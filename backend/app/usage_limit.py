"""Claude 訂閱額度(5 小時滾動視窗)的快照。

**用途**:回答完成之後,順便告訴使用者這一題吃掉幾 %、還剩幾 %、幾分鐘後重置。
那個百分比**不在這個專案裡** ——
`qa_records` 只記每題的 token 與美金成本,跟訂閱額度是兩回事。唯一知道額度的
是 claude CLI 自己,而它把答案放在 `/usage` 這個 slash 指令裡。

所以做法是:**用 `-p` 跑一次 `/usage`,把它印出來的那段字剖成數字。**
(slash 指令走 `-p` 是通的(見 `agent.py`)—— 它不產生 stream_event,
只送一則完整的 assistant 訊息;這裡用 `--output-format text` 直接拿那段字。)

⚠️ **這段輸出的格式是 CLI 給的,不是我們定的,升版就可能變。** 所以整支的原則是
「剖不出來就回 None」,而**不是**猜一個數字:上面那句話是要唸給人聽的,寧可
少講一句,也不要講一個看起來很正常但其實是瞎編的百分比。前端拿到 null 就只
顯示「回答完成」。

⚠️ **不要在每一題結束時都真的跑一次子行程。** 這支會被「每一題答完」觸發,
而主機同時可以跑 `MAX_CONCURRENT_ASKS` 題 —— 沒有快取的話尖峰時會有一串 claude 行程只為了問額度。
下面用一份模組層快取 + 一把鎖:TTL 內共用同一份答案,同時進來的人共用同一次執行。
"""

import asyncio
import logging
import re
import time
from typing import Optional

from . import config

logger = logging.getLogger(__name__)

# 一份快照可以用多久。
#
# 60 秒管的是「送出時的基準」與同時答完的好幾題共用同一份;「答完那一次」走
# `fresh=True` 不吃這份快取(不然一題在 60 秒內答完,差值永遠是 0)。
# 太短則等於沒有快取,尖峰時會有一串子行程只為了問額度。
CACHE_TTL_SEC = 60

# `/usage` 跑多久算它壞了。它是本機指令(不打模型),正常是秒級;
# 給 30 秒是留給主機負載高的時候,超過就當作讀不到 —— 不能讓它拖住呼叫端。
TIMEOUT_SEC = 30

# 上一次的結果與時間。
#
# ⚠️ **「問過了沒」看 `_cache_at`,不看 `_cache` 是不是 None。** 讀不到的結果
# 也是一個結果(None),而且更要記得 —— CLI 壞掉的那段期間,每一題答完都
# 再起一次子行程、各等滿 TIMEOUT_SEC,等於把故障放大成每題 30 秒的延遲。
_cache: Optional[dict] = None
_cache_at: float = 0.0
_lock = asyncio.Lock()


def _is_fresh(now: float) -> bool:
    return _cache_at > 0 and now - _cache_at < CACHE_TTL_SEC


#
# 百分比所在的那一行要看得出來是在講額度。
#
# ⚠️ 這是**安全**條件,不只是剖析的講究:萬一主機上的 CLI
# 版本把 `/usage` 當成一般提示丟給模型,回來的會是一段模型的回答 —— 「我 100% 確定
# 幫不上忙」裡的那個 100% 不能被當成額度唸給人聽。要求同一行有這些字之一,
# 模型的閒聊幾乎不會剛好湊齊「百分比 + 額度用語」。
_USAGE_LINE_KEYWORDS = ("usage", "used", "limit", "quota", "session", "額度", "用量", "使用")


def _find_percent(text: str) -> Optional[int]:
    """把「用掉幾 %」找出來。

    CLI 的排版會變,所以不比對整行,只找**第一個百分比數字** —— 那一段的第一個
    百分比一直都是目前這個視窗的使用率。找不到、或不是 0~100、或那一行看不出
    是在講額度(見 `_USAGE_LINE_KEYWORDS`)就回 None。
    """
    for line in text.splitlines():
        lowered = line.lower()
        if not any(word in lowered for word in _USAGE_LINE_KEYWORDS):
            continue
        for raw in re.findall(r"(\d{1,3})\s*%", line):
            value = int(raw)
            if 0 <= value <= 100:
                return value
    return None


