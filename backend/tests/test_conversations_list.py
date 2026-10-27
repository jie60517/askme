# -*- coding: utf-8 -*-
"""GET /api/conversations 只讀它用得到的東西。

這條每 8 秒輪詢一次(前端 sharedWatch.ts)。不能每次都把這個人**全部問答連同
answer 全文**載進 Python,也不能把**全站**的 conversation_meta 撈回來挑自訂標題 ——
回應裡一個 answer 字元都用不到,而 meta 那張表跟著全站的對話數一起長。

這裡守兩件事:
  結果不變 —— 自訂標題(自己的、別人分享給我的)照樣帶得出來,沒改名的照樣用第一題的重點。
  讀得少   —— 沒有任何一條 SQL 選了 qa_records.answer;meta 只撈這個人看得到的那幾組。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_conversations_list.py
"""
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from app import auth, models
from app.database import Base, SessionLocal, engine
from app.main import app

ME = "lister_a"
OTHER = "lister_b"

MINE_TITLED = "la" + "1" * 30
MINE_PLAIN = "la" + "2" * 30
THEIRS_SHARED = "lb" + "3" * 30
THEIRS_PRIVATE = "lb" + "4" * 30
ALL_CONVS = [MINE_TITLED, MINE_PLAIN, THEIRS_SHARED, THEIRS_PRIVATE]


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_mfa.py:建表在 lifespan 裡,fixture 比它早。"""
    Base.metadata.create_all(engine)


def _wipe(db):
    db.query(models.QARecord).filter(models.QARecord.owner.in_([ME, OTHER])).delete(
        synchronize_session=False
    )
    db.query(models.ConversationMeta).filter(
        models.ConversationMeta.conversation_id.in_(ALL_CONVS)
    ).delete(synchronize_session=False)
    db.query(models.ConversationShare).filter(
        models.ConversationShare.conversation_id.in_(ALL_CONVS)
    ).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def seeded():
    db = SessionLocal()
    _wipe(db)
    t0 = datetime(2026, 10, 1, 9, 0, 0)
    n = 0

    def rec(conv, owner, question, minutes):
        nonlocal n
        n += 1
        db.add(
            models.QARecord(
                session_id=f"list-{n}-" + "x" * 20,
                conversation_id=conv,
                question=question,
                # answer 故意放一個認得出來的長字串:SQL 裡出現它就代表又整欄讀回來了
                answer="ANSWER-BODY " * 500,
                owner=owner,
                asked_by=owner,
                status="done",
                created_at=t0 + timedelta(minutes=minutes),
            )
        )

    rec(MINE_TITLED, ME, "這支程式在做什麼?請給程式代號", 0)
    rec(MINE_TITLED, ME, "第二題", 5)
    rec(MINE_PLAIN, ME, "請把這三筆資料整理成 Excel 給我:品號 0012345", 1)
    rec(None, ME, "沒有 conversation_id 的舊紀錄,單獨成一組", 2)
    rec(THEIRS_SHARED, OTHER, "同事的問題", 3)
    rec(THEIRS_PRIVATE, OTHER, "同事沒分享的問題", 4)

    db.add(models.ConversationMeta(conversation_id=MINE_TITLED, custom_title="我改過的名字"))
    # 只有 claude_session_id、沒有自訂標題的 meta —— 不能讓它蓋掉第一題的重點
    db.add(models.ConversationMeta(conversation_id=MINE_PLAIN, claude_session_id="s"))
    db.add(models.ConversationMeta(conversation_id=THEIRS_SHARED, custom_title="同事取的名字"))
    db.add(models.ConversationMeta(conversation_id=THEIRS_PRIVATE, custom_title="同事的祕密標題"))
    db.add(
        models.ConversationShare(conversation_id=THEIRS_SHARED, username=ME, shared_by=OTHER)
    )
    db.commit()
    db.close()
    yield
    db = SessionLocal()
    _wipe(db)
    db.close()


def _list(client, who=ME):
    token = auth._issue(who)
    resp = client.get("/api/conversations", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    return resp.json()


def test_titles_still_come_through(seeded):
    with TestClient(app) as client:
        # 進行中要在 TestClient 開起來**之後**才設:lifespan 的 close_orphan_runs
        # 會把開機前就是 running 的紀錄全部改成 done
        db = SessionLocal()
        db.query(models.QARecord).filter(models.QARecord.conversation_id == MINE_PLAIN).update(
            {"status": "running"}
        )
        db.commit()
        db.close()
        items = {c["conversation_id"]: c for c in _list(client)}

    # 自己改過名的、別人分享給我而他改過名的,都要帶得出來
    assert items[MINE_TITLED]["title"] == "我改過的名字"
    assert items[THEIRS_SHARED]["title"] == "同事取的名字"
    assert items[THEIRS_SHARED]["shared_with_me"] is True
    # 沒改過名的用第一題的重點(meta 列存在、custom_title 是 NULL 也一樣)
    assert items[MINE_PLAIN]["title"] == "請把這三筆資料整理成 Excel 給我"
    assert items[MINE_PLAIN]["running"] is True
    assert items[MINE_TITLED]["turn_count"] == 2
    # 沒分享給我的那組不在清單上
    assert THEIRS_PRIVATE not in items
    singles = [c for c in items.values() if c["conversation_id"].startswith("single-")]
    assert [c["title"] for c in singles] == ["沒有 conversation_id 的舊紀錄"]


def test_does_not_read_answers_or_other_peoples_meta(seeded):
    statements: list[tuple[str, object]] = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append((statement, parameters))

    with TestClient(app) as client:
        event.listen(engine, "before_cursor_execute", capture)
        try:
            _list(client)
        finally:
            event.remove(engine, "before_cursor_execute", capture)

    # 輪詢的回應用不到答案全文,一條 SQL 都不該選它
    assert not [s for s, _ in statements if "qa_records.answer" in s]

    meta_reads = [(s, p) for s, p in statements if "FROM conversation_meta" in s]
    assert meta_reads, "應該要查 conversation_meta 才拿得到自訂標題"
    for sql, params in meta_reads:
        # 一定是依 conversation_id 篩過的,不是整張表
        assert "WHERE" in sql and "conversation_id IN" in sql
        # 而且篩的範圍裡沒有我看不到的那組
        assert THEIRS_PRIVATE not in repr(params)
