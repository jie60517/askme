# -*- coding: utf-8 -*-
"""SSH 終端機:WebSocket ⇄ SSH 橋接與檔案 API。

整段對著一個**在 pytest 行程內**跑的假 sshd(asyncssh):回音 shell + chroot 到暫存目錄的 SFTP。
Windows 上沒有 sshd、沒有 pty 也跑得起來 —— 真的 sshd 那一段這裡不驗。

假 sshd 跑在自己的執行緒與 event loop 裡:TestClient 在主執行緒同步等訊息,
假 sshd 若也在主執行緒就永遠輪不到它。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_terminal_bridge.py
"""
import asyncio
import json
import logging
import os
import re
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import asyncssh
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import auth, config, models, terminal, terminal_ai, users
from app.database import Base, SessionLocal, engine
from app.main import app

Base.metadata.create_all(bind=engine)

PASSWORD = "fake-sshd-password"
SSH_USER = "deploy"


# ------------------------------------------------------------------ 假 sshd
class _Server(asyncssh.SSHServer):
    def __init__(self, outer: "FakeSSHD") -> None:
        self.outer = outer

    def connection_made(self, conn) -> None:  # noqa: D401
        self.outer.connections += 1

    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        return username == SSH_USER and password == PASSWORD

    def public_key_auth_supported(self) -> bool:
        return True

    def validate_public_key(self, username: str, key) -> bool:
        return username == SSH_USER and key.export_public_key() == self.outer.client_key.export_public_key()


class FakeSSHD:
    """回音 shell:收到什麼吐什麼;`size` 回目前 PTY 尺寸;`exit` 結束。SFTP chroot 在 root。"""

    def __init__(self) -> None:
        self.root = tempfile.mkdtemp(prefix="fake-sftp-")
        self.host_key = asyncssh.generate_private_key("ssh-ed25519")
        self.client_key = asyncssh.generate_private_key("ssh-ed25519")
        self.connections = 0
        self.eofs = 0
        self.term_sizes: list = []
        self.port = 0
        self.loop = asyncio.new_event_loop()

    def start(self) -> None:
        started = threading.Event()
        threading.Thread(target=self._run, args=(started,), daemon=True).start()
        assert started.wait(10), "假 sshd 起不來"

    def _run(self, started: threading.Event) -> None:
        asyncio.set_event_loop(self.loop)
        server = self.loop.run_until_complete(
            asyncssh.listen(
                "127.0.0.1",
                0,
                server_host_keys=[self.host_key],
                server_factory=lambda: _Server(self),
                process_factory=self._shell,
                sftp_factory=lambda chan: asyncssh.SFTPServer(chan, chroot=self.root.encode()),
                encoding=None,
            )
        )
        self.port = server.get_port()
        started.set()
        self.loop.run_forever()

    async def _shell(self, process: asyncssh.SSHServerProcess) -> None:
        if process.command is not None:
            # 單次指令(`conn.run`:偵測 tty 的 ps、收線前結束程式的 sh -c ……):這個假 sshd 沒有真的 shell,
            # 直接結束、沒有輸出 —— 呼叫端都把「沒輸出」當成認不出來,照常往下走。
            # ⚠️ 不能也當成互動 shell 回聲:那會一直等輸入,收線前結束程式那一步要等到逾時
            process.exit(0)
            return
        self.term_sizes.append(tuple(process.term_size[:2]))
        process.stdout.write(b"welcome\r\n")
        try:
            while True:
                try:
                    data = await process.stdin.read(4096)
                except asyncssh.TerminalSizeChanged as exc:
                    # asyncssh 的伺服器端把 window-change 當成 stdin 上的例外送上來
                    #(真的 sshd + bash 是 SIGWINCH)。記下來、繼續讀。
                    self.term_sizes.append((exc.width, exc.height))
                    continue
                if not data:
                    break
                if data.strip() == b"exit":
                    break
                if data.strip() == b"size":
                    w, h = process.term_size[:2]
                    process.stdout.write(f"{w}x{h}".encode())
                    continue
                process.stdout.write(data)
        except (asyncssh.BreakReceived, asyncssh.Error):
            pass
        finally:
            self.eofs += 1
            process.exit(0)

    def known_hosts_line(self) -> str:
        pub = self.host_key.export_public_key().decode().strip()
        return f"[127.0.0.1]:{self.port} {pub}\n"


@pytest.fixture(scope="module")
def sshd() -> FakeSSHD:
    s = FakeSSHD()
    s.start()
    return s


@pytest.fixture
def known_hosts(sshd, tmp_path) -> Path:
    p = tmp_path / "known_hosts"
    p.write_text(sshd.known_hosts_line(), encoding="utf-8")
    return p


@pytest.fixture(autouse=True)
def terminal_env(monkeypatch, sshd, known_hosts):
    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", True)
    monkeypatch.setattr(config, "SSH_TERMINAL_HOST", "127.0.0.1")
    monkeypatch.setattr(config, "SSH_TERMINAL_PORT", sshd.port)
    monkeypatch.setattr(config, "SSH_TERMINAL_USER", SSH_USER)
    monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", PASSWORD)
    monkeypatch.setattr(config, "SSH_TERMINAL_KEY_FILE", "")
    monkeypatch.setattr(config, "SSH_TERMINAL_KNOWN_HOSTS", str(known_hosts))
    monkeypatch.setattr(config, "SSH_TERMINAL_START_DIR", "~")
    monkeypatch.setattr(config, "SSH_TERMINAL_IDLE_TIMEOUT_SEC", 180)
    monkeypatch.setattr(config, "SSH_TERMINAL_CONNECT_TIMEOUT_SEC", 5)


# ------------------------------------------------------------------ 帳號
def _make_user(username: str, role: str, tools) -> None:
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == username).delete()
        db.add(
            models.User(
                username=username,
                password="x",
                display_name=username,
                role=role,
                tools=tools,
                disabled=False,
                password_changed_at=datetime.utcnow(),
            )
        )
        db.commit()
    finally:
        db.close()


@pytest.fixture(scope="module", autouse=True)
def people():
    _make_user("br_eng", users.ROLE_ENGINEER, "full")
    _make_user("br_eng2", users.ROLE_ENGINEER, "full")
    _make_user("br_cons", users.ROLE_CONSULTANT, None)
    yield
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username.like("br_%")).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


@pytest.fixture
def client():
    """⚠️ 一定要 `with`:Starlette 的 TestClient 不進 `with` 的話,**每一條 WebSocket 各自開一個
    event loop**(各自一個 blocking portal)。橋接的 session 登錄是跨連線共用的,
    兩條在不同 loop 上互相 close 會卡死 —— 正式環境的 uvicorn 只有一個 loop,沒有這個問題。"""
    with TestClient(app) as c:
        yield c


def _token(username: str) -> str:
    return auth.issue_token(username)


