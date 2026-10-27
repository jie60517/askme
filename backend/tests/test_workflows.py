# -*- coding: utf-8 -*-
"""Work Flow:開關、權限、圖的檢查、執行引擎、排程。

引擎的 SSH 那一段換成 `FakeRunner`(照指令字串回結束代碼與輸出),所以不需要 sshd ——
真的 sshd 那一段跟 SSH 終端機共用 `terminal._connect_host`,由 test_terminal_bridge.py 守著。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_workflows.py
"""
import asyncio
import json
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import auth, config, models, users, workflow_engine as engine, workflows
from app.database import Base, SessionLocal, engine as db_engine
from app.main import app

Base.metadata.create_all(bind=db_engine)

ACTIONS = {
    "base_host": "main",
    "clients": {
        "客戶A": {
            "vpn_up": "sudo vpn-up customer-a",
            "vpn_down": "sudo vpn-down {client}",
            "sync": "timeout 1800 rsync -az --info=progress2 --stats {mode} {delete} {exclude} ca:{src}/ {dst}/",
            "src": "/srv/customer-a/app",
            "dst": "/srv/sync/customer-a",
        },
    },
}
#: 「通知人員」送了什麼(假的 notifier 記在這裡):(帳號, 內容)
SENT: list = []


class FakeRunner:
    """指令 → (結束代碼, 輸出)。`rules` 用子字串比對,第一條對到的算數;都沒對到回 0。"""

    rules: list = []
    log: list = []
    gate: "asyncio.Event | None" = None

    def __init__(self) -> None:
        self.closed = False

    async def connect(self, host_id: str) -> str:
        FakeRunner.log.append(("connect", host_id))
        if any(r[0] == f"connect:{host_id}" for r in FakeRunner.rules):
            raise engine.StepFailed(f"{host_id}:連不上")
        return f"demo@{host_id}"

    async def run(self, host_id, command, on_output):
        FakeRunner.log.append(("run", host_id, command))
        if FakeRunner.gate is not None and "rsync" in command:
            await FakeRunner.gate.wait()
        for needle, code, out in FakeRunner.rules:
            if needle in command:
                on_output(out)
                return code
        return 0

    async def close(self) -> None:
        FakeRunner.log.append(("close",))


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", True)
    monkeypatch.setattr(config, "SSH_TERMINAL_KEY_FILE", "/nonexistent/key")
    monkeypatch.setattr(config, "SSH_TERMINAL_PASSWORD", "")
    monkeypatch.setattr(workflows, "ACTIONS", ACTIONS)
    monkeypatch.setattr(workflows, "ENABLED", True)
    monkeypatch.setattr(engine, "runner_factory", FakeRunner)
    monkeypatch.setattr(engine, "RETRY_DELAY_SEC", 0)

    async def fake_notify(state, usernames, text):
        SENT.append((list(usernames), text))

    monkeypatch.setattr(engine, "notifier", fake_notify)
    SENT.clear()
    FakeRunner.rules = []
    FakeRunner.log = []
    FakeRunner.gate = None
    engine._LIVE.clear()
    engine._BY_RUN.clear()
    engine._QUEUED.clear()
    db = SessionLocal()
    try:
        db.query(models.WorkflowRun).delete()
        db.query(models.Workflow).delete()
        for name, role in (("wf_eng", users.ROLE_ENGINEER), ("wf_cons", users.ROLE_CONSULTANT)):
            db.query(models.User).filter(models.User.username == name).delete()
            db.add(models.User(username=name, password="x", display_name=name, role=role,
                               tools="full" if role == users.ROLE_ENGINEER else None))
        db.commit()
    finally:
        db.close()


def _h(user="wf_eng"):
    return {"Authorization": f"Bearer {auth.issue_token(user)}"}


def _graph(**overrides):
    """主機 → 連線客戶 → 同步 → 中斷連線;連線或同步失敗 → 通知 → 中斷連線。"""
    g = {
        "nodes": [
            {"id": "start", "type": "start", "x": 0, "y": 0},
            {"id": "vpn", "type": "vpn", "x": 1, "y": 0, "cfg": {"client": "客戶A"}},
            {"id": "sync", "type": "sync", "x": 2, "y": 0, "cfg": {"src": "/srv/customer-a/app", "dst": "/srv/sync/customer-a"}},
            {"id": "note", "type": "notify", "x": 2, "y": 1, "cfg": {"who": ["wf_cons", "group:engineer"], "msg": "failure"}},
            {"id": "off", "type": "vpnoff", "x": 3, "y": 0, "cfg": {}},
        ],
        "edges": [
            {"from": "start", "out": 0, "to": "vpn"},
            {"from": "vpn", "out": 0, "to": "sync"},
            {"from": "vpn", "out": 1, "to": "note"},
            {"from": "sync", "out": 0, "to": "off"},
            {"from": "sync", "out": 1, "to": "note"},
            {"from": "note", "out": 0, "to": "off"},
        ],
    }
    g.update(overrides)
    return g


