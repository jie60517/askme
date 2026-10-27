# -*- coding: utf-8 -*-
"""Work Flow(側邊欄 SSH Server 底下那一列):拼圖目錄、圖的檢查、排程時間的計算。

這個模組**不跑任何東西**(那是 `workflow_engine.py`),也不碰資料庫 —— 全是純函式,測試直接呼叫。

**可選功能**:主機上有 `workflow_actions.json`(`config.WORKFLOW_ACTIONS_FILE`)才啟用。
沒有這個檔的話 `/api/workflows` 一律 404、排程器不啟動、側邊欄不顯示那一列(見 :func:`enabled`)。

最重要的一條:**瀏覽器永遠送不了指令。** 每種拼圖對應的指令寫在 `workflow_actions.json`
(不進版控),瀏覽器只能送「選了清單裡的哪一個」,加上自由文字的目錄,而目錄要先過
:func:`safe_path` 的白名單才會被 `shlex.quote` 套進模板。
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from . import config

logger = logging.getLogger(__name__)


class GraphError(ValueError):
    """圖或排程的內容不合法。訊息是給人看的中文,路由層直接回 422。"""


# ------------------------------------------------------------------ 主機上的設定檔
def _load_actions() -> dict:
    """讀 `workflow_actions.json`。檔案不在就是空的;壞掉也是空的(功能照樣開著,
    只是拼圖的選單都是空的 —— 執行前檢查會擋下來,不會跑到一半才發現)。"""
    try:
        raw = json.loads(config.WORKFLOW_ACTIONS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("workflow_actions.json 讀不出來,Work Flow 的選單會是空的:%s", exc)
        return {}
    return raw if isinstance(raw, dict) else {}


def _actions_file_present() -> bool:
    return config.WORKFLOW_ACTIONS_FILE.is_file()


#: 開機時有沒有 `workflow_actions.json`。**這就是 Work Flow 的開關**:要用就把範本複製過去、重啟服務。
#: 跟設定內容一樣只看一次(改了要重啟)。測試直接換掉這個值。
ENABLED: bool = _actions_file_present()
#: **只讀一次**(跟 terminal_hosts.json 一樣,改了要重啟服務)。測試直接換掉這個值。
ACTIONS: dict = _load_actions()


def available() -> bool:
    """Work Flow 現在能不能用:啟用了(`ENABLED`),而且 SSH 終端機有開(每一步都要經 SSH 跑)。
    開機起不起排程器、`/api/workflows` 擋不擋、`/api/me` 的 `workflow_enabled` 都問這一支 —— 側邊欄顯不顯示與端點擋不擋是同一個答案。"""
    return ENABLED and config.ssh_terminal_available()


def actions() -> dict:
    return ACTIONS


def _clients() -> dict[str, dict]:
    c = actions().get("clients") or {}
    return {str(k): v for k, v in c.items() if isinstance(v, dict)}


def client(name: str) -> Optional[dict]:
    return _clients().get(name)


def client_has(name: str, key: str) -> bool:
    """這個客戶在設定檔裡有沒有 `key` 這一步要用的東西。"""
    value = (client(name) or {}).get(key)
    # 同步模板少了 {delete} 就做不到「跟來源一模一樣」:當成沒有這一步的指令,
    # 拼圖上馬上冒黃色警告、執行前就擋,不要等撥完 VPN 才在同步那一步失敗
    if key == "sync" and value and "{delete}" not in str(value):
        return False
    return bool(value)


def base_host_id() -> str:
    """起點「主機」是終端機主機清單裡的哪一台。沒填就是清單第一台。"""
    return str(actions().get("base_host") or "") or config.default_terminal_host()["id"]


# ------------------------------------------------------------------ 拼圖種類
#
# **每種拼圖的定義只有這一張表**(`NODES`):名字、出口、有哪些欄位、預設逾時、哪一欄執行前必選。
# 設定檢查(`normalize_cfg`)、給瀏覽器的目錄(`catalog`)、執行前檢查(`run_problems`)
# 都讀它;前端的設定面板與新拼圖的預設值也是照 `/catalog` 送過去的這一份畫的 ——
# 加一種拼圖只要在這裡加一列,再到 `workflow_engine.HANDLERS` 寫它做什麼。

RETRY_CHOICES = (0, 1, 3)
BASE = "base"

#: 「執行腳本」:副檔名 → 用什麼跑。**只認這張表**:不在表上的副檔名不跑,拼圖上顯示「不支援」。
#: 指令是固定的字串,使用者只打路徑(過 `safe_path` 的白名單、再 shlex.quote),不是任意指令。
SCRIPT_RUNNERS: dict[str, str] = {
    # .sh 用 bash 跑:主機上的 sh 可能是 dash,寫 bash 語法的 .sh 會壞(bash 本來就跑得了 sh 語法)
    ".sh": "bash",
    ".bash": "bash",
    ".ksh": "ksh",
    ".zsh": "zsh",
    ".csh": "csh",
    ".py": "python3",
    ".pl": "perl",
    ".rb": "ruby",
    ".php": "php",
    ".js": "node",
    ".mjs": "node",
    ".cjs": "node",
    ".lua": "lua",
    ".tcl": "tclsh",
    ".r": "Rscript",
    ".awk": "awk -f",
    ".jar": "java -jar",
    # JDK 11 起可以直接跑單一檔的 .java
    ".java": "java",
    ".groovy": "groovy",
    ".ps1": "pwsh -NoProfile -File",
}


def script_runner(path: str) -> Optional[str]:
    """這支腳本要用什麼跑;副檔名不在 `SCRIPT_RUNNERS` 上(或沒有副檔名)回 None。"""
    name = (path or "").rsplit("/", 1)[-1]
    if "." not in name:
        return None
    return SCRIPT_RUNNERS.get("." + name.rsplit(".", 1)[-1].lower())


#: 客戶設定裡跟拼圖有關的鍵(`/catalog` 的 client_keys 只報這幾個有沒有,不給內容)
CLIENT_KEYS = ("vpn_up", "vpn_down", "host", "sync")


@dataclass(frozen=True)
class Field:
    """拼圖的一個設定欄位。`kind` 決定怎麼檢查,也決定前端畫哪一種輸入框。"""

    key: str
    label: str
    #: pick(選單)/ path(目錄)/ bool / int / people(要 @ 的人與群組)
    kind: str
    #: pick 的選項:回 `[{value, label}]` 的函式(內容來自主機上的設定檔,每次現算)
    options: Optional[Callable[[], list]] = None
    default: Any = ""
    lo: int = 0
    hi: int = 0


@dataclass(frozen=True)
class NodeSpec:
    label: str
    #: 出口。**順序就是出口編號**:0 永遠是「成功 / 完成」。
    outs: tuple
    fields: tuple = ()
    #: 會不會跑指令。會的才有「逾時」;`retry` 另外決定有沒有「失敗重試」。
    runs_command: bool = True
    retry: bool = True
    #: 新拖出來那一塊的預設逾時(分鐘)
    timeout: int = 1
    #: 執行前一定要填的那幾欄(存檔不擋,畫到一半的流程要能先存)
    required: tuple = ()
    #: 客戶沿用上游的「連線客戶」,自己不選。值是這一塊要用到客戶設定裡的哪一個鍵,
    #: 執行前檢查拿它確認設定檔裡真的有(空字串 = 不沿用)。
    client_key: str = ""
    #: 非空 = 只有上游的這種拼圖**連上了客戶主機**才沿用客戶(空的 = 一律沿用)。目前只有
    #: 「執行腳本」填 "vpn":前面有連著的客戶主機(`connected_to_client_host`)就在那台跑、
    #: 沒有就在主機跑。前端照 `/catalog` 送去的這一份判斷(只看有沒有值),不另寫。
    client_after: str = ""


def _options(pairs) -> list[dict]:
    return [{"value": v, "label": l} for v, l in pairs]


def _clients_with(key: str) -> list[str]:
    return [n for n in _clients() if client_has(n, key)]


def _opt_vpn() -> list[dict]:
    return _options((n, n) for n in _clients_with("vpn_up"))


# ------------------------------------------------------------------ 通知人員
#: 「通知人員」選得到的三個群組,**跟聊天的 @ 選單同一組**(`Chat.tsx` 的 mentionGroups):
#: 照職稱**字串相等**比(管理員的職稱是 Admin,前兩組都不該圈到他),ALL 是全部。
#: 存的是群組本身、**跑的時候才展開** —— 之後新增的同職稱帳號也收得到,停用的跳過。
#: 值用 `group:` 開頭:帳號名只能是英數 `_-`(見 ids.py),不會撞到。
#: 群組 → (畫面上的字, 圈哪個職稱;None = 全部)。兩邊各一份(一個 Python、一個 TS),
#: `test_people_groups_match_the_chat_mention_menu` 會讀前端原始碼對字。
PEOPLE_GROUPS: dict[str, tuple[str, Optional[str]]] = {
    "group:consultant": ("All Consultant", "Consultant"),
    "group:engineer": ("All Software Engineer", "Software engineer"),
    "group:all": ("ALL", None),
}
MAX_PEOPLE = 50


def _active_people() -> list[dict]:
    from . import users  # 延後 import:這個模組平常不碰資料庫(見檔頭)

    return users.list_active()


def _group_members(key: str, people: list[dict]) -> list[str]:
    _, role = PEOPLE_GROUPS[key]
    return [p["username"] for p in people if role is None or p.get("role") == role]


def _opt_people() -> list[dict]:
    """@ 選單的名單:人(含自己 —— 流程跑完要通知自己是正常的,跟聊天不同)+ 三個群組。"""
    people = _active_people()
    out = [
        {"value": p["username"], "label": p.get("display_name") or p["username"], "role": p.get("role") or ""}
        for p in people
    ]
    out += [
        {"value": k, "label": label, "group": True, "count": len(_group_members(k, people))}
        for k, (label, _) in PEOPLE_GROUPS.items()
    ]
    return out


def recipients(who: list) -> list[str]:
    """跑到「通知人員」時實際要通知誰:群組展開成人、停用或刪掉的帳號跳過,照選的順序、不重複。"""
    people = _active_people()
    active = {p["username"] for p in people}
    out: list[str] = []
    for w in who or []:
        names = _group_members(w, people) if w in PEOPLE_GROUPS else [w]
        for n in names:
            if n in active and n not in out:
                out.append(n)
    return out


def rename_person(graph: Any, old: str, new: str) -> bool:
    """圖裡所有 people 欄位(「通知人員」的 `who`…)把 `old` 換成 `new`,回傳有沒有換到。

    刪帳號時用:名單存的是帳號名,`recipients` 只跳過**現在**不存在的人 ——
    同名帳號重建之後會收到前任設定的通知(內容含執行輸出)。照 NODES 的欄位定義找,不寫死 `who`,
    之後多一種 people 欄位也會被換到。群組(`group:`)不是帳號名,不會撞到。
    """
    changed = False
    nodes = graph.get("nodes") if isinstance(graph, dict) else None
    for node in nodes if isinstance(nodes, list) else []:
        spec = NODES.get(str(node.get("type") or "")) if isinstance(node, dict) else None
        cfg = node.get("cfg") if spec is not None else None
        if not isinstance(cfg, dict):
            continue
        for f in spec.fields:
            value = cfg.get(f.key)
            if f.kind == "people" and isinstance(value, list) and old in value:
                cfg[f.key] = [new if w == old else w for w in value]
                changed = True
    return changed


NODES: dict[str, NodeSpec] = {
    "start": NodeSpec("主機", ("開始",), runs_command=False, retry=False),
    # 「連線客戶」= 跑設定檔裡的 vpn_up 撥 VPN,設定檔有寫 host 的話再連進客戶主機,一塊做完
    "vpn": NodeSpec("連線客戶", ("成功", "失敗"), (Field("client", "客戶", "pick", _opt_vpn),), required=("client",)),
    "vpnoff": NodeSpec("中斷連線", ("完成",), retry=False, client_key="vpn_down"),
    # 只有兩個目錄,使用者自己填。一律只傳有變動的、而且**刪掉目的目錄裡來源沒有的檔案**
    # (跟來源一模一樣)—— 所以目的目錄至少要三層(SYNC_DST_MIN_DEPTH)
    "sync": NodeSpec(
        "同步程式", ("成功", "失敗"),
        (Field("src", "來源目錄", "path"), Field("dst", "目的目錄", "path")),
        timeout=30, client_key="sync", required=("src", "dst"),
    ),
    # 腳本 = 主機上的檔案路徑(含檔名),用什麼跑看副檔名(SCRIPT_RUNNERS)。
    # 在哪一台跑不用選:上游有連著的客戶主機就在那台,沒有就在主機(見 `needs_client`)
    "script": NodeSpec(
        "執行腳本", ("成功", "失敗"),
        (Field("script", "腳本", "path"),),
        timeout=10, required=("script",), client_key="host", client_after="vpn",
    ),
    "wait": NodeSpec(
        "等待", ("完成",), (Field("sec", "秒數", "int", default=30, lo=1, hi=3600),), runs_command=False, retry=False,
    ),
    # 跟聊天被 @ 一樣是站內通知。不跑指令,所以沒有逾時與重試。
    # 內容一律是完整的結果(失敗的步驟附最後幾行輸出)
    "notify": NodeSpec(
        "通知人員", ("完成",),
        (Field("who", "通知", "people", _opt_people, []),),
        runs_command=False, retry=False, required=("who",),
    ),
}
LABELS = {t: s.label for t, s in NODES.items()}
OUTS = {t: list(s.outs) for t, s in NODES.items()}
#: 執行前必填的欄位:種類 → 那幾欄的 key。
REQUIRED = {t: s.required for t, s in NODES.items() if s.required}


def catalog() -> dict:
    """給瀏覽器的拼圖目錄:每種拼圖的欄位與**選項名稱**。

    ⚠️ **指令一個字都不能出去**(有測試掃回應)。瀏覽器要知道的只有
    「可以選哪些」,「選了之後跑什麼」永遠是伺服器這邊的事。
    """
    clients = _clients()
    nodes = {}
    for t, s in NODES.items():
        fields = []
        for f in s.fields:
            d: dict = {"key": f.key, "label": f.label, "kind": f.kind, "default": f.default}
            if f.options:
                d["options"] = f.options()
            if f.kind == "int":
                d["min"], d["max"] = f.lo, f.hi
            fields.append(d)
        nodes[t] = {
            "label": s.label,
            "outs": list(s.outs),
            "fields": fields,
            "runs_command": s.runs_command,
            "retry": s.retry,
            "timeout": s.timeout,
            "required": list(s.required),
            "inherits_client": bool(s.client_key),
            "client_key": s.client_key,
            "client_after": s.client_after or None,
        }
    return {
        "base": {"label": LABELS["start"], "sub": _base_sub()},
        "nodes": nodes,
        # 每個客戶在設定檔裡**有哪幾個鍵**(只有鍵名,沒有指令)。前端拿它在按執行之前就畫出
        # 「客戶在設定檔裡少了這一步的指令」的黃框,跟後端 `run_problems` 同一套判斷
        "client_keys": {n: sorted(k for k in CLIENT_KEYS if client_has(n, k)) for n in clients},
        # 「執行腳本」認得的副檔名(前端拿它在按執行之前就畫出「不支援」)
        "script_types": sorted(SCRIPT_RUNNERS),
        # 排程的「下次執行」要照這個時區算,不能照瀏覽器的
        "utc_offset_min": config.WORKFLOW_UTC_OFFSET_MIN,
    }


def _base_sub() -> str:
    host = config.find_terminal_host(base_host_id())
    if not host:
        return ""
    return host["sub"] or config.terminal_host_label(host)


# ------------------------------------------------------------------ 自由文字的白名單
#: 目錄:絕對路徑或 `~/`,只收英數與 `._-/`。**空白、引號、`$`、`;`、萬用字元一律不收** ——
#: 就算後面有 shlex.quote,少一種字元就少一種要去想「會不會被哪一層再解讀一次」
#: (rsync 的遠端路徑會被遠端 shell 再展開一次,quote 只擋得住這一層)。
_PATH_RE = re.compile(r"^(~(/|$)|/)[A-Za-z0-9._/\-]*$")
MAX_PATH = 300


def safe_path(value: str, field: str) -> str:
    value = (value or "").strip().rstrip("/") or value.strip()
    if not value:
        return ""
    if len(value) > MAX_PATH or not _PATH_RE.match(value) or ".." in value.split("/"):
        raise GraphError(f"「{field}」只能是 / 開頭的路徑,而且只能有英數字與 . _ - /")
    return value


#: 同步的目的目錄至少幾層(`~` 算兩層,就是 /home/<帳號>)。同步會刪掉目的目錄裡來源沒有的檔案,
#: 填成 `/home/<帳號>` 這種淺的目錄,家目錄裡其他東西會整片被刪 —— 至少要再往下一層。
SYNC_DST_MIN_DEPTH = 3


def sync_dst_too_shallow(dst: str) -> bool:
    # `.` 不算一層:`/home/demo/.`、`~/.` 指的就是家目錄本身
    parts = [p for p in dst.split("/") if p not in ("", ".")]
    depth = len(parts) + 1 if parts and parts[0] == "~" else len(parts)
    return depth < SYNC_DST_MIN_DEPTH


def sync_dst_error() -> str:
    label = next(f.label for f in NODES["sync"].fields if f.key == "dst")
    return f"「{label}」至少要{SYNC_DST_MIN_DEPTH}層(例如 /srv/sync/xxx):同步會刪掉這個目錄裡來源沒有的檔案"


# ------------------------------------------------------------------ 圖
MAX_NODES = 120
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _num(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return max(lo, min(hi, f))


def _pick(value: Any, allowed: list[str], field: str) -> str:
    """選單的值:空字串(還沒選,草稿可以存)或清單裡的其中一個。"""
    v = str(value or "")
    if v and v not in allowed:
        raise GraphError(f"「{field}」的選項 {v!r} 不在清單裡,請重新整理後再選一次")
    return v


def normalize_cfg(ntype: str, cfg: Any) -> dict:
    """一塊拼圖的設定:只留 `NODES` 列的欄位,選單值要在清單裡,數字夾在範圍內。"""
    cfg = cfg if isinstance(cfg, dict) else {}
    spec = NODES[ntype]
    out: dict = {}
    if spec.runs_command:
        out["timeout"] = int(_num(cfg.get("timeout"), 1, 1440, spec.timeout))
    if spec.retry:
        out["retry"] = int(cfg["retry"]) if str(cfg.get("retry")) in {str(r) for r in RETRY_CHOICES} else 0
    for f in spec.fields:
        raw = cfg.get(f.key)
        if f.kind == "pick":
            out[f.key] = _pick(raw if raw not in (None, "") else f.default, [o["value"] for o in f.options()], f.label)
        elif f.kind == "path":
            out[f.key] = safe_path(str(raw or ""), f.label)
            if ntype == "sync" and f.key == "dst" and out[f.key] and sync_dst_too_shallow(out[f.key]):
                raise GraphError(sync_dst_error())
        elif f.kind == "bool":
            out[f.key] = bool(raw)
        elif f.kind == "int":
            out[f.key] = int(_num(raw, f.lo, f.hi, f.default))
        elif f.kind == "people":
            out[f.key] = _people(raw, {o["value"] for o in f.options()})
    return out


def _people(raw: Any, allowed: set) -> list[str]:
    """要 @ 的名單:只留現在選得到的人與群組(停用、刪掉的帳號**存檔時就拿掉**,不報錯 ——
    流程裡掛著一個登不進來的人沒有意義,而為了這個擋存檔只會讓人卡住),不重複。"""
    out: list[str] = []
    for w in raw if isinstance(raw, list) else []:
        w = str(w)
        if w in allowed and w not in out:
            out.append(w)
    if len(out) > MAX_PEOPLE:
        raise GraphError(f"「通知」最多選 {MAX_PEOPLE} 個")
    return out


def normalize_graph(raw: Any) -> dict:
    """瀏覽器送來的圖 → 存進資料庫的圖。不合法就 raise :class:`GraphError`。

    起點那一塊(`start`)**永遠在**:送來的圖沒有就補上,送了兩塊就拒絕。
    """
    if not isinstance(raw, dict):
        raise GraphError("流程的格式不對")
    nodes_in = raw.get("nodes") or []
    edges_in = raw.get("edges") or []
    if not isinstance(nodes_in, list) or not isinstance(edges_in, list):
        raise GraphError("流程的格式不對")
    if len(nodes_in) > MAX_NODES:
        raise GraphError(f"一個流程最多 {MAX_NODES} 塊")

    nodes: list[dict] = []
    seen: set[str] = set()
    for n in nodes_in:
        if not isinstance(n, dict):
            raise GraphError("流程的格式不對")
        nid, ntype = str(n.get("id") or ""), str(n.get("type") or "")
        if not _ID_RE.match(nid) or nid in seen:
            raise GraphError("拼圖的編號重複或不合法")
        if ntype not in OUTS:
            raise GraphError(f"不認得的拼圖種類 {ntype!r}")
        if (nid == "start") != (ntype == "start"):
            raise GraphError("起點只能有一個")
        seen.add(nid)
        node = {
            "id": nid,
            "type": ntype,
            "x": round(_num(n.get("x"), -20000, 20000, 0)),
            "y": round(_num(n.get("y"), -20000, 20000, 0)),
        }
        if ntype != "start":
            node["cfg"] = normalize_cfg(ntype, n.get("cfg"))
        nodes.append(node)
    if "start" not in seen:
        nodes.insert(0, {"id": "start", "type": "start", "x": 0, "y": 120})

    types = {n["id"]: n["type"] for n in nodes}
    edges: list[dict] = []
    used: set[tuple[str, int]] = set()
    for e in edges_in:
        if not isinstance(e, dict):
            raise GraphError("連線的格式不對")
        src, dst = str(e.get("from") or ""), str(e.get("to") or "")
        try:
            out = int(e.get("out"))
        except (TypeError, ValueError):
            raise GraphError("連線的格式不對") from None
        if src not in types or dst not in types:
            raise GraphError("連線接到不存在的拼圖")
        if dst == "start" or src == dst:
            raise GraphError("起點不能被接進去,拼圖也不能接自己")
        if not 0 <= out < len(OUTS[types[src]]):
            raise GraphError("連線的出口不對")
        if (src, out) in used:
            raise GraphError("同一個出口只能接一條線")
        used.add((src, out))
        edges.append({"from": src, "out": out, "to": dst})
    return {"nodes": nodes, "edges": edges}


#: 清單頁那一行摘要最多列幾塊(再長就看不完了)
MAIN_PATH_MAX = 6


def main_path(graph: dict) -> list[str]:
    """清單頁那一行摘要:從起點沿著「成功 / 完成」(出口 0)一路走下去的拼圖名稱。"""
    types = {n["id"]: n["type"] for n in graph.get("nodes") or []}
    nexts = {e["from"]: e["to"] for e in graph.get("edges") or [] if e.get("out") == 0}
    out, seen, cur = [], {"start"}, "start"
    while cur in nexts and nexts[cur] not in seen and len(out) < MAIN_PATH_MAX:
        cur = nexts[cur]
        seen.add(cur)
        out.append(LABELS.get(types.get(cur, ""), ""))
    return [x for x in out if x]


def reachable(graph: dict) -> set[str]:
    seen, queue = {"start"}, ["start"]
    while queue:
        cur = queue.pop()
        for e in graph["edges"]:
            if e["from"] == cur and e["to"] not in seen:
                seen.add(e["to"])
                queue.append(e["to"])
    return seen


def _has_cycle(graph: dict) -> bool:
    nexts: dict[str, list[str]] = {}
    for e in graph["edges"]:
        nexts.setdefault(e["from"], []).append(e["to"])
    state: dict[str, int] = {}

    def visit(nid: str) -> bool:
        state[nid] = 1
        for m in nexts.get(nid, []):
            if state.get(m) == 1 or (state.get(m) is None and visit(m)):
                return True
        state[nid] = 2
        return False

    return visit("start")


def connected_to_client_host(graph: dict, node_id: str) -> bool:
    """這一塊跑到的時候,客戶主機是不是連著的:沿著線往回走,找得到「連線客戶」的**成功**出口。

    走到這幾種就停(再往上的不算數):
    - 「中斷連線」:都斷了,主機一定連不到;
    - 「連線客戶」的**失敗**出口:沒連上。

    ⚠️ 「連線客戶」只有在那個客戶**設定檔裡有主機**(`host`)時才算連上主機 —— 沒寫主機的客戶,
    這一塊就只撥 VPN(`_do_vpn`),後面的腳本照舊在主機跑。
    """
    nodes = {n["id"]: n for n in graph["nodes"]}
    seen: set[str] = set()
    stack = [node_id]
    while stack:
        cur = stack.pop()
        for e in graph["edges"]:
            if e["to"] != cur or e["from"] in seen:
                continue
            seen.add(e["from"])
            up = nodes.get(e["from"]) or {}
            t = up.get("type")
            if t == "vpn" and client_has(str((up.get("cfg") or {}).get("client") or ""), "host"):
                if e["out"] == 0:
                    return True
                continue
            if t in ("vpn", "vpnoff"):
                continue
            stack.append(e["from"])
    return False


def needs_client(graph: dict, node: dict) -> bool:
    """這一塊要不要沿用上游「連線客戶」的客戶(`NodeSpec.client_key` / `client_after`)。"""
    spec = NODES.get(node["type"])
    if not spec or not spec.client_key:
        return False
    if spec.client_after:
        return connected_to_client_host(graph, node["id"])
    return True


def client_of(graph: dict, node_id: str) -> list[str]:
    """沿著線往回找,這一塊的客戶來自哪幾個「連線客戶」。碰到「連線客戶」就停,不再往上。

    回傳**排序過、不重複**的客戶名;剛好一個才是能跑的狀態。上游那塊還沒選客戶的話
    回傳裡會有一個空字串(那一塊自己已經會被算進「還沒設定」,這裡不要再罵一次)。
    """
    types = {n["id"]: n for n in graph["nodes"]}
    found: set[str] = set()
    seen: set[str] = set()
    stack = [node_id]
    while stack:
        cur = stack.pop()
        for e in graph["edges"]:
            if e["to"] != cur or e["from"] in seen:
                continue
            seen.add(e["from"])
            up = types.get(e["from"])
            if up is None:
                continue
            if up["type"] == "vpn":
                found.add(str((up.get("cfg") or {}).get("client") or ""))
            else:
                stack.append(up["id"])
    return sorted(found)


#: 客戶問題的兩種(`client_issue` 的第一個值):沒有客戶 / 客戶的設定檔少了這一步的指令。
#: 執行前檢查照種類分成兩句,**不要改成比對句子開頭** —— 改個措辭就分錯邊。
NO_CLIENT = "no_client"
CLIENT_CONFIG = "config"


def client_issue(graph: dict, node: dict) -> Optional[tuple[str, str]]:
    """這一塊在客戶這件事上的問題:(種類, 拼圖上黃框那句話);沒有問題回 None。前端同一套規則與句子。"""
    if not needs_client(graph, node):
        return None
    names = client_of(graph, node["id"])
    real = [n for n in names if n]
    if len(real) > 1:
        return NO_CLIENT, "接到兩個客戶"
    if not real:
        return None if "" in names else (NO_CLIENT, "前面沒有連線客戶")
    key = NODES[node["type"]].client_key
    if not client_has(real[0], key):
        if key == "sync" and (client(real[0]) or {}).get("sync"):
            # 有同步指令、只是少了 {delete}:講清楚少什麼,管理員才知道要補哪裡
            return CLIENT_CONFIG, f"設定檔裡「{real[0]}」的同步指令沒有 {{delete}}"
        return CLIENT_CONFIG, f"設定檔裡「{real[0]}」沒有這一步要用的指令"
    return None


def run_problems(graph: dict) -> list[str]:
    """執行前檢查。回空串列 = 可以跑;否則每一條是一句中文。

    **存檔不擋**,只擋執行:畫到一半的流程要能先存起來。
    """
    problems: list[str] = []
    if len(graph["nodes"]) < 2:
        problems.append("流程裡還沒有任何拼圖")
    reach = reachable(graph)
    orphan = [n for n in graph["nodes"] if n["id"] not in reach]
    if orphan:
        problems.append(f"{len(orphan)} 塊沒接上{LABELS['start']}")
    empty = [n for n in graph["nodes"] if any(not n["cfg"].get(k) for k in REQUIRED.get(n["type"], ()))]
    bad_script = [n for n in graph["nodes"] if n["type"] == "script" and n["cfg"].get("script") and not script_runner(n["cfg"]["script"])]
    if empty:
        problems.append(f"{len(empty)} 塊還沒設定")
    if bad_script:
        problems.append(f"{len(bad_script)} 塊的腳本類型不支援")
    kinds = [i[0] for i in (client_issue(graph, n) for n in graph["nodes"]) if i]
    if kinds.count(NO_CLIENT):
        problems.append(f"{kinds.count(NO_CLIENT)} 塊沒有客戶")
    if kinds.count(CLIENT_CONFIG):
        problems.append(f"{kinds.count(CLIENT_CONFIG)} 塊的客戶在設定檔裡少了這一步的指令")
    if _has_cycle(graph):
        problems.append("流程裡有繞回頭的線(會一直跑不停)")
    return problems


# ------------------------------------------------------------------ 排程
FREQS = ("daily", "weekly", "hourly", "once")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def normalize_schedule(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    freq = raw.get("freq") if raw.get("freq") in FREQS else "daily"
    time_s = str(raw.get("time") or "02:00")
    if not _TIME_RE.match(time_s):
        raise GraphError("排程時間的格式不對")
    days = sorted({int(d) for d in (raw.get("days") or []) if str(d).isdigit() and 0 <= int(d) <= 6})
    date_s = str(raw.get("date") or "")
    if date_s:
        if not _DATE_RE.match(date_s):
            raise GraphError("排程日期的格式不對")
        try:
            datetime.strptime(date_s, "%Y-%m-%d")
        except ValueError:
            raise GraphError("排程日期的格式不對") from None
    on = bool(raw.get("on"))
    if on and freq == "weekly" and not days:
        raise GraphError("每週排程至少要選一天")
    if on and freq == "once" and not date_s:
        raise GraphError("只跑一次的排程要選日期")
    return {
        "on": on,
        "freq": freq,
        "time": time_s,
        "days": days or [1, 2, 3, 4, 5],
        "date": date_s,
        "overlap": "queue" if raw.get("overlap") == "queue" else "skip",
        # 誰設的這個排程。排程觸發的執行記在他名下(稽核要追得到),**不是**最後存檔的人 ——
        # 只挪了一塊拼圖的人不該變成「半夜兩點跑同步的人」。由路由層填,見 `schedule_owner`。
        "by": str(raw.get("by") or "")[:80],
    }


def schedule_owner(new: dict, old: Optional[dict], viewer: str) -> dict:
    """存檔時決定排程記在誰名下:排程內容(除了 by 之外)有變 → 改成這次存檔的人,沒變 → 沿用。"""
    strip = lambda s: {k: v for k, v in (s or {}).items() if k != "by"}  # noqa: E731
    if old and strip(old) == strip(new) and old.get("by"):
        return {**new, "by": old["by"]}
    return {**new, "by": viewer}


def local_now() -> datetime:
    """排程用的「現在」,當地時間(naive)。用固定位移(見 config.WORKFLOW_UTC_OFFSET_MIN)。"""
    return datetime.utcnow() + timedelta(minutes=config.WORKFLOW_UTC_OFFSET_MIN)


def to_utc(local: datetime) -> datetime:
    return local - timedelta(minutes=config.WORKFLOW_UTC_OFFSET_MIN)


def next_run(schedule: dict, after_local: datetime) -> Optional[datetime]:
    """`after_local` **之後**(不含)的下一次執行時間,當地時間。沒有下一次回 None。

    星期用 JS 的編號(0 = 星期日),跟前端同一套 —— Python 的 `weekday()` 是 0 = 星期一,
    兩邊各用自己的會差一天,而且只有在每週排程才看得出來。
    """
    if not schedule.get("on"):
        return None
    hh, mm = (int(x) for x in schedule["time"].split(":"))
    freq = schedule["freq"]
    base = after_local.replace(second=0, microsecond=0)
    if freq == "hourly":
        cand = base.replace(minute=mm)
        if cand <= after_local:
            cand += timedelta(hours=1)
        return cand
    if freq == "once":
        cand = datetime.strptime(f"{schedule['date']} {schedule['time']}", "%Y-%m-%d %H:%M")
        return cand if cand > after_local else None
    for i in range(0, 8):
        cand = (base + timedelta(days=i)).replace(hour=hh, minute=mm)
        if cand <= after_local:
            continue
        if freq == "weekly" and (cand.weekday() + 1) % 7 not in schedule["days"]:
            continue
        return cand
    return None

