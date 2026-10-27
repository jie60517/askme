# -*- coding: utf-8 -*-
"""Work Flow 的執行引擎與排程器。

一次執行 = 從起點沿著線一塊一塊走:每一塊跑完決定走哪個出口,
出口有接線就走下去,沒接就結束。每塊拼圖實際做的事是**經 SSH 在主機(或客戶主機)
上跑一段指令**,指令來自 `workflow_actions.json`,參數由 `workflows.safe_*` 把關。

幾件跟「跑到一半出事」有關的規矩:

- **收尾安全網**:這次執行撥起來的 VPN,結束時(成功、失敗、按停止、服務關機)
  若還沒被「中斷連線」關掉,這裡自己跑那個客戶的 `vpn_down`。
- **停止**:取消那個 asyncio task → 正在跑的那條 SSH 通道被關掉、那一步記成失敗,
  然後照樣收尾。遠端的行程會不會跟著死取決於指令本身,所以範本裡的指令都包了 `timeout`。
- **每一步結束就寫一次資料庫**:服務中途重啟,紀錄停在最後完成的那一步,
  開機時 `close_orphan_workflow_runs()` 把它標成失敗 —— 不會永遠卡在「執行中」。

`Runner`(怎麼連、怎麼跑指令)與 `notifier`(怎麼通知人員)抽出來,測試換成假的,
不需要 sshd 也不需要網路。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shlex
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Awaitable, Callable, Optional, Protocol

from . import audit, config, models, workflows
from .database import session_scope

logger = logging.getLogger(__name__)

#: 每一步保留的輸出行數。
MAX_LINES = 200
#: 一次執行最多幾則事件(下方那個逐行紀錄)。流程最多 120 塊,每塊兩三則,這個上限只防意外。
MAX_EVENTS = 600
#: 重試之間等幾秒。
RETRY_DELAY_SEC = 5.0
#: 停止或關機之後,收尾(斷 VPN)最多等多久。
CLEANUP_TIMEOUT_SEC = 60.0


class Busy(Exception):
    """這條流程已經在跑了(同一條流程同時只跑一次)。"""


class StepFailed(Exception):
    """一步沒成功。訊息是給人看的中文,寫進紀錄。"""


# ------------------------------------------------------------------ 怎麼連、怎麼跑
class Runner(Protocol):
    async def connect(self, host_id: str) -> str:
        """連上那一台,回給人看的名字。連不上 raise StepFailed。"""
        ...

    async def run(self, host_id: str, command: str, on_output: Callable[[str], None]) -> int:
        """在那一台跑一段指令(必要時先連上),輸出逐段丟給 on_output,回結束代碼。"""
        ...

    async def close(self) -> None: ...


class SSHRunner:
    """真的那一個:沿用 SSH 終端機的連線(`terminal._connect_host`),同一台只連一次。"""

    def __init__(self) -> None:
        self.conns: dict = {}

    async def _conn(self, host_id: str):
        from . import terminal

        if host_id in self.conns:
            return self.conns[host_id]
        host = config.find_terminal_host(host_id)
        if host is None:
            raise StepFailed(f"設定裡找不到主機「{host_id}」,請管理員檢查 terminal_hosts.json")
        tunnel = await self._conn(host["via"]) if host["via"] else None
        try:
            conn = await terminal._connect_host(host, tunnel=tunnel)
        except terminal.TerminalError as exc:
            raise StepFailed(exc.message) from exc
        self.conns[host_id] = conn
        return conn

    async def connect(self, host_id: str) -> str:
        await self._conn(host_id)
        return config.terminal_host_label(config.find_terminal_host(host_id))

    async def run(self, host_id: str, command: str, on_output: Callable[[str], None]) -> int:
        import asyncssh

        conn = await self._conn(host_id)
        try:
            process = await conn.create_process(command, stderr=asyncssh.STDOUT, encoding="utf-8", errors="replace")
        except (OSError, asyncssh.Error) as exc:
            raise StepFailed(f"開不了執行通道:{exc}") from exc
        try:
            while True:
                chunk = await process.stdout.read(4096)
                if not chunk:
                    break
                on_output(chunk)
            await process.wait()
            return process.exit_status if process.exit_status is not None else 255
        finally:
            # 停止(task 被取消)時走到這裡:關掉通道。遠端行程靠指令自己的 timeout。
            if process.exit_status is None:
                try:
                    process.send_signal("TERM")
                except Exception:  # noqa: BLE001 —— 舊版 sshd 不收 signal 請求,關通道就好
                    pass
            process.close()

    async def close(self) -> None:
        # 反過來關:先關經跳板的那幾條,最後才關跳板本身
        for conn in reversed(list(self.conns.values())):
            conn.close()
        self.conns.clear()


#: 換成假的就能在沒有 sshd 的地方跑整條流程(測試、本機示範)。
runner_factory: Callable[[], Runner] = SSHRunner


#: 通知、對話標題裡流程名稱的寫法:「Work Flow「每日同步」」。對話標題只在還是這個開頭時才跟著流程改名(使用者自己改過的不動)
FLOW_TITLE_PREFIX = "Work Flow「"


def _flow_title(state: "RunState") -> str:
    return f"{FLOW_TITLE_PREFIX}{state.workflow_name}」"


def _post_note(state: "RunState", usernames: list, text: str, reason: str = "") -> None:
    """站內通知:跟聊天被 @ 一樣 —— 小夥伴冒泡、對話列上有未讀。

    每個流程一組對話(`workflow-<id>`),掛在 `WORKFLOW_OWNER` 名下(不是真人、登不進來)。每跑到一次這塊:
    先寫一則「這次的結果」當那組對話的一題,再留一則 @ 名單的便條 —— `notes.create_note` 會把被 @ 的人
    拉進共用、排通知,那組對話就出現在他側邊欄的「共用」。

    **畫面上只看得到便條**。那一題對話頁不畫(`is_workflow_result`),留著是因為①對話清單是從問答紀錄
    組出來的,沒有它這組對話不存在;②在這組對話裡追問時,它是給 AI 的前情提要(`ask._workflow_context`)。
    所以成敗的原因寫進便條本身(`reason`);便條有字數上限,全文(含每一步最後十行輸出)仍在那一題裡。
    """
    from . import notes

    conv_id = f"workflow-{state.workflow_id}"
    ok = not state.failed
    title = f"{_flow_title(state)}{'成功' if ok else '失敗'}"
    with session_scope() as db:
        db.add(
            models.QARecord(
                session_id=uuid.uuid4().hex,
                conversation_id=conv_id,
                question=title,
                answer=text,
                owner=config.WORKFLOW_OWNER,
                asked_by=config.WORKFLOW_OWNER,
                status="done",
                # ⚠️ 一律 True:這個欄位是「這一題有沒有答出來」,不是流程的成敗。設成 False 的話
                # 對話頁把它畫成失敗的提問 + 重試鈕,按下去會把標題當問題送給 AI
                success=True,
            )
        )
        # 側邊欄的標題:對話清單沒改過名就拿第一題的問題當標題 —— 那會永遠停在第一次的「…成功」,
        # 之後失敗了也不變,而那一題在對話頁又看不到。固定成流程名稱,跟著流程改名
        meta = db.get(models.ConversationMeta, conv_id)
        flow_title = _flow_title(state)
        if meta is None:
            db.add(models.ConversationMeta(conversation_id=conv_id, custom_title=flow_title))
        elif not meta.custom_title or meta.custom_title.startswith(FLOW_TITLE_PREFIX):
            meta.custom_title = flow_title
        db.commit()
        mentions = " ".join(f"@{u}" for u in usernames)
        # 原因另起一行(失敗時每一步各一行):擠在標題後面一整串看不出哪裡壞
        body = f"{mentions} {title}" + (f"\n{reason}" if reason else "")
        notes.create_note(db, conv_id, config.WORKFLOW_OWNER, body[: notes.MAX_NOTE_CHARS])


def _reason(state: "RunState") -> str:
    """便條上那一句原因:成功 = 走過哪幾步;失敗 = 哪一步、為什麼(那一步的訊息已經帶著最後一行輸出)。"""
    fails = [s for s in state.steps.values() if s.status == "fail"]
    if fails:
        lines: list[str] = []
        for s in fails:
            # 訊息尾巴接著的是那一步最後一行輸出(`_tail`)—— 拆成自己一行
            tail = _tail(s)
            head = s.message[: -len(tail)] if tail and s.message.endswith(tail) else s.message
            lines.append(f"{s.label}:{head}")
            if tail:
                lines.append(s.lines[-1])
        return "\n".join(lines)
    return "、".join(s.label for s in state.steps.values() if s.type != "start" and s.status == "ok")


async def _notify_in_app(state: "RunState", usernames: list, text: str) -> None:
    await asyncio.to_thread(_post_note, state, usernames, text, reason=_reason(state))


#: 換成假的就能在測試裡看送了什麼、送給誰。
notifier: Callable[["RunState", list, str], Awaitable[None]] = _notify_in_app


# ------------------------------------------------------------------ 一次執行的狀態
def _clock() -> str:
    return workflows.local_now().strftime("%H:%M:%S")


@dataclass
class Step:
    node: str
    type: str
    label: str
    status: str = "running"
    started: str = ""
    finished: str = ""
    progress: Optional[float] = None
    message: str = ""
    #: 執行中那一行副標(同步的「x / N 個檔案」)。畫面上直接顯示,空的就不顯示。
    detail: str = ""
    lines: list = field(default_factory=list)

    def public(self, with_lines: bool) -> dict:
        d = {
            "node": self.node, "type": self.type, "label": self.label, "status": self.status,
            "started": self.started, "finished": self.finished, "progress": self.progress,
            "message": self.message, "detail": self.detail, "line_count": len(self.lines),
        }
        if with_lines:
            d["lines"] = list(self.lines)
        return d


@dataclass
class RunState:
    id: int
    workflow_id: int
    workflow_name: str
    graph: dict
    trigger: str
    triggered_by: str
    started_at: datetime
    status: str = "running"
    stopped_at: str = ""
    steps: dict = field(default_factory=dict)
    events: list = field(default_factory=list)
    #: 走過的線:{from, out, to, state}。state = live(亮點正在跑)/ done / fail。
    path: list = field(default_factory=list)
    task: Optional[asyncio.Task] = None
    finished_at: Optional[datetime] = None
    #: 這次撥起來、還沒斷的 VPN(客戶名)。收尾安全網照它斷。
    vpn_up: list = field(default_factory=list)
    failed: bool = False
    stop_requested: bool = False
    #: 誰 / 什麼讓它停的(「服務重新啟動」)。空的 = 有人按了停止。
    stop_reason: str = ""

    def event(self, node: str, msg: str, level: str = "") -> None:
        if len(self.events) >= MAX_EVENTS:
            return
        # 不屬於任何一塊的(停止、收尾)記在「流程」底下,紀錄那一欄才不會空一格
        label = workflows.LABELS.get(self.graph_types.get(node, ""), "") if node else "流程"
        self.events.append({"t": _clock(), "node": node, "label": label, "msg": msg, "level": level})

    @property
    def graph_types(self) -> dict:
        return {n["id"]: n["type"] for n in self.graph["nodes"]}

    def public(self, since: int = 0, with_lines: bool = False) -> dict:
        return {
            "id": self.id,
            "workflow_id": self.workflow_id,
            "status": self.status,
            "trigger": self.trigger,
            "triggered_by": self.triggered_by,
            "started_at": iso(self.started_at),
            "finished_at": iso(self.finished_at),
            "stopped_at": self.stopped_at,
            "steps": [s.public(with_lines) for s in self.steps.values()],
            "path": list(self.path),
            # 跑的是哪一版的圖:事後改了流程,紀錄頁重播的仍是當時那一版
            "graph": self.graph,
            "events": self.events[since:],
            "events_total": len(self.events),
        }


def iso(dt: Optional[datetime]) -> Optional[str]:
    """UTC 的 naive datetime → 前端吃的 ISO 字串(結尾補 Z)。路由層也用這一支。"""
    return dt.isoformat() + "Z" if dt else None


#: 還在跑的,依 workflow_id。**「同一條流程同時只跑一次」的鎖就是這張表**:前提是只有一個
#: uvicorn worker(deploy/docker/entrypoint.py 的啟動指令沒有 --workers)。
_LIVE: dict[int, RunState] = {}
#: 依 run id,跑完之後留一小段時間,讓輪詢的前端拿得到最後那一眼。
_BY_RUN: dict[int, RunState] = {}
#: 排程撞到還在跑、設定是「排在後面」的那幾條。
_QUEUED: set[int] = set()


def archive_runner(username: str, archived: str) -> None:
    """刪帳號時:還在跑、或剛跑完的執行,執行者改成封存名(資料庫那份由 users.delete_user 改)。
    不改的話,同名帳號重建後在執行畫面上就成了「觸發的人」。"""
    for state in {id(s): s for s in [*_LIVE.values(), *_BY_RUN.values()]}.values():
        if state.triggered_by == username:
            state.triggered_by = archived


def live_for(workflow_id: int) -> Optional[RunState]:
    return _LIVE.get(workflow_id)


def get_state(run_id: int) -> Optional[RunState]:
    return _BY_RUN.get(run_id)


# ------------------------------------------------------------------ 資料庫
def _save(state: RunState) -> None:
    try:
        with session_scope() as db:
            row = db.get(models.WorkflowRun, state.id)
            if row is None:
                return
            row.status = state.status
            row.stopped_at = state.stopped_at
            row.finished_at = state.finished_at
            row.steps = json.dumps([s.public(True) for s in state.steps.values()], ensure_ascii=False)
            row.events = json.dumps(state.events, ensure_ascii=False)
            db.commit()
    except Exception:  # noqa: BLE001 —— 紀錄寫不進去不該讓流程本身停下來
        logger.warning("Work Flow 執行紀錄寫入失敗:run=%s", state.id, exc_info=True)


def row_public(row: models.WorkflowRun, with_lines: bool = False) -> dict:
    """資料庫裡那一筆 → 跟 `RunState.public()` 同一個形狀(執行紀錄頁點開舊的那一次用)。"""
    steps = json.loads(row.steps or "[]")
    if not with_lines:
        for s in steps:
            s.pop("lines", None)
    events = json.loads(row.events or "[]")
    return {
        "id": row.id,
        "workflow_id": row.workflow_id,
        "status": row.status,
        "trigger": row.trigger,
        "triggered_by": row.triggered_by,
        "started_at": iso(row.started_at),
        "finished_at": iso(row.finished_at),
        "stopped_at": row.stopped_at or "",
        "steps": steps,
        "path": _path_from_steps(json.loads(row.graph or "{}"), steps, row.status),
        "graph": json.loads(row.graph or "{}"),
        "events": events,
        "events_total": len(events),
    }


def _path_from_steps(graph: dict, steps: list, status: str) -> list:
    """資料庫裡沒有存走過的線 —— 從步驟的先後順序推回來(相鄰兩步之間的那條線)。"""
    order = [s["node"] for s in steps]
    edges = graph.get("edges") or []
    path = []
    for a, b in zip(order, order[1:]):
        for e in edges:
            if e["from"] == a and e["to"] == b:
                failed = any(s["node"] == a and s["status"] == "fail" for s in steps)
                path.append({**e, "state": "fail" if failed else "done"})
                break
    return path


def close_orphan_workflow_runs() -> int:
    """開機時:上次關機還在跑的,一律標成失敗。"""
    with session_scope() as db:
        rows = db.query(models.WorkflowRun).filter(models.WorkflowRun.status == "running").all()
        for row in rows:
            row.status = "fail"
            row.finished_at = datetime.utcnow()
            row.stopped_at = row.stopped_at or "服務重新啟動"
            events = json.loads(row.events or "[]")
            events.append({"t": "", "node": "", "label": "", "msg": "服務重新啟動,這次執行沒有跑完", "level": "fail"})
            row.events = json.dumps(events, ensure_ascii=False)
        db.commit()
        return len(rows)


# ------------------------------------------------------------------ 開始 / 停止
def start_run(workflow: models.Workflow, trigger: str, by: str) -> RunState:
    """開一次執行,回它的狀態(task 已經排進 event loop)。已經在跑就 raise Busy。

    **呼叫前要先過 `workflows.run_problems()`**(路由與排程器都有做)。
    """
    if workflow.id in _LIVE:
        raise Busy()
    graph = json.loads(workflow.graph or "{}")
    with session_scope() as db:
        row = models.WorkflowRun(
            workflow_id=workflow.id, trigger=trigger, triggered_by=by, status="running",
            graph=json.dumps(graph, ensure_ascii=False),
        )
        db.add(row)
        db.commit()
        run_id, started = row.id, row.started_at
    state = RunState(
        id=run_id, workflow_id=workflow.id, workflow_name=workflow.name, graph=graph,
        trigger=trigger, triggered_by=by, started_at=started,
    )
    _LIVE[workflow.id] = state
    _BY_RUN[run_id] = state
    state.task = asyncio.get_running_loop().create_task(_run(state))
    audit.record("workflow_run", actor=by, detail=f"{workflow.name}({'排程' if trigger == 'schedule' else '手動'})#{run_id}")
    return state


def request_stop(state: RunState, reason: str = "") -> None:
    """停掉一次執行。`reason` 給人看(例如「服務重新啟動」),空的就是有人按了停止。"""
    if state.status != "running" or state.task is None:
        return
    state.stop_requested = True
    state.stop_reason = reason
    state.task.cancel()


def record_skipped(workflow: models.Workflow, by: str, reason: str) -> None:
    """排程到點但沒跑(上一次還在跑、設定是跳過;或執行前檢查沒過):記一筆,讓紀錄頁看得到那一次沒跑。"""
    now = datetime.utcnow()
    with session_scope() as db:
        db.add(models.WorkflowRun(
            workflow_id=workflow.id, trigger="schedule", triggered_by=by, status="skipped",
            started_at=now, finished_at=now, stopped_at=reason, graph=workflow.graph,
        ))
        db.commit()


# ------------------------------------------------------------------ 主迴圈
async def _run(state: RunState) -> None:
    runner = runner_factory()
    nodes = {n["id"]: n for n in state.graph["nodes"]}
    cur: Optional[dict] = nodes.get("start")
    # ⚠️ 結果先記在區域變數,**收尾做完才寫回 state.status**:前端看到狀態不是 running
    # 就停止輪詢,太早改的話收尾那幾行(「已中斷 xxx」)永遠到不了畫面
    final = "ok"
    try:
        while cur is not None:
            out = await _step(state, runner, cur)
            edge = next((e for e in state.graph["edges"] if e["from"] == cur["id"] and e["out"] == out), None)
            if edge is None:
                # 走到沒接線的失敗出口 = 這次執行失敗,停在這一塊
                if out == 1 and workflows.OUTS[cur["type"]][1] == "失敗":
                    state.stopped_at = workflows.LABELS[cur["type"]]
                break
            state.path.append({**edge, "state": "fail" if state.steps[cur["id"]].status == "fail" else "done"})
            cur = nodes.get(edge["to"])
            if cur and cur["id"] in state.steps:
                # run_problems() 擋掉了迴圈,這裡是第二道
                state.event(cur["id"], "偵測到繞回頭的線,停止", "fail")
                state.failed = True
                break
        final = "fail" if state.failed else "ok"
    except asyncio.CancelledError:
        final = "stopped"
        # 停在哪一塊:那一塊自己已經記了一筆「已停止」,這裡不再重複
        cut = next((s for s in state.steps.values() if s.message == "已停止"), None)
        # 關機停掉的要寫出原因(不然紀錄頁看起來像有人按了停止);手動停的寫停在哪一塊
        state.stopped_at = state.stop_reason or (cut.label if cut else "")
        if state.stop_reason:
            state.event("", f"已停止({state.stop_reason})", "fail")
        elif cut is None:
            state.event("", "已停止", "fail")
    except Exception as exc:  # noqa: BLE001 —— 引擎自己的錯也要留下紀錄,不能讓那一筆永遠「執行中」
        logger.exception("Work Flow 執行發生未預期的錯誤:run=%s", state.id)
        final = "fail"
        state.event("", f"執行發生錯誤:{exc}", "fail")
    finally:
        await _cleanup(state, runner)
        state.finished_at = datetime.utcnow()
        state.status = final
        if state.status == "fail" and not state.stopped_at:
            failed = [s for s in state.steps.values() if s.status == "fail"]
            state.stopped_at = failed[0].label if failed else ""
        _save(state)
        _LIVE.pop(state.workflow_id, None)
        asyncio.get_running_loop().call_later(600, _BY_RUN.pop, state.id, None)
        if state.workflow_id in _QUEUED:
            _QUEUED.discard(state.workflow_id)
            asyncio.get_running_loop().call_soon(_start_queued, state.workflow_id)


def _vpn_command(name: str, key: str) -> str:
    """某個客戶的 vpn_up / vpn_down,`{client}` 換好。撥、斷、收尾三處共用這一支 ——
    直接拿模板去跑的話 `{client}` 會原封不動送進 shell,VPN 就斷不掉。"""
    return render(_need(workflows.client(name), key, name), {"client": shlex.quote(name)})


async def _cleanup(state: RunState, runner: Runner) -> None:
    """收尾安全網:還掛著的 VPN 一律斷掉,最後關連線。**被取消時也要跑完**。"""
    async def vpn_down(name: str, r: Runner) -> int:
        return await r.run(workflows.base_host_id(), _vpn_command(name, "vpn_down"), lambda _t: None)

    async def body() -> None:
        fresh: Optional[Runner] = None
        for name in list(state.vpn_up):
            state.event("", f"收尾:中斷{name}(流程裡沒有接到「{workflows.LABELS['vpnoff']}」)")
            try:
                try:
                    code = await vpn_down(name, runner)
                except Exception:  # noqa: BLE001
                    # ⚠️ 按停止時那條 SSH 連線常常已經跟著斷了(Connection lost)——
                    # 用舊連線斷 VPN 必失敗,VPN 就掛一整晚。重新連一條再試一次
                    fresh = fresh or runner_factory()
                    code = await vpn_down(name, fresh)
                if code != 0:
                    state.event("", f"中斷{name}失敗(結束代碼{code})", "fail")
                else:
                    state.event("", f"已中斷{name}", "ok")
            except Exception as exc:  # noqa: BLE001
                state.event("", f"中斷{name}失敗:{exc}", "fail")
            state.vpn_up.remove(name)
        await runner.close()
        if fresh is not None:
            await fresh.close()

    try:
        await asyncio.wait_for(asyncio.shield(body()), CLEANUP_TIMEOUT_SEC)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        logger.warning("Work Flow 收尾沒有在時限內完成:run=%s", state.id)
    except Exception:  # noqa: BLE001
        logger.warning("Work Flow 收尾失敗:run=%s", state.id, exc_info=True)


async def _step(state: RunState, runner: Runner, node: dict) -> int:
    ntype = node["type"]
    spec = workflows.NODES[ntype]
    step = Step(node=node["id"], type=ntype, label=spec.label, started=_clock())
    state.steps[node["id"]] = step
    ctx = StepCtx(state, runner, node, step)
    retries = int(ctx.cfg.get("retry") or 0) if spec.retry else 0
    timeout = float(ctx.cfg.get("timeout") or spec.timeout) * 60 if spec.runs_command else None
    out = 1
    try:
        for attempt in range(retries + 1):
            if attempt:
                state.event(node["id"], f"第{attempt}次重試")
                step.lines.clear()
                step.detail = ""
                # 進度條從頭來(回到「還不知道總數」),不然會停在上一次斷掉的位置
                step.progress = None
                await asyncio.sleep(RETRY_DELAY_SEC)
            try:
                out = await asyncio.wait_for(HANDLERS[ntype](ctx), timeout)
                break
            except asyncio.TimeoutError:
                step.message = f"逾時({int((timeout or 0) // 60)}分鐘內沒有跑完)"
                out = 1
            except StepFailed as exc:
                step.message = str(exc)
                out = 1
            # 還會重試的話先把這一次為什麼失敗記下來 —— 不然紀錄只看得到「第 1 次重試」,不知道重試什麼
            if attempt < retries:
                state.event(node["id"], f"{step.message},{int(RETRY_DELAY_SEC)}秒後重試", "fail")
        step.status = "ok" if out == 0 else "fail"
    except asyncio.CancelledError:
        step.status = "fail"
        step.message = "已停止"
        step.finished = _clock()
        state.event(node["id"], "已停止", "fail")
        raise
    step.finished = _clock()
    if step.status == "fail":
        state.failed = True
        state.event(node["id"], step.message or "失敗", "fail")
        if ntype == "start":
            state.stopped_at = step.label
            _save(state)
            # 起點連不上:後面什麼都不用試了
            return -1
    else:
        state.event(node["id"], step.message or "完成", "ok")
    if len(spec.outs) == 1:
        out = 0  # 只有一個出口:失敗照樣記,但流程繼續往下走
    _save(state)
    return out


# ------------------------------------------------------------------ 每種拼圖做什麼
_PLACEHOLDER = re.compile(r"\{(src|dst|exclude|delete|mode|keep|client)\}")
#: rsync --info=progress2 那一行:「  1,234,567  45%  1.20MB/s  0:00:03 (xfr#3, to-chk=2/10)」
_PROGRESS = re.compile(r"^\s*[\d,.]+[KMGT]?\s+(\d{1,3})%\s")
#: 同一行裡「還剩幾個要檢查 / 總共幾個」,換算成「x/N個檔案」。**只有 to-chk 的總數是真的**
_TO_CHECK = re.compile(r"to-chk=(\d+)/(\d+)")
#: 檔案清單還沒收齊(rsync 3 的 incremental recursion,邊列清單邊傳)時是 ir-chk:分母一直在長,
#: 那時候的百分比會 100 → 80 → 100 → 90 亂跳 —— 不拿它畫進度條
_IR_CHECK = re.compile(r"ir-chk=(\d+)/(\d+)")
#: rsync --stats 的「Number of regular files transferred: 128」(舊版叫 files transferred)
_TRANSFERRED = re.compile(r"Number of (?:regular )?files transferred:\s*([\d,]+)")


def _quote_path(p: str) -> str:
    """`~/x` 要留著讓 shell 展開 ~,其他整段 quote。"""
    if p == "~":
        return "~"
    if p.startswith("~/"):
        return "~/" + shlex.quote(p[2:])
    return shlex.quote(p)


def render(template: str, values: dict) -> str:
    """把 `{src}` 這類佔位字換成**已經 quote 好**的值。只認得固定那幾個名字 ——
    模板裡其他的大括號(awk、find -exec {} \\;)原樣留著。"""
    def sub(m: re.Match) -> str:
        key = m.group(1)
        if key not in values:
            raise StepFailed(f"設定檔的指令用了 {{{key}}},但這一塊沒有這個值")
        return values[key]

    return _PLACEHOLDER.sub(sub, template)


class _Collector:
    """指令輸出 → 這一步的紀錄。`\\r` 也當換行(rsync 的進度列是用 \\r 原地刷新)。

    ⚠️ 跑完一定要 `flush()`:最後一行沒有換行結尾的話它還在緩衝區裡,
    而失敗訊息(`_tail`)與「更新了幾個檔案」(`_transferred`)看的正是最後那幾行。
    """

    def __init__(self, step: Step) -> None:
        self.step = step
        self.rest = ""

    def __call__(self, chunk: str) -> None:
        parts = re.split(r"\r\n|\r|\n", self.rest + chunk)
        self.rest = parts.pop()
        for line in parts:
            self._line(line)

    def flush(self) -> None:
        if self.rest:
            self._line(self.rest)
            self.rest = ""

    def _line(self, line: str) -> None:
        step = self.step
        m = _PROGRESS.match(line)
        if m:
            chk = _TO_CHECK.search(line)
            if chk:
                left, total = int(chk.group(1)), int(chk.group(2))
                step.detail = f"{total - left:,}/{total:,}個檔案"
                # 清單收齊了才有真的總數。只往前不往後:進度條倒退比不動更讓人以為壞了
                step.progress = max(step.progress or 0.0, min(100, int(m.group(1))) / 100)
                return
            ir = _IR_CHECK.search(line)
            if ir:
                # 還不知道總共多少:進度維持 None(畫面上是不定長度的動畫),只報已經比對過幾個
                step.detail = f"{int(ir.group(2)) - int(ir.group(1)):,}個檔案"
            return
        if not line.strip():
            return
        step.lines.append(line[:500])
        if len(step.lines) > MAX_LINES:
            del step.lines[: len(step.lines) - MAX_LINES]


@dataclass
class StepCtx:
    """一塊拼圖執行時手上的東西。各拼圖的處理函式(`HANDLERS`)只拿這一個參數。"""

    state: RunState
    runner: Runner
    node: dict
    step: Step

    @property
    def cfg(self) -> dict:
        return self.node.get("cfg") or {}

    @property
    def client(self) -> str:
        """這一塊用哪個客戶:上游那塊「連線客戶」選的。照**這次執行的圖**算,
        不是資料庫裡現在的圖 —— 跑到一半有人改了流程,這一次還是照開始時那一份。"""
        issue = workflows.client_issue(self.state.graph, self.node)
        names = [n for n in workflows.client_of(self.state.graph, self.node["id"]) if n]
        if issue or len(names) != 1:
            raise StepFailed(issue[1] if issue else "前面沒有連線客戶")
        return names[0]

    def event(self, msg: str) -> None:
        self.state.event(self.node["id"], msg)

    async def shell(self, host: str, command: str) -> int:
        collect = _Collector(self.step)
        code = await self.runner.run(host, command, collect)
        collect.flush()
        return code


def _host_of(target: str) -> str:
    """`base` 或客戶名 → 終端機主機 id。"""
    if target in ("", workflows.BASE):
        return workflows.base_host_id()
    host = str((workflows.client(target) or {}).get("host") or "")
    if not host:
        raise StepFailed(f"設定檔裡「{target}」沒有指定主機")
    return host


async def _do_start(ctx: StepCtx) -> int:
    s = ctx.state
    ctx.event(f"開始{'排程執行' if s.trigger == 'schedule' else '手動執行'}({s.triggered_by})")
    ctx.step.message = f"已登入{await ctx.runner.connect(workflows.base_host_id())}"
    return 0


async def _do_vpn(ctx: StepCtx) -> int:
    """「連線客戶」= 在主機上跑這個客戶的 vpn_up,設定檔有寫主機的話再連進客戶主機。"""
    name = ctx.cfg["client"]
    ctx.event(f"連線{name}")
    code = await ctx.shell(workflows.base_host_id(), _vpn_command(name, "vpn_up"))
    if code != 0:
        raise StepFailed(f"連不上{name}VPN(結束代碼{code}){_tail(ctx.step)}")
    if name not in ctx.state.vpn_up:
        ctx.state.vpn_up.append(name)
    if (workflows.client(name) or {}).get("host"):
        ctx.step.message = f"已連上{await ctx.runner.connect(_host_of(name))}"
    else:
        ctx.step.message = f"已連上{name}"
    return 0


async def _do_vpnoff(ctx: StepCtx) -> int:
    # 斷的是上游那條。上游撥接失敗、走「失敗」那條線過來的時候也照樣斷一次 ——
    # 撥到一半的連線可能還掛著,斷一條沒連上的 VPN 不會有害
    name = ctx.client
    ctx.event(f"中斷{name}")
    code = await ctx.shell(workflows.base_host_id(), _vpn_command(name, "vpn_down"))
    if code != 0:
        raise StepFailed(f"中斷{name}失敗(結束代碼{code}){_tail(ctx.step)}")
    if name in ctx.state.vpn_up:
        ctx.state.vpn_up.remove(name)
    ctx.step.message = f"已中斷{name}"
    return 0


#: rsync 的「Partial transfer due to vanished source files」。只有這一個非 0 當成功;
#: 23(有檔案讀不到)不算 —— 那種情況 rsync 為了安全**整批不刪**,目的目錄跟來源不一致,要讓人看到
RSYNC_VANISHED = 24


async def _do_sync(ctx: StepCtx) -> int:
    cfg, step = ctx.cfg, ctx.step
    name = ctx.client
    c = workflows.client(name) or {}
    tmpl = _need(c, "sync", name)
    src = str(cfg.get("src") or "")
    dst = str(cfg.get("dst") or "")
    if not src or not dst:
        raise StepFailed("來源目錄與目的目錄都要填")
    # 存檔時擋過了;這裡再擋一次給沒經過存檔檢查的圖
    if workflows.sync_dst_too_shallow(dst):
        raise StepFailed(workflows.sync_dst_error())
    # 同步 = 跟來源一模一樣:模板少了 {delete} 的話刪除不會同步,寧可失敗也不默默變成「只加不刪」
    if "{delete}" not in tmpl:
        raise StepFailed(f"設定檔裡「{name}」的同步指令沒有 {{delete}},請管理員補上 workflow_actions.json")
    values = {
        "src": _quote_path(src),
        "dst": _quote_path(dst),
        # 一律只傳有變動的、不排除:模板裡寫了這兩個佔位字也不會壞,填空字串
        "exclude": "",
        "mode": "",
        # 傳完才刪(不是邊傳邊刪):中途斷線、逾時被砍,目的目錄一個檔案都不會少
        "delete": "--delete-delay",
        "client": shlex.quote(name),
    }
    ctx.event(f"{name}:{src} → {workflows.LABELS['start']}:{dst}")
    # None = 還不知道總數,畫面上先跑不定長度的動畫,等 rsync 列完清單(to-chk)才換成真的進度條
    step.progress = None
    code = await ctx.shell(workflows.base_host_id(), render(tmpl, values))
    if code == RSYNC_VANISHED:
        # 傳的途中來源有檔案被刪掉(正在用的目錄常見):其他檔案都傳完、刪除也照做了;只有消失的那幾個
        # 在目的目錄可能還留著舊的(它列清單時還在),下一次同步就會刪掉。
        # 不當成失敗 —— 不然一個暫存檔就讓每次同步都走失敗出口
        ctx.event("有檔案在同步途中被來源刪掉,下次同步會跟上")
        code = 0
    if code != 0:
        raise StepFailed(f"同步失敗(結束代碼{code}){_tail(step)}")
    moved = _transferred(step)
    step.progress = 1.0
    step.message = "完成" + (f",更新{moved:,}個檔案" if moved is not None else "")
    return 0


async def _do_script(ctx: StepCtx) -> int:
    path = str(ctx.cfg.get("script") or "")
    runner = workflows.script_runner(path)
    if not runner:
        raise StepFailed(f"不支援這個腳本:{path or '(沒有填)'}")
    # 上游有連著的客戶主機(「連線客戶」的成功出口)就在那台跑,沒有就在主機(見 workflows.needs_client)
    on_client = workflows.needs_client(ctx.state.graph, ctx.node)
    host = _host_of(ctx.client if on_client else workflows.BASE)
    folder, _, name = path.rpartition("/")
    ctx.event(f"在{'客戶主機' if on_client else workflows.LABELS['start']}執行 {path}")
    # 先切到腳本所在的目錄再跑:腳本裡用相對路徑讀自己旁邊的檔案才找得到。
    # 檔名前面加 ./ :檔名是 - 開頭的話(-c.py)會被當成直譯器的選項。
    # stdin 接 /dev/null:排程在跑,沒有人會打字,等輸入的腳本(awk -f 沒給檔案之類)不要卡到逾時
    code = await ctx.shell(host, f"cd {_quote_path(folder or '/')} && {runner} ./{shlex.quote(name)} < /dev/null")
    if code != 0:
        raise StepFailed(f"結束代碼{code}{_tail(ctx.step)}")
    ctx.step.message = "結束代碼0"
    return 0


async def _do_wait(ctx: StepCtx) -> int:
    sec = int(ctx.cfg.get("sec") or 30)
    ctx.event(f"等待{sec}秒")
    await asyncio.sleep(sec)
    ctx.step.message = "時間到"
    return 0


async def _do_notify(ctx: StepCtx) -> int:
    targets = workflows.recipients(ctx.cfg.get("who") or [])
    if not targets:
        # 選的人都停用了、或群組裡一個人都沒有
        raise StepFailed("要通知的人都不在了(帳號停用或刪除)")
    ctx.event(f"通知{len(targets)}人")
    await notifier(ctx.state, targets, _message(ctx.state))
    ctx.step.message = f"已通知{len(targets)}人"
    return 0


#: 每種拼圖做什麼。種類本身(名字、出口、欄位)在 `workflows.NODES`,兩張表的鍵要一樣 ——
#: `test_every_node_type_has_a_handler` 守著。
HANDLERS: dict[str, Callable[[StepCtx], Awaitable[int]]] = {
    "start": _do_start,
    "vpn": _do_vpn,
    "vpnoff": _do_vpnoff,
    "sync": _do_sync,
    "script": _do_script,
    "wait": _do_wait,
    "notify": _do_notify,
}


def _need(c: Optional[dict], key: str, name: str) -> str:
    cmd = str((c or {}).get(key) or "")
    if not cmd:
        raise StepFailed(f"設定檔裡「{name}」沒有{key}指令,請管理員補上 workflow_actions.json")
    return cmd


def _tail(step: Step) -> str:
    return f":{step.lines[-1]}" if step.lines else ""


def _transferred(step: Step) -> Optional[int]:
    for line in reversed(step.lines):
        m = _TRANSFERRED.search(line)
        if m:
            return int(m.group(1).replace(",", ""))
    return None


def _message(state: RunState) -> str:
    """通知的內容:成功就列走過的步驟;失敗就列每一步的原因,附最後十行輸出。"""
    head = _flow_title(state)
    fails = [s for s in state.steps.values() if s.status == "fail"]
    if not fails:
        done = "、".join(s.label for s in state.steps.values() if s.type != "start")
        return f"{head}執行到目前都成功:{done}"
    lines = [f"{head}有步驟失敗:"]
    for s in fails:
        lines.append(f"- {s.label}:{s.message}")
        if s.lines:
            lines.extend("    " + x for x in s.lines[-10:])
    return "\n".join(lines)


# ------------------------------------------------------------------ 排程器
def reschedule(row: models.Workflow, after_local: Optional[datetime] = None) -> None:
    """重算下一次排程時間(寫在 row 上,呼叫端 commit)。"""
    sched = json.loads(row.schedule or "{}")
    nxt = workflows.next_run(sched, after_local or workflows.local_now()) if sched else None
    row.next_run_at = workflows.to_utc(nxt) if nxt else None


def reschedule_all() -> None:
    """開機時:全部從「現在」重算 —— 停機期間錯過的不補跑。"""
    with session_scope() as db:
        for row in db.query(models.Workflow).filter(models.Workflow.deleted_at.is_(None)).all():
            reschedule(row)
        db.commit()


def _schedule_owner(row: models.Workflow) -> str:
    """排程觸發的執行記在誰名下:設這個排程的人(`schedule.by`),沒有就退回最後存檔的人。"""
    return str(json.loads(row.schedule or "{}").get("by") or row.updated_by)


def _owner_problem(owner: str) -> Optional[str]:
    """排程負責人現在還能不能讓主機跑東西。可以回 None,不行回給人看的原因。

    排程觸發的執行以負責人的身分跑主機指令,所以每次到點都重看一次,條件同手動執行
    (`routers/workflows.require_engineer` → `auth.can_use_terminal`),原因直接問同一份判斷
    (`auth.terminal_denial`)。負責人被刪掉的話 `schedule.by` 是封存名(`users.archived_name`),
    查不到,算「不存在」。
    """
    from . import auth

    denial = auth.terminal_denial(owner)
    return None if denial is None else f"排程負責人 {owner} {denial}"


def _record_owner_skip(row: models.Workflow, owner: str) -> bool:
    """負責人失效就記一筆跳過(紀錄頁 + 稽核)並回 True;沒問題什麼都不寫、回 False。"""
    problem = _owner_problem(owner)
    if problem is None:
        return False
    record_skipped(row, owner, problem)
    audit.record("workflow_run_denied", actor=owner, detail=f"{row.name}#{row.id}:{problem}")
    return True


def tick(now_utc: Optional[datetime] = None) -> list[int]:
    """看一次有沒有到點的。回這次觸發了哪幾條(測試用)。

    同步函式、但要在 event loop 裡呼叫(`start_run` 要 `create_task`)。
    """
    now_utc = now_utc or datetime.utcnow()
    fired: list[int] = []
    with session_scope() as db:
        due = (
            db.query(models.Workflow)
            .filter(models.Workflow.deleted_at.is_(None), models.Workflow.next_run_at.isnot(None), models.Workflow.next_run_at <= now_utc)
            .all()
        )
        for row in due:
            sched = json.loads(row.schedule or "{}")
            owner = _schedule_owner(row)
            # 先把下一次算好再觸發:start_run 出了任何事,這條都不會在下一輪又被撿起來
            reschedule(row, now_utc + timedelta(minutes=config.WORKFLOW_UTC_OFFSET_MIN))
            db.commit()
            # 負責人失效(刪除、停用、降成沒有終端機權限的職稱)就不跑:不能以失效的身分跑主機指令
            if _record_owner_skip(row, owner):
                continue
            if row.id in _LIVE:
                if sched.get("overlap") == "queue":
                    _QUEUED.add(row.id)
                else:
                    record_skipped(row, owner, "上一次還在跑")
                continue
            problems = workflows.run_problems(json.loads(row.graph or "{}"))
            if problems:
                record_skipped(row, owner, ";".join(problems))
                continue
            start_run(row, "schedule", owner)
            fired.append(row.id)
    return fired


def _start_queued(workflow_id: int) -> None:
    with session_scope() as db:
        row = db.get(models.Workflow, workflow_id)
        if row is None or row.deleted_at is not None or workflow_id in _LIVE:
            return
        if workflows.run_problems(json.loads(row.graph or "{}")):
            return
        owner = _schedule_owner(row)
        # 排隊等的那段時間負責人可能被改掉,開跑前再看一次
        if _record_owner_skip(row, owner):
            return
        start_run(row, "schedule", owner)


async def scheduler_loop() -> None:
    while True:
        try:
            tick()
        except Exception:  # noqa: BLE001 —— 一次失敗不能讓排程器整個停掉
            logger.exception("Work Flow 排程器這一輪失敗")
        await asyncio.sleep(config.WORKFLOW_TICK_SEC)


async def shutdown() -> None:
    """服務關閉:停掉還在跑的,讓它們收尾(斷 VPN)。紀錄上寫「服務重新啟動」。"""
    states = list(_LIVE.values())
    for s in states:
        request_stop(s, "服務重新啟動")
    tasks = [s.task for s in states if s.task]
    if tasks:
        await asyncio.wait(tasks, timeout=CLEANUP_TIMEOUT_SEC)