def _make(graph=None, schedule=None, name="客戶A每日同步") -> models.Workflow:
    db = SessionLocal()
    try:
        row = models.Workflow(
            name=name,
            graph=json.dumps(workflows.normalize_graph(graph or _graph()), ensure_ascii=False),
            schedule=json.dumps(workflows.normalize_schedule(schedule or {}), ensure_ascii=False),
            created_by="wf_eng", updated_by="wf_eng",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        db.expunge(row)
        return row
    finally:
        db.close()


def _run(row, trigger="manual"):
    async def go():
        state = engine.start_run(row, trigger, "wf_eng")
        await state.task
        return state

    return asyncio.run(go())


# ------------------------------------------------------------------ 開關:有 workflow_actions.json 才啟用
def _me(user="wf_eng"):
    return TestClient(app).get("/api/me", headers=_h(user)).json()


def test_without_actions_file_everything_is_404_and_me_says_off(monkeypatch):
    """沒有 workflow_actions.json:整組路由跟不存在一樣(沒登入也是 404,不是 401),/api/me 的旗標是 false"""
    monkeypatch.setattr(workflows, "ENABLED", False)
    c = TestClient(app)
    for path in ("/api/workflows", "/api/workflows/catalog", "/api/workflows/1", "/api/workflows/runs/1"):
        assert c.get(path, headers=_h()).status_code == 404, path
        assert c.get(path).status_code == 404, path
    assert c.post("/api/workflows", json={}, headers=_h()).status_code == 404
    assert _me()["workflow_enabled"] is False


def test_with_actions_file_it_is_on_for_engineers(monkeypatch):
    assert _me()["workflow_enabled"] is True
    assert TestClient(app).get("/api/workflows", headers=_h()).status_code == 200
    # 旗標講的是「功能開了沒」;能不能用另外看 can_terminal(Consultant 看得到 true,但打 API 是 403)
    assert _me("wf_cons")["workflow_enabled"] is True and _me("wf_cons")["can_terminal"] is False
    # SSH 終端機沒開:每一步都要經 SSH 跑,功能跟著關
    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", False)
    assert _me()["workflow_enabled"] is False


def test_the_switch_is_whether_the_actions_file_exists(tmp_path, monkeypatch):
    path = tmp_path / "workflow_actions.json"
    monkeypatch.setattr(config, "WORKFLOW_ACTIONS_FILE", path)
    assert workflows._actions_file_present() is False
    path.write_text("{}", encoding="utf-8")
    assert workflows._actions_file_present() is True


def test_scheduler_starts_only_when_enabled(monkeypatch):
    started = []

    async def fake_loop():
        started.append(True)

    monkeypatch.setattr(engine, "scheduler_loop", fake_loop)
    monkeypatch.setattr(workflows, "ENABLED", False)
    with TestClient(app):
        pass
    assert started == []
    monkeypatch.setattr(workflows, "ENABLED", True)
    with TestClient(app):
        pass
    assert started == [True]


# ------------------------------------------------------------------ 權限與 API
def test_consultant_is_forbidden_and_disabled_feature_is_404(monkeypatch):
    c = TestClient(app)
    assert c.get("/api/workflows", headers=_h("wf_cons")).status_code == 403
    assert c.get("/api/workflows/catalog", headers=_h("wf_cons")).status_code == 403
    assert c.get("/api/workflows").status_code == 401
    monkeypatch.setattr(config, "SSH_TERMINAL_ENABLED", False)
    assert c.get("/api/workflows", headers=_h()).status_code == 404


def test_create_save_list_delete_and_audit():
    c = TestClient(app)
    r = c.post("/api/workflows", json={"name": "客戶A每日同步", "graph": _graph(),
                                       "schedule": {"on": True, "freq": "daily", "time": "02:00"}}, headers=_h())
    assert r.status_code == 200, r.text
    wf = r.json()
    assert wf["next_run_at"] is not None
    assert [n["id"] for n in wf["graph"]["nodes"]][0] == "start"

    wf["graph"]["nodes"][1]["x"] = 999
    r = c.put(f"/api/workflows/{wf['id']}", json={"name": "改名", "graph": wf["graph"], "schedule": wf["schedule"],
                                                    "base_updated_at": wf["updated_at"]}, headers=_h())
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "改名"
    # 拿舊的 updated_at 再存一次 = 別人在中間改過 → 409,不默默蓋掉
    r2 = c.put(f"/api/workflows/{wf['id']}", json={"name": "x", "graph": wf["graph"], "schedule": {},
                                                     "base_updated_at": wf["updated_at"]}, headers=_h())
    assert r2.status_code == 409

    listed = c.get("/api/workflows", headers=_h()).json()
    assert [w["name"] for w in listed] == ["改名"]
    assert c.delete(f"/api/workflows/{wf['id']}", headers=_h()).status_code == 200
    assert c.get("/api/workflows", headers=_h()).json() == []
    assert c.get(f"/api/workflows/{wf['id']}", headers=_h()).status_code == 404

    db = SessionLocal()
    try:
        events = [a.event for a in db.query(models.AuditLog).filter(models.AuditLog.actor == "wf_eng").all()]
    finally:
        db.close()
    assert events.count("workflow_saved") >= 2 and "workflow_deleted" in events


@pytest.mark.parametrize(
    "mutate, expect",
    [
        (lambda g: g["nodes"][1]["cfg"].update(client="不存在的客戶"), "不在清單裡"),
        (lambda g: g["nodes"][2]["cfg"].update(src="/srv; rm -rf /"), "只能是 / 開頭的路徑"),
        (lambda g: g["nodes"][2]["cfg"].update(dst="/srv/$(id)"), "只能是 / 開頭的路徑"),
        (lambda g: g["nodes"][2]["cfg"].update(dst="/srv/../../etc"), "只能是 / 開頭的路徑"),
        (lambda g: g["nodes"].append({"id": "x", "type": "shell", "cfg": {}}), "不認得的拼圖種類"),
        (lambda g: g["edges"].append({"from": "vpn", "out": 0, "to": "off"}), "同一個出口只能接一條線"),
        (lambda g: g["edges"].append({"from": "off", "out": 0, "to": "start"}), "起點不能被接進去"),
    ],
)
def test_bad_graphs_are_422(mutate, expect):
    g = _graph()
    mutate(g)
    r = TestClient(app).post("/api/workflows", json={"graph": g}, headers=_h())
    assert r.status_code == 422
    assert expect in r.json()["detail"]


def test_catalog_never_contains_commands():
    body = json.dumps(TestClient(app).get("/api/workflows/catalog", headers=_h()).json(), ensure_ascii=False)
    for needle in ("vpn-up", "vpn-down", "rsync", "r.c2", "TEST_TEAMS_WEBHOOK"):
        assert needle not in body
    # 客戶的名字照樣給(「連線客戶」的選單)
    assert "客戶A" in body


def test_run_problems():
    g = workflows.normalize_graph(_graph())
    assert workflows.run_problems(g) == []
    lonely = workflows.normalize_graph(_graph(edges=[e for e in _graph()["edges"] if e["from"] != "start"]))
    assert "4 塊沒接上主機" in workflows.run_problems(lonely)
    empty = _graph()
    empty["nodes"][1]["cfg"] = {}
    assert "1 塊還沒設定" in workflows.run_problems(workflows.normalize_graph(empty))
    loop = _graph()
    loop["edges"].append({"from": "off", "out": 0, "to": "vpn"})
    assert any("繞回頭" in p for p in workflows.run_problems(workflows.normalize_graph(loop)))


# ------------------------------------------------------------------ 客戶沿用上游的「連線客戶」
def _two_clients(monkeypatch):
    acts = json.loads(json.dumps(ACTIONS, ensure_ascii=False))
    acts["clients"]["客戶E"] = {"vpn_up": "sudo vpn-up wb", "vpn_down": "sudo vpn-down wb"}
    monkeypatch.setattr(workflows, "ACTIONS", acts)


def test_client_comes_from_the_nearest_upstream_vpn():
    g = workflows.normalize_graph(_graph())
    # 直接接在 VPN 後面、隔著通知、兩條路匯流到同一塊:都是客戶A
    assert workflows.client_of(g, "sync") == ["客戶A"]
    assert workflows.client_of(g, "off") == ["客戶A"]
    # VPN 自己與起點不沿用任何東西
    assert workflows.client_of(g, "vpn") == []


def test_second_vpn_takes_over_downstream(monkeypatch):
    """連 A → 同步 → 中斷 → 連 B → 同步:第二個同步只看得到 B(往回找碰到 VPN 就停)。"""
    _two_clients(monkeypatch)
    g = workflows.normalize_graph({
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "a", "type": "vpn", "cfg": {"client": "客戶A"}},
            {"id": "s1", "type": "sync", "cfg": {}},
            {"id": "b", "type": "vpn", "cfg": {"client": "客戶E"}},
            {"id": "s2", "type": "vpnoff", "cfg": {}},
        ],
        "edges": [
            {"from": "start", "out": 0, "to": "a"}, {"from": "a", "out": 0, "to": "s1"},
            {"from": "s1", "out": 0, "to": "b"}, {"from": "b", "out": 0, "to": "s2"},
        ],
    })
    assert workflows.client_of(g, "s1") == ["客戶A"]
    assert workflows.client_of(g, "s2") == ["客戶E"]


