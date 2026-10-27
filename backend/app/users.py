"""使用者帳號的存取層。

帳號只存在資料庫(models.User),沒有任何檔案版本的帳號清單。放資料庫的理由:
要能在網頁上管理帳號(新增/停用/刪除/改權限),而且每個變更都要留稽核軌跡。
新機器第一個帳號由管理員(密碼在 .env)登入帳號管理頁建立。

get() 在 session 內就把欄位轉成 dict 回傳,避免 SQLAlchemy 物件 detached 後讀不到屬性。

管理員(config.ADMIN_USERNAME)**不在這張表**:密碼在 .env,不走這裡。
"""

import functools
import hashlib
import hmac
import json
import logging
import re
import secrets
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from . import config, models
from .database import SessionLocal

logger = logging.getLogger(__name__)

#: 現行格式:`pbkdf2_sha256$<迭代數>$<鹽 hex>$<雜湊 hex>`。
_PBKDF2_PREFIX = "pbkdf2_sha256$"

#: 迭代數。OWASP 2023 起對 PBKDF2-HMAC-SHA256 的建議值。
#:
#: 600,000 次約需數百毫秒 —— 登入慢這一下是**刻意的**:它同時也是線上猜密碼的
#: 成本。要調的話往上調,不要往下。
#: 迭代數存在字串裡,所以調高不會讓既有的密碼失效(每一列照它自己的次數驗,
#: 驗過之後由 `verify()` 順手改寫成新的)。
_PBKDF2_ITERATIONS = 600_000

_SALT_BYTES = 16


def hash_password(plain: str) -> str:
    """把明文密碼變成可以存進資料庫的字串。**每次呼叫的鹽都不一樣。**"""
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"{_PBKDF2_PREFIX}{_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


@functools.lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """帳號不存在時拿來「白算一次」的雜湊,讓回應時間跟帳號存在時一樣(見 verify)。

    第一次呼叫才算(60 萬輪要 ~270ms),不要在 import 時付 —— 測試與 CLI 也會 import 這個模組。
    """
    return hash_password("not-a-real-password")


def _matches(supplied: str, stored: str) -> bool:
    """這組明文對不對得上存起來的那個字串(`pbkdf2_sha256$…`)。

    用 compare_digest 而不是 ==:字串比對會在第一個不同的字元就回傳,
    比對時間會洩漏「前面對了幾個字」。成本是零,就順手用對的那個。

    ⚠️ **不接受明文儲存。** 「存的東西不像雜湊,就當成明文直接比」看似方便
    (寫入端本來就走 `hash_password`,平常走不到),但它是一條「只要有人手動往
    資料庫塞一列,就完全繞過雜湊」的後門,而且從程式碼上看不出那是意外還是設計。
    對不上格式一律回 False。
    """
    stored = (stored or "").strip()

    if stored.startswith(_PBKDF2_PREFIX):
        try:
            iterations_s, salt_hex, digest_hex = stored[len(_PBKDF2_PREFIX) :].split("$")
            salt = bytes.fromhex(salt_hex)
            expected = bytes.fromhex(digest_hex)
            iterations = int(iterations_s)
        except ValueError:
            # 格式壞掉的列一律當「對不上」,不要讓它變成例外把登入打掛
            return False
        actual = hashlib.pbkdf2_hmac("sha256", supplied.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)

    return False


def needs_rehash(stored: str) -> bool:
    """這個字串是不是該重算了(不是 PBKDF2,或迭代數比現行的 `_PBKDF2_ITERATIONS` 低)。"""
    stored = (stored or "").strip()
    if not stored.startswith(_PBKDF2_PREFIX):
        return True
    try:
        iterations = int(stored[len(_PBKDF2_PREFIX) :].split("$")[0])
    except ValueError:
        return True
    return iterations < _PBKDF2_ITERATIONS


def is_reserved_name(username: str) -> bool:
    """這個帳號名是不是系統保留的:管理員(`ADMIN_USERNAME`)與 Work Flow 對話的擁有者(`WORKFLOW_OWNER`)。

    兩個都符合帳號名規則(ids.NAME),所以要另外擋。WORKFLOW_OWNER 被建成真帳號的話,
    那個人就是所有 `workflow-*` 對話的 owner,看得到每一次執行的輸出。比對不分大小寫(理由同 get())。
    """
    name = (username or "").strip().lower()
    return bool(name) and name in {config.ADMIN_USERNAME.lower(), config.WORKFLOW_OWNER.lower()}


