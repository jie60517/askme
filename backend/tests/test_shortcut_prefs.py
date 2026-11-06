# -*- coding: utf-8 -*-
"""改過的快捷鍵與「要不要畫吉祥物」(user_prefs.shortcuts / companion_visible)。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_shortcut_prefs.py
"""

import json
import re
from pathlib import Path

from app import models, users
from app.database import Base, SessionLocal, engine

Base.metadata.create_all(bind=engine)

NAME = "shortcut_pref_test"
FRONTEND_SHORTCUTS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "shortcuts.ts"


def _clear():
    db = SessionLocal()
    try:
        db.query(models.UserPref).filter(models.UserPref.username == NAME).delete()
        db.commit()
    finally:
        db.close()


def test_ids_match_the_frontend():
    """後端白名單跟前端 `SHORTCUTS` 是同一份 id —— 前端加一個、這裡沒加,存了也會被丟掉。"""
    src = FRONTEND_SHORTCUTS.read_text(encoding="utf-8")
    block = src[src.index("export const SHORTCUTS"): src.index("];", src.index("export const SHORTCUTS"))]
    assert set(re.findall(r"id: '([a-z_]+)'", block)) == users.SHORTCUT_IDS


def test_unset_defaults():
    _clear()
    prefs = users.get_prefs(NAME)
    assert prefs["shortcuts"] is None
    assert prefs["companion_visible"] is True


def test_clean_keeps_known_and_drops_broken():
    assert users.clean_shortcuts(
        {
            "search": False,
            "new_chat": {"mod": True, "shift": True, "key": "j"},
            "sidebar": {"key": ""},
            "nope": False,
        }
    ) == {"search": False, "new_chat": {"mod": True, "shift": True, "alt": False, "key": "j"}}
    assert users.clean_shortcuts({"search": {"key": "x" * 17}}) is None
    assert users.clean_shortcuts({"search": {"key": "\x00"}}) is None
    assert users.clean_shortcuts("nope") is None


def test_save_replace_and_reset():
    _clear()
    assert users.set_display_prefs(NAME, None, None, shortcuts={"sidebar": False})
    assert users.get_prefs(NAME)["shortcuts"] == {"sidebar": False}
    # 每次送整份:這次沒有 sidebar = 它回到預設
    users.set_display_prefs(NAME, None, None, shortcuts={"search": {"mod": True, "key": "p"}})
    assert users.get_prefs(NAME)["shortcuts"] == {"search": {"mod": True, "shift": False, "alt": False, "key": "p"}}
    # {} = 全部回預設,存 NULL
    users.set_display_prefs(NAME, None, None, shortcuts={})
    assert users.get_prefs(NAME)["shortcuts"] is None
    _clear()


def test_other_prefs_leave_shortcuts_and_visibility_alone():
    _clear()
    users.set_display_prefs(NAME, None, None, shortcuts={"search": False}, companion_visible=False)
    users.set_display_prefs(NAME, 120, None)
    prefs = users.get_prefs(NAME)
    assert prefs["shortcuts"] == {"search": False}
    assert prefs["companion_visible"] is False
    users.set_display_prefs(NAME, None, None, companion_visible=True)
    assert users.get_prefs(NAME)["companion_visible"] is True
    _clear()


def test_unreadable_column_falls_back_to_defaults():
    """欄位裡是讀不懂的字(手改過資料庫)也不能讓設定對話框打不開。"""
    _clear()
    db = SessionLocal()
    try:
        db.add(models.UserPref(username=NAME, shortcuts="{not json"))
        db.commit()
    finally:
        db.close()
    assert users.get_prefs(NAME)["shortcuts"] is None
    _clear()


def test_api_round_trip():
    """`/api/me/prefs` 收、`/api/me` 回。"""
    from fastapi.testclient import TestClient

    from app import auth
    from app.main import app

    _clear()
    token = auth.issue_token(NAME)
    c = TestClient(app)
    h = {"Authorization": f"Bearer {token}"}
    r = c.put("/api/me/prefs", json={"shortcuts": {"new_chat": False}, "companion_visible": False}, headers=h)
    assert r.status_code == 204, r.text
    me = c.get("/api/me", headers=h).json()
    assert me["shortcuts"] == {"new_chat": False}
    assert me["companion_visible"] is False
    assert json.loads(json.dumps(me["shortcuts"])) == {"new_chat": False}
    _clear()


def test_clean_needs_ctrl_or_alt():
    """單鍵(Enter、Space、字母)不收:收進來的話全站會把那個鍵吃掉(前端 recordKey 同一條)。"""
    assert users.clean_shortcuts({"search": {"key": "Enter"}, "sidebar": {"shift": True, "key": "a"}}) is None
    assert users.clean_shortcuts({"sidebar": {"alt": True, "key": "b"}}) == {
        "sidebar": {"mod": False, "shift": False, "alt": True, "key": "b"}
    }


def test_api_rejects_huge_dict():
    from fastapi.testclient import TestClient

    from app import auth
    from app.main import app

    token = auth.issue_token(NAME)
    r = TestClient(app).put(
        "/api/me/prefs",
        json={"shortcuts": {f"k{i}": False for i in range(17)}},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 422
