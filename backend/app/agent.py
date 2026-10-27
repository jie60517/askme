import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import AsyncIterator, Dict, Iterable, List, Optional, Union

from . import config, docgen, outputs_common, pdfgen, slidegen, zipgen

logger = logging.getLogger(__name__)


def _child_env() -> dict:
    """claude 子行程的環境變數:繼承這個行程的,但**拿掉本站自己的機密**。

    create_subprocess_exec 沒傳 env= 的話,子行程會繼承整個 os.environ ——
    而 config 模組頂端的 load_dotenv() 已經把 backend/.env 整份灌進去了。
    也就是 ADMIN_PASSWORD、DATABASE_URL 裡的資料庫密碼這些東西,
    在 agent 眼裡就是幾個隨手可讀的環境變數。任何一個拿得到 Bash 的帳號
    叫它跑一次 `env`,那些值就會被串流到瀏覽器,並且寫進 qa_records.answer
    永久留著 —— 透過提示注入的話,連使用者本人都不需要有這個意圖。

    拿掉的是 config.SECRET_ENV_KEYS(黑名單的理由寫在那裡)。**沒有**動
    ANTHROPIC_* / CLAUDE_* / HOME / PATH:CLI 靠 HOME 找 ~/.claude 的憑證,
    砍掉的話 agent 在主機上會直接不能用。
    """
    env = dict(os.environ)
    for key in config.SECRET_ENV_KEYS:
        env.pop(key, None)
    return env

def collect_stderr(stream: asyncio.StreamReader) -> "tuple[List[bytes], asyncio.Task]":
    """把子行程的 stderr **全程**排空,讀到的東西收在回傳的 list 裡。

    ⚠️ **不讀會卡死**:子行程寫 stderr 寫到把 pipe buffer 填滿之後就停在那裡不動,
    而我們正在 readline() 等它的 stdout,兩邊互等。所以要一個從頭跑到尾的 task。

    回傳 `(chunks, task)`:chunks 邊讀邊長,呼叫端在收尾時 `b"".join(chunks)`;
    task 要在 finally 裡 cancel。

    ⚠️ `terminal_ai.py` 也用這一支。
    """
    chunks: List[bytes] = []

    async def drain() -> None:
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            chunks.append(chunk)

    return chunks, asyncio.create_task(drain())


def feed_stdin(proc: asyncio.subprocess.Process, text: str) -> "asyncio.Task":
    """把提示詞從 stdin 交給 `claude -p`,寫完就關(CLI 讀到 EOF 才開始)。回傳的 task 呼叫端收尾時 cancel。

    **為什麼不放在命令列**:argv 在 `/proc/<pid>/cmdline`,主機沒開 hidepid 的話,
    同一台主機上任何帳號 `ps` 都看得到每一題的問題全文。stdin 只有這個行程看得到。
    也因此不需要 `--`:問題不經過選項解析,「-259 是什麼錯誤?」這種負號開頭的不會被當成旗標。

    用背景 task 寫,不在原地 await:CLI 卡在讀 stdin 之前的話,原地等會繞過呼叫端的逾時。
    CLI 先退出了(參數錯之類)寫入會 BrokenPipe —— 吞掉,原因照樣從 stderr / 結束代碼看得到。
    """

    async def write() -> None:
        assert proc.stdin is not None
        try:
            proc.stdin.write(text.encode("utf-8"))
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError, RuntimeError):
                pass

    return asyncio.create_task(write())


class _Ticket:
    """一題的號碼牌。狀態只會 waiting → running → left,或 waiting → left。"""

    def __init__(self, user: Optional[str]):
        self.user = user
        self.state = "waiting"
        # 輪到它的那一刻由 `_Lane._admit` 設好 —— 跟計數加一是同一步
        self.granted: asyncio.Future = asyncio.get_running_loop().create_future()


class _Lane:
    """一組併發名額:全站最多 `capacity` 題,每人最多 `per_user` 題(0 = 不限)。

    同時最多幾個 claude 子行程在跑,超過的請求會排隊,等前面某個問答結束
    釋放名額才會真的啟動子行程。

    **一組只有一條隊伍,兩個條件在輪到誰的那一刻一起看**(`_admit`):照排隊順序
    往下找,第一個「全站有空位、而且自己還沒滿」的先跑;自己滿了的跳過,不擋
    後面的人。不做成「每人一把 semaphore + 全站一把」疊起來,是因為那樣先排完
    自己那條的人會被排到全站隊尾、被晚來的人插隊,順位還會從自己那條跳到全站那條。
    """

    def __init__(self, capacity: int, per_user: int = 0):
        self.capacity = capacity
        self.per_user = per_user
        self.active = 0
        self.active_by_user: Dict[str, int] = {}
        self.waiting: List[_Ticket] = []

    def enter(self, user: Optional[str]) -> _Ticket:
        """拿號碼牌。有空位就當場輪到(`granted` 已經 done),不然在隊伍裡等。

        `user` 是 None 的不算人頭(只吃全站那道)。"""
        ticket = _Ticket(user)
        self.waiting.append(ticket)
        self._admit()
        return ticket

    def position(self, ticket: _Ticket) -> int:
        """排第幾個。前面的人只會離開,所以這個數字只會往下降。"""
        return self.waiting.index(ticket) + 1

    def leave(self, ticket: _Ticket) -> None:
        """跑完、出錯、排隊中被取消都走這裡;重複呼叫無害。"""
        if ticket.state == "running":
            self.active -= 1
            if ticket.user:
                left = self.active_by_user[ticket.user] - 1
                if left:
                    self.active_by_user[ticket.user] = left
                else:
                    del self.active_by_user[ticket.user]
        elif ticket.state == "waiting":
            self.waiting.remove(ticket)
        ticket.state = "left"
        self._admit()

    def _user_full(self, user: Optional[str]) -> bool:
        return bool(user) and self.per_user > 0 and self.active_by_user.get(user, 0) >= self.per_user

    def _admit(self) -> None:
        for ticket in list(self.waiting):
            if self.active >= self.capacity:
                return
            if self._user_full(ticket.user):
                continue
            self.waiting.remove(ticket)
            ticket.state = "running"
            self.active += 1
            if ticket.user:
                self.active_by_user[ticket.user] = self.active_by_user.get(ticket.user, 0) + 1
            ticket.granted.set_result(None)


_ASK_LANE = _Lane(config.MAX_CONCURRENT_ASKS, config.MAX_CONCURRENT_ASKS_PER_USER)

# 多久沒收到 claude 的輸出就送一個 ping,避免連線被當成閒置切掉
HEARTBEAT_SEC = 15

# 子行程 stdout 的單行上限。
#
# asyncio 的 StreamReader 預設是 64 KiB,超過的話 readline() 會直接丟
# `ValueError: Separator is not found, and chunk exceed the limit`,整條串流當場死掉。
# 而 claude 的 stream-json **一行就是一個事件**:附了圖片(base64)或讓它讀了一支
# 完整的大檔(tool_result 會把檔案內容整包帶回來)時,一行破好幾 MB 是常態。
STREAM_LINE_LIMIT = 16 * 1024 * 1024

# 控制字元對照表:除了換行/歸位/tab 以外全部移除。
# 控制字元(終端機畫面裡的跳脫序列之類)送給模型只是雜訊。
_CONTROL_CHARS = {c: None for c in range(32) if c not in (9, 10, 13)}
_CONTROL_CHARS[127] = None