def test_run_problems_about_clients(monkeypatch):
    _two_clients(monkeypatch)
    # 沒有上游 VPN
    g = _graph()
    g["edges"] = [e for e in g["edges"] if e["from"] != "vpn"] + [{"from": "start", "out": 0, "to": "sync"}]
    g["edges"] = [e for e in g["edges"] if not (e["from"] == "start" and e["to"] == "vpn")]
    g["nodes"] = [n for n in g["nodes"] if n["id"] != "vpn"]
    assert "2 塊沒有客戶" in workflows.run_problems(workflows.normalize_graph(g))  # sync 與 off
    # 兩個不同客戶的 VPN 匯流到同一塊
    two = _graph()
    two["nodes"].append({"id": "vpn2", "type": "vpn", "cfg": {"client": "客戶E"}})
    two["edges"] += [{"from": "note", "out": 0, "to": "vpn2"}]
    two["edges"] = [e for e in two["edges"] if not (e["from"] == "note")] + [
        {"from": "note", "out": 0, "to": "vpn2"}, {"from": "vpn2", "out": 0, "to": "off"}]
    g2 = workflows.normalize_graph(two)
    assert workflows.client_of(g2, "off") == ["客戶A", "客戶E"]  # sorted
    assert workflows.client_issue(g2, next(n for n in g2["nodes"] if n["id"] == "off")) == (workflows.NO_CLIENT, "接到兩個客戶")
    # 客戶的設定檔裡沒有這一步要的指令(客戶E沒有 sync)
    wb = _graph()
    wb["nodes"][1]["cfg"]["client"] = "客戶E"
    assert "1 塊的客戶在設定檔裡少了這一步的指令" in workflows.run_problems(workflows.normalize_graph(wb))
    # 上游 VPN 還沒選客戶:只算「還沒設定」,下游不另外罵
    unset = _graph()
    unset["nodes"][1]["cfg"] = {}
    probs = workflows.run_problems(workflows.normalize_graph(unset))
    assert "1 塊還沒設定" in probs and not any("客戶" in p for p in probs)


def test_unknown_cfg_fields_are_dropped_on_save():
    """只留 NODES 列的欄位:下游拼圖送來的 client 丟掉(客戶一律沿用上游),
    「在哪一台跑」這種不認得的欄位也丟掉。"""
    g = _graph()
    g["nodes"][2]["cfg"]["client"] = "客戶A"
    g["nodes"][4]["cfg"]["client"] = "*"
    g["nodes"].append({"id": "sc", "type": "script", "cfg": {"script": "/srv/bin/x.sh", "host": "客戶A"}})
    n = {x["id"]: x for x in workflows.normalize_graph(g)["nodes"]}
    assert "client" not in n["sync"]["cfg"] and "client" not in n["off"]["cfg"]
    assert n["sc"]["cfg"] == {"timeout": 10, "retry": 0, "script": "/srv/bin/x.sh"}


def test_list_has_path_last_run_and_schedule_switch():
    c = TestClient(app)
    row = _make(schedule={"on": False, "freq": "daily", "time": "02:00"})
    _run(row)
    item = next(w for w in c.get("/api/workflows", headers=_h()).json() if w["id"] == row.id)
    assert item["path"] == ["連線客戶", "同步程式", "中斷連線"]
    assert item["last_status"] == "ok" and item["last_run_at"]
    assert item["next_run_at"] is None
    r = c.patch(f"/api/workflows/{row.id}/schedule", json={"on": True}, headers=_h())
    assert r.status_code == 200, r.text
    assert r.json()["schedule"]["on"] is True and r.json()["schedule"]["by"] == "wf_eng"
    assert r.json()["next_run_at"] is not None
    # 只跑一次、沒有日期:開不起來,回 422 而不是存一個永遠不會跑的排程
    once = _make(schedule={"on": False, "freq": "once", "time": "02:00"}, name="一次")
    assert c.patch(f"/api/workflows/{once.id}/schedule", json={"on": True}, headers=_h()).status_code == 422
    assert c.patch(f"/api/workflows/{row.id}/schedule", json={"on": True}, headers=_h("wf_cons")).status_code == 403


def test_catalog_marks_nodes_that_inherit_the_client():
    cat = TestClient(app).get("/api/workflows/catalog", headers=_h()).json()
    inherits = {t for t, s in cat["nodes"].items() if s["inherits_client"]}
    assert inherits == {"vpnoff", "sync", "script"}
    for t in ("vpnoff", "sync"):
        assert all(f["key"] != "client" for f in cat["nodes"][t]["fields"])
    # 前端靠這兩個在按執行之前就畫出黃框(跟 run_problems 同一套判斷),只有鍵名,沒有指令
    assert cat["nodes"]["script"]["client_after"] == "vpn" and cat["nodes"]["sync"]["client_after"] is None
    assert ".py" in cat["script_types"] and ".sh" in cat["script_types"]
    assert cat["client_keys"] == {"客戶A": ["sync", "vpn_down", "vpn_up"]}


def test_script_runs_on_the_client_host_only_after_connecting_to_it(monkeypatch):
    """前面的「連線客戶」連上了客戶主機就在那台跑,沒有就在主機;用什麼跑看副檔名"""
    acts = json.loads(json.dumps(ACTIONS, ensure_ascii=False))
    acts["clients"]["客戶A"]["host"] = "ca-host"
    monkeypatch.setattr(workflows, "ACTIONS", acts)
    g = _graph()
    g["nodes"] += [
        {"id": "sc", "type": "script", "cfg": {"script": "/srv/bin/do_it.py"}},
        {"id": "sc2", "type": "script", "cfg": {"script": "~/tools/clean.sh"}},
    ]
    g["edges"] = [e for e in g["edges"] if not (e["from"] == "sync" and e["out"] == 0)] + [
        {"from": "sync", "out": 0, "to": "sc"}, {"from": "sc", "out": 0, "to": "off"}]
    state = _run(_make(g))
    assert state.status == "ok", state.public()["log"]
    assert ("run", "ca-host", "cd /srv/bin && python3 ./do_it.py < /dev/null") in FakeRunner.log
    # 沒接在「連線客戶」後面的:主機
    g2 = _graph(nodes=[{"id": "start", "type": "start"}, {"id": "sc2", "type": "script", "cfg": {"script": "~/tools/clean.sh"}}],
                edges=[{"from": "start", "out": 0, "to": "sc2"}])
    FakeRunner.log = []
    _run(_make(g2, name="主機腳本"))
    assert ("run", "main", "cd ~/tools && bash ./clean.sh < /dev/null") in FakeRunner.log
    assert workflows.run_problems(workflows.normalize_graph({"nodes": [], "edges": []})) == ["流程裡還沒有任何拼圖"]


def test_run_endpoint_refuses_unready_graph():
    row = _make(graph={"nodes": [], "edges": []})
    r = TestClient(app).post(f"/api/workflows/{row.id}/run", headers=_h())
    assert r.status_code == 422
    assert r.json()["detail"] == "流程裡還沒有任何拼圖"


