# -*- coding: utf-8 -*-
"""個人設定的常用模型(user_prefs.preferred_model)。

只能選 opus 跟 sonnet:送 haiku 這類白名單外的值進來不能寫進資料庫
(當沒帶,原本的值不動)。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_preferred_model.py
"""

from app import config, models, users  # 白名單本身的內容由 test_config.py 驗
from app.database import Base, SessionLocal, engine

Base.metadata.create_all(bind=engine)

NAME = "preferred_model_test"


def _clear():
    db = SessionLocal()
    try:
        db.query(models.UserPref).filter(models.UserPref.username == NAME).delete()
        db.commit()
    finally:
        db.close()


def test_opus_and_sonnet_are_saved():
    _clear()
    users.set_display_prefs(NAME, None, None, preferred_model="Opus")
    assert users.get_prefs(NAME)["preferred_model"] == "opus"
    users.set_display_prefs(NAME, None, None, preferred_model="sonnet")
    assert users.get_prefs(NAME)["preferred_model"] == "sonnet"
    _clear()


def test_haiku_is_not_saved_and_the_old_value_stays():
    _clear()
    users.set_display_prefs(NAME, None, None, preferred_model="sonnet")
    users.set_display_prefs(NAME, None, None, preferred_model="haiku")
    assert users.get_prefs(NAME)["preferred_model"] == "sonnet"
    _clear()


def test_old_conversations_saved_with_haiku_fall_back_to_the_default():
    assert config.safe_model("haiku") == config.CLAUDE_MODEL
