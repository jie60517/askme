# -*- coding: utf-8 -*-
"""地理封鎖的例外清單(出差用)。

境外 IP 被地理封鎖擋著時,管理員可以在 Security 頁把出差的人的來源加進白名單,
不用重啟。

這幾支守的是**四件壞掉時畫面上看不出來的事**:

  1. **加了就生效,不必重啟。** 做不到的話,人在機場而管理員要去伺服器改 .env
     —— 而那正是這個功能要取代的流程。
  2. **它只免地理那一關。** 密碼、第二關(有綁的話)全部照舊。少了這條,
     「替出差的人開一條路」會悄悄變成「境外免二階段驗證」。
  3. **開不了太大的門。** `0.0.0.0/0`、`/8` 這種填法等於把整個封鎖關掉,
     而畫面上封鎖還是「啟用」—— 沒有人會發現。
  4. **留得下紀錄。** 誰開的、什麼時候關的、從白名單進來過幾次 —— 清單本身只有 IP,
     這些全記在稽核表。白名單是人開的,開了忘記關才是這個功能真正的風險。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_geo_allow.py
"""
import pytest
from fastapi.testclient import TestClient

from app import config, geo_allow, geoip, mfa, models, totp
from app.database import Base, SessionLocal, engine
from app.main import app

#: 測試用的「台灣」只有這一段(真的那份在 backend/tw_ranges.txt)。
SAMPLE = "140.112.0.0/16\n"

ABROAD = "8.8.8.8"
TAIWAN = "140.112.8.116"

USERNAME = "geoallowtest"
PASSWORD = "geo-allow-pass-2026"
#: 管理員的帳號名**不是寫死的 "admin"** —— 它在 .env 裡(ADMIN_USERNAME)。
#: 寫死的話這幾支會在別人的機器上莫名其妙地 401。
ADMIN = config.ADMIN_USERNAME


@pytest.fixture(autouse=True, scope="module")
def _tables():
    # 理由見 test_mfa.py 的同名 fixture:單獨跑這一檔時沒有別人先建表。
    Base.metadata.create_all(engine)


@pytest.fixture()
def clean_list():
    """每一支測試都從空的名單開始,跑完也清乾淨。

    白名單是**全域狀態**(一張表,沒有 per-request 的作用域),留下一條的話
    下一支測試會莫名其妙地放行 —— 而它自己完全沒提到白名單,查起來最久。
    """

    def _wipe():
        db = SessionLocal()
        try:
            db.query(models.GeoAllowIP).delete()
            db.commit()
        finally:
            db.close()

    _wipe()
    yield
    _wipe()


@pytest.fixture()
def geo_on(monkeypatch, tmp_path, clean_list):
    """封鎖開著(enforce),而且測試能用 X-Forwarded-For 假裝來源 IP。"""
    from app import users as users_mod

    path = tmp_path / "tw.txt"
    path.write_text(SAMPLE, encoding="utf-8")
    monkeypatch.setattr(geoip, "_default", geoip.TaiwanRanges(path))
    monkeypatch.setattr(config, "GEO_BLOCK_ENABLED", True)
    monkeypatch.setattr(config, "GEO_BLOCK_DRY_RUN", False)
    # client_ip 只有在這個旗標開著時才看 X-Forwarded-For(見 ratelimit.client_ip)
    monkeypatch.setattr(config, "TRUST_PROXY_HEADER", True)

    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == USERNAME).delete()
        db.query(models.UserMFA).filter(models.UserMFA.username == USERNAME).delete()
        db.add(
            models.User(
                username=USERNAME,
                password=users_mod.hash_password(PASSWORD),
                display_name=USERNAME,
            )
        )
        db.commit()
    finally:
        db.close()

    yield

    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == USERNAME).delete()
        db.query(models.UserMFA).filter(models.UserMFA.username == USERNAME).delete()
        db.commit()
    finally:
        db.close()


def _login(client, ip, password=PASSWORD, username=USERNAME):
    return client.post(
        "/api/login",
        json={"username": username, "password": password},
        headers={"X-Forwarded-For": ip},
    )


