# -*- coding: utf-8 -*-
"""IP 封鎖的落地與公司 IP 白名單。

IP 層的封鎖鎖上就寫資料庫、開機載回來,所以重啟不會把它解開。唯一的例外:
公司的對外 IP(`LOGIN_IP_ALLOWLIST`)永遠不會被 IP 層鎖住。

這份測試要同時守住**兩個相反方向**,只驗一邊等於沒驗:

  鎖得住 —— 重啟(= 清空記憶體 + `load_persisted_blocks()`)之後還鎖著。
  放得了 —— 白名單裡的來源連計數都不記;管理員解鎖之後,重啟不會把它載回來。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_ratelimit.py
"""
import math

import pytest

from app import models, ratelimit
from app.database import Base, SessionLocal, engine

IP = "198.51.100.7"
OFFICE = "203.0.113.5"
OFFICE_NET = "203.0.113.0/24"


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_soft_delete.py:建表在 lifespan 裡,而 fixture 比它早。"""
    Base.metadata.create_all(engine)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """每一條都從「沒有任何鎖定、沒有白名單」開始。

    記憶體與資料庫**都要清**:這個功能的整個重點就是那兩份會互相影響,
    只清其中一份的話,前一條測試留下的狀態會從另一邊漏進來。
    """
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_MAX_ATTEMPTS", 3)
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_LOCKOUT_SEC", 0)  # 0 = 永久,也是預設值
    monkeypatch.setattr(ratelimit.config, "LOGIN_MAX_ATTEMPTS", 5)
    monkeypatch.setattr(ratelimit.config, "LOGIN_LOCKOUT_SEC", 900)
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", "")

    ratelimit._accounts.clear()
    ratelimit._ips.clear()
    _wipe()
    yield
    ratelimit._accounts.clear()
    ratelimit._ips.clear()
    _wipe()


def _boom(*_args, **_kwargs):
    """假的 SessionLocal:一開就炸,模擬資料庫掛掉/被鎖住。"""
    raise RuntimeError("資料庫掛了")


def _wipe():
    db = SessionLocal()
    try:
        db.query(models.LoginIPBlock).delete()
        db.commit()
    finally:
        db.close()


def _rows():
    db = SessionLocal()
    try:
        return db.query(models.LoginIPBlock).all()
    finally:
        db.close()


def _restart():
    """模擬重啟:記憶體沒了,只剩資料庫。回傳載回幾筆。"""
    ratelimit._accounts.clear()
    ratelimit._ips.clear()
    return ratelimit.load_persisted_blocks()


def _fail(ip, times, username="someone"):
    for _ in range(times):
        ratelimit.record_failure(username, ip)


# --------------------------------------------------------------- 鎖得住


def test_block_survives_restart():
    """重啟之後還鎖著。"""
    _fail(IP, 3)
    assert ratelimit.check("someone", IP) == ratelimit.PERMANENT

    assert [r.ip for r in _rows()] == [IP]
    assert _rows()[0].expires_at is None, "永久封鎖要存成 NULL,不是一個很遠的日期"

    assert _restart() == 1
    assert ratelimit.check("someone", IP) == ratelimit.PERMANENT


def test_nothing_written_before_the_lock():
    """**沒鎖上就一列都不寫。** 每次失敗都寫的話,猛撞等於往硬碟塞東西。"""
    _fail(IP, 2)  # 門檻是 3
    assert _rows() == []
    assert _restart() == 0
    assert ratelimit.check("someone", IP) == 0


def test_expiring_lock_stores_a_deadline_and_expires_across_restart(monkeypatch):
    """設成秒數的模式:存的是到期時間,而且過期的不會被載回來。"""
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_LOCKOUT_SEC", 900)
    _fail(IP, 3)

    row = _rows()[0]
    assert row.expires_at is not None
    assert ratelimit.check("someone", IP) > 0

    # 讓它變成已經過期的那一列(直接改資料庫,不用真的等 15 分鐘)
    db = SessionLocal()
    try:
        db.query(models.LoginIPBlock).filter(models.LoginIPBlock.ip == IP).update(
            {"expires_at": row.blocked_at}
        )
        db.commit()
    finally:
        db.close()

    assert _restart() == 0
    assert ratelimit.check("someone", IP) == 0
    assert _rows() == [], "過期的列要順手刪掉,不然這張表會一直長"


def test_blocked_attempts_also_persist():
    """已經被擋下來的嘗試也算 IP 層(見 record_blocked_attempt),鎖上一樣要落地。"""
    for _ in range(3):
        ratelimit.record_blocked_attempt(IP)
    assert ratelimit.check("someone", IP) == ratelimit.PERMANENT
    assert _restart() == 1


# --------------------------------------------------------------- 放得了


def test_unlock_deletes_the_row():
    """管理員解鎖之後,重啟不能把它載回來 —— 不然解鎖只有那一次有效。"""
    _fail(IP, 3)
    assert _rows() != []

    ratelimit.reset(ip=IP)
    assert ratelimit.check("someone", IP) == 0
    assert _rows() == []

    assert _restart() == 0
    assert ratelimit.check("someone", IP) == 0


def test_reset_everything_clears_the_table():
    _fail(IP, 3)
    _fail("198.51.100.8", 3)
    ratelimit.reset()
    assert _rows() == []
    assert _restart() == 0


# --------------------------------------------------------------- 白名單


@pytest.mark.parametrize("allowlist", [OFFICE, OFFICE_NET, f"1.2.3.4,{OFFICE_NET}"])
def test_office_ip_never_gets_locked(monkeypatch, allowlist):
    """單一位址、CIDR、混著寫,三種都要認得。"""
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", allowlist)
    # ⚠️ 每次換一個帳號。同一個帳號打 30 次會鎖在**帳號層**(那一層不看白名單,
    # 這正是設計),用 check() 驗的話會拿到 900 而誤以為 IP 層失效。
    for i in range(30):
        ratelimit.record_failure(f"someone{i}", OFFICE)
    assert ratelimit.check("nobody-tried-this-account", OFFICE) == 0
    assert _rows() == [], "白名單的來源連一列都不該寫進去"
    assert OFFICE not in ratelimit._ips, "連計數都不記 —— 記了的話,拿掉白名單會立刻鎖上"


def test_allowlist_does_not_cover_the_account_layer(monkeypatch):
    """**只免 IP 那一層。** 在公司裡連打錯 5 次,那個帳號還是會被鎖。"""
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", OFFICE_NET)
    _fail(OFFICE, 5, username="alice")
    wait = ratelimit.check("alice", OFFICE)
    assert wait > 0, "帳號層被白名單一起豁免了 —— 等於公司內網可以無限猜密碼"
    assert wait != ratelimit.PERMANENT, "帳號層應該是 15 分鐘自動解,不是永久"
    # 同一個 IP、別的帳號照樣進得去
    assert ratelimit.check("another", OFFICE) == 0


def test_allowlist_added_after_the_lock_still_lets_them_in(monkeypatch):
    """「公司被鎖了,趕快把公司 IP 加進白名單」—— 最可能發生的情境。

    加了之後要立刻生效(不必等重啟),而且重啟時那一列要被清掉。
    """
    _fail(OFFICE, 3)
    assert ratelimit.check("someone", OFFICE) == ratelimit.PERMANENT

    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", OFFICE_NET)
    assert ratelimit.check("someone", OFFICE) == 0, "加了白名單還是進不來"

    assert _restart() == 0
    assert _rows() == [], "白名單裡的 IP 在開機載回時要順手刪掉"


def test_ipv4_mapped_form_matches(monkeypatch):
    """`::ffff:203.0.113.5` 是同一個位址 —— 不換回 v4 的話白名單會時靈時不靈。"""
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", OFFICE_NET)
    assert ratelimit.is_allowlisted(f"::ffff:{OFFICE}")


def test_unknown_source_is_not_allowlisted(monkeypatch):
    """`unknown`(client_ip 抓不到來源)是「不知道是誰」,不是「是公司」。"""
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", OFFICE_NET)
    assert not ratelimit.is_allowlisted("unknown")
    assert not ratelimit.is_allowlisted("")


def test_garbage_entry_is_skipped_not_fatal(monkeypatch):
    """名單裡有一行打錯,不該讓其他幾行跟著失效(更不該擋住服務起來)。"""
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", f"哈囉,{OFFICE_NET}")
    assert ratelimit.is_allowlisted(OFFICE)
    assert not ratelimit.is_allowlisted(IP)


def test_allowlist_cache_follows_the_setting(monkeypatch):
    """設定值改了,比對結果要跟著改 —— 快取是照原始字串比的。"""
    assert not ratelimit.is_allowlisted(OFFICE)
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", OFFICE_NET)
    assert ratelimit.is_allowlisted(OFFICE)
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", "")
    assert not ratelimit.is_allowlisted(OFFICE)


# --------------------------------------------------------------- 其他


def test_snapshot_shows_the_restored_block():
    """重啟載回來的那些,管理員在「安全」頁要看得到(不然他不知道要解誰)。"""
    _fail(IP, 3)
    _restart()
    ips = ratelimit.snapshot()["ips"]
    assert [row["key"] for row in ips] == [IP]
    assert ips[0]["retry_after"] == ratelimit.PERMANENT


def test_restored_entry_starts_with_a_clean_counter():
    """載回來的 entry 計數從 0 算 —— 解鎖後要重新給滿額度,不是一失敗就再鎖。"""
    _fail(IP, 3)
    _restart()
    count, _, until = ratelimit._ips[IP]
    assert count == 0
    assert math.isinf(until)


def test_database_failure_does_not_break_login(monkeypatch):
    """資料庫寫不進去時,登入流程不能炸 —— 不然猛撞就能把服務打掛。"""
    monkeypatch.setattr(ratelimit, "SessionLocal", _boom)

    _fail(IP, 3)  # 不該丟例外
    # 記憶體那份仍然有效,只是這次鎖定不會跨重啟
    assert ratelimit.check("someone", IP) == ratelimit.PERMANENT


def test_failed_unlock_is_reported_not_swallowed(monkeypatch):
    """解鎖刪不掉那一列時要**說出來**。

    寫入端吞掉例外是對的(登入不該因為資料庫出問題就 500),但解鎖端不行:
    管理員看到「解鎖成功」、重啟後那個 IP 又回來,而唯一的線索在伺服器日誌裡。
    """
    _fail(IP, 3)
    monkeypatch.setattr(ratelimit, "SessionLocal", _boom)
    assert ratelimit.reset(ip=IP) is False
    # 記憶體還是解開了 —— 他這一刻確實進得來,回報的是「重啟後會回來」
    assert ratelimit.check("someone", IP) == 0


def test_unlock_racing_with_a_lock_does_not_resurrect_it(monkeypatch):
    """**解鎖與「剛好在這一瞬間鎖上」撞在一起,不能留下一列孤兒。**

    觸發順序(攻擊者在猛撞、管理員正在處理,正是這功能唯一被用到的場合):
      1. 第 10 次失敗在 `_lock` 裡把記憶體設成永久封鎖,放開鎖,還沒寫資料庫
      2. 管理員此刻按解鎖 —— 清掉記憶體、DELETE(表裡當時還沒有那一列)
      3. 第 1 步才把 INSERT 補上

    沒有防護的話,結果是記憶體解開了、資料庫留著一列,**下次重啟它自己回來**。
    這裡用 `_persist_block` 裡那次「寫之前再確認記憶體還鎖著」的檢查來擋。
    """
    real_persist = ratelimit._persist_block

    def persist_but_someone_unlocks_first(ip, locked_until):
        ratelimit.reset(ip=ip)  # 管理員卡在中間
        return real_persist(ip, locked_until)

    monkeypatch.setattr(ratelimit, "_persist_block", persist_but_someone_unlocks_first)
    _fail(IP, 3)

    assert ratelimit.check("someone", IP) == 0
    assert _rows() == [], "解鎖之後又被寫回去了 —— 重啟會讓這個封鎖復活"
    assert _restart() == 0
