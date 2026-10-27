from typing import Union

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from .. import audit, auth, config, geo_allow, geoip, mfa, ratelimit, schemas, users, workflows

MIN_PASSWORD_LEN = 6

router = APIRouter(prefix="/api", tags=["auth"])


def _lockout_message(seconds: int) -> str:
    if seconds == ratelimit.PERMANENT:
        # 永久封鎖(IP 層)。用英文,語氣像防火牆/系統層級的拒絕。
        return "Access denied. Your connection has been blocked due to repeated failed login attempts. Contact the administrator to restore access."
    minutes = (seconds + 59) // 60
    return f"嘗試次數過多,請在 {minutes} 分鐘後再試"


def _signed_in(name: str, response: Response, request: Request, token: str) -> schemas.LoginResponse:
    """發完 token 之後的共同收尾。登入的兩條路(單因子、MFA 換發)共用。

    抄成兩份的話,加一個回傳欄位或改 cookie 行為只會有一條路跟著改,
    而漏掉的那一條是「有開 MFA 的人」—— 也就是最不容易在開發時踩到的那條。
    """
    # 同一個 token 再走一次 cookie。給 <a href> 下載與 <img src> 縮圖用 ——
    # 那兩種標籤帶不了 Authorization 標頭(見 auth.SESSION_COOKIE)。
    #
    # ⚠️ 沒有 https 時**不能硬標 Secure**:使用者在內網直連 `http://…:8100`,
    # 標了的話瀏覽器根本不會收下這個 cookie,縮圖與下載會全部 401。
    auth.set_session_cookie(response, token, secure=ratelimit.is_https(request))

    return schemas.LoginResponse(
        token=token,
        username=name,
        display_name=auth.display_name(name),
        is_admin=auth.is_admin(name),
        theme=users.get_theme(name),
    )


