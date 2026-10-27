# -*- coding: utf-8 -*-
"""同時進來的問答:名額怎麼排、同一組對話怎麼擋。

前半守的是併發名額(`agent._Lane`):排隊時送出的 `capacity` 與順位要對得上
那條隊伍,每人一道名額不能讓先排的人被插隊。

後半守的是 `runs.conversation_gate`:同一組對話的「檢查 + 登記」是一段不可
被 await 切開的動作,不然同一個 claude session 會被兩個行程同時 `--resume`。
"""
import asyncio
import json

from app import agent, runs


def _lane(monkeypatch, capacity: int):
    """把名額換成這個測試自己的,不要動到模組層那一組(其他測試也在用)。"""
    lane = agent._Lane(capacity)
    monkeypatch.setattr(agent, "_ASK_LANE", lane)
    return lane


def _occupy(lane, n: int, user=None):
    """模擬已經有 n 題在跑(要在 event loop 裡呼叫)。"""
    tickets = [lane.enter(user) for _ in range(n)]
    assert all(t.granted.done() for t in tickets), "_occupy 只用在還有空位的時候"
    return tickets


def _free(lane, tickets):
    for t in tickets:
        lane.leave(t)


def _fake_subprocess(monkeypatch):
    """把 claude 子行程換成「馬上回一則 result 就結束」的假貨。

    這裡要驗的是名額,不是串流解析 —— 真的去起子行程的話,這幾條測試在
    沒有 claude CLI 的機器上會變成在測「起不起得來」。
    """
    line_bytes = (json.dumps({"type": "result", "is_error": False}) + "\n").encode("utf-8")

    class FakeStdout:
        def __init__(self):
            self._lines = [line_bytes]
            self._i = 0

        async def readline(self):
            if self._i >= len(self._lines):
                return b""
            line = self._lines[self._i]
            self._i += 1
            return line

    class FakeStderr:
        async def read(self, _n):
            return b""

    class FakeStdin:
        """問題從 stdin 送進來(agent.feed_stdin):收下就好"""

        def write(self, _data):
            pass

        async def drain(self):
            pass

        def close(self):
            pass

    class FakeProc:
        returncode = 0

        def __init__(self):
            self.stdin = FakeStdin()
            self.stdout = FakeStdout()
            self.stderr = FakeStderr()

        def kill(self):
            pass

        async def wait(self):
            return 0

    async def fake_exec(*_args, **_kwargs):
        return FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)


def test_queue_position_and_capacity(monkeypatch):
    """名額滿了要排隊:順位從 1 開始算,capacity 是這一組的容量。"""
    lane = _lane(monkeypatch, 1)
    _fake_subprocess(monkeypatch)

    async def scenario():
        held = _occupy(lane, 1)
        gen = agent.stream_agent(
            question="同仁的題目",
            session_id="staff-sid",
            conversation_id="conv-lane",
            is_new_conversation=True,
            claude_session_id="00000000-0000-4000-8000-000000000002",
            allowed_tools="Read",
        )
        try:
            return await gen.__anext__()
        finally:
            await gen.aclose()
            _free(lane, held)

    assert asyncio.run(scenario()) == {"type": "queued", "position": 1, "capacity": 1}


# ─────────────────────────────────── 每人一道名額(全站之外)


def _gen(asker, sid: str):
    return agent.stream_agent(
        question="q",
        session_id=sid,
        conversation_id=f"conv-{sid}",
        is_new_conversation=True,
        claude_session_id="00000000-0000-4000-8000-000000000009",
        allowed_tools="Read",
        asker=asker,
    )


def test_per_user_limit_queues_only_that_user(monkeypatch):
    """自己滿了自己排隊,別人照跑;排隊的那題沒有先佔走全站的名額。"""
    lane = agent._Lane(10, per_user=2)
    monkeypatch.setattr(agent, "_ASK_LANE", lane)
    _fake_subprocess(monkeypatch)

    async def scenario():
        held = _occupy(lane, 2, "alice")
        gen = _gen("alice", "a3")
        try:
            first = await gen.__anext__()
            active_while_queued = lane.active
            bob_events = [e async for e in _gen("bob", "b1")]
        finally:
            await gen.aclose()
            _free(lane, held)
        return first, active_while_queued, bob_events

    first, active_while_queued, bob_events = asyncio.run(scenario())

    # capacity 送的是這一組(全站)的:只有一條隊伍
    assert first == {"type": "queued", "position": 1, "capacity": 10}
    assert active_while_queued == 2, "卡在自己上限的那一題不能先佔全站的名額"
    assert not [e for e in bob_events if e["type"] == "queued"], "別人不該因為 alice 滿了而排隊"
    assert [e for e in bob_events if e["type"] == "done"]


