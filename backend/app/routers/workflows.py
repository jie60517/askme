# -*- coding: utf-8 -*-
"""Work Flow 的端點。檢查在 `workflows.py`,執行與排程在 `workflow_engine.py`,
這裡只做權限、參數與回應的形狀。

功能沒開(主機上沒有 workflow_actions.json,或 SSH 終端機沒開)→ 每一條都 404,
跟這組路由不存在一樣;開了但不是工程師 / 管理員 → 403(跟 SSH Server 同一群人)。
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .. import audit, auth, models, workflow_engine as engine, workflows
from ..database import session_scope

def _require_available() -> None:
    # 掛在整組路由上、排在登入檢查前面:沒開的時候連沒登入的人看到的也是 404,跟路由不存在分不出來
    if not workflows.available():
        raise HTTPException(status_code=404, detail="Not Found")


router = APIRouter(prefix="/api/workflows", tags=["workflows"], dependencies=[Depends(_require_available)])


def require_engineer(viewer: str = Depends(auth.require_user)) -> str:
    if not auth.can_use_terminal(viewer):
        raise HTTPException(status_code=403, detail="這個功能只開放給工程師")
    return viewer


class WorkflowIn(BaseModel):
    name: str = Field(default="未命名流程", max_length=80)
    graph: dict = Field(default_factory=dict)
    schedule: dict = Field(default_factory=dict)
    #: 打開時看到的 `updated_at`。別人在這之後存過就回 409,不要默默蓋掉他的改動。
    base_updated_at: Optional[str] = None


def _get(db, workflow_id: int) -> models.Workflow:
    row = db.get(models.Workflow, workflow_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(status_code=404, detail="找不到這個流程(可能已經被刪除)")
    return row


def _detail(row: models.Workflow) -> dict:
    live = engine.live_for(row.id)
    return {
        "id": row.id,
        "name": row.name,
        "graph": json.loads(row.graph or "{}"),
        "schedule": json.loads(row.schedule or "{}"),
        "next_run_at": engine.iso(row.next_run_at),
        "updated_by": row.updated_by,
        "updated_at": engine.iso(row.updated_at),
        "running_run_id": live.id if live else None,
    }


def _normalize(body: WorkflowIn) -> tuple[str, dict, dict]:
    name = body.name.strip() or "未命名流程"
    try:
        return name, workflows.normalize_graph(body.graph), workflows.normalize_schedule(body.schedule)
    except workflows.GraphError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/catalog")
def get_catalog(viewer: str = Depends(require_engineer)):
    return workflows.catalog()


@router.get("")
def list_workflows(viewer: str = Depends(require_engineer)):
    with session_scope() as db:
        rows = (
            db.query(models.Workflow)
            .filter(models.Workflow.deleted_at.is_(None))
            .order_by(models.Workflow.id)
            .all()
        )
        out = []
        for row in rows:
            last = (
                db.query(models.WorkflowRun.status, models.WorkflowRun.started_at)
                .filter(models.WorkflowRun.workflow_id == row.id, models.WorkflowRun.status != "skipped")
                .order_by(models.WorkflowRun.id.desc())
                .first()
            )
            live = engine.live_for(row.id)
            out.append({
                "id": row.id,
                "name": row.name,
                "schedule": json.loads(row.schedule or "{}"),
                "next_run_at": engine.iso(row.next_run_at),
                "last_status": "running" if live else (last[0] if last else None),
                "last_run_at": engine.iso(last[1]) if last else None,
                # 清單頁那一行灰字:起點之後一路成功會經過哪幾塊
                "path": workflows.main_path(json.loads(row.graph or "{}")),
            })
        return out


@router.post("")
def create_workflow(body: WorkflowIn = Body(default_factory=WorkflowIn), viewer: str = Depends(require_engineer)):
    name, graph, schedule = _normalize(body)
    schedule = workflows.schedule_owner(schedule, None, viewer)
    now = datetime.utcnow()
    with session_scope() as db:
        row = models.Workflow(
            name=name, graph=json.dumps(graph, ensure_ascii=False), schedule=json.dumps(schedule, ensure_ascii=False),
            created_by=viewer, updated_by=viewer, created_at=now, updated_at=now,
        )
        engine.reschedule(row)
        db.add(row)
        db.commit()
        audit.record("workflow_saved", actor=viewer, detail=f"新增「{name}」#{row.id}")
        return _detail(row)


@router.get("/runs/{run_id}")
def get_run(
    run_id: int,
    since: int = Query(default=0, ge=0),
    lines: bool = Query(default=False),
    viewer: str = Depends(require_engineer),
):
    state = engine.get_state(run_id)
    if state is not None:
        return state.public(since=since, with_lines=lines)
    with session_scope() as db:
        row = db.get(models.WorkflowRun, run_id)
        if row is None:
            raise HTTPException(status_code=404, detail="找不到這次執行")
        data = engine.row_public(row, with_lines=lines)
        data["events"] = data["events"][since:]
        return data


@router.post("/runs/{run_id}/stop")
def stop_run(run_id: int, viewer: str = Depends(require_engineer)):
    state = engine.get_state(run_id)
    if state is None or state.status != "running":
        raise HTTPException(status_code=409, detail="這次執行已經結束了")
    engine.request_stop(state)
    audit.record("workflow_stop", actor=viewer, detail=f"{state.workflow_name}#{run_id}")
    return {"ok": True}


@router.get("/{workflow_id}")
def get_workflow(workflow_id: int, viewer: str = Depends(require_engineer)):
    with session_scope() as db:
        return _detail(_get(db, workflow_id))


@router.put("/{workflow_id}")
def save_workflow(workflow_id: int, body: WorkflowIn, viewer: str = Depends(require_engineer)):
    name, graph, schedule = _normalize(body)
    with session_scope() as db:
        row = _get(db, workflow_id)
        if body.base_updated_at and body.base_updated_at != engine.iso(row.updated_at):
            raise HTTPException(
                status_code=409,
                detail=f"{row.updated_by} 在你打開之後改過這個流程,重新整理看過再存",
            )
        row.name = name
        row.graph = json.dumps(graph, ensure_ascii=False)
        # 排程沒動的話記名沿用設排程的那個人,不是這次存檔的人(只挪了一塊拼圖不該變成排程負責人)
        schedule = workflows.schedule_owner(schedule, json.loads(row.schedule or "{}"), viewer)
        row.schedule = json.dumps(schedule, ensure_ascii=False)
        row.updated_by = viewer
        row.updated_at = datetime.utcnow()
        engine.reschedule(row)
        db.commit()
        audit.record("workflow_saved", actor=viewer, detail=f"「{name}」#{row.id}")
        return _detail(row)


class ScheduleSwitch(BaseModel):
    on: bool


@router.patch("/{workflow_id}/schedule")
def switch_schedule(workflow_id: int, body: ScheduleSwitch, viewer: str = Depends(require_engineer)):
    """清單頁那顆排程開關:只動 `on`,其他排程內容不變。

    會更新 `updated_at` —— 有人開著編輯器的話,他存檔時會收到 409,不會把開關默默蓋回去。
    """
    with session_scope() as db:
        row = _get(db, workflow_id)
        old = json.loads(row.schedule or "{}")
        try:
            schedule = workflows.normalize_schedule({**old, "on": body.on})
        except workflows.GraphError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        schedule = workflows.schedule_owner(schedule, old, viewer)
        row.schedule = json.dumps(schedule, ensure_ascii=False)
        row.updated_by = viewer
        row.updated_at = datetime.utcnow()
        engine.reschedule(row)
        db.commit()
        audit.record("workflow_saved", actor=viewer, detail=f"「{row.name}」#{row.id} 排程{'開啟' if body.on else '關閉'}")
        return _detail(row)


@router.delete("/{workflow_id}")
def delete_workflow(workflow_id: int, viewer: str = Depends(require_engineer)):
    with session_scope() as db:
        row = _get(db, workflow_id)
        if engine.live_for(row.id):
            raise HTTPException(status_code=409, detail="這個流程正在執行,先停止再刪")
        row.deleted_at = datetime.utcnow()
        row.next_run_at = None
        db.commit()
        audit.record("workflow_deleted", actor=viewer, detail=f"「{row.name}」#{row.id}")
        return {"ok": True}


@router.post("/{workflow_id}/run")
async def run_workflow(workflow_id: int, viewer: str = Depends(require_engineer)):
    with session_scope() as db:
        row = _get(db, workflow_id)
        problems = workflows.run_problems(json.loads(row.graph or "{}"))
        if problems:
            raise HTTPException(status_code=422, detail=problems[0])
        try:
            state = engine.start_run(row, "manual", viewer)
        except engine.Busy:
            raise HTTPException(status_code=409, detail="這個流程正在執行中") from None
        return state.public()


@router.get("/{workflow_id}/runs")
def list_runs(workflow_id: int, limit: int = Query(default=50, ge=1, le=200), viewer: str = Depends(require_engineer)):
    with session_scope() as db:
        _get(db, workflow_id)
        rows = (
            db.query(models.WorkflowRun)
            .filter(models.WorkflowRun.workflow_id == workflow_id)
            .order_by(models.WorkflowRun.id.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": r.id,
                "trigger": r.trigger,
                "triggered_by": r.triggered_by,
                "status": r.status,
                "started_at": engine.iso(r.started_at),
                "finished_at": engine.iso(r.finished_at),
                "stopped_at": r.stopped_at or "",
            }
            for r in rows
        ]