@router.post(
    "/login",
    response_model=Union[schemas.LoginResponse, schemas.LoginChallengeResponse],
)
def login(req: schemas.LoginRequest, request: Request, response: Response):
    ip = ratelimit.client_ip(request)

    # ⚠️ **鎖定要用小寫當 key。** 帳號登入不分大小寫(見 auth.verify_password),而計數器
    # 若照使用者打的字分開記,`ming`/`Ming`/`MING` 各有各的額度 —— 同一個帳號
    # 猜幾次就換一種寫法,帳號層的鎖等於不存在。
    attempt_key = req.username.strip().lower()

    # 先擋再驗。反過來的話,被鎖定期間送進來的密碼還是會被比對一次 ——
    # 攻擊者照樣能用「回應時間」判斷猜得對不對,鎖了等於沒鎖。
    wait = ratelimit.check(attempt_key, ip)
    if wait:
        # 被擋下來的這一次也要算進 IP 那層。少了這行,對同一個帳號猛撞就變成
        # 完全免費的:5 次之後帳號鎖了,後面每一次都在這裡回絕、走不到下面的
        # record_failure,IP 計數永遠停在 5 —— 撞五十次也不會被封鎖。
        ratelimit.record_blocked_attempt(ip)
        audit.record("login_blocked", actor=req.username, ip=ip)

        # Retry-After 只在真的「等一下就好」時給。永久封鎖時 wait 是 -1,
        # 送出去會變成一個不合法的標頭值,而且語意也錯 —— 那不是等得到的。
        headers = {"Retry-After": str(wait)} if wait > 0 else None
        raise HTTPException(
            status_code=429,
            detail=_lockout_message(wait),
            headers=headers,
        )

    # 地理封鎖:非台灣的來源一律不給登入。政策與判定在 `app/geoip.py`,預設關閉。
    #
    # ⚠️ **擺在驗密碼之前**,理由跟上面那段鎖定一樣:驗了才擋的話,境外來的人
    # 還是能從回應時間判斷密碼對不對 —— 擋等於沒擋。擺在前面還有兩個好處:
    # 不必為必定被擋的請求去跑一次密碼雜湊,而且這個錯誤**完全不透露帳號存不存在**
    # (這時候根本還沒查)。
    #
    # ⚠️ 訊息說的是「來源」不是「國家」:講明是地區封鎖等於告訴對方「換一台
    # 台灣的跳板就好」;但也不能回「帳號或密碼錯誤」—— 出差在外的使用者會以為自己
    # 記錯密碼,一直重試到把帳號撞鎖。這句話兩邊都不踩。
    if config.GEO_BLOCK_ENABLED:
        allowed, why = geoip.is_allowed(geoip.default_ranges(), ip)
        if not allowed:
            # 出差用的例外清單。它存在資料庫、由安全頁增刪,所以這裡是**現查**的 ——
            # 不用重啟,按下新增的那一秒生效。
            #
            # ⚠️ **查在 dry-run 判斷之前。** 反過來的話,試跑模式會把白名單裡的人
            # 也記成 `login_geo_dryrun`,而那份紀錄的用途正是「數一數真的開下去會誤擋到誰」
            # —— 把已經開好門的人算進去,那個數字就沒有意義了。
            hit = geo_allow.match(ip)
            if hit:
                # 放行,但**一定要留下一列**:這是「有人從境外進來了」的唯一紀錄,
                # 而白名單是人開的,開了忘記關才是這個功能真正的風險。
                audit.record("login_geo_allowlisted", actor=req.username, ip=ip, detail=hit)
            elif config.GEO_BLOCK_DRY_RUN:
                # 試跑模式:照記不擋。正式開之前用它跑幾天,看稽核裡會誤擋到誰。
                audit.record("login_geo_dryrun", actor=req.username, ip=ip, detail=why)
            else:
                # ⚠️ **不要在這裡呼叫 `ratelimit.record_blocked_attempt(ip)`。**
                # 理由跟同一個檔案裡 MFA 那段寫的一樣:來源 IP 可能是所有人共用的
                # (見 ratelimit.record_second_factor_failure),而 IP 那層是**永久封鎖**。
                # 而且它剛好會在這個功能最怕的情境上點火:`FORWARDED_ALLOW_IPS`
                # 設錯 → 全員判不出國別 → 這裡擋下 → 順手把那個共用 IP 撞成永久封鎖。
                # 那時候 `GEO_BLOCK_MODE=off` 重啟已經救不回來,還要有人去 /security 解鎖。
                # 擋境外靠的是這道判定本身,不需要再借鎖定計數器的力。
                audit.record("login_blocked_geo", actor=req.username, ip=ip, detail=why)
                raise HTTPException(status_code=403, detail="這個連線來源不允許登入,請聯絡管理員。")

    # ⚠️ **只驗密碼,先不要發 token。** 「先發、走不到最後再收回」的寫法,每一條
    # 被擋下的岔路都必須記得收 —— 漏掉任何一個,被擋下來的人手上就留著一張合法憑證。
    # 驗過再發,那種漏法在結構上不可能發生。
    if not auth.verify_password(req.username, req.password):
        ratelimit.record_failure(attempt_key, ip)
        audit.record("login_failed", actor=req.username, ip=ip)
        # 錯誤訊息不區分「沒這個帳號」與「密碼錯」—— 分開講等於送對方一份
        # 有效帳號清單,他就可以只對存在的帳號花力氣。
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")

    # 之後一律用**系統認定的那個寫法**,不是他打進來的字:帳號名同時是資料的
    # 擁有者,兩邊不一致的話他會登入成功卻看不到自己的對話(見 auth.canonical_username)。
    name = auth.canonical_username(req.username)

    # 公司網路免第二關。信任的來源就是 `LOGIN_IP_ALLOWLIST`,
    # 預設關閉,要在 .env 明確開 `MFA_SKIP_ON_TRUSTED_IP=1`;代價寫在 config 那一條。
    #
    # ⚠️ **兩處都要看這個旗標**(下面的 `mfa.is_enabled` 與 `config.MFA_REQUIRED`)。
    # 只改第一處的話,等哪天全面強制 MFA,在公司、還沒發過 QR code 的人會被第二處
    # 擋在外面 —— 而畫面上的訊息會叫他去找管理員,沒有人會想到那是「免驗」漏了一半。
    trusted_ip = config.MFA_SKIP_ON_TRUSTED_IP and ratelimit.is_allowlisted(ip)
    mfa_bound = mfa.is_enabled(name)

    if trusted_ip and (mfa_bound or config.MFA_REQUIRED):
        # 跳過了就一定要留紀錄。少了這一列,稽核上「登入成功」不分有沒有過第二關,
        # 而那正是事後追查(密碼外洩、離職員工)最想知道的一件事。
        audit.record("login_mfa_skipped_ip", actor=name, ip=ip)

    if mfa_bound and not trusted_ip:
        # ⚠️ **這一筆要記,但安全頁預設不顯示**(過濾做在 `routers/audit.py`)。
        #
        # 不記的話,「密碼對了、停在第二關沒往下走」會是零紀錄,而那正是
        # 「密碼已經外洩、只剩 MFA 在擋」的唯一訊號 —— 撞庫的人對稽核就隱形了。
        # 證據留在資料庫,畫面上一次登入只看到一列,兩件事不衝突。
        audit.record("login_mfa_challenged", actor=name, ip=ip)
        # ⚠️ 這裡**不算登入成功**,所以不呼叫 record_success —— 呼叫的話,
        # 猜密碼的人只要密碼對了就能把鎖定計數器清掉,然後慢慢猜第二關。
        return schemas.LoginChallengeResponse(mfa_token=auth.begin_challenge(name), username=name)

    if config.MFA_REQUIRED and not trusted_ip:
        # 強制模式:還沒被管理員發過 QR code 的人一律進不來,密碼對也一樣。
        audit.record("login_no_mfa_binding", actor=name, ip=ip)
        raise HTTPException(
            status_code=403,
            detail="這個帳號還沒有設定手機驗證碼,請找管理員幫你產生 QR code。",
        )

    # 沒綁、也沒強制 —— 只用密碼登入
    token = auth.issue_token(name)
    ratelimit.record_success(attempt_key, ip)
    audit.record("login_success", actor=name, ip=ip)

    return _signed_in(name, response, request, token)