# claude 的 session id 必須是標準 UUID(它自己會擋)。這裡先驗一次,
# 免得資料庫裡存到奇怪的值之後每次續問都失敗。
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def sanitize_text(text: Optional[str], max_chars: int) -> str:
    """把使用者輸入清成「可以安全交給 CLI」的樣子(拿掉控制字元、截到上限)。"""
    cleaned = (text or "").translate(_CONTROL_CHARS).strip()
    if len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars] + "\n\n(問題過長,後面已截斷)"
    return cleaned


def is_valid_session_id(value: Optional[str]) -> bool:
    return bool(value) and bool(_UUID_RE.match(value))


def partial_answer(partial: str, reason: str, advice: str = "") -> str:
    """把「中斷前已經寫出來的內容」包成一則標明不完整的回答。

    逾時(這個檔案)跟使用者按停止(routers/ask.py)都要用同一個格式 ——
    對使用者來說那是同一件事:回答沒寫完。分頭各寫一份的話,改了其中一邊
    另一邊會悄悄長得不一樣。

    內容一定要留著:那可能是等了十分鐘的成果,而且答案通常從結論往下寫,
    被砍掉的反而是比較不重要的部分。
    """
    body = f"{partial}\n\n---\n\n⚠️ **{reason}**"
    return f"{body}\n\n{advice}" if advice else body


def build_context_note(knowledge_base: Optional[dict] = None) -> str:
    """告訴 claude「這一題是哪個專案、程式碼與文件在哪、回答要守哪幾條」。

    路徑只講這個專案自己的:主機上可能還放著別的專案,讀錯專案的答案讀起來一樣有條理,
    從答案表面看不出來。所以明確要求不要讀這幾個路徑以外的原始碼。
    """
    base = knowledge_base or config.get_knowledge_base(None)
    if not base:
        return ""

    notes = [f"這個問題是關於「{base['label']}」這個專案。"]

    roots = base["code_roots"]
    if roots:
        joined = "、".join(roots)
        notes.append(
            f"涉及原始碼時,一律以 {joined} 底下的實際檔案為準(用絕對路徑讀取),"
            f"**不要**去讀這幾個路徑以外的原始碼。"
        )
    if base["knowledge_dirs"]:
        joined = "、".join(base["knowledge_dirs"])
        notes.append(
            f"這個專案的文件在 {joined},需要時請用絕對路徑讀取 —— "
            f"工作目錄裡雖然可能有指向它的 symlink,但用 Glob 找檔案時不會展開。"
        )
    notes.append(
        "回答時附上依據的「檔案:行號」;查不到或讀不到就照實說查不到,不要憑印象補。"
    )
    if base["note"]:
        notes.append(base["note"])

    return "(" + " ".join(notes) + ")"


def build_prompt(
    question: str,
    session_id: str,
    uploaded_filenames: Optional[List[str]],
    knowledge_base: Optional[dict] = None,
) -> str:
    parts = [question]
    context_note = build_context_note(knowledge_base)
    if context_note:
        parts.append(context_note)
    # 上傳檔一律講**絕對路徑**。agent-knowledge 是全站共用的一個位置
    # (見 config.AGENT_KNOWLEDGE_DIR),而 cwd 跟著專案走 —— 相對路徑
    # 只有剛好選到共用工作目錄那個專案時才解得開,其他專案都會讀不到檔案。
    upload_dir = (config.UPLOAD_DIR / session_id).as_posix()
    for filename in uploaded_filenames or []:
        extracted_path = config.UPLOAD_DIR / session_id / f"{filename}.txt"
        if extracted_path.exists():
            # pptx/docx/xlsx 這類二進位格式在上傳當下就已經在後端轉成純文字,
            # 直接讀轉出來的版本,不要叫 claude 自己想辦法解壓縮/解析原始檔案。
            parts.append(
                f"(使用者上傳了檔案 {filename},內容已經預先擷取成純文字,"
                f"請讀取 {upload_dir}/{filename}.txt 取得內容,"
                f"不需要也不要嘗試處理原始的二進位檔案)"
            )
        else:
            parts.append(f"(使用者上傳了檔案 {upload_dir}/{filename},請參考)")
    # 產生檔案的指示一定要講絕對路徑,而且要明講「資料夾已經建好、不要用 shell 指令」。
    #
    # 只寫相對路徑、或沒先建好資料夾的話,claude 會自己想辦法 mkdir / cp —— 但白名單裡
    # 沒有 shell 指令,兩個都被擋,結果它會叫使用者幫它開權限。
    # 所以資料夾由後端先建好(見 stream_agent),它只要用 Write 工具寫檔就好。
    out_dir = (config.OUTPUT_DIR / session_id).as_posix()
    parts.append(
        f"(如果這個問題需要產生**新的**檔案給使用者下載(例如你整理出來的文件),"
        f"請用 Write 工具寫到 {out_dir}/ 底下。這個資料夾已經建好了,**不需要也不要**用 "
        f"mkdir、cp、mv 之類的 shell 指令 —— 那些指令沒有開放,用了只會失敗。"
        f"也不要寫到其他任何路徑。)"
    )
    # Excel / Word / PDF / 簡報 / 壓縮檔都是二進位,Write 工具寫不出來,而白名單裡沒有 Bash
    # 所以也跑不了 python。不講這一段的話,使用者要 Excel 時它會回「我沒辦法產生
    # Excel 檔」—— 但其實它寫得出純文字,後端收尾時會轉(見 sheetgen / docgen / pdfgen /
    # slidegen / zipgen)。
    #
    # ⚠️ 這幾個檔名要跟那幾支模組裡的常數一致,所以直接引用常數,不要寫死字串。
    parts.append(
        f"(**Excel / Word / PDF / 簡報 / 壓縮檔你自己寫不出來(二進位格式,Write 出來一定是壞檔),"
        f"但系統會幫你轉** —— 不要回答「我沒辦法產生這種檔案」。做法是把資料寫成純文字,"
        f"一樣用 Write 寫到 {out_dir}/ 底下:"
        f"① Excel:直接寫 .csv(第一列放欄位標題),系統會自動轉成同名 .xlsx;"
        f"② Word:先寫好 .md,再寫一份 {docgen.MANIFEST_NAME},一行一個要轉的 .md 檔名;"
        f"③ PDF:先寫好 .md,再寫一份 {pdfgen.MANIFEST_NAME},一行一個要轉的 .md 檔名"
        f"(同一份 .md 可以同時列在兩份清單裡,Word 與 PDF 都會產);"
        f"④ 簡報:寫 {slidegen.MANIFEST_NAME},格式是 {slidegen.PROMPT_SHAPE};"
        f"⑤ 多個檔案打包:寫 {zipgen.MANIFEST_NAME},第一行是壓縮檔名,"
        f"其餘一行一個這個資料夾裡的檔名。這幾份清單檔本身不會出現在下載清單裡。"
        f"所有檔案都要**直接寫在 {out_dir}/ 這一層,不要建子資料夾**。)"
    )
    # 檔案裡的資料是使用者拿去對帳、開會用的,掰出來的一列比少一列嚴重得多。
    # 而「列不完就默默少列幾筆」是模型在這種題目上最常見的失誤。
    parts.append(
        "(產生檔案時,內容**只能來自你真的查到的東西**,不要憑印象補齊。"
        "資料量大到列不完時,就明講「只列出前 N 筆」或請使用者縮小範圍 —— "
        "默默少給幾列,使用者不會發現,那比不給還糟。)"
    )
    # 交付「主機上已經存在的檔案」不能靠 Write 把內容重打一遍:
    # 一支大型原始碼動輒好幾萬行、好幾 MB,模型根本吐不完,
    # 就算吐得完也可能漏行或改字 —— 使用者拿到的就不是原始檔了。
    # 所以改成讓它寫一份「清單」,真正的複製由後端做(見 apply_copy_manifest)。
    parts.append(
        f"(如果使用者要的是主機上**已經存在**的檔案(例如某支原始碼),"
        f"**絕對不要**用 Write 把檔案內容重打一遍 —— 大檔案一定會失敗,而且重打出來的"
        f"內容不保證跟原始檔一模一樣。正確做法是用 Write 建立一份清單檔 "
        f"{out_dir}/{COPY_MANIFEST_NAME},一行一個要交付的檔案絕對路徑(不要有其他內容),"
        f"系統會自動把那些檔案原封不動複製進下載資料夾。清單本身不會出現在下載清單裡。)"
    )
    return " ".join(parts)


