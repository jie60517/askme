# -*- coding: utf-8 -*-
"""職稱(users.role)與「職稱就是權限」。

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


def _tools_of(username: str):
    db = SessionLocal()
    try:
        return db.get(models.User, username).tools
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


# ── 職稱就是權限 ────────────────────────────────


def test_role_grants_full_only_for_engineer():
    assert users.role_grants_full(users.ROLE_ENGINEER) is True
    assert users.role_grants_full(users.ROLE_CONSULTANT) is False
    # 認不得的一律往安全的那邊倒
    assert users.role_grants_full("Manager") is False
    assert users.role_grants_full(None) is False
    assert users.role_grants_full("") is False


def test_set_role_writes_permission_too():
    """改職稱**同時**改權限 —— 這是最重要的一條。"""
    _make_user("ming", role=users.ROLE_CONSULTANT)

    users.set_role("ming", users.ROLE_ENGINEER)
    assert _tools_of("ming") == "full", "升成工程師卻沒拿到完整權限"

    users.set_role("ming", users.ROLE_CONSULTANT)
    assert _tools_of("ming") is None, "降回 Consultant 卻還留著完整權限"

    # 清掉職稱 = 退回唯讀。不能留下「沒有職稱卻有 Bash」的列。
    users.set_role("ming", users.ROLE_ENGINEER)
    users.set_role("ming", "")
    assert _tools_of("ming") is None, "清掉職稱卻還留著完整權限"


def test_new_account_is_readonly():
    """新帳號只給帳號名,預設職稱 = 唯讀(要完整權限是另一次操作)。"""
    _delete_user("newbie")
    assert users.create_user("newbie") is True
    assert _role_of("newbie") == users.DEFAULT_ROLE
    assert _tools_of("newbie") is None


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


# ── 職稱這兩個字串的三份副本,不能漂 ────────────────────────────────────
#
# 正本是 `users.ROLES`。另外兩份是不得不存在的副本:
#   - `schemas.RoleName`:Pydantic 的 `Literal` 只吃字面值,餵不進常數;
#     而 `schemas` 是葉子模組,反向 import `users` 會把 DB engine 拖進來。
#   - 前端 `adminApi.ts` 的 `USER_ROLES`:跨語言,沒有共用常數的辦法。
#
# 漂掉的症狀是靜悄悄的:後端用字串相等判斷要不要給完整權限,大小寫差一個字母
# 就是「畫面顯示 Consultant、實際上有 Bash」,或反過來把人默默降成唯讀。
# 所以在這裡釘住 —— 跟 test_terminal_bridge.py 釘前端關閉訊息同一個套路。


def test_schemas_role_literal_matches_users_roles():
    """`schemas.RoleName` 的合法值 = `users.ROLES` + 一個「清掉」的空字串。"""
    from typing import get_args

    from app import schemas

    literal_values = list(get_args(schemas.RoleName))

    assert literal_values == [*users.ROLES, ""], (
        "schemas.RoleName 跟 users.ROLES 漂掉了。正本是 users.ROLES,"
        "改職稱請先改那邊,再把 schemas.py 的 Literal 抄過去(順序也要一樣,"
        "那是下拉選單的順序)。空字串是 PATCH 的「清掉」語意,不能拿掉。"
    )


def test_frontend_role_list_matches_backend():
    """前端 `adminApi.ts` 的 `USER_ROLES` 要跟 `users.ROLES` 一字不差。

    大小寫是重點:`Software engineer` 的 e 是小寫。前端那份的註解已經寫了
    「大小寫要跟後端一模一樣」,這條把那句話變成會失敗的測試。

    部署包不含前端(`--exclude=frontend/src`),所以在部署的機器上跑會跳過。
    """
    import re
    from pathlib import Path

    import pytest

    src = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "adminApi.ts"
    if not src.exists():
        pytest.skip("找不到前端原始碼(部署包不含前端)")

    text = src.read_text(encoding="utf-8")
    m = re.search(r"export const USER_ROLES = \[([^\]]*)\] as const;", text)
    assert m, "adminApi.ts 的 USER_ROLES 解不出來 —— 宣告的寫法改了就要一起改這條"

    front = re.findall(r"'([^']+)'", m.group(1))

    assert front == users.ROLES, (
        f"前端 USER_ROLES {front} 跟後端 users.ROLES {users.ROLES} 對不上。"
        "兩邊的順序都是下拉選單的順序,連順序都要一樣。"
    )