def _admin_token(client):
    resp = client.post(
        "/api/login",
        json={"username": ADMIN, "password": config.ADMIN_PASSWORD},
        headers={"X-Forwarded-For": TAIWAN},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


def _details(actor):
    """最近幾列的 (事件, detail)。稽核的 detail 是事後唯一看得到「哪一條白名單」的地方。"""
    db = SessionLocal()
    try:
        return [
            (row.event, row.detail)
            for row in db.query(models.AuditLog)
            .filter(models.AuditLog.actor == actor)
            .order_by(models.AuditLog.id.desc())
            .limit(10)
        ]
    finally:
        db.close()


def _events(actor):
    db = SessionLocal()
    try:
        return [
            row.event
            for row in db.query(models.AuditLog)
            .filter(models.AuditLog.actor == actor)
            .order_by(models.AuditLog.id.desc())
            .limit(10)
        ]
    finally:
        db.close()


# ----------------------------------------------------------------- 填什麼算數


def test_single_address_is_stored_as_a_full_prefix():
    """`9.9.9.9` 與 `9.9.9.9/32` 是同一條,不能變成兩列。

    變成兩列的話,管理員刪掉其中一列會以為門關上了,而另一列還開著。
    """
    assert geo_allow.normalize("9.9.9.9") == "9.9.9.9/32"
    assert geo_allow.normalize(" 9.9.9.9/32 ") == "9.9.9.9/32"
    assert geo_allow.normalize("2606:4700::1") == "2606:4700::1/128"


def test_host_bits_are_normalised_to_the_network():
    """`9.9.9.5/24` 照網段解讀,存成 `9.9.9.0/24`。

    清單上要看得出**實際放行的範圍比他打的字大** —— 他以為自己開了一個位址。
    """
    assert geo_allow.normalize("9.9.9.5/24") == "9.9.9.0/24"


@pytest.mark.parametrize("bad", ["0.0.0.0/0", "::/0"])
def test_rejects_the_whole_internet(bad):
    """**最重要的一條護欄。** 這種填法等於把地理封鎖關掉,而畫面上它還是「啟用」。"""
    with pytest.raises(geo_allow.InvalidEntry):
        geo_allow.normalize(bad)


@pytest.mark.parametrize("bad", ["1.0.0.0/8", "9.9.0.0/15", "2606:4700::/31"])
def test_rejects_oversized_ranges(bad):
    with pytest.raises(geo_allow.InvalidEntry):
        geo_allow.normalize(bad)


@pytest.mark.parametrize("bad", ["10.0.0.5", "192.168.1.1", "127.0.0.1", "172.16.0.1", "203.0.113.5", "100.64.0.1"])
def test_rejects_private_addresses(bad):
    """不是對外位址的那些,包含**文件用途的 `203.0.113.0/24`**(照著範例打的人
    應該當場知道那不是真的 IP)與 CGNAT。內網那幾段更要擋 ——
    **它出現本身就代表代理設定壞了**。

    `FORWARDED_ALLOW_IPS` 設錯時 `client_ip()` 會對所有人回 nginx 自己的位址 ——
    那時候把它加進白名單等於一次替全世界開門。要修的是代理設定。
    """
    with pytest.raises(geo_allow.InvalidEntry):
        geo_allow.normalize(bad)


@pytest.mark.parametrize("bad", ["", "   ", "不是 IP", "9.9.9.999", "9.9.9.9/99"])
def test_rejects_garbage(bad):
    with pytest.raises(geo_allow.InvalidEntry):
        geo_allow.normalize(bad)


def test_match_understands_ipv4_mapped_form(clean_list):
    """`::ffff:9.9.9.9` 要比得中 `9.9.9.9/32`。

    代理、或綁在 `::` 上的 uvicorn 會給出那種寫法 —— 不換算的話,症狀是
    「明明加了,他還是登不進來」。
    """
    geo_allow.add("9.9.9.9", ADMIN)
    assert geo_allow.match("::ffff:9.9.9.9") == "9.9.9.9/32"
    assert geo_allow.match("9.9.9.10") is None


def test_match_ignores_unresolvable_source(clean_list):
    """`unknown`(client_ip 抓不到來源)不能算在白名單裡 —— 那是「不知道是誰」。"""
    geo_allow.add("9.9.9.0/24", ADMIN)
    assert geo_allow.match("unknown") is None


def test_adding_twice_keeps_the_first_row(clean_list):
    """重複加不算錯,但**不覆蓋原本那一列** —— 第二次點擊不該把時間洗掉。"""
    first = geo_allow.add("9.9.9.9", ADMIN)
    again = geo_allow.add("9.9.9.9/32", "someone-else")
    assert again.created_at == first.created_at
    assert len(geo_allow.entries()) == 1


# ----------------------------------------------------------------- 接在登入上


def test_abroad_is_blocked_until_allowlisted(geo_on):
    """**加了就生效,同一個 process 不必重啟。**"""
    with TestClient(app) as client:
        assert _login(client, ABROAD).status_code == 403

        geo_allow.add(ABROAD, ADMIN)

        ok = _login(client, ABROAD)
        assert ok.status_code == 200, ok.text
        assert "token" in ok.json()

    assert "login_geo_allowlisted" in _events(USERNAME)


def test_removing_closes_the_door_again(geo_on):
    with TestClient(app) as client:
        geo_allow.add(ABROAD, ADMIN)
        assert _login(client, ABROAD).status_code == 200

        # remove 回的是**正規化後的那個字串**(稽核記的就是它),不是布林
        assert geo_allow.remove("8.8.8.8/32") == "8.8.8.8/32"
        assert _login(client, ABROAD).status_code == 403


def test_allowlist_only_skips_the_geo_check(geo_on):
    """**密碼照驗。** 白名單放行的是「來源」,不是「這個人」。"""
    geo_allow.add(ABROAD, ADMIN)
    with TestClient(app) as client:
        assert _login(client, ABROAD, password="wrong-password").status_code == 401


def test_allowlisted_source_still_needs_the_second_factor(geo_on):
    """**最容易被做錯的一條。**

    白名單不綁帳號,所以從那個來源打過來的任何
    帳號都能過地理那一關 —— 正因為門開得寬,第二關更不能跟著免。
    免掉第二關的是**公司自己的 IP**(`MFA_SKIP_ON_TRUSTED_IP`),兩件事分開。
    """
    secret = mfa.issue(USERNAME)["secret"]
    geo_allow.add(ABROAD, ADMIN)

    with TestClient(app) as client:
        resp = _login(client, ABROAD)
        assert resp.status_code == 200
        body = resp.json()
        assert body.get("mfa_required") is True, "境外白名單把第二關一起免掉了"
        assert "token" not in body

        code = totp._code_for_counter(totp._decode_secret(secret), totp.current_counter())
        done = client.post(
            "/api/login/mfa",
            json={"mfa_token": body["mfa_token"], "code": code},
            headers={"X-Forwarded-For": ABROAD},
        )
        assert done.status_code == 200 and "token" in done.json()


def test_allowlisted_source_is_not_counted_as_a_dryrun_miss(geo_on, monkeypatch):
    """試跑模式下,**白名單裡的人不該被記成「將來會被擋」**。

    那份紀錄的用途就是數一數真的開下去會誤擋到誰 ——
    把已經開好門的人算進去,那個數字就沒有意義了。
    """
    monkeypatch.setattr(config, "GEO_BLOCK_DRY_RUN", True)
    geo_allow.add(ABROAD, ADMIN)

    with TestClient(app) as client:
        assert _login(client, ABROAD).status_code == 200

    events = _events(USERNAME)
    assert "login_geo_dryrun" not in events
    assert "login_geo_allowlisted" in events


# ----------------------------------------------------------------- API


def test_api_is_admin_only(geo_on):
    with TestClient(app) as client:
        token = _login(client, TAIWAN).json()["token"]
        headers = {"Authorization": f"Bearer {token}", "X-Forwarded-For": TAIWAN}
        assert client.get("/api/geo-allow", headers=headers).status_code == 403
        assert (
            client.post(
                "/api/geo-allow", json={"ip": ABROAD}, headers=headers
            ).status_code
            == 403
        )
        # 沒登入也不行
        assert client.get("/api/geo-allow").status_code == 401


def test_admin_can_add_list_and_remove(geo_on):
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {_admin_token(client)}",
            "X-Forwarded-For": TAIWAN,
        }

        added = client.post("/api/geo-allow", json={"ip": "9.9.9.9"}, headers=headers)
        assert added.status_code == 200, added.text
        assert added.json()["cidr"] == "9.9.9.9/32"

        listed = client.get("/api/geo-allow", headers=headers)
        assert listed.status_code == 200
        # ⚠️ 回的是**一個陣列**,不是 {items, mode}。
        assert [row["cidr"] for row in listed.json()] == ["9.9.9.9/32"]

        gone = client.post(
            "/api/geo-allow/remove", json={"ip": "9.9.9.9"}, headers=headers
        )
        assert gone.status_code == 204
        assert client.get("/api/geo-allow", headers=headers).json() == []

    assert "geo_allow_added" in _events(ADMIN)
    assert "geo_allow_removed" in _events(ADMIN)


