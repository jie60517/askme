import hmac
import secrets
import time
from typing import Optional

from fastapi import Cookie, Header, HTTPException, Response

from . import config, users

#: token -> (使用者名稱, 絕對到期時間, 最後一次被用到的時間)。存在記憶體就夠,
#: 服務重啟後大家重新登入。
#:
#: 使用者名稱同時也是對話的擁有者(qa_records.owner),所以這個表不只是
#: 「有沒有登入」,而是「你是誰」—— 拿掉會直接影響誰看得到誰的對話。
#: 第三個欄位是閒置逾時用的,見 `username_for`。
_tokens: dict[str, tuple[str, float, float]] = {}

#: 密碼過了、驗證碼還沒過的**中間狀態**。challenge -> (使用者名稱, 到期時間)。
#:
#: ⚠️ **一定要跟 `_tokens` 分成兩張表。** 同一張表的話,只過了第一關的人手上
#: 那串字就是一張合法的 token —— 他直接拿去打 /api/conversations 就進去了,
#: 第二道關卡等於不存在。分開之後,這裡的字串**只有 `redeem_challenge` 認得**,
#: 其他每一支依賴注入(require_user 等)查的都是 `_tokens`,一律 401。
_pending: dict[str, tuple[str, float]] = {}


def verify_password(username: str, password: str) -> bool:
    """這組帳密對不對。**不發 token,只回答對錯。**

    ⚠️ **這裡刻意不提供「驗完順便發 token」的函式。** 路由的順序是「驗過 →
    看要不要第二道 → 才發」;一支「驗過就直接發 token」的函式會**跳過整個 MFA
    判斷**,照著呼叫就是靜默地把第二道關卡繞過去。要發 token 請用 `issue_token`,
    而呼叫它之前要自己確定 MFA 那一關已經處理過了。

    ⚠️ **管理員與一般帳號是兩條路**,而這是唯一一份:管理員的密碼在 .env、
    不在 `users` 表,`users.verify` 對他一律回 False。抄成兩份會出現
    「管理員綁了 MFA 之後永遠停用不了」這一類的洞 —— 而那種洞只有管理員
    本人會踩到,平常測不出來。**每一條要問「這組帳密對不對」的路徑都走這一支**,
    不要在別處自己寫一份。
    """
    if config.admin_password_is_usable() and hmac.compare_digest(
        username.strip().lower().encode("utf-8"),
        config.ADMIN_USERNAME.lower().encode("utf-8"),
    ) and hmac.compare_digest(
        password.encode("utf-8"), config.ADMIN_PASSWORD.encode("utf-8")
    ):
        return True

    return users.verify(username, password)


def canonical_username(username: str) -> str:
    """使用者打的帳號 → 這個系統認定的那個寫法(大小寫)。對不到就原樣回傳。

    給登入回應用:回他打的字的話,前端存的身分會跟後端認定的不一致,
    而那個字串會被拿去比對「這則是不是我發的」(對話串的左右分邊)。
    """
    name = username.strip()
    if name.lower() == config.ADMIN_USERNAME.lower():
        return config.ADMIN_USERNAME
    return users.resolve(name) or name


def issue_token(username: str) -> str:
    """發一張登入 token 給這個**已經驗過身分**的帳號。

    ⚠️ 呼叫端要自己確定該發 —— 這一支不驗任何東西。路由層的規矩是
    「密碼過了、而且不需要第二道(或第二道也過了)」才走到這裡。
    """
    return _issue(username)


def _issue(username: str) -> str:
    now = time.time()
    token = secrets.token_urlsafe(32)
    _tokens[token] = (username, now + config.AUTH_TOKEN_TTL_SEC, now)
    return token


# ------------------------------------------------------------- MFA 的中間憑證

