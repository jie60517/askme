from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy.orm import Session

from .. import auth, config, models, shares
from ..database import get_db
from ..extract import extract_text

router = APIRouter(prefix="/api", tags=["files"])


def _safe_path(base_dir: Path, session_id: str, filename: str) -> Optional[Path]:
    """組出 base_dir/session_id/filename,並擋掉跳出目錄的路徑。

    session_id 與 filename 都不能含分隔符或 ..,最後再確認組出來的絕對路徑
    真的落在 base_dir 底下 —— 這是防路徑穿越的關鍵,不能省。
    """
    for part in (session_id, filename):
        if not part or part in (".", "..") or ".." in part:
            return None
        if any(sep in part for sep in ("/", "\\", "\x00")):
            return None

    base = base_dir.resolve()
    path = (base_dir / session_id / filename).resolve()
    if base not in path.parents:
        return None
    return path


# ⚠️ 這三條**要登入**,而且是靠 cookie 擋的(`auth.require_user_file`):下載用
# `<a href>`、縮圖用 `<img src>`,這兩種標籤帶不了 Authorization 標頭,所以登入時
# 同一個 token 多發一份 HttpOnly cookie(細節與取捨見 `auth.SESSION_COOKIE`);
# 「session_id 是 uuid4 猜不到」不算權限 —— 網址會被複製、貼進聊天室、留在瀏覽器
# 紀錄與 nginx log 裡。
#
# ⚠️ 第二層:不只是「要登入」,是「看得到那組對話的人」—— 每一條路由都先把
# session_id 換回它屬於哪一組對話,再問 `conversations.visible_to`,跟對話清單、
# 歷史、續問**同一套規則、同一個出入口**(這裡自己寫一份判斷的話遲早分岔,
# 症狀是「對話看不到但檔案下載得到」,例如取消共用後對方照樣下載得到)。
# 路徑穿越由 `_safe_path` 擋。`owner IS NULL` 的紀錄同樣拿不到檔案。


# 允許「預覽」(inline 開啟)的副檔名。
#
# 預設一律是下載(Content-Disposition: attachment)—— 但點縮圖/檔名的人只是想
# **確認這個是不是他要的那份**,不是要下載,所以前端會帶 ?inline=1 要求預覽。
#
# ⚠️ **SVG / HTML / XML 刻意不在名單裡。** 這三種瀏覽器會當成文件渲染,而且
# 內嵌得了 script —— 這個站的前端跟 API 同一個 origin,行內開啟一個同事上傳的
# SVG 等於在站台 origin 上執行它裡面的程式碼(token 就存在 sessionStorage)。
# 當 <img src> 用沒有這個問題(img 不執行 script),所以縮圖照樣顯示得出來。
#
# 純文字與程式碼進名單,理由是它們**在瀏覽器
# 眼裡多半是未知格式,一律會被下載** —— 使用者只是想看一眼是不是這一支,就多一個檔案
# 躺在下載資料夾。
#
# ⚠️ **這份名單比前端 lib/filekind.ts 的 isTextFilename 窄,而且是故意的。**
# 兩者管的不是同一件事:
#   前端燈箱  —— fetch 內容 + `<pre>{文字}</pre>` 渲染(React 轉義),html 只是原始碼,安全
#   這份名單  —— 瀏覽器**導覽**過去時直接渲染,html/xml/svg 會被執行
# 所以燈箱看得了 html,這裡照樣不放行(中鍵開新分頁 → 下載)。放寬這份名單前
# 先問一句:「這個格式被瀏覽器當文件打開,會不會執行裡面的東西?」
#
# ⚠️ `.env` 之類「設定檔」刻意不列:預覽功能不需要它們,而含機密的檔案
# 不該變得更容易在瀏覽器裡攤開來看。
_INLINE_TEXT = {
    ".txt", ".md", ".log", ".sql", ".json", ".csv",
    ".yaml", ".yml", ".ini", ".conf", ".cfg", ".properties",
    ".sh", ".bat", ".ps1", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".c", ".h", ".cpp", ".java", ".go", ".rs", ".css",
}
_INLINE_OK = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".pdf"
} | _INLINE_TEXT

# 瀏覽器不要自己猜型別。少了它,一個副檔名是 .txt 但內容長得像 HTML 的檔案,
# 在部分瀏覽器會被當成 HTML 渲染 —— 上面那份 inline 名單擋掉的東西就從側門進來了。
# `no-store`:同事的附件不要留在瀏覽器快取裡,共用電腦登出之後 back/forward 才讀不回來。
_FILE_HEADERS = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"}


def _file_response(path: Path, filename: str, inline: bool) -> FileResponse:
    if inline and Path(filename).suffix.lower() in _INLINE_OK:
        return FileResponse(
            path, filename=filename, content_disposition_type="inline", headers=_FILE_HEADERS
        )
    return FileResponse(path, filename=filename, headers=_FILE_HEADERS)


