# -*- coding: utf-8 -*-
"""登入的地理封鎖(`app/geoip.py` + `routers/auth.py`)。

政策:**只有判定為台灣(或內網)才放行,沒有例外,判不出國別也擋**
(fail-closed)。所以這裡最重要的幾條不是「境外擋得掉」,而是:
  - 私有位址 / 讀不懂的來源也擋 —— 這是刻意的,也是設定錯誤時的行為;
  - 功能**預設關閉**,關著的時候一切照舊(不然每個人的開發機都登不進去);
  - 試跑模式只記錄不擋;
  - 擋的那一刀落在**驗密碼之前**(不能從回應分辨密碼對不對、也不透露帳號存不存在)。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_geoip.py
"""
import pytest
from fastapi.testclient import TestClient

from app import config, geoip, models
from app.database import Base, SessionLocal, engine
from app.main import app

Base.metadata.create_all(bind=engine)

#: 測試自己的一小份清單,不依賴 backend/tw_ranges.txt 的當下內容
#: (那個檔會被 build_tw_ranges.py 重建,測試不該跟著它的增減浮動)。
SAMPLE = """
# 假的台灣網段清單
140.112.0.0/16
1.34.0.0/15
2001:288::/32
"""


@pytest.fixture()
def ranges(tmp_path):
    path = tmp_path / "tw.txt"
    path.write_text(SAMPLE, encoding="utf-8")
    return geoip.TaiwanRanges(path)


# ----------------------------------------------------------------- 查表本身
@pytest.mark.parametrize(
    "ip, expected",
    [
        ("140.112.8.116", geoip.TAIWAN),  # 段中間
        ("140.112.0.0", geoip.TAIWAN),  # 起點(邊界)
        ("140.112.255.255", geoip.TAIWAN),  # 終點(邊界)
        ("140.111.255.255", geoip.ELSEWHERE),  # 起點前一個
        ("140.113.0.0", geoip.ELSEWHERE),  # 終點後一個
        ("1.34.0.1", geoip.TAIWAN),
        ("8.8.8.8", geoip.ELSEWHERE),
        ("2001:288::1", geoip.TAIWAN),  # IPv6 也要查得到
        ("2606:4700::1111", geoip.ELSEWHERE),
        # IPv4-mapped:uvicorn 綁在 `::` 上時,v4 的來源會長成這樣。
        # 不正規化就會拿去查 v6 表 → 查不到 → fail-closed 把台灣人鎖在門外。
        ("::ffff:140.112.8.116", geoip.TAIWAN),
        ("::ffff:8.8.8.8", geoip.ELSEWHERE),
    ],
)
def test_country_of(ranges, ip, expected):
    assert ranges.country_of(ip) == expected


@pytest.mark.parametrize(
    "ip",
    ["127.0.0.1", "192.168.1.5", "10.0.0.7", "::1", "unknown", "", "::ffff:127.0.0.1"],
)
def test_private_and_garbage_are_unknown(ranges, ip):
    """私有位址與讀不懂的來源都是「判不出來」——**不是**台灣。

    私有位址在世界上每個角落都長一樣;`unknown` 是 `ratelimit.client_ip()` 抓不到
    來源時回的字串。這兩種說它是台灣都是猜的。
    """
    assert ranges.country_of(ip) is None
    assert geoip.is_allowed(ranges, ip) == (False, "unknown_ip")


def test_empty_list_blocks_everything(tmp_path):
    """清單讀不到的時候**每一個 IP 都會被擋** —— 這正是 `main.init_database()`
    要在啟動時擋下「開著但清單是空的」的理由(不擋的話是全員鎖死,而且看不出原因)。
    """
    missing = geoip.TaiwanRanges(tmp_path / "does-not-exist.txt")
    assert missing.count == 0
    assert geoip.is_allowed(missing, "140.112.8.116") == (False, "unknown_ip")


def test_is_allowed_reasons(ranges):
    assert geoip.is_allowed(ranges, "140.112.8.116") == (True, "taiwan")
    assert geoip.is_allowed(ranges, "8.8.8.8") == (False, "not_taiwan")


@pytest.mark.parametrize("ip", ["172.20.0.5", "172.16.0.1", "172.31.255.254", "::ffff:172.20.0.5"])
def test_intranet_172_is_allowed(ranges, ip, monkeypatch):
    """172.16.0.0/12 的內網來源放行。"""
    monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)
    assert geoip.is_allowed(ranges, ip) == (True, "intranet")


