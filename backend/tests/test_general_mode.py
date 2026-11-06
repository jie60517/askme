# -*- coding: utf-8 -*-
"""一般模式 `/general`:這一題不帶任何專案,其他照舊。

驗收 A1–A6 都在這支。真的 claude 不跑:A1 攔 `create_subprocess_exec` 看組出來的命令列,
A3、A4 從 `/api/ask` 進去、把 `agent.stream_agent` 換成記下參數的假的。
"""
import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import agent, auth, config
from app.main import app


@pytest.fixture
def general_root(tmp_path, monkeypatch):
    root = tmp_path / "askme_general"
    monkeypatch.setattr(config, "GENERAL_WORKDIR", root)
    return root


# ── 設定 ───────────────────────────────────────────────────────────────


def test_general_是保留代號(general_root):
    assert config.get_knowledge_base("general") is config.GENERAL_BASE
    assert config.is_general(config.get_knowledge_base("general"))
    assert config.is_general("general")
    # 一般的環境不受影響
    assert not config.is_general(config.get_knowledge_base(None))


def test_工作目錄是每個人一格_第一次才建(general_root):
    assert not general_root.exists()
    alice = config.resolve_workdir(config.GENERAL_BASE, user="alice")
    assert Path(alice) == general_root / "alice"
    assert Path(alice).is_dir()
    assert Path(config.resolve_workdir(config.GENERAL_BASE, user="bob")) == general_root / "bob"
    # 續問指定當初那個目錄,一律照它
    assert config.resolve_workdir(config.GENERAL_BASE, explicit="/somewhere", user="alice") == "/somewhere"


@pytest.mark.parametrize("name", ["../root", "a/b", "..", "", "王小明"])
def test_帳號名組不出別的路徑(general_root, name):
    path = Path(config.general_workdir(name))
    assert path.parent == general_root, f"{name!r} 跑出 {general_root} 了:{path}"
    assert path.name not in ("", ".", "..")


def test_一般模式絕不落回共用工作目錄(general_root):
    """CLAUDE_WORKDIR 是預設專案的工作目錄,落回去就會載到它的 CLAUDE.md。"""
    assert config.resolve_workdir(config.GENERAL_BASE, user="alice") != config.CLAUDE_WORKDIR


def test_沒有版本說明(general_root):
    assert agent.build_context_note(config.GENERAL_BASE) == ""
    prompt = agent.build_prompt("寫一支 python 排序", "run-1", None, config.GENERAL_BASE)
    assert "這個版本" not in prompt
    assert "4gl" not in prompt
    # 產檔的說明照舊(Excel / Word 自動轉)
    assert "Excel" in prompt


# ── A1 組出來的命令列 ───────────────────────────────────────────────────


class _FakeProc:
    returncode = 0

    def __init__(self):
        class Stdin:
            def write(self, data):
                pass

            async def drain(self):
                pass

            def close(self):
                pass

        class Empty:
            async def readline(self):
                await asyncio.sleep(0)
                return b""

            async def read(self, _n=-1):
                return b""

        self.stdin, self.stdout, self.stderr = Stdin(), Empty(), Empty()

    def kill(self):
        pass

    async def wait(self):
        return 0


def _run(monkeypatch, tmp_path, *, allowed_tools, writable=None):
    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "outputs")
    monkeypatch.setattr(config, "CLAUDE_EXTRA_DIRS", [str(tmp_path / "erp_tree")])
    captured = {}

    async def fake_exec(*cmd, **kwargs):
        captured["cmd"] = list(cmd)
        captured["cwd"] = kwargs.get("cwd")
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    workdir = config.resolve_workdir(config.GENERAL_BASE, user="alice")

    async def drive():
        async for _ in agent.stream_agent(
            question="幫我寫一支 shell script",
            session_id="run-g1",
            conversation_id="conv-g1",
            is_new_conversation=True,
            claude_session_id="22222222-2222-2222-2222-222222222222",
            allowed_tools=allowed_tools,
            knowledge_base=config.GENERAL_BASE,
            writable_extra_dirs=writable,
            workdir=workdir,
            asker="alice",
        ):
            pass

    asyncio.run(drive())
    return captured, workdir


