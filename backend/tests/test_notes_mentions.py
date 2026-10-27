# -*- coding: utf-8 -*-
"""@ 提及規則(notes._MENTION / parse_mentions)。

⚠️ 這些案例跟前端 `src/lib/__tests__/mentions.test.ts` 是**同一份契約**:
兩邊的 regex 必須逐字對齊,改任何一邊要讓兩份測試同時過。
"""
import pytest

from app import notes, users


@pytest.fixture(autouse=True)
def fake_users(monkeypatch):
    monkeypatch.setattr(
        users,
        "list_active",
        lambda: [
            {"username": "ming"},
            {"username": "ming2"},
            {"username": "sarah"},
        ],
    )


def test_chinese_adjacent_counts():
    # 中文打字不會在 @ 前面空一格
    assert notes.parse_mentions("請@ming看一下") == ["ming"]


def test_email_does_not_trigger():
    assert notes.parse_mentions("寄到 user@example.com") == []


def test_ming2_is_not_ming():
    assert notes.parse_mentions("@ming2 你看") == ["ming2"]


def test_case_insensitive_returns_canonical():
    assert notes.parse_mentions("@MING 你看") == ["ming"]


def test_order_preserved_and_deduped():
    assert notes.parse_mentions("@sarah @ming @sarah") == ["sarah", "ming"]


def test_unknown_is_plain_text():
    assert notes.parse_mentions("@nobody 在嗎") == []


def test_viewer_excluded():
    assert notes.parse_mentions("@ming @sarah", viewer="ming") == ["sarah"]