def _audit_rows(event: str, actor: str) -> list:
    db = SessionLocal()
    try:
        return (
            db.query(models.AuditLog)
            .filter(models.AuditLog.event == event, models.AuditLog.actor == actor)
            .order_by(models.AuditLog.id.desc())
            .all()
        )
    finally:
        db.close()


def _auth_msg(token: str, cols: int = 100, rows: int = 30) -> str:
    return json.dumps({"type": "auth", "token": token, "cols": cols, "rows": rows})


def _expect_close(ws, code: int) -> dict:
    """讀到 closed 訊息與關閉碼。回 closed 訊息。"""
    closed = None
    try:
        while True:
            msg = ws.receive()
            # Starlette 的測試用 session:伺服器主動關會拿到 websocket.close(原始訊息),
            # 不是 websocket.disconnect;兩種都要認,不然會在空佇列上等到天荒地老。
            if msg.get("type") in ("websocket.close", "websocket.disconnect"):
                assert msg.get("code") == code, f"關閉碼 {msg.get('code')},預期 {code}"
                break
            text = msg.get("text")
            if text:
                data = json.loads(text)
                if data.get("type") == "closed":
                    closed = data
    except WebSocketDisconnect as exc:
        assert exc.code == code, f"關閉碼 {exc.code},預期 {code}"
    assert closed is not None, "沒收到 closed 訊息"
    return closed


def _connect(client, token: str, **kw):
    """開 WebSocket、送 auth、讀到 status=connected 與 welcome。回 (ws, status)。"""
    ws = client.websocket_connect("/api/terminal/ws", headers={"origin": "http://testserver"})
    ws.__enter__()
    ws.send_text(_auth_msg(token, **kw))
    status = ws.receive_json()
    assert status["type"] == "status" and status["state"] == "connected", status
    banner = ws.receive_bytes()
    assert b"welcome" in banner
    return ws, status


def _echo_back(ws, expected: bytes, timeout: float = 5.0) -> None:
    """等那個回音回來,**中間的文字訊息一律跳過**。

    ⚠️ 直接 `ws.receive_bytes()` 只有在「下一則一定是回音」時才成立,而這條路上
    隨時可能插進文字訊息:`watch_cwd` 第一次讀到目前目錄會送一則 `{"type":"cwd"}`,
    keepalive 到了會送 `{"type":"ping"}`。它們什麼時候來由遠端與輪詢週期決定,
    跟這裡要驗的事情無關。

    ⚠️ **撞到的時候症狀會騙人**:`receive_bytes()` 拿到文字訊息會炸成
    `KeyError: 'bytes'`,看起來像「連線被關掉了」—— 但連線可能好好的,
    只是前面卡了一則 cwd。所以要驗「連線還活著」就用這一支,它會把真正的原因
    (收到 `closed`、還是根本沒有回音)講出來,而不是丟一個 `KeyError`。
    `receive_bytes()` 會把「被閒置逾時收線」和「文字訊息卡位」這兩種完全不同的
    失敗壓成同一個看不懂的例外。
    """
    end = time.time() + timeout
    while time.time() < end:
        msg = ws.receive()
        if msg.get("type") in ("websocket.close", "websocket.disconnect"):
            raise AssertionError(f"連線被關掉了:{msg}")
        if msg.get("bytes") is not None:
            assert msg["bytes"] == expected, f"回音是 {msg['bytes']!r},預期 {expected!r}"
            return
        data = json.loads(msg["text"])
        assert data.get("type") != "closed", f"不該收到 closed:{data}"
    raise AssertionError(f"等不到回音 {expected!r}")


def _wait(pred, timeout: float = 5.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


# ------------------------------------------------------------------ 登入 / 權限
def test_first_message_must_be_auth(client, sshd):
    before = sshd.connections
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(json.dumps({"type": "resize", "cols": 80, "rows": 24}))
        _expect_close(ws, terminal.CLOSE_UNAUTHENTICATED)
    assert sshd.connections == before, "還沒登入就去連 SSH"


def test_bad_token_is_4401(client, sshd):
    before = sshd.connections
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg("not-a-token"))
        _expect_close(ws, terminal.CLOSE_UNAUTHENTICATED)
    assert sshd.connections == before


def test_consultant_is_4403_and_audited(client, sshd):
    before = sshd.connections
    n = len(_audit_rows("terminal_denied", "br_cons"))
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg(_token("br_cons")))
        _expect_close(ws, terminal.CLOSE_FORBIDDEN)
    assert sshd.connections == before
    assert len(_audit_rows("terminal_denied", "br_cons")) == n + 1


def test_feature_disabled_is_4404(client, monkeypatch):
    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", False)
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg(_token("br_eng")))
        _expect_close(ws, terminal.CLOSE_DISABLED)


def test_origin_mismatch_is_4403(client):
    with client.websocket_connect(
        "/api/terminal/ws", headers={"origin": "http://evil.example"}
    ) as ws:
        _expect_close(ws, terminal.CLOSE_FORBIDDEN)


# ------------------------------------------------------------------ 連線本體
def test_connect_echo_and_cleanup(client, sshd):
    eofs = sshd.eofs
    ws, status = _connect(client, _token("br_eng"))
    try:
        assert status["home"] == "/"  # chroot 之下的家目錄
        assert status["label"] == "主機"  # 沒有 terminal_hosts.json 時那一台(config._terminal_host_from_env)
        assert status["max_upload_mb"] == config.MAX_REQUEST_MB
        ws.send_bytes(b"echo hi\n")
        assert ws.receive_bytes() == b"echo hi\n"
    finally:
        ws.__exit__(None, None, None)
    assert _wait(lambda: sshd.eofs == eofs + 1), "瀏覽器關了,sshd 那頭的 shell 沒收到 EOF"
    # 稽核是在 SSH 連線收完之後才寫的,sshd 那頭的 EOF 會比它早幾毫秒 —— 要等一下
    assert _wait(lambda: any("left_page" in r.detail for r in _audit_rows("terminal_disconnect", "br_eng")))
    assert _audit_rows("terminal_connect", "br_eng")


def test_resize_reaches_the_pty(client, sshd):
    ws, _ = _connect(client, _token("br_eng"), cols=100, rows=30)
    try:
        assert sshd.term_sizes[-1] == (100, 30)
        ws.send_text(json.dumps({"type": "resize", "cols": 132, "rows": 40}))
        # resize 沒有回應,用一個會回尺寸的指令探
        _wait(lambda: False, 0.2)
        ws.send_bytes(b"size")
        msg = ws.receive()
        assert msg.get("bytes") == b"132x40", msg
    finally:
        ws.__exit__(None, None, None)


def test_exit_closes_with_1000(client):
    ws, _ = _connect(client, _token("br_eng"))
    ws.send_bytes(b"exit")
    closed = _expect_close(ws, 1000)
    assert closed["reason"] == "exit"
    ws.__exit__(None, None, None)