def _find_reset_minutes(text: str) -> Optional[int]:
    """「幾分鐘後重置」。

    只看**含 reset / 重置 的那一行**,然後在那一行裡各自找小時與分鐘 ——
    兩個都是選填、至少要有一個:
      `Resets in 2h 15m` / `resets in 45m` / `Resets in 3h` / `重置於 2 小時 15 分` / `重置於 2 小時`

    ⚠️ 單位後面**不能再接英文字母**(`(?![a-z])`):`m` 尾巴可以接任何東西的話,
    「Resets in 2h … 3 messages」會被剖成 3 分鐘。
    不用字界 `\b` 是因為 `2h30m` 這種沒空格的寫法,`h` 後面是數字、沒有字界,
    會漏掉小時;負向前瞻兩種都對。

    只認**相對時間**,不去解析「Resets at 3:00pm」那種絕對時刻 —— 那要知道
    主機時區與現在幾點,而算錯的代價是講出一個差好幾小時的數字。
    """
    line = next(
        (ln for ln in text.splitlines() if "reset" in ln.lower() or "重置" in ln),
        None,
    )
    if line is None:
        return None
    lowered = line.lower()
    hours = re.search(r"(\d+)\s*(?:h(?:ours?|rs?)?(?![a-z])|小時)", lowered)
    minutes = re.search(r"(\d+)\s*(?:m(?:in(?:ute)?s?)?(?![a-z])|分(?:鐘)?)", lowered)
    if hours is None and minutes is None:
        return None
    total = int(hours.group(1) if hours else 0) * 60 + int(minutes.group(1) if minutes else 0)
    return total if total > 0 else None


def parse_usage(text: str) -> Optional[dict]:
    """`/usage` 印出來的那段字 → `{used_percent, remaining_percent, resets_in_minutes}`。

    百分比剖不出來就整份回 None(沒有百分比,這個功能就沒有東西可以講);
    重置時間剖不出來只是那一半留 None,前端會少講「幾分鐘後重置」那半句。

    抽成模組層的函式而不是寫在 `read_usage_limit()` 裡面,是為了**測得到** ——
    格式一變,要對的就是這一支,不必真的去起一個子行程。
    """
    used = _find_percent(text)
    if used is None:
        return None
    return {
        "used_percent": used,
        "remaining_percent": 100 - used,
        "resets_in_minutes": _find_reset_minutes(text),
    }


def usage_argv() -> list:
    """`claude -p /usage` 的完整命令列。抽出來是為了測得到那幾道閘門。

    ⚠️ **閘門一道都不能少**:這條命令沒有任何使用者輸入,
    但它在主機上起的是一個 claude 回合。`agent.py` 那段只證明 slash 指令的輸出
    **形狀**(整則 assistant 訊息),沒證明每個 CLI 版本的 `/usage` 都不打模型 ——
    萬一它被當成一般提示,任何登入者打 `/api/usage-limit` 就是在 `CLAUDE_WORKDIR`
    起一個「預設工具權限、掛滿 MCP server」的 agent 回合。所以:
      - `--allowedTools ""` + `--disallowedTools`:一支工具都不給
      - `--strict-mcp-config`(照設定):不載主機上的 MCP server
      - `--max-budget-usd 0.01`:真的打到模型也在一分錢內被切斷
      - `--model haiku`:就算打了也是最便宜的那顆
    正常情況(`/usage` 是本機指令)這些旗標全部沒有作用,只是保險。
    """
    cmd = [
        config.CLAUDE_BIN,
        "-p",
        "--output-format",
        "text",
        "--allowedTools",
        "",
        "--disallowedTools",
        config.DISALLOWED_TOOLS,
        "--max-budget-usd",
        "0.01",
        "--model",
        "haiku",
    ]
    if config.CLAUDE_STRICT_MCP:
        cmd.append("--strict-mcp-config")
    cmd += ["--", "/usage"]
    return cmd