# 每個工具的「我到底碰了什麼」放在 input 的哪個欄位。
#
# ⚠️ 這張表管的是**畫面上的「執行過程」**—— claude 用得到的工具都要在,
# 沒列到的工具只能靠下面 `_describe_tool_use` 的退路欄位猜。加新工具時記得補這張表。
#
# 「參考來源=讀過哪些程式碼」的語意在前端匯出時才過濾(READ_TOOLS),
# 它的用途是證明回答有沒有根據程式碼(答案下面沒有來源,就代表它沒查程式碼)。
# Write/Edit 是產出不是來源,混進去會稀釋那個訊號。
_TOOL_TARGET_FIELDS = {
    "Read": ("file_path",),
    "Grep": ("path", "pattern"),
    "Glob": ("path", "pattern"),
    "Bash": ("command",),
    # 寫檔與改檔:交付檔案的那幾題全靠它,少了等於「它做了什麼都看不到」
    "Write": ("file_path",),
    "Edit": ("file_path",),
    "MultiEdit": ("file_path",),
    "NotebookEdit": ("notebook_path",),
    # 查外部資料。target 是查詢字串/網址,對使用者來說正是他想知道的那件事
    "WebSearch": ("query",),
    "WebFetch": ("url", "prompt"),
    # 子代理:description 是它自己寫的一句話,比工具名有用
    "Task": ("description", "subagent_type"),
    # 載入一支 skill。欄位叫 skill 而不是上面任何一個,所以**退路欄位也接不到** ——
    # 少了這一列,整個 skill 呼叫在明細與畫面上完全不存在。
    "Skill": ("skill", "args"),
}

# Bash 的 command 是整條指令,可能很長。原樣送到前端會把版面撐爆,
# 也可能把一長串管線指令直接攤在使用者眼前。
_MAX_COMMAND_CHARS = 120

# `target_full` 的上限。這一份不是給版面看的,是給查帳的人看的,所以放寬到指令與
# 路徑幾乎不可能超過的長度 —— 但仍要有上限:Bash 的 command 可以是一整份 heredoc,
# 沒有上限等於讓任何一題把幾 MB 的內容寫進 qa_steps。
_MAX_TARGET_FULL_CHARS = 2000


def _strip_known_root(path: str) -> str:
    """把冗長的絕對路徑縮短成看得懂的樣子,但保留足以分辨來源的前綴。

    /srv/myproject/src/orders/service.py   -> src/orders/service.py
    /srv/myproject-docs/docs/orders.md     -> docs/orders.md

    保留最後一段目錄名是刻意的:使用者要能一眼分辨這筆來源是原始碼還是文件。

    比對前先把分隔線統一成 /。本機在 Windows 上跑的時候路徑是反斜線,
    不統一的話這裡整段比不到,畫面上就會出現一長串完整絕對路徑。
    """
    normalized = path.replace("\\", "/")

    def strip_root(root: str):
        root_norm = root.replace("\\", "/").rstrip("/")
        if not root_norm:
            return None
        # 一定要卡在 / 的邊界上。單純用 startswith 比的話,
        # root=/srv/app 會把 /srv/app2/x 也誤認成自己底下的檔案。
        if normalized == root_norm:
            return ""
        if normalized.startswith(root_norm + "/"):
            return normalized[len(root_norm) + 1 :]
        return None

    # 比對所有專案的路徑,不只目前選的那個 —— 使用者要能一眼看出來源是哪一棵樹。
    # 長的先比,避免 /a/b 把 /a/b/c 底下的檔案先攔走。
    for root in sorted(config.all_known_roots(), key=len, reverse=True):
        if not root:
            continue
        rest = strip_root(root)
        if rest is None:
            continue
        prefix = root.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
        return f"{prefix}/{rest}" if rest else prefix

    # 工作目錄底下的檔案(CLAUDE.md、規則檔)。每個專案有自己的 cwd,所以要全比一輪。
    for workdir in sorted(config.all_workdirs(), key=len, reverse=True):
        rest = strip_root(workdir)
        if rest is not None:
            return rest or "."
    return path


def _describe_tool_use(name: str, raw_input: str) -> Optional[dict]:
    """把一次工具呼叫整理成「參考來源」一筆。

    raw_input 是 input_json_delta 一段一段拼回來的 JSON 字串;工具還沒吐完就中斷的話
    會是不完整的 JSON,解不開就直接跳過,不要讓串流因為這種事整個掛掉。
    """
    fields = _TOOL_TARGET_FIELDS.get(name)
    if not fields:
        # 沒列到的工具(新版 CLI 的內建工具、MCP 工具)**不要直接消失**:
        # 從 input 裡挑一個常見欄位當標的,至少讓那一步看得到。
        fields = ("file_path", "path", "query", "url", "command", "description", "pattern")
    try:
        data = json.loads(raw_input) if raw_input else {}
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    values = [str(data[f]) for f in fields if data.get(f)]
    if not values:
        return None

    # 同一個值滿足不了兩個畫面,所以留兩份。
    #
    #   target       縮短版。聊天頁的「參考來源」要一眼看完,所以砍掉樹根、
    #                Bash 截在 120 字。
    #   target_full  原樣。用量明細要回答的是「哪一棵樹」「那條指令
    #                後半段做了什麼」—— 縮短版剛好把這兩件事都砍掉了。
    #
    # target_full **只進流水帳,不進聊天頁** —— 見 content_block_stop 那段。
    raw = values[0]
    target_full = " ".join(raw.split()) if name == "Bash" else raw
    if len(target_full) > _MAX_TARGET_FULL_CHARS:
        target_full = target_full[:_MAX_TARGET_FULL_CHARS] + "…"

    target = values[0]
    if name == "Bash":
        target = " ".join(target.split())
        if len(target) > _MAX_COMMAND_CHARS:
            target = target[:_MAX_COMMAND_CHARS] + "..."
    else:
        target = _strip_known_root(target)
    detail = values[1] if len(values) > 1 else None
    return {"tool": name, "target": target, "target_full": target_full, "detail": detail}


def _describe_usage(message: dict, parent_tool_use_id: Optional[str]) -> Optional[dict]:
    """把一則 assistant 訊息整理成流水帳裡的「一輪」(models.QAStep)。

    `usage` 的四個欄位在 CLI 的版本之間改過名字,所以每個都給幾個備選名,
    而且**認不得就留 None,不要填 0** —— 0 是一個看起來很正常的數字,
    事後看到一輪 input 是 0 會以為快取全中,而真相是我們根本沒讀到那個欄位。

    回 None 的情況:這則訊息沒帶 usage(例如某些 CLI 版本的中間訊息)。
    寧可少一列,也不要記一列全是 None 的空帳。
    """
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None

    def pick(*names: str) -> Optional[int]:
        for name in names:
            value = usage.get(name)
            if isinstance(value, int):
                return value
        return None

    input_tokens = pick("input_tokens")
    output_tokens = pick("output_tokens")
    cache_read = pick("cache_read_input_tokens", "cache_read_tokens")
    cache_creation = pick("cache_creation_input_tokens", "cache_creation_tokens")
    if input_tokens is None and output_tokens is None:
        return None

    return {
        # 子代理(Task)裡面的模型呼叫要分開標:它一樣要花錢,但不是主線的一輪
        "kind": "subturn" if parent_tool_use_id else "turn",
        "model": message.get("model"),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read,
        "cache_creation_tokens": cache_creation,
    }