def get(username: str) -> Optional[dict]:
    """找一個帳號,回一個 dict(欄位同 User);找不到、或撞到保留名(is_reserved_name),回 None。

    **在 session 內就轉成 dict** —— SQLAlchemy 物件在 session 關掉後會 detached,
    再讀屬性會炸。

    撞名管理員的要排除:不排除的話那個人登入時會走到管理員那條路,拿到權限。
    撞名 WORKFLOW_OWNER 的同理:那一列登入後會成為所有 Work Flow 對話的 owner。
    撞名的判斷**不分大小寫** —— 只比對相同大小寫的話,`ADMIN` 就繞過了這道。

    **查詢不分大小寫**(先精準比對走主鍵索引,沒中才退回 lower 比對)。
    人記得的是「我的帳號是 ming」,不是「M 要不要大寫」;而回傳的 `username`
    一律是**資料庫裡存的那個大小寫**,呼叫端要拿它當身分 —— 見 resolve()。
    """
    username = username.strip()
    if not username or is_reserved_name(username):
        return None
    db = SessionLocal()
    try:
        u = db.get(models.User, username)
        if u is None:
            from sqlalchemy import func

            # order_by 不是裝飾:萬一資料庫裡真的同時存在 `ming` 與 `Ming`
            # (create_user 擋得掉,但既有資料可能有),沒有排序的話 .first()
            # 挑到哪一列不保證,同一個人今天登入是這個身分、明天是另一個 ——
            # 對話會像消失一樣。固定挑同一列,至少行為是穩定可查的。
            u = (
                db.query(models.User)
                .filter(func.lower(models.User.username) == username.lower())
                .order_by(models.User.username)
                .first()
            )
        if u is None or not u.password:
            return None
        return {
            "username": u.username,
            "password": u.password,
            "display_name": u.display_name,
            "tools": u.tools,
            "disabled": u.disabled,
            # 「他自己改過密碼了嗎」。**只有 set_password() 會寫它**,
            # 而那條路擋掉了「改成預設密碼」—— 所以有值就必然不是預設值。
            # is_default_password() 靠這個省掉一次 ~270ms 的 PBKDF2 比對。
            "password_changed_at": u.password_changed_at,
        }
    finally:
        db.close()


def resolve(username: str) -> Optional[str]:
    """把使用者打的帳號對回**資料庫裡存的那個大小寫**。找不到回 None。

    為什麼非有不可:帳號名同時是資料的擁有者(`qa_records.owner`、共用名單、
    資料夾)。使用者打 `Ming` 而資料庫存的是 `ming` 的話,直接拿他打的字當身分,
    他會登入成功卻**看不到自己的任何一組對話** —— 那些的 owner 是 `ming`。
    所以身分一律用資料庫存的那個,登入時就換過去。
    """
    entry = get(username)
    return str(entry["username"]) if entry else None


def verify(username: str, password: str) -> bool:
    """密碼對不對。**對了、而且迭代數比現行的低,就順手用現行的迭代數重算。**

    ⚠️ 重算只能發生在這裡:改寫需要明文,而系統唯一拿得到明文的時刻就是他登入
    的這一瞬間。調高 `_PBKDF2_ITERATIONS` 之後,各帳號在下一次登入時跟上。
    """
    entry = get(username)
    if not entry or entry.get("disabled"):
        # 停用的帳號登不進去 —— 帳號還在、軌跡還在,只是這道門關了。
        # ⚠️ 但**照樣算一次 PBKDF2** 再回 False:存在的帳號要花 ~270ms 比對,
        # 不存在的立刻回,回應時間就是一份帳號清單(打一輪就知道誰在)。
        _matches(password, _dummy_hash())
        return False

    stored = str(entry["password"])
    if not _matches(password, stored):
        return False

    if needs_rehash(stored):
        # ⚠️ **不要動 `password_changed_at`。** 那個欄位的意思是「他自己改過密碼」,
        # 而這裡換的是儲存方式,不是密碼 —— 寫下去的話,還在用預設密碼的人會被
        # 當成「已經改過了」,強制改密碼那道就對他失效了。
        _store_hash(str(entry["username"]), hash_password(password))

    return True


def _store_hash(username: str, hashed: str) -> None:
    """只覆蓋 `password` 這一欄,其他一律不碰。失敗就算了(下次登入再試一次)。

    重算失敗不該讓登入失敗 —— 他的密碼是對的,存著的那份雜湊仍然驗得過。
    """
    db = SessionLocal()
    try:
        u = db.get(models.User, username)
        if u is not None:
            u.password = hashed
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    finally:
        db.close()


def display_name(username: str) -> str:
    entry = get(username)
    return str(entry.get("display_name") or username) if entry else username


def is_power_user(username: str) -> bool:
    """這個帳號能不能用完整工具組(含 Bash)。打錯字(非 "full")一律當唯讀。"""
    entry = get(username)
    return bool(entry) and str(entry.get("tools", "")).strip().lower() == "full"


