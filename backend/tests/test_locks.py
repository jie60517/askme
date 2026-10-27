# -*- coding: utf-8 -*-
"""登入鎖定的查詢與解除(`routers/locks.py`)。

這兩條端點是「把自己鎖在門外」時
唯一的自助途徑 —— `LOGIN_IP_LOCKOUT_SEC=0` 是 IP 層永久封鎖,沒人按解鎖
就是真的一直鎖著。

這份要守的是三件會靜悄悄出錯的事:

  看得到 —— 鎖住的 IP 要出現在 /api/locks,而且永久封鎖要標得出來(-1)。
  解得開 —— 按了解鎖,記憶體與**資料庫**兩邊都要清掉。
  講得出來 —— 資料庫那一列沒刪成功時**不能回 204**。靜靜成功的話,管理員
  看到的是解鎖了,下次部署之後那個 IP 又被鎖著,而唯一的線索在伺服器日誌裡。
  那一條是 `routers/locks.py` 的 `unlock()` 裡回 500 的分支,也是這支 router 最容易
  在重構時被「簡化」掉的地方。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_locks.py
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, models, ratelimit
from app.database import Base, SessionLocal, engine
from app.main import app

IP = "198.51.100.23"
VICTIM = "locked-out-person"


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_ratelimit.py:建表在 lifespan 裡,而 fixture 比它早。"""
    Base.metadata.create_all(engine)


def _wipe_blocks():
    db = SessionLocal()
    try:
        db.query(models.LoginIPBlock).delete()
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """每一條都從「沒有任何鎖定」開始,記憶體與資料庫都清。

    只清一邊的話,前一條留下的狀態會從另一邊漏進來 —— 這個功能的重點
    正是那兩份會互相影響。
    """
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_MAX_ATTEMPTS", 3)
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_LOCKOUT_SEC", 0)  # 0 = 永久
    monkeypatch.setattr(ratelimit.config, "LOGIN_MAX_ATTEMPTS", 3)
    monkeypatch.setattr(ratelimit.config, "LOGIN_LOCKOUT_SEC", 900)
    monkeypatch.setattr(ratelimit.config, "LOGIN_IP_ALLOWLIST", "")

    ratelimit._accounts.clear()
    ratelimit._ips.clear()
    _wipe_blocks()
    yield
    ratelimit._accounts.clear()
    ratelimit._ips.clear()
    _wipe_blocks()


def _admin():
    return {"Authorization": f"Bearer {auth._issue(config.ADMIN_USERNAME)}"}


def _lock_the_ip():
    """撞到 IP 層上限。`LOGIN_IP_MAX_ATTEMPTS=3`,所以三次就鎖。

    用 `record_blocked_attempt`:它只記 IP 層,不會順手把哪個帳號也鎖上。"""
    for _ in range(3):
        ratelimit.record_blocked_attempt(IP)


def _ip_wait() -> int:
    """這個 IP 還要等多久。拿一個沒失敗過的帳號問 `check`,答案就只來自 IP 層。"""
    return ratelimit.check("never-tried-account", IP)


# ── 誰能看 ──────────────────────────────────────────────────────────


def test_locks_is_admin_only():
    """一般帳號看不到鎖定清單 —— 那是「誰正在被鎖」的名單。

    要的是 403 不是 401:他確實登入了,只是這一頁不給看。回 401 的話
    前端會把 token 清掉、把人踢回登入頁,他會以為自己密碼打錯。
    """
    with TestClient(app) as client:
        resp = client.get(
            "/api/locks", headers={"Authorization": f"Bearer {auth._issue('nobody-special')}"}
        )
    assert resp.status_code == 403


def test_unlock_is_admin_only():
    """解鎖更不能開放 —— 開放等於讓被鎖的人自己解開自己。"""
    with TestClient(app) as client:
        resp = client.post(
            "/api/locks/unlock",
            json={"ip": IP},
            headers={"Authorization": f"Bearer {auth._issue('nobody-special')}"},
        )
    assert resp.status_code == 403


# ── 看得到 ──────────────────────────────────────────────────────────


def test_locked_ip_shows_up_as_permanent():
    """鎖住的 IP 要出現在清單上,而且 `retry_after` 是 -1(永久)。

    -1 不是「錯誤」而是 `ratelimit.PERMANENT`。前端要靠它分辨「等一下就好」
    跟「不處理就一直鎖著」,混在一起顯示的話管理員會以為可以等。
    """
    _lock_the_ip()

    with TestClient(app) as client:
        data = client.get("/api/locks", headers=_admin()).json()

    ips = {row["key"]: row["retry_after"] for row in data["ips"]}
    assert IP in ips, "鎖住的 IP 沒出現在 /api/locks 上,管理員無從得知要解誰"
    assert ips[IP] == ratelimit.PERMANENT


def test_accounts_and_ips_are_separate_lists():
    """帳號層與 IP 層是兩份清單,不能混。

    兩者的性質不同:帳號層會自己到期(預設 15 分鐘),IP 層目前是永久。
    併成一份的話,管理員分不出哪幾筆非處理不可。
    """
    ratelimit.record_failure(VICTIM, IP)
    ratelimit.record_failure(VICTIM, IP)
    ratelimit.record_failure(VICTIM, IP)

    with TestClient(app) as client:
        data = client.get("/api/locks", headers=_admin()).json()

    assert VICTIM in {row["key"] for row in data["accounts"]}
    assert IP in {row["key"] for row in data["ips"]}
    assert VICTIM not in {row["key"] for row in data["ips"]}