def test_wrong_password_is_4502_without_leaking_it(client, monkeypatch):
    monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", "wrong")
    n = len(_audit_rows("terminal_connect_failed", "br_eng"))
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg(_token("br_eng")))
        closed = _expect_close(ws, terminal.CLOSE_UNREACHABLE)
    assert "拒絕登入" in closed["message"]
    assert "wrong" not in closed["message"]
    assert closed["code"] == terminal.CLOSE_UNREACHABLE
    rows = _audit_rows("terminal_connect_failed", "br_eng")
    assert len(rows) == n + 1 and "wrong" not in (rows[0].detail or "")


def test_unreachable_port_is_4502(client, monkeypatch):
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    free_port = s.getsockname()[1]
    s.close()
    monkeypatch.setattr(config, "SSH_TERMINAL_PORT", free_port)
    started = time.time()
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg(_token("br_eng")))
        closed = _expect_close(ws, terminal.CLOSE_UNREACHABLE)
    assert time.time() - started < config.SSH_TERMINAL_CONNECT_TIMEOUT_SEC + 2
    assert "連不上" in closed["message"] or "逾時" in closed["message"]


def test_hostkey_mismatch_and_missing_file_refuse(client, monkeypatch, tmp_path):
    bad = tmp_path / "bad_known_hosts"
    other = asyncssh.generate_private_key("ssh-ed25519").export_public_key().decode().strip()
    bad.write_text(f"[127.0.0.1]:{config.SSH_TERMINAL_PORT} {other}\n", encoding="utf-8")
    monkeypatch.setattr(config, "SSH_TERMINAL_KNOWN_HOSTS", str(bad))
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg(_token("br_eng")))
        closed = _expect_close(ws, terminal.CLOSE_UNREACHABLE)
    assert "主機金鑰不符" in closed["message"]

    monkeypatch.setattr(config, "SSH_TERMINAL_KNOWN_HOSTS", str(tmp_path / "nope"))
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg(_token("br_eng")))
        closed = _expect_close(ws, terminal.CLOSE_UNREACHABLE)
    assert "known_hosts" in closed["message"]


def test_key_auth_works_and_broken_key_refuses(client, sshd, monkeypatch, tmp_path):
    key_file = tmp_path / "askme_terminal"
    key_file.write_bytes(sshd.client_key.export_private_key())
    monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", "")
    monkeypatch.setattr(config, "SSH_TERMINAL_KEY_FILE", str(key_file))
    ws, _ = _connect(client, _token("br_eng"))
    ws.__exit__(None, None, None)

    key_file.write_text("this is not a key", encoding="utf-8")
    with client.websocket_connect("/api/terminal/ws") as ws:
        ws.send_text(_auth_msg(_token("br_eng")))
        closed = _expect_close(ws, terminal.CLOSE_UNREACHABLE)
    assert "金鑰" in closed["message"]


def test_replace_waits_for_the_new_connection_to_succeed(client, monkeypatch):
    """新的連不上時,舊的那一條要還在。"""
    ws1, s1 = _connect(client, _token("br_eng"))
    try:
        monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", "wrong")
        with client.websocket_connect("/api/terminal/ws") as ws2:
            ws2.send_text(_auth_msg(_token("br_eng")))
            _expect_close(ws2, terminal.CLOSE_UNREACHABLE)
        monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", PASSWORD)
        ws1.send_bytes(b"still alive\n")
        assert ws1.receive_bytes() == b"still alive\n"
        assert terminal.get_session(s1["session_id"], "br_eng") is not None
    finally:
        ws1.__exit__(None, None, None)


def test_origin_port_must_match_too(client):
    with client.websocket_connect(
        "/api/terminal/ws", headers={"origin": "http://testserver:9999"}
    ) as ws:
        _expect_close(ws, terminal.CLOSE_FORBIDDEN)


def test_several_connections_live_side_by_side(client, monkeypatch):
    """同一個人可以開好幾條 —— **新的不會把舊的踢掉**,
    因為舊的那條可能正在跑東西。滿了才拒絕新的,而且是在真的去連 SSH **之前**就擋。
    """
    monkeypatch.setattr(config, "SSH_TERMINAL_MAX_SESSIONS", 2)
    ws1, s1 = _connect(client, _token("br_eng"))
    ws2, s2 = _connect(client, _token("br_eng"))
    try:
        assert s1["session_id"] != s2["session_id"]
        # 兩條都還在,而且各自都通
        ws1.send_bytes(b"first\n")
        assert ws1.receive_bytes() == b"first\n"
        ws2.send_bytes(b"second\n")
        assert ws2.receive_bytes() == b"second\n"
        assert terminal.get_session(s1["session_id"], "br_eng") is not None
        assert terminal.get_session(s2["session_id"], "br_eng") is not None
        assert terminal.session_count("br_eng") == 2

        # 第三條:名額滿了,拒絕(4429),而且**不會**動到前兩條
        with client.websocket_connect(
            "/api/terminal/ws", headers={"origin": "http://testserver"}
        ) as ws3:
            ws3.send_text(_auth_msg(_token("br_eng")))
            closed = ws3.receive_json()
            assert closed["type"] == "closed" and closed["code"] == terminal.CLOSE_TOO_MANY
            assert "關掉一個頁籤" in closed["message"]
        assert terminal.session_count("br_eng") == 2
    finally:
        ws1.__exit__(None, None, None)
        ws2.__exit__(None, None, None)


def test_idle_timeout_closes_and_activity_resets(client, monkeypatch):
    monkeypatch.setattr(config, "SSH_TERMINAL_IDLE_TIMEOUT_SEC", 1)
    ws, _ = _connect(client, _token("br_eng"))
    try:
        # 每 0.4 秒敲一下,敲 1.6 秒 —— 超過閒置上限,但每一下都重設,不該斷
        for _ in range(4):
            time.sleep(0.4)
            ws.send_bytes(b"k")
            assert ws.receive_bytes() == b"k"
        started = time.time()
        closed = _expect_close(ws, terminal.CLOSE_IDLE)
        assert closed["reason"] == "idle"
        assert "沒有操作" in closed["message"]
        assert 0.7 <= time.time() - started <= 3
    finally:
        ws.__exit__(None, None, None)
    rows = _audit_rows("terminal_disconnect", "br_eng")
    assert "idle" in rows[0].detail


def test_activity_message_from_file_panel_resets_idle(client, monkeypatch):
    monkeypatch.setattr(config, "SSH_TERMINAL_IDLE_TIMEOUT_SEC", 1)
    ws, _ = _connect(client, _token("br_eng"))
    try:
        for _ in range(4):
            time.sleep(0.4)
            ws.send_text(json.dumps({"type": "activity"}))
        ws.send_bytes(b"alive")
        assert ws.receive_bytes() == b"alive"
    finally:
        ws.__exit__(None, None, None)


