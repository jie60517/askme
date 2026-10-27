"""進行中問答的登記表。

**為什麼需要這一層**:claude 跑一題動輒十幾分鐘,而使用者一定會在中間關掉分頁、
重新整理、或走到另一台電腦繼續看。如果整段 claude 呼叫掛在 HTTP 串流的
async generator 裡,瀏覽器一斷線 generator 就被取消 → 子行程被砍 → 那一題
歷史查不到、側邊欄沒有、錢也白花了。

所以:送出的當下就在資料庫寫一筆 `status="running"` 的紀錄,claude 跑在背景 task,
HTTP 串流只是「觀看」這個 task 的事件流。任何人、任何時候都可以重新接上
(先把已經發生的事件重播一遍,再繼續跟),斷線完全不影響它跑完。

事件只留在記憶體 —— 服務重啟時進行中的那幾題會斷掉,由 main.py 啟動時
把殘留的 running 紀錄收尾成失敗。
"""

import asyncio
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Dict, List, Optional

# 跑完之後還留在記憶體裡多久。留著是為了讓「剛好在結束前一秒重新整理」的人
# 還接得到 done 事件;超過就從資料庫讀歷史紀錄,不用一直佔記憶體。
RETENTION_SEC = 10 * 60


class Run:
    """一次問答的執行狀態。事件是唯一的真相來源,訂閱者各自記自己看到哪裡。"""

    def __init__(
        self,
        run_id: str,
        conversation_id: str,
        record_id: int,
        question: str,
        knowledge_base_id: Optional[str] = None,
        owner: Optional[str] = None,
    ):
        self.run_id = run_id
        self.conversation_id = conversation_id
        self.record_id = record_id
        self.question = question
        self.knowledge_base_id = knowledge_base_id
        # 這組對話掛在誰名下(同 QARecord.owner)。
        # 進行中的問答同樣要照身分過濾:少了這個,「還在跑」的清單會把別人
        # 正在問的問題原文送到每個人的瀏覽器上 —— 那是最尷尬的一種洩漏,
        # 因為它是即時的。
        self.owner = owner
        self.started_at = time.time()

        # claude 那邊的 session id,以及這次是不是新開的。只有真的跑完才會寫進
        # ConversationMeta(見 models.ConversationMeta 的說明)。
        self.claude_session_id: Optional[str] = None
        self.claude_session_is_new = False
        # 這個 session 跑在哪個工作目錄。跟 session id 一起記進 ConversationMeta,
        # 續問才回得去同一個目錄(見 models.ConversationMeta.workdir)。
        self.claude_workdir: Optional[str] = None

        self.events: List[dict] = []
        self.answer_parts: List[str] = []
        self.sources: List[dict] = []
        # 每一步的流水帳(models.QAStep)。**跟 sources 不一樣,不去重、也不進 events**
        # —— 它只在收尾時寫進資料庫,不送到瀏覽器:一題幾百步,送過去只是白佔頻寬
        # 跟重播長度,而畫面上要顯示的是去重過的那份(sources)。
        self.steps: List[dict] = []

        self.done = False
        self.finished_at: Optional[float] = None
        # 使用者按了停止(而不是系統要收掉這個 task)。兩者都是 CancelledError,
        # 靠這個旗標分辨:前者要把已經寫出來的內容保留下來,後者不用。
        self.stop_requested = False

        self.task: Optional[asyncio.Task] = None
        self._waiters: List[asyncio.Event] = []
        # 收尾(ask._finalize)在工作執行緒裡跑,從那裡 emit 時要靠它把叫醒丟回迴圈
        # (見 _wake)。**建構時就記下**,不要等第一個訂閱者:那樣的話執行緒可能剛好在
        # 訂閱者「檢查完、還沒記下迴圈」的空檔 emit,讀到 None,那一聲叫醒就丟了。
        try:
            self._loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:  # 測試裡在迴圈外建的 Run
            self._loop = None

    # ------------------------------------------------------------------ 產生事件

    def emit(self, event: dict) -> None:
        self.events.append(event)
        self._wake()

    def finish(self) -> None:
        self.done = True
        self.finished_at = time.time()
        self._wake()

    def _wake(self) -> None:
        # ⚠️ asyncio.Event.set() 不是執行緒安全的:從工作執行緒直接呼叫,
        # 等待中的訂閱者不一定會醒(迴圈不知道有事發生),畫面就停在「回答中」。
        # 不在迴圈裡就排回迴圈去叫醒。這同時保住了 follow() 的「檢查到掛等待
        # 之間沒有 await」那條不變式:叫醒一定在迴圈上、在那段同步程式之後才跑。
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            if self._loop is not None and not self._loop.is_closed():
                self._loop.call_soon_threadsafe(self._wake_on_loop)
            return
        self._wake_on_loop()

    def _wake_on_loop(self) -> None:
        for waiter in self._waiters:
            waiter.set()
        self._waiters.clear()

    # ------------------------------------------------------------------ 觀看

    async def follow(self) -> AsyncIterator[dict]:
        """從頭重播已經發生的事件,然後繼續跟到結束。

        可以同時有很多個訂閱者(同一個人開兩個分頁、或換裝置接上),
        彼此不互相干擾 —— 每個訂閱者只記自己的 idx。
        """
        idx = 0
        while True:
            while idx < len(self.events):
                yield self.events[idx]
                idx += 1
            if self.done:
                return

            # 從上面那個「還有沒有新事件」的檢查到這裡掛上等待之間沒有任何 await,
            # 單一事件迴圈不會插進別的工作,所以不會漏掉剛好在這瞬間產生的事件。
            waiter = asyncio.Event()
            # 正式路徑上 __init__ 就已經記下了(Run 都在迴圈裡建);這裡只補「在迴圈外建的 Run」(測試)
            self._loop = self._loop or asyncio.get_running_loop()
            self._waiters.append(waiter)
            await waiter.wait()

    # ------------------------------------------------------------------ 停止

    def request_stop(self) -> bool:
        """使用者按了停止。回傳 False 代表這題早就跑完了,沒東西可停。"""
        if self.done or self.task is None or self.task.done():
            return False
        self.stop_requested = True
        self.task.cancel()
        return True