#: 唯讀帳號手上這三支工具要收成「只能讀這些路徑」。
_SCOPABLE_READONLY_TOOLS = ("Read", "Grep", "Glob")


def _abs_rule_path(directory: Union[str, Path]) -> str:
    """把一個目錄轉成 Claude Code 路徑規則用的絕對寫法(`//` 開頭、`/**` 結尾)。

    規則走 gitignore 語法,**單一個 `/` 開頭是「專案根目錄起算」而不是檔案系統
    根目錄**,要表達絕對路徑得用兩個斜線。

    ⚠️ **一定要 `resolve()`。** claude 會**先 realpath 再判斷權限**,規則填指向端
    (symlink 本身)的話比不中 —— 症狀是那棵樹整個讀不到,而畫面上只會看到模型說
    找不到檔案,看不出是權限規則沒對上(`config.CLAUDE_EXTRA_DIRS` 同理)。
    `resolve()` 也把相對路徑轉成絕對:`//` 接一段相對路徑會產出一條永遠比不中的規則。
    """
    return "//" + Path(directory).resolve().as_posix().lstrip("/") + "/**"


def scope_readonly_tools(
    allowed_tools: str, readable_dirs: Iterable[Union[str, Path]]
) -> str:
    """把裸的 `Read`/`Grep`/`Glob` 換成路徑限定版,只讓它讀這一題該讀的目錄。

    子行程跟服務**同一個 uid**,而 `Read` 不受 `--add-dir` 約束,所以裸規則等於
    「服務身分讀得到的一切」:`.env` 裡的 `ADMIN_PASSWORD`、`SSH_TERMINAL_KEY_FILE`
    指到的那把私鑰、`~/.claude/.credentials.json`,以及 `~/.claude/projects/` 底下
    **所有人的對話逐字稿**(Grep 就撈得到)。

    **為什麼是限縮允許規則,而不是加一份拒絕清單**:

        設定檔 `permissions.deny` 放 `Read(//etc/hostname)`  → 照樣讀得到
        `--allowedTools "Read(//工作目錄/**)"` 讀界外         → is_error=True
            「Claude requested permissions to read from /etc/hostname,
              but you haven't granted it yet.」

    差別在於 `Read` 一旦被整個放行,路徑層規則就不再被查;不給裸的 `Read`,
    權限層才會逐條比對。**不要改成加 deny。**

    ⚠️ 測這種東西要用「模型沒有理由拒絕」的探針,而且要看 stream-json 裡有沒有
    真的發出 `tool_use`。模型若因 `CLAUDE.md` 的指示**自己**拒絕讀某個檔,
    那是自律不是強制力,換個說法就可能過,證明不了任何事。

    ⚠️ **full 帳號(名單裡有 Bash 的那組)原封不動。** Bash 不吃路徑規則,收了 Read
    擋不住任何事,只會把管理員自己的正常操作弄壞。那組的範圍寫在
    `config.ALLOWED_TOOLS_FULL` 上面。

    ⚠️ `readable_dirs` 少一個目錄,就是那一類檔案從此讀不到(附件、程式碼樹、skill),
    而且畫面上看不出原因。要放行新的目錄請加在呼叫端算 `readable_dirs` 的地方,
    不要在這裡補例外。
    """
    names = [t.strip() for t in allowed_tools.split(",") if t.strip()]
    if any(name == "Bash" or name.startswith("Bash(") for name in names):
        # ⚠️ 判斷條件是「名單裡有 Bash」而不是「這個帳號是 full」—— 所以有人往
        # `CLAUDE_ALLOWED_TOOLS`(唯讀那組)加一條 `Bash(...)` 的話,整個收緊會
        # **靜默失效**。那是設定錯誤不是正常用法,叫一聲,不然沒有人會發現。
        if allowed_tools.strip() != config.ALLOWED_TOOLS_FULL.strip():
            logger.warning(
                "唯讀那組工具名單裡有 Bash(%s)—— 路徑限定整個不生效,Bash 讀得到專案以外的目錄。"
                "請把 Bash 從 CLAUDE_ALLOWED_TOOLS 拿掉。",
                allowed_tools,
            )
        return allowed_tools

    dirs = list(dict.fromkeys(str(d) for d in readable_dirs if d))
    if not dirs:
        # **整支拿掉,不要退回裸規則** —— 退回去等於靜默把洞打開。實際上不會發生
        # (cwd 一定在清單裡,config.resolve_workdir 最後會落到 CLAUDE_WORKDIR),
        # 真的發生了也該是「這題答不出來」。但降級是靜默的,所以要留 log。
        logger.warning("算不出任何可讀目錄,唯讀帳號這一題會沒有 Read/Grep/Glob 可用")

    scoped = []
    for name in names:
        if name not in _SCOPABLE_READONLY_TOOLS:
            scoped.append(name)
            continue
        scoped += [f"{name}({_abs_rule_path(d)})" for d in dirs]
    return ",".join(scoped)