def test_no_idle_timeout_by_default_but_keepalive_keeps_the_pipe_warm(client, monkeypatch):
    """預設**閒置不斷線**,用 keepalive 撐住中間的 nginx。

    兩件事一起驗,因為它們是同一個決定的兩半:
      - `SSH_TERMINAL_IDLE_TIMEOUT_SEC=0`(預設)時,放著不動不會收到 closed;
      - `SSH_TERMINAL_KEEPALIVE_SEC` 到了就送一則 `{"type": "ping"}` ——
        那是給 proxy 看的流量,不是給使用者看的訊息(前端收到不認得的 type 會忽略)。
    """
    # ⚠️ 這個檔案的 fixture 把閒置設成 180 秒(見上面),所以要自己調回 0 ——
    # 「預設就是 0」那一條在 `test_terminal_auth.py::test_terminal_defaults`。
    monkeypatch.setattr(config, "SSH_TERMINAL_IDLE_TIMEOUT_SEC", 0)
    monkeypatch.setattr(config, "SSH_TERMINAL_KEEPALIVE_SEC", 1)
    ws, _ = _connect(client, _token("br_eng"))
    try:
        # 什麼都不做,等 keepalive 自己來 —— 來的是 ping 就代表「沒人動」也沒斷
        deadline = time.time() + 5
        while time.time() < deadline:
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "ping":
                break
            assert msg.get("type") != "closed", f"閒置不該斷線,卻收到 {msg}"
        else:  # pragma: no cover —— 等不到就是 keepalive 沒送
            raise AssertionError("等不到 keepalive 的 ping")
        # 連線還活著:打一個字回音照樣回來
        ws.send_bytes(b"alive")
        assert ws.receive_bytes() == b"alive"
    finally:
        ws.__exit__(None, None, None)


# ------------------------------ 登入在連線期間失效
#
# 握手時驗過一次身分之後,閒置預設不斷線、keepalive 又主動撐著,所以連線可以
# 無限期活著:只在握手時看身分的話,後台把離職的人按成停用,他那個頁籤仍然是
# 一個開著的 shell。`run_session` 的 `token_watch` 會定期回頭檢查身分。
def test_logging_out_closes_a_live_session(client, monkeypatch):
    """登出(= 改密碼 / 停用 / 重設 / 刪除都會走的 `revoke_all_for`)要收得掉已經開著的 shell。"""
    monkeypatch.setattr(terminal, "TOKEN_CHECK_SEC", 0.05)
    token = _token("br_eng")
    ws, _ = _connect(client, token)
    try:
        auth.logout(f"Bearer {token}")
        closed = _expect_close(ws, terminal.CLOSE_UNAUTHENTICATED)
        assert closed["reason"] == "revoked", closed
        assert "登入已失效" in closed["message"]
    finally:
        ws.__exit__(None, None, None)
    # 斷線的原因要留在稽核裡:管理員按下停用之後,看得出那條連線真的收掉了
    assert "revoked" in _audit_rows("terminal_disconnect", "br_eng")[0].detail


def test_losing_the_role_closes_a_live_session(client, monkeypatch):
    """**token 還好好的,但職稱被改成 Consultant** —— 一樣要收線。

    這條擋的是「改職稱那條路忘了撤 token」:身分檢查跟握手那一刻走同一支
    (`auth.can_use_terminal`),所以少撤一次不會變成一條留在主機上的 shell。
    """
    monkeypatch.setattr(terminal, "TOKEN_CHECK_SEC", 0.05)
    ws, _ = _connect(client, _token("br_eng2"))
    try:
        _make_user("br_eng2", users.ROLE_CONSULTANT, None)
        closed = _expect_close(ws, terminal.CLOSE_UNAUTHENTICATED)
        assert closed["reason"] == "revoked", closed
    finally:
        ws.__exit__(None, None, None)
        _make_user("br_eng2", users.ROLE_ENGINEER, "full")  # 還原,別影響後面的測試


def test_a_live_terminal_keeps_the_login_alive(client, monkeypatch):
    """**放著不動的終端機不會被登入的閒置逾時斷掉** —— 「閒置不斷線」不受影響。

    看門狗問的 `auth.username_for` 會推後閒置計時,而那是刻意的:一條還活著的
    WebSocket 就證明瀏覽器沒有關,也就不是那個逾時要抓的情境(說明在 `auth.username_for`)。
    少了這條測試,哪天有人把看門狗改成「唯讀地檢查」,症狀會是「終端機開著開著就斷了,
    而且訊息說登入已失效」—— 從畫面上看起來像 bug,不像設計。
    """
    monkeypatch.setattr(terminal, "TOKEN_CHECK_SEC", 0.05)
    monkeypatch.setattr(config, "SSH_TERMINAL_IDLE_TIMEOUT_SEC", 0)
    token = _token("br_eng")
    ws, _ = _connect(client, token)
    try:
        # ⚠️ **閒置上限要在連線建立之後才收緊,而且要先推後一次。**
        #
        # 冷啟動時第一次 SSH 握手可能要一秒以上(asyncssh 第一次載入、產金鑰、
        # 第一條連線),那段時間會被算進閒置 —— 在 `_connect` 之前就把上限設成 1 的話,
        # 看門狗第一次回頭檢查時 token 已經被清掉了,session 當場以 `revoked` 收線。
        #
        # 症狀很會騙人:**單獨跑這一條必失敗,跟著整個檔案跑又會過**(那時候
        # 假 sshd 早就熱了,握手很快),很容易被誤判成「別的改動把它弄壞了」。
        assert auth.username_for(token) == "br_eng"  # 推後一次,把冷啟動那段洗掉
        monkeypatch.setattr(config, "AUTH_IDLE_TIMEOUT_SEC", 1)

        time.sleep(2.5)  # 超過閒置上限,而且中間完全沒有人碰它
        ws.send_bytes(b"alive")
        # ⚠️ 這 2.5 秒裡 `watch_cwd` 很可能已經送過一則 cwd,**不能**直接 receive_bytes
        _echo_back(ws, b"alive")
        assert auth.username_for(token) == "br_eng", "登入被閒置逾時收走了"
    finally:
        ws.__exit__(None, None, None)


# ------------------------------------------------------------------ 檔案 API
def _h(username: str) -> dict:
    return {"Authorization": f"Bearer {_token(username)}"}


@pytest.fixture
def tree(sshd):
    """chroot 裡放一點東西:app/(含 lib/x.py)、empty/、CLAUDE.md、中文.txt。"""
    root = Path(sshd.root)
    for p in root.iterdir():
        if p.is_dir():
            import shutil

            shutil.rmtree(p)
        else:
            p.unlink()
    (root / "app" / "lib").mkdir(parents=True)
    (root / "app" / "lib" / "x.py").write_text("print('hi')\n", encoding="utf-8")
    (root / "empty").mkdir()
    (root / "CLAUDE.md").write_bytes(b"# hi\n")  # write_bytes:Windows 的 write_text 會寫成 CRLF
    (root / "中文.txt").write_bytes("測試".encode("utf-8"))
    return root