def begin_challenge(username: str) -> str:
    """密碼過了,發一張只能用來換 token 的短命憑證。

    順手把過期的清掉:這張表的量很小(同時在登入的人),但沒有人清的話,
    一個持續被撞的帳號會讓它無限長大 —— 那是一條不需要任何憑證就能觸發的
    記憶體成長路徑。
    """
    now = time.time()
    for key in [k for k, (_, exp) in _pending.items() if exp < now]:
        _pending.pop(key, None)

    challenge = secrets.token_urlsafe(32)
    _pending[challenge] = (username, now + config.MFA_CHALLENGE_TTL_SEC)
    return challenge


def challenge_user(challenge: str) -> Optional[str]:
    """這張中間憑證是誰的。過期或不存在回 None。**不會消耗掉它。**"""
    entry = _pending.get(challenge)
    if entry is None:
        return None
    username, expires_at = entry
    if expires_at < time.time():
        _pending.pop(challenge, None)
        return None
    return username


def redeem_challenge(challenge: str) -> Optional[str]:
    """把中間憑證換成真正的 token(**一次性,換完就作廢**)。

    驗證碼已經在呼叫端驗過了 —— 這一支只負責「換」。
    """
    username = challenge_user(challenge)
    if username is None:
        return None
    _pending.pop(challenge, None)
    return _issue(username)


def logout(authorization: str) -> None:
    _tokens.pop(bearer_token(authorization), None)


def bearer_token(authorization: str) -> str:
    """`Authorization: Bearer xxx` 裡的那串。"""
    return authorization.removeprefix("Bearer ").strip()


# ------------------------------------------------------- 檔案下載/縮圖用的 cookie
#
# **為什麼非得多一條 cookie。** 下載是 `<a href>`、縮圖是 `<img src>`,這兩種
# 標籤沒辦法帶 `Authorization` 標頭。而不擋登入、只靠「session_id 是 uuid4,
# 猜不到」是站不住的:網址會被複製、貼進聊天室、留在瀏覽器紀錄與 nginx log 裡
# —— 那不是權限,只是隱晦。
#
# cookie 是瀏覽器**會自己帶上**的憑證,所以這兩種標籤擋得住:
#   HttpOnly   JS 讀不到(token 本身走 sessionStorage + 標頭那條路)
#   SameSite=Lax  別的網站用 fetch/img 打過來時不帶;但「使用者自己點的
#                 頂層導覽」會帶 —— 下載正是靠這個成立的
#   Path=/api  前端的靜態資源不必收到它
#
# ⚠️ 它跟 Authorization 是**同一個 token**,不是第二種身分。作廢一邊等於
# 作廢另一邊(`revoke_all_for` 動的是同一張表),不會出現「登出了但 cookie
# 還能下載」。
SESSION_COOKIE = "t100_session"


def set_session_cookie(response: Response, token: str, secure: bool) -> None:
    """下載/縮圖用的 cookie。**沒有 max_age —— 這是一個 session cookie。**

    ⚠️ **不要加 max_age。** 「關掉瀏覽器就要重新登入」是刻意的行為,
    前端那一半是 token 存在 sessionStorage(見 frontend/src/lib/auth.ts)。
    兩半必須一致:

      這裡加了 max_age 的話,瀏覽器關掉再開,分頁那側已經沒有 token(要重新
      登入),cookie 卻還活著 —— 也就是「畫面上是登出狀態,但檔案下載那三條
      路徑照樣通」。那是最難發現的一種權限殘留,因為畫面完全看不出來。

    伺服器端的壽命不受影響:token 本身仍然在 `_tokens` 裡帶著到期時間
    (`AUTH_TOKEN_TTL_SEC`),cookie 只是決定瀏覽器願意帶它多久。
    """
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/api",
    )


def clear_session_cookie(response: Response) -> None:
    # path 要跟設的時候一模一樣,不然刪不掉(瀏覽器當成另一個 cookie)
    response.delete_cookie(SESSION_COOKIE, path="/api")


