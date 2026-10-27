# -*- coding: utf-8 -*-
"""SSH 終端機的端點:一條 WebSocket(終端機本體)+ 四支 HTTP(檔案欄)。

橋接、閒置、SFTP 全在 `app/terminal.py`;這裡只做兩件事:
把 Starlette 的 WebSocket 包成 `terminal.Transport`,以及 HTTP 端點的參數 / 權限 / 回應。

**權限有三道,每一道都在後端**:
  1. 登入:WebSocket 的第一個訊息帶 token(瀏覽器開 WebSocket 帶不了 Authorization 標頭);
     HTTP 端點照常 `Depends(auth.require_user)`,下載那一支走 cookie(理由寫在它上面)。
  2. 身分:`auth.can_use_terminal()` —— 工程師或管理員。其他職稱直接連會拿到 4403 + 一筆稽核。
  3. session:檔案 API 要帶 `session_id`,而且要是**這個人**目前那一條;不是就 409。

⚠️ 前兩道**不是只在握手那一刻驗**:連上之後由 `terminal.run_session` 的 `token_watch`
每 `terminal.TOKEN_CHECK_SEC` 秒重問一次,登出 / 停用 / 職稱降級會把已經開著的 shell 收掉(4401);
改密碼收掉的是**其他分頁**開著的那幾條(`revoke_all_for` 刻意留著呼叫者自己那張 token)。
"""
from __future__ import annotations

import asyncio
import json
import logging
import posixpath
from typing import List, Tuple, Union
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile, WebSocket
from fastapi.responses import StreamingResponse
from starlette.websockets import WebSocketDisconnect, WebSocketState

from .. import audit, auth, config, ratelimit, terminal, terminal_ai

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/terminal", tags=["terminal"])

# nosniff 由 security.SecurityHeaders 統一加,這裡只補「不要快取」。
# ⚠️ 名字講的是**這組標頭做什麼**,不是誰在用 —— 下載與 /ask 的 ndjson 串流
# 都掛它,用「檔案」命名的時候串流那邊看起來像掛錯了。
_NO_STORE_HEADERS = {"Cache-Control": "private, no-store"}


class _WS:
    """Starlette WebSocket → terminal.Transport。"""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws

    async def send_text(self, text: str) -> None:
        if self.ws.client_state != WebSocketState.CONNECTED:
            raise terminal.Disconnected()
        await self.ws.send_text(text)

    async def send_bytes(self, data: bytes) -> None:
        if self.ws.client_state != WebSocketState.CONNECTED:
            raise terminal.Disconnected()
        await self.ws.send_bytes(data)

    async def receive(self) -> Tuple[str, Union[str, bytes]]:
        try:
            msg = await self.ws.receive()
        except (WebSocketDisconnect, RuntimeError) as exc:
            raise terminal.Disconnected() from exc
        if msg.get("type") == "websocket.disconnect":
            raise terminal.Disconnected()
        data = msg.get("bytes")
        if data is not None:
            return "bytes", data
        return "text", msg.get("text") or ""

    async def close(self, code: int, reason: str = "") -> None:
        if self.ws.client_state == WebSocketState.CONNECTED:
            await self.ws.close(code=code, reason=reason)


async def _reject(ws: WebSocket, code: int, message: str) -> None:
    """先送一則 closed(讓前端有中文可顯示、也有關閉碼可對照),再用關閉碼關掉。"""
    try:
        await ws.send_text(terminal.closed_payload("error", message, code))
    except Exception:  # noqa: BLE001
        pass
    try:
        await ws.close(code=code, reason=message[:120])
    except Exception:  # noqa: BLE001
        pass