def test_list_dir_sorted_dirs_first(client, tree):
    ws, st = _connect(client, _token("br_eng"))
    try:
        r = client.get("/api/terminal/files", params={"session_id": st["session_id"], "path": "~"}, headers=_h("br_eng"))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["path"] == "/" and body["home"] == "/"
        names = [(e["name"], e["is_dir"]) for e in body["entries"]]
        assert names == [("app", True), ("empty", True), ("CLAUDE.md", False), ("中文.txt", False)]
        md = next(e for e in body["entries"] if e["name"] == "CLAUDE.md")
        assert md["size"] == 5 and md["mtime"] > 0

        r = client.get("/api/terminal/files", params={"session_id": st["session_id"], "path": "~/app/lib"}, headers=_h("br_eng"))
        assert [e["name"] for e in r.json()["entries"]] == ["x.py"]

        r = client.get("/api/terminal/files", params={"session_id": st["session_id"], "path": "/nope"}, headers=_h("br_eng"))
        assert r.status_code == 404
        r = client.get("/api/terminal/files", params={"session_id": st["session_id"], "path": "relative/x"}, headers=_h("br_eng"))
        assert r.status_code == 400
    finally:
        ws.__exit__(None, None, None)


def test_file_api_requires_login_role_and_own_session(client, tree):
    ws, st = _connect(client, _token("br_eng"))
    try:
        sid = st["session_id"]
        assert client.get("/api/terminal/files", params={"session_id": sid}).status_code == 401
        assert client.get("/api/terminal/files", params={"session_id": sid}, headers=_h("br_cons")).status_code == 403
        assert client.get("/api/terminal/files", params={"session_id": sid}, headers=_h("br_eng2")).status_code == 409
        assert client.get("/api/terminal/files", params={"session_id": "nonsense"}, headers=_h("br_eng")).status_code == 409
    finally:
        ws.__exit__(None, None, None)
    # 斷線之後同一個 session_id 也不能用了
    assert client.get("/api/terminal/files", params={"session_id": sid}, headers=_h("br_eng")).status_code == 409


def test_upload_conflict_overwrite_and_audit(client, tree):
    ws, st = _connect(client, _token("br_eng"))
    try:
        sid = st["session_id"]
        n = len(_audit_rows("terminal_file_upload", "br_eng"))
        files = [("files", ("a.txt", b"AAA", "text/plain")), ("files", ("b.bin", bytes(range(256)) * 10, "application/octet-stream"))]
        r = client.post("/api/terminal/files/upload", params={"session_id": sid, "path": "~/app"}, files=files, headers=_h("br_eng"))
        assert r.status_code == 200, r.text
        assert (tree / "app" / "a.txt").read_bytes() == b"AAA"
        assert (tree / "app" / "b.bin").read_bytes() == bytes(range(256)) * 10
        assert len(_audit_rows("terminal_file_upload", "br_eng")) == n + 2
        assert "/app/a.txt" in _audit_rows("terminal_file_upload", "br_eng")[1].detail

        r = client.post("/api/terminal/files/upload", params={"session_id": sid, "path": "~/app"}, files=[("files", ("a.txt", b"BBB", "text/plain"))], headers=_h("br_eng"))
        assert r.status_code == 409
        assert r.json()["detail"]["exists"] == ["a.txt"]
        assert (tree / "app" / "a.txt").read_bytes() == b"AAA", "409 的時候不能動到檔案"

        r = client.post("/api/terminal/files/upload", params={"session_id": sid, "path": "~/app", "overwrite": 1}, files=[("files", ("a.txt", b"BBB", "text/plain"))], headers=_h("br_eng"))
        assert r.status_code == 200
        assert (tree / "app" / "a.txt").read_bytes() == b"BBB"

        r = client.post("/api/terminal/files/upload", params={"session_id": sid, "path": "~"}, files=[("files", ("../evil.txt", b"x", "text/plain"))], headers=_h("br_eng"))
        assert r.status_code == 200 and (tree / "evil.txt").exists(), "檔名只取最後一段"
    finally:
        ws.__exit__(None, None, None)


def test_download_content_and_utf8_filename(client, tree):
    ws, st = _connect(client, _token("br_eng"))
    try:
        sid = st["session_id"]
        r = client.get("/api/terminal/files/download", params={"session_id": sid, "path": "~/中文.txt"}, headers=_h("br_eng"))
        assert r.status_code == 200
        assert r.content == "測試".encode("utf-8")
        cd = r.headers["content-disposition"]
        assert cd.startswith("attachment;") and "filename*=UTF-8''%E4%B8%AD%E6%96%87.txt" in cd
        assert "nosniff" in r.headers["x-content-type-options"]
        assert client.get("/api/terminal/files/download", params={"session_id": sid, "path": "~/app"}, headers=_h("br_eng")).status_code == 400
        assert client.get("/api/terminal/files/download", params={"session_id": sid, "path": "~/nope"}, headers=_h("br_eng")).status_code == 404
    finally:
        ws.__exit__(None, None, None)


def test_delete_file_empty_dir_but_not_nonempty(client, tree):
    ws, st = _connect(client, _token("br_eng"))
    try:
        sid = st["session_id"]
        n = len(_audit_rows("terminal_file_delete", "br_eng"))
        r = client.delete("/api/terminal/files", params={"session_id": sid, "path": "~/CLAUDE.md"}, headers=_h("br_eng"))
        assert r.status_code == 200 and not (tree / "CLAUDE.md").exists()
        r = client.delete("/api/terminal/files", params={"session_id": sid, "path": "~/empty"}, headers=_h("br_eng"))
        assert r.status_code == 200 and not (tree / "empty").exists()
        r = client.delete("/api/terminal/files", params={"session_id": sid, "path": "~/app"}, headers=_h("br_eng"))
        assert r.status_code == 400 and "不是空的" in r.json()["detail"]
        assert (tree / "app" / "lib" / "x.py").exists()
        assert client.delete("/api/terminal/files", params={"session_id": sid, "path": "~/nope"}, headers=_h("br_eng")).status_code == 404
        assert client.delete("/api/terminal/files", params={"session_id": sid, "path": "/"}, headers=_h("br_eng")).status_code == 400
        assert len(_audit_rows("terminal_file_delete", "br_eng")) == n + 2
    finally:
        ws.__exit__(None, None, None)