# ------------------------------------------------------------------ 執行
def test_happy_path_records_every_step_and_quotes_arguments(monkeypatch):
    monkeypatch.setenv("TEST_TEAMS_WEBHOOK", "https://example.invalid/hook")
    FakeRunner.rules = [("rsync", 0, "  1,000  45%  1.0MB/s\r  2,000 100%  1.0MB/s\nNumber of regular files transferred: 128\n")]
    state = _run(_make())
    assert state.status == "ok"
    assert [s.node for s in state.steps.values()] == ["start", "vpn", "sync", "off"]
    assert all(s.status == "ok" for s in state.steps.values())
    assert state.steps["sync"].progress == 1.0
    assert "更新128個檔案" in state.steps["sync"].message
    cmds = [x[2] for x in FakeRunner.log if x[0] == "run"]
    assert cmds[0] == "sudo vpn-up customer-a"
    assert "--exclude" not in cmds[1] and " --delete-delay " in cmds[1]
    assert "ca:/srv/customer-a/app/ /srv/sync/customer-a/" in cmds[1]
    assert cmds[-1] == "sudo vpn-down '客戶A'"
    assert [p["to"] for p in state.path] == ["vpn", "sync", "off"]
    # 資料庫裡那一筆跟記憶體同一個結果
    db = SessionLocal()
    try:
        row = db.get(models.WorkflowRun, state.id)
        assert row.status == "ok" and len(json.loads(row.steps)) == 4
    finally:
        db.close()


def test_vpn_failure_takes_the_failure_branch():
    FakeRunner.rules = [("vpn-up", 1, "handshake timeout\n")]
    state = _run(_make())
    sent = [text for _, text in SENT]
    # 群組展開成人、跟單選的人合在一起不重複(單選的 wf_cons + 工程師組裡的 wf_eng)
    assert "wf_cons" in SENT[0][0] and "wf_eng" in SENT[0][0]
    assert len(SENT[0][0]) == len(set(SENT[0][0]))
    assert state.status == "fail"
    assert [s.node for s in state.steps.values()] == ["start", "vpn", "note", "off"]
    assert state.steps["vpn"].status == "fail"
    assert "handshake timeout" in state.steps["vpn"].message
    assert "連線客戶" in sent[0] and "handshake timeout" in sent[0]
    assert state.stopped_at == "連線客戶"


def test_unconnected_failure_exit_fails_the_run():
    g = _graph(edges=[{"from": "start", "out": 0, "to": "vpn"}, {"from": "vpn", "out": 0, "to": "sync"}])
    g["nodes"] = [n for n in g["nodes"] if n["id"] in ("start", "vpn", "sync")]
    FakeRunner.rules = [("rsync", 23, "rsync error\n")]
    state = _run(_make(graph=g))
    assert state.status == "fail"
    assert state.stopped_at == "同步程式"


def test_vpn_left_up_is_taken_down_by_cleanup():
    """流程裡沒有「中斷連線」:結束時後端自己斷。"""
    g = _graph(edges=[{"from": "start", "out": 0, "to": "vpn"}, {"from": "vpn", "out": 0, "to": "sync"}])
    g["nodes"] = [n for n in g["nodes"] if n["id"] in ("start", "vpn", "sync")]
    state = _run(_make(graph=g))
    assert state.status == "ok"
    assert ("run", "main", "sudo vpn-down '客戶A'") in FakeRunner.log
    assert any("收尾" in e["msg"] for e in state.events)
    assert FakeRunner.log[-1] == ("close",)


def test_stop_mid_run_marks_stopped_and_still_cleans_up():
    async def go():
        FakeRunner.gate = asyncio.Event()
        state = engine.start_run(_make(), "manual", "wf_eng")
        while "sync" not in state.steps:
            await asyncio.sleep(0.01)
        engine.request_stop(state)
        await state.task
        return state

    state = asyncio.run(go())
    assert state.status == "stopped"
    assert state.steps["sync"].status == "fail" and state.steps["sync"].message == "已停止"
    assert ("run", "main", "sudo vpn-down '客戶A'") in FakeRunner.log


def test_second_run_is_busy():
    async def go():
        FakeRunner.gate = asyncio.Event()
        row = _make()
        state = engine.start_run(row, "manual", "wf_eng")
        with pytest.raises(engine.Busy):
            engine.start_run(row, "manual", "wf_eng")
        FakeRunner.gate.set()
        await state.task

    asyncio.run(go())


def test_start_host_unreachable_stops_immediately():
    FakeRunner.rules = [("connect:main", 1, "")]
    state = _run(_make())
    assert state.status == "fail"
    assert list(state.steps) == ["start"]
    assert state.stopped_at == "主機"


def test_retry_then_success():
    calls = {"n": 0}

    class Flaky(FakeRunner):
        async def run(self, host_id, command, on_output):
            if "vpn-up" in command:
                calls["n"] += 1
                return 1 if calls["n"] == 1 else 0
            return 0

    engine.runner_factory = Flaky
    g = _graph()
    g["nodes"][1]["cfg"]["retry"] = 1
    state = _run(_make(graph=g))
    assert calls["n"] == 2
    assert state.steps["vpn"].status == "ok"
    assert any("第1次重試" in e["msg"] for e in state.events)
    # 重試之前先記一筆這一次為什麼失敗
    assert any(e["level"] == "fail" and "秒後重試" in e["msg"] for e in state.events)


def test_run_view_carries_the_graph_it_ran():
    """紀錄頁重播的是當時那一版的圖,不是現在的(事後改了流程也對得上)。"""
    row = _make()
    state = _run(row)
    assert state.public()["graph"]["nodes"][1]["cfg"]["client"] == "客戶A"
    db = SessionLocal()
    try:
        r = db.get(models.WorkflowRun, state.id)
        assert engine.row_public(r)["graph"]["nodes"][1]["cfg"]["client"] == "客戶A"
    finally:
        db.close()


def test_orphan_runs_are_closed_on_startup():
    row = _make()
    db = SessionLocal()
    try:
        db.add(models.WorkflowRun(workflow_id=row.id, trigger="manual", triggered_by="wf_eng", status="running"))
        db.commit()
    finally:
        db.close()
    assert engine.close_orphan_workflow_runs() == 1
    db = SessionLocal()
    try:
        r = db.query(models.WorkflowRun).one()
        assert r.status == "fail" and r.finished_at is not None
        assert "服務重新啟動" in r.events
    finally:
        db.close()


def test_render_only_touches_known_placeholders():
    assert engine.render("awk '{print $1}' {src}", {"src": "'/a'"}) == "awk '{print $1}' '/a'"
    assert engine._quote_path("~/sync/x") == "~/sync/x"
    assert engine._quote_path("/srv/a b") == "'/srv/a b'"


