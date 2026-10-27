# -*- coding: utf-8 -*-
"""兩個掛在路由之前的 ASGI 中介層:請求本文大小上限、回應安全標頭。

**為什麼是 ASGI 中介層而不是 FastAPI 的 Depends**:FastAPI 對帶 `Form`/`File` 的端點
是**先把整個 body 解析完(multipart 的檔案 spool 到 /tmp)再跑 Depends**,也就是
`require_user` 排在讀 body 之後。匿名者送幾 GB 過來,授權那一步永遠跑不到,
/tmp 已經滿了。要在 body 被讀之前擋,只能站在 ASGI 那一層。

nginx 的 `client_max_body_size` 是第一道(見 deploy/nginx.conf.example),
這裡是第二道 —— 有人在內網直連 8100、或改了 nginx 設定時,後端自己還擋得住。
"""
import base64
import hashlib
import logging
import time
from pathlib import Path
from typing import Iterable, Optional

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

#: 413 的回應本文:{"detail":"請求太大"}(UTF-8 逸出,免得原始碼的編碼被人動到)
_TOO_LARGE_BODY = b'{"detail":"\xe8\xab\x8b\xe6\xb1\x82\xe5\xa4\xaa\xe5\xa4\xa7"}'


class BodySizeLimit:
    """超過上限的請求直接 413,**不讀 body**。

    兩個上限:
      - `max_bytes`:帶著**有效**憑證(登入 token、session cookie)的請求,
        上傳檔案走這裡。
      - `anon_max_bytes`:沒有憑證、或憑證是假的。匿名的合法請求只有 `/api/login`
        這類幾百 bytes 的 JSON,64 KB 綽綽有餘。

    ⚠️ 憑證要**真的驗**,不能只看標頭有沒有帶:只看有沒有帶的話,匿名者加一行
    `Authorization: Bearer x` 就拿到大的上限,這道閘等於沒有。驗的方式跟路由那側
    一樣是查記憶體裡的 token 表(auth._tokens),成本是一次 dict 查詢。

    有 Content-Length 就看它;沒有(chunked)就邊收邊數,超過就中斷。
    """

    def __init__(self, app: ASGIApp, max_bytes: int, anon_max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.anon_max_bytes = anon_max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return

        limit = self.max_bytes if _has_valid_credential(scope) else self.anon_max_bytes
        if limit <= 0:
            await self.app(scope, receive, send)
            return

        declared: Optional[int] = None
        for name, value in scope.get("headers", ()):
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = None
        if declared is not None and declared > limit:
            await _reject_too_large(send, started=False)
            return

        received = 0
        response_started = False

        async def counting_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _TooLarge()
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except _TooLarge:
            await _reject_too_large(send, started=response_started)


class _TooLarge(Exception):
    pass


def _has_valid_credential(scope: Scope) -> bool:
    """這個請求帶的憑證是不是真的。查的是路由那側同一份 token 表。"""
    from . import auth  # 延遲 import:auth 拉進 users / database,不要在 import 這個模組時就載

    bearer = ""
    cookie = ""
    for name, value in scope.get("headers", ()):
        if name == b"authorization":
            bearer = value.decode("latin-1")
        elif name == b"cookie":
            cookie = value.decode("latin-1")

    now = time.time()
    token = auth.bearer_token(bearer) if bearer else ""
    if token and _token_alive(auth, token, now):
        return True
    if cookie:
        for part in cookie.split(";"):
            key, _, val = part.strip().partition("=")
            if key == auth.SESSION_COOKIE and _token_alive(auth, val.strip(), now):
                return True
    return False


def _token_alive(auth, token: str, now: float) -> bool:
    entry = auth._tokens.get(token)
    return bool(entry) and entry[1] > now


async def _reject_too_large(send: Send, started: bool) -> None:
    if started:
        # 下游已經開始回應(邊串流邊讀 body)才發現超量:第二個 response.start 不合法,
        # 只能斷線。留一筆 log,不然這種請求看起來像網路問題。
        logger.warning("請求本文超過上限,但回應已開始,只能中斷連線")
        return
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_TOO_LARGE_BODY)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": _TOO_LARGE_BODY})