async def stream_agent(
    question: str,
    session_id: str,
    conversation_id: str,
    is_new_conversation: bool,
    claude_session_id: str,
    allowed_tools: str,
    uploaded_filenames: Optional[List[str]] = None,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    knowledge_base: Optional[dict] = None,
    writable_extra_dirs: Optional[List[str]] = None,
    workdir: Optional[str] = None,
    prior_session_ids: Optional[List[str]] = None,
    asker: Optional[str] = None,
) -> AsyncIterator[dict]:
    """逐字串流 claude 的回答。yield 出來的事件：
    {"type": "delta", "text": "..."}                                   文字片段
    {"type": "source", "tool", "target", "detail", "at_ms", "tool_use_id"}  執行過程(**去重**,給使用者看;
                                                                       tool_use_id 對得到後面的 step_duration)
    {"type": "step", "kind", "turn", "at_ms", ...}                     流水帳(**不去重**,給管理員看)
    {"type": "step_duration", "tool_use_id", "duration_ms"}            補上某一步真正的耗時(晚到)
    {"type": "done", "success", "answer", "error", "duration_ms",
                      "cost_usd", "conversation_id"}                   結束,含完整結果
    {"type": "error", "message", "conversation_id"}                    啟動失敗/逾時

    ⚠️ `source` 與 `step` 是兩份**故意不一樣**的資料,不要合併成一份:
    前者去重、會送到瀏覽器;後者完整、只寫進資料庫(見 models.QAStep)。

    `prior_session_ids` 是**這組對話前幾題**的 session_id。唯讀帳號的讀取範圍是
    逐題放行的,少了它,續問就讀不到前幾題的附件 —— `session_id` 是每一題
    一個,第 1 題的 PDF 在 `uploads/{第1題的sid}/`,而第 2 題的規則只涵蓋自己那格。

    `asker` 是**真的按下送出的那個人**(登入身分),用來算每人的併發名額(見 `_Lane`);
    None 的只受全站名額限制。
    """
    question = sanitize_text(question, config.MAX_QUESTION_CHARS)
    prompt = build_prompt(question, session_id, uploaded_filenames, knowledge_base)

    # 是不是新對話由呼叫端判斷(ask.py 會去資料庫看這個 id 有沒有紀錄)。
    # 不能用「有沒有帶 conversation_id」來判斷 —— 前端會自己先產生 id 再送出,
    # 這樣側邊欄跟網址在回答開始的當下就能定位,不用等到回完才知道自己在哪一組對話。
    conv_id = conversation_id

    # claude 的 session id 跟 conversation_id 是兩回事(見 models.ConversationMeta 的說明)。
    session_ref = claude_session_id

    # 格式不對的話 claude 會直接擋(Invalid session ID. Must be a valid UUID),
    # 而且那組對話會從此每次都失敗。與其把錯誤丟給使用者,不如當成新對話重開一個 ——
    # 頂多是接不到前面的上下文,總比整組卡死好。
    if not is_valid_session_id(session_ref):
        session_ref = str(uuid.uuid4())
        is_new_conversation = True

    # 只有這次問答自己的 outputs/{session_id} 資料夾可寫,其餘路徑(尤其程式碼樹)
    # 完全唯讀不受影響。
    #
    # 資料夾先建好。沒建的話 claude 得自己 mkdir,而白名單裡沒有 mkdir ——
    # 它會卡在那裡,然後開始跟使用者解釋「請幫我開權限」。
    # 這一題沒產生任何檔案的話,跑完會由 routers/ask.py 把空資料夾收掉。
    output_dir = config.OUTPUT_DIR / session_id
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        # 建不起來就讓它繼續跑 —— 這一題多半不需要產生檔案,不該因此整題失敗
        pass

    # 路徑規則用絕對路徑(`//srv/...`,由 `_abs_rule_path` 組;雙斜線與 realpath 的
    # 理由寫在那支上面)。不寫相對路徑:相對路徑以工作目錄為基準,而 agent-knowledge
    # 刻意不落在任何專案的工作目錄底下(見 config.AGENT_KNOWLEDGE_DIR),相對那條永遠對不上。
    #
    # 工具名稱同時給 Write 與 Edit:Edit 規則涵蓋所有會改檔案的工具(Write 也算),
    # 不同版本對「該用哪個名字比對」的行為不一定一樣。
    absolute_glob = _abs_rule_path(output_dir)
    scoped_write_rules = [
        f"Write({absolute_glob})",
        f"Edit({absolute_glob})",
    ]
    # 這一題要在哪個目錄裡跑。決定的是「我是誰」——那個目錄的 CLAUDE.md、
    # `.claude/skills/`、以及 session 存到 ~/.claude/projects/ 底下哪一格。
    #
    # 呼叫端(ask.py)沒指定時才從知識庫推。**續問一定要由呼叫端指定**:
    # 那組對話當初的 session 存在當初那個 cwd 底下,換了目錄 --resume 會找不到。
    #
    # ⚠️ 這行要**排在組 `--allowedTools` 之前** —— cwd 同時是唯讀帳號讀取範圍的
    # 第一個目錄(見下面 readable_dirs)。
    cwd = config.resolve_workdir(knowledge_base, workdir)

    # --add-dir 掛哪些目錄。只掛這一題選到的專案,不要把所有專案都掛上去 ——
    # 掛了就等於允許它跨專案亂翻。(真正接到指令列的位置在最下面,那個參數是
    # variadic,必須擺在整條指令的最後。)
    extra_dirs = list(config.CLAUDE_EXTRA_DIRS)
    if knowledge_base:
        extra_dirs += knowledge_base["code_roots"] + knowledge_base["knowledge_dirs"]
        # 同產品環境共用的 skill 目錄。**掛它是為了載入 skill,不是為了讀檔** ——
        # `--add-dir` 進來的目錄會載入它的 `.claude/skills/`,同時也整個變成可讀,
        # 所以那裡只該放 skill。
        if knowledge_base.get("skill_dir"):
            extra_dirs.append(knowledge_base["skill_dir"])
    # full 帳號才有的可寫目錄(例如 flows/,讓它把流程知識累積回去)。
    # 依登入身分決定,由呼叫端(ask.py)算好傳進來 —— 不能讓請求自己指定要寫哪。
    if writable_extra_dirs:
        extra_dirs += writable_extra_dirs
    seen_dirs = list(dict.fromkeys(d for d in extra_dirs if d))

    # 唯讀帳號讀得到的範圍。理由寫在 scope_readonly_tools 上面。
    #
    # ⚠️ **這一題自己的 uploads/{session_id} 一定要在清單裡。** 使用者上傳的附件就放
    # 在那裡,漏掉它就讀不到附件。它與 outputs 刻意**不**進 `--add-dir`(理由見下面那段
    # prompt cache),但**必須**進讀取範圍 —— 兩者是兩件事。
    #
    # ⚠️ 只放這一題自己的那兩個資料夾,**絕對不要放 agent-knowledge 整層** ——
    # 那等於任何人都能叫它去翻別人上傳的檔案與別人的產出。
    readable_dirs = [cwd, *seen_dirs, config.UPLOAD_DIR / session_id, output_dir]
    # 續問要讀得到前幾題的附件與產出(理由見上面 prior_session_ids 那段)。
    # 只放**這組對話自己的**題號,別組對話的一個都不會進來。
    for prior_sid in prior_session_ids or []:
        readable_dirs += [config.UPLOAD_DIR / prior_sid, config.OUTPUT_DIR / prior_sid]
    allowed_tools = scope_readonly_tools(allowed_tools, readable_dirs)

    # 呼叫端依登入身分決定要給哪一組(ask.py 走 auth.allowed_tools_for)
    # —— 這裡不猜預設值,少帶就是呼叫端的錯。
    #
    # 寫入規則要接在收完之後,不然會被 scope_readonly_tools 一起算進去。
    allowed_tools = ",".join([allowed_tools, *scoped_write_rules])
    disallowed_tools = config.DISALLOWED_TOOLS

    # 白名單過濾。這兩個值會直接接在 --model / --effort 後面,
    # API 又是公開的,不能假設一定是從前端下拉選單來的。
    effective_model = config.safe_model(model)
    # effort:呼叫端指定的 → 這個環境的預設(knowledge_bases.json 的 effort,選填)→ 全站預設。
    effective_effort = config.safe_effort(effort or (knowledge_base or {}).get("effort"))

    # 注意:這些旗標的確切名稱與語法會隨 claude CLI 版本調整,部署前請用
    # `claude --help` 對照主機上實際安裝的版本確認一次。
    cmd = [
        config.CLAUDE_BIN,
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--allowedTools",
        allowed_tools,
        "--disallowedTools",
        disallowed_tools,
    ]
    if effective_model:
        cmd += ["--model", effective_model]
    if effective_effort:
        cmd += ["--effort", effective_effort]
    # 快取與成本的三道閘門。**為什麼要有、預設值為什麼是那樣、量測方式**
    # 一律寫在 config 那三個常數上面,這裡不重複(要改預設值就去那邊改,
    # 只有一個地方需要動)。這裡只記兩件在 config 看不到的事:
    #
    #   1. 順序 —— 三個都必須排在 `--add-dir` 之前(它是 variadic,會吃掉後面的參數)。
    #   2. `--exclude-dynamic-system-prompt-sections` **只在預設系統提示下生效**。
    #      哪天在上面加了 `--system-prompt`,CLI 會**靜默**忽略它,症狀是成本悄悄
    #      漲回去而畫面上完全看不出來 —— 要加的話記得同時去 config 更新那段說明。
    if config.CLAUDE_STATIC_SYSTEM_PROMPT:
        cmd.append("--exclude-dynamic-system-prompt-sections")
    if config.CLAUDE_STRICT_MCP:
        cmd.append("--strict-mcp-config")
    if config.CLAUDE_MAX_BUDGET_USD:
        cmd += ["--max-budget-usd", config.CLAUDE_MAX_BUDGET_USD]
    cmd += ["--session-id", session_ref] if is_new_conversation else ["--resume", session_ref]

    # ⚠️ 這一題自己的 uploads/{session_id}、outputs/{session_id} **不掛進 --add-dir**。
    #
    # --add-dir 的清單是 prompt cache 前綴的一部分:同一組對話裡只要這份清單換了一個
    # 目錄,續問的快取就整段失效。session_id 每題都是新的,掛進去等於每次續問都把
    # 整段對話歷史用寫入價重買一次。
    #
    # 那兩個資料夾走 `--allowedTools` 的路徑規則(上面 readable_dirs 與
    # scoped_write_rules):只換 allowedTools 不影響快取,所以規則字串
    # 裡帶 session_id 是安全的,`--add-dir` 裡帶就不是。這兩個參數對快取的待遇不一樣,
    # 不要把它們搬在一起。
    #
    # --add-dir 是 variadic(<directories...>),會一路吃掉後面的參數直到下一個旗標,
    # 所以固定擺在整條指令的最後面,不然會把別人的參數吞進去。
    if seen_dirs:
        cmd += ["--add-dir", *seen_dirs]

    # 問題本身**不放在命令列**,啟動之後從 stdin 送(理由見 feed_stdin;
    # tests/test_prompt_stdin.py 守著)。
    # ⚠️ 命令列最後一個是 variadic 的 --add-dir:要在命令列尾巴再加東西的話,記得先收掉它。

    # ---------------------------------------------------------------- 取得執行名額
    #
    # 主機同時只跑這麼多題,超過就得排隊。這段等待不能靜默:
    # 否則排在後面的人只看到「思考中… 0 秒」慢慢往上跳,分不出是主機在想還是
    # 根本還沒開始;而且整條連線在那段期間一個位元組都沒有,中間的 SSH 通道/
    # 反向代理很容易把它當成死連線直接切掉。所以邊等邊回報順位,順便當心跳用。
    #
    # 卡在自己每人上限的也一樣送全站的 capacity:只有一條隊伍(見 `_Lane`),順位講的就是這條。
    lane = _ASK_LANE
    ticket = lane.enter(asker)

    try:
        while not ticket.granted.done():
            yield {
                "type": "queued",
                "position": lane.position(ticket),
                "capacity": lane.capacity,
            }
            await asyncio.wait({ticket.granted}, timeout=HEARTBEAT_SEC)

        # cwd 在上面組 --allowedTools 的時候就算好了(它同時是唯讀帳號讀取範圍的
        # 第一個目錄)。**只能有一處推導** —— 這裡再算一次的話,兩個值哪天不一樣,
        # 症狀是那組對話續問突然查無 session。
        start = time.time()
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                env=_child_env(),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE,
                limit=STREAM_LINE_LIMIT,
            )
        # ValueError 是參數裡有 NUL 之類的東西;OSError 常見於 CLAUDE_BIN 路徑錯。
        except (OSError, ValueError) as exc:
            yield {
                "type": "error",
                "message": (
                    f"無法啟動 claude CLI(工作目錄 {cwd}),"
                    f"請確認 CLAUDE_BIN 與該專案的 workdir 設定是否正確: {exc}"
                ),
                "conversation_id": conv_id,
            }
            return

        assert proc.stderr is not None
        stderr_chunks, stderr_task = collect_stderr(proc.stderr)
        stdin_task = feed_stdin(proc, prompt)

        text_block_indexes: set[int] = set()
        full_text_parts: List[str] = []
        # 答案從 full_text_parts 的第幾段開始 —— **前面那些是自言自語,不是答案**。
        #
        # 模型在兩次工具呼叫之間會講話(「找它的原始碼。」「檢查實際的實作。」),
        # 那些跟最後的回答一樣都是 text_delta,整串接起來會把過場話混進答案開頭,
        # 而畫面上另外有一塊「執行過程」已經在講它翻了什麼。
        #
        # 所以:**只要又要呼叫工具,就代表前面講的都還只是過程**,把起點往後推。
        # 留下來的是最後一次工具呼叫之後的文字,也就是它總結出來的那一段。
        answer_start_index = 0
        final_result: Optional[dict] = None
        timed_out = False

        # 工具呼叫的參數是分段串流過來的,要照 index 拼回完整 JSON 才解得開
        tool_blocks: dict[int, dict] = {}
        # 只留去重。「參考來源」的累積在 ask.py(record.sources 從 run.sources 來,
        # 過濾也在那邊做),這裡不另外存一份 —— 兩層各存各過濾就是重複程式碼。
        seen_sources: set = set()

        # 流水帳(models.QAStep)的兩個計數器。跟上面那個 set 沒有關係 ——
        # **這裡什麼都不去重**,重複讀同一個檔正是要看到的東西。
        step_seq = 0
        # 上一筆記進流水帳的 assistant 訊息 id,用來去重(見下面 assistant 那一段)
        last_usage_message_id = None
        # tool_use_id → 這通呼叫寫完的時刻。tool_result 回來時相減就是真正的耗時。
        # 沒等到 result 的(被停止、逾時)就一直留在這裡,耗時留 NULL —— 那是事實。
        tool_started_at: dict = {}
        # 第幾輪模型呼叫。工具列先發生、該輪的 assistant 訊息後到(串流順序就是這樣),
        # 所以是「工具掛在目前這一輪,等 assistant 到了才 +1」。
        turn_index = 0

        # 後備:完整的 assistant 訊息(不是逐字串流的那種)。
        # 像 /context、/usage 這類 slash 指令的輸出「完全不會」產生 stream_event,
        # 只會送一則完整的 assistant 訊息 —— 只解析 text_delta 的話會一個字都撈不到,
        # 使用者看到的就是一則空白回答。
        # 一般問答則是兩種都有(delta 與完整的 assistant 訊息),所以這裡只能收著,
        # 不能直接加進答案,否則會整段重複。
        assistant_text_parts: List[str] = []

        def answer_text() -> str:
            """最後一次工具呼叫之後寫的東西,那才是答案(見 answer_start_index)。

            ⚠️ **切完是空的就退回全部。** 最後一輪偶爾一個 text_delta 都沒有
            (例如整題只有 slash 指令的輸出,或收尾那則是完整 assistant 訊息而不是
            逐字串流)。那時候寧可連過程一起給,也不要送一則空白回答出去 ——
            使用者分不出「它沒答」跟「它答了但被我切掉」。
            """
            trimmed = "".join(full_text_parts[answer_start_index:]).strip()
            return trimmed or "".join(full_text_parts).strip()

        assert proc.stdout is not None
        try:
            while True:
                remaining = config.CLAUDE_TIMEOUT_SEC - (time.time() - start)
                if remaining <= 0:
                    timed_out = True
                    break

                # 一次只等一小段,而不是一路等到逾時為止。
                # claude 在讀大檔或思考時可能好幾分鐘不吐任何位元組,如果這段期間
                # 整條 HTTP 連線完全沒有流量,中間的 SSH 通道/反向代理/瀏覽器
                # 很可能把它當成死連線切掉。沒等到東西就送一個 ping 出去,
                # 連線有流量就不會被回收。
                try:
                    raw_line = await asyncio.wait_for(
                        proc.stdout.readline(), timeout=min(HEARTBEAT_SEC, remaining)
                    )
                except asyncio.TimeoutError:
                    if proc.returncode is not None:
                        break
                    yield {"type": "ping", "elapsed_ms": int((time.time() - start) * 1000)}
                    continue
                except ValueError:
                    # 連 STREAM_LINE_LIMIT 都塞不下的一行。readline() 失敗時會把緩衝區
                    # 清掉,所以可以直接接著讀下一行 —— 那種超大行幾乎都是 tool_result
                    # (claude 讀進去的檔案內容),不是答案本身,跳過它比整題失敗好太多。
                    # 剩下的殘骸會在下面的 JSONDecodeError 那裡被濾掉。
                    continue

                if not raw_line:
                    break

                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if data.get("type") == "stream_event":
                    event = data.get("event", {})
                    etype = event.get("type")
                    index = event.get("index")

                    if etype == "content_block_start":
                        block = event.get("content_block", {})
                        if block.get("type") == "text":
                            text_block_indexes.add(index)
                        elif block.get("type") == "tool_use":
                            # id 要收:等一下 tool_result 回來時,它是唯一對得起來的鍵
                            # (index 只在這一則訊息裡有意義,下一輪就重來了)
                            tool_blocks[index] = {
                                "name": block.get("name", ""),
                                "json": "",
                                "id": block.get("id"),
                            }
                            # 它還要繼續做事 —— 前面講的那些話是過程,不是答案。
                            # 前端的答案是靠 delta 累積的,所以光把起點往後推還不夠,
                            # 得同時叫它把畫面上那幾句也清掉,否則串流當下看得到、
                            # 重新整理之後又不見了(同一則回答兩種樣子)。
                            if len(full_text_parts) > answer_start_index:
                                answer_start_index = len(full_text_parts)
                                yield {"type": "answer_reset"}

                    elif etype == "content_block_delta":
                        delta = event.get("delta", {})
                        if index in text_block_indexes and delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            full_text_parts.append(text)
                            yield {"type": "delta", "text": text}
                        elif index in tool_blocks and delta.get("type") == "input_json_delta":
                            tool_blocks[index]["json"] += delta.get("partial_json", "")

                    elif etype == "content_block_stop":
                        # 工具呼叫收下來,每則回答才能列出實際讀過的檔案 —— 答案下面沒有來源,
                        # 就代表它沒查程式碼,是憑既有知識回的。
                        block_info = tool_blocks.pop(index, None)
                        if block_info:
                            source = _describe_tool_use(block_info["name"], block_info["json"])
                            if source:
                                # 流水帳先走,而且**不管重複**:同一個檔被讀第三次的時候,
                                # 下面那個 set 會把它擋掉(畫面上不該出現三次),
                                # 但那正是查成本時要看到的那一列。
                                yield {
                                    "type": "step",
                                    "kind": "tool",
                                    "seq": step_seq,
                                    "turn": turn_index,
                                    "at_ms": int((time.time() - start) * 1000),
                                    "tool_use_id": block_info["id"],
                                    **source,
                                }
                                step_seq += 1
                                if block_info["id"]:
                                    tool_started_at[block_info["id"]] = time.time()

                                # 完整路徑只留給流水帳(管理員才看得到那一頁)。
                                # 聊天頁的「參考來源」每個使用者都看得到,沒有理由
                                # 把主機上的絕對路徑一路送到瀏覽器。
                                source.pop("target_full", None)
                                # 工具真正的耗時晚到(step_duration),前端靠這個 id 把它補回同一列
                                # —— 拿相鄰兩步的 at_ms 相減量到的是「到下一步之前」,
                                # 混著模型思考與寫答案的時間。
                                source["tool_use_id"] = block_info["id"]

                                key = (source["tool"], source["target"])
                                if key not in seen_sources:
                                    seen_sources.add(key)
                                    # ⚠️ 每一步都要帶「從這一題開始算過了幾毫秒」。
                                    # 少了它,**答完之後**那條時間軸就沒有耗時可以顯示
                                    # ——串流當下的耗時是前端拿自己的時鐘算的,
                                    # 重新整理就沒了。
                                    # 用相對毫秒不是絕對時間:耗時是相減出來的,
                                    # 相對值不會被前後端的時鐘差影響。
                                    source["at_ms"] = int((time.time() - start) * 1000)
                                    yield {"type": "source", **source}

                elif data.get("type") == "user":
                    # **工具真正花多久,只有這裡量得到。**
                    #
                    # ⚠️ `content_block_stop` 是「模型把這通呼叫**寫完**了」,
                    # 不是「工具跑完了」—— 工具是在整則 assistant 訊息結束之後才執行的。
                    # 所以拿 at_ms 相減當耗時是錯的(那量到的是模型吐字的速度),
                    # 真正的耗時是 tool_use 寫完到 tool_result 回來之間這一段。
                    #
                    # 對不到 id 的 tool_result 直接略過(例如服務重啟前殘留的),
                    # 對不到就沒有耗時可寫,留 NULL 比猜一個數字好。
                    for block in data.get("message", {}).get("content", []) or []:
                        if block.get("type") != "tool_result":
                            continue
                        tool_use_id = block.get("tool_use_id")
                        started = tool_started_at.pop(tool_use_id, None)
                        if tool_use_id is None or started is None:
                            continue
                        yield {
                            "type": "step_duration",
                            "tool_use_id": tool_use_id,
                            "duration_ms": int((time.time() - started) * 1000),
                        }

                elif data.get("type") == "assistant":
                    message = data.get("message", {}) or {}
                    for block in message.get("content", []) or []:
                        if block.get("type") == "text" and block.get("text"):
                            assistant_text_parts.append(block["text"])

                    # 一則 assistant 訊息 = 一次模型呼叫,帳算在這裡。
                    # **token 只有這條路拿得到** —— stream_event 那邊的
                    # message_start 只有半套(輸出還沒發生),最後的 result
                    # 只有一題的總額,拆不出每一輪。
                    # ⚠️ **同一次模型呼叫會發好幾則 assistant 事件** —— CLI 是
                    # 一個 content block 一則(文字一則、tool_use 一則…),而每一則
                    # 都帶著同一份 `usage`。照單全收的話一次呼叫會被記成 2~3 輪,
                    # 「累計 token」與「第幾輪」跟著虛高。用 message.id 去重 ——
                    # 同一次 API 回應共用一個 id,不同呼叫必定不同。
                    message_id = message.get("id")
                    if message_id is not None and message_id == last_usage_message_id:
                        continue
                    step = _describe_usage(message, data.get("parent_tool_use_id"))
                    if step:
                        last_usage_message_id = message_id
                        yield {
                            "type": "step",
                            "seq": step_seq,
                            "turn": turn_index,
                            "at_ms": int((time.time() - start) * 1000),
                            **step,
                        }
                        step_seq += 1
                        # 子代理那幾則不算主線的一輪,不然「跑了幾輪」會被灌水
                        if step["kind"] == "turn":
                            turn_index += 1

                elif data.get("type") == "result":
                    final_result = data
        except (GeneratorExit, asyncio.CancelledError):
            # 使用者按了停止(routers/ask.py 會 cancel 這個背景 task),或服務要收攤。
            # 子行程沒有理由繼續跑,直接砍掉,不然會白白空跑到逾時。
            #
            # 兩種例外都要接:被 aclose() 關掉時進來的是 GeneratorExit,
            # 但如果取消發生在「正在 await 讀取下一行」的當下,進來的是 CancelledError
            # —— 只接 GeneratorExit 的話那條路會直接穿過去,子行程就沒人砍了。
            proc.kill()
            stderr_task.cancel()
            stdin_task.cancel()
            raise

        if timed_out:
            proc.kill()
            await proc.wait()
            stderr_task.cancel()
            stdin_task.cancel()

            # 逾時之前已經寫出來的內容要留著(見 partial_answer)
            partial = answer_text()
            if partial:
                yield {
                    "type": "done",
                    "success": True,
                    "answer": partial_answer(
                        partial,
                        f"這個回答在 {config.CLAUDE_TIMEOUT_SEC} 秒時被中斷,內容並不完整。",
                        "上面是中斷前已經查到的部分。想拿到完整答案的話,建議把問題拆小 —— "
                        "例如一次只問一個流程,或先問「有哪些流程」再逐一深入。",
                    ),
                    "error": None,
                    "duration_ms": int((time.time() - start) * 1000),
                    "cost_usd": None,
                    "conversation_id": conv_id,
                }
                return

            yield {
                "type": "error",
                "message": (
                    f"逾時(超過 {config.CLAUDE_TIMEOUT_SEC} 秒)且沒有產生任何內容。\n"
                    f"這題可能要翻的程式太多,建議拆成幾個小問題分開問,"
                    f"例如一次只問一個流程、或先問「有哪些相關程式」再逐一深入。"
                ),
                "conversation_id": conv_id,
            }
            return

        await proc.wait()
        await stderr_task
        stdin_task.cancel()  # 正常早就寫完了;CLI 沒讀完就結束的話不留一個掛著
        duration_ms = int((time.time() - start) * 1000)

        if final_result is None:
            stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()
            yield {
                "type": "error",
                "message": stderr_text or f"claude 執行失敗(exit code {proc.returncode})",
                "conversation_id": conv_id,
            }
            return

        # 一個字都沒串流到,但有完整的 assistant 訊息 —— slash 指令就是這種。
        # 補送成一個 delta,前端才看得到內容(前端的答案是靠 delta 累積的,
        # 不是從 done 事件讀的)。只有在 full_text_parts 是空的時候才做,不會重複。
        if not full_text_parts and assistant_text_parts:
            fallback_text = "".join(assistant_text_parts)
            full_text_parts.append(fallback_text)
            yield {"type": "delta", "text": fallback_text}

        is_error = bool(final_result.get("is_error"))

        answer = answer_text() if not is_error else ""

        yield {
            "type": "done",
            "success": not is_error,
            "answer": answer,
            "error": final_result.get("result") if is_error else None,
            "duration_ms": duration_ms,
            "cost_usd": final_result.get("total_cost_usd"),
            "conversation_id": conv_id,
        }

    finally:
        # ⚠️ 不管怎麼結束都要還號碼牌,不然那個名額永遠不會空出來,隊伍最後整條卡死。
        # 排隊中被取消也走這裡;輪到與計數是同一步(`_Lane._admit`),沒有
        # 「名額剛好在取消那一瞬間發下來、卻沒人還」的空窗。
        lane.leave(ticket)