@router.post("/login/mfa", response_model=schemas.LoginResponse)
def login_mfa(req: schemas.MFAVerifyRequest, request: Request, response: Response):
    """登入第二關:拿中間憑證 + 驗證碼換真正的 token。

    ⚠️ **打錯要記進帳號層的鎖定計數器**,跟 /api/login 共用同一個 key。
    不記的話,第二關就是一個不限次數的猜測入口 —— 6 位數只有一百萬種組合,
    而走到這裡的人手上已經有正確的密碼了。

    ⚠️ **但不記 IP 層**,理由見 `ratelimit.record_second_factor_failure`:
    來源 IP 可能是所有人共用的,而那一層是永久封鎖。
    """
    ip = ratelimit.client_ip(request)

    username = auth.challenge_user(req.mfa_token)
    if username is None:
        # 過期或偽造。**不記錯誤次數** —— 這裡沒有任何祕密被猜(憑證是 256 bit
        # 隨機值),而且合法使用者慢一步就會撞到,不該因此被鎖。
        raise HTTPException(status_code=401, detail="這次登入已經逾時,請重新輸入帳號密碼")

    attempt_key = username.strip().lower()
    wait = ratelimit.check(attempt_key, ip)
    if wait:
        ratelimit.record_blocked_attempt(ip)
        audit.record("login_blocked", actor=username, ip=ip)
        headers = {"Retry-After": str(wait)} if wait > 0 else None
        raise HTTPException(status_code=429, detail=_lockout_message(wait), headers=headers)

    if not mfa.verify_code(username, req.code):
        # ⚠️ **只記帳號層。** 六位數打錯是常態,而 nginx 後面的來源 IP
        # 可能是所有人共用的,記進 IP 層等於大家一起被永久鎖死 ——
        # 理由完整寫在 ratelimit.record_second_factor_failure。
        ratelimit.record_second_factor_failure(attempt_key)
        audit.record("login_mfa_failed", actor=username, ip=ip)
        raise HTTPException(status_code=401, detail="驗證碼不正確,請看手機上最新的那一組")

    token = auth.redeem_challenge(req.mfa_token)
    if token is None:
        # 驗證碼對了、憑證卻剛好在這一瞬間過期。極罕見,但回 500 會讓使用者
        # 以為系統壞了 —— 講清楚該做什麼。
        raise HTTPException(status_code=401, detail="這次登入已經逾時,請重新輸入帳號密碼")

    ratelimit.record_success(attempt_key, ip)
    audit.record("login_success", actor=username, ip=ip)

    return _signed_in(username, response, request, token)