class SecurityHeaders:
    """每個回應都帶的瀏覽器端防線。

    - `Strict-Transport-Security`:只在這條連線是 https 時才送(http 上送了會被
      瀏覽器忽略,而且本機開發是 http)。這裡看的是 `scope["scheme"]`,那是 uvicorn
      填的 —— 它只在**來源位址落在 `FORWARDED_ALLOW_IPS`** 時才照 `X-Forwarded-Proto`
      改寫。所以兩個條件缺一不可:nginx 要送那個標頭(deploy/nginx.conf.example),
      而且 .env 的 `FORWARDED_ALLOW_IPS` 要填 nginx 真正連進來的位址(nginx 跑在
      docker 容器裡的話,來源是容器網段,不是 127.0.0.1)。少了後者,標頭有送也會被丟掉,
      症狀是 CSP 有、HSTS 沒有。
      ⚠️ 刻意**不**自己讀 `X-Forwarded-Proto`:「代理標頭能不能信」只該有一份判斷,
      就是 uvicorn 那份;`ratelimit.is_https` 在 `TRUST_PROXY_HEADER` 開著時會自己讀,
      那是給「uvicorn 前面還有一層它認不出來的代理」用的,一般部署不該開。
    - `Content-Security-Policy`:`script-src` 只放 self 加上 index.html 那兩段 inline
      script 的 hash —— hash 是**啟動時從 dist/index.html 算出來的**,前端改了那段
      不用來這裡同步。找不到 dist(本機只跑後端)就不送 CSP。
      `style-src` 放 `'unsafe-inline'`:StyleX / framer-motion 會寫 inline style,
      而 XSS 真正要擋的是 script,不是 style。`img-src data: blob:` 給頭像與縮圖。
    - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`:登入頁與帳號管理頁
      不准被**別的網站**用 iframe 嵌進去(clickjacking)。
    - `Referrer-Policy: same-origin`:答案裡的外部圖片連結不會把本站網址帶出去。

    ⚠️ **每一條路由都一樣,沒有例外。** 上面那兩樣對「被自己的頁面嵌起來」沒有影響:
    同源的 iframe 兩種檢查都會過。PDF 預覽會白掉是
    iframe 的 `sandbox` 屬性造成的,那件事在 `FileLightbox.tsx` 那側處理 ——
    不要回頭在這裡替某些路徑開例外。
    """

    def __init__(self, app: ASGIApp, index_html: Optional[Path]) -> None:
        self.app = app
        self.csp = _build_csp(index_html)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(
                    [
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"same-origin"),
                        (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    ]
                )
                headers.append((b"x-frame-options", b"SAMEORIGIN"))
                if self.csp:
                    headers.append((b"content-security-policy", self.csp))
                if scope.get("scheme") == "https":
                    headers.append(
                        (b"strict-transport-security", b"max-age=31536000; includeSubDomains")
                    )
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


def inline_script_hashes(index_html: Path) -> list[str]:
    """dist/index.html 裡每一段 inline `<script>` 的 CSP hash(`'sha256-…'`)。

    用字串切,不用 HTML parser:index.html 是 vite 產的、我們自己寫的兩段 script,
    形狀固定。script 內容裡出現 `</script>` 字串的話瀏覽器自己也會在那裡截斷,
    所以這裡跟著截是對的。
    """
    try:
        html = index_html.read_text(encoding="utf-8")
    except OSError:
        return []
    hashes: list[str] = []
    for chunk in html.split("<script")[1:]:
        head, _, rest = chunk.partition(">")
        if "src=" in head:
            continue
        body, _, _ = rest.partition("</script>")
        digest = hashlib.sha256(body.encode("utf-8")).digest()
        hashes.append("'sha256-" + base64.b64encode(digest).decode("ascii") + "'")
    return hashes


def _build_csp(index_html: Optional[Path]) -> Optional[bytes]:
    if index_html is None or not index_html.is_file():
        return None
    script_src = " ".join(["'self'", *inline_script_hashes(index_html)])
    directives: Iterable[str] = (
        "default-src 'self'",
        f"script-src {script_src}",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    )
    return "; ".join(directives).encode("ascii")
