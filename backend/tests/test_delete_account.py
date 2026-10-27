# -*- coding: utf-8 -*-
"""刪帳號之後用同名重建,新的人不能接手前任的任何東西。

這些表都沒有外鍵、只認名字。刪帳號只刪 User 與 UserPref 的話,新的同名帳號一登入就看到前任的對話、
筆記、截圖,收到前任的分享與 @。規則:名字可以重用,前任做過的事改成封存名
(`名字#deleted-時間`,`#` 建不出來),他個人的東西刪掉。

守四件事:
  1. 存帳號名的地方**一個都沒漏**:掃所有表,看起來像帳號名的欄位都要列在 users 的三份清單裡;
     刪完之後再掃全庫每一格的**內容**,藏在 json(Work Flow 的圖、排程)、逗號名單裡的名字也要換掉;
  2. 同名重建的新帳號看不到前任的對話、分享、資料夾、@、筆記;
  3. 同事那邊不受影響:前任分享出來的對話照樣看得到(分享人改成封存名),同事自己的東西一樣不少;
  4. 記憶體裡以帳號名為 key 的也收掉:還開著的終端機連線、執行中流程的觸發者、登入失敗計數。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_delete_account.py
"""
import asyncio
import json
import re
from datetime import datetime

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient

from app import auth, config, ids, models, ratelimit, shares, terminal, users, workflow_engine, workflows
from app.database import Base, SessionLocal, engine
from app.main import app

GONE = "leaver-acct"
STAY = "stayer-acct"
CONV = "c" * 32  # 前任的對話,分享給了同事
CONV2 = "d" * 32  # 同事的對話,分享給了前任

#: 看起來像存帳號名的欄位
_USER_COLUMN = re.compile(r"^(username|owner|author|actor|mentioned)$|_by$")


def test_every_username_column_is_handled():
    """新增一個存帳號名的欄位卻沒告訴刪帳號要怎麼處理,同名重建的新帳號就會接手那一欄 —— 這條擋那種漏。

    `schedule` 是 json(裡面的 "by"),名字看不出來,所以清單裡有、這裡掃不到:只檢查清單裡的每一欄都真的存在。
    """
    handled = set(users.DELETED_USER_COLUMNS) | set(users.RENAMED_USER_COLUMNS) | set(users.KEPT_USER_COLUMNS)
    found = {
        (table.name, column.name)
        for table in Base.metadata.tables.values()
        for column in table.columns
        if _USER_COLUMN.search(column.name)
    }
    assert found - handled == set(), "這幾欄存帳號名,刪帳號時要刪、改封存名還是不動?加進 users 的清單"
    for table, column in handled:
        assert column in Base.metadata.tables[table].c, (table, column)
    # 同一欄不能同時刪又改名
    assert not set(users.DELETED_USER_COLUMNS) & set(users.RENAMED_USER_COLUMNS)


def test_archived_name_can_never_be_a_real_account():
    archived = users.archived_name("eden", datetime(2026, 10, 15, 9, 30, 0))
    assert archived == "eden#deleted-20261015093000"
    assert not ids.REGEX.match(archived)


def test_admin_cannot_create_reserved_names():
    """帳號管理頁建 WORKFLOW_OWNER / 管理員名(任何大小寫)要回 400 和原因,而不是建出來或回「建立失敗」。"""
    c = TestClient(app)
    admin = {"Authorization": f"Bearer {auth._issue(config.ADMIN_USERNAME)}"}
    for name in (config.WORKFLOW_OWNER, config.WORKFLOW_OWNER.upper(), config.ADMIN_USERNAME.upper()):
        r = c.post("/api/users", json={"username": name}, headers=admin)
        assert r.status_code == 400, (name, r.text)
        assert "保留" in r.json()["detail"]
    with SessionLocal() as db:
        assert db.get(models.User, config.WORKFLOW_OWNER.lower()) is None


# ------------------------------------------------------------------ 整個流程
@pytest.fixture(autouse=True)
def _setup(tmp_path, monkeypatch):
    Base.metadata.create_all(engine)
    monkeypatch.setattr(config, "NOTEBOOK_DIR", tmp_path / "notebook")
    config.NOTEBOOK_DIR.mkdir()
    _wipe()
    _add_user(GONE)
    _add_user(STAY, created_by=GONE)
    yield
    _wipe()


def _wipe():
    with SessionLocal() as db:
        # 倒著刪:workflow_runs 有外鍵指向 workflows
        for table, column in reversed(users.DELETED_USER_COLUMNS + users.RENAMED_USER_COLUMNS):
            if column == "schedule":
                continue
            t = Base.metadata.tables[table]
            db.execute(t.delete().where(t.c[column].like(f"%{GONE}%") | t.c[column].like(f"%{STAY}%")))
        db.query(models.AuditLog).filter(models.AuditLog.actor.in_([GONE, STAY])).delete(synchronize_session=False)
        db.commit()


def _add_user(name, created_by=None):
    with SessionLocal() as db:
        db.add(models.User(username=name, password=users.hash_password("pw-123456"), display_name=name,
                           created_by=created_by, password_changed_at=datetime.utcnow()))
        db.commit()


