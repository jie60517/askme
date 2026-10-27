# -*- coding: utf-8 -*-
"""自己改密碼(`POST /api/password`)打錯「目前的密碼」要計數、要留稽核紀錄。

不限次數的話,拿到一張 token 的人(借用沒鎖的電腦、偷到的 cookie)可以在這裡無限次猜目前的密碼。
跟登入共用帳號層的計數,錯到上限回 429;每一次打錯記 `password_change_failed`。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_password_change.py
"""
import pytest
from fastapi.testclient import TestClient

from app import config, models, ratelimit, users
from app.database import Base, SessionLocal, engine
from app.main import app

USERNAME = "pwchangeuser"
PASSWORD = "not-the-default-password"


@pytest.fixture
def account():
    Base.metadata.create_all(engine)

    def clean():
        with SessionLocal() as db:
            db.query(models.User).filter(models.User.username == USERNAME).delete()
            db.query(models.AuditLog).filter(models.AuditLog.actor == USERNAME).delete()
            db.commit()
        ratelimit.reset(username=USERNAME)

    clean()
    with SessionLocal() as db:
        db.add(models.User(username=USERNAME, password=users.hash_password(PASSWORD), display_name="PW"))
        db.commit()
    yield USERNAME
    clean()


def _events():
    with SessionLocal() as db:
        return [r.event for r in db.query(models.AuditLog).filter(models.AuditLog.actor == USERNAME)]


def test_wrong_current_password_is_counted_and_audited(account, monkeypatch):
    monkeypatch.setattr(config, "LOGIN_MAX_ATTEMPTS", 3)
    with TestClient(app) as client:
        token = client.post("/api/login", json={"username": account, "password": PASSWORD}).json()["token"]
        me = {"Authorization": f"Bearer {token}"}
        statuses = [
            client.post(
                "/api/password", json={"current_password": f"guess{i}", "new_password": "brand-new-pw"}, headers=me
            ).status_code
            for i in range(4)
        ]
        assert statuses[:3] == [400, 400, 400]
        assert statuses[3] == 429, statuses
        # 鎖著的時候連對的密碼也不比對(先擋再驗,同 login)
        right = client.post(
            "/api/password", json={"current_password": PASSWORD, "new_password": "brand-new-pw"}, headers=me
        )
        assert right.status_code == 429
    events = _events()
    assert events.count("password_change_failed") == 3
    assert "password_change_blocked" in events
    assert users.verify(account, PASSWORD)


def test_right_password_still_changes(account):
    with TestClient(app) as client:
        token = client.post("/api/login", json={"username": account, "password": PASSWORD}).json()["token"]
        resp = client.post(
            "/api/password",
            json={"current_password": PASSWORD, "new_password": "brand-new-pw"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 204
    assert users.verify(account, "brand-new-pw")
    assert "password_changed" in _events()
