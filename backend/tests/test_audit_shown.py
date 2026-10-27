"""安全頁「最近的事件」只顯示登入成功/失敗/被擋。其他事件**照記**,帶 `all_events=1` 才看得到。"""

from app import audit, models
from app.database import Base, SessionLocal, engine
from app.routers import audit as audit_router

Base.metadata.create_all(bind=engine)

ACTOR = "audit_shown_test"
SHOWN = ["login_success", "login_failed", "login_blocked_geo"]
HIDDEN = ["geo_allow_removed", "terminal_ai_ask", "workflow_saved", "account_deleted", "terminal_connect", "login_geo_allowlisted"]


def _events(**kwargs):
    db = SessionLocal()
    try:
        page = audit_router.list_audit(limit=200, db=db, **kwargs)
        return [e.event for e in page["items"] if e.actor == ACTOR]
    finally:
        db.close()


def setup_module():
    for event in SHOWN + HIDDEN:
        audit.record(event, actor=ACTOR)


def teardown_module():
    db = SessionLocal()
    try:
        db.query(models.AuditLog).filter(models.AuditLog.actor == ACTOR).delete()
        db.commit()
    finally:
        db.close()


def test_page_shows_only_login():
    assert set(_events(category=None, offset=0)) == set(SHOWN)


def test_login_is_the_only_category():
    import pytest
    from fastapi import HTTPException

    assert set(_events(category="login", offset=0)) == {"login_success", "login_failed", "login_blocked_geo"}
    # 不存在的分類要回錯誤,不要默默回全部
    with pytest.raises(HTTPException):
        _events(category="integration", offset=0)


def test_unknown_category_is_an_error_not_everything():
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        _events(category="terminal", offset=0)


def test_hidden_events_are_still_recorded():
    """畫面不顯示 ≠ 不記:事後還要查得到「誰刪了帳號、誰改了白名單」"""
    assert set(_events(category=None, offset=0, all_events=True)) == set(SHOWN + HIDDEN)
    assert set(_events(category="terminal", offset=0, all_events=True)) == {"terminal_ai_ask", "workflow_saved", "terminal_connect"}
