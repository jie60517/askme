"""把 claude 整理出來的資料轉成 PowerPoint 簡報(.pptx)。

跟 `sheetgen`(Excel)、`pdfgen`(PDF)同一個理由:.pptx 是一包 zip,
Write 工具寫不出來,而網頁的一般帳號沒有 Bash 跑不了 python-pptx。

⚠️ **只收 JSON,絕不收 Python。** 讓模型寫程式再由後端執行,等於開放任意程式碼執行。

`__slides__.json` 的形狀寫在下面的 `PROMPT_SHAPE` —— 版面只有三種,刻意不給模型
更多選擇。**那個字串就是教模型的那份**(`agent.build_prompt` 直接引用它),
不要在別處另外寫一份形狀說明:兩份一漂移,就會有人照著錯的那份寫。

同一頁同時給 bullets 與 table 的話兩個都會畫(表格排在條列下面)。
"""

import json
import logging
from pathlib import Path
from typing import List, Optional

from . import config, outputs_common

logger = logging.getLogger(__name__)

MANIFEST_NAME = "__slides__.json"

# 教模型怎麼寫這份 manifest 的那段字。放在這裡而不是提示詞裡:形狀變了的時候,
# 改的人一定會看到這個檔案,不一定會想到去改 agent.py 的提示詞。
PROMPT_SHAPE = (
    '{"title":"封面","subtitle":"副標(可省略)",'
    '"slides":[{"heading":"這頁的標題","bullets":["第一點","第二點"],'
    '"table":{"header":["欄位","說明"],"rows":[["order_id","訂單編號"]]},'
    '"notes":"備忘稿(可省略)"}]}'
)

# 繁體中文用微軟正黑體,跟其他產出的檔案放在一起不會突兀
FONT_MAIN = "微軟正黑體"

# 一頁塞不下的量。超過就截斷並在備忘稿講一聲 —— 硬塞的結果是字壓在頁面外面,
# 而那在產檔當下完全看不出來。
MAX_BULLETS = 9
MAX_TABLE_ROWS = 14
MAX_SLIDES = 100


def _style(run, size: float, bold: bool = False, color=None) -> None:
    """設定一段文字的字型。

    ⚠️ **中文要另外設 `a:ea`。** `run.font.name` 只寫得到 latin 那一格,中文字
    會走佈景的預設字型 —— 在別人的電腦上開就是另一套字,跟 Word 那份對不起來。
    """
    from lxml import etree
    from pptx.oxml.ns import qn
    from pptx.util import Pt

    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = FONT_MAIN
    if color is not None:
        run.font.color.rgb = color
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        node = rPr.find(qn(tag))
        if node is None:
            node = etree.SubElement(rPr, qn(tag))
        node.set("typeface", FONT_MAIN)