def test_only_locked_entries_are_listed():
    """失敗過但還沒鎖的不列 —— 那是正常人打錯字的日常。

    列出來的話,真正需要處理的那幾筆會被淹沒。
    """
    ratelimit.record_blocked_attempt(IP)  # 只有 1 次,上限是 3

    with TestClient(app) as client:
        data = client.get("/api/locks", headers=_admin()).json()

    assert IP not in {row["key"] for row in data["ips"]}


# ── 解得開 ──────────────────────────────────────────────────────────


def test_unlock_clears_memory_and_database():
    """按了解鎖,兩邊都要乾淨。

    只清記憶體的話,這一次確實進得來,但服務一重啟那筆封鎖就被載回來 ——
    管理員看到的是「我解過的 IP 自己回來了」,而且查不出原因。
    """
    _lock_the_ip()
    assert _ip_wait() != 0, "前置條件沒成立:IP 應該是鎖住的"

    db = SessionLocal()
    persisted_before = db.query(models.LoginIPBlock).filter(models.LoginIPBlock.ip == IP).count()
    db.close()
    assert persisted_before == 1, "前置條件沒成立:封鎖應該有寫進資料庫"

    with TestClient(app) as client:
        resp = client.post("/api/locks/unlock", json={"ip": IP}, headers=_admin())

    assert resp.status_code == 204
    assert _ip_wait() == 0, "記憶體還鎖著"

    db = SessionLocal()
    persisted_after = db.query(models.LoginIPBlock).filter(models.LoginIPBlock.ip == IP).count()
    db.close()
    assert persisted_after == 0, "資料庫那一列還在 —— 重啟之後封鎖會回來"


def test_unlock_also_clears_the_failure_count():
    """解鎖要連失敗計數一起清,不然對方下一次打錯就立刻又被鎖上。

    那種情況下管理員會以為解鎖按鈕沒有作用。
    """
    _lock_the_ip()

    with TestClient(app) as client:
        assert client.post("/api/locks/unlock", json={"ip": IP}, headers=_admin()).status_code == 204

    ratelimit.record_blocked_attempt(IP)  # 上限 3,計數若沒清這一次就會再鎖上
    assert _ip_wait() == 0, "計數沒清掉 —— 一次失敗就又被鎖住了"


def test_unlock_needs_a_target():
    """兩個都不給要 400。

    不擋的話會走到 `ratelimit.reset()` 的 clear_all 分支,**把全站的鎖定
    一次清光** —— 那跟管理員按這顆按鈕想做的事完全不同。
    """
    with TestClient(app) as client:
        resp = client.post("/api/locks/unlock", json={}, headers=_admin())
    assert resp.status_code == 400


def test_unlock_a_never_locked_ip_is_not_an_error():
    """解一個沒被鎖的 IP 不該報錯 —— 管理員按兩次是很正常的事。"""
    with TestClient(app) as client:
        resp = client.post("/api/locks/unlock", json={"ip": "203.0.113.99"}, headers=_admin())
    assert resp.status_code == 204


# ── 講得出來(這支 router 最容易被「簡化」掉的分支)──────────────────


def test_unlock_reports_when_the_database_row_survives(monkeypatch):
    """記憶體解開了、資料庫那列沒刪掉 —— **不能回 204**。

    這是 `routers/locks.py` 的 `unlock()` 回 500 那段。靜靜回 204 的話,管理員看到的是
    解鎖成功,下次部署之後那個 IP 又被鎖著,而唯一的線索在伺服器日誌裡。
    實務上多半是 SQLite 的 `database is locked`(有人正在寫)。

    這裡直接讓 `_forget_block` 回 False 來模擬那個狀態 —— 真的去製造一次
    寫入衝突會讓測試變得不穩定,而要驗的是「回報」不是「衝突怎麼發生」。
    """
    _lock_the_ip()
    monkeypatch.setattr(ratelimit, "_forget_block", lambda ip: False)

    with TestClient(app) as client:
        resp = client.post("/api/locks/unlock", json={"ip": IP}, headers=_admin())

    assert resp.status_code == 500, "資料庫沒刪成功卻回了成功 —— 管理員不會知道封鎖會回來"
    assert "重啟" in resp.json()["detail"], "訊息要講出「重啟之後會回來」,不然管理員不知道要再按一次"

    # 記憶體那半仍然要是解開的:這一次他確實進得來,壞的只有持久化那半。
    assert _ip_wait() == 0


def test_unlocking_only_an_account_does_not_hit_the_database_branch():
    """只解帳號、不碰 IP 的那種呼叫一律成功 —— 帳號層本來就不落地。

    這條防的是「把 500 那條分支寫成無條件檢查」:那樣的話管理員每次解帳號
    都會看到一句嚇人的錯誤訊息,而其實什麼問題都沒有。
    """
    ratelimit.record_failure(VICTIM, "203.0.113.77")
    ratelimit.record_failure(VICTIM, "203.0.113.77")
    ratelimit.record_failure(VICTIM, "203.0.113.77")

    with TestClient(app) as client:
        resp = client.post("/api/locks/unlock", json={"username": VICTIM}, headers=_admin())

    assert resp.status_code == 204