def test_listing_is_not_activity_but_the_panel_says_when_it_is(client, tree):
    """列目錄**不算**活動(檔案欄會跟著終端機的目前目錄走,那一趟不能拖著閒置計時);
    使用者自己點的那幾種,前端另外送一則 `activity`,那一則才算。"""
    ws, st = _connect(client, _token("br_eng"))
    try:
        sid = st["session_id"]
        s = terminal.get_session(sid, "br_eng")
        before = s.last_activity
        time.sleep(0.05)
        client.get("/api/terminal/files", params={"session_id": sid, "path": "~"}, headers=_h("br_eng"))
        assert s.last_activity == before, "列目錄不算活動 —— 跟隨終端機的那一趟會讓閒置永遠不到"
        ws.send_text(json.dumps({"type": "activity"}))
        assert _wait(lambda: s.last_activity > before), "使用者發動的那一趟要靠 activity 訊息重設"
    finally:
        ws.__exit__(None, None, None)


def test_writing_file_operations_still_count_as_activity(client, tree):
    """會動到主機的那幾支照樣算活動 —— 拖一個大檔上傳到一半被閒置踢掉會很難看。"""
    ws, st = _connect(client, _token("br_eng"))
    try:
        sid = st["session_id"]
        s = terminal.get_session(sid, "br_eng")
        before = s.last_activity
        time.sleep(0.05)
        client.post(
            "/api/terminal/files/upload",
            params={"session_id": sid, "path": "~"},
            files={"files": ("idle.txt", b"x")},
            headers=_h("br_eng"),
        )
        assert s.last_activity > before, "上傳要重設閒置計時"
        before = s.last_activity
        time.sleep(0.05)
        client.delete("/api/terminal/files", params={"session_id": sid, "path": "~/idle.txt"}, headers=_h("br_eng"))
        assert s.last_activity > before, "刪除要重設閒置計時"
    finally:
        ws.__exit__(None, None, None)


def test_paths_normalize(client, tree):
    ws, st = _connect(client, _token("br_eng"))
    try:
        s = terminal.get_session(st["session_id"], "br_eng")
        assert terminal.resolve_path(s, "/app/../../../etc") == "/etc"
        assert terminal.resolve_path(s, "~/app/./lib/") == "/app/lib"
        with pytest.raises(terminal.TerminalError):
            terminal.resolve_path(s, "app")
    finally:
        ws.__exit__(None, None, None)


# ------------------------------------------------------------------ 目前目錄(檔案欄跟著走)
def test_cwd_tracking_is_optional_and_never_touches_idle(client, tree):
    """認不出 shell 的機器上(這個假 sshd 的 SFTP 是 chroot 的,沒有 /dev/pts、沒有 /proc)
    整段追蹤要**靜靜地不做**:連線照常、不推 `cwd`、也不會把閒置計時重設掉。"""
    ws, st = _connect(client, _token("br_eng"))
    try:
        s = terminal.get_session(st["session_id"], "br_eng")
        before = s.last_activity
        # 追蹤在背景跑;跑不起來的話 shell_pid 一直是 None,而且不准算成活動
        time.sleep(0.5)
        assert s.shell_pid is None
        assert s.cwd is None
        assert s.last_activity == before, "看一眼目前目錄不算活動,不然閒置永遠不會到"
    finally:
        ws.__exit__(None, None, None)


def test_listed_dir_change_pushes_dir_and_never_touches_idle(client, tree):
    """檔案欄開著的目錄被別人動了(終端機裡 mkdir / rm),要推一則 `{"type":"dir"}` 叫它重列,
    檔案欄才會自己更新。看修改時間一樣不算活動。

    ⚠️ 修改時間先撥回一百秒前再列:SFTP v3 的修改時間只到秒,列目錄跟建資料夾落在同一秒的話
    比對不出差別(那種情況靠 `DIR_SETTLE_SEC` 補的那一次,這裡不驗)。"""
    old = time.time() - 100
    os.utime(tree, (old, old))
    ws, st = _connect(client, _token("br_eng"))
    try:
        s = terminal.get_session(st["session_id"], "br_eng")
        r = client.get("/api/terminal/files", params={"session_id": st["session_id"], "path": "~"}, headers=_h("br_eng"))
        assert r.status_code == 200
        before = s.last_activity
        (tree / "made-in-terminal").mkdir()
        time.sleep(terminal.DIR_POLL_SEC * 2 + 0.5)
        # 要在 `_next_dir` 之前看:它打的那個字本身就算活動
        assert s.last_activity == before, "看一眼修改時間不算活動,不然閒置永遠不會到"
        assert _next_dir(ws) == {"type": "dir", "path": "/"}
    finally:
        ws.__exit__(None, None, None)


def test_dir_watch_covers_a_listing_that_finished_out_of_order(client, tree):
    """前端連點兩個資料夾、前一個回得慢時,後端**最後列完**的不是畫面上那個 —— 最近列過的幾個都要盯
    (只盯最後列完的那個的話,在畫面上那個目錄裡 mkdir 就不會重列)。
    這裡用「先列 app、再列 ~」模擬:畫面上是 app,後端最後列完的是 ~。"""
    old = time.time() - 100
    os.utime(tree / "app", (old, old))
    ws, st = _connect(client, _token("br_eng"))
    try:
        for path in ("~/app", "~"):
            r = client.get("/api/terminal/files", params={"session_id": st["session_id"], "path": path}, headers=_h("br_eng"))
            assert r.status_code == 200
        (tree / "app" / "made-in-terminal").mkdir()
        assert _next_dir(ws) == {"type": "dir", "path": "/app"}
    finally:
        ws.__exit__(None, None, None)


def _next_dir(ws) -> dict | None:
    """等兩輪輪詢之後的第一則 `{"type":"dir"}`;沒有就回 None。

    ⚠️ 不能一直 `receive()` 等它:沒推的時候 `receive()` 會永遠卡住(沒有逾時),測試失敗的樣子會是整批跑不完。
    所以先等兩輪,再打一個字當**終點** —— 推了的話一定排在那個回音前面。"""
    time.sleep(terminal.DIR_POLL_SEC * 2 + 0.5)
    ws.send_bytes(b"#")
    while True:
        msg = ws.receive()
        if msg.get("type") in ("websocket.close", "websocket.disconnect"):
            raise AssertionError(f"連線被關掉了:{msg}")
        if msg.get("bytes") is not None and b"#" in msg["bytes"]:
            return None
        if msg.get("text"):
            data = json.loads(msg["text"])
            assert data.get("type") != "closed", data
            if data.get("type") == "dir":
                return data


def test_listing_carries_ls_l_columns(client, tree):
    """檔案欄要顯示 Name / Size / Last modified / Owner / Group / Access。

    `access` 是後端從權限位元算的(`mode_text`),不靠伺服器的字串;
    `owner` / `group` 來自 SFTP v3 的 `longname`,拿不到名字就退回 uid / gid 數字 —— 兩種都不准是 None。
    """
    ws, st = _connect(client, _token("br_eng"))
    try:
        r = client.get(
            "/api/terminal/files",
            params={"session_id": st["session_id"], "path": "~"},
            headers=_h("br_eng"),
        )
        assert r.status_code == 200
        by_name = {e["name"]: e for e in r.json()["entries"]}
        folder, plain = by_name["app"], by_name["CLAUDE.md"]
        assert folder["access"].startswith("d") and len(folder["access"]) == 10
        assert plain["access"].startswith("-") and len(plain["access"]) == 10
        for entry in (folder, plain):
            assert isinstance(entry["owner"], str) and isinstance(entry["group"], str)
    finally:
        ws.__exit__(None, None, None)


