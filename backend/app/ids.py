"""`conversation_id` 與帳號名的字元規則。**全專案只有這一份。**

conversations.py 與 notes.py 的 `_CONV_ID`、ask.py 的 `re.fullmatch`、schemas.py 的
`CreateUserRequest` 都從這裡拿 —— 幾個地方不一致的話,一邊建得起來的東西另一邊會存取不到。

擋的不是 SQL injection(SQLAlchemy 本來就會參數化),是:
  長度 —— 沒有上限的話,一個幾 MB 的路徑字串就會被拿去查資料庫
  字元 —— 這些值會進網址、當主鍵、組成側邊欄連結,奇怪的字元只會製造麻煩
"""

import re

from fastapi import Path

# 英數 + 底線 + 連字號,1~64 字
# ⚠️ 前端 `frontend/src/pages/Users.tsx` 的 `USERNAME_PATTERN` 照抄這一條,在送出前先擋
#    (不然使用者看到的是 pydantic 的原文正規式)。改這裡要一起改那裡。
NAME = r"[A-Za-z0-9_-]{1,64}"
ANCHORED = rf"^{NAME}$"

#: 給 pydantic 的 `Field(pattern=...)` 用
FIELD_PATTERN = ANCHORED

#: 給程式裡自己比對用(ask.py 收的是 request body,不是 path 參數)
REGEX = re.compile(ANCHORED)


def path_param() -> Path:
    """給 router 的 path 參數用。

    每次呼叫回一個新的 `Path` 實例而不是共用一個模組層級的物件 —— FastAPI 會把它
    當成參數的預設值,共用同一個實例在目前的版本雖然可行,但那是實作細節,
    不值得為了省一次物件建立去賭。
    """
    return Path(pattern=ANCHORED)