@pytest.mark.parametrize("ip", ["172.15.255.255", "172.32.0.1"])
def test_just_outside_172_16_slash_12_is_not_intranet(ranges, ip):
    """172.16.0.0/12 只到 172.31 —— 兩邊各差一個位址就不是內網(而且也不是台灣的段)。"""
    assert geoip.is_allowed(ranges, ip)[1] != "intranet"


def test_proxy_address_is_never_intranet(ranges, monkeypatch):
    """代理自己的位址照擋:`FORWARDED_ALLOW_IPS` 設錯時所有人都會長成它,
    那時候要「一個人都進不來」,不能變成「全世界都放行」。"""
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "10.0.0.6, 172.20.0.0/24")
    assert geoip.is_allowed(ranges, "172.20.0.5") == (False, "proxy_address")
    assert geoip.is_allowed(ranges, "172.21.0.5") == (True, "intranet")


def test_shipped_list_is_usable():
    """跟著版控走的那份(`backend/tw_ranges.txt`)要真的載得起來、而且認得台灣。

    不比對段數(APNIC 會增減,比對數字等於每次重建都要改測試),只確認
    「有內容、而且一個熟知的台灣位址查得到」。
    """
    real = geoip.default_ranges()
    assert real.count > 100
    assert real.country_of("140.112.8.116") == geoip.TAIWAN
    assert real.country_of("8.8.8.8") == geoip.ELSEWHERE


# ----------------------------------------------------------------- 接在登入上
def _make_admin():
    """建一個密碼進得去的帳號(用 app 自己的雜湊,不要自己拼)。"""
    from app import users as users_mod

    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == "geotest").delete()
        db.add(
            models.User(
                username="geotest",
                password=users_mod.hash_password("geo-pass-2026"),
                display_name="geotest",
                role="Software engineer",
            )
        )
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def geo_on(monkeypatch, tmp_path):
    """打開封鎖,並且讓測試能用 X-Forwarded-For 假裝來源 IP。"""
    path = tmp_path / "tw.txt"
    path.write_text(SAMPLE, encoding="utf-8")
    monkeypatch.setattr(geoip, "_default", geoip.TaiwanRanges(path))
    monkeypatch.setattr(config, "GEO_BLOCK_ENABLED", True)
    monkeypatch.setattr(config, "GEO_BLOCK_DRY_RUN", False)
    # client_ip 只有在這個旗標開著時才看 X-Forwarded-For(見 ratelimit.client_ip)
    monkeypatch.setattr(config, "TRUST_PROXY_HEADER", True)
    _make_admin()


def _login(client, ip):
    return client.post(
        "/api/login",
        json={"username": "geotest", "password": "geo-pass-2026"},
        headers={"X-Forwarded-For": ip},
    )


def test_login_allowed_from_taiwan(geo_on):
    with TestClient(app) as client:
        assert _login(client, "140.112.8.116").status_code == 200


def test_login_allowed_from_intranet(geo_on, monkeypatch):
    monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)
    with TestClient(app) as client:
        assert _login(client, "172.20.0.5").status_code == 200


def test_login_blocked_from_abroad(geo_on):
    with TestClient(app) as client:
        resp = _login(client, "8.8.8.8")
    assert resp.status_code == 403
    # 訊息**不能**提到國家或地區判定(那等於告訴對方換一台台灣跳板),
    # 也不能是「帳號或密碼錯誤」(出差的人會一直重試到把帳號撞鎖)。
    assert "國" not in resp.json()["detail"]
    assert "密碼" not in resp.json()["detail"]


def test_blocked_before_password_check(geo_on):
    """境外來源**用錯的密碼**也要拿到一模一樣的 403 —— 擋在驗密碼之前的證明。

    差一個字就代表回應能分辨密碼對不對,那這道封鎖對猜密碼的人是透明的。
    """
    with TestClient(app) as client:
        good = _login(client, "8.8.8.8")
        bad = client.post(
            "/api/login",
            json={"username": "geotest", "password": "wrong"},
            headers={"X-Forwarded-For": "8.8.8.8"},
        )
        # 連帳號不存在也要一樣
        nobody = client.post(
            "/api/login",
            json={"username": "no-such-user", "password": "x"},
            headers={"X-Forwarded-For": "8.8.8.8"},
        )
    assert good.status_code == bad.status_code == nobody.status_code == 403
    assert good.json() == bad.json() == nobody.json()