def test_bad_entry_comes_back_as_a_readable_400(geo_on):
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {_admin_token(client)}",
            "X-Forwarded-For": TAIWAN,
        }
        resp = client.post("/api/geo-allow", json={"ip": "0.0.0.0/0"}, headers=headers)
        assert resp.status_code == 400
        # 訊息是給人看的中文,不是 pydantic 的英文欄位錯誤
        assert "全世界" in resp.json()["detail"]


def test_removing_something_that_is_not_there_says_so(geo_on):
    """靜靜回 204 的話,「門還開著」跟「畫面沒更新」在畫面上長得一模一樣。"""
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {_admin_token(client)}",
            "X-Forwarded-For": TAIWAN,
        }
        resp = client.post(
            "/api/geo-allow/remove", json={"ip": "9.9.9.10"}, headers=headers
        )
        assert resp.status_code == 404


def test_audit_says_the_same_thing_when_opening_and_closing(geo_on):
    """**開門那一列與關門那一列要指得出是同一條白名單。**

    使用者刪的時候打的字**不一定跟清單上顯示的一樣**(`9.9.9.5/24` 與
    `9.9.9.0/24` 是同一條),而稽核如果照著他打的字記,兩列就對不起來 ——
    事後查「那個境外來源是誰開的、什麼時候關的」會變成兩件看起來無關的事。
    所以兩邊都記正規化後的網段。

    ⚠️ 「同一條」的界線在**前綴**,不在位址:`9.9.9.5`(→ `/32`)跟
    `9.9.9.0/24` 是**兩條不同的**白名單,刪前者不會動到後者 —— 那是對的,
    而且下面那條 404 的測試守著它。
    """
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {_admin_token(client)}",
            "X-Forwarded-For": TAIWAN,
        }
        added = client.post(
            "/api/geo-allow",
            json={"ip": "9.9.9.5/24"},
            headers=headers,
        )
        assert added.status_code == 200, added.text
        assert added.json()["cidr"] == "9.9.9.0/24"

        # **故意用另一種寫法刪** —— 同一條網段,但不是清單上顯示的那個字串
        gone = client.post("/api/geo-allow/remove", json={"ip": "9.9.9.5/24"}, headers=headers)
        assert gone.status_code == 204

    # ⚠️ **要取「最新的那一筆」。** 同一檔裡別的測試也用管理員的身分加過、刪過
    # 白名單,而 `_details` 是新到舊排的 —— 直接 `dict(...)` 的話後面(舊的)那筆
    # 會蓋掉前面(新的),於是這條在單獨跑時綠、整檔跑時紅,而失敗訊息跟本測試無關。
    details = _details(ADMIN)
    latest = {}
    for event, detail in details:
        latest.setdefault(event, detail)

    assert latest["geo_allow_added"] == "9.9.9.0/24"
    assert latest["geo_allow_removed"] == "9.9.9.0/24"