# ------------------------------------------------------------------ 排程
def _at(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M")


def test_next_run_math():
    daily = workflows.normalize_schedule({"on": True, "freq": "daily", "time": "02:00"})
    assert workflows.next_run(daily, _at("2026-09-24 01:59")) == _at("2026-09-24 02:00")
    assert workflows.next_run(daily, _at("2026-09-24 02:00")) == _at("2026-09-25 02:00")
    assert workflows.next_run(daily, _at("2026-09-30 23:00")) == _at("2026-10-01 02:00")
    # 每週六(JS 編號 6)。2026-09-24 是星期四
    weekly = workflows.normalize_schedule({"on": True, "freq": "weekly", "time": "23:30", "days": [6]})
    assert workflows.next_run(weekly, _at("2026-09-24 12:00")) == _at("2026-09-26 23:30")
    sunday = workflows.normalize_schedule({"on": True, "freq": "weekly", "time": "08:00", "days": [0]})
    assert workflows.next_run(sunday, _at("2026-09-26 09:00")) == _at("2026-09-27 08:00")
    hourly = workflows.normalize_schedule({"on": True, "freq": "hourly", "time": "00:15"})
    assert workflows.next_run(hourly, _at("2026-09-24 10:20")) == _at("2026-09-24 11:15")
    once = workflows.normalize_schedule({"on": True, "freq": "once", "time": "09:00", "date": "2026-09-25"})
    assert workflows.next_run(once, _at("2026-09-24 10:00")) == _at("2026-09-25 09:00")
    assert workflows.next_run(once, _at("2026-09-25 10:00")) is None
    assert workflows.next_run(workflows.normalize_schedule({"on": False}), _at("2026-09-24 10:00")) is None


def _due(row, minutes_ago=1):
    db = SessionLocal()
    try:
        r = db.get(models.Workflow, row.id)
        r.next_run_at = datetime.utcnow() - timedelta(minutes=minutes_ago)
        db.commit()
    finally:
        db.close()


def test_tick_fires_once_and_reschedules():
    row = _make(schedule={"on": True, "freq": "daily", "time": "02:00"})
    _due(row)

    async def go():
        fired = engine.tick()
        again = engine.tick()
        await engine.live_for(row.id).task
        return fired, again

    fired, again = asyncio.run(go())
    assert fired == [row.id] and again == []
    db = SessionLocal()
    try:
        r = db.get(models.Workflow, row.id)
        assert r.next_run_at > datetime.utcnow()
        run = db.query(models.WorkflowRun).one()
        assert run.trigger == "schedule" and run.triggered_by == "wf_eng" and run.status == "ok"
    finally:
        db.close()


@pytest.mark.parametrize("overlap", ["skip", "queue"])
def test_tick_while_running(overlap):
    row = _make(schedule={"on": True, "freq": "hourly", "time": "00:00", "overlap": overlap})

    async def go():
        FakeRunner.gate = asyncio.Event()
        first = engine.start_run(row, "manual", "wf_eng")
        while "sync" not in first.steps:
            await asyncio.sleep(0.01)
        _due(row)
        assert engine.tick() == []
        FakeRunner.gate.set()
        await first.task
        await asyncio.sleep(0.05)
        second = engine.live_for(row.id)
        if second:
            await second.task

    asyncio.run(go())
    db = SessionLocal()
    try:
        statuses = [r.status for r in db.query(models.WorkflowRun).order_by(models.WorkflowRun.id)]
        triggers = [r.trigger for r in db.query(models.WorkflowRun).order_by(models.WorkflowRun.id)]
    finally:
        db.close()
    if overlap == "skip":
        assert statuses == ["skipped", "ok"] or statuses == ["ok", "skipped"]
    else:
        assert statuses == ["ok", "ok"] and triggers == ["manual", "schedule"]


@pytest.mark.parametrize("case", ["deleted", "disabled", "consultant"])
def test_tick_skips_when_the_schedule_owner_is_no_longer_valid(case):
    """負責人被刪除(schedule.by 變封存名)、停用、或降成沒有終端機權限的職稱:到點不跑,記一筆跳過與稽核。"""
    row = _make(schedule={"on": True, "freq": "daily", "time": "02:00"})
    owner = {"deleted": users.archived_name("wf_eng"), "disabled": "wf_eng", "consultant": "wf_cons"}[case]
    db = SessionLocal()
    try:
        r = db.get(models.Workflow, row.id)
        sched = json.loads(r.schedule)
        sched["by"] = owner
        r.schedule = json.dumps(sched, ensure_ascii=False)
        if case == "disabled":
            db.get(models.User, "wf_eng").disabled = True
        db.query(models.AuditLog).filter(models.AuditLog.event == "workflow_run_denied").delete()
        db.commit()
    finally:
        db.close()
    _due(row)

    async def go():
        return engine.tick()

    assert asyncio.run(go()) == []
    assert engine.live_for(row.id) is None
    db = SessionLocal()
    try:
        run = db.query(models.WorkflowRun).one()
        assert run.status == "skipped" and run.triggered_by == owner and "排程負責人" in run.stopped_at
        assert not any(e[0] == "run" for e in FakeRunner.log), "負責人失效時一條主機指令都不能跑"
        logs = db.query(models.AuditLog).filter(models.AuditLog.event == "workflow_run_denied").all()
        assert [a.actor for a in logs] == [owner]
        assert db.get(models.Workflow, row.id).next_run_at > datetime.utcnow(), "下一次照樣排好"
    finally:
        db.close()


def test_missed_schedules_are_not_caught_up():
    row = _make(schedule={"on": True, "freq": "daily", "time": "02:00"})
    _due(row, minutes_ago=60 * 24 * 3)
    engine.reschedule_all()
    db = SessionLocal()
    try:
        assert db.get(models.Workflow, row.id).next_run_at > datetime.utcnow()
    finally:
        db.close()


def test_example_actions_file_is_valid(monkeypatch):
    """範本要能直接複製來用:json 讀得起來,目錄裡看得到它列的東西,看不到指令,也沒有引擎不認的佔位符。"""
    from pathlib import Path

    backend = Path(__file__).resolve().parent.parent
    raw = json.loads((backend / "workflow_actions.example.json").read_text(encoding="utf-8"))
    monkeypatch.setattr(workflows, "ACTIONS", raw)
    # 範本裡的客戶指到 terminal_hosts 範本裡的主機:兩份範本要一起對得起來
    monkeypatch.setattr(config, "TERMINAL_HOSTS_FILE", backend / "terminal_hosts.example.json")
    monkeypatch.setattr(config, "_TERMINAL_HOSTS_FILE_ENTRIES", config._load_terminal_hosts_file())
    clients = {"客戶A": "main"}
    for host_id in clients.values():
        assert config.find_terminal_host(host_id) is not None
    cat = workflows.catalog()
    vpn_client = next(f for f in cat["nodes"]["vpn"]["fields"] if f["key"] == "client")
    assert [o["value"] for o in vpn_client["options"]] == list(clients)
    for name in clients:
        assert {"vpn_up", "vpn_down", "host", "sync"} <= set(cat["client_keys"][name])
    body = json.dumps(cat, ensure_ascii=False)
    assert "rsync" not in body and "vpn-up" not in body
    # {rsh}、{target} 這兩個佔位符引擎沒有值可以填(render 遇到就讓那一步失敗),範本裡不可以出現
    text = (backend / "workflow_actions.example.json").read_text(encoding="utf-8")
    for placeholder in ("{rsh}", "{target}"):
        assert placeholder not in text, placeholder


# ------------------------------------------------------------------ 收尾、紀錄、進度
def test_every_node_type_has_a_handler():
    """拼圖種類(workflows.NODES)與「它做什麼」(engine.HANDLERS)兩張表的鍵要一樣。"""
    assert set(workflows.NODES) == set(engine.HANDLERS)


def test_cleanup_renders_client_placeholder():
    """收尾斷 VPN 要跟一般步驟一樣套模板 —— 直接跑模板的話 {client} 會原封不動送進 shell。"""
    g = _graph(edges=[{"from": "start", "out": 0, "to": "vpn"}])
    g["nodes"] = [n for n in g["nodes"] if n["id"] in ("start", "vpn")]
    _run(_make(graph=g))
    cmds = [x[2] for x in FakeRunner.log if x[0] == "run"]
    assert cmds[-1] == "sudo vpn-down '客戶A'"
    assert not any("{client}" in c for c in cmds)


def test_last_line_without_newline_is_kept():
    """最後一行沒有換行結尾也要進紀錄 —— 失敗訊息看的就是它。"""
    FakeRunner.rules = [("vpn-up", 1, "handshake timeout")]
    state = _run(_make())
    assert "handshake timeout" in state.steps["vpn"].message


def test_sync_progress_detail():
    g = _graph()
    FakeRunner.rules = [("rsync", 0, "  1,000  45%  1.0MB/s  0:00:01 (xfr#3, to-chk=2178/3960)\rNumber of regular files transferred: 7\n")]
    state = _run(_make(graph=g))
    assert state.steps["sync"].detail == "1,782/3,960個檔案"


def test_sync_progress_waits_for_the_real_total_and_never_goes_back():
    """清單還沒收齊(ir-chk)時百分比的分母一直在長,會 100 → 80 → 100 亂跳:不畫進度條(None = 不定長度動畫);
    收齊(to-chk)之後才是真的進度,而且只往前"""
    seen = []

    class Watch(FakeRunner):
        async def run(self, host_id, command, on_output):
            if "rsync" not in command:
                return 0
            for line in (
                "  1,000 100%  1.0MB/s  0:00:01 (xfr#1, ir-chk=1020/1030)\r",
                "  2,000  80%  1.0MB/s  0:00:01 (xfr#9, ir-chk=1500/1600)\r",
                "  3,000  40%  1.0MB/s  0:00:02 (xfr#30, to-chk=900/2000)\r",
                "  3,100  38%  1.0MB/s  0:00:02 (xfr#31, to-chk=899/2000)\r",
            ):
                on_output(line)
                step = holder["state"].steps["sync"]
                seen.append((step.progress, step.detail))
            return 0

    holder = {}

    async def go():
        engine.runner_factory = Watch
        state = engine.start_run(_make(), "manual", "wf_eng")
        holder["state"] = state
        await state.task

    asyncio.run(go())
    assert seen == [(None, "10個檔案"), (None, "100個檔案"), (0.4, "1,100/2,000個檔案"), (0.4, "1,101/2,000個檔案")]
    assert holder["state"].steps["sync"].progress == 1.0


def test_sync_needs_both_directories_and_only_has_them():
    """同步只有兩個目錄,兩個都要填才能跑;方式 / 排除 / 刪除這些不認得的欄位存檔時丟掉"""
    cat = TestClient(app).get("/api/workflows/catalog", headers=_h()).json()
    assert [f["key"] for f in cat["nodes"]["sync"]["fields"]] == ["src", "dst"]
    assert cat["nodes"]["sync"]["required"] == ["src", "dst"]
    g = _graph()
    g["nodes"][2]["cfg"] = {"src": "/srv/a", "mode": "full", "exclude": "*.log", "delete": True}
    saved = workflows.normalize_graph(g)
    assert set(saved["nodes"][2]["cfg"]) == {"timeout", "retry", "src", "dst"}
    assert "1 塊還沒設定" in workflows.run_problems(saved)


def test_sync_destination_must_be_deep_enough_because_it_deletes():
    """同步會刪掉目的目錄裡來源沒有的檔案:目的目錄淺到家目錄就擋,存檔時與執行時都擋"""
    for bad in ("/home/demo", "/srv", "~", "~/", "~/.", "/home/demo/.", "/home/./demo"):
        g = _graph()
        g["nodes"][2]["cfg"]["dst"] = bad
        with pytest.raises(workflows.GraphError, match="至少要3層"):
            workflows.normalize_graph(g)
    for ok in ("/home/demo/projects/customer-a/app", "~/customer-a", "/srv/sync/customer-a"):
        g = _graph()
        g["nodes"][2]["cfg"]["dst"] = ok
        assert workflows.normalize_graph(g)["nodes"][2]["cfg"]["dst"] == ok
    # 沒經過存檔檢查的圖:執行時再擋,rsync 一次都不跑
    row = _make()
    saved = json.loads(row.graph)
    saved["nodes"][2]["cfg"]["dst"] = "/home/demo"
    row.graph = json.dumps(saved, ensure_ascii=False)
    state = _run(row)
    assert state.steps["sync"].status == "fail" and "至少要3層" in state.steps["sync"].message
    assert not any("rsync" in x[2] for x in FakeRunner.log if x[0] == "run")


def test_sync_template_without_delete_fails_instead_of_silently_not_deleting(monkeypatch):
    actions = json.loads(json.dumps(ACTIONS))
    actions["clients"]["客戶A"]["sync"] = "timeout 1800 rsync -az ca:{src}/ {dst}/"
    monkeypatch.setattr(workflows, "ACTIONS", actions)
    # 執行前就擋(拼圖上冒黃色警告),不用等撥完 VPN 才失敗
    assert not workflows.client_has("客戶A", "sync")
    assert any("少了這一步的指令" in p for p in workflows.run_problems(workflows.normalize_graph(_graph())))
    # 硬跑(跳過執行前檢查)也不會變成「只加不刪」
    state = _run(_make())
    assert state.steps["sync"].status == "fail" and "{delete}" in state.steps["sync"].message
    assert not any("rsync" in x[2] for x in FakeRunner.log if x[0] == "run")


def test_sync_vanished_source_files_still_counts_as_done():
    """rsync 24(傳的途中來源有檔案被刪):其他都傳完、也刪了,不走失敗出口;23(讀不到、整批不刪)照樣失敗"""
    FakeRunner.rules = [("rsync", 24, "file has vanished: \"/srv/customer-a/app/tmp/x\"\nNumber of regular files transferred: 3\n")]
    state = _run(_make())
    assert state.steps["sync"].status == "ok" and state.steps["sync"].message == "完成,更新3個檔案"
    assert any("下次同步會跟上" in e["msg"] for e in state.events)
    FakeRunner.rules = [("rsync", 23, "rsync error: some files could not be transferred (code 23)\n")]
    assert _run(_make()).steps["sync"].status == "fail"


def test_retry_resets_progress():
    seen = []

    class Twice(FakeRunner):
        async def run(self, host_id, command, on_output):
            if "rsync" in command:
                seen.append(self_step_progress())
                on_output("  1,000  60%  1.0MB/s  0:00:01 (xfr#1, to-chk=4/10)\r")
                return 1 if len(seen) == 1 else 0
            return 0

    holder = {}

    def self_step_progress():
        return holder["state"].steps["sync"].progress

    async def go():
        engine.runner_factory = Twice
        g = _graph()
        g["nodes"][2]["cfg"]["retry"] = 1
        state = engine.start_run(_make(graph=g), "manual", "wf_eng")
        holder["state"] = state
        await state.task
        return state

    asyncio.run(go())
    assert seen == [None, None], "第二次重試開始時回到「還不知道總數」,不能停在上一次的 60%"


def test_shutdown_records_the_reason():
    async def go():
        FakeRunner.gate = asyncio.Event()
        state = engine.start_run(_make(), "manual", "wf_eng")
        while "sync" not in state.steps:
            await asyncio.sleep(0.01)
        await engine.shutdown()
        return state

    state = asyncio.run(go())
    assert state.status == "stopped" and state.stopped_at == "服務重新啟動"
    assert any("服務重新啟動" in e["msg"] for e in state.events)


def test_schedule_owner_is_whoever_set_the_schedule():
    """排程沒動的存檔不會把排程負責人換成存檔的人;排程觸發的執行記在負責人名下。"""
    c = TestClient(app)
    wf = c.post("/api/workflows", json={"graph": _graph(), "schedule": {"on": True, "freq": "daily", "time": "02:00"}},
                headers=_h("wf_eng")).json()
    assert wf["schedule"]["by"] == "wf_eng"
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == "wf_eng2").delete()
        db.add(models.User(username="wf_eng2", password="x", display_name="wf_eng2", role=users.ROLE_ENGINEER, tools="full"))
        db.commit()
    finally:
        db.close()
    wf["graph"]["nodes"][1]["x"] = 50
    wf2 = c.put(f"/api/workflows/{wf['id']}", json={"graph": wf["graph"], "schedule": wf["schedule"], "name": wf["name"]},
                headers=_h("wf_eng2")).json()
    assert wf2["schedule"]["by"] == "wf_eng", "只挪了一塊拼圖,排程負責人不該換人"
    wf2["schedule"]["time"] = "03:00"
    wf3 = c.put(f"/api/workflows/{wf['id']}", json={"graph": wf2["graph"], "schedule": wf2["schedule"], "name": wf["name"]},
                headers=_h("wf_eng2")).json()
    assert wf3["schedule"]["by"] == "wf_eng2"


