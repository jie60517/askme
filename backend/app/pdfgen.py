"""把 claude 寫出來的 Markdown 轉成 PDF。

跟 `sheetgen`(Excel)同一個理由與同一套做法:PDF 也是二進位,
Write 工具寫不出來,而網頁的一般帳號沒有 Bash 跑不了 reportlab。所以 claude 只負責
寫一份 `.md`,再用 `__pdf__.txt` 點名哪幾份要轉,真正產檔在這裡。

**為什麼吃 Markdown**:「請給我一份 PDF」要的是一般文件,
內容長什麼樣每次都不同。Markdown 是模型本來就在寫的格式,不用教也不會寫錯。

**中文字型**:走 Adobe 的 CJK 標準字型 `MSung-Light`(Adobe-CNS1,繁體)——
**不內嵌字型檔**,由閱讀器自己替換。這是刻意的:內嵌要在 repo 裡放一份十幾 MB 的
字型檔,而主機上有沒有中文字型無法保證。Chromium 的 PDF 檢視器能正常顯示。

Markdown 怎麼切塊、清單怎麼跑跟 `docgen` 共用一份(`markdown_doc`),這裡只管畫成 PDF。
`>` 引用不另外排版,照一般文字印。行內只認 `**粗體**` 與 `` `等寬` ``,
**其餘語法一律照原字印出來** —— 看得懂比「安靜地漏掉」好。
"""

import html
import logging
import re
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from . import markdown_doc as md

logger = logging.getLogger(__name__)

# claude 用 Write 寫出來的「這幾份要轉 PDF」清單。跟其他 manifest 一樣,
# 處理完就刪 —— 它是給後端看的中間產物,不該出現在使用者的下載清單裡。
MANIFEST_NAME = "__pdf__.txt"

CJK_FONT = "MSung-Light"
MONO_FONT = "Courier"


def _register_font() -> Tuple[str, List[str]]:
    """回傳(實際可用的字型名稱, 要顯示給使用者的訊息)。

    註冊不起來就退回 Helvetica,並且**一定要講出來**:只寫 log 的話,使用者拿到的是
    一份中文整段空白的 PDF,而畫面上什麼提示都沒有 —— 他會以為是自己的閱讀器壞了。
    檔案照產(英數的部分還讀得到),但要附一句。
    """
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont

    try:
        pdfmetrics.registerFont(UnicodeCIDFont(CJK_FONT))
        return CJK_FONT, []
    except Exception:  # noqa: BLE001 —— 字型註冊失敗不該讓整份文件產不出來
        logger.warning("CJK 字型註冊失敗,PDF 會用 Helvetica(中文不會顯示)")
        return "Helvetica", [
            "這台主機載不到中文字型(%s),PDF 裡的中文不會顯示,請改用 Markdown 或 Word。"
            % CJK_FONT
        ]


def _inline(text: str) -> str:
    """行內語法 → reportlab 的迷你標記。**先跳脫再換**,順序反了會被當成標籤。"""
    out = html.escape(text, quote=False)
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"`([^`]+)`", r'<font face="%s">\1</font>' % MONO_FONT, out)
    return out


def _styles(font: str):
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

    base = getSampleStyleSheet()
    styles = {
        "body": ParagraphStyle(
            "body", parent=base["Normal"], fontName=font, fontSize=10.5, leading=17,
            spaceAfter=7,
        ),
        "code": ParagraphStyle(
            "code", parent=base["Normal"], fontName=MONO_FONT, fontSize=9, leading=12,
            leftIndent=10, backColor=colors.HexColor("#F4F4F4"), borderPadding=5,
            spaceAfter=8,
        ),
    }
    # 標題級距收斂在 20→11:六級都跟內文差很多的話,一份三層的文件看起來會很吵
    for level, (size, space) in enumerate(
        [(20, 12), (16, 10), (13, 8), (11.5, 7), (11, 6), (11, 6)], start=1
    ):
        styles[f"h{level}"] = ParagraphStyle(
            f"h{level}", parent=base["Normal"], fontName=font, fontSize=size,
            leading=size * 1.4, spaceBefore=space + 4, spaceAfter=space,
            textColor=colors.HexColor("#1A1A1A"),
        )
    styles["cell"] = ParagraphStyle(
        "cell", parent=styles["body"], fontSize=9, leading=13, spaceAfter=0
    )
    return styles


