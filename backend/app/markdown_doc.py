"""`docgen`(Word)與 `pdfgen`(PDF)共用的部分:Markdown 怎麼切成區塊、manifest 怎麼跑。

兩支吃的是同一份 `.md`、認的是同一套語法,差別只在區塊最後畫成什麼。所以切塊與
「讀清單 → 逐檔轉換 → 回報訊息」的骨架只寫在這裡,兩支各自只留輸出的部分 ——
語法規則或錯誤訊息改一處,Word 與 PDF 一起生效,不會一份認得、另一份照原字印。

認得的語法:`#`~`######`、段落、`-`/`*`/`+` 清單、`1.`/`1)` 編號、`|` 表格(第二行要是
`|---|`)、``` 程式碼區塊、`---`/`***`/`___` 分隔線、`\\pagebreak`;`quotes=True` 時另認 `>` 引用。
**其餘語法一律當段落文字** —— 看得懂比「安靜地漏掉」好。行內語法(粗體、等寬)由各輸出端處理。
"""

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Tuple, Union

from . import config, outputs_common

logger = logging.getLogger(__name__)

# 轉得動的來源。`.csv` 刻意不收:那是表格資料,該走 sheetgen 變成 Excel。
SOURCE_SUFFIXES = (".md", ".markdown", ".txt")

_TABLE_ROW = re.compile(r"^\s*\|(.+)\|\s*$")
# 表格的第二行(|---|:--:|),用來確認上一行真的是表頭而不是一句有 | 的話
_TABLE_SEP = re.compile(r"^\s*\|[\s:|-]+\|\s*$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")


@dataclass(frozen=True)
class Paragraph:
    """連續幾行一般文字,以空白接成一段。"""

    text: str


@dataclass(frozen=True)
class Heading:
    level: int
    text: str


@dataclass(frozen=True)
class Code:
    """程式碼區塊的各行,原樣保留(含縮排)。"""

    lines: Tuple[str, ...]


@dataclass(frozen=True)
class Table:
    """各列的儲存格。列可能長短不一 —— 模型寫的表格少一根 | 是常有的事,補齊是輸出端的事。"""

    rows: Tuple[Tuple[str, ...], ...]


@dataclass(frozen=True)
class Bullets:
    """連續的清單項目(中間沒有空行或其他區塊)。"""

    items: Tuple[str, ...]


@dataclass(frozen=True)
class Numbered:
    """一個編號項目,`number` 是原本寫的數字(照原數字印,不重新編號)。"""

    number: str
    text: str


@dataclass(frozen=True)
class Quote:
    """連續幾行 `>` 併成一段;空的引用行略過,所以 text 可能是空字串。"""

    text: str


@dataclass(frozen=True)
class Rule:
    """分隔線。"""


@dataclass(frozen=True)
class PageBreak:
    """`\\pagebreak`。"""


Block = Union[Paragraph, Heading, Code, Table, Bullets, Numbered, Quote, Rule, PageBreak]


def _split_row(line: str) -> Tuple[str, ...]:
    return tuple(c.strip() for c in _TABLE_ROW.match(line).group(1).split("|"))