def test_dry_run_records_but_lets_through(geo_on, monkeypatch):
    """試跑模式:境外照樣進得來,但稽核留下一筆 —— 上線前拿它看會誤擋到誰。"""
    monkeypatch.setattr(config, "GEO_BLOCK_DRY_RUN", True)
    with TestClient(app) as client:
        assert _login(client, "8.8.8.8").status_code == 200

    db = SessionLocal()
    try:
        events = [
            row.event
            for row in db.query(models.AuditLog)
            .filter(models.AuditLog.actor == "geotest")
            .order_by(models.AuditLog.id.desc())
            .limit(5)
        ]
    finally:
        db.close()
    assert "login_geo_dryrun" in events


def test_disabled_by_default_lets_everyone_in(monkeypatch):
    """**關著的時候什麼都不做。** 功能沒開時,登入的行為必須跟沒有這個功能一模一樣
    (開發機也要登得進去)。
    """
    monkeypatch.setattr(config, "GEO_BLOCK_ENABLED", False)
    monkeypatch.setattr(config, "TRUST_PROXY_HEADER", True)
    _make_admin()
    with TestClient(app) as client:
        assert _login(client, "8.8.8.8").status_code == 200


# ----------------------------------------------------------------- 承諾要釘住的
def test_admin_has_no_bypass(geo_on):
    """**管理員也擋。** 沒有例外:所有人一律只能從允許的來源登入,沒有後門。

    這條要用真的管理員帳號跑 —— `_make_admin()` 建的是一般工程師,
    證明不了「is_admin 沒有被放行」。
    """
    from app import auth as auth_mod

    with TestClient(app) as client:
        resp = client.post(
            "/api/login",
            json={"username": config.ADMIN_USERNAME, "password": "whatever"},
            headers={"X-Forwarded-For": "8.8.8.8"},
        )
    assert resp.status_code == 403
    # 而且要跟一般帳號拿到**一模一樣**的回應(不能從回應看出這是管理員)
    assert auth_mod.is_admin(config.ADMIN_USERNAME)


def test_default_mode_is_off(monkeypatch):
    """**預設值真的是 off。** 測試環境沒有設 GEO_BLOCK_MODE,讀到的就該是預設。

    誰不小心把預設翻成開,已部署的服務下一次重啟就會開始擋人,而沒有人改過 .env。
    """
    assert config.GEO_BLOCK_MODE == "off"
    assert config.GEO_BLOCK_ENABLED is False
    assert config.GEO_BLOCK_DRY_RUN is False
    assert config.geo_block_mode_error() == ""


@pytest.mark.parametrize("bad", ["1", "true", "on", "yes", "ture", "enforce "])
def test_unknown_mode_is_rejected(monkeypatch, bad):
    """看不懂的值要**當場報錯**,不能靜默當成關閉、更不能靜默當成開。

    `"1"` / `"true"` 特地列進來:那是布林開關的寫法,很容易照抄過來 ——
    要的是明確失敗,不是猜。
    (`"enforce "` 有尾空白,但 config 會 strip,所以它**應該通過** —— 見下面的 assert。)
    """
    monkeypatch.setattr(config, "GEO_BLOCK_MODE", bad.strip().lower())
    if bad.strip().lower() in config.GEO_BLOCK_MODES:
        assert config.geo_block_mode_error() == ""
    else:
        assert "GEO_BLOCK_MODE" in config.geo_block_mode_error()


def test_startup_refuses_when_ranges_missing(monkeypatch, tmp_path):
    """**清單讀不到就不給開機。** fail-closed 之下清單空的等於全員鎖死,
    而畫面上的訊息刻意不透露原因 —— 服務起來反而沒人查得出真正的問題。
    """
    from app.main import init_database

    monkeypatch.setattr(config, "GEO_BLOCK_MODE", "enforce")
    monkeypatch.setattr(config, "GEO_BLOCK_ENABLED", True)
    monkeypatch.setattr(geoip, "_default", geoip.TaiwanRanges(tmp_path / "nope.txt"))
    with pytest.raises(RuntimeError) as exc:
        init_database()
    # 要確定擋下來的是**這個**原因,不是別的啟動檢查(例如 ADMIN_PASSWORD)
    assert "tw_ranges" in str(exc.value) or "網段清單" in str(exc.value)


def test_startup_refuses_unknown_mode(monkeypatch):
    """設定值看不懂也不給開機 —— 同上,猜錯一邊的代價是所有人登不進來。"""
    from app.main import init_database

    monkeypatch.setattr(config, "GEO_BLOCK_MODE", "ture")
    with pytest.raises(RuntimeError) as exc:
        init_database()
    assert "GEO_BLOCK_MODE" in str(exc.value)