def _require_visible_session(db: Session, session_id: str, viewer: str) -> None:
    """這個 session_id 的檔案,這個人有沒有資格拿。沒有就 404。

    session_id 有兩種來源,兩條都要認:
      1. 一題問答的 session_id(`QARecord.session_id`)—— 附件與產出檔;
      2. 一則便條的 `attachment_sid`(models.ConversationNote 那段有說明:
         它刻意不掛在任何一題底下,是替那則便條配的獨立 id)。

    判斷本身**不自己寫**:第 1 種直接套 `conversations.visible_to`,
    第 2 種找出便條屬於哪組對話再問 `shares.can_access` —— 兩個都是既有的
    唯一出入口。這裡多寫一份「owner 等於自己或在共用名單裡」的話,
    哪天共用規則改了就會分岔。

    ⚠️ 回 404 而不是 403:403 等於告訴對方「這個 session_id 存在,只是你不能看」。
    對一個「網址會外流」的東西,連存在與否都不要確認。找不到對應紀錄的
    (例如對話已經刪掉、只剩磁碟上的殘檔)也是 404 —— 那些本來就不該再被拿到。
    """
    # 延後 import:conversations 會 import 這個模組以外的一堆東西,
    # 放在模組頂端的話兩邊的 import 順序會變得很脆弱。
    from .conversations import visible_to

    owned = (
        visible_to(db.query(models.QARecord.id), db, viewer)
        .filter(models.QARecord.session_id == session_id)
        .first()
    )
    if owned is not None:
        return

    note = (
        db.query(models.ConversationNote)
        .filter(models.ConversationNote.attachment_sid == session_id)
        .first()
    )
    if note is not None and shares.can_access(db, note.conversation_id, viewer):
        return

    raise HTTPException(status_code=404, detail="找不到檔案")


def _existing_file(base_dir: Path, session_id: str, filename: str) -> Path:
    """組出檔案路徑並確認它真的在。不合法回 400、不存在回 404。

    三條路由(下載、上傳、預覽)共用這一份:**路徑安全檢查**不該有第二份。
    """
    path = _safe_path(base_dir, session_id, filename)
    if path is None:
        raise HTTPException(status_code=400, detail="不合法的路徑")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="找不到檔案")
    return path


@router.get("/files/{session_id}/{filename}")
def download_output(
    session_id: str,
    filename: str,
    inline: bool = False,
    viewer: str = Depends(auth.require_user_file),
    db: Session = Depends(get_db),
):
    """下載(或帶 ?inline=1 預覽)這一題產生的檔案(outputs/)。"""
    _require_visible_session(db, session_id, viewer)
    return _file_response(
        _existing_file(config.OUTPUT_DIR, session_id, filename), filename, inline
    )


@router.get("/uploads/{session_id}/{filename}")
def get_upload(
    session_id: str,
    filename: str,
    inline: bool = False,
    viewer: str = Depends(auth.require_user_file),
    db: Session = Depends(get_db),
):
    """取回這一題上傳的檔案(uploads/)。給對話裡的圖片縮圖與預覽用。"""
    _require_visible_session(db, session_id, viewer)
    return _file_response(
        _existing_file(config.UPLOAD_DIR, session_id, filename), filename, inline
    )


# 抽出來的文字上限。跟前端燈箱的截斷值同一個量級 —— 一份幾萬列的 xlsx 攤成文字
# 可以是好幾 MB,而預覽的用途是「確認這份是不是我要的」,不是在網頁裡讀完它。
_MAX_PREVIEW_CHARS = 200_000

# 網址上的 scope → 實際的目錄。用**白名單**而不是拿字串去湊路徑,
# 也不要 getattr(config, ...) 繞一手:直接存目錄物件,型別檢查看得到,
# 而且不存在的 scope 在這裡就沒有對應項,連組路徑的機會都沒有。
_PREVIEW_DIRS = {"files": config.OUTPUT_DIR, "uploads": config.UPLOAD_DIR}


@router.get("/preview/{scope}/{session_id}/{filename}", response_class=PlainTextResponse)
def preview_as_text(
    scope: str,
    session_id: str,
    filename: str,
    viewer: str = Depends(auth.require_user_file),
    db: Session = Depends(get_db),
):
    """Word / Excel / PowerPoint 的**純文字**預覽。

    這些格式是壓縮過的二進位,瀏覽器打不開,直接抓回去顯示只會是亂碼 ——
    但使用者最常附的就是這幾種,「點開確認是不是這份報價單」是很自然的動作。
    所以在後端把文字抽出來(用的是上傳時那支 `extract_text`,同一份實作,
    不要另外寫一份平行的解析),前端當文字顯示。

    抽不出來(格式不支援、檔案壞了)回 415,前端據此顯示「這個檔沒辦法預覽,
    請下載」—— 跟「檔案不見了」(404)分開,兩者要處理的事不一樣。

    權限與路徑安全跟上面兩條同一套(要登入 + 看得到那組對話 + `_safe_path`)。
    """
    base_dir = _PREVIEW_DIRS.get(scope)
    if base_dir is None:
        raise HTTPException(status_code=400, detail="不合法的路徑")
    _require_visible_session(db, session_id, viewer)
    path = _existing_file(base_dir, session_id, filename)

    text = extract_text(path)
    if text is None:
        raise HTTPException(status_code=415, detail="這個格式沒辦法轉成文字預覽")
    if len(text) > _MAX_PREVIEW_CHARS:
        text = text[:_MAX_PREVIEW_CHARS] + "\n\n…(內容太長,只顯示前面一段。要看完整內容請下載)"
    return PlainTextResponse(text, headers=_FILE_HEADERS)
