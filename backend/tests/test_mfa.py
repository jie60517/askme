"""多因子驗證 —— **管理員發放**的模型。

管理員在帳號管理頁按「產生 QR code」→ 使用者拿手機掃 → 之後登入要輸入六碼。
沒有自助綁定,也沒有備用碼;手機壞了就請管理員再產生一次。

這幾支守的是**幾件不能退回去的事**,每一件壞掉的表現都是「畫面上完全正常」:

  1. 演算法要對。TOTP 是跨系統的協定 —— 對不上 RFC 6238 的測試向量,
     症狀是「掃了碼,但每次登入都說驗證碼錯」,而錯的是我們。
  2. 只過第一關拿到的東西**不能是一張能用的 token**。這是整個功能的重點:
     驗漏了的話 MFA 等於完全沒裝,而登入畫面看起來一模一樣。
  3. 同一組碼**不能用第二次**。重放沒擋住的話,MFA 退化成「第二個密碼」。
  4. 重新產生**一定要讓舊的當場失效**。不然「手機掉了」按下去等於沒按。
  5. 「公司 IP 免第二關」(`MFA_SKIP_ON_TRUSTED_IP`)**只在
     公司的 IP 上免**,而且**預設關著**。這一條漏掉的話,一個為了方便加的開關
     會變成「所有人都不必過第二關」—— 而登入畫面一樣是一路順暢的。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_mfa.py
"""
import base64
import time

import pytest
from fastapi.testclient import TestClient

from app import auth, config, mfa, models, ratelimit, totp, users
from app.database import Base, SessionLocal, engine
from app.main import app

USERNAME = "mfauser"
PASSWORD = "not-the-default-password"


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """建表。

    ⚠️ 不能靠別的測試檔先跑過 —— 建表是在 `TestClient(app)` 的 lifespan 裡發生的
    (見 conftest 的說明),而這一檔的 fixture 在那之前就要寫資料庫。
    少了這一行,單獨跑 `pytest tests/test_mfa.py` 會整片 `no such table: users`,
    但整套一起跑卻是綠的 —— 那種只在單獨執行時壞掉的測試最浪費時間。
    """
    Base.metadata.create_all(engine)


def _code_now(secret: str, offset: int = 0) -> str:
    """現在這個時間窗的驗證碼。`offset` 以 30 秒為單位。"""
    return totp._code_for_counter(totp._decode_secret(secret), totp.current_counter() + offset)


@pytest.fixture
def account():
    """一個真的能登入的帳號,測試結束整個清掉(含 MFA 綁定)。"""
    db = SessionLocal()
    db.query(models.User).filter(models.User.username == USERNAME).delete()
    db.query(models.UserMFA).filter(models.UserMFA.username == USERNAME).delete()
    db.add(
        models.User(
            username=USERNAME,
            password=users.hash_password(PASSWORD),
            display_name="MFA Tester",
        )
    )
    db.commit()
    db.close()

    yield USERNAME

    db = SessionLocal()
    db.query(models.User).filter(models.User.username == USERNAME).delete()
    db.query(models.UserMFA).filter(models.UserMFA.username == USERNAME).delete()
    db.commit()
    db.close()


# ---------------------------------------------------------------- 演算法