_runs: Dict[str, Run] = {}


def register(run: Run) -> None:
    _evict_expired()
    _runs[run.run_id] = run


def get(run_id: str) -> Optional[Run]:
    return _runs.get(run_id)


def active() -> List[Run]:
    """還在跑的問答,新的排前面。前端用它把「問了但還沒回完」的對話接回來。"""
    return sorted((r for r in _runs.values() if not r.done), key=lambda r: r.started_at, reverse=True)


def active_for_conversation(conversation_id: str) -> Optional[Run]:
    for run in _runs.values():
        if not run.done and run.conversation_id == conversation_id:
            return run
    return None


#: 每組對話一把鎖(用完就丟,見 `conversation_gate`)。
_conversation_locks: Dict[str, asyncio.Lock] = {}
#: 那把鎖現在有幾個人在用(含正在等的)。歸零才刪得掉,不然刪掉的瞬間
#: 還在等的人會拿到一把新的鎖,等於沒鎖。
_conversation_lock_users: Dict[str, int] = {}


@asynccontextmanager
async def conversation_gate(conversation_id: str) -> AsyncIterator[None]:
    """把「這組對話有沒有人在跑」的檢查與 `register()` 圈成不可中斷的一段。

    ⚠️ **這兩件事之間不能有 await。** `POST /api/ask` 從 409 守衛到 register
    中間要存附件、查資料庫、寫紀錄,每一個 await 都是一個讓出點 —— 同一組對話
    的兩個帶附件的請求會**雙雙通過守衛**,然後對同一個 claude session 各起一次
    `--resume`。那是同一份 session 檔被兩個行程同時寫,而症狀不是報錯,是那組
    對話的上下文從此錯亂。

    守衛與登記之間隔著的東西太多(附件要先落地才知道檔名、紀錄要先進資料庫才有
    id),搬不動;所以用鎖把整段圈起來 —— 後到的那個請求會等,等到前一個
    登記完成,再照常被 409 擋下來。

    鎖是**每組對話一把、用完就丟**:全域一把的話,一個人傳大檔會讓所有人送不出
    問題;不丟的話這份 dict 會跟著對話數一直長。
    """
    lock = _conversation_locks.get(conversation_id)
    if lock is None:
        lock = _conversation_locks[conversation_id] = asyncio.Lock()
    # 計數要在 await 之前加 —— 加在鎖裡面的話,還在等的人不算數,
    # 拿到鎖的那個離開時就會把這把鎖刪掉。
    _conversation_lock_users[conversation_id] = _conversation_lock_users.get(conversation_id, 0) + 1
    try:
        async with lock:
            yield
    finally:
        remaining = _conversation_lock_users[conversation_id] - 1
        if remaining > 0:
            _conversation_lock_users[conversation_id] = remaining
        else:
            del _conversation_lock_users[conversation_id]
            del _conversation_locks[conversation_id]


def _evict_expired() -> None:
    now = time.time()
    for run_id, run in list(_runs.items()):
        if run.done and now - run.finished_at > RETENTION_SEC:
            del _runs[run_id]
