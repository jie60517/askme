# -*- coding: utf-8 -*-
"""收線前結束這條連線開出來的程式(`terminal.end_programs_command` / `end_programs`)。

分頁或瀏覽器關了,就把這條連線開的程式關掉,避免程式殘留。

守的是:
  1. 認程式只靠 `SSH_CONNECTION`(大家可能共用同一個帳號,工作階段 / tty 都會撞號),
     第二輪 KILL 不重找、只補殺第一輪名單裡還活著的;腳本裡不能有 csh 會展開的 `!`;
  2. 收線順序:關 shell(同步)→ 收程式 → 關連線;
  3. 收程式失敗(連線早就斷了)、或這個任務半路又被取消,連線照樣收得掉;
  4. 真的收到程式才寫稽核紀錄(會改遠端主機的動作要留痕)。
這裡不跑 sh,只驗指令的組成與收線流程。腳本本身要在真的 Linux 上驗:同一個 SSH_CONNECTION
底下的、nohup 背景的、忽略 TERM 的全收掉;另一個 SSH_CONNECTION 的不動;空的環境報 0 支。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_terminal_end_programs.py
"""

import asyncio

from app import terminal


class _FakeProcess:
    def __init__(self, log):
        self.log = log

    def close(self):
        self.log.append("process.close")


class _FakeConn:
    def __init__(self, log, *, fail=False, stdout="ended 2 killed 1\n", hang=False):
        self.log = log
        self.fail = fail
        self.stdout = stdout
        self.hang = hang

    async def run(self, command, check=False, **_kw):
        self.log.append(("run", command))
        if self.fail:
            raise OSError("connection lost")
        if self.hang:
            await asyncio.sleep(3600)
        result = type("R", (), {})()
        result.stdout = self.stdout
        return result

    def close(self):
        self.log.append("conn.close")

    async def wait_closed(self):
        return None


class _FakeTunnel:
    def __init__(self, log):
        self.log = log

    def close(self):
        self.log.append("tunnel.close")


def _session(log, **conn_kw):
    return terminal.Session(
        session_id="s1",
        username="eng",
        token="t",
        ip="127.0.0.1",
        conn=_FakeConn(log, **conn_kw),
        process=_FakeProcess(log),
        home="/home/deploy",
        label="deploy@test",
        sftp=None,
        tunnel=_FakeTunnel(log),
    )


def _quiet_audit(monkeypatch, sink=None):
    def record(*a, **k):
        if sink is not None:
            sink.append((a, k))

    monkeypatch.setattr(terminal.audit, "record", record)


def test_只靠_SSH_CONNECTION_認程式_而且第二輪不重找():
    cmd = terminal.end_programs_command()
    assert cmd.startswith("sh -c ")
    assert "SSH_CONNECTION" in cmd
    # 不能靠 tty 或其他環境變數認程式(會撞號,殺到共用帳號上別人的程式)
    assert "ps -t" not in cmd and "FGLSERVER" not in cmd
    # csh 會在單引號裡做 ! 的歷史展開 —— 腳本裡不能有
    assert "!" not in cmd
    # 先 TERM、等一下、只補殺第一輪名單裡還活著的(kill -0),不重新掃一次
    assert (
        cmd.index("kill -TERM")
        < cmd.index(f"sleep {terminal.END_PROGRAMS_GRACE_SEC}")
        < cmd.index("kill -0")
        < cmd.index("kill -KILL")
    )
    assert cmd.count("holders |") == 1


def test_收線順序_關_shell_收程式_關連線_最後收跳板(monkeypatch):
    _quiet_audit(monkeypatch)
    log = []
    s = _session(log)
    asyncio.run(terminal.close_session(s, "left_page"))
    run_at = next(i for i, x in enumerate(log) if isinstance(x, tuple))
    assert log.index("process.close") < run_at < log.index("conn.close") < log.index("tunnel.close")


def test_收程式失敗也照常收線(monkeypatch):
    _quiet_audit(monkeypatch)
    log = []
    s = _session(log, fail=True)
    asyncio.run(terminal.close_session(s, "network"))
    assert "process.close" in log and "conn.close" in log and "tunnel.close" in log
    assert s.close_reason == "network"


def test_收程式半路又被取消_連線與跳板照樣收(monkeypatch):
    _quiet_audit(monkeypatch)
    log = []
    s = _session(log, hang=True)

    async def main():
        task = asyncio.create_task(terminal.close_session(s, "server"))
        while not any(isinstance(x, tuple) for x in log):
            await asyncio.sleep(0.01)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(main())
    assert "conn.close" in log and "tunnel.close" in log


def test_真的收到程式才寫稽核(monkeypatch):
    records = []
    _quiet_audit(monkeypatch, records)
    asyncio.run(terminal.close_session(_session([], stdout="ended 3 killed 1\n"), "left_page"))
    ended = [k for a, k in records if a[0] == "terminal_end_programs"]
    assert len(ended) == 1
    assert "3 支" in ended[0]["detail"] and "1 支強制結束" in ended[0]["detail"]

    records.clear()
    asyncio.run(terminal.close_session(_session([], stdout="ended 0\n"), "left_page"))
    assert "terminal_end_programs" not in [a[0] for a, _ in records]
