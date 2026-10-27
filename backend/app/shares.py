"""對話共用。

一組對話的可見範圍從「只有 owner」變成「owner + 被分享的人」。這個判斷散落在
很多地方(對話清單、歷史、續問、進行中的串流、重新命名、刪除),所以集中在這裡,
不要在每個 router 各寫一份 —— 漏掉一處的後果是「看得到列表但點進去 404」,
或更糟:「看不到列表但續問得了」。

**分享不改變擁有權。** qa_records.owner 永遠是原本發問的人,被分享的人續問時
新的那筆紀錄也掛在**原 owner** 名下(見 ask.py)。這樣整組對話的 owner 從頭到尾
一致,conversations.py 那句「任一筆紀錄的 owner 代表整組對話」的前提才站得住。
"""

from typing import List, Optional, Set

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models


def shared_with(db: Session, viewer: str) -> Set[str]:
    """分享給這個人的所有對話 id。"""
    rows = (
        db.query(models.ConversationShare.conversation_id)
        .filter(models.ConversationShare.username == viewer)
        .all()
    )
    return {r[0] for r in rows}


def owner_of(db: Session, conversation_id: str) -> Optional[str]:
    """這組對話是誰的。用最早那筆紀錄的 owner —— 同一組對話裡 owner 從頭到尾一致
    (ask.py 擋掉了別人插入紀錄),所以任一筆都可以,取最早的最直觀。

    ⚠️ **已刪除的紀錄不算數。** 刪對話是軟刪除(列還在),不濾掉的話,拿著舊
    網址對那組對話續問會被判定成「你就是原作者」而放行 —— 於是那組已經刪掉的
    對話從下一題開始又長回來了,而且 claude 那側還會 `--resume` 回原本的
    session,把使用者以為刪掉的內容整段讀回模型的上下文裡。
    濾掉之後這裡回 None,呼叫端會把它當成一組全新的對話。
    """
    row = (
        db.query(models.QARecord.owner)
        .filter(models.QARecord.conversation_id == conversation_id)
        .filter(models.QARecord.deleted_at.is_(None))
        .order_by(models.QARecord.created_at.asc())
        .first()
    )
    return row[0] if row else None


def can_access(db: Session, conversation_id: str, viewer: Optional[str]) -> bool:
    """這個人看不看得到這組對話 —— 自己的,或別人分享給他的。

    ⚠️ 唯一的判斷入口。續問、串流、歷史、改標題、刪除全部走這裡,
    不然很容易出現「列表看得到但點進去 404」這種前後矛盾。

    viewer 是空的一律 False:owner_of 對不存在的對話回 None,少了這道
    `None == None` 就會放行。
    """
    if not viewer:
        return False
    if owner_of(db, conversation_id) == viewer:
        return True
    return (
        db.query(models.ConversationShare)
        .filter(
            models.ConversationShare.conversation_id == conversation_id,
            models.ConversationShare.username == viewer,
        )
        .first()
        is not None
    )


def recipients(db: Session, conversation_id: str) -> List[models.ConversationShare]:
    """這組對話分享給了誰。給「管理共用對象」的畫面用。"""
    return (
        db.query(models.ConversationShare)
        .filter(models.ConversationShare.conversation_id == conversation_id)
        .order_by(models.ConversationShare.created_at.asc())
        .all()
    )


def add(db: Session, conversation_id: str, username: str, shared_by: str) -> bool:
    """分享給一個人。已經分享過就回 False(不是錯誤 —— 想不起來有沒有按過很正常)。

    先查再插會有競態:兩邊同時分享給同一個人時,兩邊都查到「沒有」,第二個 insert
    撞上複合主鍵,500。所以照樣先查(省掉大多數情況的例外),但也接住 IntegrityError
    —— 那個結果跟「已經分享過」是同一件事,不該變成錯誤。
    """
    existing = (
        db.query(models.ConversationShare)
        .filter(
            models.ConversationShare.conversation_id == conversation_id,
            models.ConversationShare.username == username,
        )
        .first()
    )
    if existing is not None:
        return False
    db.add(
        models.ConversationShare(
            conversation_id=conversation_id, username=username, shared_by=shared_by
        )
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False
    return True


def remove(db: Session, conversation_id: str, username: str) -> bool:
    row = (
        db.query(models.ConversationShare)
        .filter(
            models.ConversationShare.conversation_id == conversation_id,
            models.ConversationShare.username == username,
        )
        .first()
    )
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


def remove_all(db: Session, conversation_id: str) -> None:
    """對話被刪掉時一起清乾淨,不要留孤兒列。"""
    db.query(models.ConversationShare).filter(
        models.ConversationShare.conversation_id == conversation_id
    ).delete(synchronize_session=False)
    db.commit()
