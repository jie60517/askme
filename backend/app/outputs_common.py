"""收尾產檔那幾支(`sheetgen` / `pdfgen` / `docgen` / `slidegen` / `zipgen`)共用的小零件。

它們做的事不一樣,但邊角完全一樣:清單怎麼讀、清單怎麼刪、檔名怎麼清、撞名怎麼辦、
半成品怎麼清、函式庫沒裝要說什麼。集中在這裡,改一處五支一起生效。
`pdfgen` 與 `docgen` 吃同一種來源(Markdown),兩支另外共用 `markdown_doc`。
"""

import logging
from pathlib import Path
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# 檔名裡不能有的字。**逗號一定要在**:下載清單是用逗號串起來存成一欄的
# (`QARecord.output_files`),檔名裡有逗號會把那份清單從中間切斷。
BAD_NAME_CHARS = set('/\\,:*?"<>|\x00')


def clean_line(text: str) -> str:
    """清單檔的一行 → 檔名/路徑。

    模型有時會加上 markdown 的清單符號或反引號,寬容一點 ——
    為了一個星號就說「找不到這個檔案」不值得。
    """
    return text.strip().strip("`").lstrip("-*").strip()


def safe_name(text: str, limit: int = 80) -> str:
    """把模型給的字串清成一個能當檔名的東西。清完是空的就回空字串。"""
    cleaned = "".join(
        c for c in str(text or "") if c not in BAD_NAME_CHARS and ord(c) >= 32
    ).strip()
    return cleaned[:limit].rstrip(".")


def unique_path(directory: Path, name: str) -> Path:
    """`directory/name`,撞名就加序號。

    **一律不覆蓋。** 同一題裡很可能已經有一個同名檔 —— copy manifest 剛複製進來的
    正本(使用者要的那份原始檔)、或前一個產檔器的產出。蓋掉的話使用者會拿到一個
    內容跟檔名對不上的檔案,而且畫面上不會有任何跡象。
    """
    stem, suffix = Path(name).stem, Path(name).suffix
    target = directory / name
    counter = 2
    while target.exists():
        target = directory / f"{stem}({counter}){suffix}"
        counter += 1
    return target


def read_manifest(path: Path, kind: str) -> Tuple[Optional[str], List[str]]:
    """讀一份清單檔並**立刻刪掉它**,回傳(內容, 要顯示給使用者的訊息)。

    讀不出來時內容是 None,而且一定會回一則訊息:**靜默 return 是最糟的結果** ——
    答案說「已經產生」、下載清單裡沒有、畫面上也沒有任何錯誤。

    **要先刪再產檔**:產到一半出錯時它才不會留在下載清單裡,讓使用者看到一個
    看不懂的檔。⚠️ 刪除**不可以寫在呼叫端的 `finally` 裡** —— `unlink` 自己也會丟
    OSError(檔案被鎖、權限沒了),從 finally 逃出去的例外會一路衝出 `_finalize`
    把整題變成失敗,而那正是收尾階段最不該發生的事。
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        text = None
        notices = ["%s清單讀不出來(%s),沒有產生。" % (kind, type(exc).__name__)]
    else:
        notices = []

    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("清單檔刪不掉 path=%s", path)
        notices.append(
            "「%s」是系統用的清單檔,刪不掉(%s),它會出現在下載清單裡,可以忽略。"
            % (path.name, exc.strerror or type(exc).__name__)
        )
    return text, notices


def discard_partial(path: Path) -> None:
    """清掉寫到一半的產出。失敗就算了 —— 這已經是錯誤處理路徑上的收尾動作。

    不清的話,使用者的下載清單裡會多一個打不開的壞檔,而他不知道那是半成品。
    """
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("半成品刪不掉 path=%s", path)


def missing_package(package: str, output_name: str) -> List[str]:
    """函式庫沒裝時要說的話。

    正常不會走到(全都釘在 requirements.txt),真的走到代表那台機器的 venv 沒跟上。
    講清楚要做什麼,不要只丟一個 ImportError。
    """
    logger.warning("%s 未安裝,%s產不出來", package, output_name)
    return [
        "主機的 venv 沒有 %s,%s產不出來。"
        "請在 backend 的 venv 重跑:./.venv/bin/pip install -r requirements.txt"
        % (package, output_name)
    ]
