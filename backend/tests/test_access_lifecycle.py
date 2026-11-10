# -*- coding: utf-8 -*-
"""帳號、對話與串流的存取邊界。

守的是:
  - 帳號被別人撞鎖時,本人重試不會把自己所在的 IP 永久封鎖;
  - 改角色不能拔掉直接改不了的成員的權限(D9a ③);
  - 帳號刪掉後,同名重建的新帳號拿不到前一個人在記憶體裡的題目,前一個人還在跑的題目會停掉;
  - owner 為 NULL 的公開池舊對話不能被續問;
  - 已經開著的串流在共用收回、登出之後會收線(重新接上那條,以及共用者自己送出的那條)。

跑法(在 backend/ 底下):
    .venv/bin/python -m pytest tests/test_access_lifecycle.py
"""
import asyncio
import json
import uuid
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import auth, config, models, ratelimit, roles, runs, shares, users
from app.database import Base, SessionLocal, engine
from app.main import app


@pytest.fixture(autouse=True, scope="module")
def _tables():
    Base.metadata.create_all(engine)
    roles.ensure_seeded()


def _mk(name, role=None, own=None):
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == name).delete()
        db.add(
            models.User(
                username=name,
                password="x",
                display_name=name,
                role=role,
                perm_overrides=json.dumps(own) if own is not None else None,
                password_changed_at=datetime.utcnow(),
            )
        )
        db.commit()
    finally:
        db.close()


def _h(user):
    return {"Authorization": f"Bearer {auth._issue(user)}"}


def _rec(conv, owner, q="q", a="a", session_id=None):
    db = SessionLocal()
    try:
        r = models.QARecord(
            conversation_id=conv, owner=owner, asked_by=owner, question=q, answer=a,
            status="done", success=True, session_id=session_id or uuid.uuid4().hex,
        )
        db.add(r)
        db.commit()
        return r.id
    finally:
        db.close()


# ------------------------------------------------------------------ 2. IP 永久封鎖


def test_retries_against_foreign_account_lock_do_not_ban_the_ip(monkeypatch):
    """別人從別處把帳號撞鎖,本人從自己的 IP 重試十次,不能把那個 IP 永久封鎖。"""
    monkeypatch.setattr(config, "TRUST_PROXY_HEADER", True)
    monkeypatch.setattr(config, "LOGIN_MAX_ATTEMPTS", 5)
    monkeypatch.setattr(config, "LOGIN_LOCKOUT_SEC", 900)
    monkeypatch.setattr(config, "LOGIN_IP_MAX_ATTEMPTS", 10)
    monkeypatch.setattr(config, "LOGIN_IP_LOCKOUT_SEC", 0)
    monkeypatch.setattr(config, "LOGIN_IP_ALLOWLIST", "")
    ratelimit._accounts.clear()
    ratelimit._ips.clear()
    for n in ("sa_alice", "sa_bob"):
        if users.get(n) is None:
            users.create_user(n)
        users.set_password(n, "Sa-pass-" + n)
    with TestClient(app) as c:
        for _ in range(5):
            c.post("/api/login", json={"username": "sa_alice", "password": "wrong"},
                   headers={"X-Forwarded-For": "198.51.100.7"})
        for _ in range(10):
            r = c.post("/api/login", json={"username": "sa_alice", "password": "Sa-pass-sa_alice"},
                       headers={"X-Forwarded-For": "203.0.113.50"})
            assert r.status_code == 429
        r = c.post("/api/login", json={"username": "sa_bob", "password": "Sa-pass-sa_bob"},
                   headers={"X-Forwarded-For": "203.0.113.50"})
        assert r.status_code == 200
    assert ratelimit.check("sa_bob", "203.0.113.50") == 0
    ratelimit._accounts.clear()
    ratelimit._ips.clear()


# ------------------------------------------------------------------ 3. 改角色拔權限


def test_role_edit_cannot_strip_a_higher_ranked_member():
    _mk("sa_mgr2", roles.ROLE_CONSULTANT, own={"users": True, "usage": True})
    with TestClient(app) as c:
        rid = c.post("/api/roles", json={"name": "SaLead", "perms": {"usage": True, "users": True}},
                     headers=_h(config.ADMIN_USERNAME)).json()["id"]
        _mk("sa_boss", rid, own={"security": True, "ai_exec": True})
        assert c.patch("/api/users/sa_boss", json={"perms": {}}, headers=_h("sa_mgr2")).status_code == 403
        assert c.patch(f"/api/roles/{rid}", json={"perms": {}}, headers=_h("sa_mgr2")).status_code == 403
        assert auth.perms_for("sa_boss")["users"] is True
        assert c.patch(f"/api/roles/{rid}", json={"name": "SaLead2"}, headers=_h("sa_mgr2")).status_code == 200
        assert c.patch(f"/api/roles/{rid}", json={"perms": {}}, headers=_h(config.ADMIN_USERNAME)).status_code == 200


# ------------------------------------------------------------------ 4. 刪帳號同名重建