def _table(rows: Sequence[Sequence[str]], styles, width: float):
    """把 Markdown 的表格轉成一張有格線的表。

    每一格都包成 Paragraph 而不是塞字串:欄位說明動輒二三十個字,不包的話
    reportlab 不會換行,那一欄會直接被裁掉(而且不會有任何警告)。
    """
    from reportlab.lib import colors
    from reportlab.platypus import Paragraph, Table, TableStyle

    # 每一列補到一樣長:reportlab 的 Table 不接受長短不一的列(直接丟例外),
    # 而模型寫的表格少一根 | 是常有的事
    cols = max(len(row) for row in rows)
    data = [
        [Paragraph(_inline(cell), styles["cell"]) for cell in list(row) + [""] * (cols - len(row))]
        for row in rows
    ]
    table = Table(data, colWidths=[width / cols] * cols, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#BBBBBB")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8E8E8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def _flowables(block: md.Block, styles, font: str, width: float) -> list:
    """一個區塊 → reportlab 的 flowable(可能不只一個)。"""
    from reportlab.platypus import (
        HRFlowable, ListFlowable, ListItem, PageBreak, Paragraph, Spacer,
    )

    if isinstance(block, md.Paragraph):
        return [Paragraph(_inline(block.text), styles["body"])]
    if isinstance(block, md.Heading):
        return [Paragraph(_inline(block.text), styles[f"h{block.level}"])]
    if isinstance(block, md.Code):
        # 程式碼要**逐行**保留:接成一段再交給 Paragraph 的話縮排會被吃掉
        text = "<br/>".join(
            html.escape(b, quote=False).replace(" ", "&nbsp;") for b in block.lines
        )
        return [Paragraph(text or "&nbsp;", styles["code"])]
    if isinstance(block, md.Table):
        return [_table(block.rows, styles, width), Spacer(1, 8)]
    if isinstance(block, md.Bullets):
        return [
            ListFlowable(
                [ListItem(Paragraph(_inline(b), styles["body"])) for b in block.items],
                bulletType="bullet", leftIndent=16, bulletFontName=font,
            )
        ]
    if isinstance(block, md.Numbered):
        return [Paragraph("%s. %s" % (block.number, _inline(block.text)), styles["body"])]
    if isinstance(block, md.Rule):
        return [
            Spacer(1, 4),
            HRFlowable(width="100%", thickness=0.6, color="#CCCCCC"),
            Spacer(1, 6),
        ]
    if isinstance(block, md.PageBreak):
        return [PageBreak()]
    return []


def render(markdown: str, out_path: Path, title: Optional[str] = None) -> List[str]:
    """把 Markdown 寫成 PDF,回傳要顯示給使用者的訊息。失敗會丟例外,由呼叫端收。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate

    font, notices = _register_font()
    styles = _styles(font)
    doc = SimpleDocTemplate(
        str(out_path), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=20 * mm, bottomMargin=18 * mm,
        title=title or out_path.stem, author="AskME",
    )

    flow = []
    for block in md.parse(markdown):
        flow.extend(_flowables(block, styles, font, doc.width))
    if not flow:
        # 完全空的文件 reportlab 會產一份 0 頁的 PDF,有些閱讀器打不開
        flow.append(Paragraph("(這份文件沒有內容)", styles["body"]))
    doc.build(flow)
    return notices


def apply_pdf_manifest(session_id: str, knowledge_base: Optional[dict] = None) -> List[str]:
    """把 `__pdf__.txt` 點名的 Markdown 轉成 PDF,回傳要顯示給使用者的訊息。

    由 `routers/ask.py` 的 `_finalize` 呼叫,**一定要排在 `list_output_files` 前面**
    —— 不然產出來的 PDF 不會出現在下載清單裡。失敗只回訊息、不丟例外
    (見 `markdown_doc.apply_manifest`)。
    """
    return md.apply_manifest(
        session_id,
        manifest_name=MANIFEST_NAME,
        label="PDF",
        suffix=".pdf",
        package="reportlab",
        render=render,
    )
