# -*- coding: utf-8 -*-
"""每一步的流水帳(models.QAStep)。

守的是幾件「壞掉了畫面上看不出來」的事:

  1. **流水帳不去重**,而畫面上的 sources 要去重。兩份資料故意不一樣,
     哪天有人為了「省一份」把它們合併,這裡會紅。
  2. token 只從 assistant 訊息的 usage 拿得到,而 `usage` 的欄位名在 CLI 版本
     之間改過 —— 認不得的時候要留 None,**不能填 0**(0 看起來像「快取全中」)。
  3. 真的刪掉問答紀錄時流水帳要跟著消失。bulk delete 不經過 ORM,
     只有資料庫自己的 ON DELETE CASCADE 擋得住。
  4. 「這題算誰問的」只有一條規則:總覽排行榜的分組鍵跟明細頁的篩選鍵必須一致,
     不然點進去看到的題數跟排行上那個數字會對不起來(見 routers/stats._asker)。
  5. **答案只留最後一次工具呼叫之後寫的東西。** 工具之間的自言自語跟答案一樣
     都是 text_delta,接在一起就是使用者看到的第一行(見 agent.answer_start_index)。
"""
import json

from app import agent, models
from app.database import SessionLocal


def _stream_lines(*payloads):
    """把幾個事件包成 claude CLI 的 stream-json(一行一個 JSON)。"""
    return "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in payloads)


def _tool_use_events(index, name, tool_input, tool_id=None):
    """一次完整的工具呼叫:start → input_json_delta → stop。"""
    return [
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": index,
                "content_block": {
                    "type": "tool_use",
                    "name": name,
                    "id": tool_id or f"toolu_{index}",
                },
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": index,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": json.dumps(tool_input, ensure_ascii=False),
                },
            },
        },
        {"type": "stream_event", "event": {"type": "content_block_stop", "index": index}},
    ]


def _text(index, text):
    """一段串流出來的文字:start → text_delta → stop。"""
    return [
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": index,
                "content_block": {"type": "text"},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": index,
                "delta": {"type": "text_delta", "text": text},
            },
        },
        {"type": "stream_event", "event": {"type": "content_block_stop", "index": index}},
    ]


def _tool_result(tool_use_id):
    """工具跑完之後 CLI 送回來的那則 user 訊息。"""
    return {
        "type": "user",
        "message": {"content": [{"type": "tool_result", "tool_use_id": tool_use_id}]},
    }


def _assistant(usage, model="claude-opus-5", parent=None):
    event = {
        "type": "assistant",
        "message": {"model": model, "content": [], "usage": usage},
    }
    if parent:
        event["parent_tool_use_id"] = parent
    return event


# ─────────────────────────────────────────────── usage 解析

def test_usage_missing_fields_stay_none_not_zero():
    """認不得的欄位留 None。填 0 的話,事後看到一輪 input=0 會以為快取全中。"""
    step = agent._describe_usage({"usage": {"output_tokens": 12}, "model": "m"}, None)
    assert step["output_tokens"] == 12
    assert step["input_tokens"] is None
    assert step["cache_read_tokens"] is None


def test_usage_reads_cache_fields():
    step = agent._describe_usage(
        {
            "model": "claude-opus-5",
            "usage": {
                "input_tokens": 7,
                "output_tokens": 130,
                "cache_read_input_tokens": 14428,
                "cache_creation_input_tokens": 900,
            },
        },
        None,
    )
    assert step == {
        "kind": "turn",
        "model": "claude-opus-5",
        "input_tokens": 7,
        "output_tokens": 130,
        "cache_read_tokens": 14428,
        "cache_creation_tokens": 900,
    }


def test_usage_without_any_tokens_is_skipped():
    """沒帶 usage 的訊息不記 —— 寧可少一列,也不要一列全是 None 的空帳。"""
    assert agent._describe_usage({"model": "m", "content": []}, None) is None
    assert agent._describe_usage({"model": "m", "usage": "nope"}, None) is None


def test_subagent_turn_is_marked_separately():
    """子代理的模型呼叫要花錢,但不是主線的一輪,混在一起算「跑了幾輪」會失真。"""
    step = agent._describe_usage(
        {"model": "m", "usage": {"input_tokens": 1, "output_tokens": 2}}, "toolu_abc"
    )
    assert step["kind"] == "subturn"


# ─────────────────────────────────────────────── 串流:去重 vs 流水帳