async def _run_usage_command() -> Optional[dict]:
    """真的去跑一次 `claude -p /usage`。失敗一律回 None(理由見檔頭),但要留 log ——
    「小夥伴不講用量」在畫面上看不出原因,log 是唯一的線索。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            *usage_argv(),
            cwd=config.resolve_workdir(),
            # ⚠️ 跟問答走同一份「拿掉本站機密」的環境(理由見 agent._child_env):
            # 這裡一樣是把整個 os.environ 交給別人的行程。
            env=_child_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
    except (OSError, ValueError) as exc:
        logger.warning("/usage 起不了子行程:%s", exc)
        return None

    try:
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_SEC)
        except asyncio.TimeoutError:
            logger.warning("/usage 超過 %s 秒沒回,放棄", TIMEOUT_SEC)
            return None
    finally:
        # 逾時、或這個 coroutine 被外部取消 —— 子行程都不該留下來
        if proc.returncode is None:
            proc.kill()
            await proc.wait()

    if proc.returncode != 0:
        logger.warning(
            "/usage 回 exit %s:%s",
            proc.returncode,
            stderr.decode("utf-8", errors="replace").strip()[:500],
        )
        return None
    snapshot = parse_usage(stdout.decode("utf-8", errors="replace"))
    if snapshot is None:
        # 剖不出來要留一段原文,不然下次升版格式一變只會看到「小夥伴不講話」
        logger.warning("/usage 的輸出剖不出百分比:%r", stdout[:300])
    return snapshot


def _child_env() -> dict:
    """跟 `agent._child_env()` 同一份。

    ⚠️ 直接 import agent 會把「問答」那一整包(含 semaphore 與模組層狀態)拉進來,
    而這裡只需要那一件事,所以借用它 —— 借用而不是抄一份,是為了哪天黑名單加了
    一個 key,兩邊不會漏掉其中一邊。
    """
    from .agent import _child_env as agent_child_env

    return agent_child_env()


async def read_usage_limit(fresh: bool = False) -> Optional[dict]:
    """目前的額度快照。TTL 內共用同一份;同時進來的人共用同一次執行。

    ⚠️ 這裡**沒有**「這一題用了幾 %」。那個差值要用「送出時」與「答完時」兩份
    快照相減,而只有前端知道每一題的送出與答完是哪兩個時刻(`lib/petSetup.tsx`)。
    在這裡算「跟上一次讀到的差幾 %」會有三種錯:TTL 內的第二題唸到第一題的差、
    服務剛啟動的第一題永遠沒有差、5 小時視窗一重置就唸出負數。後端只回事實,不猜歸屬。

    `fresh=True`(答完那一次):**成功的快取不算數**,一定重跑 —— 一題常在 60 秒內
    答完,兩次讀到同一份快取的話「本次耗用」永遠是 0。
    ⚠️ 但**失敗的快取照樣算數**:CLI 壞掉那段期間,fresh 也不該每題再等一次
    TIMEOUT_SEC,那正是 `_cache_at` 存在的理由。
    """
    global _cache, _cache_at

    def cached_is_usable(now: float) -> bool:
        if not _is_fresh(now):
            return False
        return _cache is None or not fresh

    if cached_is_usable(time.time()):
        return _cache

    async with _lock:
        # 等鎖的期間別人可能剛跑完 —— 再看一次,不要重複起子行程
        if cached_is_usable(time.time()):
            return _cache
        _cache = await _run_usage_command()
        # 讀不到也要記時間(理由見 _cache 的說明)
        _cache_at = time.time()
        return _cache
