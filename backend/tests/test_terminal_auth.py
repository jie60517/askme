# -*- coding: utf-8 -*-
"""SSH 終端機(/ssh)的權限與設定。

- `auth.can_use_terminal()`:跟 Bash 權限同一個來源 —— 管理員、或職稱帶完整權限的帳號;
  Consultant、停用的、認不得的職稱、沒登入,一律 False。
- `/api/me` 的 `can_terminal`:身分過了**還要功能有開**(config.ssh_terminal_available)。
- 稽核的 `terminal` 分類要把五個事件都列進去,不然它們只會出現在「全部」。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_terminal_auth.py
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, models, users
from app.database import Base, SessionLocal, engine
from app.main import app
from app.routers import audit as audit_router

Base.metadata.create_all(bind=engine)


def _make_user(username: str, role, tools=None, disabled=False):
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == username).delete()
        db.add(
            models.User(
                username=username,
                password="x",
                display_name=username,
                role=role,
                tools=tools,
                disabled=disabled,
            )
        )
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _terminal_enabled(monkeypatch):
    """預設把功能開著、給一把(假的)金鑰路徑。要測「關掉」的案例自己再蓋掉。"""
    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", True)
    monkeypatch.setattr(config, "SSH_TERMINAL_KEY_FILE", "/nonexistent/key")
    monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", "")


@pytest.fixture
def people():
    _make_user("term_eng", role=users.ROLE_ENGINEER, tools="full")
    _make_user("term_cons", role=users.ROLE_CONSULTANT, tools=None)
    _make_user("term_off", role=users.ROLE_ENGINEER, tools="full", disabled=True)
    _make_user("term_weird", role="Intern", tools=None)
    yield
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username.like("term_%")).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_engineer_and_admin_can_use_terminal(people):
    assert auth.can_use_terminal("term_eng") is True
    assert auth.can_use_terminal(config.ADMIN_USERNAME) is True


def test_consultant_disabled_unknown_role_and_anonymous_cannot(people):
    assert auth.can_use_terminal("term_cons") is False
    assert auth.can_use_terminal("term_off") is False, "停用的帳號不能開終端機"
    assert auth.can_use_terminal("term_weird") is False, "認不得的職稱要往安全的那邊倒"
    assert auth.can_use_terminal(None) is False
    assert auth.can_use_terminal("") is False
    assert auth.can_use_terminal("nobody-here") is False


def test_terminal_permission_follows_role_not_a_second_switch(people):
    """職稱就是權限:把工程師改成 Consultant,終端機權限要跟著掉,不需要另外設定。"""
    assert users.set_role("term_eng", users.ROLE_CONSULTANT) is True
    assert auth.can_use_terminal("term_eng") is False
    assert users.set_role("term_eng", users.ROLE_ENGINEER) is True
    assert auth.can_use_terminal("term_eng") is True


def _me(token: str):
    return TestClient(app).get("/api/me", headers={"Authorization": f"Bearer {token}"}).json()


def test_api_me_reports_can_terminal(people):
    assert _me(auth.issue_token("term_eng"))["can_terminal"] is True
    assert _me(auth.issue_token("term_cons"))["can_terminal"] is False
    assert _me(auth.issue_token(config.ADMIN_USERNAME))["can_terminal"] is True


def test_api_me_ssh_mode_is_full_or_empty(people):
    """`ssh_mode` 只有兩種:"full"(工程師 / 管理員)與 ""(其他人,含 Consultant —— Consultant 沒有 SSH)。"""
    assert _me(auth.issue_token("term_eng"))["ssh_mode"] == "full"
    assert _me(auth.issue_token(config.ADMIN_USERNAME))["ssh_mode"] == "full"
    assert _me(auth.issue_token("term_cons"))["ssh_mode"] == ""
    assert _me(auth.issue_token("term_weird"))["ssh_mode"] == ""


def test_api_me_anonymous_is_false():
    body = TestClient(app).get("/api/me").json()
    assert body["username"] is None
    assert body["can_terminal"] is False


def test_api_me_false_when_feature_disabled_or_no_credentials(people, monkeypatch):
    token = auth.issue_token("term_eng")
    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", False)
    assert _me(token)["can_terminal"] is False, "開關關掉就不該顯示那一列"

    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", True)
    monkeypatch.setattr(config, "SSH_TERMINAL_KEY_FILE", "")
    monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", "")
    assert config.ssh_terminal_available() is False
    assert _me(token)["can_terminal"] is False, "沒有憑證 = 功能關閉,不是連的時候才炸"

    monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", "pw")
    assert config.ssh_terminal_available() is True
    assert _me(token)["can_terminal"] is True


def test_audit_terminal_category_lists_every_event():
    assert set(audit_router._CATEGORIES["terminal"]) == {
        "terminal_connect",
        "terminal_connect_failed",
        "terminal_disconnect",
        "terminal_denied",
        "terminal_file_upload",
        "terminal_file_delete",
        # 收線時結束這條連線開的程式
        "terminal_end_programs",
        # AI 助手:只記「誰在幾點問了一次」,問題與畫面內容不記
        "terminal_ai_ask",
        # Work Flow:一樣是「誰讓主機跑了東西」
        "workflow_saved",
        "workflow_deleted",
        "workflow_run",
        "workflow_stop",
        # 排程到點、負責人失效而跳過的那一次
        "workflow_run_denied",
    }


def test_terminal_defaults():
    """終端機設定的預設值。改預設值要是有意的,改了這裡跟著改。"""
    assert config.SSH_TERMINAL_HOST == "127.0.0.1"
    assert config.SSH_TERMINAL_PORT == 22
    assert config.SSH_TERMINAL_USER == "tiptop"
    # 0 = 閒置不斷線。規則只有兩條:
    # 前端 3 分鐘蓋螢幕保護(不是斷線)、關掉網頁才斷。要恢復自動斷線就把秒數填回 .env。
    assert config.SSH_TERMINAL_IDLE_TIMEOUT_SEC == 0
    # keepalive 要明顯小於 nginx 範本的 proxy_read_timeout(660),不然閒著的連線
    # 會被 nginx 切掉,而使用者看到的原因會是「網路中斷」。
    assert config.SSH_TERMINAL_KEEPALIVE_SEC == 240
    assert config.SSH_TERMINAL_CONNECT_TIMEOUT_SEC == 10
    assert config.SSH_TERMINAL_START_DIR == "~"