def test_mode_text_matches_ls():
    assert terminal.mode_text(0o040755) == "drwxr-xr-x"
    assert terminal.mode_text(0o100644) == "-rw-r--r--"
    assert terminal.mode_text(0o104755) == "-rwsr-xr-x"   # setuid,x 有開 → 小寫 s
    assert terminal.mode_text(0o104655) == "-rwSr-xr-x"   # setuid,x 沒開 → 大寫 S
    assert terminal.mode_text(0o041777) == "drwxrwxrwt"   # sticky


def test_cwd_payload_shape():
    msg = json.loads(terminal.cwd_payload("/srv/app/src"))
    assert msg == {"type": "cwd", "path": "/srv/app/src"}


def test_detect_shell_pid_refuses_to_guess_when_someone_else_connects_too():
    """認 tty 的規則:多出**不只一格**、或確認時又多冒出一格,一律放棄。

    大家可能共用同一個系統帳號,認錯 tty 會讓檔案欄跟到別人那條連線的目錄 —— 寧可不追蹤。
    這裡不需要真的 sshd:`_detect_shell_pid` 只透過 `sftp.readdir('/dev/pts')` 看世界。
    """

    class FakeSftp:
        """每次 readdir 回下一批 /dev/pts 內容(最後一批之後就一直回它)。"""

        def __init__(self, batches):
            self.batches = list(batches)

        async def readdir(self, path):
            assert path == "/dev/pts"
            names = self.batches[0] if len(self.batches) == 1 else self.batches.pop(0)
            return [SimpleNamespace(filename=n) for n in names]

    def detect(batches):
        session = SimpleNamespace(sftp=FakeSftp(batches), pts_before=frozenset({"0"}), conn=None)
        return asyncio.run(terminal._detect_shell_pid(session))

    # 一次多出兩格:兩個人同時連進來,不猜
    assert detect([["0", "1", "2"]]) is None
    # 先看到一格,確認時又多一格:剛剛那一格不一定是我們的,也不猜
    assert detect([["0", "1"], ["0", "1", "2"]]) is None
    # 一格都沒多(不是 Linux / 讀不到 /dev/pts):靜靜地不追蹤
    assert detect([["0"]]) is None


# ------------------------------------------------------------------ AI 助手
def test_ai_prompt_carries_context_and_truncates():
    """畫面內容與問題都會進提示,而且各自有上限(貼一整份 log 也不會整份送給模型;提示走 stdin,見 test_prompt_stdin.py)。"""
    prompt = terminal_ai.build_prompt("這個錯誤是什麼意思?", "gcc: error: 42")
    assert "這個錯誤是什麼意思?" in prompt
    assert "gcc: error: 42" in prompt
    assert "<terminal>" in prompt and "</terminal>" in prompt
    # 沒有工具這件事要寫在提示裡 —— 它是這條路唯一的行為約束
    assert "沒有任何工具" in prompt

    long_context = "x" * (terminal_ai.MAX_CONTEXT_CHARS + 5_000)
    long_question = "問" * (terminal_ai.MAX_QUESTION_CHARS + 500)
    prompt = terminal_ai.build_prompt(long_question, long_context)
    assert prompt.count("x") == terminal_ai.MAX_CONTEXT_CHARS
    # 「問」這個字提示本身也有一個(「使用者的問題:」),所以比對整段而不是數字數
    assert "問" * terminal_ai.MAX_QUESTION_CHARS in prompt
    assert "問" * (terminal_ai.MAX_QUESTION_CHARS + 1) not in prompt
    # 留下的是**最後**那一段畫面(最近發生的事),不是開頭
    assert terminal_ai.build_prompt("q", "頭" + "x" * terminal_ai.MAX_CONTEXT_CHARS).count("頭") == 0


def test_ai_ask_needs_a_live_session_and_a_question(client, tree):
    """沒有連線就沒有畫面可以問(409);問題空白 400。兩道都在後端。"""
    ws, st = _connect(client, _token("br_eng"))
    try:
        sid = st["session_id"]
        r = client.post(
            "/api/terminal/ask",
            json={"session_id": "沒有這條", "question": "嗨", "context": ""},
            headers=_h("br_eng"),
        )
        assert r.status_code == 409
        r = client.post(
            "/api/terminal/ask",
            json={"session_id": sid, "question": "   ", "context": ""},
            headers=_h("br_eng"),
        )
        assert r.status_code == 400
    finally:
        ws.__exit__(None, None, None)


def test_ai_ask_is_engineers_only(client, tree):
    """Consultant 連終端機都連不上,自然也問不了 —— 這一支自己也要擋(不能只靠前端不顯示)。"""
    ws, st = _connect(client, _token("br_eng"))
    try:
        r = client.post(
            "/api/terminal/ask",
            json={"session_id": st["session_id"], "question": "嗨", "context": ""},
            headers=_h("br_consultant"),
        )
        assert r.status_code in (403, 409)
    finally:
        ws.__exit__(None, None, None)


def test_owner_group_only_trusts_a_real_ls_l_line():
    """`longname` 只有長得**完全像** `ls -l` 才採信,不然退回 uid / gid。

    鬆一點就會抓錯欄:有些 sshd 少印一欄,結果「群組」顯示的是檔案大小。
    """
    from types import SimpleNamespace

    attrs = SimpleNamespace(uid=1001, gid=1002, permissions=0o100644, size=24, mtime=0)
    good = SimpleNamespace(longname="-rw-r--r--    1 deploy   deploy       1234 Sep 10 17:06 x.py")
    assert terminal._owner_group(good, attrs) == ("deploy", "deploy")

    short = SimpleNamespace(longname="-rw-rw-rw- 1 0 24 Sep 10 17:39 CLAUDE.md")
    assert terminal._owner_group(short, attrs) == ("1001", "1002")

    assert terminal._owner_group(SimpleNamespace(longname=""), attrs) == ("1001", "1002")
    assert terminal._owner_group(SimpleNamespace(longname=None), SimpleNamespace(uid=None, gid=None)) == ("", "")


