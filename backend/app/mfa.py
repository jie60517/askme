"""多因子驗證的存取層:誰綁了、驗不驗得過。

分工:演算法在 `totp.py`(不碰資料庫),端點在 `routers/`,這裡只負責
「把狀態存好、讀對」。

**這是「管理員發放」的模型,不是自助綁定**:管理員替每個帳號產生 QR code,使用者用手機掃。

    管理員在帳號管理頁按「產生 QR code」→ 後端當場配一組密鑰、**立刻生效**
    → 畫面上出現 QR → 使用者拿手機掃 → 之後登入就要輸入六碼。

    手機壞掉、換手機、掃失敗:管理員再按一次,舊的當場作廢。
    **這是唯一的復原路徑**,所以沒有備用碼 —— 兩套復原機制只會讓人不知道該用哪一套,
    而且備用碼是印在紙上的長期祕密,在「隨時找得到管理員」的內部系統裡不划算。

⚠️ **這個模型下,管理員看得到使用者的密鑰**(他要把 QR 顯示出來給人掃)。
也就是說管理員有能力產生任何人的第二道驗證碼。這在這個系統裡不算降低門檻 ——
他本來就能重設任何人的密碼、而且有主機的 Bash 權限。但**這是一個真的差別**,
自助綁定的模型裡連管理員都拿不到密鑰。要改回自助就要把 `issue()` 拆成
「產生但不回傳密鑰」+「使用者自己確認」兩步。

**帳號名稱一律先過 `auth.canonical_username`。** 登入不分大小寫,而這張表的
主鍵是字串 —— 用他打進來的字去查的話,`Ming` 查不到 `ming` 那一列,
系統會判定「這個人沒有啟用 MFA」然後**直接放行**。也就是說,大小寫沒統一
不是查不到資料而已,是整道關卡被繞過去。所以正規化寫在這一層的入口,
不要指望每個呼叫端記得做。
"""

from datetime import datetime

from . import config, models, totp
from .database import session_scope as _session


def _canonical(username: str) -> str:
    """使用者打的帳號 → 系統認定的那個寫法。**只有一份規則,在 `auth` 裡。**

    ⚠️ `auth` 要 import 這個模組(登入時要問「他要不要第二道」),所以這裡
    **只能在函式內 import**,不能放模組層 —— 放上去就是啟動時的循環相依。
    不要在這裡另抄一份規則:兩份大小寫規則漂掉的症狀是
    「查不到那一列 → 判定沒啟用 MFA → 直接放行」,也就是整道關卡被繞過。
    """
    from . import auth

    return auth.canonical_username(username)


# ---------------------------------------------------------------- 查詢

def is_enabled(username: str) -> bool:
    """這個帳號登入時要不要第二道關卡。"""
    with _session() as db:
        return db.get(models.UserMFA, _canonical(username)) is not None


def enabled_usernames() -> set[str]:
    """所有已經綁定的帳號。

    帳號管理頁要在每一列標「綁了沒」,而那一頁一次列出全部的人 ——
    一個一個查就是 N 次往返,一次撈回來再比對只要一次。
    """
    with _session() as db:
        return {row[0] for row in db.query(models.UserMFA.username).all()}


# ---------------------------------------------------------------- 發放

def issue(username: str) -> dict:
    """配一組新密鑰給這個帳號,**立刻生效**,回傳畫 QR 需要的東西。

    ⚠️ **重複呼叫就是「重新產生」**,舊的當場作廢 —— 這正是手機壞掉時的解法。
    所以呼叫端一定要是管理員(路由層用 `require_admin` 擋),而且畫面上要講清楚
    「舊的會失效」,不然管理員會在不知情的狀況下把某個人擋在門外。

    **沒有「待確認」狀態**:管理員發的,發了就算數。自助綁定才需要那個中間狀態
    (使用者可能抄到一半跑掉),而這裡是當面掃碼。
    """
    name = _canonical(username)
    secret = totp.generate_secret()
    with _session() as db:
        row = db.get(models.UserMFA, name)
        if row is None:
            row = models.UserMFA(username=name, secret=secret)
            db.add(row)
        else:
            row.secret = secret
            row.created_at = datetime.utcnow()
        # 換了密鑰,舊密鑰用掉的計數器就沒有意義了 —— 不清的話,新密鑰的前幾組碼
        # 會被「小於等於 last_counter」那條規則擋掉,而使用者只看到「驗證碼不正確」。
        row.last_counter = None
        db.commit()

        return {
            "secret": secret,
            "formatted_secret": totp.format_secret(secret),
            "otpauth_uri": totp.provisioning_uri(secret, name, config.MFA_ISSUER),
        }


def revoke(username: str) -> bool:
    """解除綁定(整列刪掉)。回傳有沒有真的刪到東西。

    ⚠️ `MFA_REQUIRED` 開著的時候,解除綁定等於**把這個人擋在門外**
    (他沒有綁定就登不進來)。那是刻意的 —— 用途是「這個人離職了」,
    不是「他手機壞了」。手機壞掉要按的是重新產生(`issue`)。
    """
    name = _canonical(username)
    with _session() as db:
        row = db.get(models.UserMFA, name)
        if row is None:
            return False
        db.delete(row)
        db.commit()
        return True


# ---------------------------------------------------------------- 登入時的驗證

def verify_code(username: str, code: str) -> bool:
    """登入第二關。

    ⚠️ **成功時一定要把用掉的計數器寫回去** —— 少了這一步,同一組六碼在它那個
    30 秒窗內可以重複使用,MFA 就退化成「第二個固定密碼」。
    比對規則在 `totp.verify`。
    """
    name = _canonical(username)
    with _session() as db:
        row = db.get(models.UserMFA, name)
        if row is None:
            # 沒綁定的人不該走到這裡。回 False 而不是 True ——
            # 呼叫端若有邏輯錯誤,失敗的方向要往「進不去」那邊倒。
            return False

        counter = totp.verify(row.secret, code, row.last_counter)
        if counter is None:
            return False
        row.last_counter = counter
        db.commit()
        return True
