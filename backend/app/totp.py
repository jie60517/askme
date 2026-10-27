"""TOTP(RFC 6238)的**演算法**。這一層不碰資料庫,只做數學。

存取與流程在 `mfa.py`,端點在 `routers/`。分成兩層是因為這一層可以
單獨測(給定密鑰與時間,答案是唯一的),而那正是最不能出錯的部分。

**為什麼自己實作,不裝 pyotp。** 整段演算法是 30 行標準庫
(`hmac` + `hashlib` + `struct`),而多一個相依就多一件部署時會缺的東西 ——
pip 安裝是部署裡最容易失敗的一步,而 MFA 壞掉的表現是
**所有人都登不進來**。用標準庫的話,程式碼進得去主機就一定跑得動。

⚠️ **參數不能改**。SHA-1 / 6 位數 / 30 秒是 Google Authenticator、Microsoft
Authenticator、Authy 這些 App 的預設值,而 `otpauth://` 這個 URI 的
`algorithm`、`digits`、`period` 參數**有些 App 根本不讀**(它們假設就是預設值)。
改成 SHA-256 或 8 位數,在部分 App 上的症狀是「綁定成功,但每次驗證都失敗」,
而使用者完全看不出是哪裡錯。SHA-1 在這裡不是弱點:它是被當成 HMAC 的雜湊函式,
HMAC-SHA1 沒有已知的實用攻擊,而且密鑰每 30 秒只產生一個 6 位數輸出。
"""

import base64
import hashlib
import hmac
import secrets
import struct
import time
from typing import Optional
from urllib.parse import quote

# ---------------------------------------------------------------- TOTP 參數

_DIGITS = 6
_PERIOD_SEC = 30

#: 密鑰長度。RFC 4226 要求至少 128 bit、建議 160 bit,這裡給 160。
_SECRET_BYTES = 20

#: 允許前後各幾個 30 秒的時間窗。
#:
#: **1 是刻意的(前後各 30 秒,總共 90 秒的容許範圍)。** 給 0 的話,手機時鐘
#: 跟伺服器差幾秒就永遠驗不過,而使用者只會看到「驗證碼錯誤」——
#: 那是最難自己診斷的一種失敗。給 2 以上則是把可猜測的碼從 3 個變成 5 個,
#: 沒有換到任何實際好處(主機時間由 NTP 校準,不會漂到 60 秒)。
_SKEW_STEPS = 1


def generate_secret() -> str:
    """新的 base32 密鑰。**去掉 `=` 填充** —— 有些 App 的手動輸入欄位不接受它。"""
    return base64.b32encode(secrets.token_bytes(_SECRET_BYTES)).decode("ascii").rstrip("=")


def _decode_secret(secret: str) -> bytes:
    """把存起來的 base32 字串還原成位元組。填充是在這裡補回去的。"""
    cleaned = (secret or "").strip().replace(" ", "").upper()
    padded = cleaned + "=" * (-len(cleaned) % 8)
    return base64.b32decode(padded, casefold=True)


def _code_for_counter(secret_bytes: bytes, counter: int) -> str:
    """HOTP(RFC 4226):給定密鑰與計數器,算出那一組 6 位數。"""
    digest = hmac.new(secret_bytes, struct.pack(">Q", counter), hashlib.sha1).digest()
    # 動態截斷:用最後一個位元組的低 4 bit 決定從哪裡取 4 個位元組
    offset = digest[-1] & 0x0F
    truncated = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(truncated % (10 ** _DIGITS)).zfill(_DIGITS)


def current_counter(now: Optional[float] = None) -> int:
    """現在是第幾個 30 秒。測試要固定時間就傳 `now`。"""
    return int((time.time() if now is None else now) // _PERIOD_SEC)


def verify(
    secret: str,
    code: str,
    last_counter: Optional[int] = None,
    now: Optional[float] = None,
) -> Optional[int]:
    """驗證一組碼。**對的話回傳用掉的計數器,錯的話回 None。**

    ⚠️ **回傳計數器而不是 True/False,是為了擋重放。** 同一組 6 位數在 30 秒內
    有效,呼叫端必須把用過的計數器存起來,並在下一次呼叫時傳回 `last_counter`
    —— 少了這一步,肩窺或攔截到那 6 個數字的人在同一分鐘內可以再登入一次。

    `last_counter` 之前(含)的計數器一律跳過,所以每一組碼只能用一次。
    """
    digits = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(digits) != _DIGITS:
        return None

    try:
        secret_bytes = _decode_secret(secret)
    except Exception:
        # 密鑰壞掉(手動改過資料庫、或欄位被截斷)。當成驗證失敗,
        # 不要往上丟例外 —— 那會變成登入路徑上的 500。
        return None

    center = current_counter(now)
    for counter in range(center - _SKEW_STEPS, center + _SKEW_STEPS + 1):
        if counter < 0:
            continue
        if last_counter is not None and counter <= last_counter:
            continue
        if hmac.compare_digest(_code_for_counter(secret_bytes, counter), digits):
            return counter
    return None


def provisioning_uri(secret: str, account: str, issuer: str) -> str:
    """`otpauth://` URI。App 掃 QR code 或貼上這串就能綁定。

    標籤寫成 `發行者:帳號`,而且 `issuer` 參數再給一次 —— 兩個地方都要,
    因為各家 App 讀的位置不一樣,只給一邊的話有些 App 會顯示成沒有名字的項目。
    """
    label = quote(f"{issuer}:{account}", safe="")
    params = "&".join(
        [
            f"secret={quote(secret, safe='')}",
            f"issuer={quote(issuer, safe='')}",
            "algorithm=SHA1",
            f"digits={_DIGITS}",
            f"period={_PERIOD_SEC}",
        ]
    )
    return f"otpauth://totp/{label}?{params}"


def format_secret(secret: str) -> str:
    """手動輸入用:每 4 個字一組。

    人要照著螢幕把 32 個字元敲進手機,連在一起的話一定會看丟位置。
    App 收到時會自己把空白去掉,所以分組不影響綁定。
    """
    return " ".join(secret[i : i + 4] for i in range(0, len(secret), 4))