def username_for(token: str) -> Optional[str]:
    """token → 使用者。過期、閒置過久、或不存在都回 None(順手把它清掉)。

    **呼叫一次就算一次活動**(推後閒置計時),所以它同時是「這張 token 還活著嗎」
    的唯一判斷 —— 除了下面那幾支依賴注入,`terminal.py` 的 token 看門狗也問這一支
    (理由見它自己的說明,以及下面「⚠️ 長連線」那段)。

    **閒置逾時是「關掉瀏覽器就要重新登入」的伺服器端後盾。**

    前端把 token 存 sessionStorage、cookie 也是 session cookie,所以正常情況下
    關掉瀏覽器它就沒了。但那全都在瀏覽器那一側 —— 瀏覽器的「回復上次工作階段」
    (Ctrl+Shift+T、或設定成開機還原分頁)會把 sessionStorage 與 session cookie
    一起帶回來,於是那張 token 又活了,而伺服器這邊本來完全不知情。

    閒置逾時補的就是這一段:瀏覽器關著的時候沒有任何請求,計時器不會被推後,
    過了 `AUTH_IDLE_TIMEOUT_SEC` 這張 token 就死在伺服器上,救回來也沒用。

    ⚠️ **推後的是閒置計時,不是絕對到期時間。** `AUTH_TOKEN_TTL_SEC` 那個上限
    是登入當下就定死的 —— 一直在用也不會變成永久登入。

    ⚠️ **長連線(SSH 終端機)每 30 秒問一次,那也算活動 —— 是刻意的。**
    這個逾時要抓的是「瀏覽器關掉之後被『回復上次工作階段』救回來的 token」,
    而一條還活著的 WebSocket 正好證明那件事沒有發生:瀏覽器真的關掉的話,
    連線當場就斷了,也就不會再有人來問。所以「終端機開著」等同「人還在」,
    撐住這張 token 是對的;真正的上限仍然是 `AUTH_TOKEN_TTL_SEC`,它一到,
    看門狗就會把那條終端機一起收掉。
    """
    entry = _tokens.get(token)
    if entry is None:
        return None
    username, expires_at, last_seen = entry
    now = time.time()
    if expires_at < now:
        _tokens.pop(token, None)
        return None
    if config.AUTH_IDLE_TIMEOUT_SEC and now - last_seen > config.AUTH_IDLE_TIMEOUT_SEC:
        _tokens.pop(token, None)
        return None
    _tokens[token] = (username, expires_at, now)
    return username


def is_admin(username: Optional[str]) -> bool:
    # 不分大小寫:token 裡的身分已經正規化過,但這個函式也會拿到別處來的字串
    return bool(username) and username.strip().lower() == config.ADMIN_USERNAME.lower()


def display_name(username: Optional[str]) -> Optional[str]:
    if username is None:
        return None
    return username if is_admin(username) else users.display_name(username)


def allowed_tools_for(username: str) -> str:
    """這個帳號問問題時,claude 拿得到哪些工具。

    管理員與資料庫 `users.tools = "full"` 的帳號拿完整工具組(含 Bash),
    其他人唯讀。**判斷一律用登入身分,不能讓前端指定** —— 那等於把權限交給
    請求方自己填。

    沒對上任何放寬條件就落到最後一行的唯讀組 —— 預設值該是「最少權限」而不是「全開」。
    """
    if is_admin(username) or users.is_power_user(username):
        return config.ALLOWED_TOOLS_FULL
    return config.ALLOWED_TOOLS


def writable_dirs_for(username: Optional[str]) -> list[str]:
    """這個帳號問問題時,額外掛進 --add-dir 的可寫目錄。

    只有 full 帳號(管理員 + tools:full)拿得到 —— 用途是讓他們把整理好的流程
    累積回 flows/。唯讀帳號回空清單,而且他們也沒有全域 Write 工具,雙重擋住。

    跟 allowed_tools_for 一樣,判斷一律用登入身分,不能讓前端指定。
    """
    if username and (is_admin(username) or users.is_power_user(username)):
        return config.CLAUDE_FULL_EXTRA_DIRS
    return []