def is_default_password(username: str) -> bool:
    """這個人還在用發下去的預設密碼(所有人同一組,改掉之前等於沒有隔離)。

    ⚠️ **這一支跑在 `auth.require_user` 裡,也就是每一個需要登入的 API 都會呼叫。**
    所以它必須便宜:一次 PBKDF2 比對要 ~270ms,每次都比對等於**每一支 API 都慢 0.27 秒**。

    捷徑:`password_changed_at` 有值就直接回 False,不比對。
    這個推論成立的前提有兩條,兩條都在程式裡:
      1. 只有 `set_password()` 會寫那個欄位(`reset_password()` 把它清回 None);
      2. 它唯一的呼叫端 `routers/auth.change_password` **擋掉了「改成預設密碼」**。
    所以「有值」= 他自己改過 = 一定不是預設值。
    真的要算的只剩從沒改過的那些人,而他們本來就被擋在強制改密碼那一頁。

    ⚠️ 上面第 2 條要是哪天被拿掉,這個捷徑就會開始說謊(有人把密碼改回預設值
    卻不再被標記)。改那條前先回來看這裡。

    ⚠️ **捷徑漏掉的那群人:欄位是空的、密碼卻不是現在的預設值。** `DEFAULT_USER_PASSWORD`
    換過之後,用前一組預設密碼建、還沒改過的帳號就是這樣。
    這些人每一支 API 都要真的算一次,主機忙的時候一次可達 1 秒。所以比對結果記在
    `_default_check_cache`(見 `_row_uses_default_password_cached`),同一份雜湊只算一次。
    """
    entry = get(username)
    if not entry:
        return False
    # 快取的 key 用資料庫裡存的那個大小寫(get 不分大小寫,傳進來的可能是 Alice)
    return _row_uses_default_password_cached(
        str(entry["username"]), str(entry["password"]), entry.get("password_changed_at")
    )


#: username → (當時存的雜湊字串, 當時的預設密碼, 是不是預設密碼)。給 `_row_uses_default_password_cached` 用。
_default_check_cache: dict[str, tuple[str, str, bool]] = {}


def _row_uses_default_password_cached(
    username: str, stored: str, changed_at: Optional[datetime]
) -> bool:
    """帳號表的這一列是不是還在用預設密碼。`is_default_password` 與帳號管理頁(`list_users`)共用這一份判斷。

    `password_changed_at` 有值直接回 False(理由見 `is_default_password`);要真的比對時,
    同一個人同一份雜湊只算一次(~270ms,主機忙時 1 秒)。

    **用雜湊字串與預設密碼本身當版本**,所以不用在任何寫入的地方記得清快取:改密碼、管理員重設、
    登入時重算迭代數,`hash_password` 每次都換新的鹽,字串一定不一樣 → 對不上就重算;
    預設密碼(`config.DEFAULT_USER_PASSWORD`)換了也一樣(平常要重啟才換,測試會在執行中換)。
    """
    default = config.DEFAULT_USER_PASSWORD
    if not default or changed_at is not None:
        return False
    cached = _default_check_cache.get(username)
    if cached is not None and cached[:2] == (stored, default):
        return cached[2]
    result = _matches(default, stored)
    _default_check_cache[username] = (stored, default, result)
    return result