async def _collect(monkeypatch, payloads):
    """跑一次 stream_agent,把事件收成 list。claude 子行程用假的 cat 取代。"""
    line_bytes = _stream_lines(*payloads).encode("utf-8")

    class FakeStdout:
        def __init__(self, data):
            self._lines = data.splitlines(keepends=True)
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
            self.stdout = FakeStdout(line_bytes)
            self.stderr = FakeStderr()

        def kill(self):
            pass

        async def wait(self):
            return 0

    async def fake_exec(*_args, **_kwargs):
        return FakeProc()

    import asyncio

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = []
    async for event in agent.stream_agent(
        question="這支程式在做什麼",
        session_id="testsid",
        conversation_id="conv-1",
        is_new_conversation=True,
        claude_session_id="00000000-0000-4000-8000-000000000001",
        allowed_tools="Read,Grep,Glob",
    ):
        events.append(event)
    return events


def test_repeated_reads_appear_in_steps_but_not_in_sources(monkeypatch):
    """**同一個檔讀三次**:sources 只出現一次(畫面用),steps 出現三次(查成本用)。

    這是這整張表存在的理由。合併成一份資料的話,兩邊必有一邊是錯的。
    """
    import asyncio

    payloads = []
    for i in range(3):
        payloads += _tool_use_events(i, "Read", {"file_path": "/tmp/checkout.py"})
    payloads.append(_assistant({"input_tokens": 5, "output_tokens": 50}))
    payloads.append({"type": "result", "is_error": False, "total_cost_usd": 0.5})

    events = asyncio.run(_collect(monkeypatch, payloads))

    sources = [e for e in events if e["type"] == "source"]
    tool_steps = [e for e in events if e["type"] == "step" and e["kind"] == "tool"]
    turn_steps = [e for e in events if e["type"] == "step" and e["kind"] == "turn"]

    assert len(sources) == 1, "畫面上的執行過程要去重"
    assert len(tool_steps) == 3, "流水帳不去重 —— 讀三次就是三列"
    assert len(turn_steps) == 1
    assert turn_steps[0]["output_tokens"] == 50


def test_steps_are_numbered_in_order_and_grouped_by_turn(monkeypatch):
    """工具掛在**發動它的那一輪**上,而 assistant 訊息是後到的(串流順序如此)。"""
    import asyncio

    payloads = (
        _tool_use_events(0, "Grep", {"path": "/tmp", "pattern": "checkout"})
        + [_assistant({"input_tokens": 3, "output_tokens": 10})]
        + _tool_use_events(1, "Read", {"file_path": "/tmp/a.py"})
        + [_assistant({"input_tokens": 4000, "output_tokens": 20})]
        + [{"type": "result", "is_error": False, "total_cost_usd": 1.0}]
    )
    events = asyncio.run(_collect(monkeypatch, payloads))
    steps = [e for e in events if e["type"] == "step"]

    assert [s["seq"] for s in steps] == [0, 1, 2, 3]
    assert [(s["kind"], s["turn"]) for s in steps] == [
        ("tool", 0),
        ("turn", 0),
        ("tool", 1),
        ("turn", 1),
    ]


# ─────────────────────────────────────────────── 刪除連動

def test_deleting_a_record_deletes_its_steps():
    """bulk delete 不經過 ORM —— 靠的是資料庫的 ON DELETE CASCADE。

    少了它會直接撞 FOREIGN KEY constraint failed(連線有開 foreign_keys),
    症狀是刪除時 500,而不是留下孤兒列。
    """
    from app.main import init_database

    init_database()
    db = SessionLocal()
    try:
        record = models.QARecord(
            session_id="sid-cascade", conversation_id="conv-cascade",
            question="q", answer="a",
        )
        db.add(record)
        db.commit()
        # 先把 id 抓成純值:commit 之後再去讀 record.id 會觸發 refresh,
        # 而那一列已經被下面刪掉了(ObjectDeletedError)。
        rid = record.id
        db.add(models.QAStep(qa_record_id=rid, seq=0, turn=0, kind="tool", tool="Read"))
        db.commit()
        assert db.query(models.QAStep).filter_by(qa_record_id=rid).count() == 1

        db.query(models.QARecord).filter(models.QARecord.id == rid).delete(
            synchronize_session=False
        )
        db.commit()
        assert db.query(models.QAStep).filter_by(qa_record_id=rid).count() == 0
    finally:
        db.close()

# ─────────────────────────────────────────────── 每一步真正花多久

