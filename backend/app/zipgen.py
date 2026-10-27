"""把這一題產出的幾個檔案打包成一個 .zip。

同樣是「沒有 Bash 就做不到」的那一類:壓縮要跑程式。使用者要「這五支程式的
原始碼一起給我」時,打包成一個就不用各按一次下載。

用法:claude 用 Write 寫一份 `__zip__.txt`,**第一行是壓縮檔名**,其餘每行一個
這一題產出資料夾裡的檔名。

⚠️ **只收這一題資料夾裡的檔名,不收路徑。** 要打包主機上既有的檔案,正確做法是
先用 copy manifest 把它們複製進來(那邊才有來源白名單),再列進這份清單 ——
順序天然成立,`_finalize` 就是先跑 copy manifest 才跑到這裡。
"""

import logging
import zipfile
from pathlib import Path
from typing import List, Optional

from . import config, outputs_common

logger = logging.getLogger(__name__)

MANIFEST_NAME = "__zip__.txt"

# 打包上限。壓縮是同步的,而這段在收尾的關鍵路徑上(使用者正盯著畫面等 done)。
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 200


def _safe_zip_name(text: str) -> str:
    """壓縮檔名清理:清掉不能當檔名的字,再補上 .zip。"""
    cleaned = outputs_common.safe_name(text)
    if not cleaned:
        return "打包檔案.zip"
    return cleaned if cleaned.lower().endswith(".zip") else cleaned + ".zip"


def apply_zip_manifest(session_id: str, knowledge_base: Optional[dict] = None) -> List[str]:
    """把 `__zip__.txt` 點名的檔案打包,回傳要顯示給使用者的訊息。

    由 `routers/ask.py` 的 `_finalize` 呼叫,**一定要排在 `list_output_files` 前面**,
    而且要排在 copy manifest、sheetgen、pdfgen **後面** —— 那幾支產出來的檔案
    也要包得進去。

    任何一步失敗都只回訊息、不丟例外(收尾階段,答案已經算完了)。
    """
    session_dir = config.OUTPUT_DIR / session_id
    manifest = session_dir / MANIFEST_NAME
    if not manifest.is_file():
        return []

    text, notices = outputs_common.read_manifest(manifest, "打包")
    if text is None:
        return notices

    entries = [outputs_common.clean_line(line) for line in text.splitlines()]
    entries = [e for e in entries if e]
    if len(entries) < 2:
        return notices + [
            "打包清單的內容不完整(第一行要是壓縮檔名,後面至少一個檔案),沒有打包。"
        ]

    # **撞名要在挑成員之前就解決掉。** 用還沒去重的名字比對的話,
    # 「清單裡列到一個同名的既有 .zip」會拿到「不是這一題產出的檔案」這種誤導訊息。
    zip_path = outputs_common.unique_path(session_dir, _safe_zip_name(entries[0]))
    members: List[Path] = []
    total = 0
    wanted_names = entries[1:]
    if len(wanted_names) > MAX_MEMBERS:
        # **截斷一定要講**:少給幾個檔案而不說,跟少給幾列一樣 —— 使用者不會發現
        notices.append(
            "打包清單有 %d 個檔案,超過上限,只放進前 %d 個。"
            % (len(wanted_names), MAX_MEMBERS)
        )
        wanted_names = wanted_names[:MAX_MEMBERS]
    for wanted in wanted_names:
        # 只收檔名。`Path(...).name` 同時把 ../ 這種寫法擋掉。
        src = session_dir / Path(wanted).name
        if src == zip_path or not src.is_file():
            notices.append("「%s」不是這一題產出的檔案,沒有放進壓縮檔。" % wanted)
            continue
        try:
            total += src.stat().st_size
        except OSError:
            continue
        members.append(src)

    if not members:
        return notices + ["沒有可以打包的檔案,壓縮檔沒有產生。"]
    if total > MAX_TOTAL_BYTES:
        return notices + [
            "要打包的檔案加起來超過 %d MB,沒有壓縮,請直接下載個別檔案。"
            % (MAX_TOTAL_BYTES // (1024 * 1024))
        ]

    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for src in members:
                zf.write(src, arcname=src.name)
    except Exception as exc:  # noqa: BLE001 —— 收尾階段,不能讓它把整題弄成失敗
        logger.exception("打包失敗 session=%s", session_id)
        outputs_common.discard_partial(zip_path)
        return notices + [
            "打包失敗:%s: %s(個別檔案還是可以下載)" % (type(exc).__name__, exc)
        ]

    return notices
