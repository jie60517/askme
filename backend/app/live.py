"""對話頁的即時推送(@ 便條已讀)。

一句話講完:**有人看過便條、或有人寫了新便條,正開著那組對話的每一頁在一秒內重抓便條。**

為什麼推的只是「變了」而不帶資料:收到的人本來就要用 `GET /notes` 重抓 —— 那支路由
已經做了權限檢查、顯示名稱、已讀時間。推送線另外組一份資料的話,兩邊遲早長得不一樣。
「變了」也讓合併很自然:一口氣有三個人標已讀,還沒送出去的那一則就代表全部。

⚠️ **只在單一行程裡有效。** 訂閱清單放在這個模組的記憶體裡,而正式站與測試站都是
一個 uvicorn 行程(`deploy/t100_web.service` 沒有 `--workers`)。哪天開了多個 worker,
在 A 行程標的已讀推不到連在 B 行程的人 —— 那時要改走 Redis 之類的轉送。

⚠️ **`publish` 可以從任何執行緒呼叫。** 標已讀那支路由是同步的 `def`(FastAPI 丟進
執行緒池跑),而 asyncio.Queue 不是執行緒安全的;所以一律經 `call_soon_threadsafe`
回到訂閱者所在的 event loop 再放進佇列。
"""

import asyncio
from typing import Dict, Optional, Set

#: 送給前端的唯一一種事件:這組對話的便條(含已讀)變了,重抓。
NOTES_CHANGED = "notes"

_subs: Dict[str, Set[asyncio.Queue]] = {}
#: 訂閱者所在的 event loop。最後一次 subscribe 時記下;只有一個行程、一個 loop。
_loop: Optional[asyncio.AbstractEventLoop] = None


def subscribe(conversation_id: str) -> asyncio.Queue:
    """開始收這組對話的事件。**一定要在 event loop 裡呼叫**(WebSocket 路由裡)。

    佇列大小 1:還沒送出去的那一則就代表「變了」,再來幾則都一樣,不必排隊。
    """
    global _loop
    _loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=1)
    _subs.setdefault(conversation_id, set()).add(q)
    return q


def unsubscribe(conversation_id: str, q: asyncio.Queue) -> None:
    subs = _subs.get(conversation_id)
    if subs is None:
        return
    subs.discard(q)
    if not subs:
        _subs.pop(conversation_id, None)


def _deliver(conversation_id: str) -> None:
    for q in list(_subs.get(conversation_id, ())):
        if q.empty():
            q.put_nowait(NOTES_CHANGED)


def publish(conversation_id: str) -> None:
    """通知正開著這組對話的人:便條變了。沒人開著就什麼都不做。

    呼叫點要排在 **commit 之後** —— 收到的人會立刻重抓,還沒 commit 的話抓到的是舊的,
    而下一次推送要等下一個人動作,那個頭像就一直不出來。
    """
    loop = _loop
    if loop is None or loop.is_closed() or conversation_id not in _subs:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        _deliver(conversation_id)
        return
    try:
        loop.call_soon_threadsafe(_deliver, conversation_id)
    except RuntimeError:
        # loop 剛好在關(服務重啟中):連線本來就要斷了,前端重連時會自己重抓
        pass