def test_recreated_same_name_account_cannot_reach_predecessor_run():
    _mk("sa_old", roles.ROLE_CONSULTANT)
    conv = str(uuid.uuid4())
    rid = _rec(conv, "sa_old", q="PRED-Q", a="")
    run = runs.Run(run_id=uuid.uuid4().hex, conversation_id=conv, record_id=rid, question="PRED-Q", owner="sa_old")

    class _Task:  # 還在跑的背景 task 的替身:只要 done() / cancel()
        cancelled = False

        def done(self):
            return False

        def cancel(self):
            self.cancelled = True

    run.task = _Task()
    runs.register(run)
    run.emit({"type": "delta", "text": "PRED-SECRET"})
    with TestClient(app) as c:
        assert c.delete("/api/users/sa_old", headers=_h(config.ADMIN_USERNAME)).status_code == 204
        assert c.post("/api/users", json={"username": "sa_old"}, headers=_h(config.ADMIN_USERNAME)).status_code == 201
        users.set_password("sa_old", "Sa-successor-1")
        h = _h("sa_old")
        assert all(r["run_id"] != run.run_id for r in c.get("/api/ask/runs", headers=h).json())
        assert c.get(f"/api/ask/runs/{run.run_id}/stream", headers=h).status_code == 404
        assert c.post(f"/api/ask/runs/{run.run_id}/stop", headers=h).status_code == 404
    assert run.owner != "sa_old"
    # 前一個人還在跑的題目要停掉:人不在了,不該帶著他的工具權限繼續跑、繼續計費
    assert run.stop_requested and run.task.cancelled
    run.finish()


# ------------------------------------------------------------------ 5. 沒有擁有者的舊對話


def test_owner_null_legacy_conversation_cannot_be_continued(monkeypatch):
    from app import agent

    called = []

    async def fake(**kw):
        called.append(kw)
        yield {"type": "done", "success": True}

    monkeypatch.setattr(agent, "stream_agent_retrying", fake)
    _mk("sa_bob2", roles.ROLE_CONSULTANT)
    legacy = str(uuid.uuid4())
    _rec(legacy, None, q="LEGACY-Q", a="LEGACY-SECRET")
    with TestClient(app) as c:
        r = c.post("/api/ask", data={"question": "repeat", "conversation_id": legacy}, headers=_h("sa_bob2"))
    assert r.status_code == 404
    assert called == []
    db = SessionLocal()
    try:
        assert shares.owner_of(db, legacy) is None
        assert db.query(models.QARecord).filter(models.QARecord.conversation_id == legacy).count() == 1
    finally:
        db.close()


# ------------------------------------------------------------------ 6. 撤銷後串流


def test_open_stream_stops_after_access_is_revoked():
    from app.routers import ask as askr

    conv = str(uuid.uuid4())
    run = runs.Run(run_id=uuid.uuid4().hex, conversation_id=conv, record_id=0, question="Q", owner="sa_own")
    run.emit({"type": "delta", "text": "BEFORE"})
    allowed = {"v": True}

    async def go():
        got = []

        async def reader():
            async for chunk in askr._watch(run, still_allowed=lambda: allowed["v"], every=0.05):
                got.append(chunk)

        t = asyncio.create_task(reader())
        await asyncio.sleep(0.15)
        allowed["v"] = False
        await asyncio.sleep(0.15)
        run.emit({"type": "delta", "text": "AFTER_REVOKE"})
        run.finish()
        await asyncio.wait_for(t, 5)
        return "".join(got)

    out = asyncio.run(go())
    assert "BEFORE" in out
    assert "AFTER_REVOKE" not in out


def test_watch_run_rechecks_share_and_token():
    from app.routers import ask as askr

    _mk("sa_own2", roles.ROLE_CONSULTANT)
    _mk("sa_peer", roles.ROLE_CONSULTANT)
    conv = str(uuid.uuid4())
    rid = _rec(conv, "sa_own2")
    db = SessionLocal()
    db.add(models.ConversationShare(conversation_id=conv, username="sa_peer", shared_by="sa_own2"))
    db.commit()
    run = runs.Run(run_id=uuid.uuid4().hex, conversation_id=conv, record_id=rid, question="Q", owner="sa_own2")
    runs.register(run)
    token = auth._issue("sa_peer")
    seen = {}
    real = askr._watch

    def capture(r, still_allowed=None, **kw):
        seen["fn"] = still_allowed
        return real(r)

    askr._watch = capture
    try:
        asyncio.run(askr.watch_run(run.run_id, db=db, viewer="sa_peer", authorization=f"Bearer {token}"))
    finally:
        askr._watch = real
    check = seen["fn"]
    assert check() is True
    db.query(models.ConversationShare).filter_by(conversation_id=conv, username="sa_peer").delete()
    db.commit()
    assert check() is False
    db.add(models.ConversationShare(conversation_id=conv, username="sa_peer", shared_by="sa_own2"))
    db.commit()
    assert check() is True
    auth.logout(f"Bearer {token}")
    assert check() is False
    db.close()
    run.finish()


def test_shared_asker_stream_is_rechecked_but_owner_stream_is_not():
    """共用者自己送出的那條串流(run.owner 是原擁有者)也要定期重新確認;擁有者自己的不用。"""
    from app.routers import ask as askr

    run = runs.Run(run_id=uuid.uuid4().hex, conversation_id=str(uuid.uuid4()), record_id=0, question="Q", owner="sa_own3")
    seen = []
    real = askr._watch

    def capture(r, still_allowed=None, **kw):
        seen.append(still_allowed)
        return real(r)

    askr._watch = capture
    try:
        askr.stream_run(run, viewer="sa_own3", authorization="Bearer x")
        askr.stream_run(run, viewer="sa_peer3", authorization="Bearer x")
        askr.stream_run(run)
    finally:
        askr._watch = real
    assert seen[0] is None
    assert callable(seen[1])
    assert seen[2] is None
    assert seen[1]() is False  # token 不是他的 → 看不到
    run.finish()