@pytest.mark.parametrize(
    "unix_time, expected",
    [
        # RFC 6238 附錄 B 的測試向量(SHA-1,密鑰 "12345678901234567890")。
        # ⚠️ 這幾個數字**不是我們算出來的**,是規格書上印的 —— 所以它們同時
        # 也在驗「使用者手機上那支 App 會不會同意我們」。
        (59, "287082"),
        (1111111109, "081804"),
        (1111111111, "050471"),
        (1234567890, "005924"),
        (2000000000, "279037"),
    ],
)
def test_matches_rfc6238_vectors(unix_time, expected):
    secret = base64.b32encode(b"12345678901234567890").decode().rstrip("=")
    got = totp._code_for_counter(totp._decode_secret(secret), unix_time // 30)
    assert got == expected, f"t={unix_time} 應該是 {expected},算出來是 {got}"


def test_accepts_one_step_of_clock_skew():
    """手機時鐘差幾秒是常態。前後各一個時間窗要收,兩個窗以外要拒。"""
    secret = totp.generate_secret()
    assert totp.verify(secret, _code_now(secret, -1)) is not None
    assert totp.verify(secret, _code_now(secret, +1)) is not None
    assert totp.verify(secret, _code_now(secret, +3)) is None


def test_rejects_replay_of_the_same_counter():
    """用過的計數器不能再用 —— 這是 `last_counter` 存在的唯一理由。"""
    secret = totp.generate_secret()
    code = _code_now(secret)
    used = totp.verify(secret, code)
    assert used is not None
    assert totp.verify(secret, code, last_counter=used) is None


# ---------------------------------------------------------------- 發放與登入

def test_issue_takes_effect_immediately(account):
    """管理員發的,**發了就算數** —— 沒有「待確認」那個中間狀態。

    自助綁定才需要它(使用者可能抄到一半跑掉),而這裡是管理員當面給人掃碼。
    """
    assert mfa.is_enabled(account) is False
    issued = mfa.issue(account)
    assert issued["secret"] and issued["otpauth_uri"].startswith("otpauth://totp/")
    assert mfa.is_enabled(account) is True


def test_reissue_kills_the_old_secret(account):
    """**手機掉了按「重新產生」,舊手機上那組就要當場失效。**

    不作廢的話,撿到舊手機的人照樣進得來,而管理員以為自己已經處理完了。
    """
    old_secret = mfa.issue(account)["secret"]
    new_secret = mfa.issue(account)["secret"]
    assert old_secret != new_secret

    assert mfa.verify_code(account, _code_now(old_secret)) is False, "舊的密鑰還能登入"
    assert mfa.verify_code(account, _code_now(new_secret)) is True


def test_reissue_clears_the_replay_counter(account):
    """換密鑰時**要把用過的計數器清掉**。

    不清的話,新密鑰的前幾組碼會被「小於等於 last_counter」那條規則擋掉 ——
    而使用者只看到「驗證碼不正確」,完全看不出是系統在擋自己。
    """
    first = mfa.issue(account)["secret"]
    assert mfa.verify_code(account, _code_now(first)) is True  # 用掉這一格
    second = mfa.issue(account)["secret"]
    assert mfa.verify_code(account, _code_now(second)) is True, "重新產生之後,同一格的碼被舊計數器擋掉了"


def test_password_alone_does_not_get_you_in(account):
    """**整個功能的重點。** 只過第一關拿到的字串不能當 token 用。"""
    mfa.issue(account)

    with TestClient(app) as client:
        resp = client.post("/api/login", json={"username": account, "password": PASSWORD})
        assert resp.status_code == 200
        body = resp.json()
        assert body.get("mfa_required") is True
        assert "token" not in body, "只過了密碼那關就拿到 token —— 第二道關卡形同虛設"

        # 那張中間憑證拿去打真正的 API 一律要被擋
        challenge = body["mfa_token"]
        me = client.get("/api/conversations", headers={"Authorization": f"Bearer {challenge}"})
        assert me.status_code == 401, "中間憑證被當成合法 token,MFA 被繞過"


def test_second_factor_completes_the_login(account):
    secret = mfa.issue(account)["secret"]

    with TestClient(app) as client:
        challenge = client.post(
            "/api/login", json={"username": account, "password": PASSWORD}
        ).json()["mfa_token"]

        bad = client.post("/api/login/mfa", json={"mfa_token": challenge, "code": "000000"})
        assert bad.status_code == 401

        resp = client.post(
            "/api/login/mfa", json={"mfa_token": challenge, "code": _code_now(secret)}
        )
        assert resp.status_code == 200, resp.text
        token = resp.json()["token"]
        assert client.get(
            "/api/conversations", headers={"Authorization": f"Bearer {token}"}
        ).status_code == 200


def test_challenge_is_single_use(account):
    """換過 token 的中間憑證要當場作廢 —— 不然它就是一張可以重複使用的通行證。"""
    secret = mfa.issue(account)["secret"]

    with TestClient(app) as client:
        challenge = client.post(
            "/api/login", json={"username": account, "password": PASSWORD}
        ).json()["mfa_token"]
        code = _code_now(secret)
        assert client.post(
            "/api/login/mfa", json={"mfa_token": challenge, "code": code}
        ).status_code == 200
        again = client.post("/api/login/mfa", json={"mfa_token": challenge, "code": code})
        assert again.status_code == 401


def test_unbound_user_logs_in_with_password_until_enforced(account, monkeypatch):
    """還沒發到 QR 的人:**沒開強制時照舊登得進來,開了就擋。**

    這個順序是全面上線的關鍵 —— 先開強制再發 QR 的話,那一瞬間所有人
    (包含管理員自己)都登不進來。
    """
    with TestClient(app) as client:
        monkeypatch.setattr(auth.config, "MFA_REQUIRED", False)
        ok = client.post("/api/login", json={"username": account, "password": PASSWORD})
        assert ok.status_code == 200 and "token" in ok.json()

        monkeypatch.setattr(auth.config, "MFA_REQUIRED", True)
        blocked = client.post("/api/login", json={"username": account, "password": PASSWORD})
        assert blocked.status_code == 403
        assert "管理員" in blocked.json()["detail"]
        assert "token" not in blocked.json()


def test_blocked_login_does_not_leave_a_usable_token(account, monkeypatch):
    """被強制模式擋下來的人,手上不能留著一張能用的 token。

    路由是「驗過密碼 → 判斷要不要第二道 → 才發 token」,所以正常情況下
    根本不會有多餘的 token 被產生。這一條守的是**那個結構** —— 改成
    「不論如何先發、走不到最後再收回」的話,每個岔路都必須記得收,
    漏掉任何一個,被擋下來的人手上就留著一張合法憑證。
    """
    # ⚠️ 旗標要在 `TestClient(app)` **起來之後**才打開:開機防呆會擋下
    # 「強制開著、但管理員還沒綁」的啟動(見 main.init_database),
    # 在外面就 patch 的話,連服務都起不來,而失敗訊息完全不像這條在測的事。
    with TestClient(app) as client:
        monkeypatch.setattr(auth.config, "MFA_REQUIRED", True)
        before = set(auth._tokens)
        client.post("/api/login", json={"username": account, "password": PASSWORD})
        assert set(auth._tokens) == before, "被擋下來的登入還是留了一張 token 在伺服器上"


def test_admin_issues_and_list_shows_it(account):
    """管理員按「產生 QR code」,清單那一欄要跟著變。"""
    with TestClient(app) as client:
        admin = {"Authorization": f"Bearer {auth._issue(auth.config.ADMIN_USERNAME)}"}

        issued = client.post(f"/api/users/{account}/mfa", headers=admin)
        assert issued.status_code == 200
        assert issued.json()["otpauth_uri"].startswith("otpauth://totp/")
        assert mfa.is_enabled(account) is True

        # 帳號清單要標出「發過了沒」,不然管理員不知道還有誰沒發
        listed = client.get("/api/users", headers=admin).json()
        assert next(u for u in listed if u["username"] == account)["mfa_enabled"] is True


def test_admin_can_issue_to_himself(account):
    """**管理員自己也要發得到,而且要在網頁上發得到。**

    他不在 `users` 表裡,所以 `/api/users` 那份清單沒有他 —— 帳號管理頁上
    也就沒有他那一列。少了 `/api/admin-account` 這一支,權限最大的帳號永遠
    發不到 QR,而那會讓 `MFA_REQUIRED` 根本開不起來(他自己會被自己擋在門外)。
    """
    admin_name = auth.config.ADMIN_USERNAME
    with TestClient(app) as client:
        admin = {"Authorization": f"Bearer {auth._issue(admin_name)}"}
        try:
            before = client.get("/api/admin-account", headers=admin).json()
            # 只比在意的那兩個欄位,不要整份比對 —— 這一支的欄位會增加,
            # 整份比對會在完全無關的改動上壞掉。
            assert before["username"] == admin_name
            assert before["mfa_enabled"] is False

            assert client.post(f"/api/users/{admin_name}/mfa", headers=admin).status_code == 200
            after = client.get("/api/admin-account", headers=admin).json()
            assert after["mfa_enabled"] is True, "管理員發給自己之後,狀態沒有變"
        finally:
            # 一定要收乾淨:留著的話下一條測試的管理員登入會被要求輸入六碼
            mfa.revoke(admin_name)


def test_admin_account_is_admin_only(account):
    """一般帳號看不到管理員那一筆。"""
    with TestClient(app) as client:
        me = {"Authorization": f"Bearer {auth._issue(account)}"}
        assert client.get("/api/admin-account", headers=me).status_code == 403


def test_only_admins_can_issue(account):
    """一般帳號不能幫自己(或別人)產生 QR —— 那等於自助繞過管理員。"""
    with TestClient(app) as client:
        me = {"Authorization": f"Bearer {auth._issue(account)}"}
        assert client.post(f"/api/users/{account}/mfa", headers=me).status_code == 403


def test_login_lockout_counts_the_second_factor(account, monkeypatch):
    """**驗證碼打錯也要記進帳號鎖定的次數。**

    分開記的話,第二關就是一個不限次數的猜測入口 —— 六位數只有一百萬種組合,
    而走到這裡的人手上已經有正確的密碼了。
    """
    monkeypatch.setattr(auth.config, "LOGIN_MAX_ATTEMPTS", 3)
    mfa.issue(account)
    with TestClient(app) as client:
        challenge = client.post(
            "/api/login", json={"username": account, "password": PASSWORD}
        ).json()["mfa_token"]
        codes = ["000000", "111111", "222222", "333333"]
        statuses = [
            client.post("/api/login/mfa", json={"mfa_token": challenge, "code": c}).status_code
            for c in codes
        ]
    assert 429 in statuses, f"驗證碼連錯 {len(codes)} 次都沒有被鎖:{statuses}"


# ------------------------------------------------- 「關掉瀏覽器就重新登入」的後盾

def test_idle_tokens_die_on_the_server(monkeypatch):
    """閒置超過上限的 token 要在伺服器上失效。

    **為什麼需要伺服器這一道**:前端那一半(token 存 sessionStorage、cookie 是
    session cookie)全都在瀏覽器那一側,而瀏覽器的「回復上次工作階段」
    (Ctrl+Shift+T)會把兩者一起帶回來 —— 於是「關掉瀏覽器就要重新登入」
    這個要求會默默不成立,而且畫面上看不出來。

    關著的瀏覽器不送請求,計時器就不會被推後,所以這一條擋得住。
    """
    monkeypatch.setattr(auth.config, "AUTH_IDLE_TIMEOUT_SEC", 60)
    token = auth._issue("idler")
    assert auth.username_for(token) == "idler"

    # 把「最後一次用到」往回撥兩分鐘 —— 等同「瀏覽器關了兩分鐘」
    username, expires_at, _ = auth._tokens[token]
    auth._tokens[token] = (username, expires_at, time.time() - 120)
    assert auth.username_for(token) is None
    assert token not in auth._tokens, "過期的 token 沒有被清掉,會一直佔著記憶體"


def test_active_use_keeps_the_token_alive(monkeypatch):
    """一直在用就不該被踢。網頁本身每 8 秒就在輪詢,所以分頁開著就算在用。"""
    monkeypatch.setattr(auth.config, "AUTH_IDLE_TIMEOUT_SEC", 60)
    token = auth._issue("worker")
    for _ in range(3):
        assert auth.username_for(token) == "worker"


def test_idle_timeout_does_not_extend_the_absolute_deadline(monkeypatch):
    """推後的是閒置計時,**不是絕對到期時間** —— 一直用也不會變成永久登入。"""
    monkeypatch.setattr(auth.config, "AUTH_IDLE_TIMEOUT_SEC", 60)
    token = auth._issue("longtimer")
    username, _, last_seen = auth._tokens[token]
    auth._tokens[token] = (username, time.time() - 1, last_seen)
    assert auth.username_for(token) is None

def test_refuses_to_boot_when_enforced_but_admin_unbound(monkeypatch):
    """強制開著、管理員自己卻還沒綁 —— **寧可起不來。**

    那個狀態沒有任何出路:所有人登入都被 403 擋掉,而唯一能發 QR code 的人
    就是管理員。服務起來反而更糟 —— 大家會一個一個試、把帳號鎖掉,
    然後才有人想到要看 .env。在啟動時當場失敗、把該做的事寫在訊息裡,
    是唯一能讓人在三十秒內解決的做法。
    """
    from app.main import init_database

    monkeypatch.setattr(auth.config, "MFA_REQUIRED", True)
    admin_name = auth.config.ADMIN_USERNAME
    was_bound = mfa.is_enabled(admin_name)
    if was_bound:
        mfa.revoke(admin_name)
    try:
        with pytest.raises(RuntimeError) as exc:
            init_database()
        # 訊息要講出「怎麼救」,不然看到它的人只會知道壞了
        assert "MFA_REQUIRED" in str(exc.value)
        assert "QR code" in str(exc.value)
    finally:
        if was_bound:
            mfa.issue(admin_name)


def test_boots_when_enforced_and_admin_is_bound(monkeypatch):
    """管理員綁好了就照常啟動 —— 這條防呆不能把正常的部署也擋掉。"""
    from app.main import init_database

    monkeypatch.setattr(auth.config, "MFA_REQUIRED", True)
    admin_name = auth.config.ADMIN_USERNAME
    was_bound = mfa.is_enabled(admin_name)
    mfa.issue(admin_name)
    try:
        init_database()  # 不該丟例外
    finally:
        if not was_bound:
            mfa.revoke(admin_name)


def test_second_factor_failures_do_not_touch_the_ip_layer(account, monkeypatch):
    """**驗證碼打錯只記帳號層,不能記 IP 層。**

    部署在 nginx 後面而 `TRUST_PROXY_HEADER` 沒開時,`client_ip` 對
    所有人回傳同一個位址,而 IP 層是 10 次就**永久封鎖**。六位數打錯是常態
    (時鐘偏移、看到上一組碼),記進去的話所有人加起來十次就一起鎖死,
    連管理員都進不去解 —— 一個不需要任何攻擊者就會自己發生的故障。
    """
    from app import ratelimit

    monkeypatch.setattr(ratelimit.config, "LOGIN_MAX_ATTEMPTS", 5)
    # ⚠️ **計數器是模組層的狀態,而且以帳號名當 key。** 同一檔前面那條
    # 「連錯會被鎖」的測試用的是同一個帳號名,不清的話這裡會先撞到鎖定,
    # 走的是 `record_blocked_attempt`(那一條**本來就會**動 IP 層)——
    # 於是這條斷言失敗,而失敗的原因跟它要測的事完全無關。
    # 症狀是「單獨跑會過、整檔跑會掛」。
    ratelimit._accounts.clear()
    ratelimit._ips.clear()

    secret = mfa.issue(account)["secret"]
    ip_before = dict(ratelimit._ips)

    with TestClient(app) as client:
        challenge = client.post(
            "/api/login", json={"username": account, "password": PASSWORD}
        ).json()["mfa_token"]
        for _ in range(3):
            client.post("/api/login/mfa", json={"mfa_token": challenge, "code": "000000"})

    assert dict(ratelimit._ips) == ip_before, "驗證碼打錯被記進了 IP 層 —— 所有人會一起被永久封鎖"
    # 帳號層還是要記,不然第二關就是一個不限次數的猜測入口
    assert ratelimit.check(account.lower(), "1.2.3.4") >= 0
    assert secret  # 用掉變數,避免 linter 抱怨


# ---------------------------------------------------------------- 公司 IP 免第二關

COMPANY_IP = "203.0.113.77"


@pytest.fixture()
def company_network(monkeypatch):
    """讓測試能假裝「這次登入來自公司的對外 IP」。

    ⚠️ 走的是 `LOGIN_IP_ALLOWLIST` 那一份名單(不是另外一個設定),見 config 的說明。
    """
    monkeypatch.setattr(config, "LOGIN_IP_ALLOWLIST", COMPANY_IP)
    # client_ip 只有在這個旗標開著時才看 X-Forwarded-For(見 ratelimit.client_ip)
    monkeypatch.setattr(config, "TRUST_PROXY_HEADER", True)
    # 前面幾條測試會在計數器裡留下失敗紀錄,而它們以帳號名當 key
    ratelimit._accounts.clear()
    ratelimit._ips.clear()


def _login_from(client, ip, username=USERNAME, password=PASSWORD):
    return client.post(
        "/api/login",
        json={"username": username, "password": password},
        headers={"X-Forwarded-For": ip},
    )


def test_company_ip_skips_the_second_factor(account, company_network, monkeypatch):
    """**功能本身**:在公司網路登入可以免第二關。

    在公司的 IP 上,綁了 MFA 的人直接拿到 token —— 但**稽核一定要留下那一列**,
    不然事後查不出這次登入少過了一關。
    """
    monkeypatch.setattr(config, "MFA_SKIP_ON_TRUSTED_IP", True)
    mfa.issue(account)

    with TestClient(app) as client:
        resp = _login_from(client, COMPANY_IP)

    assert resp.status_code == 200, resp.text
    assert "token" in resp.json()
    assert resp.json().get("mfa_required") is not True

    db = SessionLocal()
    try:
        events = [
            row.event
            for row in db.query(models.AuditLog)
            .filter(models.AuditLog.actor == USERNAME)
            .order_by(models.AuditLog.id.desc())
            .limit(5)
        ]
    finally:
        db.close()
    assert "login_mfa_skipped_ip" in events, "跳過第二關卻沒有留下紀錄"


def test_other_ips_still_need_the_code(account, company_network, monkeypatch):
    """**同一個開關,換個來源就不算數。** 這是「免驗」沒有外溢的證明。"""
    monkeypatch.setattr(config, "MFA_SKIP_ON_TRUSTED_IP", True)
    mfa.issue(account)

    with TestClient(app) as client:
        body = _login_from(client, "8.8.8.8").json()

    assert body.get("mfa_required") is True
    assert "token" not in body


def test_switch_is_off_by_default(account, company_network):
    """**預設關著。** 沒有人明確在 .env 開它之前,公司的 IP 照樣要輸入六碼。

    conftest 把環境變數設成 0,所以這裡讀到的就是真正的預設行為。
    """
    assert config.MFA_SKIP_ON_TRUSTED_IP is False
    mfa.issue(account)

    with TestClient(app) as client:
        body = _login_from(client, COMPANY_IP).json()

    assert body.get("mfa_required") is True
    assert "token" not in body


def test_company_ip_also_passes_the_enforced_mode(account, company_network, monkeypatch):
    """強制模式下,**還沒發過 QR code 的人在公司也要進得來**。

    ⚠️ 這一條守的是「兩處都看同一個旗標」:只改了 `mfa.is_enabled` 那一處的話,
    這裡會回 403,而畫面上的訊息是「請找管理員產生 QR code」—— 沒有人會想到
    那是免驗漏了一半。
    """
    monkeypatch.setattr(config, "MFA_SKIP_ON_TRUSTED_IP", True)
    assert mfa.is_enabled(account) is False

    with TestClient(app) as client:
        # ⚠️ 旗標要在 `TestClient(app)` **起來之後**才打開:開機防呆會擋下
        # 「MFA_REQUIRED 開著、但管理員自己還沒綁」那個狀態(見 main.init_database)。
        monkeypatch.setattr(config, "MFA_REQUIRED", True)
        resp = _login_from(client, COMPANY_IP)
        # 對照組:同一個沒綁的帳號,從別的地方進來照樣被擋
        blocked = _login_from(client, "8.8.8.8")

    assert resp.status_code == 200 and "token" in resp.json()
    assert blocked.status_code == 403
