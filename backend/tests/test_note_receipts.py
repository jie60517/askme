# -*- coding: utf-8 -*-
"""@ 便條的已讀:便條清單帶「誰看過了」+ 開著對話頁的即時推送線。

要守的四件事:
  看過才算 —— `seen` 只放 `seen_at` 有值的人,而且對話裡每個人拿到的都一樣
              (大家都看得到,不只寫便條的人)。
  推得到   —— 被 @ 的人打開對話(標已讀)、或有人寫了新便條,開著那組對話的連線收到
              `{"type": "notes"}`。標已讀那支路由是同步的(跑在執行緒池),推送要跨執行緒送得到。
  擋得住   —— 沒登入、看不到那組對話的人連不上;不然任何人都能聽「誰看過了」。
  不打擾   —— 標已讀沒標到任何一則(重複打開)不推,不然每次聚焦視窗大家都重抓一次。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_note_receipts.py
"""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import auth, live, models, shares, users
from app.database import Base, SessionLocal, engine
from app.main import app

ME = "rr-author"
JIM = "rr-jim"
MING = "rr-ming"
HUA = "rr-hua"  # 共用進來、沒被 @ 的人
STRANGER = "rr-stranger"
CONV = "r" * 32
ORIGIN = {"origin": "http://testserver"}