def can_use_terminal(username: Optional[str]) -> bool:
    """這個帳號能不能開側邊欄的 SSH 終端機(`/ssh`)。

    跟 Bash 權限**同一個來源**:管理員,或職稱帶完整權限的帳號(`users.is_power_user`,
    由 `users.role_grants_full` 推導)。不另開一套 —— 兩套遲早不一致,而不一致的那一面
    是「畫面上看不到那一列、直接打網址卻連得進去」。

    停用的帳號一律 False(他本來就登不進來,這裡是第二道)。
    **只看身分,不看功能開沒開**:功能開關是 `config.ssh_terminal_available()`,
    呼叫端兩個都要問 —— 側邊欄那一列顯不顯示、WebSocket 讓不讓連,讀同一組答案。
    判斷本身在 `terminal_denial`,要講原因的呼叫端直接問那一支。
    """
    return terminal_denial(username) is None


def terminal_denial(username: Optional[str]) -> Optional[str]:
    """`can_use_terminal` 為什麼不行:可以回 None,不行回一個短的原因
    (「不存在」「已停用」「沒有終端機權限」),由呼叫端接在帳號名後面。"""
    if is_admin(username):
        return None
    entry = users.get(username) if username else None
    if not entry:
        return "不存在"
    if entry.get("disabled"):
        return "已停用"
    if not users.is_power_user(username):
        return "沒有終端機權限"
    return None


def revoke_all_for(username: str, keep_token: str = "") -> None:
    """把這個人其他地方的登入全部作廢(改密碼時用)。

    不做的話,改密碼等於白改:舊密碼外洩後別人早就登入的那個分頁,
    token 還會繼續有效到過期為止,照樣看得到他的對話。
    """
    for token in [t for t, (u, *_) in _tokens.items() if u == username and t != keep_token]:
        _tokens.pop(token, None)


# ------------------------------------------------------------------ 依賴注入
#
# 幾種不同的需求,不要混用:
#   require_admin —— 用量統計、安全、帳號管理。沒登入或不是管理員就 401/403。
#   require_user  —— 問答與對話清單。沒登入 401;還在用預設密碼 403。
#   require_any_user —— 只要求登入,允許預設密碼。**只給「還沒改掉預設密碼的人
#                    也必須到得了」的路徑用**,目前是改密碼本身,以及純顯示偏好
#                    (主題、字級、頭像;都在 routers/auth.py)——
#                    改密碼:不放行的話還在用預設密碼的人連改密碼那條路都被
#                      自己擋住,死結。
#                    顯示偏好:被擋在強制改密碼畫面的人也該能切深色、把字調大。
#                      它們不讀也不寫任何業務資料,放行沒有換到任何東西。
#                    不符合這條規則的端點一律不該用它。
#   require_user_file —— **只給 <a href> / <img src> 直接指過去的檔案路徑用**
#                    (/api/files、/api/uploads、/api/preview,另有終端機下載與筆記圖片,
#                    見 require_user_file)。規則跟 require_user 一模一樣,差別只在
#                    **它也收 cookie** —— 那兩種標籤帶不了 Authorization 標頭
#                    (見下面 SESSION_COOKIE)。清單就這幾條(全是唯讀 GET),
#                    不要再擴充:其他端點都是 axios 打的、標頭帶得動,改用它
#                    只會白白多接受一種瀏覽器會自動附上的憑證。
#   current_user  —— **只給 /api/me 用**。沒登入回 None 而不是報錯,前端才有辦法
#                    問出「我現在到底有沒有登入」來決定要不要顯示登入頁。
#
# ⚠️ 新增讀得到 QARecord 的路徑時,一律掛 require_user。掛成 current_user 的話
# 那條路徑就對匿名開放了 —— 對一個對外可及的站台,那是最大的一種破口。

# 還在用預設密碼時,require_user / require_user_file 回 403 帶的 detail。
# 前端不比對這個字串:它看 /api/me 的 `password_is_default`(frontend/src/App.tsx),
# 是 true 就只渲染 pages/ForcePasswordChange.tsx,其他頁面不掛載、也就不會打到這些端點。
# 這個字串是給直接打 API 的呼叫端看的原因。
PASSWORD_CHANGE_REQUIRED = "password_change_required"


