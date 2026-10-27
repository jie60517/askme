import uuid
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request

# ⚠️ 要用 starlette 的 UploadFile 來判斷,不能用 fastapi 的:手動 `request.form()`
# 拿到的是 starlette 的實例,而 fastapi.UploadFile 是它的**子類別** ——
# isinstance(starlette 實例, fastapi.UploadFile) 永遠是 False,
# 附件會被靜靜濾光,存進去的便條一個檔案都沒有。
from starlette.datastructures import UploadFile
from sqlalchemy.orm import Session

from .. import auth, ids, models, notes, schemas, shares, uploads, users
from ..database import get_db

router = APIRouter(prefix="/api", tags=["notes"])

_CONV_ID = ids.path_param()


def _to_out(note: models.ConversationNote, display: dict) -> schemas.NoteOut:
    mentioned = [n for n in (note.mentioned or "").split(",") if n]
    return schemas.NoteOut(
        id=note.id,
        created_at=note.created_at,
        conversation_id=note.conversation_id,
        author=note.author,
        author_name=display.get(note.author, note.author),
        body=note.body,
        mentioned=mentioned,
        mentioned_names={u: display.get(u, u) for u in mentioned},
        attachments=[n for n in (note.attachments or "").split(",") if n],
        attachment_sid=note.attachment_sid,
    )


@router.get("/conversations/{conversation_id}/notes", response_model=List[schemas.NoteOut])
def list_notes(
    conversation_id: str = _CONV_ID,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """這組對話裡的所有便條。看得到對話的人都看得到 —— 便條的用途就是講給
    對話裡的人聽,被 @ 的人打開之後要看得到自己是為了什麼被拉進來。"""
    if not shares.can_access(db, conversation_id, viewer):
        raise HTTPException(status_code=404, detail="找不到這個對話")
    # 帳號清單撈一次就好 —— display_names() 的 docstring 明寫「避免在迴圈裡逐筆查」,
    # 放進 list comprehension 會變成每則便條重讀一次整份 users 表。
    display = users.display_names()
    return [_to_out(n, display) for n in notes.notes_for(db, conversation_id)]


@router.post(
    "/conversations/{conversation_id}/notes",
    response_model=schemas.NoteOut,
    status_code=201,
)
async def create_note(
    request: Request,
    conversation_id: str = _CONV_ID,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """寫一則便條。@ 到的人會被拉進共用,並收到一則通知。可以夾帶附件。

    **這則永遠不會送給 claude。** 它不建立 QARecord、不佔 session、不計成本,
    也不受「同一組對話同時只跑一題」的限制 —— 問題正在跑的時候本來就最需要喊人。
    附件也一樣:那是給被 @ 的人看的(截圖、要對方確認的檔案),claude 讀不到。

    請求格式收兩種:**JSON `{text}` 或 multipart(text + files)**。手動分辨而不是
    宣告成 pydantic 參數,是因為部署時前端是每次請求從磁碟讀的、後端要重啟才換 ——
    交接的空窗裡一定有「舊前端(送 JSON)+ 新後端」同時存在,宣告成 multipart
    的話,那段時間所有不帶附件的便條都會 422。
    """
    content_type = request.headers.get("content-type", "")
    files: List[UploadFile] = []
    if content_type.startswith("multipart/"):
        form = await request.form()
        text = str(form.get("text") or "")
        files = [f for f in form.getlist("files") if isinstance(f, UploadFile)]
    else:
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="便條不能是空的")
        text = str((body or {}).get("text") or "")

    # 長度上限要自己檢查(這條手動收請求,沒有 pydantic schema 幫忙)——
    # 少了它,一個請求就能把任意大小的字串寫進資料庫(schemas.py 開頭的原則)。
    # 先 strip 再計長:前後空白不該吃掉字數配額。
    text = text.strip()
    if len(text) > notes.MAX_NOTE_CHARS:
        raise HTTPException(
            status_code=400, detail=f"便條最多 {notes.MAX_NOTE_CHARS} 字"
        )
    if not text:
        raise HTTPException(status_code=400, detail="便條不能是空的")

    # 還沒問過任何一題的對話沒有 owner(owner 是從 qa_records 推出來的),
    # can_access 會一律回 False。那時候回 404 會讓人一頭霧水 —— 明明就在這一頁上,
    # 所以分開判斷,並且講清楚要先問一題。
    owner = shares.owner_of(db, conversation_id)
    if owner is None:
        raise HTTPException(
            status_code=400, detail="這組對話還沒有內容,先問一題再 @ 同事進來"
        )
    if owner != viewer and not shares.can_access(db, conversation_id, viewer):
        raise HTTPException(status_code=404, detail="找不到這個對話")

    note, _ = notes.create_note(db, conversation_id, viewer, text)
    if not note.mentioned:
        # 一個人都沒 @ 到,那這則沒有收件人。**要講出來**,不然使用者會以為
        # 已經通知出去了(最常見的原因是帳號打錯字,而畫面上看起來一模一樣)。
        # 附件也還沒存(存檔排在這個檢查後面),所以這裡不會留下孤兒檔案。
        db.delete(note)
        db.commit()
        raise HTTPException(
            status_code=400,
            detail="沒有 @ 到任何同事。請用 @ 加上帳號名稱,例如 @ming",
        )

    # 附件存進 uploads/{sid}/,sid 是替這則便條配的隨機 id(跟問答的 session_id
    # 同一種格式,下載走現成的 /api/uploads 路由)。**不能掛在任何一題底下**,
    # 不然檔案區的版次規則會把它算成那一題的附件。
    rejected_msgs: List[str] = []
    if files:
        sid = uuid.uuid4().hex
        saved, rejected = await uploads.save_uploads_async(sid, files)
        if saved:
            note.attachment_sid = sid
            note.attachments = ",".join(saved)
            db.commit()
        # 沒存成的**一定要帶回去給前端講**:靜靜略過的話,使用者以為同事
        # 收得到那張截圖,而它根本沒存進去(同 uploads.py)。
        rejected_msgs = [f"「{name}」沒有附上:{reason}" for name, reason in rejected]

    out = _to_out(note, users.display_names())
    out.rejected_files = rejected_msgs
    return out


@router.get("/mentions/pending", response_model=schemas.MentionPoll)
def pending_mentions(
    db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)
):
    """小夥伴的輪詢打這一條。一次拿兩件事,不要分成兩個請求:

      announce —— 還沒彈過的提及,拿去跳氣泡
      unread   —— 還沒讀的則數,就是小夥伴頭上那個數字

    兩者不一樣:氣泡跳過了不代表他去看了,所以彈完 unread 還是會留著,
    直到他真的打開那組對話為止。
    """
    pending = notes.pending_for(db, viewer)
    announce: List[schemas.MentionOut] = []

    if pending:
        note_map = {
            n.id: n
            for n in db.query(models.ConversationNote)
            .filter(models.ConversationNote.id.in_([m.note_id for m in pending]))
            .all()
        }
        display = users.display_names()
        for mention in pending:
            note = note_map.get(mention.note_id)
            if note is None:
                # 便條被刪了(對話整組被刪會走到這)。這則已經沒有內容可以講,
                # 直接收掉,免得它永遠留在待通知清單裡。
                mention.notified_at = datetime.utcnow()
                mention.seen_at = datetime.utcnow()
                continue
            announce.append(
                schemas.MentionOut(
                    id=mention.id,
                    created_at=mention.created_at,
                    conversation_id=mention.conversation_id,
                    author_name=display.get(note.author, note.author),
                    # 拿掉他自己那個 @token —— 氣泡上再念一次他自己的帳號只是佔寬度
                    body=notes.strip_own_mention(note.body, viewer),
                )
            )
        db.commit()

    return schemas.MentionPoll(announce=announce, unread=notes.unread_count(db, viewer))


