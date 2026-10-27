"""對話便條與 @ 提及。

一句話講完這個功能:**在輸入框打「@ming 這個簽核卡住了」送出,ming 會被拉進共用、
他的小夥伴會跳出這句話,而 claude 完全不知道有這回事。**

為什麼不讓它進 claude:這則的收件人是人,不是 AI。混進提示裡的話,claude 會很認真地
去解讀「@ming」是什麼欄位代號 —— 那不只是浪費,它還會把那當成問題的一部分來回答。

為什麼要獨立成一則便條,而不是「順便在問題前面加一句」:喊人最需要的時機,正好是
**問題還在跑的時候**(十幾分鐘,你想找人一起看)。而那時候 /api/ask 會被
「同一組對話同時只跑一題」的 409 擋掉。便條走自己的路,不受那個限制。
"""

import re
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from . import models, shares, users

# @ 提及的邊界規則。_MENTION 與 strip_own_mention 共用這組常數,兩邊只要有一邊
# 漂走,就會出現「認得出是提及、卻處理不了」這種很難查的失配。兩個容易寫錯的地方:
#
#   - 不能要求 @ 前面是空白或開頭:中文打字不會在 @ 前面空一格,「請@ming看一下」
#     會判不出提及,整句被當成問題送給 claude,畫面上完全看不出差別。
#
#   - 結尾不能用 \b:Python 的 \b 是 Unicode-aware、中文字算 word 字元,
#     「@ming看」的 g 跟「看」之間沒有邊界。
#
# 前面不能是 email 用得到的那些字元 —— 否則 user@example.com 裡的 @example 會被
# 當成提及,貼一段含 email 的錯誤訊息進來就莫名其妙把人拉進共用了。
_NOT_BEFORE = r"(?<![A-Za-z0-9_.@-])"
# 後面不能再接帳號名還能用的字元(不要用 \b,理由見上)。
# 這樣 @ming2 也不會被當成 @ming —— 那是另一個人。
_NOT_AFTER = r"(?![A-Za-z0-9_-])"
# 帳號名本身,跟 ids.py 的規則同一組
_NAME = r"[A-Za-z0-9_-]"

_MENTION = re.compile(rf"{_NOT_BEFORE}@({_NAME}{{1,64}}){_NOT_AFTER}")

MAX_NOTE_CHARS = 500


def parse_mentions(text: str, viewer: Optional[str] = None) -> List[str]:
    """從文字裡挑出真的對得上帳號的 @提及,保持出現順序、不重複。

    對不上帳號的 @xxx 一律當成普通文字,不報錯 —— 打錯字很常見,而為了一個錯字
    把整則便條退回去,使用者只會覺得系統很難用。畫面上那個 token 不會被標成
    提及,他自己看得出來。

    停用的帳號也排除:他登不進來,拉他進共用等於什麼都沒發生。
    """
    valid = {u["username"].lower(): u["username"] for u in users.list_active()}
    found: List[str] = []
    for match in _MENTION.finditer(text):
        username = valid.get(match.group(1).lower())
        # @ 自己是沒有意義的,直接略過
        if username is None or username == viewer or username in found:
            continue
        found.append(username)
    return found