def test_ai_command_has_no_prompt_on_the_command_line():
    """提示詞(含遠端主機畫面)走 stdin,命令列上沒有(同一台機器上任何帳號 `ps` 都看得到 argv)。

    走 stdin 也就不需要 `--` 把提示詞跟變長的 `--disallowedTools` 隔開(放在命令列的話,
    提示詞會被當成工具名字吃掉)。stdin 真的有送,見 tests/test_prompt_stdin.py。
    """
    cmd = terminal_ai.build_command()
    assert "--" not in cmd
    assert "--disallowedTools" in cmd
    # 這條路不掛任何目錄、也不接續 session:它讀不到主機上的檔案
    assert "--add-dir" not in cmd and "--resume" not in cmd
    disallowed = cmd[cmd.index("--disallowedTools") + 1]
    for tool in ("Bash", "Read", "Write", "Edit", "WebFetch", "Task"):
        assert tool in disallowed


def test_ai_surfaces_the_cli_own_error():
    """CLI 出事時只送一則完整訊息(不走串流),那句話要照原樣給人看,不要吞掉。"""
    assert terminal_ai.cli_error_message(
        {"type": "result", "is_error": True, "result": "Not logged in · Please run /login"}
    ) == "Not logged in · Please run /login"
    assert terminal_ai.cli_error_message({"type": "result", "is_error": False, "result": "ok"}) == ""
    assert (
        terminal_ai.cli_error_message(
            {"type": "assistant", "error": "authentication_failed",
             "message": {"content": [{"type": "text", "text": "Failed to authenticate"}]}}
        )
        == "Failed to authenticate"
    )
    # 正常的 assistant 訊息不是錯誤,不能被當成錯誤送出去
    assert terminal_ai.cli_error_message(
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "答案"}]}}
    ) == ""


def test_ai_per_user_slot_blocks_a_second_question_in_flight():
    """同一個人同時只有一次在跑(每一次都是一個計費行程),小時上限也擋。"""
    user = "slot_tester"
    terminal_ai.take_slot(user)
    try:
        with pytest.raises(terminal_ai.TooMany):
            terminal_ai.take_slot(user)
    finally:
        terminal_ai.release_slot(user)
    # 放掉之後可以再問
    terminal_ai.take_slot(user)
    terminal_ai.release_slot(user)


def _reasons_used_in_the_bridge() -> set[str]:
    """把橋接**真的會回**的結束原因從 `terminal.py` 的原始碼裡掃出來。

    ⚠️ 掃原始碼而不是手抄一份清單:手抄的清單擋不住「新增一個原因、忘了登記、
    也忘了加進清單」,測試照樣綠。橋接裡的原因只會從兩個地方長出來:任務 `return "..."`,
    或 `close_session(..., "...")` / `close_all(reason=...)` 的預設值。
    """
    source = (Path(terminal.__file__)).read_text(encoding="utf-8")
    found = set(re.findall(r'return "([a-z_]+)"', source))
    found |= set(re.findall(r'close_session\([^,]+,\s*"([a-z_]+)"\)', source))
    found |= set(re.findall(r'reason: str = "([a-z_]+)"', source))
    return found


def test_every_close_reason_the_bridge_can_return_is_registered():
    """**橋接會回的每一個原因都要在 `CLOSE_REASONS` 裡。**

    漏登記的話(例如 keepalive 回的 `network`),關閉碼落回 1000、訊息落回
    「連線已結束。」—— 而前端把 1000 讀成 `exit`,「半開的連線被回收」就長得跟
    「使用者自己打 exit」一模一樣。

    只有一張表,而且這條測試是**從原始碼掃出來跟它對**的:漏登記就會紅,
    不需要有人記得同時更新測試裡的清單。
    """
    used = _reasons_used_in_the_bridge()
    # 掃到的東西要合理:少於這幾個就是正則失效了(改寫橋接時要回來修這條測試)
    assert {"exit", "idle", "left_page", "server", "network"} <= used, f"掃出來的原因不對:{used}"
    missing = used - set(terminal.CLOSE_REASONS)
    assert not missing, f"這些原因沒登記進 CLOSE_REASONS:{sorted(missing)}"
    for reason in sorted(used):
        message = terminal.closed_message(reason)
        assert message, f"{reason} 沒有訊息"
        # 只有 exit 可以長得像「正常結束」:其他原因落回那一句就是沒登記
        if reason != "exit":
            assert message != terminal.CLOSE_REASONS["exit"][1], f"{reason} 退回通用訊息"


def test_unregistered_reason_is_loud_not_silent(caplog):
    """沒登記的原因**不可以靜悄悄變成正常結束**:要記一筆,而且退回「錯誤」不是 1000。"""
    with caplog.at_level(logging.ERROR, logger="app.terminal"):
        assert terminal.close_code_for("made_up") == 1011
        assert terminal.closed_message("made_up") == "連線發生錯誤。"
    assert any("made_up" in r.getMessage() for r in caplog.records), "沒登記的原因沒有記進 log"


def _frontend_close_messages() -> dict[str, str]:
    """把前端 `closeMessage()` 裡的句子挖出來(`make('<reason>', '<中文>')`)。"""
    path = Path(terminal.__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "terminalApi.ts"
    if not path.exists():  # 只裝了後端的環境(部署包不含前端原始碼)
        pytest.skip(f"找不到前端原始碼:{path}")
    text = path.read_text(encoding="utf-8")
    return {m[0]: m[1] for m in re.findall(r"make\('([a-z_]+)',\s*'([^']+)'\)", text)}


def test_close_messages_match_the_frontend_word_for_word(monkeypatch):
    """兩邊那幾句要**逐字一樣**,而且是對著前端原始碼比,不是對著一份抄來的字面值。

    同一種斷線會從兩條路長出訊息:後端送得到就用後端的 `closed.message`,送不到
    (網路真的斷了)前端就拿關閉碼自己補。兩句不一樣的話,同一種斷線在使用者眼裡
    會有兩種說法(兩邊要同一個腔)。

    ⚠️ 只 assert 後端 == 一個寫死的字面值的話,**前端改掉照樣綠**。
    """
    front = _frontend_close_messages()
    assert front, "前端的 closeMessage() 解不出句子 —— 它的寫法改了,這條測試要跟著改"
    for reason in ("network", "exit"):
        assert reason in front, f"前端沒有 {reason} 那句"
        assert terminal.closed_message(reason) == front[reason], (
            f"{reason}:後端「{terminal.closed_message(reason)}」/ 前端「{front[reason]}」"
        )
    # idle 兩條路各驗一次(別的測試會把這個值 monkeypatch 掉,所以這裡自己指定):
    # 閒置關著(預設 0)→ 退回跟前端 4408 逐字相同的那句;開著 → 帶分鐘數。
    monkeypatch.setattr(config, "SSH_TERMINAL_IDLE_TIMEOUT_SEC", 0)
    assert terminal.closed_message("idle") == front["idle"]
    monkeypatch.setattr(config, "SSH_TERMINAL_IDLE_TIMEOUT_SEC", 600)
    assert terminal.closed_message("idle") == "10 分鐘沒有操作,已自動斷線。"