def test_catalog_describes_fields_and_defaults():
    cat = TestClient(app).get("/api/workflows/catalog", headers=_h()).json()
    assert cat["utc_offset_min"] == config.WORKFLOW_UTC_OFFSET_MIN
    # 中斷連線只斷上游那一條,用一般的預設逾時
    assert cat["nodes"]["vpnoff"]["timeout"] == 1 and cat["nodes"]["sync"]["timeout"] == 30
    assert cat["nodes"]["wait"]["runs_command"] is False


def test_cleanup_reconnects_when_the_connection_died():
    """按停止之後舊連線常常已經斷了:收尾要重新連一條把 VPN 斷掉,不能就此放棄。"""
    instances = []

    class Dying(FakeRunner):
        def __init__(self):
            super().__init__()
            instances.append(self)

        async def run(self, host_id, command, on_output):
            if "vpn-down" in command and self is instances[0]:
                raise engine.StepFailed("Connection lost")
            return await super().run(host_id, command, on_output)

    async def go():
        engine.runner_factory = Dying
        FakeRunner.gate = asyncio.Event()
        state = engine.start_run(_make(), "manual", "wf_eng")
        while "sync" not in state.steps:
            await asyncio.sleep(0.01)
        engine.request_stop(state)
        await state.task
        return state

    state = asyncio.run(go())
    assert len(instances) == 2, "舊連線斷了要開一條新的"
    assert any(e["msg"] == "已中斷客戶A" for e in state.events)
    # 手動停止:停在哪一塊寫得出來,「已停止」只記一次
    assert state.stopped_at == "同步程式"
    assert sum(1 for e in state.events if "已停止" in e["msg"]) == 1
    assert all(e["label"] for e in state.events), "每一則紀錄都要有歸屬(不屬於任何一塊的記在「流程」)"


