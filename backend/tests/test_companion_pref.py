# -*- coding: utf-8 -*-
"""右下角的吉祥物(user_prefs.companion)。

沒設過 = None(前端畫預設的小夥伴);只收 `users.COMPANIONS` 裡的值,
不認得的當成沒帶 —— 不能把一個前端畫不出來的名字寫進資料庫。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_companion_pref.py
"""

from app import models, users
from app.database import Base, SessionLocal, engine

Base.metadata.create_all(bind=engine)

NAME = "companion_pref_test"


def _clear():
    db = SessionLocal()
    try:
        db.query(models.UserPref).filter(models.UserPref.username == NAME).delete()
        db.commit()
    finally:
        db.close()


def test_unset_is_none():
    _clear()
    assert users.get_prefs(NAME)["companion"] is None


def test_set_and_switch_back():
    _clear()
    assert users.set_display_prefs(NAME, None, None, companion="blob")
    assert users.get_prefs(NAME)["companion"] == "blob"
    assert users.set_display_prefs(NAME, None, None, companion=" Classic ")
    assert users.get_prefs(NAME)["companion"] == "classic"
    _clear()


def test_unknown_value_is_ignored():
    _clear()
    users.set_display_prefs(NAME, None, None, companion="blob")
    users.set_display_prefs(NAME, None, None, companion="dragon")
    assert users.get_prefs(NAME)["companion"] == "blob"
    _clear()


def test_other_prefs_leave_companion_alone():
    """拉字級拉桿(只帶 font_scale)不能把吉祥物洗掉。"""
    _clear()
    users.set_display_prefs(NAME, None, None, companion="blob")
    users.set_display_prefs(NAME, 120, None)
    prefs = users.get_prefs(NAME)
    assert prefs["companion"] == "blob"
    assert prefs["font_scale"] == 120
    _clear()


# ── Bloub 的型態與顏色 ───────────────────────────────


def test_shape_color_unset_is_none():
    _clear()
    prefs = users.get_prefs(NAME)
    assert prefs["companion_shape"] is None
    assert prefs["companion_color"] is None


def test_shape_color_set():
    _clear()
    assert users.set_display_prefs(NAME, None, None, companion_shape="nuage", companion_color=" Bleu ")
    prefs = users.get_prefs(NAME)
    assert prefs["companion_shape"] == "nuage"
    assert prefs["companion_color"] == "bleu"
    _clear()


def test_shape_color_unknown_is_ignored():
    """`encre` / `creme` 是上游有、但這裡刻意不收的(那就是 auto 的樣子)。"""
    _clear()
    users.set_display_prefs(NAME, None, None, companion_shape="goutte", companion_color="vert")
    users.set_display_prefs(NAME, None, None, companion_shape="dragon", companion_color="encre")
    users.set_display_prefs(NAME, None, None, companion_color="creme")
    prefs = users.get_prefs(NAME)
    assert prefs["companion_shape"] == "goutte"
    assert prefs["companion_color"] == "vert"
    _clear()


def test_switching_companion_keeps_shape_color():
    """切回 classic 再切回 blob,型態與顏色還在。"""
    _clear()
    users.set_display_prefs(NAME, None, None, companion="blob", companion_shape="triangle", companion_color="rose")
    users.set_display_prefs(NAME, None, None, companion="classic")
    users.set_display_prefs(NAME, None, None, companion="blob")
    prefs = users.get_prefs(NAME)
    assert (prefs["companion"], prefs["companion_shape"], prefs["companion_color"]) == ("blob", "triangle", "rose")
    _clear()


def test_auto_color_is_accepted():
    _clear()
    users.set_display_prefs(NAME, None, None, companion_color="violet")
    users.set_display_prefs(NAME, None, None, companion_color="auto")
    assert users.get_prefs(NAME)["companion_color"] == "auto"
    _clear()


# ── 調色盤自己挑的顏色 ───────────────────────────────


def test_custom_hex_color_is_accepted_lowercased():
    _clear()
    assert users.set_display_prefs(NAME, None, None, companion_color=" #E8590C ")
    assert users.get_prefs(NAME)["companion_color"] == "#e8590c"
    users.set_display_prefs(NAME, None, None, companion_color="bleu")
    assert users.get_prefs(NAME)["companion_color"] == "bleu"
    _clear()


def test_malformed_hex_is_ignored():
    """只收 #rrggbb —— 它會直接變成 SVG 的 fill,別的寫法一律不收。"""
    _clear()
    users.set_display_prefs(NAME, None, None, companion_color="#2fb380")
    for bad in ("#fff", "2fb380", "#2fb38g", "#2fb38080", "url(#x)", "red"):
        users.set_display_prefs(NAME, None, None, companion_color=bad)
    assert users.get_prefs(NAME)["companion_color"] == "#2fb380"
    _clear()
