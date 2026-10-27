import re
import shutil
from typing import List, Optional, Tuple

from fastapi import UploadFile

from . import config
from .extract import extract_text

#: 上傳目錄名 = 呼叫端產的 uuid4().hex。它會變成路徑的一段,所以在寫檔前驗格式。
_SESSION_ID = re.compile(r"[0-9a-f]{32}")

CHUNK_SIZE = 1024 * 1024

# 檔名會被拿去組路徑、寫進提示、也會出現在下載連結上,所以要擋掉三類東西:
# 路徑分隔符與 ..(跳出目錄)、控制字元(NUL 會讓後續處理丟 ValueError)、
# 以及只由點組成的名字(. 跟 .. 指向目錄本身或上層)。
#
# 逗號也要擋:檔名清單是用逗號分隔存進欄位的(QARecord.output_files、
# ConversationNote.attachments),檔名含逗號的話 split 回來會斷成兩個
# 不存在的檔 —— 清單上多出兩列「已失效」,而真的那個檔案永遠列不出來。
_ILLEGAL_CHARS = set('/\\,\x00') | {chr(c) for c in range(32)}
_MAX_FILENAME_CHARS = 120


def _safe_filename(raw: Optional[str]) -> Optional[str]:
    name = (raw or "").strip()
    if not name or ".." in name or set(name) & _ILLEGAL_CHARS:
        return None
    if set(name) <= {"."}:
        return None
    if len(name) > _MAX_FILENAME_CHARS:
        # 太長的檔名在某些檔案系統會直接寫入失敗,保留副檔名截短
        stem, dot, ext = name.rpartition(".")
        ext = f".{ext}" if dot and len(ext) <= 10 else ""
        name = (stem or name)[: _MAX_FILENAME_CHARS - len(ext)] + ext
    return name


def save_uploads(
    session_id: str, files: List[UploadFile]
) -> Tuple[List[str], List[Tuple[str, str]]]:
    """存多個檔案。回傳 (成功的檔名, [(失敗的檔名, 原因)])。

    失敗的檔案不會中斷其他檔案,但**一定要把原因帶回去** —— 靜悄悄略過的話,
    問題照樣送出,使用者以為 AI 看過那張截圖,拿到答非所問的回覆還不知道為什麼。
    """
    saved: List[str] = []
    rejected: List[Tuple[str, str]] = []

    # 一個請求最多幾個檔:單檔上限擋不住「一個請求塞一千個 50 MB」。
    if config.MAX_UPLOAD_FILES > 0 and len(files) > config.MAX_UPLOAD_FILES:
        return [], [
            (file.filename or "(未命名檔案)", f"一次最多附 {config.MAX_UPLOAD_FILES} 個檔案")
            for file in files
        ]
    # 硬碟剩太少就整批拒收 —— 這是「一個帳號把硬碟塞滿」的最後一道閘。
    # 上傳目錄通常跟資料庫、程式碼樹在同一顆碟上,滿了是整台機器一起出事。
    if not _enough_free_disk():
        return [], [
            (file.filename or "(未命名檔案)", "主機硬碟空間不足,附件暫時無法上傳,請通知管理員")
            for file in files
        ]

    for file in files:
        name, reason = save_upload(session_id, file)
        if name:
            saved.append(name)
        else:
            rejected.append((file.filename or "(未命名檔案)", reason or "無法存檔"))
    return saved, rejected


def _enough_free_disk() -> bool:
    """上傳目錄所在的硬碟剩得夠不夠。只查不建:目錄還沒建就查它上一層(同一顆碟)。"""
    if config.MIN_FREE_DISK_MB <= 0:
        return True
    probe = config.UPLOAD_DIR if config.UPLOAD_DIR.exists() else config.UPLOAD_DIR.parent
    try:
        free = shutil.disk_usage(probe).free
    except OSError:
        return True  # 查不到就放行,查不到不該變成「沒人能上傳」
    return free >= config.MIN_FREE_DISK_MB * 1024 * 1024


async def save_uploads_async(
    session_id: str, files: List[UploadFile]
) -> Tuple[List[str], List[Tuple[str, str]]]:
    """給 async 端點用的 `save_uploads`。

    存檔 + 解析 Office 是同步的,直接在 `async def` 裡呼叫會把整個 event loop 停住,
    所有人的問答串流一起卡(一個大 xlsx 就夠)。丟到 threadpool 跑。
    """
    from fastapi.concurrency import run_in_threadpool

    return await run_in_threadpool(save_uploads, session_id, files)


def save_upload(session_id: str, file: UploadFile) -> Tuple[Optional[str], Optional[str]]:
    """存到 agent-knowledge/uploads/{session_id}/{原檔名}。

    回傳 (檔名, None) 代表成功,(None, 原因) 代表這個檔案沒存成 —— 原因會原樣顯示給使用者看。

    像 pptx/docx/xlsx 這種二進位文件格式,claude 自己沒辦法直接讀懂內容,又不該開放
    unzip/python 這類指令讓它自己想辦法解——這裡上傳當下就先在後端把文字內容擷取出來,
    另存一份 {原檔名}.txt,claude 之後只要讀這份純文字就好。
    """
    # 在寫檔前驗 session_id,不要靠「呼叫端一定給對」——
    # 下面 resolve() 那道是最後一道,不是唯一一道。
    if not _SESSION_ID.fullmatch(session_id or ""):
        return None, "session 格式不正確"
    name = _safe_filename(file.filename)
    if not name:
        return None, "檔名不能包含 / \\ 逗號或控制字元,請改名後重新上傳"

    try:
        target_dir = config.UPLOAD_DIR / session_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / name

        # 最後一道:確認組出來的路徑真的落在這次問答的資料夾底下。
        # 前面的字元檢查漏了什麼,這裡會擋下來。
        if target_dir.resolve() not in target_path.resolve().parents:
            return None, "檔名不合法,請改名後重新上傳"

        # 單檔上限,預設 50 MB。MAX_UPLOAD_MB <= 0 才是不限制(要明寫才會發生)
        max_bytes = config.MAX_UPLOAD_MB * 1024 * 1024 if config.MAX_UPLOAD_MB > 0 else 0
        written = 0
        with target_path.open("wb") as out:
            while chunk := file.file.read(CHUNK_SIZE):
                written += len(chunk)
                if max_bytes and written > max_bytes:
                    out.close()
                    target_path.unlink(missing_ok=True)
                    return None, f"檔案超過 {config.MAX_UPLOAD_MB} MB 上限"
                out.write(chunk)
    except OSError as exc:
        return None, f"主機寫入失敗({exc.strerror or type(exc).__name__})"

    text = extract_text(target_path)
    if text:
        try:
            (target_dir / f"{name}.txt").write_text(text, encoding="utf-8")
        except OSError:
            pass

    return name, None