def test_per_user_queue_runs_when_own_slot_frees(monkeypatch):
    """自己前一題結束,排隊的那題接著跑;跑完計數歸零、隊伍清空。"""
    lane = agent._Lane(10, per_user=1)
    monkeypatch.setattr(agent, "_ASK_LANE", lane)
    _fake_subprocess(monkeypatch)

    async def scenario():
        held = _occupy(lane, 1, "alice")
        gen = _gen("alice", "a2")
        first = await gen.__anext__()
        _free(lane, held)
        rest = [e async for e in gen]
        return first, rest

    first, rest = asyncio.run(scenario())

    assert first["type"] == "queued"
    assert [e for e in rest if e["type"] == "done"]
    assert lane.active == 0
    assert lane.active_by_user == {}, "跑完的人要從計數裡拿掉,不然這份 dict 只會長"
    assert lane.waiting == []


def test_queued_cancel_leaves_counts_untouched(monkeypatch):
    """排隊中被取消:號碼牌拿掉,計數不多不少。"""
    lane = agent._Lane(10, per_user=1)
    monkeypatch.setattr(agent, "_ASK_LANE", lane)
    _fake_subprocess(monkeypatch)

    async def scenario():
        held = _occupy(lane, 1, "alice")
        gen = _gen("alice", "a2")
        await gen.__anext__()
        await gen.aclose()
        counts = (lane.active, dict(lane.active_by_user), list(lane.waiting))
        _free(lane, held)
        return counts

    counts = asyncio.run(scenario())

    assert counts == (1, {"alice": 1}, [])


def test_own_turn_is_not_jumped_by_later_arrivals():
    """自己那題一可以跑,就排在比它晚來的人前面;後面的人順位只降不跳。

    疊兩把 semaphore 的寫法在這裡會錯:alice 先排完自己那把,再排到全站隊尾,
    dave 明明比較晚來卻先跑。
    """
    lane = agent._Lane(2, per_user=1)

    async def scenario():
        alice_running = _occupy(lane, 1, "alice")
        carol_running = _occupy(lane, 1, "carol")
        alice_next = lane.enter("alice")   # 自己滿、全站也滿
        dave = lane.enter("dave")          # 全站滿
        before = lane.position(dave)
        _free(lane, alice_running)         # 全站空一位,alice 自己也空了
        return alice_next.granted.done(), dave.granted.done(), before, lane.position(dave), carol_running

    alice_ran, dave_ran, before, after, _ = asyncio.run(scenario())

    assert alice_ran and not dave_ran
    assert (before, after) == (2, 1)


def test_user_at_own_limit_does_not_block_others():
    """自己滿了的人排在前面,不會擋住後面還沒滿的人。"""
    lane = agent._Lane(3, per_user=1)

    async def scenario():
        _occupy(lane, 1, "alice")
        alice_next = lane.enter("alice")
        bob = lane.enter("bob")
        return alice_next.granted.done(), bob.granted.done(), lane.position(alice_next)

    alice_ran, bob_ran, alice_pos = asyncio.run(scenario())

    assert not alice_ran and bob_ran
    assert alice_pos == 1


def test_no_user_is_not_counted_per_user():
    """不帶 asker 的題目只受全站名額限制,不算人頭(`stream_agent` 的 asker 預設是 None)。"""
    lane = agent._Lane(5, per_user=1)

    async def scenario():
        tickets = [lane.enter(None) for _ in range(5)]
        return [t.granted.done() for t in tickets], dict(lane.active_by_user)

    granted, by_user = asyncio.run(scenario())

    assert granted == [True] * 5
    assert by_user == {}


# ─────────────────────────────────── 同一組對話同時只能有一題在跑


def test_conversation_gate_lets_only_one_request_register(monkeypatch):
    """兩個請求同時對同一組對話送出:只有一個登記得成,另一個要看到 409。

    中間那個 `await` 代表 `save_uploads_async()` —— 守衛與 `register()` 之間
    真正隔著的東西。沒有這道鎖的話兩邊都會通過守衛,然後對同一個 claude
    session 各起一次 `--resume`。
    """
    monkeypatch.setattr(runs, "_runs", {})
    conv_id = "conv-race"

    async def attempt(run_id: str, outcome: list):
        async with runs.conversation_gate(conv_id):
            if runs.active_for_conversation(conv_id) is not None:
                outcome.append("409")
                return
            await asyncio.sleep(0)  # ← 存附件那段
            runs.register(
                runs.Run(run_id=run_id, conversation_id=conv_id, record_id=1, question="q")
            )
            outcome.append("registered")

    async def scenario():
        outcome: list = []
        await asyncio.gather(attempt("a", outcome), attempt("b", outcome))
        return outcome

    outcome = asyncio.run(scenario())

    assert sorted(outcome) == ["409", "registered"]
    assert len(runs._runs) == 1
    # 鎖用完要清掉,不然這份 dict 會跟著對話數一直長
    assert conv_id not in runs._conversation_locks