@router.get("/me", response_model=schemas.MeResponse)
def me(request: Request, response: Response, authorization: str = Header(default="")):
    """目前登入的身分。**這一條刻意不擋沒登入的人** —— 回 username=null,
    前端據此決定要不要顯示登入頁(擋了的話登入頁自己也會 401,繞不出來)。

    前端每次載入都要問一次:token 存在 sessionStorage,但它可能已經過期
    (服務重啟就全部失效)。不問的話,畫面會顯示「已登入 alice」,
    而實際上每一個動作都會被打回。

    **順便把下載用的 cookie 補上。** 這條每次開站都會被呼叫,所以在新分頁裡
    接手了 token 的人(見前端 auth.ts 的跨分頁交接)不必重新登入,
    縮圖與下載直接就是通的。

    ⚠️ 補發**不會延長登入**:那是一個 session cookie(沒有 max_age),
    瀏覽器關掉就沒了,而 token 的到期時間是登入當下就定死的(`auth._issue`)。
    想做成「一直在用就一直不登出」是另一件事,要動的是 `_tokens` 的到期時間,
    不是這裡。

    身分**不走 `Depends(auth.current_user)`**,直接拿標頭問一次 —— 兩種寫法
    讀的是同一個標頭,掛 Depends 只會讓同一個憑證在簽名裡出現兩次。
    """
    username = auth.current_user(authorization)
    if username is not None:
        auth.set_session_cookie(
            response, auth.bearer_token(authorization), secure=ratelimit.is_https(request)
        )

    prefs = users.get_prefs(username)
    can_terminal = config.ssh_terminal_available() and auth.can_use_terminal(username)
    return schemas.MeResponse(
        username=username,
        display_name=auth.display_name(username),
        is_admin=auth.is_admin(username),
        password_is_default=bool(username) and users.is_default_password(username),
        theme=prefs["theme"],
        avatar=prefs["avatar"],
        font_scale=prefs["font_scale"],
        contrast=prefs["contrast"],
        preferred_model=prefs["preferred_model"],
        companion=prefs["companion"],
        companion_shape=prefs["companion_shape"],
        companion_color=prefs["companion_color"],
        can_terminal=can_terminal,
        ssh_mode="full" if can_terminal else "",
        can_notebook=config.NOTEBOOK_ENABLED,
        workflow_enabled=workflows.available(),
    )


@router.put("/me/prefs", status_code=204)
def set_display_prefs(
    req: schemas.DisplayPrefsRequest,
    username: str = Depends(auth.require_any_user),
):
    """記下字級、對比、常用模型與吉祥物。

    跟主題同一條路:`require_any_user` 而不是 `require_user` —— 被擋在強制改密碼
    畫面的人也該能把字調大。這個設定不碰任何資料,放行沒有風險。

    ⚠️ 寫失敗**不往上丟**,跟 set_theme 同一個理由:這是顯示偏好,
    而使用者當下那一頁已經是對的了(前端先套本機再送這裡)。
    """
    # 具名傳:參數已經七個,照位置傳的話再加一項就容易排錯位置
    users.set_display_prefs(
        username,
        font_scale=req.font_scale,
        contrast=req.contrast,
        preferred_model=req.preferred_model,
        companion=req.companion,
        companion_shape=req.companion_shape,
        companion_color=req.companion_color,
    )


@router.put("/me/avatar", status_code=204)
def set_avatar(
    req: schemas.AvatarRequest,
    username: str = Depends(auth.require_any_user),
):
    """換頭像。空的 = 拿掉,回到名字縮寫。

    ⚠️ 這一條**要把失敗講出來**(跟主題/字級不同):使用者剛挑了一張圖,
    默默不存會讓他以為換好了,下次登入才發現沒有。失敗多半是圖太大
    (`users.MAX_AVATAR_CHARS`)或不是圖片,兩種都該當場講。
    """
    if not users.set_avatar(username, req.avatar):
        raise HTTPException(
            status_code=400,
            detail="頭像存不進去。請確認是圖片,而且換一張小一點的。",
        )