def test_tool_duration_comes_from_tool_result_not_from_at_ms(monkeypatch):
    """耗時要**等 tool_result 回來**才算得出來,不能拿 at_ms 相減。

    `content_block_stop` 只代表「模型把這通呼叫寫完了」,工具是在整則 assistant
    訊息結束之後才跑的 —— 相鄰兩個 tool_use 的 at_ms 差,量到的是模型吐字的速度。
    """
    import asyncio

    payloads = (
        _tool_use_events(0, "Read", {"file_path": "/tmp/a.py"}, tool_id="toolu_a")
        + [_assistant({"input_tokens": 3, "output_tokens": 10})]
        + [_tool_result("toolu_a")]
        + [{"type": "result", "is_error": False, "total_cost_usd": 1.0}]
    )
    events = asyncio.run(_collect(monkeypatch, payloads))

    tool_step = next(e for e in events if e["type"] == "step" and e["kind"] == "tool")
    assert tool_step["tool_use_id"] == "toolu_a"

    durations = [e for e in events if e["type"] == "step_duration"]
    assert len(durations) == 1
    assert durations[0]["tool_use_id"] == "toolu_a"
    assert durations[0]["duration_ms"] >= 0


def test_tool_without_result_gets_no_duration(monkeypatch):
    """沒等到 tool_result(被停止、逾時)就不補耗時 —— NULL 是事實,0 是謊。"""
    import asyncio

    payloads = _tool_use_events(0, "Read", {"file_path": "/tmp/a.py"}, tool_id="toolu_x") + [
        {"type": "result", "is_error": False, "total_cost_usd": 0.1}
    ]
    events = asyncio.run(_collect(monkeypatch, payloads))
    assert [e for e in events if e["type"] == "step_duration"] == []


def test_unknown_tool_result_is_ignored(monkeypatch):
    """對不到 id 的 tool_result 直接略過,不要讓串流因為這種事出錯。"""
    import asyncio

    payloads = [_tool_result("toolu_never_seen"), {"type": "result", "is_error": False}]
    events = asyncio.run(_collect(monkeypatch, payloads))
    assert [e for e in events if e["type"] == "step_duration"] == []


# ─────────────────────────────────────────────── 「這題算誰問的」只有一條規則

def test_ranking_and_detail_use_the_same_asker_rule():
    """排行榜的分組鍵跟明細頁的篩選鍵必須是同一條規則。

    不一致的話(例如排行照 `owner` 分組、明細照 `coalesce(asked_by, owner)` 篩),
    共用對話裡別人續問的那幾題,在排行上算原作者、在明細裡算送出的人,
    點進去看到的題數跟排行那個數字對不起來,而畫面上完全看不出是哪邊錯。
    """
    from app.main import init_database
    from app.routers import stats

    init_database()
    db = SessionLocal()
    try:
        # arnold 在 alice 的共用對話裡續問一題:owner=alice,但真正問的人是 arnold
        db.add(
            models.QARecord(
                session_id="sid-asker", conversation_id="conv-asker",
                question="q", answer="a", owner="alice", asked_by="arnold",
            )
        )
        # alice 自己問的一題(舊格式:asked_by 是 NULL)
        db.add(
            models.QARecord(
                session_id="sid-asker2", conversation_id="conv-asker2",
                question="q2", answer="a2", owner="alice", asked_by=None,
            )
        )
        db.commit()

        by_user = stats.get_stats(granularity="day", start=None, end=None, db=db).by_user
        detail = stats.list_questions(user="arnold", limit=50, offset=0, db=db)

        assert by_user.get("arnold") == 1, "排行要把續問那題算給送出的人"
        assert by_user.get("alice") == 1, "原作者只剩自己問的那一題"
        assert detail.total == by_user["arnold"], "點進去的題數要跟排行上那個數字一致"
    finally:
        db.close()


# ─────────────────────────────────────────── 答案 vs 工具之間的自言自語

def test_answer_drops_the_narration_between_tool_calls(monkeypatch):
    """工具之間講的話不是答案。

    不切的話,答案的第一行會是一串過場話,例如
        「I'll look up this program…找它的原始碼與藍圖。檢查實際的檔案…## 結論」
    一題常常有幾十次模型呼叫,那串可以很長 —— 而畫面上另外有一塊「執行過程」
    已經在講它翻了什麼。
    """
    import asyncio

    payloads = (
        _text(0, "I'll look up this program.")
        + _tool_use_events(1, "Grep", {"pattern": "group_config"})
        + [_tool_result("toolu_1")]
        + _text(2, "找它的原始碼與藍圖。")
        + _tool_use_events(3, "Read", {"file_path": "/srv/app/src/config/group_config.py"})
        + [_tool_result("toolu_3")]
        + _text(4, "## 結論\n\n它是集團控管設定。")
        + [_assistant({"input_tokens": 5, "output_tokens": 50})]
        + [{"type": "result", "is_error": False, "total_cost_usd": 0.5}]
    )

    events = asyncio.run(_collect(monkeypatch, payloads))
    done = [e for e in events if e["type"] == "done"][0]

    assert done["answer"] == "## 結論\n\n它是集團控管設定。"
    assert "I'll" not in done["answer"], "英文開場白是最容易漏的那一種"
    assert "藍圖" not in done["answer"]

    # 前端的答案是靠 delta 累積的,光切後端不夠 —— 畫面上那幾句也要收回去,
    # 否則串流當下看得到、重新整理之後又不見了。
    assert len([e for e in events if e["type"] == "answer_reset"]) == 2