def render(spec: dict, out_path: Path) -> List[str]:
    """把資料寫成 .pptx。失敗會丟例外,由呼叫端收。回傳要顯示給使用者的訊息。"""
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.util import Emu, Inches, Pt

    notices: List[str] = []
    prs = Presentation()
    # 16:9。python-pptx 內建的範本還是 4:3,拿去投影會左右各一條黑邊
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)

    title_slide = prs.slides.add_slide(prs.slide_layouts[0])
    title_slide.shapes.title.text = str(spec.get("title") or "簡報")
    _style(title_slide.shapes.title.text_frame.paragraphs[0].runs[0], 40, bold=True)
    subtitle = str(spec.get("subtitle") or "").strip()
    if subtitle and len(title_slide.placeholders) > 1:
        frame = title_slide.placeholders[1].text_frame
        frame.text = subtitle
        _style(frame.paragraphs[0].runs[0], 18, color=RGBColor(0x55, 0x55, 0x55))

    slides = spec.get("slides")
    if not isinstance(slides, list):
        slides = []
    if len(slides) > MAX_SLIDES:
        notices.append("簡報超過 %d 頁,只產出前 %d 頁。" % (MAX_SLIDES, MAX_SLIDES))
        slides = slides[:MAX_SLIDES]

    for raw in slides:
        if not isinstance(raw, dict):
            continue
        slide = prs.slides.add_slide(prs.slide_layouts[5])  # 只有標題的版面
        slide.shapes.title.text = str(raw.get("heading") or "")
        if slide.shapes.title.text_frame.paragraphs[0].runs:
            _style(slide.shapes.title.text_frame.paragraphs[0].runs[0], 28, bold=True)

        top = Inches(1.7)
        bullets = [str(b) for b in (raw.get("bullets") or []) if str(b).strip()]
        if len(bullets) > MAX_BULLETS:
            notices.append(
                "「%s」這一頁的條列超過 %d 點,多的沒有放進去。"
                % (raw.get("heading") or "", MAX_BULLETS)
            )
            bullets = bullets[:MAX_BULLETS]
        if bullets:
            box = slide.shapes.add_textbox(
                Inches(0.9), top, prs.slide_width - Inches(1.8), Inches(0.4) * len(bullets)
            )
            frame = box.text_frame
            frame.word_wrap = True
            for i, text in enumerate(bullets):
                para = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
                para.text = "• " + text
                para.space_after = Pt(8)
                _style(para.runs[0], 16)
            top = Emu(top + Inches(0.45) * len(bullets) + Inches(0.2))

        table = raw.get("table")
        if isinstance(table, dict) and (table.get("header") or table.get("rows")):
            # 空的 table 直接跳過 —— 不擋的話下面會噴「表格排不下」那則訊息,
            # 而使用者根本沒放表格,只會看得一頭霧水。
            header = [str(h) for h in (table.get("header") or [])]
            rows = [r for r in (table.get("rows") or []) if isinstance(r, list)]
            # 一列大約 0.4 吋(12pt 的字再小也擠不下更多),用「這一頁還剩幾吋」
            # 回推放得下幾列 —— 條列已經吃掉多少高度,這裡才知道。
            # ⚠️ 硬塞的結果是表格長到頁面外面,而**產檔當下完全看不出來**:
            # 檔案照樣產得出來、打開來才發現最後幾列不見了。
            room = int((prs.slide_height - top - Inches(0.4)) / Inches(0.4))
            fit = min(MAX_TABLE_ROWS, room - (1 if header else 0))
            if fit < 2:
                # 條列已經把這一頁吃光了。硬畫一張兩列的表沒有意義,
                # 講清楚比畫一個看不懂的東西好。
                notices.append(
                    "「%s」這一頁的條列太長,表格排不下,沒有放進去 ——"
                    "請把表格獨立成一頁。" % (raw.get("heading") or "")
                )
                rows, header = [], []
            if rows and len(rows) > fit:
                notices.append(
                    "「%s」這一頁的表格放不下 %d 列,只放了前 %d 列"
                    "(需要完整資料請改要 Excel)。"
                    % (raw.get("heading") or "", len(rows), fit)
                )
                rows = rows[:fit]
            cols = max([len(header)] + [len(r) for r in rows])
            if cols and (rows or header):
                shape = slide.shapes.add_table(
                    len(rows) + (1 if header else 0) or 1,
                    cols,
                    Inches(0.9),
                    top,
                    prs.slide_width - Inches(1.8),
                    Inches(0.4) * (len(rows) + (1 if header else 0)),
                )
                grid = shape.table
                data = ([header] if header else []) + rows
                for r, row in enumerate(data):
                    for c in range(cols):
                        cell = grid.cell(r, c)
                        cell.text = str(row[c]) if c < len(row) else ""
                        _style(
                            cell.text_frame.paragraphs[0].runs[0]
                            if cell.text_frame.paragraphs[0].runs
                            else cell.text_frame.paragraphs[0].add_run(),
                            12,
                            bold=(r == 0 and bool(header)),
                        )

        notes = str(raw.get("notes") or "").strip()
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))
    return notices


def apply_slides_manifest(session_id: str, knowledge_base: Optional[dict] = None) -> List[str]:
    """把 `__slides__.json` 轉成 .pptx,回傳要顯示給使用者的訊息。

    由 `routers/ask.py` 的 `_finalize` 呼叫,**一定要排在 `list_output_files` 前面**。
    任何一步失敗都只回訊息、不丟例外(收尾階段,答案已經算完了)。
    """
    session_dir = config.OUTPUT_DIR / session_id
    manifest = session_dir / MANIFEST_NAME
    if not manifest.is_file():
        return []

    text, notices = outputs_common.read_manifest(manifest, "簡報")
    if text is None:
        return notices
    try:
        spec = json.loads(text)
    except json.JSONDecodeError as exc:
        return notices + [
            "簡報資料不是合法的 JSON(%s),沒有產生 PowerPoint。" % type(exc).__name__
        ]
    if not isinstance(spec, dict):
        return notices + ["簡報資料格式不正確(最外層應該是物件),沒有產生 PowerPoint。"]

    stem = outputs_common.safe_name(spec.get("title")) or "簡報"
    out_path = outputs_common.unique_path(session_dir, stem + ".pptx")

    try:
        return notices + render(spec, out_path)
    except ImportError:
        return notices + outputs_common.missing_package("python-pptx", "簡報")
    except Exception as exc:  # noqa: BLE001 —— 收尾階段,不能讓它把整題弄成失敗
        logger.exception("簡報產出失敗 session=%s", session_id)
        outputs_common.discard_partial(out_path)
        return notices + ["簡報產出失敗:%s: %s" % (type(exc).__name__, exc)]
