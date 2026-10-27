# -*- coding: utf-8 -*-
"""密碼的存法:PBKDF2-HMAC-SHA256(有鹽),迭代數存在字串裡。

不用單輪 SHA-256 的理由:它是為了**算得快**設計的,而密碼雜湊要的正好相反。
`app.db` 任何能 SSH 進伺服器的人都讀得到 —— 外流的話,一張現成的彩虹表就能把
所有人的密碼還原。而且沒有鹽,兩個人用同一組密碼會產生一模一樣的雜湊,
光看資料庫就知道誰跟誰的密碼一樣。

這一份守四件事:
  1. 新存進去的一定是 PBKDF2,而且**同一組密碼每次的雜湊都不一樣**(有鹽);
  2. 迭代數比現行低的雜湊仍然驗得過 —— 不然調高迭代數之後所有人都登不進去;
  3. 那種雜湊在**登入成功時**就地重算,而且不動 `password_changed_at`;
  4. 明文儲存**不被接受**(「不像雜湊就當明文比」是一條繞過雜湊的後門)。
"""
import hashlib
from datetime import datetime

from app import config, models, users
from app.database import Base, SessionLocal, engine


def _fresh_user(username: str, stored_password: str, changed_at=None) -> None:
    """直接把一列塞進資料庫,`password` 欄位原樣寫入(繞過 hash_password)。

    ⚠️ 這正是測試需要的:要驗「低迭代數的雜湊讀不讀得懂」就得**寫得出它**,
    而正常的寫入路徑一律用現行的迭代數。
    """
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == username).delete()
        db.add(
            models.User(
                username=username,
                password=stored_password,
                display_name=username,
                password_changed_at=changed_at,
            )
        )
        db.commit()
    finally:
        db.close()


def _stored_password(username: str) -> str:
    db = SessionLocal()
    try:
        return str(db.get(models.User, username).password)
    finally:
        db.close()


# ---------------------------------------------------------------- 1. 新格式

def test_hash_password_produces_salted_pbkdf2():
    hashed = users.hash_password("hunter2")

    assert hashed.startswith("pbkdf2_sha256$")
    # 迭代數要存在字串裡 —— 之後調高才不會讓既有密碼失效
    assert hashed.split("$")[1] == str(users._PBKDF2_ITERATIONS)
    assert users._matches("hunter2", hashed)
    assert not users._matches("hunter3", hashed)


def test_same_password_hashes_differently_every_time():
    """**有鹽**。少了這條,資料庫看得出「這兩個人的密碼一樣」。"""
    a = users.hash_password("same-password")
    b = users.hash_password("same-password")

    assert a != b
    # 但兩個都驗得過
    assert users._matches("same-password", a)
    assert users._matches("same-password", b)


# ---------------------------------------------------------------- 2 & 3. 低迭代數

_LOW_ITERATIONS = 1000


def _weak(plain: str) -> str:
    """迭代數比現行低的 PBKDF2(調高 `_PBKDF2_ITERATIONS` 之前存的就是這個樣子)。"""
    salt = b"0123456789abcdef"
    digest = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"), salt, _LOW_ITERATIONS)
    return f"pbkdf2_sha256${_LOW_ITERATIONS}${salt.hex()}${digest.hex()}"


def _iterations(stored: str) -> int:
    return int(stored.split("$")[1])


def test_low_iteration_hash_still_verifies():
    """迭代數照字串裡寫的算 —— 不然調高迭代數之後所有人當場登不進去。"""
    assert users._matches("hunter2", _weak("hunter2"))
    assert not users._matches("wrong", _weak("hunter2"))


def test_login_rehashes_a_low_iteration_hash_in_place():
    """登入成功 = 系統唯一拿得到明文的時刻,也是唯一能改寫雜湊的時刻。"""
    _fresh_user("olduser", _weak("hunter2"))

    assert users.verify("olduser", "hunter2") is True

    upgraded = _stored_password("olduser")
    assert _iterations(upgraded) == users._PBKDF2_ITERATIONS, "登入成功卻沒有重算"
    assert users._matches("hunter2", upgraded)
    # 重算之後當然還要能再登入一次
    assert users.verify("olduser", "hunter2") is True