@router.put("/me/theme", status_code=204)
def set_theme(
    req: schemas.ThemeRequest,
    username: str = Depends(auth.require_any_user),
):
    """記下這個人的深色/淺色偏好,讓他換一台電腦也是同一個樣子。

    瀏覽器那邊本來就有 localStorage(而且是在 JS 載入前就套上,避免閃一下白底),
    這裡存的是**跟著人走**的那一份:換電腦、或共用電腦時,localStorage 記到的
    會是這台機器上一個人的選擇。

    用 require_any_user 而不是 require_user —— 還在用預設密碼、被擋在強制改密碼
    畫面的人,也該能把畫面切成深色。這個設定不碰任何資料,放行沒有風險。
    """
    users.set_theme(username, req.theme)


@router.post("/password", status_code=204)
def change_password(
    req: schemas.ChangePasswordRequest,
    request: Request,
    authorization: str = Header(default=""),
    username: str = Depends(auth.require_any_user),
):
    """自己改自己的密碼。管理員的密碼在 .env,不走這裡。

    ⚠️ 這條**故意**用 require_any_user 而不是 require_user:還在用預設密碼的人
    被擋在其他 API 之外,如果連這條也擋,他就沒有任何辦法把密碼改掉了。
    """
    if auth.is_admin(username):
        raise HTTPException(status_code=400, detail="管理員密碼請改 .env 的 ADMIN_PASSWORD")

    # 跟登入共用帳號層的計數:不記的話,拿到一張 token 的人(借用沒鎖的電腦、
    # 偷到的 cookie)可以在這裡無限次猜目前的密碼,而且稽核紀錄一筆都沒有。
    # 先擋再驗,理由同 login。⚠️ 只記帳號層、不碰 IP 層,理由同 MFA 第二關(record_second_factor_failure):
    # 走到這裡的人已經登入了,不是在掃帳號;來源 IP 可能是所有人共用的,IP 層是永久封鎖。
    ip = ratelimit.client_ip(request)
    attempt_key = username.strip().lower()
    wait = ratelimit.check(attempt_key, ip)
    if wait:
        audit.record("password_change_blocked", actor=username, ip=ip)
        headers = {"Retry-After": str(wait)} if wait > 0 else None
        raise HTTPException(status_code=429, detail=_lockout_message(wait), headers=headers)

    # 一定要驗舊密碼:不驗的話,借用別人沒鎖的電腦就能把他的密碼改掉,
    # 從此把他鎖在自己的對話外面
    if not users.verify(username, req.current_password):
        ratelimit.record_second_factor_failure(attempt_key)
        audit.record("password_change_failed", actor=username, ip=ip)
        raise HTTPException(status_code=400, detail="目前的密碼不正確")

    new_password = req.new_password
    if len(new_password) < MIN_PASSWORD_LEN:
        raise HTTPException(status_code=400, detail=f"新密碼至少要 {MIN_PASSWORD_LEN} 個字")
    if new_password == req.current_password:
        raise HTTPException(status_code=400, detail="新密碼跟目前的密碼一樣")
    # 擋掉「改成預設密碼」—— 那組所有人都知道,改了等於沒改
    if config.DEFAULT_USER_PASSWORD and new_password == config.DEFAULT_USER_PASSWORD:
        raise HTTPException(status_code=400, detail="不能用預設密碼,請換一組只有你知道的")

    if not users.set_password(username, new_password):
        raise HTTPException(status_code=500, detail="密碼沒有存成功,請再試一次或聯絡管理者")

    audit.record("password_changed", actor=username, ip=ip)

    # 其他地方的登入一起踢掉,只留目前這個分頁
    auth.revoke_all_for(username, keep_token=authorization.removeprefix("Bearer ").strip())


@router.post("/logout", status_code=204)
def logout(response: Response, authorization: str = Header(default="")):
    auth.logout(authorization)
    # token 已經作廢,cookie 留著也沒用 —— 但要主動刪掉,不然瀏覽器會一直
    # 附一串失效的字串上來,而稽核與除錯時那看起來像「有人拿舊 token 在試」。
    auth.clear_session_cookie(response)