@router.websocket("/ws")
async def terminal_ws(ws: WebSocket) -> None:
    await ws.accept()
    ip = ratelimit.client_ip(ws)

    if not terminal.origin_ok(ws.headers.get("origin"), ws.headers.get("host")):
        await _reject(ws, terminal.CLOSE_FORBIDDEN, "來源不符")
        return

    # 第一個訊息一定要是 auth,而且要在 AUTH_TIMEOUT_SEC 內到。在這之前**不碰 SSH**。
    try:
        raw = await asyncio.wait_for(ws.receive_text(), terminal.AUTH_TIMEOUT_SEC)
        msg = json.loads(raw)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError, RuntimeError):
        await _reject(ws, terminal.CLOSE_UNAUTHENTICATED, "沒有登入")
        return
    if not isinstance(msg, dict) or msg.get("type") != "auth":
        await _reject(ws, terminal.CLOSE_UNAUTHENTICATED, "沒有登入")
        return
    # ⚠️ 這串要**留下來**跟著 session 走(`open_session(token=…)`):`token_watch` 靠它
    # 每 30 秒問一次「這個人還登入著嗎」,少了它,登出 / 停用 / 改密碼收不掉已經開著的 shell。
    token = str(msg.get("token") or "").strip()
    try:
        username = auth.require_user(f"Bearer {token}")
    except HTTPException:
        await _reject(ws, terminal.CLOSE_UNAUTHENTICATED, "沒有登入,或登入已過期")
        return

    if not config.ssh_terminal_available():
        await _reject(ws, terminal.CLOSE_DISABLED, "SSH 終端機沒有開啟")
        return
    # 工程師 / 管理員才連得進來;其他人直接連會拿到 4403 + 一筆稽核
    if not auth.can_use_terminal(username):
        audit.record("terminal_denied", actor=username, ip=ip)
        await _reject(ws, terminal.CLOSE_FORBIDDEN, "這個功能沒有開放給你")
        return

    try:
        cols = int(msg.get("cols") or 0)
        rows = int(msg.get("rows") or 0)
    except (TypeError, ValueError):
        cols, rows = 0, 0
    # 要連哪一台(主機清單上點的那一台)。**只收 id**,位址與憑證永遠是伺服器這邊的事;
    # 不認得的 id 由 open_session 擋掉,不會默默連到別台。沒給的話走清單上的第一台。
    host_id = str(msg.get("host") or "")[:64]
    try:
        session = await terminal.open_session(
            username, ip, cols or 120, rows or 30, host_id=host_id, token=token,
        )
    except terminal.TerminalError as exc:
        # 連不上要留痕:憑證設錯、sshd 掛了,管理員在 /security 就看得到,
        # 不用翻 journal。訊息本身不含憑證(terminal.open_session 保證)。
        logger.warning("終端機連線失敗(%s):%s", username, exc.message)
        audit.record("terminal_connect_failed", actor=username, ip=ip, detail=exc.message)
        await _reject(ws, exc.code, exc.message)
        return

    await terminal.run_session(session, _WS(ws))


# ------------------------------------------------------------------ 主機清單
@router.get("/hosts")
async def list_hosts(viewer: str = Depends(auth.require_user)):
    """主機清單上有哪幾台(進 /ssh 先選主機才連)。

    ⚠️ 回的是 `config.public_terminal_hosts()` —— **只有 id / 名字 / 副標 / 經過誰**。
    位址、帳號、憑證一個都不出去:主機卡片只需要畫得出來,連到哪是伺服器決定的。
    """
    if not auth.can_use_terminal(viewer):
        raise HTTPException(status_code=403, detail="這個功能沒有開放給你")
    if not config.ssh_terminal_available():
        # 功能沒開就回空的,讓前端顯示「沒有可以連的主機」,而不是畫一張點不了的圖
        return {"hosts": []}
    return {"hosts": config.public_terminal_hosts()}


# ------------------------------------------------------------------ 檔案欄
def _require_session(session_id: str, viewer: str) -> terminal.Session:
    if not auth.can_use_terminal(viewer):
        raise HTTPException(status_code=403, detail="這個功能只開放給工程師")
    s = terminal.get_session(session_id, viewer)
    if s is None:
        raise HTTPException(status_code=409, detail="終端機沒有連線,請重新連線")
    return s


def _http_error(exc: terminal.TerminalError) -> HTTPException:
    code = exc.code if 400 <= exc.code < 600 else 502
    return HTTPException(status_code=code, detail=exc.message)


@router.get("/files")
async def list_files(
    session_id: str,
    path: str = "~",
    viewer: str = Depends(auth.require_user),
):
    s = _require_session(session_id, viewer)
    try:
        return await terminal.list_dir(s, path)
    except terminal.TerminalError as exc:
        raise _http_error(exc) from exc