def _logged_in(token: str) -> str:
    """token → 使用者,無效就 401。四支依賴共用的第一段。"""
    username = username_for(token)
    if username is None:
        raise HTTPException(status_code=401, detail="請先登入")
    return username


def _password_changed(username: str) -> str:
    """已經改掉預設密碼才放行。`require_user` 與 `require_user_file` 共用的第二段。

    ⚠️ 這段**只能有一份**:它是「這個 token 背後是不是本人」的判斷
    (理由見 require_user),抄成兩份的話兩邊會漂,而漂掉的那一邊不會有人發現。
    """
    if not is_admin(username) and users.is_default_password(username):
        # 403 而不是 401:他確實登入了,token 也是有效的。回 401 的話前端會把
        # token 清掉、把人踢回登入頁,他重新登入又是同一組預設密碼,無限迴圈。
        raise HTTPException(status_code=403, detail=PASSWORD_CHANGE_REQUIRED)
    return username


def require_any_user(authorization: str = Header(default="")) -> str:
    """只要求登入,不管密碼是不是預設值。

    只有「還沒改掉預設密碼的人也必須到得了」的路徑該用這個(見上面依賴注入那段)。
    其他地方用了就等於把強制改密碼整個繞過去。
    """
    return _logged_in(bearer_token(authorization))


def require_user(authorization: str = Header(default="")) -> str:
    """必須登入,而且必須已經改掉預設密碼。

    為什麼連「讀自己的對話」都要擋:預設密碼是所有帳號同一組,而且那串字就寫在
    專案的設定範本裡。在他改掉之前,任何知道那組密碼的人都能用他的帳號登入 ——
    也就是說,這個 token 背後是不是本人,系統其實不知道。

    管理員不在此限:他的密碼在 .env,不走 /api/password(改密碼那條路會拒絕他),
    擋下去他就完全進不來了。管理員的預設密碼要靠改 .env 解決,不是靠這裡。
    """
    return _password_changed(require_any_user(authorization))


def require_user_file(
    authorization: str = Header(default=""),
    session: str = Cookie(default="", alias=SESSION_COOKIE),
) -> str:
    """跟 `require_user` 同一條規則,但**多收 cookie 這條路**。

    只給 `<a href>` / `<img src>` 直接指過去的路徑用(`/api/files`、
    `/api/uploads`、`/api/preview`,以及 `/api/terminal/files/download`
    —— 終端機檔案欄的下載也是 `<a download>`,而且還要 session_id 對得上;
    `/api/notebook/images/{id}` —— 個人筆記裡的 `<img>`)—— 那些標籤
    帶不了 `Authorization` 標頭,見上面 SESSION_COOKIE 那段。

    ⚠️ **不要拿它去掛別的端點。** 其他路徑都是 axios 打的、標頭帶得動,
    改用這一支只會讓它們白白多接受一種來源(而 cookie 是瀏覽器會自動附上的,
    正是 CSRF 的載體 —— 這幾條是唯讀 GET 才付得起這個代價)。
    """
    return _password_changed(
        _logged_in(bearer_token(authorization) or session.strip())
    )


def require_admin(authorization: str = Header(default="")) -> str:
    username = _logged_in(bearer_token(authorization))
    if not is_admin(username):
        # 403 而不是 401:他確實登入了,只是這一頁不給看。
        # 回 401 的話前端會把 token 清掉、把人踢回登入頁,他會以為自己密碼打錯。
        raise HTTPException(status_code=403, detail="這個頁面只有管理員能看")
    return username


def current_user(authorization: str = Header(default="")) -> Optional[str]:
    """目前的使用者,沒登入回 None(不是錯誤)。

    **只有 /api/me 該用這個。** 其他地方要的是 require_user ——
    「沒登入」對問答與對話清單來說不再是合法狀態。
    """
    return username_for(bearer_token(authorization))
