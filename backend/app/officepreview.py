"""Word / 簡報 / Excel 的「看起來跟真的一樣」預覽。

`extract.extract_text` 只抽得出純文字;這裡讓這三種預覽起來跟 PDF 一樣像原檔。

- **Word / 簡報 → PDF**:用 LibreOffice(`soffice --headless --convert-to pdf`)轉,
  前端丟進跟 .pdf 同一個 PDF 框。轉好的放 `config.PREVIEW_CACHE_DIR`,同一份檔案第二次直接給。
- **Excel → 表格資料**:轉 PDF 會被切成一頁頁 A4、沒有格線,不像 Excel(本機實測)。
  改成讀出每張工作表的值給前端畫表格。

**沒裝 LibreOffice 或轉失敗不是錯誤**:呼叫端退回純文字預覽。

⚠️ 安全上的取捨(寫進資安報告):
- LibreOffice 轉檔**不執行文件裡的巨集**(預設的巨集安全性只信任簽章來源,headless 轉檔也一樣)。
- 文件裡若有「連到外部網址的圖片 / 物件」,LibreOffice 轉檔時可能會去抓 —— 跟抽文字(`extract`,不連網)**不一樣**:
  這台主機連著客戶 VPN 與內網,一份連到內網網址的 docx 會讓主機替它發出請求。附件是同仁自己上傳的、
  產出是 AI 產的,目前接受;要擋得在主機上用網路隔離跑(列在資安報告)。
- 一次只轉一份(鎖)、逾時砍掉;用獨立的設定檔目錄,不跟主機上其他人用的 LibreOffice 搶。
  排隊等鎖最多 `LOCK_WAIT_SEC`,等不到回 503(前端退回純文字)—— 路由是同步的,排隊會佔住執行緒池;
  轉不出來的那一份記住 `FAILED_TTL_SEC`,再打開直接 415,不會每次都佔鎖 30 秒重轉。
- 預覽觸發轉檔是 GET + cookie(`require_user_file` 說「唯讀 GET 才付得起 cookie 的代價」):轉檔會寫快取,
  已經不是純讀;要猜得到對話 id 與檔名才觸發得了,風險低,記在資安報告。
"""

import datetime
import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Union

from . import config
from .extract import _is_ole2, _zip_within_budget

logger = logging.getLogger(__name__)

#: 轉得成 PDF 的格式。舊版 .doc / .ppt 也收:不轉的話它們只能下載
PDF_SUFFIXES = {".docx", ".pptx", ".doc", ".ppt", ".odt", ".odp"}
#: 讀得成表格的格式
SHEET_SUFFIXES = {".xlsx", ".xlsm", ".xls"}

#: 一份轉多久算卡住。本機實測 2 秒左右,主機慢一點也不該超過這個
CONVERT_TIMEOUT_SEC = 30
#: 排隊等前一份轉完最多等多久,等不到就回 503(燈箱快速翻十份簡報,不要每一份都佔一條執行緒排著)
LOCK_WAIT_SEC = 20
#: 轉不出來的那一份多久內不再試
FAILED_TTL_SEC = 600
#: 舊版 .xls 讀進記憶體的上限(xlrd 整份讀;新版 xlsx 有解壓預算)
MAX_XLS_BYTES = 20 * 1024 * 1024
#: 快取多久沒人看就清
CACHE_MAX_AGE_SEC = 7 * 24 * 3600

#: 表格預覽每張工作表最多幾列幾欄。預覽是「確認是不是這份」,不是在網頁裡讀完
MAX_ROWS = 500
MAX_COLS = 50

# LibreOffice 同一個設定檔目錄一次只能有一個行程用,第二個會安靜地什麼都不做就結束 ——
# 所以一次只轉一份。轉一份 2 秒,排隊可以接受。
_lock = threading.Lock()
_soffice: Optional[str] = None
#: 轉不出來的:快取鍵 → 記下的時間
_failed: Dict[str, float] = {}


class Unavailable(Exception):
    """這台主機轉不了(沒裝 LibreOffice)。呼叫端回 503,前端退回純文字。"""


class Failed(Exception):
    """這一份轉不出來(壞檔、逾時、太大)。呼叫端回 415,前端退回純文字。"""


def _find_soffice() -> Optional[str]:
    """找到了就記住;**找不到不記**:先部署、後裝 LibreOffice 的話,不用重開後端就會生效"""
    global _soffice
    if _soffice:
        return _soffice
    candidates = [config.SOFFICE_PATH] if config.SOFFICE_PATH else []
    candidates += [shutil.which("soffice") or "", shutil.which("libreoffice") or ""]
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")):
            if base:
                candidates.append(str(Path(base) / "LibreOffice" / "program" / "soffice.exe"))
    _soffice = next((c for c in candidates if c and Path(c).is_file()), None)
    if _soffice is None:
        logger.info("找不到 LibreOffice,Word / 簡報預覽會退回純文字")
    return _soffice