@router.post("/files/upload")
async def upload_files(
    session_id: str,
    path: str = "~",
    overwrite: int = Query(default=0),
    files: List[UploadFile] = File(default=[]),
    viewer: str = Depends(auth.require_user),
):
    """multipart 多檔。同名而且 `overwrite=0` → 409,`detail.exists` 是撞名的清單,
    前端問過使用者再帶 `overwrite=1` 送一次。**大小上限走 BodySizeLimit**(MAX_REQUEST_MB),
    到不了這裡就被 413 掉;前端拿 status 訊息裡的 `max_upload_mb` 在送出前先擋。"""
    s = _require_session(session_id, viewer)
    if not files:
        raise HTTPException(status_code=400, detail="沒有檔案")
    try:
        dir_path = terminal.resolve_path(s, path)
        names = []
        for f in files:
            name = posixpath.basename((f.filename or "").replace("\\", "/")).strip()
            if not name or name in (".", "..") or "\x00" in name:
                raise HTTPException(status_code=400, detail="檔名不合法")
            names.append(name)
        if not overwrite:
            clashes = [n for n in names if await terminal.exists(s, posixpath.join(dir_path, n))]
            if clashes:
                raise HTTPException(status_code=409, detail={"exists": clashes})
        done = []
        for f, name in zip(files, names):
            size = await terminal.upload(s, dir_path, name, lambda f=f: f.read(terminal.CHUNK))
            done.append({"name": name, "size": size})
    except terminal.TerminalError as exc:
        raise _http_error(exc) from exc
    return {"path": dir_path, "uploaded": done}


@router.get("/files/download")
async def download_file(
    session_id: str,
    path: str,
    # 下載是 `<a download>` 直接指過來的(大檔不該先整個讀進瀏覽器記憶體),帶不了 Authorization
    # 標頭 —— 跟 /api/files 一樣走 cookie 那條路(auth.require_user_file 的說明有列這一條)。
    # 唯讀 GET,而且還要 session_id 對得上目前這個人的連線。
    viewer: str = Depends(auth.require_user_file),
):
    s = _require_session(session_id, viewer)
    try:
        full, size, body = await terminal.download(s, path)
    except terminal.TerminalError as exc:
        raise _http_error(exc) from exc
    name = posixpath.basename(full) or "download"
    ascii_name = name.encode("ascii", "replace").decode("ascii").replace('"', "_")
    headers = {
        **_NO_STORE_HEADERS,
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}",
        "Content-Length": str(size),
    }
    return StreamingResponse(body, media_type="application/octet-stream", headers=headers)


@router.delete("/files")
async def delete_file(
    session_id: str,
    path: str,
    viewer: str = Depends(auth.require_user),
):
    s = _require_session(session_id, viewer)
    try:
        full = await terminal.delete(s, path)
    except terminal.TerminalError as exc:
        raise _http_error(exc) from exc
    return {"deleted": full}


# ------------------------------------------------------------------ AskME
@router.post("/ask")
async def terminal_ask(
    session_id: str = Body(..., embed=True),
    question: str = Body(..., embed=True),
    context: str = Body(default="", embed=True),
    viewer: str = Depends(auth.require_user),
):
    """問終端機旁邊的助手一句話,回 ndjson 串流(`delta` / `done` / `error`)。

    **它只會講話**:沒有工具、沒有 --add-dir(見 `terminal_ai.py`)。
    要帶 `session_id` 而且要是這個人目前那一條 —— 沒有連線就沒有畫面可以問。
    稽核只記「誰問了一次」,**不記問題與畫面內容**。
    """
    session = _require_session(session_id, viewer)
    if not question.strip():
        raise HTTPException(status_code=400, detail="請先寫一個問題")
    if not terminal_ai.available():
        raise HTTPException(status_code=503, detail="這台主機上沒有設定 claude CLI,AskME 不能用")
    try:
        terminal_ai.take_slot(viewer)
    except terminal_ai.TooMany as exc:
        raise HTTPException(status_code=429, detail=exc.message) from exc
    # 送出的**那一下**是使用者的動作,算活動;**模型吐字不算**(純輸出不算活動,
    # 不然一個長回答就能把閒置計時撐住 120 秒)。
    session.touch()
    audit.record("terminal_ai_ask", actor=viewer, ip=session.ip, detail=session.label)

    async def body():
        try:
            async for event in terminal_ai.ask(question, context):
                yield (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
        finally:
            terminal_ai.release_slot(viewer)

    return StreamingResponse(body(), media_type="application/x-ndjson", headers=_NO_STORE_HEADERS)