def _admin():
    return {"Authorization": f"Bearer {auth._issue(config.ADMIN_USERNAME)}"}


def _me(name):
    return {"Authorization": f"Bearer {auth._issue(name)}"}


def _note(db, owner: str, title: str) -> int:
    note = models.UserNote(username=owner, title=title, body="")
    db.add(note)
    db.flush()
    return note.id


def _graph_naming(name: str) -> dict:
    """一張圖:**每一種**有 people 欄位的拼圖各一塊,名單裡有 `name`、一個群組、一個同事。
    照 workflows.NODES 現算 —— 之後新增一種 people 欄位,這裡自動多一塊,沒處理到就會被下面的全庫掃描抓到。"""
    nodes = [{"id": "start", "type": "start"}]
    for ntype, spec in workflows.NODES.items():
        people = {f.key: [name, "group:all", STAY] for f in spec.fields if f.kind == "people"}
        if people:
            nodes.append({"id": f"n-{ntype}", "type": ntype, "cfg": people})
    assert len(nodes) > 1, "NODES 裡找不到任何 people 欄位 —— 「通知人員」改名了?"
    return {"nodes": nodes, "edges": []}


def _cells_naming(db, name: str):
    """全資料庫:哪些文字格子裡還有 `name` 這個帳號名(整個名字比對,封存名 `name#deleted-…` 不算)。
    掃的是**內容**不是欄位名 —— 藏在 json 裡(Work Flow 的圖、排程)、逗號名單裡的都抓得到。"""
    token = re.compile(rf"(?<![A-Za-z0-9_-]){re.escape(name)}(?![A-Za-z0-9_#-])")
    hits = []
    for table in Base.metadata.tables.values():
        cols = [c for c in table.columns if isinstance(c.type, (sa.String, sa.Text))]
        for row in db.execute(table.select()).mappings():
            hits += [(table.name, c.name) for c in cols if isinstance(row[c.name], str) and token.search(row[c.name])]
    return hits


def _seed():
    with SessionLocal() as db:
        # 對話:前任自己的(分享給同事)、同事分享給前任的
        for conv, owner in ((CONV, GONE), (CONV2, STAY)):
            db.add(models.QARecord(session_id=conv[:24] + "00000001", conversation_id=conv, question="q", answer="a",
                                   owner=owner, asked_by=owner, status="done"))
        db.add(models.ConversationShare(conversation_id=CONV, username=STAY, shared_by=GONE))
        db.add(models.ConversationShare(conversation_id=CONV2, username=GONE, shared_by=STAY))
        folder = models.ConversationFolder(username=GONE, name="待處理")
        db.add(folder)
        db.flush()
        db.add(models.ConversationFolderItem(username=GONE, conversation_id=CONV2, folder_id=folder.id))
        note = models.ConversationNote(conversation_id=CONV2, author=STAY, body="@leaver-acct 看一下", mentioned=f"{GONE},{STAY}x")
        db.add(note)
        db.flush()
        db.add(models.ConversationMention(note_id=note.id, conversation_id=CONV2, username=GONE))
        db.add(models.ConversationNote(conversation_id=CONV, author=GONE, body="前任寫的便條"))
        db.add(models.UserMFA(username=GONE, secret="S" * 32))
        db.add(models.UserPref(username=GONE, theme="dark"))
        graph = json.dumps(_graph_naming(GONE))
        wf = models.Workflow(name="刪帳號測試流程", created_by=GONE, updated_by=GONE, graph=graph,
                             schedule=json.dumps({"by": GONE, "times": ["09:00"]}))
        db.add(wf)
        db.flush()
        db.add(models.WorkflowRun(workflow_id=wf.id, trigger="schedule", triggered_by=GONE, status="done", graph=graph))
        db.add(models.AuditLog(event="login_success", actor=GONE))
        # 筆記:前任自己的 + 圖片;同事自己的
        mine = _note(db, GONE, "前任的筆記")
        theirs = _note(db, STAY, "同事的筆記")
        db.add(models.UserNoteImage(id="a" * 32, username=GONE, note_id=mine, ext="png", bytes=3))
        db.add(models.UserNoteImage(id="b" * 32, username=STAY, note_id=theirs, ext="png", bytes=3))
        db.commit()
        return mine, theirs, wf.id


def _count(db, table, column, value):
    t = Base.metadata.tables[table]
    return db.execute(t.select().where(t.c[column] == value)).first() is not None


