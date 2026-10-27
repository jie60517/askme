# -*- coding: utf-8 -*-
"""額度快照(`app/usage_limit.py`)。

剖析器與快取各自釘住 —— `/usage` 的輸出格式是 CLI 給的,升版就可能變,
而「變了之後哪裡壞」要靠這裡在第一時間指出來,不是靠使用者回報小夥伴不講話。
"""
import asyncio

import pytest

from app import usage_limit


# ---------------------------------------------------------------- 剖析器


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Resets in 2h 15m", 135),
        ("resets in 45m", 45),
        ("Resets in 3h", 180),  # 只有小時、沒有分鐘也要認得
        ("重置於 2 小時 15 分", 135),
        ("重置於 2 小時", 120),
        # ⚠️ 「3 messages」的 m 後面不是字界,不能被當成 3 分鐘
        ("Resets in 2h ... 3 messages", 120),
        ("Resets at 3:00pm", None),  # 絕對時刻刻意不解析
        ("nothing to see", None),
        ("Resets in 0m", None),  # 0 不是一個可以唸的數字
        ("Resets in 2h30m", 150),  # 沒空格:h 後面是數字,不能靠字界
    ],
)
def test_reset_minutes(text, expected):
    assert usage_limit._find_reset_minutes(text) == expected


def test_parse_usage_full():
    snapshot = usage_limit.parse_usage("Current session: 45% used\nResets in 2h 15m")
    assert snapshot == {"used_percent": 45, "remaining_percent": 55, "resets_in_minutes": 135}


def test_parse_usage_without_reset_keeps_percent():
    # 重置時間剖不出來只是那一半留 None,百分比照樣要回
    assert usage_limit.parse_usage("Session usage 12%") == {
        "used_percent": 12,
        "remaining_percent": 88,
        "resets_in_minutes": None,
    }


def test_parse_usage_without_percent_is_none():
    # 沒有百分比就整份 None —— 寧可不講,也不要編一個數字
    assert usage_limit.parse_usage("Resets in 2h") is None
    assert usage_limit.parse_usage("") is None


def test_percent_must_sit_on_a_usage_line():
    """安全條件:百分比那一行要看得出來是在講額度(見 _USAGE_LINE_KEYWORDS)。

    CLI 若把 /usage 當一般提示丟給模型,回來的是一段回答 ——
    「我 100% 確定幫不上忙」不能被唸成額度。
    """
    assert usage_limit.parse_usage("I am 100% sure I cannot help with that.") is None
    assert usage_limit.parse_usage("Model reply\nSession usage: 42%")["used_percent"] == 42


def test_usage_argv_has_every_guard():
    """那幾道閘門一道都不能少(理由見 usage_argv 的 docstring)。"""
    argv = usage_limit.usage_argv()
    assert argv[-2:] == ["--", "/usage"]
    assert argv[argv.index("--allowedTools") + 1] == ""
    assert "--disallowedTools" in argv
    assert argv[argv.index("--max-budget-usd") + 1] == "0.01"
    assert argv[argv.index("--model") + 1] == "haiku"


def test_parse_usage_rejects_out_of_range_percent():
    # 「250%」不是使用率,跳過它去找下一個
    assert usage_limit.parse_usage("scale 250%, used 30%")["used_percent"] == 30


# ---------------------------------------------------------------- 快取


@pytest.fixture
def fresh_cache(monkeypatch):
    monkeypatch.setattr(usage_limit, "_cache", None)
    monkeypatch.setattr(usage_limit, "_cache_at", 0.0)
    monkeypatch.setattr(usage_limit, "_lock", asyncio.Lock())


def test_failed_read_is_cached_too(fresh_cache, monkeypatch):
    """CLI 壞掉時**不能**每一題都再試一次。

    只看 `_cache is not None and 還新鮮` 是不夠的:失敗時 `_cache` 正是 None,
    故障期間每一題答完都會再起一個子行程、各等滿 TIMEOUT_SEC。
    """
    calls = []

    async def failing():
        calls.append(1)
        return None

    monkeypatch.setattr(usage_limit, "_run_usage_command", failing)

    async def run():
        assert await usage_limit.read_usage_limit() is None
        assert await usage_limit.read_usage_limit() is None

    asyncio.run(run())
    assert len(calls) == 1, "讀不到也要記時間,TTL 內不該再跑一次子行程"


def test_successful_read_is_shared_within_ttl(fresh_cache, monkeypatch):
    calls = []

    async def ok():
        calls.append(1)
        return {"used_percent": 10, "remaining_percent": 90, "resets_in_minutes": 5}

    monkeypatch.setattr(usage_limit, "_run_usage_command", ok)

    async def run():
        first = await usage_limit.read_usage_limit()
        second = await usage_limit.read_usage_limit()
        assert first == second

    asyncio.run(run())
    assert len(calls) == 1


def test_expired_cache_reruns(fresh_cache, monkeypatch):
    calls = []

    async def ok():
        calls.append(1)
        return {"used_percent": len(calls), "remaining_percent": 0, "resets_in_minutes": None}

    monkeypatch.setattr(usage_limit, "_run_usage_command", ok)

    async def run():
        await usage_limit.read_usage_limit()
        # 把上一次的時間撥到 TTL 之前
        monkeypatch.setattr(usage_limit, "_cache_at", usage_limit._cache_at - usage_limit.CACHE_TTL_SEC - 1)
        again = await usage_limit.read_usage_limit()
        assert again["used_percent"] == 2

    asyncio.run(run())
    assert len(calls) == 2


def test_snapshot_has_no_delta():
    """「這一題用了幾 %」不在後端算(理由見 read_usage_limit 的 docstring)。"""
    snapshot = usage_limit.parse_usage("30% used, resets in 1h")
    assert "delta_percent" not in snapshot


def test_fresh_read_skips_a_successful_cache(fresh_cache, monkeypatch):
    """答完那一次要的是現在的水位:成功的快取不算數,一定重跑。"""
    calls = []

    async def ok():
        calls.append(1)
        return {"used_percent": len(calls) * 10, "remaining_percent": 0, "resets_in_minutes": None}

    monkeypatch.setattr(usage_limit, "_run_usage_command", ok)

    async def run():
        first = await usage_limit.read_usage_limit()
        second = await usage_limit.read_usage_limit(fresh=True)
        assert first["used_percent"] == 10 and second["used_percent"] == 20

    asyncio.run(run())
    assert len(calls) == 2


def test_fresh_read_still_respects_a_failed_cache(fresh_cache, monkeypatch):
    """CLI 壞掉時 fresh 也不該再等一次 TIMEOUT_SEC —— 失敗的快取照樣算數。"""
    calls = []

    async def failing():
        calls.append(1)
        return None

    monkeypatch.setattr(usage_limit, "_run_usage_command", failing)

    async def run():
        assert await usage_limit.read_usage_limit() is None
        assert await usage_limit.read_usage_limit(fresh=True) is None

    asyncio.run(run())
    assert len(calls) == 1


def test_usage_limit_endpoint_requires_login():
    from fastapi.testclient import TestClient

    from app.main import app

    resp = TestClient(app).get("/api/usage-limit")
    assert resp.status_code in (401, 403), "額度是主機的營運資訊,不該給路人看"