def _cache_key(src: Path) -> str:
    """路徑 + 大小 + 修改時間。同名檔被換掉(大小或時間變了)就是另一份。"""
    stat = src.stat()
    raw = "%s|%d|%d" % (src.resolve(), stat.st_size, stat.st_mtime_ns)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def _prune(cache_dir: Path) -> None:
    """清掉太久沒人看的。看過的會被 touch(見 to_pdf),所以這裡看的是「最後一次被看」。"""
    cutoff = time.time() - CACHE_MAX_AGE_SEC
    for path in cache_dir.glob("*.pdf"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def _looks_ok(src: Path) -> bool:
    """丟給 LibreOffice 之前的同一道檢查:Office 新格式是 zip,先看解壓預算(壓縮炸彈)。"""
    suffix = src.suffix.lower()
    if suffix in (".docx", ".pptx", ".odt", ".odp"):
        return _zip_within_budget(src)
    if suffix in (".doc", ".ppt"):
        return _is_ole2(src)
    return True


def _run(cmd: List[str], name: str) -> None:
    """跑一次 LibreOffice,逾時**整組**砍掉。

    ⚠️ Linux 的 `soffice` 是一支殼(shell script → oosplash → soffice.bin)。只砍殼的話
    soffice.bin 會留著、繼續佔住設定檔目錄,之後每一份都「安靜地什麼都沒產」。
    所以開成自己的一組行程(`start_new_session`),逾時對整組送 SIGKILL。
    Windows 沒有行程組這回事,`kill()` 砍 soffice.exe 就好(它自己會收 soffice.bin)。
    """
    posix = os.name == "posix"
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=posix
        )
    except OSError as exc:
        logger.warning("LibreOffice 叫不起來 %s", exc)
        raise Unavailable() from None
    try:
        proc.wait(timeout=CONVERT_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        logger.warning("LibreOffice 轉檔逾時 file=%s", name)
        if posix:
            try:
                os.killpg(proc.pid, 9)
            except OSError:
                pass
        else:
            proc.kill()
        proc.wait()
        raise Failed("逾時") from None


def to_pdf(src: Path) -> Path:
    """`src`(Word / 簡報)→ 轉好的 PDF 路徑。轉不了丟 `Unavailable` / `Failed`。"""
    if src.suffix.lower() not in PDF_SUFFIXES:
        raise Failed("不支援的格式")
    cache_dir = config.PREVIEW_CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = _cache_key(src)
    target = cache_dir / (key + ".pdf")
    try:
        os.utime(target)  # 記下「剛被看過」,_prune 才不會清掉常用的;utime 不成 = 沒有或剛被清掉,照沒快取轉
        return target
    except OSError:
        pass
    failed_at = _failed.get(key)
    if failed_at and time.time() - failed_at < FAILED_TTL_SEC:
        raise Failed("剛剛轉不出來")

    soffice = _find_soffice()
    if soffice is None:
        raise Unavailable()
    if not _looks_ok(src):
        raise Failed("檔案太大或壞掉")

    if not _lock.acquire(timeout=LOCK_WAIT_SEC):
        raise Unavailable()
    try:
        if target.is_file():  # 排隊時別人剛好轉好了同一份
            return target
        _prune(cache_dir)
        try:
            _convert(soffice, src, target, cache_dir)
        except Failed:
            now = time.time()
            for old in [k for k, t in _failed.items() if now - t >= FAILED_TTL_SEC]:
                del _failed[old]
            _failed[key] = now
            raise
    finally:
        _lock.release()
    return target


def _convert(soffice: str, src: Path, target: Path, cache_dir: Path) -> None:
    # ignore_cleanup_errors:Windows 逾時砍掉 soffice.exe 時 soffice.bin 可能還握著 in.docx,
    # 清暫存目錄會丟 PermissionError 蓋掉 Failed、變成 500
    with tempfile.TemporaryDirectory(dir=cache_dir, ignore_cleanup_errors=True) as work:
        work_dir = Path(work)
        # 複製成固定的檔名再轉:檔名是使用者給的,可能有空白、引號、很長的中文
        source = work_dir / ("in" + src.suffix.lower())
        shutil.copyfile(src, source)
        profile = (cache_dir / "profile").resolve().as_uri()
        cmd = [
            soffice, f"-env:UserInstallation={profile}",
            "--headless", "--norestore", "--nolockcheck",
            "--convert-to", "pdf", "--outdir", str(work_dir), str(source),
        ]
        _run(cmd, src.name)
        produced = work_dir / "in.pdf"
        if not produced.is_file() or produced.stat().st_size == 0:
            raise Failed("沒有產出")
        os.replace(produced, target)


Cell = Union[str, int, float]


def _cell(value) -> Cell:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, datetime.datetime):
        return value.strftime("%Y/%m/%d %H:%M") if (value.hour or value.minute) else value.strftime("%Y/%m/%d")
    if isinstance(value, datetime.date):
        return value.strftime("%Y/%m/%d")
    return str(value)