def parse(markdown: str, quotes: bool = False) -> List[Block]:
    """把 Markdown 逐行切成區塊。`quotes=False` 時 `>` 開頭的行當一般文字。"""
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: List[Block] = []
    paragraph: List[str] = []
    bullets: List[str] = []

    def flush():
        if paragraph:
            blocks.append(Paragraph(" ".join(paragraph)))
            paragraph.clear()
        if bullets:
            blocks.append(Bullets(tuple(bullets)))
            bullets.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            flush()
            i += 1
            continue

        if stripped.startswith("```"):
            flush()
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            i += 1  # 收掉結尾的 ```
            blocks.append(Code(tuple(block)))
            continue

        if stripped in ("---", "***", "___"):
            flush()
            blocks.append(Rule())
            i += 1
            continue

        if stripped == "\\pagebreak":
            flush()
            blocks.append(PageBreak())
            i += 1
            continue

        heading = _HEADING.match(stripped)
        if heading:
            flush()
            blocks.append(Heading(len(heading.group(1)), heading.group(2)))
            i += 1
            continue

        # 表格:這一行是 |...|,而且下一行是 |---|
        if _TABLE_ROW.match(line) and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            flush()
            rows = [_split_row(line)]
            i += 2
            while i < len(lines) and _TABLE_ROW.match(lines[i]):
                rows.append(_split_row(lines[i]))
                i += 1
            blocks.append(Table(tuple(rows)))
            continue

        if quotes and _QUOTE.match(line):
            flush()
            quoted = []
            while i < len(lines) and _QUOTE.match(lines[i]):
                quoted.append(_QUOTE.match(lines[i]).group(1).strip())
                i += 1
            blocks.append(Quote(" ".join(q for q in quoted if q)))
            continue

        bullet = _BULLET.match(line)
        if bullet:
            if paragraph:
                blocks.append(Paragraph(" ".join(paragraph)))
                paragraph.clear()
            bullets.append(bullet.group(1))
            i += 1
            continue

        numbered = _NUMBERED.match(line)
        if numbered:
            flush()
            blocks.append(Numbered(numbered.group(1), numbered.group(2)))
            i += 1
            continue

        if bullets:
            blocks.append(Bullets(tuple(bullets)))
            bullets.clear()
        paragraph.append(stripped)
        i += 1

    flush()
    return blocks


Renderer = Callable[..., List[str]]


def apply_manifest(
    session_id: str,
    *,
    manifest_name: str,
    label: str,
    suffix: str,
    package: str,
    render: Renderer,
) -> List[str]:
    """把 `manifest_name` 點名的 Markdown 逐份用 `render` 轉成 `suffix` 檔,回傳要顯示給使用者的訊息。

    `label` 是訊息裡的格式名(「Word」「PDF」),`package` 是 `render` 要的函式庫
    (沒裝時講出要裝什麼)。`render(markdown, out_path, title=...)` 回傳訊息、失敗丟例外。

    任何一步失敗都只回訊息、不丟例外:這是收尾階段,答案已經算完了,
    不該因為產檔失敗把整題變成失敗。
    """
    session_dir = config.OUTPUT_DIR / session_id
    manifest = session_dir / manifest_name
    if not manifest.is_file():
        return []

    text, notices = outputs_common.read_manifest(manifest, label)
    for line in (text or "").splitlines():
        wanted = outputs_common.clean_line(line)
        if not wanted:
            continue
        # **只收檔名,不收路徑。** 這一層是「把這一題自己產出的檔案換個格式」,
        # 讀別的地方的檔案是 copy manifest 的事,那邊才有來源白名單。
        name = Path(wanted).name
        src = session_dir / name
        if not src.is_file() or Path(name).suffix.lower() not in SOURCE_SUFFIXES:
            notices.append("「%s」不是這一題產出的 Markdown 檔,沒有轉成 %s。" % (wanted, label))
            continue

        # **不可以直接用 `src.with_suffix(...)`。** 那會蓋掉同名的既有檔 ——
        # 最常見的情況是 copy manifest 剛把一份真的 `手冊.pdf` 複製進來,
        # 而模型又寫了 `手冊.md`:使用者要的正本會被轉出來的那份無聲蓋掉。
        dst = outputs_common.unique_path(session_dir, src.stem + suffix)
        try:
            notices.extend(
                render(src.read_text(encoding="utf-8", errors="replace"), dst, title=src.stem)
            )
        except ImportError:
            return notices + outputs_common.missing_package(package, label)
        except Exception as exc:  # noqa: BLE001 —— 收尾階段,不能讓它把整題弄成失敗
            logger.exception("%s 產出失敗 session=%s file=%s", label, session_id, name)
            notices.append(
                "「%s」轉成 %s 失敗:%s: %s(原本的檔案還是可以下載)"
                % (name, label, type(exc).__name__, exc)
            )
            outputs_common.discard_partial(dst)

    return notices