def test_failed_login_does_not_upgrade():
    """密碼錯的時候不准動那一列 —— 那是攻擊者也能觸發的路徑。"""
    _fresh_user("olduser2", _weak("hunter2"))

    assert users.verify("olduser2", "wrong-password") is False

    assert _iterations(_stored_password("olduser2")) == _LOW_ITERATIONS


def test_rehash_does_not_touch_password_changed_at():
    """⚠️ 這一條是重點,而且很容易寫錯。

    `password_changed_at` 的意思是「**他自己**改過密碼」,而重算改的是儲存方式、
    不是密碼。寫下去的話,還在用預設密碼的人會被當成「已經改過了」——
    強制改密碼那道門就對他失效了,而畫面上完全看不出來。

    `is_default_password()` 也拿這個欄位當快速路徑,所以寫錯的話
    連「誰還在用預設密碼」那一欄都會跟著說謊。
    """
    default = config.DEFAULT_USER_PASSWORD
    _fresh_user("neverchanged", _weak(default), changed_at=None)

    assert users.verify("neverchanged", default) is True

    db = SessionLocal()
    try:
        row = db.get(models.User, "neverchanged")
        assert _iterations(row.password) == users._PBKDF2_ITERATIONS, "應該要重算"
        assert row.password_changed_at is None, "重算不該假裝他改過密碼"
    finally:
        db.close()

    # 而且他仍然要被標成「還在用預設密碼」
    assert users.is_default_password("neverchanged") is True


# ---------------------------------------------------------------- 4. 明文後門

def test_plaintext_storage_is_rejected():
    """「存的東西不像雜湊就當明文比」(`compare_digest(supplied, stored)`)是一條
    「手動塞一列就完全繞過雜湊」的後門。寫入端一律走 hash_password,所以不像雜湊的值一律回 False。"""
    assert users._matches("hunter2", "hunter2") is False
    assert users._matches("hunter2", "") is False
    assert users._matches("hunter2", "not-a-hash-at-all") is False


def test_malformed_pbkdf2_does_not_raise():
    """格式壞掉的列要當「對不上」,不能變成例外把登入整條打掛。"""
    for broken in (
        "pbkdf2_sha256$",
        "pbkdf2_sha256$notanumber$aa$bb",
        "pbkdf2_sha256$600000$zzzz$bb",   # 不是合法的 hex
        "pbkdf2_sha256$600000$aabb",      # 少一段
    ):
        assert users._matches("hunter2", broken) is False, broken


# ---------------------------------------------------------------- needs_rehash

def test_needs_rehash():
    assert users.needs_rehash(_weak("x")) is True
    assert users.needs_rehash("sha256:abcd") is True
    assert users.needs_rehash("") is True
    assert users.needs_rehash(users.hash_password("x")) is False
    # 迭代數比現行低的也要換(之後調高時,舊列會被逐一帶上來)
    assert users.needs_rehash("pbkdf2_sha256$1000$aabb$ccdd") is True


# ------------------------------------------- is_default_password 的快速路徑

def test_is_default_password_short_circuits_on_password_changed_at():
    """改過密碼的人**不必**跑一次 ~270ms 的 PBKDF2 比對就該回 False。

    這條捷徑成立的前提是「只有 set_password() 會寫那個欄位,而它擋掉了
    改成預設密碼」—— 見 users.is_default_password 的說明。
    """
    default = config.DEFAULT_USER_PASSWORD
    # 密碼**就是**預設值,但欄位標成「改過了」
    _fresh_user("weird", users.hash_password(default), changed_at=datetime(2026, 8, 1))

    assert users.is_default_password("weird") is False

    # 對照組:同樣的密碼,沒有標記 → 要抓出來
    _fresh_user("plain", users.hash_password(default), changed_at=None)
    assert users.is_default_password("plain") is True


