# -*- coding: utf-8 -*-
"""刪對話 = 軟刪除。

管理員的用量統計是從 `qa_records` 算的:刪對話時整列刪掉的話,會連帶把成本、
token、誰問的一起帶走,統計上少了一些人的問題,而畫面上沒有任何線索指向刪除。

軟刪除有**兩個方向**要同時守住,任何一邊漏掉都是嚴重的:

  留得住 —— 統計那一側還看得到這一題的成本與 token。
  真的刪 —— 使用者那一側完全看不到,而且內容已經被清空,連續問都接不回去。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_soft_delete.py
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, models, shares
from app.database import Base, SessionLocal, engine
from app.main import app

OWNER = "deleter"
CONV = "d" * 32
SID = "d" * 31 + "1"


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_mfa.py:建表在 lifespan 裡,fixture 比它早。"""
    Base.metadata.create_all(engine)


@pytest.fixture
def record():
    db = SessionLocal()
    db.query(models.QARecord).filter(models.QARecord.conversation_id == CONV).delete()
    row = models.QARecord(
        session_id=SID,
        conversation_id=CONV,
        question="這支程式在做什麼",
        answer="它在做這個",
        owner=OWNER,
        asked_by=OWNER,
        cost_usd=1.25,
        status="done",
    )
    db.add(row)
    db.commit()
    record_id = row.id
    # 一筆流水帳。**測試一定要有這個** —— 「刪對話有沒有把碰過的檔案路徑清掉」
    # 是這一組最容易漏的一條,而沒有 qa_steps 列的話那條斷言必定通過。
    db.add(
        models.QAStep(
            qa_record_id=record_id,
            seq=0,
            turn=0,
            kind="tool",
            tool="Read",
            target="src/orders/checkout.py",
            target_full="/srv/app/src/orders/checkout.py",
            detail="grep order_total",
            input_tokens=1234,
        )
    )
    db.commit()
    db.close()

    yield record_id

    db = SessionLocal()
    db.query(models.QARecord).filter(models.QARecord.conversation_id == CONV).delete()
    db.commit()
    db.close()


def _delete_it(client) -> int:
    token = auth._issue(OWNER)
    return client.delete(
        f"/api/conversations/{CONV}", headers={"Authorization": f"Bearer {token}"}
    ).status_code


def test_cost_survives_deletion_for_the_admin(record):
    """**軟刪除的理由。** 刪掉之後,那筆錢還要算得到。"""
    with TestClient(app) as client:
        assert _delete_it(client) == 204

        admin = auth._issue(auth.config.ADMIN_USERNAME)
        items = client.get(
            "/api/stats/questions", headers={"Authorization": f"Bearer {admin}"}
        ).json()["items"]

    mine = [i for i in items if i["id"] == record]
    assert mine, "刪掉對話之後,那一題從用量統計上整個消失了"
    assert mine[0]["cost_usd"] == 1.25
    assert mine[0]["deleted_at"] is not None, "統計頁分不出這題是被刪掉的"


def test_content_is_really_gone(record):
    """另一個方向:使用者按刪除,要的是那些字消失。留著標記卻留著內容不算刪。"""
    with TestClient(app) as client:
        assert _delete_it(client) == 204

    db = SessionLocal()
    row = db.get(models.QARecord, record)
    db.close()
    assert row.question == ""
    assert row.answer == ""


def test_step_trail_is_wiped_too(record):
    """流水帳裡的**標的**也要清掉,數字留著。

    軟刪除不會觸發 `ON DELETE CASCADE`,那些列會留下來,而管理員的題目明細頁
    照樣送得出去 —— 裡面是檔案路徑、搜尋字串、完整的 Bash 指令,對一筆標著
    「已刪除」的紀錄來說,那比問題原文還敏感。
    """
    with TestClient(app) as client:
        assert _delete_it(client) == 204

    db = SessionLocal()
    step = (
        db.query(models.QAStep).filter(models.QAStep.qa_record_id == record).one()
    )
    db.close()

    assert step.target is None, "刪掉對話之後,它碰過的檔案路徑還留在流水帳上"
    assert step.target_full is None
    assert step.detail is None
    # 數字是帳,要留著 —— 這正是整個軟刪除的理由
    assert step.input_tokens == 1234


def test_deleted_question_detail_leaks_nothing(record):
    """管理員打開那一題的明細時,拿不到任何內容,但拿得到數字。"""
    with TestClient(app) as client:
        assert _delete_it(client) == 204
        admin = auth._issue(auth.config.ADMIN_USERNAME)
        detail = client.get(
            f"/api/stats/questions/{record}", headers={"Authorization": f"Bearer {admin}"}
        ).json()

    blob = repr(detail)
    assert "checkout.py" not in blob, "已刪除的題目,明細頁還吐得出它讀過的檔名"
    assert "grep order_total" not in blob
    assert detail["question"]["cost_usd"] == 1.25


def test_owner_can_no_longer_see_it(record):
    """側邊欄、歷史、續問全部走 `visible_to` —— 刪掉的要一條都看不到。"""
    with TestClient(app) as client:
        assert _delete_it(client) == 204
        token = auth._issue(OWNER)
        convs = client.get(
            "/api/conversations", headers={"Authorization": f"Bearer {token}"}
        ).json()

    assert all(c.get("conversation_id") != CONV for c in convs), "刪掉的對話又回到清單上了"


def test_deleted_conversation_cannot_be_resumed(record):
    """拿舊網址續問**不能**接回原本那組 claude session。

    接回去的話,使用者以為刪掉的內容會被 `--resume` 整段讀回模型的上下文裡
    —— 那比「清單上還看得到」嚴重得多,因為完全看不出來。
    守的是 `shares.owner_of` 裡那個 `deleted_at IS NULL`。
    """
    with TestClient(app) as client:
        assert _delete_it(client) == 204

    db = SessionLocal()
    assert shares.owner_of(db, CONV) is None
    db.close()
