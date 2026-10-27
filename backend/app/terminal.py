# -*- coding: utf-8 -*-
"""SSH 終端機(側邊欄 SSH Server):session 登錄、WebSocket ⇄ SSH 的橋接、閒置計時、SFTP 檔案操作。

**這個模組不依賴 FastAPI**:WebSocket 那一側抽象成 :class:`Transport`(四個 async 方法),
路由層(routers/terminal.py)只做「把 Starlette 的 WebSocket 包成 Transport」與 HTTP 端點。
好處是整段橋接可以在 pytest 裡對著一個假的 sshd 跑(tests/test_terminal_bridge.py),
Windows 上不需要真的 sshd。

摘要:

- 連到哪、用誰、拿什麼憑證全由 `config.SSH_TERMINAL_*` 決定,瀏覽器**不能指定**任何一項。
- 每個網站帳號同時可以開**好幾條**,上限 `SSH_TERMINAL_MAX_SESSIONS`;滿了拒絕新的(4429),
  **不踢舊的** —— 舊的可能正在跑東西,不替使用者決定犧牲哪一條。
- 閒置(沒有鍵盤輸入、也沒有檔案操作)超過 `SSH_TERMINAL_IDLE_TIMEOUT_SEC` 就斷;
  預設 0 = 不斷。填了秒數時,純輸出不算活動 —— `tail -f` 放著一樣會斷。
- **身分每 `TOKEN_CHECK_SEC` 秒回頭確認一次**(`run_session` 的 `token_watch`):
  登出、改密碼、被停用、職稱降級,已經開著的那條 shell 要跟著關掉,不能等他自己關頁籤。
- 稽核記連線 / 連線失敗 / 斷線 / 上傳 / 刪除;**不記鍵盤輸入與畫面內容**。
- 檔案欄的 SFTP 走同一條 SSH 連線,所以 session 一斷檔案 API 也跟著失效(409)。
- **檔案欄跟著終端機的目前目錄走**:開 PTY 前後各看一次 `/dev/pts`
  認出自己的 tty → 那個 tty 的 session leader 就是 shell → 每秒讀一次 `/proc/<pid>/cwd`,
  變了才推一則 `cwd`。**不改主機上的任何設定**,也不在畫面上打字;認不出來就靜靜地不追蹤。
- **收線時把這條連線開的程式一起關掉**:關 shell 之後在主機上跑一次 `end_programs_command()`,
  只認 `SSH_CONNECTION`(共用帳號,tty 會撞號)。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import posixpath
import re
import secrets
import shlex
import stat as statmod
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable, Optional, Protocol, Tuple, Union

import asyncssh

from . import audit, auth, config

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ 協定常數
#: 第一個訊息(auth)最多等幾秒。瀏覽器是開了 WebSocket 馬上送,5 秒是給慢網路的。
AUTH_TIMEOUT_SEC = 5
#: WebSocket 關閉碼。前端拿它對照成中文。
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_DISABLED = 4404
CLOSE_IDLE = 4408
CLOSE_UNREACHABLE = 4502
#: 開太多條(上限見 config.SSH_TERMINAL_MAX_SESSIONS)。
CLOSE_TOO_MANY = 4429
#: **結束原因的唯一一張表**:原因 → (關閉碼, 給人看的中文)。
#:
#: ⚠️ 加一個新原因**只要改這裡**。漏登記的原因關閉碼會落回錯誤值,前端會講錯原因。
#: **測試會從原始碼裡把橋接真的會回的原因掃出來跟這張表對**(`test_terminal_bridge.py`),所以漏了會紅。
#:
#: 關閉碼的選法:`exit` 1000 是正常結束;`idle` / 拒連各有自己的 4xxx;`server` / `error`
#: 1011;`left_page` 是瀏覽器那頭先關的,**維持 1000**(它不會有人收 —— 對面都走了 ——
#: 而真的送到時前端看的是 payload 裡的 `reason`,不是碼);`network` 是 keepalive 送不出去,
#: 1001 = going away,前端拿不到 payload 時照碼補的那句剛好也是「連線中斷」。
#:
#: 中文那一欄要跟前端 `lib/terminalApi.ts` 的 `closeMessage()` **同一個腔**;
#: 逐字相同的那兩句有測試對著前端原始碼比。
CLOSE_REASONS: dict[str, tuple[int, str]] = {
    "exit": (1000, "連線已結束。"),
    # 訊息帶分鐘數,是算出來的 —— 見 `closed_message()`。
    "idle": (CLOSE_IDLE, ""),
    "server": (1011, "主機那一端關閉了連線。"),
    "error": (1011, "連線發生錯誤。"),
    "left_page": (1000, "已離開終端機。"),
    "network": (1001, "連線中斷(網路或伺服器重新啟動)。"),
    # 登出、改密碼、被停用、職稱被改掉 —— 一律是 4401。見 `run_session` 的 `token_watch`。
    #
    # ⚠️ **這一句跟前端 4401 的備援句刻意不逐字相同**(其他幾個原因是要逐字相同的,
    # 有測試對著前端原始碼比)。因為 4401 在前端那側是**兩種情況共用**的:握手當下就
    # 沒登入(那時候還沒有人被「收回權限」),以及這裡的連線中途失效。前端拿不到 payload
    # 時只有關閉碼可看,分不出是哪一種,所以它那句必須是比較寬的「登入已過期,請重新
    # 整理後再試。」;而這裡送得出 payload,就講得出**為什麼**失效 —— 使用者看到的是
    # 這一句,前端那句只有在連線真的斷掉、payload 送不到時才會頂上。
    "revoked": (CLOSE_UNAUTHENTICATED, "登入已失效(登出、改密碼或權限被收回),請重新登入。"),
}
#: 一次從 sshd 讀 / 往 SFTP 寫的塊大小。
CHUNK = 64 * 1024
#: 目前目錄多久看一次(秒)。一次是一趟 SFTP readlink,很輕;**不算活動**,不會拖著閒置計時。
CWD_POLL_SEC = 1.0
#: 連續幾次讀不到目前目錄就改成慢速重試(不是 Linux、/proc 被藏起來、ps 不給看)。
#: **不會永久放棄** —— 永久關掉的話使用者只會看到「檔案欄不跟了」,查不出原因。
CWD_MISS_LIMIT = 3
#: 慢速重試的間隔(秒)。
CWD_SLOW_POLL_SEC = 10.0
#: 目錄的修改時間多久看一次(秒)。跟 `CWD_POLL_SEC` 同值但各管各的:一個目錄一趟 SFTP stat,**不算活動**。
DIR_POLL_SEC = 1.0
#: 檔案欄**最近列過**的目錄盯幾個(加上目前目錄)。見 `run_session` 的 `watch_dirs` 為什麼不是只盯一個
DIR_WATCH_RECENT = 3
#: 目錄的修改時間變了之後,隔幾秒**再**推一次 `dir`(見 `run_session` 的 `watch_dirs`)。
#: SFTP v3 的修改時間只到**秒** —— 檔案欄被第一則叫去重列的那一秒裡又有變動的話,修改時間不會再變,
#: 只靠比對就會漏掉;補一次就收得到。
DIR_SETTLE_SEC = 2.0
#: 「這個人的登入還在不在」多久回頭確認一次(秒)。見 `run_session` 的 `token_watch`。
#: 成本是一次 dict 查詢加一次 users 查詢,30 秒一輪可以忽略;它決定的是
#: 「後台按下停用」到「他那個 shell 真的關掉」之間最久會差多久。
TOKEN_CHECK_SEC = 30.0


class TerminalError(Exception):
    """連不上、不能連、或檔案操作失敗。`code` 對 WebSocket 是關閉碼,對 HTTP 是狀態碼。"""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Disconnected(Exception):
    """Transport 那一頭(瀏覽器)先關了。"""


class Transport(Protocol):
    """WebSocket 的最小介面。路由層用 Starlette 的 WebSocket 實作;測試可以用假的。"""

    async def send_text(self, text: str) -> None: ...
    async def send_bytes(self, data: bytes) -> None: ...
    async def receive(self) -> Tuple[str, Union[str, bytes]]:
        """回 ("text", str) 或 ("bytes", bytes);對方關了就 raise Disconnected。"""
        ...
    async def close(self, code: int, reason: str = "") -> None: ...


# ------------------------------------------------------------------ session
@dataclass
class Session:
    """一條連線的資料與資源。**不碰登錄簿**(那是模組層 `_register` / `_unregister` 的事)。"""

    session_id: str
    #: 網站帳號(稽核的 actor),不是 SSH 那頭的登入帳號。
    username: str
    #: 開這條連線時用的那張登入 token。**看門狗靠它問「這個人還登入著嗎」**
    #: (`run_session` 的 `token_watch`),所以它是必填的 —— 給預設值的話,
    #: 下一個自己組 Session 的人會安靜地得到一條「收不回來」的連線。
    #:
    #: ⚠️ `repr=False`:這是**活的憑證**,而 dataclass 的預設 repr 會把每個欄位都印出來 ——
    #: 哪天有人寫一句 `logger.info("%s", session)`(或某個例外把它帶進 traceback),
    #: 一張還能用的登入 token 就進了 journal。這個檔案自己的規矩是錯誤訊息「**不含憑證**」
    #: (見 `open_session`),那條規矩對這個欄位也要成立。
    token: str = field(repr=False)
    ip: str
    conn: asyncssh.SSHClientConnection
    process: asyncssh.SSHClientProcess
    #: 檔案欄的起點(絕對路徑)。`~` 由 sshd 那頭解出來。
    home: str
    #: 給人看的標籤,例如 `user@main-server`。
    label: str
    sftp: asyncssh.SFTPClient
    #: 連的是主機清單裡的哪一台(`terminal_hosts.json` 的 id)。前端的主機清單靠它知道
    #: 哪一張卡片是亮的(閒置的螢幕保護要把「還連著的那台」點亮)。
    host_id: str = "main"
    #: 跳板那一條連線(經跳板連的主機才有)。**要自己關** ——
    #: asyncssh 不會因為主連線收掉就順手把 tunnel 也收掉,漏了就留一條掛在跳板主機上。
    tunnel: Optional[asyncssh.SSHClientConnection] = None
    #: 開 PTY **之前**的 /dev/pts 清單。多出來的那一格就是這條連線的 tty(見 `_detect_shell_pid`)。
    pts_before: frozenset[str] = frozenset()
    #: PTY 那條 tty(`pts/N`),`_detect_shell_pid` 認出來的。讀它的 stty 設定用(`_read_erase`)。
    tty_name: Optional[str] = None
    #: 主機那頭的 tty 把哪個字元當「刪除前一個字」(`stty erase`)。None = 還不知道 / 就是 ^?(不用換)。
    erase: Optional[bytes] = None
    #: 上一次讀 `stty erase` 的時間(`time.monotonic()`,0 = 還沒讀過)。按 Backspace 時太久沒讀就先讀一次(`refresh_erase`)。
    erase_checked_at: float = 0.0
    #: 這台讀得到 stty(Linux 的 `stty -F`)。讀過而且一次都沒成功就是 False —— 按 Backspace 時不再先讀,免得每一下都卡一趟。
    erase_readable: bool = True
    #: PTY 裡那個 shell 的 PID(追蹤目前目錄用)。找不到就是 None = 不追蹤。
    shell_pid: Optional[int] = None
    #: 最後一次讀到的目前目錄;只有變了才推給前端。
    cwd: Optional[str] = None
    #: 檔案欄最近列過的目錄(`list_dir`),新的在前、最多 `DIR_WATCH_RECENT` 個。
    #: 它們跟 `cwd` 一起被盯著修改時間(`run_session` 的 `watch_dirs`)
    listed_paths: list[str] = field(default_factory=list)
    #: 目錄 → 上次看到的修改時間(秒)。`list_dir` 列之前記一筆,`watch_dirs` 比對;變了就推 `dir`
    dir_mtimes: dict[str, int] = field(default_factory=dict)
    started_at: float = field(default_factory=time.monotonic)
    last_activity: float = field(default_factory=time.monotonic)
    close_reason: Optional[str] = None
    closed: asyncio.Event = field(default_factory=asyncio.Event)

    def touch(self) -> None:
        """有活動(鍵盤輸入、檔案操作)。閒置計時從這一刻重算。"""
        self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_activity

    async def close(self, reason: str) -> None:
        """關掉 SSH 連線並寫稽核。**可重入**:第一個到的原因算數,後面的呼叫不做事。

        `reason` 是稽核與前端 Banner 用的:idle / left_page / exit / server / error / network
        (`network` = keepalive 送不出去,半開的連線被發現)。**這一串就是 `CLOSE_REASONS` 的鍵**
        —— 要加新的原因,那張表是唯一要改的地方(測試會掃原始碼對)。
        """
        if self.close_reason is not None:
            return
        self.close_reason = reason
        self.closed.set()
        # 稽核**先寫、再等連線收完**:這一支常常是在被取消的任務裡跑的(瀏覽器關了、服務要停),
        # 第一個 await 之後就不保證還有下一行。同一個理由,close() 本身是同步的,先叫再說。
        duration = int(time.monotonic() - self.started_at)
        audit.record(
            "terminal_disconnect",
            actor=self.username,
            ip=self.ip,
            detail=f"{self.label} {duration}s {reason}",
        )
        try:
            self.process.close()
        except Exception:  # noqa: BLE001 —— 收尾,不能讓一個例外擋住後面的
            pass
        try:
            # 這條連線開出來的程式收掉 —— 見 `end_programs`。
            # ⚠️ 順序:關 shell(同步,一定做得到)→ **收程式** → 關連線。
            #   不能排在關 shell 前面:這一支常在被取消的任務裡跑,第一個 await 之後不保證跑得到,
            #   被取消的那條路上會連 shell 都關不到。
            #   認程式靠 `SSH_CONNECTION`,shell 關了不影響;連線還開著,指令送得出去。
            # shield:就算這個任務被取消,收程式這一步也讓它自己跑完
            try:
                await asyncio.shield(asyncio.wait_for(end_programs(self), END_PROGRAMS_TIMEOUT_SEC))
            except Exception:  # noqa: BLE001 —— 連線早就斷了(網路掉了)或主機沒回應:收不到,往下照常收線
                pass
        finally:
            # ⚠️ 連線與跳板的收尾放 finally:上面那個 await 期間這個任務若**又**被取消,
            # CancelledError 不是 Exception、上面接不住 —— 不放 finally 的話連線與跳板就留在那裡。
            try:
                self.conn.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                # shield:就算這個任務被取消,連線的收尾也讓它自己跑完,不留半開的 sshd session
                await asyncio.shield(asyncio.wait_for(self.conn.wait_closed(), 3))
            except Exception:  # noqa: BLE001
                pass
            finally:
                # 跳板**最後**才收:先收的話目標那一條的收尾封包就沒有路可以走了
                if self.tunnel is not None:
                    try:
                        self.tunnel.close()
                    except Exception:  # noqa: BLE001
                        pass


#: 收線時結束程式:先送 TERM,等這麼多秒還在的再 KILL(`end_programs_command`)
END_PROGRAMS_GRACE_SEC = 2
#: 整段(找程式 → TERM → 等 → KILL)最多等多久。主機沒回應就放棄,往下照常收線
END_PROGRAMS_TIMEOUT_SEC = 8

#: 收線前結束程式的那一段 sh(`end_programs_command`)。
#: ⚠️ 會丟給**目標主機的登入 shell** 跑(外面包 `sh -c`),登入 shell 可能是 csh —— 腳本裡**不能有 `!`**
#: (csh 在單引號裡照樣做歷史展開),所以否定一律寫成 `||`。
#: ⚠️ 讀不到工作階段的(`s` 是空的)一律略過:那是這段腳本自己開的子程式(管線、`$(...)`),掃描時還活著、
#: 帶著同一個 SSH_CONNECTION,讀工作階段時已經結束了 —— 不略過的話會被算進名單,而那個 pid 可能已經被
#: 系統分給別的程式。
_END_PROGRAMS_SH = r"""
C="$SSH_CONNECTION"
[ -n "$C" ] || { echo "ended 0 no-id"; exit 0; }
sid_of() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $4}'; }
ME=$(sid_of $$)
[ -n "$ME" ] || { echo "ended 0 no-proc"; exit 0; }
holders() {
  if printf 'x\000' | grep -qz x 2>/dev/null; then
    grep -lzxF "SSH_CONNECTION=$C" /proc/[0-9]*/environ 2>/dev/null
  else
    for f in /proc/[0-9]*/environ; do
      tr '\000' '\n' < "$f" 2>/dev/null | grep -qxF "SSH_CONNECTION=$C" && echo "$f"
    done
  fi
}
P=$(holders | sed -n 's#^/proc/\([0-9]*\)/environ$#\1#p' | while read p; do
  [ "$p" = "$$" ] && continue
  s=$(sid_of "$p")
  [ -n "$s" ] || continue
  [ "$s" = "$ME" ] && continue
  echo "$p"
done)
[ -n "$P" ] || { echo "ended 0"; exit 0; }
kill -TERM $P 2>/dev/null
sleep __GRACE__
Q=""
for p in $P; do kill -0 "$p" 2>/dev/null && Q="$Q $p"; done
[ -z "$Q" ] || kill -KILL $Q 2>/dev/null
echo "ended $(echo $P | wc -w) killed $(echo $Q | wc -w)"
"""


def end_programs_command() -> str:
    """收線前在目標主機上跑的那一段:找出**這條 SSH 連線開出來的程式**,先 TERM、還在的再 KILL。

    分頁或瀏覽器關了,就把這條連線開的程式關掉,避免程式殘留。只關 shell、靠斷線訊號帶走底下的程式
    不夠 —— 背景跑的、忽略斷線訊號的程式不一定跟著收。

    **怎麼認「這條連線的程式」:環境變數 `SSH_CONNECTION`**(「來源 IP 來源埠 主機 IP 主機埠」)。
    sshd 對同一條 TCP 連線開的每個 channel 都給一模一樣的值、子程式一路繼承;別條連線(別的使用者、
    用一般 SSH 用戶端連的人 —— **可能大家都用同一個帳號登入**)來源埠一定不同。所以在**同一條連線**上開一個
    單次指令讀自己的 `$SSH_CONNECTION`,掃 `/proc/*/environ` 找帶著同一個值的,就是這條連線開出來的全部
    —— `nohup … &` 背景跑的也算。自己這個單次指令也帶著同一個值,用**工作階段**
    排掉(sshd 每個 channel 一個工作階段,`/proc/<pid>/stat` 第 6 欄)。
    ⚠️ 不能用「shell 的工作階段 / tty(`pts/N`)」認,都會撞號:tty 在我們收掉之後會被系統分給
    下一個登入的人,tty 偵測本身也可能認錯人(`_detect_shell_pid` 的已知盲點)—— 在共用帳號上
    那等於砍掉別人的工作階段。第二輪 KILL 也**不重找**:只補殺第一輪名單裡還活著的。

    只認 Linux 的 `/proc`;沒有(或讀不到自己的 `SSH_CONNECTION`)就什麼都不做,靠斷線訊號。
    用 `sh -c` 包起來:目標主機的登入 shell 不一定是 sh,而 `conn.run` 是丟給登入 shell 跑的。
    """
    return "sh -c " + shlex.quote(_END_PROGRAMS_SH.strip().replace("__GRACE__", str(END_PROGRAMS_GRACE_SEC)))


_END_PROGRAMS_RESULT = re.compile(r"ended (\d+)(?: killed (\d+))?")


async def end_programs(session: "Session") -> None:
    """收線前結束這條連線開出來的程式(`end_programs_command`)。真的收到東西才寫稽核(會改主機的動作要留痕)。
    失敗只記一行,不擋收線。"""
    try:
        # stdin 給 DEVNULL:遠端一開始就讀到 EOF,不會有哪個環節卡在等輸入(收線的路上最怕卡住)
        result = await session.conn.run(end_programs_command(), check=False, stdin=asyncssh.DEVNULL)
    except (asyncssh.Error, OSError) as exc:
        logger.info("終端機:收線前結束程式失敗(%s):%s", session.label, exc)
        return
    lines = str(result.stdout or "").strip().splitlines()
    m = _END_PROGRAMS_RESULT.match(lines[-1]) if lines else None
    if m and int(m.group(1)) > 0:
        killed = int(m.group(2) or 0)
        audit.record(
            "terminal_end_programs",
            actor=session.username,
            ip=session.ip,
            detail=f"{session.label} {m.group(1)} 支" + (f"(其中 {killed} 支強制結束)" if killed else ""),
        )


#: 網站帳號 → 它現在開著的那幾條(可以用分頁多開)。
#: 上限 `config.SSH_TERMINAL_MAX_SESSIONS`;滿了就**拒絕新的**,不是踢掉舊的 ——
#: 舊的那條可能正在跑東西。
_sessions: dict[str, dict[str, Session]] = {}
#: session_id → Session,給檔案 API 查。
_by_id: dict[str, Session] = {}


def _register(session: Session) -> None:
    _sessions.setdefault(session.username, {})[session.session_id] = session
    _by_id[session.session_id] = session


def _unregister(session: Session) -> None:
    mine = _sessions.get(session.username)
    if mine is not None:
        mine.pop(session.session_id, None)
        if not mine:
            del _sessions[session.username]
    _by_id.pop(session.session_id, None)


def session_count(username: str) -> int:
    """這個人現在開著幾條。"""
    return len(_sessions.get(username, {}))


async def close_session(session: Session, reason: str) -> None:
    """從登錄簿拿掉、然後關掉。**所有要關 session 的地方都走這支**,不要直接叫 `session.close`。"""
    _unregister(session)
    await session.close(reason)


async def close_user(username: str) -> int:
    """刪帳號時:關掉這個人還開著的每一條。回傳關了幾條。

    不關的話:登錄簿以帳號名為 key,連線本身還留在主機上、佔著名額,
    要等 `token_watch` 下一輪才收(token 收回只會讓它在 30 秒內發現)。
    """
    mine = list(_sessions.get(username, {}).values())
    await asyncio.gather(*(close_session(s, "revoked") for s in mine), return_exceptions=True)
    return len(mine)


def get_session(session_id: str, username: str) -> Optional[Session]:
    """檔案 API 用:這個 session_id 存在、而且是這個人的,才回。"""
    s = _by_id.get(session_id)
    if s is None or s.username != username or s.close_reason is not None:
        return None
    return s


def active_sessions() -> list[Session]:
    return [s for mine in _sessions.values() for s in mine.values()]


def _label(host: config.TerminalHost) -> str:
    """給人看的標籤(`user@main-server` 或設定檔裡的名字)。規則在 `config` 那邊,
    因為主機清單那支 API 也要用同一份 —— 兩邊各算一次就會出現「卡片上寫 A、頁籤上寫 B」。"""
    return config.terminal_host_label(host)


def _host_password(host: config.TerminalHost) -> str:
    """這台主機的密碼。json 裡只有**環境變數名**,值在 .env(json 進得了版控)。

    ⚠️ `SSH_TERMINAL_PASSWORD` 這個名字要讀 `config` 上的值、不是 `os.environ` ——
    測試 monkeypatch 的是前者(test_terminal_bridge.py),讀 environ 的話那些測試會
    拿著真的密碼去連真的主機。
    """
    name = host["password_env"]
    if not name:
        return ""
    if name == "SSH_TERMINAL_PASSWORD":
        return config.SSH_TERMINAL_PASSWORD
    return os.environ.get(name, "")


async def _connect_host(
    host: config.TerminalHost, tunnel: Optional[asyncssh.SSHClientConnection] = None
) -> asyncssh.SSHClientConnection:
    """連一台主機。給了 `tunnel` 就**從那條連線裡**連出去(等同 ssh 的 ProxyJump)。

    ⚠️ 錯誤訊息一律標明是**哪一台**:兩跳的時候「連不上」有兩種意思,不寫清楚的話
    管理員得自己猜是跳板主機掛了、還是跳板到目標主機那一段不通。
    """
    label = config.terminal_host_label(host)
    known_hosts = host["known_hosts"]
    if not os.path.isfile(known_hosts):
        raise TerminalError(
            CLOSE_UNREACHABLE,
            f"{label}:找不到主機金鑰檔(known_hosts),請管理員用 ssh-keyscan 產生(見 deploy/docker/ssh/README.md)",
        )
    kwargs: dict = {}
    if host["key_file"]:
        if not os.path.isfile(host["key_file"]):
            raise TerminalError(CLOSE_UNREACHABLE, f"{label}:找不到 SSH 金鑰檔,請管理員檢查設定")
        kwargs["client_keys"] = [host["key_file"]]
    else:
        # 沒有金鑰就**只**用密碼:client_keys=[] 讓 asyncssh 不去翻 ~/.ssh 與 agent。
        kwargs["client_keys"] = []
        password = _host_password(host)
        if not password:
            raise TerminalError(CLOSE_UNREACHABLE, f"{label}:沒有可用的憑證(金鑰與密碼都沒設)")
        kwargs["password"] = password
    if tunnel is not None:
        kwargs["tunnel"] = tunnel

    try:
        return await asyncio.wait_for(
            asyncssh.connect(
                host["host"],
                port=host["port"],
                username=host["user"],
                known_hosts=known_hosts,
                # 不要 x11 / agent 轉發:這條連線只做終端機與 SFTP。
                agent_forwarding=False,
                x11_forwarding=False,
                # ⚠️ **SSH 這一段也要 keepalive**:閒置不自動斷線時,一條沒人打字的連線可能在
                # 「這裡 ↔ 主機」被中間的 NAT / VPN 悄悄回收 —— 兩跳的連線更容易遇到。
                # asyncssh 自己會在 `keepalive_count_max` 次沒回應之後斷開,那也正是我們要的:
                # **真的死掉要被發現**,而不是留一條看起來還在的殼。
                # 0 直接傳下去 —— asyncssh 的 `keepalive_interval=0` 就是「不送」,跟這個設定值的 0 同義。
                keepalive_interval=config.SSH_TERMINAL_KEEPALIVE_SEC,
                **kwargs,
            ),
            timeout=config.SSH_TERMINAL_CONNECT_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError as exc:
        raise TerminalError(
            CLOSE_UNREACHABLE,
            f"{label}:連線逾時({config.SSH_TERMINAL_CONNECT_TIMEOUT_SEC} 秒內沒有回應)",
        ) from exc
    except asyncssh.HostKeyNotVerifiable as exc:
        raise TerminalError(
            CLOSE_UNREACHABLE,
            f"{label}:主機金鑰不符,請管理員重新用 ssh-keyscan 產生 known_hosts(見 deploy/docker/ssh/README.md)",
        ) from exc
    except asyncssh.PermissionDenied as exc:
        raise TerminalError(CLOSE_UNREACHABLE, f"{label}:sshd 拒絕登入(金鑰或密碼不對)") from exc
    except asyncssh.KeyImportError as exc:
        raise TerminalError(CLOSE_UNREACHABLE, f"{label}:SSH 金鑰檔讀不出來,請管理員檢查") from exc
    except (OSError, asyncssh.Error) as exc:
        raise TerminalError(CLOSE_UNREACHABLE, f"{label}:連不上 sshd({exc})") from exc


# ------------------------------------------------------------------ 目前目錄(檔案欄跟著走)
async def _list_pts(sftp: asyncssh.SFTPClient) -> frozenset[str]:
    """`/dev/pts` 底下那些數字檔名。讀不到(不是 Linux、沒權限)就回空的。"""
    try:
        names = await sftp.readdir("/dev/pts")
    except (asyncssh.Error, OSError):
        return frozenset()
    out = set()
    for n in names:
        name = n.filename if isinstance(n.filename, str) else n.filename.decode("utf-8", "replace")
        if name.isdigit():
            out.add(name)
    return frozenset(out)


async def _detect_shell_pid(session: Session) -> Optional[int]:
    """找出 PTY 裡那個 shell 的 PID —— 檔案欄要跟著它的目前目錄走。

    **不動主機上的任何設定**(不改 `.bashrc`、不送 `PROMPT_COMMAND`、不在畫面上打字):
    開 PTY 前後各看一次 `/dev/pts`,多出來的那一格就是這條連線的 tty;那個 tty 上的
    **session leader**(`pid == sid`)就是 sshd 幫我們開的那個 shell。

    ⚠️ 大家在主機上可能**都是同一個帳號**,所以認錯 tty = 檔案欄跟到**別人那條連線**的目錄。
    因此寧可不追蹤也不猜:多出**不只一格**就放棄;只多一格時還要再等一下**確認**這中間沒有
    別人也連進來(我們的那一格慢了半拍、別人的先出現,看起來也是「剛好一格」)。
    代價是同一瞬間有兩個人連進來時兩邊都不追蹤:少一個功能勝過指到別人的目錄。

    拿不到就回 None,整個追蹤靜靜地不做,終端機本身完全不受影響。
    """
    for delay in (0.2, 0.5, 1.0):
        await asyncio.sleep(delay)
        new = sorted(await _list_pts(session.sftp) - session.pts_before)
        if len(new) == 1:
            break
        if len(new) > 1:
            return None
    else:
        return None
    await asyncio.sleep(0.5)
    if sorted(await _list_pts(session.sftp) - session.pts_before) != new:
        return None
    tty = f"pts/{new[0]}"
    session.tty_name = tty
    try:
        result = await asyncio.wait_for(
            session.conn.run(f"ps -t {tty} -o pid=,sid=", check=False), timeout=5
        )
    except (asyncio.TimeoutError, asyncssh.Error, OSError):
        return None
    for line in (result.stdout or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[0] == parts[1]:
            return int(parts[0])
    return None


#: `stty -a` 裡的 `erase = ^H;`
_ERASE = re.compile(r"\berase = (\S+?);")


#: 讀不出來(stty 失敗、輸出不認得)的回傳值:**跟「確定是 ^?」不一樣**——呼叫端遇到它要保留上一次的結果
UNKNOWN = object()


def parse_erase(stty_output: str):
    """`stty -a` 的輸出 → 那條 tty 的刪除鍵:`^H` → b"\\x08";`^?` → None(就是瀏覽器送的那個,不用換);
    讀不出來 → `UNKNOWN`(呼叫端保留上一次讀到的,不要把已經測到的 ^H 洗掉)。"""
    m = _ERASE.search(stty_output)
    if not m:
        return UNKNOWN
    spec = m.group(1)
    if spec == "^?":
        return None
    if len(spec) == 2 and spec[0] == "^" and "@" <= spec[1].upper() <= "_":
        return bytes([ord(spec[1].upper()) - 64])
    return UNKNOWN


#: 主機 id → 那台最後一次測到的刪除鍵。一條連線偵測不到自己的 tty(同一瞬間有別人連進來、
#: `ps` 失敗)時拿它當預設(`known_erase`)。只在記憶體。
_ERASE_BY_HOST: dict[str, Optional[bytes]] = {}


def known_erase(host_id: str) -> Optional[bytes]:
    return _ERASE_BY_HOST.get(host_id)


def remember_erase(host_id: str, erase: Optional[bytes]) -> None:
    _ERASE_BY_HOST[host_id] = erase


async def read_erase(conn: asyncssh.SSHClientConnection, tty_name: str, timeout: float = 5):
    """那條 tty 現在的刪除鍵(`parse_erase` 的三種回傳)。要 Linux 的 `stty -F`。"""
    try:
        result = await asyncio.wait_for(conn.run(f"stty -a -F /dev/{tty_name}", check=False), timeout=timeout)
    except (asyncio.TimeoutError, asyncssh.Error, OSError):
        return UNKNOWN
    return parse_erase(str(result.stdout or ""))


def translate_backspace(data: bytes, erase: Optional[bytes]) -> bytes:
    """瀏覽器的 Backspace 送的是 `^?`(0x7f);主機那頭如果把刪除鍵設成別的(老系統的 .profile
    常寫 `stty erase ^H`),那個 `^?` 會被當成一般字元印出來 —— 畫面上就是一串 `^?`。

    **只換「整段都是 Backspace」的那幾格**(一次按、或按住連發):貼上的內容裡就算剛好夾了 0x7f,
    那也是使用者要送的資料,不能動。
    """
    if erase and data and data.strip(b"\x7f") == b"":
        return erase * len(data)
    return data


#: 登入之後前 `ERASE_FAST_FOR_SEC` 秒每 `ERASE_FAST_SEC` 秒看一次刪除鍵(.profile 多半在這段時間設 stty),
#: 之後每 `ERASE_SLOW_SEC` 秒一次就好(有人在 shell 裡自己下 stty 也跟得上)
ERASE_FAST_SEC = 2.0
ERASE_FAST_FOR_SEC = 60.0
ERASE_SLOW_SEC = 60.0
#: 按 Backspace 時,上一次讀 stty 超過這麼久就先讀一次再送(`backspace_needs_refresh`)。
#: 光靠上面的輪詢,`.profile` 下完 `stty erase ^H` 到下一輪讀到之間最長 2 秒,那段時間按的都會印成 `^?`。
#: 按住連發的那一串沿用剛讀到的,不會每一下都讀。
ERASE_ON_KEY_SEC = 1.0
#: 按鍵時那一趟讀的上限:比輪詢的 5 秒短 —— 這段時間使用者的輸入是停著的。
ERASE_ON_KEY_TIMEOUT_SEC = 1.5


async def refresh_erase(session: Session, timeout: float = 5) -> None:
    """讀一次這條連線的刪除鍵,更新 `session.erase`。輪詢與按鍵前那一趟共用。讀不出來就保留上一次的。"""
    if not session.tty_name:
        return
    value = await read_erase(session.conn, session.tty_name, timeout)
    session.erase_checked_at = time.monotonic()
    if value is UNKNOWN:
        if session.erase_readable and session.erase is None and session.host_id not in _ERASE_BY_HOST:
            # 一次都沒成功過:多半是這台沒有 `stty -F`(不是 Linux)。按鍵前就不再先讀
            session.erase_readable = False
        return
    session.erase_readable = True
    session.erase = value
    remember_erase(session.host_id, value)


def backspace_needs_refresh(session: Session, data: bytes, now: float) -> bool:
    """這一格輸入送出去之前,要不要先讀一次 stty(見 `ERASE_ON_KEY_SEC`)。只看「整段都是 Backspace」的輸入。"""
    return (
        bool(data)
        and data.strip(b"\x7f") == b""
        and session.tty_name is not None
        and session.erase_readable
        and now - session.erase_checked_at >= ERASE_ON_KEY_SEC
    )


async def _read_cwd(session: Session) -> Optional[str]:
    """`/proc/<shell>/cwd` 指到哪。**不呼叫 `touch()`** —— 看一眼不算活動,不然閒置永遠不會到。"""
    if session.shell_pid is None:
        return None
    try:
        target = await session.sftp.readlink(f"/proc/{session.shell_pid}/cwd")
    except (asyncssh.Error, OSError):
        return None
    if target is None:
        return None
    path = target if isinstance(target, str) else target.decode("utf-8", "replace")
    return path or None


def check_quota(username: str) -> None:
    """名額**開連線之前**就檢查:連上了才發現不能用的話,主機那頭已經多開了一個 session。"""
    if session_count(username) >= config.SSH_TERMINAL_MAX_SESSIONS:
        raise TerminalError(
            CLOSE_TOO_MANY,
            f"最多同時開 {config.SSH_TERMINAL_MAX_SESSIONS} 條連線,關掉一個頁籤再開。",
        )


async def open_session(
    username: str,
    ip: str,
    cols: int,
    rows: int,
    host_id: str = "",
    *,
    token: str,
) -> Session:
    """連進主機清單裡的某一台(`host_id`),開 PTY 與 SFTP,登錄成這個人的 session。

    `host_id` 是 `terminal_hosts.json` 的 id(在主機清單上點哪一台就連哪一台)。
    ⚠️ 瀏覽器能指定的**只有這個 id**,位址 / 帳號 / 憑證仍然全部在伺服器這邊 ——
    不認得的 id 一律拒絕,**不要退回第一台**:那會變成「點 B 卻連到 A」。
    沒給 id 的走清單上的第一台。

    連不上一律 raise :class:`TerminalError`(code = WebSocket 關閉碼),訊息是給人看的中文,
    **不含憑證**。同一個人可以同時開好幾條,名額在開連線**之前**就檢查。

    `token` 是**強制具名**的:那張登入 token 要跟著 session 走,`run_session` 的看門狗
    才問得出「這個人還登入著嗎」。給它預設值的話,漏傳的那條連線會變成一條**收不回來的
    shell** —— 而那件事從畫面上完全看不出來,所以寧可讓漏傳的人在呼叫端就紅。
    """
    if not config.ssh_terminal_available():
        raise TerminalError(CLOSE_DISABLED, "SSH 終端機沒有開啟")
    host = config.find_terminal_host(host_id) if host_id else config.default_terminal_host()
    if host is None:
        raise TerminalError(CLOSE_UNREACHABLE, "不認得這一台主機,請重新整理再選一次")

    # 名額**開連線之前**就檢查
    check_quota(username)
    tunnel = None
    if host["via"]:
        # 兩跳(經跳板的路由):先連跳板,再從**那條連線裡**連目標。
        # 等同 ssh 的 ProxyJump —— 服務本身連不到目標,路由與金鑰都在跳板身上。
        jump_host = config.find_terminal_host(host["via"])
        if jump_host is None:
            raise TerminalError(
                CLOSE_UNREACHABLE,
                f"設定裡找不到跳板主機「{host['via']}」,請管理員檢查 terminal_hosts.json",
            )
        tunnel = await _connect_host(jump_host)
    try:
        conn = await _connect_host(host, tunnel=tunnel)
    except BaseException:
        # 第一段連上了、第二段沒有(或被取消)—— 跳板那條要收掉,不然它會一直掛在跳板主機上
        if tunnel is not None:
            tunnel.close()
        raise

    try:
        # SFTP 先開:開 PTY **之前**要先拍一張 /dev/pts 的快照,等一下才認得出哪一格是自己的
        # tty(`_detect_shell_pid`)。這一步失敗不影響終端機,只是不追蹤目前目錄。
        sftp = await conn.start_sftp_client()
        start = host["start_dir"] or "~"
        home = await sftp.realpath("." if start == "~" else start)
        pts_before = await _list_pts(sftp)
        process = await conn.create_process(
            term_type="xterm-256color",
            term_size=(max(cols, 20), max(rows, 5)),
            encoding=None,
        )
    except BaseException as exc:
        # 包括**被取消**(這中間關了分頁):不收的話這條 SSH、跳板都留著
        conn.close()
        if tunnel is not None:
            tunnel.close()
        if isinstance(exc, (OSError, asyncssh.Error)):
            raise TerminalError(CLOSE_UNREACHABLE, f"連上了但開不了終端機:{exc}") from exc
        raise

    session = Session(
        session_id=secrets.token_urlsafe(16),
        username=username,
        token=token,
        ip=ip,
        conn=conn,
        process=process,
        home=str(home),
        label=_label(host),
        sftp=sftp,
        host_id=host["id"],
        tunnel=tunnel,
        pts_before=pts_before,
    )
    _register(session)
    # 稽核要看得出**連了哪一台**:經跳板的那幾條尤其重要。
    via = f"(經 {config.terminal_host_label(config.find_terminal_host(host['via']) or {})})" if host["via"] else ""
    audit.record(
        "terminal_connect",
        actor=username,
        ip=ip,
        detail=f"{session.label}{via}:{host['port']}",
    )
    return session


# ------------------------------------------------------------------ 橋接
def status_payload(session: Session) -> str:
    """連上時給前端的第一則訊息:session_id(檔案 API 要帶)、家目錄、標籤、上傳上限、
    同時能開幾條(頁籤的上限,**只有這一份**,前端不自己寫死)、AI 助手在不在(沒有 CLI 的
    主機那顆按鈕根本不要畫)。"""
    from . import terminal_ai  # 放這裡:避免模組層互相 import

    return json.dumps(
        {
            "type": "status",
            "state": "connected",
            "session_id": session.session_id,
            "home": session.home,
            "label": session.label,
            # 主機清單要知道這條連的是哪一台(閒置的螢幕保護靠它決定誰亮著)
            "host_id": session.host_id,
            "max_upload_mb": config.MAX_REQUEST_MB,
            "max_sessions": config.SSH_TERMINAL_MAX_SESSIONS,
            "ai_enabled": terminal_ai.available(),
        },
        ensure_ascii=False,
    )


def cwd_payload(path: str) -> str:
    """終端機的目前目錄變了。前端的檔案欄收到就跟過去。"""
    return json.dumps({"type": "cwd", "path": path}, ensure_ascii=False)


def dir_payload(path: str) -> str:
    """這個目錄裡的東西變了(終端機裡 mkdir / rm / mv 之類)。
    前端的檔案欄正好開著這個目錄就重列,開著別的就不理。"""
    return json.dumps({"type": "dir", "path": path}, ensure_ascii=False)


def _reason_entry(reason: str) -> tuple[int, str]:
    """查 `CLOSE_REASONS`。**查不到不要靜悄悄當成正常結束** —— 記一筆再退回「錯誤」。

    靜默落回 1000 + 「連線已結束。」的話,看起來跟使用者自己打 exit 一模一樣,稽核上也看不出哪裡不對。
    """
    entry = CLOSE_REASONS.get(reason)
    if entry is None:
        logger.error("終端機:沒有登記的結束原因 %r —— 把它加進 CLOSE_REASONS", reason)
        return 1011, "連線發生錯誤。"
    return entry


def close_code_for(reason: str) -> int:
    return _reason_entry(reason)[0]


def closed_message(reason: str) -> str:
    if reason == "idle":
        timeout = config.SSH_TERMINAL_IDLE_TIMEOUT_SEC
        # ⚠️ 0 = 不自動斷線(預設),那時候這條路根本不會被走到 —— 真的被走到也
        # **不要湊出「1 分鐘沒有操作」這種永遠不成立的話**。
        # 這一句跟前端 4408 那句逐字一樣。
        if timeout <= 0:
            return "太久沒有操作,已自動斷線。"
        return f"{max(1, round(timeout / 60))} 分鐘沒有操作,已自動斷線。"
    return _reason_entry(reason)[1]


def closed_payload(reason: str, message: Optional[str] = None, code: Optional[int] = None) -> str:
    """`closed` 訊息。橋接結束與拒連(routers 的 _reject)都用這一支組,格式只有一份。"""
    body = {
        "type": "closed",
        "reason": reason,
        "code": code if code is not None else close_code_for(reason),
        "message": message if message is not None else closed_message(reason),
    }
    return json.dumps(body, ensure_ascii=False)


async def run_session(session: Session, transport: Transport) -> str:
    """把一條 session 接到一個 transport 上,跑到其中一邊結束為止。回傳結束原因。

    幾件事同時進行:sshd → 瀏覽器、瀏覽器 → sshd、閒置看門狗、**登入看門狗**
    (`token_watch`:登出 / 停用 / 改密碼要收得掉這條連線)、keepalive、
    以及「別人把這條關了」(服務要停時的 `close_all`)。任何一個先結束,其餘全部取消;
    最後由這裡送 `closed` 訊息並關 WebSocket。
    """
    try:
        await transport.send_text(status_payload(session))
    except Exception:  # noqa: BLE001
        # 連上主機的那一刻瀏覽器已經走了(連線中途關分頁;開發模式 React 會開一次、馬上關掉再開一次)。
        # ⚠️ 不收的話這條 session 留在登錄簿裡:佔一個名額、SSH 一直連著,而且會被當成「還開著」拿去沿用,
        # 幾輪下來名額會被這種殭屍佔滿
        await close_session(session, "left_page")
        return "left_page"

    async def pump_out() -> str:
        try:
            while True:
                data = await session.process.stdout.read(CHUNK)
                if not data:
                    return "exit"
                await transport.send_bytes(data)
        except Disconnected:
            return "left_page"
        except (asyncssh.Error, OSError):
            return "server"

    async def pump_in() -> str:
        while True:
            try:
                frame_kind, payload = await transport.receive()
            except Disconnected:
                return "left_page"
            if frame_kind == "bytes":
                if payload:
                    if backspace_needs_refresh(session, payload, time.monotonic()):
                        await refresh_erase(session, ERASE_ON_KEY_TIMEOUT_SEC)
                    session.process.stdin.write(translate_backspace(payload, session.erase))  # type: ignore[arg-type]
                    session.touch()
                continue
            try:
                msg = json.loads(payload) if payload else {}
            except ValueError:
                continue
            msg_type = msg.get("type")
            if msg_type == "resize":
                cols, rows = int(msg.get("cols") or 0), int(msg.get("rows") or 0)
                if cols >= 20 and rows >= 5:
                    session.process.change_terminal_size(cols, rows)
            elif msg_type == "activity":
                session.touch()

    async def watchdog() -> str:
        timeout = config.SSH_TERMINAL_IDLE_TIMEOUT_SEC
        if timeout <= 0:
            await asyncio.Event().wait()  # 0 = 不做閒置逾時
        while True:
            remaining = timeout - session.idle_seconds()
            if remaining <= 0:
                return "idle"
            await asyncio.sleep(min(remaining, 1.0))

    async def token_watch() -> str:
        """**登出 / 改密碼 / 停用 / 職稱降級,要能把已經開著的 shell 收掉。**

        握手時驗過一次身分之後,連線本身不會再回頭看 —— 而閒置預設不斷線
        (`SSH_TERMINAL_IDLE_TIMEOUT_SEC=0`)、keepalive 又主動撐著,所以那條連線可以無限期活著:
        後台把一個帳號按成停用,他瀏覽器上那個頁籤仍然是一個開著的 shell,直到他自己關掉或服務重啟。
        (`revoke_all_for` 只清 `auth._tokens`,不會去關 session。)

        兩個問題各擋一種情況,**都要問**:
          `auth.username_for` —— token 還在不在(登出、改密碼、停用、重設、刪除
            都會走 `revoke_all_for`),以及 `AUTH_TOKEN_TTL_SEC` 那個絕對上限到了沒。
          `auth.can_use_terminal` —— 身分還夠不夠(職稱改成沒有完整權限的、帳號被停用)。
            這一支是**後盾**:上面那些路徑理論上都會撤 token,但「改職稱」哪天忘了撤,
            這裡照樣收得掉。權限判斷跟握手那一刻走同一支,不另寫一份。

        ⚠️ 問 `username_for` 會**推後閒置計時**,那是刻意的 —— 理由寫在它的說明裡
        (一條還活著的 WebSocket 就證明瀏覽器沒關,而那正是閒置逾時要抓的情境)。
        所以這個看門狗不會讓一條放著不動的終端機斷線,它只在身分真的沒了的時候收線。
        """
        while True:
            await asyncio.sleep(TOKEN_CHECK_SEC)
            if auth.username_for(session.token) is None or not auth.can_use_terminal(session.username):
                logger.info("終端機:登入已失效,收線(%s / %s)", session.username, session.label)
                return "revoked"

    async def closed_elsewhere() -> str:
        """別人把這條關了(服務要停的 `close_all`);那個原因為準。"""
        await session.closed.wait()
        return session.close_reason or "server"

    async def watch_cwd() -> None:
        """目前目錄變了就推一則 `cwd`。**不放進下面那組 `asyncio.wait`** ——
        它結束(這台機器不給看 /proc)不代表連線該結束。任何一步失敗都只是「不追蹤」。"""
        session.shell_pid = await _detect_shell_pid(session)
        if session.shell_pid is None:
            logger.info("終端機:認不出 shell 的 PID,檔案欄不跟隨目前目錄(%s)", session.label)
            return
        misses = 0
        while True:
            path = await _read_cwd(session)
            if path is None:
                # 讀不到就**放慢**,不要永久放棄:一次讀不到可能只是主機忙了一下,
                # 而永久關掉的話使用者看到的症狀是「檔案欄突然不跟了」,還查不出原因。
                # 連續失敗夠多次就退到 10 秒一次,省得一直白跑。
                misses += 1
                if misses == CWD_MISS_LIMIT:
                    logger.info("終端機:讀不到目前目錄,改成慢速重試(%s)", session.label)
            else:
                misses = 0
                if path != session.cwd:
                    session.cwd = path
                    try:
                        await transport.send_text(cwd_payload(path))
                    except Exception:  # noqa: BLE001 —— 瀏覽器先走了,交給 pump_* 收尾
                        return
            await asyncio.sleep(CWD_POLL_SEC if misses < CWD_MISS_LIMIT else CWD_SLOW_POLL_SEC)

    async def watch_dirs() -> None:
        """目前目錄與檔案欄最近列過的目錄,修改時間變了就推一則 `dir`,檔案欄重列(終端機裡 mkdir / rm 之後)。
        跟 `watch_cwd` 一樣**不放進**下面那組 `asyncio.wait`、不算活動;讀不到修改時間的目錄就不盯。
        前端開著的正好是推來的那個目錄才重列,其他的不理 —— 所以這裡多盯幾個無妨,少盯就會漏。

        ⚠️ 盯**最近幾個**,不是只盯最後列完的那個:前端只認最後**發出**的那趟列目錄,而後端最後**列完**的
        不一定是它 —— 掛載當下家目錄與目前目錄兩趟同時在飛,或連點兩個資料夾、前一個比較大回得慢。
        目前目錄是終端機在動的地方,一定要在。
        ⚠️ 只看得到目錄本身的增刪改名;改一個既有檔案的**內容**不會動到目錄的修改時間,那一列的大小與時間不會跟著變。
        """
        settle: dict[str, float] = {}
        while True:
            watched = {p for p in (session.cwd, *session.listed_paths) if p}
            for p in [p for p in session.dir_mtimes if p not in watched]:
                del session.dir_mtimes[p]
            for p in [p for p in settle if p not in watched]:
                del settle[p]
            for p in watched:
                try:
                    mtime = (await session.sftp.stat(p)).mtime
                except (asyncssh.Error, OSError):
                    session.dir_mtimes.pop(p, None)
                    continue
                if mtime is None:
                    continue
                seen = session.dir_mtimes.get(p)
                session.dir_mtimes[p] = int(mtime)
                now = time.monotonic()
                if seen is not None and seen != int(mtime):
                    settle[p] = now + DIR_SETTLE_SEC
                elif p in settle and now >= settle[p]:
                    del settle[p]
                else:
                    continue
                try:
                    await transport.send_text(dir_payload(p))
                except Exception:  # noqa: BLE001 —— 瀏覽器先走了,交給 pump_* 收尾
                    return
            await asyncio.sleep(DIR_POLL_SEC)

    async def keepalive() -> str:
        """定期送一則 `{"type":"ping"}`,讓中間的 proxy 看到有流量 —— **同時當作偵測器**。

        ⚠️ 閒置預設不斷線(見 `config.SSH_TERMINAL_IDLE_TIMEOUT_SEC`),
        於是擋在前面的變成 nginx 的 `proxy_read_timeout`(範本 660 秒):一條沒人動的
        WebSocket 會被它切掉,而使用者看到的原因會是「網路中斷」—— 明明只是沒有人打字。
        這一則訊息跟閒置計時**無關**(那一頭看的是使用者的動作),它只負責讓連線上有東西流過。

        ⚠️ **它要在底下那組 `asyncio.wait` 裡**:送不出去就是
        對面已經走了 —— 半開的 TCP(拔網路線、電腦睡著、VPN 掉線)**不會**讓 `pump_in` 返回,
        而閒置逾時關掉之後,這是唯一還會發現這件事的東西。少了它,那條 session 會一直佔著
        `SSH_TERMINAL_MAX_SESSIONS` 的名額,主機上的 sshd session 也回不來。
        `every <= 0`(把 keepalive 關掉)就永遠等下去 —— 只靠 pump_* 收尾。
        """
        every = config.SSH_TERMINAL_KEEPALIVE_SEC
        if every <= 0:
            await asyncio.Event().wait()  # 0 = 不送,也就沒有這個偵測器
        while True:
            await asyncio.sleep(every)
            try:
                await transport.send_text(json.dumps({"type": "ping"}))
            except Exception:  # noqa: BLE001 —— 送不出去 = 對面走了
                logger.info("終端機:keepalive 送不出去,收線(%s)", session.label)
                return "network"

    async def watch_erase() -> None:
        """Backspace 要送哪個字(`translate_backspace`)。**跟上面的「跟著 cd 走」分開跑**:
        那邊認不出這條的 tty(同一瞬間別人也連進來、`ps` 失敗)不能連帶讓
        Backspace 壞掉 —— 認不出來就用這台主機上次測到的(`known_erase`)。
        tty 是 `watch_cwd` 的 `_detect_shell_pid` 認出來的(`session.tty_name`),這裡只是等它。
        輪詢之間的空窗由按鍵那一頭補(`backspace_needs_refresh`)。"""
        session.erase = known_erase(session.host_id)
        started = time.monotonic()
        while True:
            await refresh_erase(session)
            fast = time.monotonic() - started < ERASE_FAST_FOR_SEC
            await asyncio.sleep(ERASE_FAST_SEC if fast else ERASE_SLOW_SEC)

    cwd_task = asyncio.create_task(watch_cwd())
    dirs_task = asyncio.create_task(watch_dirs())
    erase_task = asyncio.create_task(watch_erase())

    tasks = {
        asyncio.create_task(pump_out()),
        asyncio.create_task(pump_in()),
        asyncio.create_task(watchdog()),
        asyncio.create_task(token_watch()),
        asyncio.create_task(keepalive()),
        asyncio.create_task(closed_elsewhere()),
    }
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        # 這個 handler 被外面取消(伺服器要停、或測試用的 client 離開):
        # 一樣要把 SSH 收掉,不然 sshd 那頭會留一個殭屍 session。
        cwd_task.cancel()
        dirs_task.cancel()
        erase_task.cancel()
        for t in tasks:
            t.cancel()
        await close_session(session, "left_page")
        raise
    cwd_task.cancel()
    dirs_task.cancel()
    erase_task.cancel()
    for t in pending:
        t.cancel()
    reason = "server"
    for t in done:
        try:
            reason = t.result()
        except Exception:  # noqa: BLE001 —— 任何一路炸掉都當 error,不讓整個 WebSocket 卡住
            logger.exception("終端機橋接出錯(%s)", session.label)
            reason = "error"
    # 別人已經把這條關了(服務要停)的話,以那個原因為準:
    # 關掉 SSH 會讓 pump_out 同時讀到 EOF,兩個任務一起完成,不能讓 "exit" 蓋過真正的原因。
    if session.close_reason is not None:
        reason = session.close_reason
    await close_session(session, reason)

    # 瀏覽器那頭已經關了的話,下面兩步會失敗 —— 那正是 left_page,不用管。
    try:
        await transport.send_text(closed_payload(reason))
        await transport.close(close_code_for(reason), reason)
    except Exception:  # noqa: BLE001
        pass
    return reason


def origin_ok(origin: Optional[str], host: Optional[str]) -> bool:
    """瀏覽器帶的 Origin 要跟 Host 同一台、同一個 port。

    沒有 Origin(非瀏覽器的客戶端)不擋:跨站 WebSocket 劫持只有瀏覽器做得到,而瀏覽器一定會送
    Origin;非瀏覽器的客戶端本來就得先有 token。
    """
    if not origin:
        return True
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(origin)
        origin_host = (parts.hostname or "").lower()
        origin_port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return False
    raw = (host or "").strip()
    if raw.startswith("["):
        host_only, _, rest = raw[1:].partition("]")
        port_text = rest.lstrip(":")
    else:
        host_only, _, port_text = raw.partition(":")
    host_only = host_only.lower()
    if not origin_host or origin_host != host_only:
        return False
    if origin_host in ("localhost", "127.0.0.1", "::1"):
        # 本機開發:vite 代理 changeOrigin 會把 Host 改成後端的 port(localhost:8124),
        # 跟瀏覽器的 Origin(localhost:5174)天生對不上;同一台機器上的兩個 port 不是跨站,不比 port。
        return True
    if port_text.isdigit():
        # Host 有明寫 port 就要一模一樣
        return origin_port == int(port_text)
    # Host 沒帶 port = 預設 port。uvicorn 在 nginx 後面看到的 scheme 不一定可信(要 proxy 標頭),
    # 所以不猜是 80 還是 443 —— 兩個預設 port 都算對,其他的(9999)一律不是同一站。
    return origin_port in (80, 443)


# ------------------------------------------------------------------ 檔案(SFTP)
def resolve_path(session: Session, raw: Optional[str]) -> str:
    """把使用者給的路徑收成**絕對路徑**。`~` 與 `~/x` 展開成家目錄;相對路徑 400。

    不做 jail —— SSH 登入帳號自己在主機上的權限就是邊界。但 `..` 一律先正規化,
    給 SFTP 的永遠是乾淨的絕對路徑。
    """
    p = (raw or "").strip() or "~"
    if p == "~":
        p = session.home
    elif p.startswith("~/"):
        p = session.home.rstrip("/") + p[1:]
    p = posixpath.normpath(p)
    if not p.startswith("/"):
        raise TerminalError(400, "路徑必須是絕對路徑")
    return p


#: `ls -l` 第一欄的九個權限位元,由高到低。
_PERM_BITS = "rwxrwxrwx"


def mode_text(permissions: int) -> str:
    """`drwxr-xr-x` / `-rw-r--r--`,跟 `ls -l` 第一欄同一套(setuid / setgid / sticky 也照 ls 的寫法)。"""
    kind = "d" if statmod.S_ISDIR(permissions) else "l" if statmod.S_ISLNK(permissions) else "-"
    out = [kind]
    for i, ch in enumerate(_PERM_BITS):
        out.append(ch if permissions & (0o400 >> i) else "-")
    # setuid / setgid / sticky 蓋在 x 的位置上,大寫表示對應的 x 沒有開
    for bit, idx, on, off in ((statmod.S_ISUID, 3, "s", "S"), (statmod.S_ISGID, 6, "s", "S"), (statmod.S_ISVTX, 9, "t", "T")):
        if permissions & bit:
            out[idx] = on if out[idx] == "x" else off
    return "".join(out)


def _owner_group(name_entry, attrs: asyncssh.SFTPAttrs) -> Tuple[str, str]:
    """擁有者與群組的**名字**。

    SFTP v3 的 attrs 只有 uid / gid 數字,名字在 `longname`(伺服器直接給的 `ls -l` 那一行)
    的第 3、4 欄。OpenSSH 給的就是這個格式;格式不對(別的 sshd、SFTP v4+ 沒有 longname)
    就退回數字,不猜。
    """
    longname = getattr(name_entry, "longname", None)
    if isinstance(longname, bytes):
        longname = longname.decode("utf-8", "replace")
    if longname:
        # 嚴格比對 `ls -l` 的形狀:權限 連結數 擁有者 群組 大小 月 日 時間 名字。
        # 鬆一點的話會抓錯欄 —— 有些 sshd(例如 asyncssh 在 Windows 上)少印一欄,
        # 於是「群組」那一格顯示的是檔案大小。
        parts = longname.split()
        if (
            len(parts) >= 9
            and parts[0][:1] in "-dlbcps"
            and len(parts[0]) == 10
            and parts[1].isdigit()
            and parts[4].isdigit()
        ):
            return parts[2], parts[3]
    uid, gid = attrs.uid, attrs.gid
    return ("" if uid is None else str(uid)), ("" if gid is None else str(gid))


def _entry(name: str, attrs: asyncssh.SFTPAttrs, is_dir: bool, name_entry=None) -> dict:
    """一列檔案。`owner` / `group` / `access` 對應 `ls -l` 那幾欄。"""
    permissions = int(attrs.permissions or 0)
    owner, group = _owner_group(name_entry, attrs) if name_entry is not None else ("", "")
    return {
        "name": name,
        "is_dir": is_dir,
        "size": int(attrs.size or 0),
        "mtime": int(attrs.mtime or 0),
        "mode": permissions & 0o7777,
        "access": mode_text(permissions),
        "owner": owner,
        "group": group,
    }


def _sftp_error(exc: Exception) -> TerminalError:
    if isinstance(exc, asyncssh.SFTPNoSuchFile):
        return TerminalError(404, "找不到這個路徑")
    if isinstance(exc, asyncssh.SFTPPermissionDenied):
        return TerminalError(403, "主機上沒有權限")
    if isinstance(exc, asyncssh.SFTPError):
        return TerminalError(400, f"主機回報:{exc.reason}")
    return TerminalError(502, f"SFTP 失敗:{exc}")


async def list_dir(session: Session, raw_path: Optional[str]) -> dict:
    """列目錄:資料夾在前、名稱排序。連結指向資料夾的也算資料夾。

    ⚠️ **這一支不算活動**(唯一一支不 `touch()` 的檔案操作)。檔案欄會**跟著終端機的
    目前目錄走**,而跟隨那一趟也是列目錄 —— 讓它算活動的話,主機上一支
    `while true; do cd /a; sleep 60; cd /b; done` 就能讓沒人在用的連線永遠不斷,牴觸
    「純輸出不算活動,`tail -f` 放著一樣會斷」。
    **使用者自己**點的那幾種列目錄照樣算活動 —— 前端在使用者發動時另外送一則 `activity`
    (`FilePanel` 的 `load(..., {countsAsActivity: true})`),跟隨的那一趟不送。
    """
    path = resolve_path(session, raw_path)
    try:
        # 修改時間**先**看、再列:列到一半有人動了這個目錄的話,`watch_dirs` 會看到比這個新的時間,
        # 多重列一次;反過來(列完才看)那次變動就被當成已經列過了
        mtime = (await session.sftp.stat(path)).mtime
        names = await session.sftp.readdir(path)
    except (asyncssh.Error, OSError) as exc:
        raise _sftp_error(exc) from exc
    session.listed_paths = [path, *(p for p in session.listed_paths if p != path)][:DIR_WATCH_RECENT]
    if mtime is not None:
        session.dir_mtimes[path] = int(mtime)
    entries = []
    for n in names:
        name = n.filename if isinstance(n.filename, str) else n.filename.decode("utf-8", "replace")
        if name in (".", ".."):
            continue
        perm = int(n.attrs.permissions or 0)
        is_dir = statmod.S_ISDIR(perm)
        if statmod.S_ISLNK(perm):
            try:
                is_dir = await session.sftp.isdir(posixpath.join(path, name))
            except (asyncssh.Error, OSError):
                is_dir = False
        entries.append(_entry(name, n.attrs, is_dir, n))
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {"path": path, "home": session.home, "entries": entries}


async def exists(session: Session, path: str) -> bool:
    try:
        return await session.sftp.exists(path)
    except (asyncssh.Error, OSError) as exc:
        raise _sftp_error(exc) from exc


async def upload(
    session: Session,
    dir_path: str,
    name: str,
    read_chunk: Callable[[], Awaitable[bytes]],
) -> int:
    """把一個檔案寫到 `dir_path/name`。回傳寫了幾個位元組。寫到一半失敗會把半成品刪掉。"""
    target = posixpath.join(dir_path, name)
    session.touch()
    written = 0
    try:
        async with session.sftp.open(target, "wb") as out:
            while True:
                chunk = await read_chunk()
                if not chunk:
                    break
                await out.write(chunk)
                written += len(chunk)
                session.touch()
    except (asyncssh.Error, OSError) as exc:
        try:
            await session.sftp.remove(target)
        except Exception:  # noqa: BLE001
            pass
        raise _sftp_error(exc) from exc
    audit.record(
        "terminal_file_upload",
        actor=session.username,
        ip=session.ip,
        detail=f"{target} {written}B",
    )
    return written


async def download(session: Session, raw_path: Optional[str]) -> Tuple[str, int, AsyncIterator[bytes]]:
    """回 (絕對路徑, 大小, 內容的 async 產生器)。不記稽核(只是讀)。"""
    path = resolve_path(session, raw_path)
    session.touch()
    try:
        attrs = await session.sftp.stat(path)
    except (asyncssh.Error, OSError) as exc:
        raise _sftp_error(exc) from exc
    if statmod.S_ISDIR(int(attrs.permissions or 0)):
        raise TerminalError(400, "這是資料夾,不能下載")

    async def body() -> AsyncIterator[bytes]:
        async with session.sftp.open(path, "rb") as f:
            # session 關了(閒置、被踢)就停,不要對著已關的連線一直讀
            while session.close_reason is None:
                chunk = await f.read(CHUNK)
                if not chunk:
                    break
                session.touch()
                yield chunk

    return path, int(attrs.size or 0), body()


async def delete(session: Session, raw_path: Optional[str]) -> str:
    """刪檔案或**空**資料夾。非空資料夾 400 —— 沒有回收桶,遞迴刪除刻意不做。
    `/` 與家目錄本身也不給刪(空的家目錄刪掉,下一次連線就沒有起點了)。"""
    path = resolve_path(session, raw_path)
    if path == "/" or path == session.home:
        raise TerminalError(400, "不能刪這個目錄")
    session.touch()
    try:
        attrs = await session.sftp.lstat(path)
        if statmod.S_ISDIR(int(attrs.permissions or 0)):
            inside = [n for n in await session.sftp.readdir(path) if n.filename not in (".", "..", b".", b"..")]
            if inside:
                raise TerminalError(400, "資料夾不是空的,請先在終端機裡處理")
            await session.sftp.rmdir(path)
        else:
            await session.sftp.remove(path)
    except TerminalError:
        raise
    except (asyncssh.Error, OSError) as exc:
        raise _sftp_error(exc) from exc
    audit.record("terminal_file_delete", actor=session.username, ip=session.ip, detail=path)
    return path


async def close_all(reason: str = "server") -> None:
    """服務關閉時把所有 session 收掉,不留 sshd 那頭的殭屍。"""
    # 一起收,不要一條一條等:每條收線前都要在目標主機上結束程式(最多 END_PROGRAMS_TIMEOUT_SEC),
    # 一條一條等的話 N 條就是 N 倍,服務管理員可能等不及就把行程砍了,後面那幾條收不乾淨
    await asyncio.gather(*(close_session(s, reason) for s in active_sessions()), return_exceptions=True)
