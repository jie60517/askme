# -*- coding: utf-8 -*-
"""職稱(users.role)。它存的是角色的 id,權限由角色決定(roles.py,測試在 test_roles.py)。

`role` 是空的(NULL 或空字串)= 從沒設過,或管理員清掉了。畫面上退回 DEFAULT_ROLE。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_users_role.py
"""

from app import models, users
from app.database import Base, SessionLocal, engine

# 建表。這份只測 users 模組,用不到 app.main 的路由,所以自己 create_all 就好
# (回填 / close_orphan_runs 都在 main.init_database 裡,不會在 import 時跑)。
Base.metadata.create_all(bind=engine)


def _make_user(username: str, role=None):
    """直接建一列,繞過 create_user 的預設密碼那些跟這裡無關的東西。"""
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == username).delete()
        db.add(models.User(username=username, password="x", display_name=username, role=role))
        db.commit()
    finally:
        db.close()


def _role_of(username: str):
    db = SessionLocal()
    try:
        u = db.get(models.User, username)
        return u.role
    finally:
        db.close()


def _set_tools_directly(username: str, tools):
    db = SessionLocal()
    try:
        db.get(models.User, username).tools = tools
        db.commit()
    finally:
        db.close()


def _delete_user(username: str):
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == username).delete()
        db.commit()
    finally:
        db.close()


def test_normalize_role_trims_and_accepts_none():
    assert users.normalize_role("  Consultant  ") == "Consultant"
    assert users.normalize_role(None) == ""
    assert users.normalize_role("   ") == ""


def test_set_role_clears_to_null():
    """清掉職稱存 NULL,不留空字串。"""
    _make_user("ming", role="Software engineer")
    assert users.set_role("ming", "") is True
    assert _role_of("ming") is None


def test_both_kinds_of_empty_show_the_default_role():
    """NULL 與舊資料的空字串在畫面上等價。"""
    _make_user("ming", role=None)
    _make_user("ken", role="")

    by_name = {p["username"]: p for p in users.list_active()}
    assert by_name["ming"]["role"] == users.DEFAULT_ROLE
    assert by_name["ken"]["role"] == users.DEFAULT_ROLE


# ── 角色決定權限(由 roles.py 算,這裡只留 users 那幾支舊介面的行為)─────────


def test_role_grants_full_only_for_engineer():
    assert users.role_grants_full(users.ROLE_ENGINEER) is True
    assert users.role_grants_full(users.ROLE_CONSULTANT) is False
    # 認不得的一律往安全的那邊倒
    assert users.role_grants_full("Manager") is False
    assert users.role_grants_full(None) is False
    assert users.role_grants_full("") is False


def test_set_role_changes_permission_too():
    """改角色**同時**改權限 —— 權限只看角色(不再看 tools 欄)。"""
    _make_user("ming", role=users.ROLE_CONSULTANT)

    users.set_role("ming", users.ROLE_ENGINEER)
    assert users.is_power_user("ming"), "升成工程師卻沒拿到 AI 可執行指令"

    users.set_role("ming", users.ROLE_CONSULTANT)
    assert not users.is_power_user("ming"), "降回顧問卻還留著 AI 可執行指令"

    # 清掉 = 退回預設角色。不能留下「沒有角色卻有 Bash」的列。
    users.set_role("ming", users.ROLE_ENGINEER)
    users.set_role("ming", "")
    assert not users.is_power_user("ming"), "清掉角色卻還留著 AI 可執行指令"


def test_tools_column_no_longer_grants_anything():
    """舊的 tools='full' 不再給權限(只看角色):顧問 + tools full 一樣沒有 Bash。"""
    _make_user("ming", role=users.ROLE_CONSULTANT)
    _set_tools_directly("ming", "full")
    assert not users.is_power_user("ming")


def test_new_account_gets_the_default_role():
    """新帳號只給帳號名,角色 = 預設角色(要更多權限是另一次操作)。"""
    _delete_user("newbie")
    assert users.create_user("newbie") is True
    assert _role_of("newbie") == users.DEFAULT_ROLE
    assert not users.is_power_user("newbie")


def test_reserved_names_cannot_become_accounts():
    """管理員與 Work Flow 對話的擁有者都符合帳號名規則,但不能被建成帳號(不分大小寫);
    資料庫裡就算已經有那一列,get() 也不認,登不進來。"""
    from app import config

    for name in (config.WORKFLOW_OWNER, config.WORKFLOW_OWNER.upper(), config.ADMIN_USERNAME, config.ADMIN_USERNAME.upper()):
        assert users.is_reserved_name(name), name
        assert users.create_user(name) is False, name
    _delete_user(config.WORKFLOW_OWNER)
    try:
        _make_user(config.WORKFLOW_OWNER)
        assert users.get(config.WORKFLOW_OWNER) is None
        assert users.exists(config.WORKFLOW_OWNER) is False
    finally:
        _delete_user(config.WORKFLOW_OWNER)
    assert not users.is_reserved_name("work-flow-2")


# 權限目錄的副本(schemas.Perms、前端 PERM_KEYS)釘在 test_roles.py。