def test_status_stays_running_until_cleanup_is_done():
    """收尾(斷 VPN)還在跑的時候狀態要維持 running —— 前端看到結束就停止輪詢,收尾那幾行會到不了畫面。"""
    seen = []

    class Watch(FakeRunner):
        async def run(self, host_id, command, on_output):
            if "vpn-down" in command:
                seen.append(next(iter(engine._BY_RUN.values())).status)
            return await super().run(host_id, command, on_output)

    g = _graph(edges=[{"from": "start", "out": 0, "to": "vpn"}])
    g["nodes"] = [n for n in g["nodes"] if n["id"] in ("start", "vpn")]
    engine.runner_factory = Watch
    state = _run(_make(graph=g))
    assert seen == ["running"]
    assert state.status == "ok"


# ------------------------------------------------------------------ 通知人員
def test_notify_offers_people_and_the_three_chat_groups():
    cat = TestClient(app).get("/api/workflows/catalog", headers=_h()).json()
    spec = cat["nodes"]["notify"]
    assert spec["label"] == "通知人員" and spec["runs_command"] is False
    who = {f["key"]: f for f in spec["fields"]}["who"]
    assert who["kind"] == "people"
    values = [o["value"] for o in who["options"]]
    # 自己也選得到(流程跑完通知自己是正常的,跟聊天不同)
    assert "wf_eng" in values and "wf_cons" in values
    groups = [o["label"] for o in who["options"] if o.get("group")]
    assert groups == ["All Consultant", "All Software Engineer", "ALL"]


def test_script_host_only_counts_a_live_client_connection(monkeypatch):
    """客戶主機要「連著」才在那裡跑:客戶設定檔沒寫主機、接在連線客戶的失敗出口、中斷連線之後,都回主機"""
    def g(edges, extra=()):
        nodes = [{"id": "start", "type": "start"}, {"id": "v", "type": "vpn", "cfg": {"client": "客戶A"}},
                 {"id": "sc", "type": "script", "cfg": {"script": "/a.sh"}}, *extra]
        return workflows.normalize_graph({"nodes": nodes, "edges": [{"from": a, "out": o, "to": b} for a, o, b in edges]})

    def sc(graph):
        return next(n for n in graph["nodes"] if n["id"] == "sc")

    # 設定檔裡的客戶A沒有 host:只撥 VPN,腳本照舊在主機跑
    no_host = g([("start", 0, "v"), ("v", 0, "sc")])
    assert not workflows.needs_client(no_host, sc(no_host))

    acts = json.loads(json.dumps(ACTIONS, ensure_ascii=False))
    acts["clients"]["客戶A"]["host"] = "ca-host"
    monkeypatch.setattr(workflows, "ACTIONS", acts)
    ok = g([("start", 0, "v"), ("v", 0, "sc")])
    assert workflows.needs_client(ok, sc(ok))
    failed = g([("start", 0, "v"), ("v", 1, "sc")])
    assert not workflows.needs_client(failed, sc(failed))
    off = g([("start", 0, "v"), ("v", 0, "o"), ("o", 0, "sc")], [{"id": "o", "type": "vpnoff"}])
    assert not workflows.needs_client(off, sc(off))


def test_script_path_rules():
    """相對路徑、~user 報錯(不是默默清掉)"""
    for bad in ("bin/run.sh", "~other/x.sh", "~x.py", "recompile"):
        g = _graph(nodes=[{"id": "start", "type": "start"}, {"id": "sc", "type": "script", "cfg": {"script": bad}}], edges=[])
        with pytest.raises(workflows.GraphError):
            workflows.normalize_graph(g)