client = TestClient(app)


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_soft_delete.py:建表在 lifespan 裡,而 fixture 比它早。"""
    Base.metadata.create_all(engine)


@pytest.fixture(autouse=True)
def _people(monkeypatch):
    people = [ME, JIM, MING, HUA, STRANGER]
    monkeypatch.setattr(users, "list_active", lambda: [{"username": u} for u in people])
    monkeypatch.setattr(users, "display_names", lambda: {u: u.upper() for u in people})


@pytest.fixture(autouse=True)
def _clean():
    def wipe():
        db = SessionLocal()
        try:
            for table in (
                models.ConversationMention,
                models.ConversationNote,
                models.ConversationShare,
                models.QARecord,
            ):
                db.query(table).filter(table.conversation_id == CONV).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    wipe()
    db = SessionLocal()
    try:
        # `shares.can_access` 靠 qa_records.owner 判斷誰是主人
        db.add(
            models.QARecord(
                session_id="r" * 31 + "1",
                conversation_id=CONV,
                question="問題",
                answer="答案",
                owner=ME,
                asked_by=ME,
                status="done",
            )
        )
        db.commit()
        shares.add(db, CONV, HUA, ME)
    finally:
        db.close()
    yield
    wipe()


def _headers(username: str) -> dict:
    return {"Authorization": f"Bearer {auth._issue(username)}"}


def _note(text: str = f"@{JIM} @{MING} 幫我看一下") -> int:
    res = client.post(f"/api/conversations/{CONV}/notes", json={"text": text}, headers=_headers(ME))
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _read(username: str) -> int:
    res = client.post(f"/api/conversations/{CONV}/mentions/read", headers=_headers(username))
    assert res.status_code == 200, res.text
    return res.json()["marked"]


def _seen(viewer: str, note_id: int) -> dict:
    res = client.get(f"/api/conversations/{CONV}/notes", headers=_headers(viewer))
    assert res.status_code == 200, res.text
    return next(n for n in res.json() if n["id"] == note_id)["seen"]


def _connect(username: str):
    ws = client.websocket_connect(f"/api/conversations/{CONV}/live", headers=ORIGIN)
    ws.__enter__()
    ws.send_json({"type": "auth", "token": auth._issue(username)})
    return ws


# ── 便條清單的 seen ────────────────────────────────────────────────────


def test_seen_lists_only_people_who_opened_the_conversation():
    note_id = _note()
    assert _seen(ME, note_id) == {}

    _read(JIM)
    assert list(_seen(ME, note_id)) == [JIM]

    _read(MING)
    # 照看的先後排(畫面上的頭像順序)
    assert list(_seen(ME, note_id)) == [JIM, MING]


def test_everyone_in_the_conversation_sees_the_same_receipts():
    note_id = _note()
    _read(JIM)
    for viewer in (ME, JIM, MING, HUA):
        assert list(_seen(viewer, note_id)) == [JIM], viewer


def test_reading_counts_for_every_note_that_mentions_you():
    """標已讀是整組對話一起標(打開那組對話就算全看過了),兩則都要出現他。"""
    first = _note()
    second = _note(f"@{JIM} 還有這張")
    _read(JIM)
    assert JIM in _seen(ME, first)
    assert JIM in _seen(ME, second)


# ── 推送線:擋人 ────────────────────────────────────────────────────────


def test_live_rejects_without_login():
    with client.websocket_connect(f"/api/conversations/{CONV}/live", headers=ORIGIN) as ws:
        ws.send_json({"type": "auth", "token": "not-a-token"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4401


def test_live_rejects_people_who_cannot_see_the_conversation():
    ws = _connect(STRANGER)
    try:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4404
    finally:
        ws.__exit__(None, None, None)


def test_live_rejects_other_origins():
    with client.websocket_connect(
        f"/api/conversations/{CONV}/live", headers={"origin": "http://evil.example"}
    ) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4403


# ── 推送線:推得到 ──────────────────────────────────────────────────────


def test_live_pushes_when_someone_reads():
    _note()
    ws = _connect(ME)
    try:
        assert ws.receive_json() == {"type": "ready"}
        # 標已讀那支是同步路由(執行緒池),推送要跨執行緒回到這條連線的 event loop
        assert _read(JIM) == 1
        assert ws.receive_json() == {"type": "notes"}
    finally:
        ws.__exit__(None, None, None)


def test_live_pushes_new_notes_to_everyone_watching():
    ws = _connect(HUA)
    try:
        assert ws.receive_json() == {"type": "ready"}
        _note()
        assert ws.receive_json() == {"type": "notes"}
    finally:
        ws.__exit__(None, None, None)


def test_note_with_attachment_is_pushed_once_after_the_file_is_saved(monkeypatch):
    """網頁寫的便條只推一次,而且是附件存好之後 —— 先推的話別人會先看到沒有附件的那則。"""
    from app import uploads

    saved_before_push = []
    real_save = uploads.save_uploads_async

    async def spy_save(sid, files):
        result = await real_save(sid, files)
        saved_before_push.append(len(calls))
        return result

    calls = []
    monkeypatch.setattr(uploads, "save_uploads_async", spy_save)
    monkeypatch.setattr(live, "publish", calls.append)
    res = client.post(
        f"/api/conversations/{CONV}/notes",
        data={"text": f"@{JIM} 看這張"},
        files={"files": ("shot.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64, "image/png")},
        headers=_headers(ME),
    )
    assert res.status_code == 201, res.text
    assert calls == [CONV]
    assert saved_before_push == [0]


def test_leaving_the_share_pushes(monkeypatch):
    """離開共用的人看過的頭像要從大家畫面上消失,所以要推。"""
    from app import notes

    _note()
    _read(JIM)
    calls = []
    monkeypatch.setattr(live, "publish", calls.append)
    db = SessionLocal()
    try:
        notes.remove_for_user(db, CONV, JIM)
    finally:
        db.close()
    assert calls == [CONV]


def test_reading_again_does_not_push(monkeypatch):
    """重複打開(視窗每次聚焦都會打一次標已讀)沒標到任何一則,不推。

    不用連線來驗:推出去的那則會立刻被連線取走,看佇列空不空分不出有沒有推過。
    """
    _note()
    _read(JIM)
    calls = []
    monkeypatch.setattr(live, "publish", calls.append)
    assert _read(JIM) == 0
    assert _read(STRANGER) == 0
    assert calls == []


def test_live_closes_after_being_removed_from_the_share(monkeypatch):
    """被移出共用之後不能再聽「誰看過了」:下一輪檢查就關,而且是 4404(前端不重連)。"""
    from app import terminal

    monkeypatch.setattr(terminal, "TOKEN_CHECK_SEC", 0.05)
    ws = _connect(HUA)
    try:
        assert ws.receive_json() == {"type": "ready"}
        db = SessionLocal()
        try:
            shares.remove(db, CONV, HUA)
        finally:
            db.close()
        with pytest.raises(WebSocketDisconnect) as exc:
            while True:
                ws.receive_json()  # 中間可能夾著 ping
        assert exc.value.code == 4404
    finally:
        ws.__exit__(None, None, None)


def test_unsubscribes_when_the_page_closes():
    ws = _connect(ME)
    assert ws.receive_json() == {"type": "ready"}
    ws.__exit__(None, None, None)
    # 關頁之後再推不會找到任何佇列(不然訂閱清單只長不縮)
    for _ in range(50):
        if CONV not in live._subs:
            break
        import time

        time.sleep(0.02)
    assert CONV not in live._subs


def test_publish_without_listeners_is_a_no_op():
    live.publish("nobody-is-watching")