def set_password(username: str, new_password: str) -> bool:
    """改密碼並記下變更時間。帳號不存在回 False。原子性交給資料庫交易。"""
    username = username.strip()
    db = SessionLocal()
    try:
        u = db.get(models.User, username)
        if u is None:
            return False
        u.password = hash_password(new_password)
        u.password_changed_at = datetime.utcnow()
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("改密碼寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


# ---------------------------------------------------------------- 管理(給管理員用)
#
# 這些是「管理員在網頁上操作帳號」的後端。都回傳簡單的成功/失敗,由 API 層轉成
# 適當的 HTTP 錯誤 + 寫稽核。帳號名的格式檢查在 API 層做(這裡假設已經乾淨)。


def list_users() -> list[dict]:
    """所有帳號(不含密碼雜湊),給管理頁看。附帶「是否還在用預設密碼」與「發過 QR 沒」。"""
    # ⚠️ **函式內 import,不能放模組層** —— `mfa` 會(在它自己的函式內)反過來
    # import `auth`,而 `auth` 在模組層就 import 了 `users`。放上去就是循環相依。
    from . import mfa

    # 一次撈回所有已綁定的帳號再比對。一列查一次的話,N 個帳號就是 N 趟往返,
    # 而這一頁本來就是一次列出全部的人。
    bound = mfa.enabled_usernames()

    db = SessionLocal()
    try:
        rows = db.query(models.User).order_by(models.User.username).all()
        out = []
        for u in rows:
            # ⚠️ **`password_changed_at` 有值就直接說「不是預設」,不要去比對雜湊。**
            #
            # 一次 PBKDF2 比對要 ~270ms(刻意的,見 _PBKDF2_ITERATIONS),這一頁若把
            # **每個帳號**都比一次,20 個帳號就要 5 秒才開得出來。
            # `set_password()` 是唯一會寫這個欄位的地方,所以有值 = 他自己改過密碼 =
            # 一定不是預設值,不必算。真的需要比對的只有「從沒改過」那些列。
            # 跟 is_default_password 同一份判斷(含快取):欄位空著、密碼卻早就改過的帳號,不必每次開這頁都重算。
            is_default = _row_uses_default_password_cached(
                u.username, str(u.password), u.password_changed_at
            )
            out.append(
                {
                    "username": u.username,
                    "mfa_enabled": u.username in bound,
                    "display_name": u.display_name or u.username,
                    "tools": u.tools,
                    "disabled": u.disabled,
                    "role": u.role,
                    "created_at": u.created_at,
                    "password_changed_at": u.password_changed_at,
                    "is_default_password": is_default,
                }
            )
        return out
    finally:
        db.close()


def exists(username: str) -> bool:
    """這個帳號在不在。**跟 get() 一樣不分大小寫** ——

    分開判斷的話會出現這種對不上:管理員要建 `Ming`,這裡精確比對說「不存在」,
    路由放行,然後 create_user 的第二道(不分大小寫)才擋下來 —— 使用者看到的是
    「建立失敗」而不是「這個帳號已經有了」,而後者才是他需要知道的事。
    """
    return get(username) is not None


#: 職稱的兩個合法值,**順序就是下拉選單的順序**。
#:
#: ⚠️ 大小寫照資料庫既有的值(`Software engineer`,小寫 e)。改大小寫等於
#: 讓既有資料全部對不上 `role_grants_full()`,那些人的權限會在下一次
#: 存檔時被降級,而畫面上看不出來。
#:
#: **`ROLES` 是這兩個字串的正本。** 另外還有兩份不得不存在的副本 ——
#: `schemas.RoleName`(Pydantic 的 `Literal` 只吃字面值,餵不進常數)與前端
#: `adminApi.ts` 的 `USER_ROLES`(跨語言)。要改職稱**先改這裡**,另外兩份抄過去;
#: 漂掉會被 `tests/test_users_role.py` 的兩條釘樁測試擋下來。
ROLE_CONSULTANT = "Consultant"
ROLE_ENGINEER = "Software engineer"
ROLES = [ROLE_CONSULTANT, ROLE_ENGINEER]

#: 哪些職稱帶完整權限(可以在主機上跑 Bash)。
#:
#: ⚠️ **職稱就是權限**。
#: `role` 是唯一來源,`tools` 由它推導出來、只是給 agent.py 讀的快取欄位。
#: **不要從別的地方寫 `tools`** —— 兩個地方都能寫就一定會不一致,而不一致的
#: 那一面是「畫面顯示 Consultant、實際上有 Bash」。
_FULL_ROLES = {ROLE_ENGINEER}


def role_grants_full(role: Optional[str]) -> bool:
    """這個職稱帶不帶完整權限。認不得的職稱一律當唯讀(往安全的那邊倒)。"""
    return normalize_role(role) in _FULL_ROLES


def normalize_role(raw: Optional[str]) -> str:
    """把使用者輸入的職稱收成乾淨的字串。前後空白去掉,`None` 當空字串。

    **回傳空字串時代表什麼,由呼叫端決定** —— 這是這條路上唯一需要動腦的地方:

    - `create_user`:沒填 → 存 `DEFAULT_ROLE`(明確給了預設職稱,不是「從沒設過」)
    - `set_role`:清空 → 存 NULL(清掉;讀的那側退回 `DEFAULT_ROLE`)

    所以這裡只做「收乾淨」,不做「空的要存成什麼」。
    """
    return (raw or "").strip()


def create_user(
    username: str,
    display_name: Optional[str] = None,
    created_by: Optional[str] = None,
    role: Optional[str] = None,
) -> bool:
    """新增帳號,密碼設成預設值(首次登入會被強制改)。已存在或是保留名(is_reserved_name)回 False。

    ⚠️ **刻意沒有 `full` 參數**(職稱就是權限)。權限一律由 `role`
    推導;不給 role 就是 `DEFAULT_ROLE`(Consultant)= 唯讀。
    新帳號預設唯讀是刻意的:要給完整權限就建完之後改職稱,那一步會寫稽核。

    **帳號一律存小寫。** 登入不分大小寫(見 get / resolve),所以 `Ming` 跟 `ming`
    是同一個人 —— 真的建出兩列的話,resolve 只會挑到其中一個,另一個的對話
    從此沒有人看得到。存小寫 + 用 get() 檢查是否已存在(它也不分大小寫),
    兩道一起把這種列擋在門外。顯示名稱不動,那本來就是給人看的。
    """
    username = username.strip().lower()
    if not username or is_reserved_name(username):
        return False
    if not config.default_user_password_is_usable():
        # 沒有初始密碼可以發就不建。**不能退回任何寫在程式裡的字串** —— 那等於
        # 另一組寫在版控、所有人共用的密碼,而且「還在用預設密碼」的強制改密碼閘門
        # 對它是關的(is_default_password 只比對 config 那個值)。
        logger.error("DEFAULT_USER_PASSWORD 沒設,拒絕建立帳號 user=%s", username)
        return False
    db = SessionLocal()
    try:
        # 不分大小寫地檢查 —— db.get 是精準比對,擋不掉只有大小寫不同的那種
        if get(username) is not None:
            return False
        db.add(
            models.User(
                username=username,
                password=hash_password(config.DEFAULT_USER_PASSWORD),
                display_name=(display_name or username).strip() or username,
                # 沒填 → 預設職稱(Consultant),權限跟著它推導 = 唯讀。
                # 存實際的職稱字串而不是 None:新帳號不是「從沒設過」,是「明確給了預設職稱」。
                role=normalize_role(role) or DEFAULT_ROLE,
                tools="full" if role_grants_full(role or DEFAULT_ROLE) else None,
                disabled=False,
                created_by=created_by,
                password_changed_at=None,  # 從沒改過 → is_default_password 會是 True → 強制改
            )
        )
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("建立帳號寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


def set_role(username: str, role: Optional[str]) -> bool:
    """設定畫面上的職稱。空字串/空白 = **清掉**,存 NULL(讀的那側退回 `DEFAULT_ROLE`)。"""
    db = SessionLocal()
    try:
        u = db.get(models.User, username.strip())
        if u is None:
            return False
        u.role = normalize_role(role) or None
        # ⚠️ **權限跟著職稱一起寫**。分兩次寫、或讓呼叫端自己記得也要改 tools,
        # 遲早會出現「職稱是 Consultant 但還有 Bash」。
        # 清掉職稱 → 認不得 → 退回唯讀,這是往安全的那邊倒。
        u.tools = "full" if role_grants_full(u.role) else None
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("改職稱寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


def set_disabled(username: str, disabled: bool) -> bool:
    db = SessionLocal()
    try:
        u = db.get(models.User, username.strip())
        if u is None:
            return False
        u.disabled = disabled
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("停用/啟用帳號寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


def reset_password(username: str) -> bool:
    """重設成預設密碼,並清掉「上次變更時間」—— 這樣對方下次登入會被強制改。"""
    if not config.default_user_password_is_usable():
        logger.error("DEFAULT_USER_PASSWORD 沒設,拒絕重設密碼 user=%s", username)
        return False
    db = SessionLocal()
    try:
        u = db.get(models.User, username.strip())
        if u is None:
            return False
        u.password = hash_password(config.DEFAULT_USER_PASSWORD)
        u.password_changed_at = None
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("重設密碼寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


#: 刪帳號時,每一個存帳號名的欄位怎麼處理。**新增存帳號名的欄位一定要加進來** ——
#: tests/test_delete_account.py 會掃所有表,看起來像帳號名的欄位(username / owner / author / actor / mentioned / *_by)
#: 沒列在這三份裡就失敗。
#:
#: 為什麼要處理:這些表都沒有外鍵、只認名字。只刪 User 的話,之後新的人用同一個名字建帳號,
#: 登入就看到前任的對話、筆記、截圖,收到前任的分享與 @。帳號名可以重用,前任的紀錄改成封存名。
#:
#: 刪掉 —— 他個人的東西、別人給他的權限(分享給他、@ 他、資料夾、MFA、偏好)
DELETED_USER_COLUMNS = (
    ("users", "username"),
    ("user_prefs", "username"),
    ("user_mfa", "username"),
    ("conversation_shares", "username"),
    ("conversation_folders", "username"),
    ("conversation_folder_items", "username"),
    ("conversation_mentions", "username"),
    ("user_notes", "username"),
    ("user_note_images", "username"),
)
#: 改成封存名 —— 他做過的事(問過的題、寫的便條、分享出去的、建的帳號與流程)。
#: 歷史留著(統計、同事收到的分享照常),但新的同名帳號接不到:封存名有 `#`,建不出來也登入不了
RENAMED_USER_COLUMNS = (
    ("qa_records", "owner"),
    ("qa_records", "asked_by"),
    ("conversation_notes", "author"),
    ("conversation_notes", "mentioned"),  # 逗號分隔的名單,逐個換
    ("conversation_shares", "shared_by"),
    ("users", "created_by"),
    ("workflows", "created_by"),
    ("workflows", "updated_by"),
    ("workflows", "schedule"),  # json 裡的 "by"(排程記在誰名下)
    ("workflows", "graph"),  # json:「通知人員」的名單(workflows.rename_person)—— 不換的話同名新帳號收到前任設定的通知
    ("workflow_runs", "triggered_by"),
    ("workflow_runs", "graph"),  # 執行當下那張圖的快照,同上
)
#: 不動 —— 稽核紀錄不刪不改(models.AuditLog),改了就失去意義
KEPT_USER_COLUMNS = (("audit_log", "actor"),)


def archived_name(username: str, now: Optional[datetime] = None) -> str:
    """刪掉的帳號在歷史紀錄裡的名字。`#` 不在帳號名允許的字元裡(ids.NAME),所以沒有人建得出、登入得了這個名字。"""
    return f"{username}#deleted-{(now or datetime.utcnow()):%Y%m%d%H%M%S}"


def delete_user(username: str) -> Optional[str]:
    """刪除帳號。他個人的東西一起刪,他做過的事改成封存名(見 DELETED_USER_COLUMNS / RENAMED_USER_COLUMNS)。

    回傳封存名(失敗或沒有這個人回 None)—— 呼叫端還要拿它處理記憶體裡的東西(routers/admin_users.delete_user)。
    """
    db = SessionLocal()
    try:
        u = db.get(models.User, username.strip())
        if u is None:
            return None
        name = u.username
        archived = archived_name(name)
        image_paths = [
            config.NOTEBOOK_DIR / f"{i.id}.{i.ext}"
            for i in db.query(models.UserNoteImage).filter(models.UserNoteImage.username == name)
        ]
        _delete_user_rows(db, name)
        _archive_user_refs(db, name, archived)
        db.commit()
        # 資料庫先刪成功才刪檔(理由同 routers/notebook._unlink)
        for path in image_paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("刪帳號時筆記圖片檔刪不掉 user=%s file=%s", name, path.name)
        return archived
    except Exception:  # noqa: BLE001
        logger.exception("刪除帳號寫入失敗 user=%s", username)
        db.rollback()
        return None
    finally:
        db.close()


def _table(name: str):
    return models.Base.metadata.tables[name]


def _delete_user_rows(db, name: str) -> None:
    for table, column in DELETED_USER_COLUMNS:
        t = _table(table)
        db.execute(t.delete().where(t.c[column] == name))


def _rename_in_list(raw: str, name: str, archived: str) -> Optional[str]:
    """逗號分隔的名單。回傳換好的字串;沒有要換的回 None。"""
    names = (raw or "").split(",")
    return ",".join(archived if n == name else n for n in names) if name in names else None


def _rename_schedule_by(sched, name: str, archived: str) -> bool:
    if isinstance(sched, dict) and sched.get("by") == name:
        sched["by"] = archived
        return True
    return False


def _json_renamers() -> dict:
    """存成 json 的欄位:各自怎麼在裡面找帳號名。函式收解開的物件、就地改、回傳有沒有改。"""
    from . import workflows  # 延後:workflows 平常不碰資料庫,也不該在 import users 時被拖進來

    return {
        ("workflows", "schedule"): _rename_schedule_by,
        ("workflows", "graph"): workflows.rename_person,
        ("workflow_runs", "graph"): workflows.rename_person,
    }


def _archive_user_refs(db, name: str, archived: str) -> None:
    json_renamers = _json_renamers()
    for table, column in RENAMED_USER_COLUMNS:
        t = _table(table)
        col = t.c[column]
        renamer = json_renamers.get((table, column))
        if renamer is None and (table, column) != ("conversation_notes", "mentioned"):
            db.execute(t.update().where(col == name).values({column: archived}))
            continue
        # 名字藏在字串裡:先用 contains 粗篩,再逐列解開比對整個名字(不會把 bob 換進 bobby)
        for row_id, raw in db.execute(select(t.c.id, col).where(col.contains(name))).all():
            if renamer is None:
                new = _rename_in_list(raw, name, archived)
            else:
                try:
                    obj = json.loads(raw or "{}")
                except ValueError:
                    continue
                new = json.dumps(obj, ensure_ascii=False) if renamer(obj, name, archived) else None
            if new is not None:
                db.execute(t.update().where(t.c.id == row_id).values({column: new}))


# ---------------------------------------------------------------- 個人偏好

#: 頭像 data URI 的長度上限。
#:
#: 前端上傳前已經縮到 256px 並壓成 JPEG(約 20~40KB),這裡是**第二道** ——
#: 前端那道任何人都繞得過(直接打 API 就好),而這一欄會被每一次
#: `/api/shareable-users` 帶出去給所有登入者,一份肥的頭像會拖慢每個人的 @ 選單。
#: 300_000 字元 ≈ 220KB 的二進位,對 256px 的 JPEG 來說綽綽有餘。
MAX_AVATAR_CHARS = 300_000

#: 字級與對比的合法範圍(百分比)。
#:
#: ⚠️ **字級的下限是 50 不是 0**:字級 0 的畫面上什麼都看不到,包含那條把它
#: 調回來的拉桿本身 —— 設下去就再也救不回來(除非清 localStorage 或改資料庫)。
#: 50% 已經很小了,而且還讀得到。
#:
#: ⚠️ **兩者範圍要一樣(50~200)**:兩條拉桿上的 100% 要落在同一個位置,
#: 而位置是由範圍決定的。對比若給到 0,它的 100 會跑到正中間、
#: 跟字級的 100 對不齊。
MIN_FONT_SCALE = 50
MAX_FONT_SCALE = 200
MIN_CONTRAST = 50
MAX_CONTRAST = 200

#: 右下角的吉祥物。"classic" = GIF 小夥伴,"blob" = bloub。
#: NULL = 沒設過 = classic。
#: 跟常用模型不同,合法值是固定的 —— 前端只畫得出這兩隻。
COMPANIONS = frozenset({"classic", "blob"})

# Bloub 的型態與顏色。跟前端 `lib/companionPref.ts` 的
# `BLOB_SHAPES` / `BLOB_COLORS` 是同一份清單,值是上游引擎的 id(法文,見 `src/pet/bloub/skins.ts`)。
# 顏色的 `auto` = 跟著佈景(淺色近黑、深色近白),也是沒設過時的樣子;
# 上游的 `encre`(近黑)與 `creme`(近白)刻意不收 —— 那就是 auto 在兩種佈景下的樣子。
COMPANION_SHAPES = frozenset(
    {"cercle", "galet", "squircle", "capsule", "triangle", "hexagone", "nuage", "goutte"}
)
COMPANION_COLORS = frozenset(
    {"auto", "gris", "brun", "rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose"}
)


def _pick(value: str, allowed: frozenset) -> Optional[str]:
    """偏好的單選值:去空白、轉小寫、在白名單裡才算 —— 不認得的回 None(呼叫端當成沒帶)。"""
    value = value.strip().lower()
    return value if value in allowed else None


# 調色盤自己挑的顏色:色票之外也收 `#rrggbb`(一律存小寫)。
# 只收這一種寫法 —— 前端拿它直接當 SVG 的 fill,寫什麼進去就畫什麼。
_HEX_COLOR = re.compile(r"#[0-9a-f]{6}")


def _pick_color(value: str) -> Optional[str]:
    """Bloub 的顏色:色票裡的名字,或 `#rrggbb`。不認得的回 None。"""
    picked = _pick(value, COMPANION_COLORS)
    if picked is not None:
        return picked
    value = value.strip().lower()
    return value if _HEX_COLOR.fullmatch(value) else None


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


def get_prefs(username: Optional[str]) -> dict:
    """個人顯示設定。沒設過的欄位回 None —— 前端據此用預設值。"""
    empty = {
        "theme": None,
        "avatar": None,
        "font_scale": None,
        "contrast": None,
        "preferred_model": None,
        "companion": None,
        "companion_shape": None,
        "companion_color": None,
    }
    if not username:
        return empty
    db = SessionLocal()
    try:
        pref = db.get(models.UserPref, username)
        if pref is None:
            return empty
        return {
            "theme": pref.theme,
            "avatar": pref.avatar,
            "font_scale": pref.font_scale,
            "contrast": pref.contrast,
            "preferred_model": pref.preferred_model,
            "companion": pref.companion,
            "companion_shape": pref.companion_shape,
            "companion_color": pref.companion_color,
        }
    finally:
        db.close()


def set_display_prefs(
    username: Optional[str],
    font_scale: Optional[int],
    contrast: Optional[int],
    preferred_model: Optional[str] = None,
    companion: Optional[str] = None,
    companion_shape: Optional[str] = None,
    companion_color: Optional[str] = None,
) -> bool:
    """記下字級、對比、常用模型與吉祥物(含 Bloub 的型態與顏色)。

    **值一律夾在合法範圍內**,不夾的話 API 收得到 0 或 9999。
    常用模型則是**白名單比對**:不在 `config.ALLOWED_MODELS` 裡的一律當成沒帶,
    不要寫進資料庫 —— 這個值之後會被當成模型名字送去跑,寫什麼進去就送什麼。
    吉祥物、型態、顏色同樣比對各自的白名單,不認得的當成沒帶。
    """
    if not username:
        return False
    db = SessionLocal()
    try:
        pref = db.get(models.UserPref, username)
        if pref is None:
            pref = models.UserPref(username=username)
            db.add(pref)
        if font_scale is not None:
            pref.font_scale = _clamp(font_scale, MIN_FONT_SCALE, MAX_FONT_SCALE)
        if contrast is not None:
            pref.contrast = _clamp(contrast, MIN_CONTRAST, MAX_CONTRAST)
        if preferred_model is not None:
            model = preferred_model.strip().lower()
            # 空字串 = 清掉(回到伺服器的預設模型);其餘只收白名單裡的
            if model == "":
                pref.preferred_model = None
            elif model in config.ALLOWED_MODELS:
                pref.preferred_model = model
        # 吉祥物三項:不認得的當成沒帶(回 None 就不寫)。顏色多收 #rrggbb
        for column, raw, pick in (
            ("companion", companion, lambda v: _pick(v, COMPANIONS)),
            ("companion_shape", companion_shape, lambda v: _pick(v, COMPANION_SHAPES)),
            ("companion_color", companion_color, _pick_color),
        ):
            picked = pick(raw) if raw is not None else None
            if picked is not None:
                setattr(pref, column, picked)
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("字級/對比/常用模型/吉祥物寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


def set_avatar(username: Optional[str], data_uri: Optional[str]) -> bool:
    """換頭像。`None` 或空字串 = 拿掉頭像(回到名字縮寫)。

    只收 `data:image/...;base64,` 開頭的字串,而且擋長度 —— 這一欄會被
    `/api/shareable-users` 帶給所有登入者,不能讓任何人往裡面塞任意大的東西。
    """
    if not username:
        return False
    value = (data_uri or "").strip() or None
    if value is not None:
        # 只收點陣圖。`image/svg+xml` 也是 data:image/,但 SVG 能帶 script ——
        # 今天 <img> 不會執行它,哪天有人把頭像改成 <object> 或 inline 就是 stored XSS。
        if not value.startswith(("data:image/png;", "data:image/jpeg;", "data:image/webp;", "data:image/gif;")):
            return False
        if len(value) > MAX_AVATAR_CHARS:
            return False
    db = SessionLocal()
    try:
        pref = db.get(models.UserPref, username)
        if pref is None:
            pref = models.UserPref(username=username)
            db.add(pref)
        pref.avatar = value
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("頭像寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


def get_theme(username: Optional[str]) -> Optional[str]:
    """這個人上次選的主題。沒設過回 None —— 前端據此沿用本機的設定。"""
    if not username:
        return None
    db = SessionLocal()
    try:
        pref = db.get(models.UserPref, username)
        return pref.theme if pref else None
    finally:
        db.close()


def set_theme(username: Optional[str], theme: str) -> bool:
    """記下主題偏好。管理員也適用 —— UserPref 不依賴 users 表(見 models.UserPref)。

    寫失敗只回 False 不往上丟:主題是裝飾,不值得讓使用者看到一個紅色錯誤,
    而且他當下那一頁已經是對的了(前端先套本機再送這裡)。
    """
    if not username or theme not in ("light", "dark"):
        return False
    db = SessionLocal()
    try:
        pref = db.get(models.UserPref, username)
        if pref is None:
            db.add(models.UserPref(username=username, theme=theme))
        else:
            pref.theme = theme
        db.commit()
        return True
    except Exception:  # noqa: BLE001 —— 跟這個檔案其他寫入函式一致
        logger.exception("主題寫入失敗 user=%s", username)
        db.rollback()
        return False
    finally:
        db.close()


#: `users.role` 是空的時候算哪一種。
#: ⚠️ 這裡的預設值是 `Consultant` = **唯讀**,而職稱就是權限:
#: 空職稱一律往安全的那邊倒,不會有人因為沒設職稱而拿到 Bash。
#:
#: 什麼時候會用到這個預設值:
#: 帳號的 role 是空的(NULL 或空字串)—— 從沒設過,或管理員在網頁上清掉了。
#: 兩種都會在 `list_active()` 退回這裡(`u.get("role") or DEFAULT_ROLE`)。
#: 職稱進資料庫的路:建帳號時選的職稱,與帳號管理頁的「修改職稱」。
#: ⚠️ **不要再寫一次字面值**:`"Consultant"`
#: 這個字串在整個後端只該出現在 `ROLE_CONSULTANT` 那一行。兩個常數是兩件事
#: ——「Consultant 這個職稱」與「沒設過的人算什麼」—— 但值必須是同一個,而寫兩次
#: 的話哪天改了一邊,`role_grants_full()` 就會對不上。
DEFAULT_ROLE = ROLE_CONSULTANT

#: 管理員(.env 的 ADMIN_USERNAME)的職稱。他不在 users 表裡,所以標不到 role 欄位。
#: 寫全 "Admin",不要縮寫(一個字母看不出是什麼)。
ADMIN_ROLE = "Admin"


def list_active() -> list[dict]:
    """可以被分享的對象:啟用中的帳號 + 管理員。

    只回 username / display_name / role —— 這是**一般帳號**也打得到的清單
    (不然沒有人能分享),不該順便把權限、密碼狀態那些帶出去。
    `role` 是資料庫的 `users.role`。⚠️ **它就是權限**(見 `_FULL_ROLES`)——
    但這條 API 只回職稱字串,不回 `tools`:一般帳號打得到它,不該從這裡讀出
    「誰能跑 Bash」。
    沒設過與被清掉(都是 NULL)都退回 `DEFAULT_ROLE` —— 這裡用
    `or` 一次收掉兩種,呼叫端永遠拿得到一個非空字串,不必自己判空。

    管理員要手動補上:他不在 users 表裡(密碼在 .env),但他確實是個能登入、
    能收到共用對話的人。漏掉的話就無法分享給管理員。
    """
    # 頭像一次撈完再對回去 —— 一人一次 get_prefs 的話 N 個人就是 N 次查詢,
    # 而這條 API 每次開對話都會被打。
    avatars = _avatars_by_username()
    return [{**u, "avatar": avatars.get(u["username"])} for u in _active_accounts()]


def _active_accounts() -> list[dict]:
    """`list_active` 去掉頭像的那一份:username / display_name / role,依 username 排序。

    ⚠️ **不要從 `list_users()` 濾出來。** 那支是給管理頁的:每個「從沒改過密碼」
    的帳號都要跑一次 PBKDF2(~270ms)比對預設密碼,還順帶查 MFA。而這裡會被
    `display_names()` 呼叫 —— 側欄每 8 秒一次的 `GET /api/conversations`、
    發便利貼(async 路徑,卡住的是整個事件迴圈)都走這條。這裡只要三個欄位,
    一次查詢就夠了。
    """
    db = SessionLocal()
    try:
        rows = (
            db.query(models.User.username, models.User.display_name, models.User.role)
            .filter(models.User.disabled.isnot(True))
            .all()
        )
    finally:
        db.close()
    out = [
        {
            "username": username,
            "display_name": display_name or username,
            "role": role or DEFAULT_ROLE,
        }
        for username, display_name, role in rows
    ]
    if config.ADMIN_USERNAME and not any(u["username"] == config.ADMIN_USERNAME for u in out):
        out.append(
            {
                "username": config.ADMIN_USERNAME,
                "display_name": config.ADMIN_USERNAME,
                "role": ADMIN_ROLE,
            }
        )
    return sorted(out, key=lambda u: u["username"])


def _avatars_by_username() -> dict:
    """有設頭像的人 → 他的 data URI。沒設過的不會出現在這份表裡。"""
    db = SessionLocal()
    try:
        rows = (
            db.query(models.UserPref.username, models.UserPref.avatar)
            .filter(models.UserPref.avatar.isnot(None))
            .all()
        )
        return {username: avatar for username, avatar in rows}
    finally:
        db.close()


def display_names() -> dict:
    """username -> 顯示名稱。一次撈完,避免在迴圈裡逐筆查。

    走 `_active_accounts` 不走 `list_active`:這裡用不到頭像,而頭像一張最多
    30 萬字元(MAX_AVATAR_CHARS),側欄每 8 秒輪詢一次,全部讀出來再丟掉。
    """
    return {u["username"]: u["display_name"] for u in _active_accounts()}