def test_same_name_recreated_gets_nothing_from_the_predecessor():
    mine, theirs, wf_id = _seed()
    for image_id in ("a" * 32, "b" * 32):
        (config.NOTEBOOK_DIR / f"{image_id}.png").write_bytes(b"png")

    with TestClient(app) as client:
        assert client.delete(f"/api/users/{GONE}", headers=_admin()).status_code == 204
        with SessionLocal() as db:
            # 全庫掃內容:除了稽核紀錄(不改)與便條的內文(人寫的字,不是身分),哪裡都不能再有這個名字
            left = [hit for hit in _cells_naming(db, GONE) if hit[0] != "audit_log" and hit != ("conversation_notes", "body")]
            assert left == [], f"刪帳號後這些格子還留著前任的名字:{left}"
        _add_user(GONE)  # 新的人,同一個名字

        # 新的人:沒有對話、沒有分享給他的、沒有資料夾、沒有 @、沒有筆記
        assert client.get("/api/conversations", headers=_me(GONE)).json() == []
        with SessionLocal() as db:
            assert not shares.can_access(db, CONV, GONE) and not shares.can_access(db, CONV2, GONE)
            # 同事:前任分享出來的那組照樣看得到
            assert shares.can_access(db, CONV, STAY)

    with SessionLocal() as db:
        # 刪掉的:每一欄都不剩前任的名字(新帳號自己的 users 那一列除外)
        for table, column in users.DELETED_USER_COLUMNS:
            if table != "users":
                assert not _count(db, table, column, GONE), (table, column)
        # 改名的:每一欄都換成同一個封存名
        rec = db.query(models.QARecord).filter(models.QARecord.conversation_id == CONV).one()
        archived = rec.owner
        assert archived.startswith(f"{GONE}#deleted-") and rec.asked_by == archived
        assert db.query(models.ConversationShare).filter_by(conversation_id=CONV).one().shared_by == archived
        assert db.query(models.ConversationNote).filter_by(conversation_id=CONV).one().author == archived
        assert db.query(models.ConversationNote).filter_by(conversation_id=CONV2).one().mentioned == f"{archived},{STAY}x"
        assert db.get(models.User, STAY).created_by == archived
        wf = db.get(models.Workflow, wf_id)
        assert (wf.created_by, wf.updated_by, json.loads(wf.schedule)["by"]) == (archived, archived, archived)
        assert json.loads(wf.schedule)["times"] == ["09:00"]
        # 「通知人員」的名單:前任換成封存名,群組與同事原樣、順序不變;執行快照那份一樣
        run = db.query(models.WorkflowRun).filter_by(workflow_id=wf_id).one()
        for graph in (json.loads(wf.graph), json.loads(run.graph)):
            assert graph == _graph_naming(archived)
        # 跑的時候:直接點名的那一格已經不是新的同名帳號(封存名不是現存帳號,跳過)。
        # 群組(group:all)照樣圈得到新帳號 —— 那是他自己的身分,正確
        notify = next(n for n in json.loads(wf.graph)["nodes"] if n["type"] == "notify")
        named = [w for w in notify["cfg"]["who"] if not w.startswith("group:")]
        assert workflows.recipients(named) == [STAY]
        assert run.triggered_by == archived
        for table, column in users.RENAMED_USER_COLUMNS:
            if column != "schedule":
                assert not _count(db, table, column, GONE), (table, column)
        # 不動的:稽核紀錄
        assert _count(db, "audit_log", "actor", GONE)

        # 筆記:他的整份刪掉;同事的一樣都不能少
        assert db.query(models.UserNote).filter(models.UserNote.id == mine).count() == 0
        assert db.query(models.UserNote).filter(models.UserNote.id == theirs).count() == 1
        assert db.query(models.UserNoteImage).filter(models.UserNoteImage.username == STAY).count() == 1
    assert not (config.NOTEBOOK_DIR / f"{'a' * 32}.png").exists()
    assert (config.NOTEBOOK_DIR / f"{'b' * 32}.png").exists()


# ------------------------------------------------------------------ 記憶體裡的(連線、執行中的流程、失敗計數)
class _LiveSession:
    """terminal 登錄簿裡的一條還開著的連線。"""

    def __init__(self, username):
        self.username = username
        self.session_id = "delete-account-live-session"
        self.host_id = "main"
        self.close_reason = None

    async def close(self, reason):
        self.close_reason = reason


def test_deleting_closes_what_is_still_open_in_memory(monkeypatch):
    """token 收回只會讓 WebSocket 斷,登錄簿裡的連線還留著;刪帳號要當場收掉。"""
    monkeypatch.setattr(config, "LOGIN_MAX_ATTEMPTS", 5)
    live = _LiveSession(GONE)
    terminal._register(live)
    state = workflow_engine.RunState(
        id=-1, workflow_id=-1, workflow_name="刪帳號測試流程", graph={}, trigger="schedule", triggered_by=GONE, started_at=datetime.utcnow()
    )
    monkeypatch.setitem(workflow_engine._LIVE, -1, state)
    ratelimit.record_second_factor_failure(GONE)
    assert terminal.session_count(GONE) == 1
    try:
        with TestClient(app) as client:
            assert client.delete(f"/api/users/{GONE}", headers=_admin()).status_code == 204
        assert live.close_reason == "revoked"
        assert terminal.session_count(GONE) == 0
        assert state.triggered_by.startswith(f"{GONE}#deleted-")
        assert GONE not in ratelimit._accounts
    finally:
        asyncio.run(terminal.close_user(GONE))
        ratelimit.reset(username=GONE)