@router.post("/mentions/announced", status_code=204)
def mark_announced(
    req: schemas.SeenMentionsRequest,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """小夥伴已經把這幾則彈出來了,下次輪詢不要再講一次。

    **這不是「已讀」** —— 未讀數不會因此變少,他還沒真的去看。

    一定要限制在自己名下(`username == viewer`)—— 少了那個條件,任何人送一串
    連號 id 進來就能把別人的待通知清單清光,而對方永遠不會知道有人 @ 過他。
    """
    if not req.ids:
        return
    (
        db.query(models.ConversationMention)
        .filter(
            models.ConversationMention.id.in_(req.ids),
            models.ConversationMention.username == viewer,
            models.ConversationMention.notified_at.is_(None),
        )
        .update({models.ConversationMention.notified_at: datetime.utcnow()}, synchronize_session=False)
    )
    db.commit()


@router.post("/conversations/{conversation_id}/mentions/read", response_model=schemas.UnreadOut)
def mark_conversation_read(
    conversation_id: str = _CONV_ID,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """他打開了這組對話 —— 裡面所有 @ 他的提及都算讀過了。

    **回傳剩下幾則未讀**,讓前端可以立刻更新徽章而不必等下一輪輪詢(8 秒)。
    等輪詢的話,他看完退出來紅點還掛著,會以為還有沒看到的東西。
    這裡回真正的剩餘數,不是前端自己猜著扣 —— 同一個人可能在別的分頁也在讀。

    不檢查 can_access:標記自己的未讀不會洩漏任何東西,而看不到那組對話的人
    本來就不會有屬於它的提及(update 會影響 0 列)。
    """
    marked = notes.mark_read(db, viewer, conversation_id)
    db.commit()
    return schemas.UnreadOut(unread=notes.unread_count(db, viewer), marked=marked)