def create_note(
    db: Session, conversation_id: str, author: str, body: str
) -> Tuple[models.ConversationNote, List[str]]:
    """寫一則便條,把 @ 到的人拉進共用,並替每個人排一則待通知。

    回傳 (便條, 被 @ 到的人)。

    **每一次被 @ 都會通知**,不管對方是不是早就在共用名單裡、是不是對話的原作者。
    @ 的日常用途就是「喊一聲」,只有第一次拉人才通知的話,同一組對話裡喊第二次
    完全沒反應,這個功能等於只有第一次有用。
    """
    mentioned = parse_mentions(body, viewer=author)

    note = models.ConversationNote(
        conversation_id=conversation_id,
        author=author,
        body=body,
        mentioned=",".join(mentioned) if mentioned else None,
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    owner = shares.owner_of(db, conversation_id)
    for username in mentioned:
        # ⚠️ **不要把對話的 owner 加進共用名單。** 那是他自己的對話,替他建一列
        # ConversationShare 之後,conversations.py 的 incoming 會撈到它 ——
        # 他自己的對話會被歸到側邊欄的「共用」區,標成「來自 XXX 分享的」,
        # 而 shared_out 也跟著變成 False。
        if username != owner:
            # 已經在名單裡就跳過(shares.add 自己判斷),不是錯誤
            shares.add(db, conversation_id, username, author)
        # **每一次被 @ 都要通知**,不管他是不是早就在共用名單裡、是不是 owner
        # (理由見 docstring)。
        db.add(
            models.ConversationMention(
                note_id=note.id,
                conversation_id=conversation_id,
                username=username,
            )
        )
    db.commit()
    return note, mentioned


def strip_own_mention(body: str, username: str) -> str:
    """把收件人自己的 @token 從內容裡拿掉,給通知用。

    ming 的小夥伴講「阿華 @你:@ming 這個簽核你熟」是多餘的 —— 他已經知道是在叫他,
    再念一次自己的帳號只是佔掉氣泡的寬度。**只拿掉他自己那個**,別人的 @ 要留著:
    「@ming @jim 你們兩個看一下」對 ming 而言,jim 也在場是有意義的資訊。
    """
    # 前後條件都沿用上面那兩個常數 —— 兩邊不一致的話會變成「認得出是提及,
    # 卻剝不掉」,ming 的氣泡就會多念一次他自己的帳號。
    cleaned = re.sub(
        rf"{_NOT_BEFORE}@{re.escape(username)}{_NOT_AFTER}\s*",
        "",
        body,
        flags=re.IGNORECASE,
    )
    # 整則就只有一個 @名字(沒有留言)時不要變成空字串,那氣泡會是空的
    return cleaned.strip() or body.strip()


def pending_for(db: Session, username: str) -> List[models.ConversationMention]:
    """小夥伴**還沒彈過**的提及,舊的排前面(照順序講完才不會漏掉中間那則)。

    判斷用 notified_at 而不是 seen_at —— 前者是「氣泡跳過了」,後者是「他真的去看了」。
    """
    return (
        db.query(models.ConversationMention)
        .filter(
            models.ConversationMention.username == username,
            models.ConversationMention.notified_at.is_(None),
        )
        .order_by(models.ConversationMention.created_at.asc())
        .all()
    )


def unread_count(db: Session, username: str) -> int:
    """還沒讀的提及有幾則 —— 小夥伴頭上那個數字。"""
    return (
        db.query(models.ConversationMention)
        .filter(
            models.ConversationMention.username == username,
            models.ConversationMention.seen_at.is_(None),
        )
        .count()
    )


def unread_by_conversation(db: Session, username: str) -> dict:
    """conversation_id → 這個人在該組對話還沒讀的提及數。側邊欄的未讀標記靠它。

    一次撈完(group by),不要在對話迴圈裡逐組 count —— 那會變成 N 次查詢。
    """
    from sqlalchemy import func

    rows = (
        db.query(
            models.ConversationMention.conversation_id,
            func.count(models.ConversationMention.id),
        )
        .filter(
            models.ConversationMention.username == username,
            models.ConversationMention.seen_at.is_(None),
        )
        .group_by(models.ConversationMention.conversation_id)
        .all()
    )
    return {conv_id: count for conv_id, count in rows}


def mark_read(db: Session, username: str, conversation_id: str) -> int:
    """把這組對話裡屬於他的提及全部標成已讀,回傳標了幾則。

    觸發點是「他真的打開了那組對話」——那才叫讀到了。點氣泡、從側邊欄點進去、
    直接貼網址都算,因為三者最後都會載入那組對話。
    """
    from datetime import datetime as _dt

    return (
        db.query(models.ConversationMention)
        .filter(
            models.ConversationMention.username == username,
            models.ConversationMention.conversation_id == conversation_id,
            models.ConversationMention.seen_at.is_(None),
        )
        .update({models.ConversationMention.seen_at: _dt.utcnow()}, synchronize_session=False)
    )


def remove_for_user(db: Session, conversation_id: str, username: str) -> None:
    """某人離開(或被移出)共用時,把他在這組對話的提及一起清掉。

    不清的話有兩個殘留:他的下一輪輪詢仍會收到這組對話的便條內容(雖然那本來
    就是寫給他的,不算洩漏),而且那幾則會一直算在他的未讀數裡 —— 他點進去
    只會看到 404,紅點卻掛著。對話刪除那條路已經有 remove_all 在清,
    這裡補上「只離開共用」的對稱操作。

    自己 commit(跟 remove_all 一致)—— 呼叫點都排在 shares.remove 後面,
    而那個函式已經 commit 過了,留給呼叫端的話這筆刪除會隨著 session 關閉被丟掉。
    """
    db.query(models.ConversationMention).filter(
        models.ConversationMention.conversation_id == conversation_id,
        models.ConversationMention.username == username,
    ).delete(synchronize_session=False)
    db.commit()


def remove_all(db: Session, conversation_id: str) -> None:
    """對話被刪掉時一起清乾淨。

    待通知的提及尤其要清:留著的話,對方的小夥伴會跳出一則指向已經不存在的對話的
    訊息,點下去 404。
    """
    for table in (models.ConversationMention, models.ConversationNote):
        db.query(table).filter(table.conversation_id == conversation_id).delete(
            synchronize_session=False
        )
    db.commit()


def notes_for(db: Session, conversation_id: str) -> List[models.ConversationNote]:
    return (
        db.query(models.ConversationNote)
        .filter(models.ConversationNote.conversation_id == conversation_id)
        .order_by(models.ConversationNote.created_at.asc())
        .all()
    )