def test_A1_不掛任何專案的東西(general_root, tmp_path, monkeypatch):
    captured, workdir = _run(
        monkeypatch, tmp_path, allowed_tools=config.ALLOWED_TOOLS_FULL, writable=[str(tmp_path / "flows")]
    )
    cmd = captured["cmd"]
    assert captured["cwd"] == workdir
    assert "--mcp-config" not in cmd, "一般模式不接 ERP 知識庫 / 問資料"
    assert "--add-dir" not in cmd, "全站的 ERP 樹、flows/ 都不掛"
    assert str(tmp_path / "erp_tree") not in " ".join(cmd)


def test_A5_唯讀帳號只讀得到自己那一格(general_root, tmp_path, monkeypatch):
    config.general_workdir("bob")  # 別人的那一格先存在
    captured, workdir = _run(monkeypatch, tmp_path, allowed_tools=config.ALLOWED_TOOLS)
    cmd = captured["cmd"]
    tools = cmd[cmd.index("--allowedTools") + 1]
    assert "Bash" not in tools
    assert Path(workdir).as_posix().lstrip("/") in tools, tools
    assert "/bob" not in tools, "讀得到別人的一般資料夾"
    assert general_root.as_posix() + "/**" not in tools, "整層 askme_general 都放行了"


# ── A3、A4 從 /api/ask 進去 ─────────────────────────────────────────────


@pytest.fixture
def recorded(monkeypatch, tmp_path, general_root):
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "outputs")
    calls = []

    def fake_agent(session_id, **kwargs):
        calls.append({"session_id": session_id, **kwargs})

        async def gen():
            yield {"type": "delta", "text": "好。"}
            yield {
                "type": "done",
                "success": True,
                "answer": "好。",
                "error": None,
                "duration_ms": 5,
                "cost_usd": 0.0,
                "conversation_id": kwargs.get("conversation_id"),
            }

        return gen()

    monkeypatch.setattr(agent, "stream_agent", fake_agent)
    return calls


def _ask(client, token, conv, kb):
    with client.stream(
        "POST",
        "/api/ask",
        data={"question": "幫我看這段 python", "conversation_id": conv, "kb": kb},
        headers={"Authorization": f"Bearer {token}"},
    ) as resp:
        assert resp.status_code == 200
        return [json.loads(line) for line in resp.iter_lines() if line.strip()]


def test_A3_續問留在一般模式_同一個工作目錄(recorded, general_root):
    with TestClient(app) as client:
        token = auth._issue("tester")
        first = _ask(client, token, "conv-general-a3", "general")
        second = _ask(client, token, "conv-general-a3", "general")
    assert [e for e in first if e["type"] == "done"] and [e for e in second if e["type"] == "done"]
    a, b = recorded
    assert config.is_general(a["knowledge_base"]) and config.is_general(b["knowledge_base"])
    assert Path(a["workdir"]) == general_root / "tester"
    assert b["workdir"] == a["workdir"], "續問換了目錄,--resume 會找不到 session"
    assert a["is_new_conversation"] and not b["is_new_conversation"]
    assert b["claude_session_id"] == a["claude_session_id"]
    start = [e for e in first if e["type"] == "start"][0]
    assert start.get("knowledge_base") == "general", "前端靠這個認出這組是一般模式"


def test_從專案換到一般_重開_session(recorded, general_root):
    with TestClient(app) as client:
        token = auth._issue("tester")
        _ask(client, token, "conv-general-switch", config.DEFAULT_KNOWLEDGE_BASE)
        _ask(client, token, "conv-general-switch", "general")
    a, b = recorded
    assert not config.is_general(a["knowledge_base"])
    assert b["is_new_conversation"], "換到一般模式要重開 —— 舊 session 在專案的目錄底下"
    assert Path(b["workdir"]) == general_root / "tester"


@pytest.mark.parametrize("can_exec", [False, True])
def test_A4_工具照角色_一般模式不放寬(recorded, monkeypatch, can_exec):
    monkeypatch.setattr(auth, "has_perm", lambda user, perm: can_exec if perm == "ai_exec" else False)
    with TestClient(app) as client:
        token = auth._issue("tester")
        _ask(client, token, f"conv-general-a4-{can_exec}", "general")
    tools = recorded[0]["allowed_tools"]
    assert tools == (config.ALLOWED_TOOLS_FULL if can_exec else config.ALLOWED_TOOLS)
    assert ("Bash" in tools) is can_exec