def test_script_types_decide_how_to_run_and_unknown_ones_block_the_run():
    assert workflows.script_runner("/a/b/x.PY") == "python3"
    assert workflows.script_runner("/a/b/job.jar") == "java -jar"
    assert workflows.script_runner("/a/b/readme.txt") is None
    assert workflows.script_runner("/a/b/noext") is None
    g = _graph(nodes=[{"id": "start", "type": "start"}, {"id": "sc", "type": "script", "cfg": {"script": "/srv/notes.txt"}}],
               edges=[{"from": "start", "out": 0, "to": "sc"}])
    assert "1 塊的腳本類型不支援" in workflows.run_problems(workflows.normalize_graph(g))


def test_people_groups_match_the_chat_mention_menu():
    """通知人員的群組跟聊天的 @ 選單要同一組(字與職稱),兩邊各寫一份,這條對字"""
    from pathlib import Path

    chat = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "pages" / "Chat.tsx").read_text(encoding="utf-8")
    for label, role in workflows.PEOPLE_GROUPS.values():
        assert f"label: '{label}'" in chat, label
    # 職稱字串跟 users.py 的常數一致(Chat 那邊用的是 adminApi 的常數,指向同一個字)
    roles = {r for _, r in workflows.PEOPLE_GROUPS.values() if r}
    assert roles == {users.ROLE_CONSULTANT, users.ROLE_ENGINEER}


def test_notify_list_drops_unknown_people_on_save_and_empty_list_blocks_run():
    g = _graph()
    note = next(n for n in g["nodes"] if n["id"] == "note")
    note["cfg"] = {"who": ["wf_cons", "ghost-user", "wf_cons", "group:all"]}
    saved = workflows.normalize_graph(g)
    assert next(n for n in saved["nodes"] if n["id"] == "note")["cfg"]["who"] == ["wf_cons", "group:all"]
    note["cfg"] = {"who": []}
    assert "1 塊還沒設定" in workflows.run_problems(workflows.normalize_graph(g))
    # 舊的「通知 Teams」(存的是 channel)讀進來變成沒選人的「通知人員」
    note["cfg"] = {"channel": "ops", "msg": "failure"}
    assert next(n for n in workflows.normalize_graph(g)["nodes"] if n["id"] == "note")["cfg"] == {"who": []}


def test_recipients_expand_groups_at_run_time_and_skip_disabled():
    assert workflows.recipients(["group:consultant"]) == [
        p["username"] for p in users.list_active() if p["role"] == users.ROLE_CONSULTANT
    ]
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == "wf_cons").update({"disabled": True})
        db.commit()
    finally:
        db.close()
    assert "wf_cons" not in workflows.recipients(["wf_cons", "group:all"])
    assert workflows.recipients(["wf_cons"]) == []


def test_notify_with_nobody_left_fails_the_step():
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == "wf_cons").update({"disabled": True})
        db.commit()
    finally:
        db.close()
    g = _graph()
    next(n for n in g["nodes"] if n["id"] == "note")["cfg"] = {"who": ["wf_cons"]}
    FakeRunner.rules = [("vpn-up", 1, "boom\n")]
    state = _run(_make(graph=g))
    assert state.steps["note"].status == "fail"
    assert "帳號停用" in state.steps["note"].message
    assert SENT == []


def test_in_app_notice_is_a_shared_conversation_with_a_mention(monkeypatch):
    """真的那支 notifier:寫一題結果 + 一則 @ 便條,被 @ 的人拉進共用;用量統計不算這一題。"""
    from app import notes
    from app.routers import stats

    monkeypatch.setattr(engine, "notifier", engine._notify_in_app)
    FakeRunner.rules = [("vpn-up", 1, "boom\n")]
    row = _make()
    conv = f"workflow-{row.id}"
    db = SessionLocal()
    try:
        db.query(models.ConversationMention).filter(models.ConversationMention.conversation_id == conv).delete()
        db.query(models.ConversationShare).filter(models.ConversationShare.conversation_id == conv).delete()
        db.query(models.ConversationNote).filter(models.ConversationNote.conversation_id == conv).delete()
        db.query(models.QARecord).filter(models.QARecord.conversation_id == conv).delete()
        db.commit()
    finally:
        db.close()
    _run(row)
    db = SessionLocal()
    try:
        rec = db.query(models.QARecord).filter(models.QARecord.conversation_id == conv).one()
        # 流程失敗寫在標題裡;這一題本身是「答出來了」(success=False 會被畫成可以重試的失敗提問)
        assert rec.owner == config.WORKFLOW_OWNER and rec.success is True and "失敗" in rec.question
        assert "客戶A每日同步" in rec.question and "boom" in rec.answer
        shared = {r.username for r in db.query(models.ConversationShare).filter(models.ConversationShare.conversation_id == conv)}
        assert {"wf_cons", "wf_eng"} <= shared
        assert any(m.conversation_id == conv for m in notes.pending_for(db, "wf_cons"))
        # 用量統計的基底查詢排除這一題
        assert stats._apply_range(db.query(models.QARecord), None, None).filter(models.QARecord.conversation_id == conv).count() == 0
        # 畫面上只看得到便條:成敗的原因要在便條本身 —— 哪一步、為什麼
        note = db.query(models.ConversationNote).filter(models.ConversationNote.conversation_id == conv).one()
        # 原因另起一行:哪一步、為什麼一行,最後一行輸出再一行
        body_lines = note.body.split("\n")
        assert body_lines[0].startswith("@wf_cons") and body_lines[0].endswith("失敗")
        assert body_lines[1].startswith("連線客戶:") and body_lines[2] == "boom"
    finally:
        db.close()
    # 對話頁拿到的那一題標成 Work Flow 的結果(前端不畫它),被 @ 的人也讀得到
    client = TestClient(app)
    items = client.get(f"/api/conversations/{conv}", headers=_h("wf_cons")).json()
    assert [i["is_workflow_result"] for i in items] == [True]
    # 側邊欄標題固定是流程名稱(不是第一次的「…成功 / 失敗」);搜尋不搜那一題(點進去看不到命中的字)
    listed = {c["conversation_id"]: c for c in client.get("/api/conversations", headers=_h("wf_cons")).json()}
    assert listed[conv]["title"] == "Work Flow「客戶A每日同步」"
    hits = client.get("/api/conversations/search", params={"q": "boom"}, headers=_h("wf_cons")).json()
    assert all(h.get("conversation_id") != conv for h in hits)
    # 有人在這組對話裡追問的那一題(owner 一樣是 Work Flow,送出的是真人):照畫、照搜
    with SessionLocal() as db:
        db.add(models.QARecord(session_id="follow-up", conversation_id=conv, question="boom 是什麼意思", answer="說明",
                               owner=config.WORKFLOW_OWNER, asked_by="wf_cons", status="done", success=True))
        db.commit()
    hits = client.get("/api/conversations/search", params={"q": "boom"}, headers=_h("wf_cons")).json()
    assert any(h.get("conversation_id") == conv for h in hits)
    items = client.get(f"/api/conversations/{conv}", headers=_h("wf_cons")).json()
    assert [i["is_workflow_result"] for i in items] == [True, False]
