"""專案 CLAUDE.md 範本要引入同一個資料夾裡的網頁情境規則副本。

headless 模式只載入 workdir 裡面的 @ 引入,所以每個專案的 workdir 放一份
`deploy/workdirs/RULES-web-context.md` 的副本,CLAUDE.md 用 `@./` 引入它;
範本寫錯的話,照範本建的專案規則都不會生效,而畫面上看不出來。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_claude_md_template_imports_the_local_copy():
    text = (ROOT / "deploy" / "workdirs" / "CLAUDE.template.md").read_text(encoding="utf-8")
    assert "@./RULES-web-context.md" in text
