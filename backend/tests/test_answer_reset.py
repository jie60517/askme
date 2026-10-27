# -*- coding: utf-8 -*-
"""`answer_reset` 要轉送到瀏覽器。

agent.py 在「模型又要去呼叫工具」時發這個事件,前端 runs.ts 收到會清掉過場話;
ask.py 的 `_execute` 沒轉送的話,過場話會留在畫面上,答完那一刻整段被換掉、版面跳一下。
"""
import asyncio

from app import runs
from app.routers import ask as ask_router


def test_answer_reset轉送到瀏覽器_停止時也不留過場話(monkeypatch):
    async def fake_stream(**_kw):
        yield {"type": "delta", "text": "我先找一下這支程式。"}
        yield {"type": "answer_reset"}
        yield {"type": "delta", "text": "答案。"}
        yield {"type": "done", "success": True, "answer": "答案。"}

    finalized = {}
    monkeypatch.setattr(ask_router.agent, "stream_agent", fake_stream)
    monkeypatch.setattr(ask_router, "_finalize", lambda run, result: finalized.update(result))

    run = runs.Run("run-x", "conv-x", 1, "q")
    asyncio.run(ask_router._execute(run))

    types = [e["type"] for e in run.events]
    assert types == ["delta", "answer_reset", "delta"], "answer_reset 沒送到瀏覽器"
    assert run.answer_parts == ["答案。"], "按停止時留下的部分答案不該包含過場話"
    assert finalized["answer"] == "答案。"