def _trim(rows: List[List[Cell]]) -> List[List[Cell]]:
    """去掉尾端整列空白、每列尾端空白,再補成一樣寬(表格要每列一樣長)。"""
    while rows and all(c == "" for c in rows[-1]):
        rows.pop()
    width = 0
    for row in rows:
        while row and row[-1] == "":
            row.pop()
        width = max(width, len(row))
    return [row + [""] * (width - len(row)) for row in rows]


def _xlsx_sheets(src: Path) -> List[Dict]:
    from openpyxl import load_workbook

    wb = load_workbook(str(src), read_only=True, data_only=True)
    try:
        sheets = []
        for ws in wb.worksheets:
            rows: List[List[Cell]] = []
            truncated = False
            # max_col:只建前 MAX_COLS 格。不給的話 dimension 寫成 XFD 的檔每列會建 16384 格
            for values in ws.iter_rows(values_only=True, max_col=MAX_COLS):
                if len(rows) == MAX_ROWS:
                    # 多讀一列就停:要知道的只是「有沒有截掉」。數完整張表要把幾十萬列都讀過一遍
                    truncated = True
                    break
                rows.append([_cell(v) for v in values])
            # 欄數超過也要說,不能直接砍、不提示;read_only 的 max_column 照 dimension,可能是 None
            wide = (ws.max_column or 0) > MAX_COLS
            sheets.append({"name": ws.title, "rows": _trim(rows), "truncated": truncated or wide})
        return sheets
    finally:
        wb.close()


def _xls_sheets(src: Path) -> List[Dict]:
    import xlrd

    book = xlrd.open_workbook(str(src))
    sheets = []
    for sheet in book.sheets():
        rows: List[List[Cell]] = []
        for r in range(min(sheet.nrows, MAX_ROWS)):
            row: List[Cell] = []
            for cell in sheet.row(r)[:MAX_COLS]:
                if cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        row.append(_cell(datetime.datetime(*xlrd.xldate_as_tuple(cell.value, book.datemode))))
                        continue
                    except (ValueError, OverflowError, xlrd.XLDateError):
                        pass
                if cell.ctype == xlrd.XL_CELL_EMPTY:
                    row.append("")
                elif cell.ctype == xlrd.XL_CELL_NUMBER:
                    v = float(cell.value)
                    row.append(int(v) if v.is_integer() else v)
                else:
                    row.append(_cell(cell.value))
            rows.append(row)
        sheets.append({"name": sheet.name, "rows": _trim(rows), "truncated": sheet.nrows > MAX_ROWS or sheet.ncols > MAX_COLS})
    return sheets


def sheets(src: Path) -> List[Dict]:
    """Excel → `[{name, rows, truncated}]`。第一列就當表頭(前端畫成表頭)。讀不出來丟 `Failed`。

    `rows` 最多 `MAX_ROWS` 列 × `MAX_COLS` 欄;`truncated` 代表後面(或右邊)還有,前端寫「只顯示前 N 列、M 欄」。
    """
    suffix = src.suffix.lower()
    if suffix not in SHEET_SUFFIXES:
        raise Failed("不支援的格式")
    try:
        if suffix == ".xls":
            if not _is_ole2(src):
                # 副檔名是 .xls、內容其實是 HTML / tab 分隔的 ERP 匯出檔:交給純文字預覽
                raise Failed("不是真的 .xls")
            if src.stat().st_size > MAX_XLS_BYTES:
                raise Failed("檔案太大")
            return _xls_sheets(src)
        if not _zip_within_budget(src):
            raise Failed("檔案太大或壞掉")
        return _xlsx_sheets(src)
    except Failed:
        raise
    except Exception as exc:  # noqa: BLE001 —— 壞檔、加密檔:退回純文字就好,不要 500
        logger.info("Excel 表格預覽讀不出來 file=%s %s", src.name, type(exc).__name__)
        raise Failed(type(exc).__name__) from None
