# -*- coding: utf-8 -*-
"""好幾題同時換新登入憑證撞在一起,要自動重跑一次(實測三題同時問會全倒)。"""
import asyncio

from app import agent

RACE = (
    "Failed to refresh OAuth token: another Claude Code process is refreshing it "
    "or exited mid-refresh. This is usually transient; retry in a minute"
)


def _collect(gen):
    async def go():
        return [e async for e in gen]

    return asyncio.run(go())


def test_撞到換憑證就重跑一次_失敗那次不留痕跡(monkeypatch):
    calls = []

    async def fake_stream(**_kw):
        calls.append(1)
        yield {"type": "queued", "position": 1, "capacity": 2}
        yield {"type": "step", "kind": "init"}
        if len(calls) == 1:
            yield {"type": "done", "success": False, "answer": "", "error": RACE}
            return
        yield {"type": "delta", "text": "答案。"}
        yield {"type": "done", "success": True, "answer": "答案。", "error": None}

    async def no_wait(_s):
        return None

    monkeypatch.setattr(agent, "stream_agent", fake_stream)
    monkeypatch.setattr(agent.asyncio, "sleep", no_wait)
    events = _collect(agent.stream_agent_retrying())

    assert len(calls) == 2
    # 第一次的排隊照送(那是即時的),第一次的 step 與失敗的 done 都不送
    assert [e["type"] for e in events] == ["queued", "queued", "step", "delta", "done"]
    assert events[-1]["success"] is True


def _fake_writing_session(transcript, calls, seen_at_retry):
    """跟真的 claude 一樣:呼叫 API 之前就把這一題寫進逐字稿,第一次再撞換憑證失敗。"""

    async def fake_stream(**_kw):
        calls.append(1)
        if len(calls) == 2:
            seen_at_retry.append(transcript.read_text(encoding="utf-8") if transcript.exists() else None)
        with open(transcript, "a", encoding="utf-8") as f:
            f.write('{"type":"user","q":"這一題"}\n')
        if len(calls) == 1:
            yield {"type": "done", "success": False, "answer": "", "error": RACE}
            return
        yield {"type": "done", "success": True, "answer": "答案。", "error": None}

    return fake_stream


def _no_wait(monkeypatch):
    async def no_wait(_s):
        return None

    monkeypatch.setattr(agent.asyncio, "sleep", no_wait)


def test_新對話重跑前刪掉第一次留下的逐字稿(monkeypatch, tmp_path):
    """不刪的話同一個 --session-id 再跑會被擋:Session ID … is already in use(容器實測)。"""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    sid = "11111111-2222-3333-4444-555555555555"
    transcript = tmp_path / "projects" / "-srv-projects-prod" / f"{sid}.jsonl"
    transcript.parent.mkdir(parents=True)
    calls, seen = [], []
    monkeypatch.setattr(agent, "stream_agent", _fake_writing_session(transcript, calls, seen))
    _no_wait(monkeypatch)

    events = _collect(agent.stream_agent_retrying(claude_session_id=sid))

    assert len(calls) == 2
    assert seen == [None], "重跑時第一次的逐字稿還在"
    assert events[-1]["success"] is True


def test_續問重跑前把逐字稿截回原本的長度(monkeypatch, tmp_path):
    """不截的話,續問的逐字稿裡同一個問題會出現兩次。"""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    sid = "11111111-2222-3333-4444-666666666666"
    transcript = tmp_path / "projects" / "-srv-projects-prod" / f"{sid}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"type":"user","q":"上一題"}\n', encoding="utf-8")
    calls, seen = [], []
    monkeypatch.setattr(agent, "stream_agent", _fake_writing_session(transcript, calls, seen))
    _no_wait(monkeypatch)

    _collect(agent.stream_agent_retrying(claude_session_id=sid))

    assert seen == ['{"type":"user","q":"上一題"}\n']
    assert transcript.read_text(encoding="utf-8").count("這一題") == 1


def test_第二次還是失敗就照實回報(monkeypatch):
    calls = []

    async def fake_stream(**_kw):
        calls.append(1)
        yield {"type": "done", "success": False, "answer": "", "error": RACE}

    async def no_wait(_s):
        return None

    monkeypatch.setattr(agent, "stream_agent", fake_stream)
    monkeypatch.setattr(agent.asyncio, "sleep", no_wait)
    events = _collect(agent.stream_agent_retrying())

    assert len(calls) == 2
    assert events == [{"type": "done", "success": False, "answer": "", "error": RACE}]


def test_其他錯誤不重跑(monkeypatch):
    calls = []

    async def fake_stream(**_kw):
        calls.append(1)
        yield {"type": "step", "kind": "init"}
        yield {"type": "done", "success": False, "answer": "", "error": "別的錯誤"}

    monkeypatch.setattr(agent, "stream_agent", fake_stream)
    events = _collect(agent.stream_agent_retrying())

    assert len(calls) == 1
    assert [e["type"] for e in events] == ["step", "done"]


def test_已經開始作答就不壓事件(monkeypatch):
    async def fake_stream(**_kw):
        yield {"type": "step", "kind": "init"}
        yield {"type": "source", "tool": "Read", "target": "a.py"}
        yield {"type": "delta", "text": "答"}
        yield {"type": "done", "success": True, "answer": "答", "error": None}

    monkeypatch.setattr(agent, "stream_agent", fake_stream)
    events = _collect(agent.stream_agent_retrying())

    assert [e["type"] for e in events] == ["step", "source", "delta", "done"]
