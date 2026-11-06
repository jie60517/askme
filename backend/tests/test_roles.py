# -*- coding: utf-8 -*-
"""角色與權限(roles.py)。

守的是:
  種子  兩個種子角色每個關卡逐一對照;
  邊界  管理員全開、停用全關、對不上的角色退回預設角色;
  加減  個人加減只存跟角色不同的那幾項,改回一樣就消失,換角色照留;
  API   角色的 API、刪除的擋法、稽核、四條防升權;
  釘樁  權限目錄的副本(schemas.Perms、前端 PERM_KEYS)跟 roles.PERM_KEYS 一字不差。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_roles.py
"""
import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import auth, config, models, roles, users
from app.database import Base, SessionLocal, engine
from app.main import app


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_mfa.py:建表在 lifespan 裡,fixture 比它早。"""
    Base.metadata.create_all(engine)
    roles.ensure_seeded()


def _make_user(name, role=None, *, disabled=False, own=None):
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == name).delete()
        db.add(
            models.User(
                username=name,
                password="x",
                display_name=name,
                role=role,
                disabled=disabled,
                perm_overrides=json.dumps(own) if own is not None else None,
                password_changed_at=datetime.utcnow(),
            )
        )
        db.commit()
    finally:
        db.close()


def _auth(user):
    return {"Authorization": f"Bearer {auth._issue(user)}"}


def _admin():
    return _auth(config.ADMIN_USERNAME)


def _drop_roles(*ids):
    db = SessionLocal()
    try:
        db.query(models.Role).filter(models.Role.id.in_(ids)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _audit_count(event):
    db = SessionLocal()
    try:
        return db.query(models.AuditLog).filter(models.AuditLog.event == event).count()
    finally:
        db.close()


# ------------------------------------------------------------------ 種子角色


def test_工程師的每個關卡跟以前一樣():
    _make_user("r_eng", roles.ROLE_ENGINEER)
    assert auth.allowed_tools_for("r_eng") == config.ALLOWED_TOOLS_FULL
    assert auth.writable_dirs_for("r_eng") == config.CLAUDE_FULL_EXTRA_DIRS
    assert auth.has_perm("r_eng", "ai_exec") is True
    for key in ("usage", "security", "users"):
        assert auth.has_perm("r_eng", key) is False, key


def test_顧問的每個關卡跟以前一樣():
    _make_user("r_cons", roles.ROLE_CONSULTANT)
    assert auth.allowed_tools_for("r_cons") == config.ALLOWED_TOOLS
    assert auth.writable_dirs_for("r_cons") == []
    for key in ("ai_exec", "usage", "security", "users"):
        assert auth.has_perm("r_cons", key) is False, key


# ------------------------------------------------------------------ 邊界


def test_管理員全開_停用全關_對不上的退回預設角色():
    assert roles.covers(auth.perms_for(config.ADMIN_USERNAME), roles.ALL)
    _make_user("r_off", roles.ROLE_ENGINEER, disabled=True)
    assert auth.perms_for("r_off") == roles.NONE
    _make_user("r_weird", "Intern")
    assert auth.perms_for("r_weird") == roles.role_perms(roles.DEFAULT_ROLE)
    assert auth.perms_for("nobody_like_this") == roles.NONE
    assert auth.perms_for(None) == roles.NONE


def test_壞掉的權限一律當沒有():
    assert roles.clean_perms("not json") == roles.NONE
    assert roles.clean_perms({"usage": "yes", "users": "true", "ai_exec": 1}) == roles.NONE


# ------------------------------------------------------------------ 個人加減


def test_個人加減只存不同的那幾項():
    _make_user("r_own", roles.ROLE_CONSULTANT, own={})
    base = roles.role_perms(roles.ROLE_CONSULTANT)
    roles.set_user_access("r_own", value={**base, "usage": True})
    assert roles.access_of("r_own")["own"] == {"usage": True}
    assert auth.has_perm("r_own", "usage")

    # 改回跟角色一樣 → 個人設定那一項消失
    roles.set_user_access("r_own", value=base)
    assert roles.access_of("r_own")["own"] == {}

    # 換角色:個人加減照留
    roles.set_user_access("r_own", value={**base, "usage": True})
    roles.set_user_access("r_own", role_id=roles.ROLE_ENGINEER)
    access = roles.access_of("r_own")
    assert access["role"] == roles.ROLE_ENGINEER and access["own"] == {"usage": True}
    assert auth.has_perm("r_own", "ai_exec") and auth.has_perm("r_own", "usage")


# ------------------------------------------------------------------ 角色 API


def test_角色的新增改名改權限與稽核():
    with TestClient(app) as client:
        resp = client.post("/api/roles", json={"name": " 業務 ", "perms": {"usage": True}}, headers=_admin())
        assert resp.status_code == 201, resp.text
        role = resp.json()
        assert role["name"] == "業務" and role["perms"]["usage"] and not role["is_default"]
        try:
            # 名字規則
            for bad in ("業務", "admin", "x" * 41):
                assert client.post("/api/roles", json={"name": bad}, headers=_admin()).status_code in (400, 422), bad

            _make_user("r_sales", role["id"], own={})
            before = _audit_count("role_perms_changed")
            resp = client.patch(
                f"/api/roles/{role['id']}", json={"name": "業務部", "perms": {"usage": True, "ai_exec": True}}, headers=_admin()
            )
            assert resp.status_code == 200 and resp.json()["name"] == "業務部"
            assert _audit_count("role_perms_changed") == before + 1
            # 下一個請求就生效
            assert auth.has_perm("r_sales", "ai_exec") is True
            # @ 名單跟著角色名字走
            people = {p["username"]: p for p in users.list_active()}
            assert people["r_sales"]["role"] == "業務部" and people["r_sales"]["role_id"] == role["id"]
        finally:
            _make_user("r_sales", roles.ROLE_CONSULTANT)
            _drop_roles(role["id"])


def test_刪角色的三種擋法_而且一個刪不掉就全部不刪():
    with TestClient(app) as client:
        a = client.post("/api/roles", json={"name": "刪A"}, headers=_admin()).json()
        b = client.post("/api/roles", json={"name": "刪B"}, headers=_admin()).json()
        try:
            # 預設角色
            assert client.post("/api/roles/delete", json={"ids": [roles.DEFAULT_ROLE]}, headers=_admin()).status_code == 409
            # 有人用(停用的也算):A 有人,B 沒人 → 兩個都不刪
            _make_user("r_holder", a["id"], disabled=True)
            resp = client.post("/api/roles/delete", json={"ids": [a["id"], b["id"]]}, headers=_admin())
            assert resp.status_code == 409 and "刪A" in resp.json()["detail"]
            assert roles.get_role(b["id"]) is not None, "一個刪不掉就全部不刪"
            _make_user("r_holder", roles.ROLE_CONSULTANT)
            before = _audit_count("role_deleted")
            assert client.post("/api/roles/delete", json={"ids": [a["id"], b["id"]]}, headers=_admin()).status_code == 204
            assert roles.get_role(a["id"]) is None and roles.get_role(b["id"]) is None
            assert _audit_count("role_deleted") == before + 2
        finally:
            _drop_roles(a["id"], b["id"])


def test_改某人的角色與個人加減():
    _make_user("r_target", roles.ROLE_CONSULTANT, own={})
    with TestClient(app) as client:
        before = _audit_count("perms_changed")
        perms = {**roles.role_perms(roles.ROLE_ENGINEER), "usage": True}
        resp = client.patch("/api/users/r_target", json={"role": roles.ROLE_ENGINEER, "perms": perms}, headers=_admin())
        assert resp.status_code == 200, resp.text
        row = resp.json()
        assert row["role"] == roles.ROLE_ENGINEER and row["own"] == {"usage": True}
        assert row["perms"]["ai_exec"] is True and row["perms"]["usage"] is True
        assert _audit_count("perms_changed") == before + 1
        assert client.patch("/api/users/r_target", json={"role": "no-such-role"}, headers=_admin()).status_code == 400


def test_me帶實際權限():
    _make_user("r_me", roles.ROLE_CONSULTANT, own={"usage": True})
    with TestClient(app) as client:
        me = client.get("/api/me", headers=_auth("r_me")).json()
        assert me["perms"]["usage"] is True and me["perms"]["users"] is False
        admin = client.get("/api/me", headers=_admin()).json()
        assert admin["perms"]["users"] is True


def test_管理頁的關卡看各自的權限():
    _make_user("r_plain", roles.ROLE_CONSULTANT, own={})
    _make_user("r_usage", roles.ROLE_CONSULTANT, own={"usage": True})
    with TestClient(app) as client:
        assert client.get("/api/stats", headers=_auth("r_plain")).status_code == 403
        assert client.get("/api/stats", headers=_auth("r_usage")).status_code != 403
        assert client.get("/api/users", headers=_auth("r_usage")).status_code == 403
        assert client.get("/api/roles", headers=_auth("r_usage")).status_code == 403


# ------------------------------------------------------------------ 防升權


def test_有Users權限的人不能替自己升權():
    # 經理:顧問 + Users;手下:顧問;老闆:工程師(有經理沒有的權限)
    _make_user("r_mgr", roles.ROLE_CONSULTANT, own={"users": True})
    _make_user("r_staff", roles.ROLE_CONSULTANT, own={})
    _make_user("r_boss", roles.ROLE_ENGINEER, own={})
    mgr = _auth("r_mgr")
    denied_before = _audit_count("users_action_denied")
    with TestClient(app) as client:
        assert client.get("/api/users", headers=mgr).status_code == 200
        # ① 不能動自己
        assert client.patch("/api/users/r_mgr", json={"perms": {**auth.perms_for("r_mgr"), "usage": True}}, headers=mgr).status_code == 403
        # ② 給不出自己沒有的權限
        assert client.patch("/api/users/r_staff", json={"role": roles.ROLE_ENGINEER}, headers=mgr).status_code == 403
        assert client.post("/api/roles", json={"name": "偷渡", "perms": {"ai_exec": True}}, headers=mgr).status_code == 403
        # ③ 動不了權限比自己大的人(連重設密碼都不行)與角色
        assert client.post("/api/users/r_boss/reset-password", headers=mgr).status_code == 403
        assert client.patch("/api/users/r_boss", json={"disabled": True}, headers=mgr).status_code == 403
        assert client.patch(f"/api/roles/{roles.ROLE_ENGINEER}", json={"name": "改掉"}, headers=mgr).status_code == 403
        # ④ 碰不到管理員
        assert client.post(f"/api/users/{config.ADMIN_USERNAME}/mfa", headers=mgr).status_code == 403
        assert client.get("/api/admin-account", headers=mgr).status_code == 403
        # 擋下的每一次都記稽核(admin-account 是 require_admin 擋的,不算在內)
        assert _audit_count("users_action_denied") == denied_before + 7
        # 自己有的權限範圍內可以給
        ok = client.patch("/api/users/r_staff", json={"perms": {**auth.perms_for("r_staff"), "users": True}}, headers=mgr)
        assert ok.status_code == 200 and ok.json()["perms"]["users"] is True


def test_名字換大小寫或加空白也繞不過發手機驗證碼的權限檢查():
    """檢查用原樣的名字、寫入卻不分大小寫的話:`BOSS` 查不到人就跳過比對,寫進去的是 boss 的密鑰。"""
    from app import mfa

    _make_user("r_mgr2", roles.ROLE_CONSULTANT, own={"users": True})
    _make_user("r_boss2", roles.ROLE_ENGINEER, own={})
    mgr = _auth("r_mgr2")
    with TestClient(app) as client:
        for variant in ("R_BOSS2", "R_Boss2", "r_boss2%20"):
            assert client.post(f"/api/users/{variant}/mfa", headers=mgr).status_code == 403, variant
        assert client.post("/api/users/nobody_here/mfa", headers=mgr).status_code == 404
    assert not mfa.is_enabled("r_boss2")


# ------------------------------------------------------------------ 釘樁


def test_schemas的權限欄位跟目錄一字不差():
    from app import schemas

    assert list(schemas.Perms.model_fields) == list(roles.PERM_KEYS), (
        "schemas.Perms 跟 roles.PERM_KEYS 漂掉了。正本是 roles.py,改權限目錄請兩邊一起改(順序是畫面上的順序)"
    )


def test_前端的權限目錄跟後端一字不差():
    """前端 adminApi.ts 的 PERM_KEYS 要跟 roles.PERM_KEYS 一字不差(連順序)。部署包不含前端,主機上跳過。"""
    import re
    from pathlib import Path

    src = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "adminApi.ts"
    if not src.exists():
        pytest.skip("找不到前端原始碼(部署包不含前端)")
    m = re.search(r"export const PERM_KEYS = \[([^\]]*)\] as const;", src.read_text(encoding="utf-8"))
    assert m, "adminApi.ts 的 PERM_KEYS 解不出來 —— 宣告的寫法改了就要一起改這條"
    assert re.findall(r"'([^']+)'", m.group(1)) == list(roles.PERM_KEYS)