# claude 用 Write 建立的「請幫我複製這些檔案」清單檔名
COPY_MANIFEST_NAME = "__copy__.txt"


def apply_copy_manifest(session_id: str, knowledge_base: Optional[dict] = None) -> List[str]:
    """把清單裡的檔案原封不動複製進下載資料夾,回傳要顯示給使用者的訊息。

    **為什麼要有這一層**:使用者常常要的是「把這支原始碼給我」,而那是主機上已經存在的
    檔案。叫模型用 Write 把內容重打一遍是行不通的 —— 大型原始檔動輒好幾萬行、好幾 MB,
    吐不完,就算吐得完也不保證一字不差。而開放 `cp` 給它又太寬(能複製任何東西到任何
    地方)。所以讓它只寫一份「路徑清單」,真正的複製由這裡做,順便驗證來源合法。

    只允許複製這一題選到的那個專案的程式碼樹與文件目錄底下的檔案 —— 跟提示裡「不要讀別的路徑」
    是同一條界線,而且擋掉 /etc/passwd 這種東西被塞進清單。
    """
    session_dir = config.OUTPUT_DIR / session_id
    manifest = session_dir / COPY_MANIFEST_NAME
    if not manifest.is_file():
        return []

    base = knowledge_base or config.get_knowledge_base(None)
    roots = []
    for raw in (base["code_roots"] + base["knowledge_dirs"]) if base else []:
        try:
            roots.append(Path(raw).resolve())
        except OSError:
            continue

    try:
        lines = manifest.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    # 先刪清單,免得複製途中出錯時它留在下載清單裡讓使用者看到一個莫名其妙的檔案
    manifest.unlink(missing_ok=True)

    notices: List[str] = []
    for line in lines:
        # 模型有時會加上 markdown 的清單符號或反引號,寬容一點
        wanted = line.strip().strip("`").lstrip("-*").strip()
        if not wanted:
            continue
        try:
            source = Path(wanted).resolve()
        except (OSError, ValueError):
            # ValueError:模型寫的路徑裡有 NUL 之類的字元
            notices.append(f"「{wanted}」不是有效的路徑,沒有複製")
            continue

        if not any(source == r or r in source.parents for r in roots):
            notices.append(f"「{wanted}」不在這個專案的程式碼樹底下,基於安全考量沒有複製")
            continue
        if not source.is_file():
            notices.append(f"「{wanted}」不存在或不是檔案,沒有複製")
            continue

        # 同名就加序號,不要互相覆蓋
        target = session_dir / source.name
        counter = 2
        while target.exists():
            target = session_dir / f"{source.stem}({counter}){source.suffix}"
            counter += 1
        try:
            shutil.copy2(source, target)
        except OSError as exc:
            notices.append(f"「{source.name}」複製失敗:{exc.strerror or type(exc).__name__}")

    return notices