def _record_hash_checks(monkeypatch) -> list:
    """清掉預設密碼的快取,之後每一次真的去比對雜湊(`users._matches`)都記下那份雜湊字串。"""
    users._default_check_cache.clear()
    calls = []
    real = users._matches

    def counting(supplied: str, stored: str) -> bool:
        calls.append(stored)
        return real(supplied, stored)

    monkeypatch.setattr(users, "_matches", counting)
    return calls


def test_is_default_password_computes_each_hash_only_once(monkeypatch):
    """欄位空著、密碼卻不是預設值的人(預設密碼換過之後,用前一組建、還沒改過的帳號),
    捷徑幫不上忙。**每一支 API** 都會問這一題,所以同一份雜湊只准真的算一次
    (一次 PBKDF2 約幾百毫秒,帳號一多每支 API 都會明顯變慢)。"""
    _fresh_user("upgraded", users.hash_password("my-own-password"), changed_at=None)
    calls = _record_hash_checks(monkeypatch)

    for _ in range(5):
        assert users.is_default_password("upgraded") is False
    assert len(calls) == 1


def test_list_users_default_column_uses_the_same_check(monkeypatch):
    """帳號管理頁的「預設密碼」欄跟 is_default_password 同一份判斷:答案一致,而且開幾次頁面都只算一次。"""
    default = config.DEFAULT_USER_PASSWORD
    _fresh_user("admin_page_default", users.hash_password(default), changed_at=None)
    _fresh_user("admin_page_migrated", users.hash_password("my-own-password"), changed_at=None)
    _fresh_user("admin_page_changed", users.hash_password("whatever"), changed_at=datetime(2026, 8, 1))
    calls = _record_hash_checks(monkeypatch)

    for _ in range(3):
        column = {u["username"]: u["is_default_password"] for u in users.list_users()}
        assert column["admin_page_default"] is True
        assert column["admin_page_migrated"] is False
        assert column["admin_page_changed"] is False
    for name in ("admin_page_default", "admin_page_migrated", "admin_page_changed"):
        assert users.is_default_password(name) is column[name]
    # 欄位空著的兩個人各算一次;改過密碼的那個走捷徑,一次都不算
    # (只數這三個人的:測試資料庫裡可能還有別的測試留下的帳號)
    mine = {_stored_password(n): n for n in ("admin_page_default", "admin_page_migrated", "admin_page_changed")}
    counted = [mine[h] for h in calls if h in mine]
    assert sorted(counted) == ["admin_page_default", "admin_page_migrated"]


def test_is_default_password_cache_follows_the_stored_hash():
    """快取用雜湊字串當版本:重設成預設密碼、再自己改掉,答案都要當場跟著變,不用誰去清快取。"""
    _fresh_user("flip", users.hash_password("my-own-password"), changed_at=None)
    users._default_check_cache.clear()
    assert users.is_default_password("flip") is False

    assert users.reset_password("flip") is True
    assert users.is_default_password("flip") is True

    # 管理員重設之後,同樣是預設密碼但換了鹽(雜湊不同)也照樣認得
    _fresh_user("flip", users.hash_password(config.DEFAULT_USER_PASSWORD), changed_at=None)
    assert users.is_default_password("flip") is True

    # 自己改成別的密碼,但欄位空著:要回 False,不能沿用上一次的 True
    _fresh_user("flip", users.hash_password("another-one"), changed_at=None)
    assert users.is_default_password("flip") is False


def test_is_default_password_cache_follows_the_default_password(monkeypatch):
    """預設密碼本身換了,同一份雜湊的答案也要跟著換 —— 快取不能沿用舊預設密碼算出來的結果。"""
    _fresh_user("swap", users.hash_password("新的初始密碼"), changed_at=None)
    users._default_check_cache.clear()
    assert users.is_default_password("swap") is False

    monkeypatch.setattr(config, "DEFAULT_USER_PASSWORD", "新的初始密碼")
    assert users.is_default_password("swap") is True
