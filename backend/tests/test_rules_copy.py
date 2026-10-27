"""範例專案自帶的網頁情境規則要跟正本一致。

headless 模式只載入 workdir 裡面的 @ 引入,所以範例專案放的是副本;改正本忘了改副本,
範例專案的回答就會照舊規則走,而畫面上看不出來。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_example_rules_match_the_canonical_copy():
    canonical = (ROOT / "deploy" / "workdirs" / "RULES-web-context.md").read_text(encoding="utf-8")
    copy = (ROOT / "workspace" / "example" / "RULES-web-context.md").read_text(encoding="utf-8")
    assert copy == canonical


def test_example_claude_md_imports_the_local_copy():
    text = (ROOT / "workspace" / "example" / "CLAUDE.md").read_text(encoding="utf-8")
    assert "@./RULES-web-context.md" in text