def flatten_output_dir(
    session_id: str, knowledge_base: Optional[dict] = None
) -> List[str]:
    """把產出資料夾底下的子目錄攤平成一層,回傳要顯示給使用者的訊息。

    **為什麼要有這一層**:`list_output_files` 只掃第一層,而下載網址也是
    `/api/files/{題號}/{檔名}` —— 沒有放路徑的位置。所以 claude 只要寫成
    `outputs/{題號}/報表/a.csv`,那個檔案就**完全不會出現在下載清單裡**:
    它寫成功了、答案裡也講了「已經產生報表/a.csv」,但使用者什麼都看不到,
    而且畫面上不會有任何錯誤。提示裡雖然叫它不要建子目錄,但那是規則不是機制。

    位置:**排在 copy manifest 之後**(複製進來的檔案也要攤平)、**其餘後處理之前**
    —— sheetgen / pdfgen / slidegen / zipgen 也都只掃第一層。

    `knowledge_base` 用不到,收它只是為了跟收尾那串後處理同一個簽名(見
    `routers/ask.py` 的 `_finalize`)。
    """
    session_dir = config.OUTPUT_DIR / session_id
    if not session_dir.is_dir():
        return []

    notices: List[str] = []
    for source in sorted(session_dir.rglob("*")):
        if not source.is_file() or source.parent == session_dir:
            continue
        target = outputs_common.unique_path(session_dir, source.name)
        try:
            source.rename(target)
        except OSError as exc:
            notices.append(
                f"「{source.name}」放在子資料夾裡、又搬不出來,下載清單上不會有它"
                f"({exc.strerror or type(exc).__name__})"
            )

    # 由深而淺收掉空目錄。rmdir 只在真的空的時候會成功,所以搬不動的那些會留著。
    for directory in sorted(session_dir.rglob("*"), reverse=True):
        if directory.is_dir():
            try:
                directory.rmdir()
            except OSError:
                pass

    return notices


def list_output_files(session_id: str) -> List[str]:
    out_dir = config.OUTPUT_DIR / session_id
    if not out_dir.exists():
        return []
    return sorted(p.name for p in out_dir.iterdir() if p.is_file())