def test_answer_is_kept_whole_when_no_tool_was_used(monkeypatch):
    """沒查任何東西就直接回答的題目,一個字都不能少。"""
    import asyncio

    payloads = (
        _text(0, "這個問題我直接回答:")
        + _text(1, "答案是 A。")
        + [_assistant({"input_tokens": 5, "output_tokens": 10})]
        + [{"type": "result", "is_error": False, "total_cost_usd": 0.1}]
    )

    events = asyncio.run(_collect(monkeypatch, payloads))
    done = [e for e in events if e["type"] == "done"][0]

    assert done["answer"] == "這個問題我直接回答:答案是 A。"
    assert not [e for e in events if e["type"] == "answer_reset"]


def test_answer_falls_back_to_everything_when_the_last_turn_is_silent(monkeypatch):
    """最後一輪一個 text_delta 都沒有時,寧可連過程一起給,也不要送空白回答出去。

    使用者分不出「它沒答」跟「它答了但被我切掉」—— 後者看起來就是壞了。
    """
    import asyncio

    payloads = (
        _text(0, "先看看這支程式。")
        + _tool_use_events(1, "Read", {"file_path": "/tmp/a.py"})
        + [_tool_result("toolu_1")]
        + [_assistant({"input_tokens": 5, "output_tokens": 10})]
        + [{"type": "result", "is_error": False, "total_cost_usd": 0.1}]
    )

    events = asyncio.run(_collect(monkeypatch, payloads))
    done = [e for e in events if e["type"] == "done"][0]

    assert done["answer"] == "先看看這支程式。"


# ─────────────────────────────────────────────── 聊天頁的執行過程:畫工具真正的耗時

def test_source_event_carries_tool_use_id(monkeypatch):
    """畫面用的 source 要帶 tool_use_id,晚到的 step_duration 才補得回同一列。"""
    import asyncio

    payloads = (
        _tool_use_events(0, "Read", {"file_path": "/tmp/a.py"}, tool_id="toolu_a")
        + [_assistant({"input_tokens": 3, "output_tokens": 10})]
        + [_tool_result("toolu_a")]
        + [{"type": "result", "is_error": False, "total_cost_usd": 1.0}]
    )
    events = asyncio.run(_collect(monkeypatch, payloads))
    source = next(e for e in events if e["type"] == "source")
    assert source["tool_use_id"] == "toolu_a"


def test_tool_duration_is_written_back_to_steps_and_sources():
    """step_duration 補兩個地方:流水帳(題目明細)與畫面用的 sources,並通知正在看的人。

    耗時是工具自己跑的時間,不是「到下一步之前」(那樣算的話,最後一步會一路算到
    答案寫完,零點幾秒的工具會顯示成十幾秒)。
    """
    from types import SimpleNamespace

    from app.routers.ask import _record_tool_duration

    emitted = []
    run = SimpleNamespace(
        steps=[{"tool_use_id": "toolu_a"}, {"tool_use_id": "toolu_b"}],
        sources=[{"tool": "Read", "target": "a.py", "tool_use_id": "toolu_a"}],
        emit=emitted.append,
    )
    _record_tool_duration(run, {"type": "step_duration", "tool_use_id": "toolu_a", "duration_ms": 282})

    assert run.steps[0]["duration_ms"] == 282
    assert "duration_ms" not in run.steps[1]
    assert run.sources[0]["duration_ms"] == 282
    assert emitted == [{"type": "source_duration", "tool_use_id": "toolu_a", "duration_ms": 282}]

    # 去重過的 sources 裡沒有那一列(同一個目標第二次呼叫):只補流水帳,不 emit
    _record_tool_duration(run, {"type": "step_duration", "tool_use_id": "toolu_b", "duration_ms": 50})
    assert run.steps[1]["duration_ms"] == 50
    assert len(emitted) == 1
