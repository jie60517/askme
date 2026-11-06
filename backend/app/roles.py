"""角色與權限。

角色可以自己新增,每個角色勾選能用哪些功能。三件事收在這裡,別的地方一律問這裡,不要自己讀 `users.role` 或 `roles.perms`:

1. **權限目錄**寫死在程式裡 —— 每一項背後都有一段真的擋人的程式(見各 `auth.*` 關卡),
   畫面不能憑空新增。每一項都是開或關;Work Flow 掛在 SSH Server 底下(上層沒勾,底下就一定沒有,見 `_pin`)。
2. **角色**存資料庫(`models.Role`)。`users.role` 存角色的 id;兩個種子角色的 id 沿用舊職稱字串。
3. **實際權限 = 角色的值,再套上這個人的個人加減**(`users.perm_overrides`,只存跟角色不同的那幾項)。

⚠️ **管理員不在這裡**:他不在 users 表、不是角色,`auth.has_perm` 對他一律回 True。
這個模組只管 users 表裡的帳號。
"""

from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime
from typing import Any, Optional

from . import models
from .database import SessionLocal

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ 權限目錄

#: 開或關的那幾項,**順序就是畫面上的順序**:
#:   ssh       SSH Server(終端機、檔案欄、AskME)
#:   workflow  Work Flow(會經 SSH 在主機上跑指令 → 要有 ssh)
#:   usage     Usage(用量統計、題目明細)
#:   security  Security(登入鎖定、稽核紀錄、境外白名單)
#:   users     Users(帳號管理 + 角色分頁;有防升權限制)
#:   ai_exec   AI 可執行指令(Bash、寫入)
FLAGS = (
    "ssh",
    "workflow",
    "usage",
    "security",
    "users",
    "ai_exec",
)
PERM_KEYS = FLAGS
#: SSH Server 底下那幾項(沒有 ssh 就一定沒有,`_pin`)
SSH_CHILDREN = ("workflow",)

NONE: dict[str, Any] = {k: False for k in FLAGS}
ALL: dict[str, Any] = {k: True for k in FLAGS}

#: 稽核與錯誤訊息用的名字(跟前端畫面上的字同一組)
LABELS = {
    "ssh": "SSH Server",
    "workflow": "Work Flow",
    "usage": "Usage",
    "security": "Security",
    "users": "Users",
    "ai_exec": "AI 可執行指令",
}

# ------------------------------------------------------------------ 種子角色

ROLE_CONSULTANT = "Consultant"
ROLE_ENGINEER = "Software engineer"
#: 新帳號、沒設過角色、角色對不上的帳號都算它。**它不能刪**。
DEFAULT_ROLE = ROLE_CONSULTANT

SEEDS: dict[str, dict[str, Any]] = {
    ROLE_ENGINEER: {**NONE, "ssh": True, "workflow": True, "ai_exec": True},
    ROLE_CONSULTANT: dict(NONE),
}
#: 種子的建立順序 = 角色分頁的順序
_SEED_ORDER = (ROLE_CONSULTANT, ROLE_ENGINEER)

MAX_NAME = 40
#: 管理員的職稱(`users.ADMIN_ROLE`),角色不能叫這個名字,不然 @ 選單分不出誰是管理員
RESERVED_NAMES = {"admin"}


class RoleError(ValueError):
    """角色的新增 / 修改 / 刪除不成立(名字重複、還有人在用…)。訊息直接給畫面看。"""


# ------------------------------------------------------------------ 純函式


def _load(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return obj if isinstance(obj, dict) else {}


def clean_perms(raw: Any) -> dict:
    """任何來源(資料庫的 JSON、前端送來的 dict)→ 一份完整、乾淨的權限。

    認不得的鍵丟掉;缺的鍵當「沒有」;開關**只有 True 才算開**(字串 "true"、1 都不算 —— 往安全的那邊倒)。
    """
    obj = _load(raw)
    return _pin({k: obj.get(k) is True for k in FLAGS})


def _pin(perms: dict) -> dict:
    """上層沒勾,底下就一定沒有(Work Flow 會在主機上跑指令,沒有 SSH 不能給)。"""
    if not perms.get("ssh"):
        for k in SSH_CHILDREN:
            perms[k] = False
    return perms


def clean_overrides(raw: Any) -> dict:
    """個人加減:只留認得的鍵、合法的值。**不補缺的鍵**(缺 = 跟角色一樣)。"""
    obj = _load(raw)
    return {k: obj[k] for k in FLAGS if isinstance(obj.get(k), bool)}


def apply(role_perms: dict, overrides: dict) -> dict:
    """角色的值套上個人加減 → 這個人實際的權限。"""
    return _pin({**clean_perms(role_perms), **clean_overrides(overrides)})


def diff(base: dict, value: dict) -> dict:
    """value 跟 base(角色的值)不同的那幾項 —— 就是要存進 `perm_overrides` 的東西。"""
    b, v = clean_perms(base), clean_perms(value)
    return {k: v[k] for k in PERM_KEYS if v[k] != b[k]}


def covers(have: dict, want: dict) -> bool:
    """`have` 是不是包含 `want` 的每一項(只能給出自己有的權限)。"""
    h, w = clean_perms(have), clean_perms(want)
    return all(h[k] or not w[k] for k in FLAGS)


def describe(perms: dict) -> str:
    """稽核用的一行摘要:「Usage、AI 可執行指令」;什麼都沒有寫「無」。"""
    p = clean_perms(perms)
    return "、".join(LABELS[k] for k in FLAGS if p[k]) or "無"


def describe_changes(before: dict, after: dict) -> str:
    """稽核用:「+ Usage、− AI 可執行指令」。"""
    b, a = clean_perms(before), clean_perms(after)
    parts = [f"{'+' if a[k] else '−'} {LABELS[k]}" for k in FLAGS if b[k] != a[k]]
    return "、".join(parts) or "沒有變更"


# ------------------------------------------------------------------ 讀


def _role_of(db, role_id: Optional[str]) -> tuple[str, dict]:
    """帳號上存的角色 id → (實際算哪個角色, 它的權限)。空的、對不上的都退回預設角色。

    角色表還沒建種子(全新資料庫開機前、測試)時照 `SEEDS` 算 —— 結果跟建好之後一模一樣。
    """
    row = db.get(models.Role, role_id) if role_id else None
    if row is not None:
        return row.id, clean_perms(row.perms)
    default = db.get(models.Role, DEFAULT_ROLE)
    if default is not None:
        return default.id, clean_perms(default.perms)
    if role_id in SEEDS and not db.query(models.Role.id).first():
        return role_id, dict(SEEDS[role_id])
    return DEFAULT_ROLE, dict(SEEDS[DEFAULT_ROLE])


def _own(u: "models.User") -> dict:
    """這個帳號的個人加減。

    沒存過(NULL)= 跟角色一樣。
    """
    return clean_overrides(u.perm_overrides) if u.perm_overrides is not None else {}

def resolve_role_id(role_id: Optional[str]) -> str:
    """帳號實際算哪個角色(空的、對不上的 → 預設角色)。"""
    db = SessionLocal()
    try:
        return _role_of(db, role_id)[0]
    finally:
        db.close()


def role_perms(role_id: Optional[str]) -> dict:
    """角色的權限(空的、對不上的 → 預設角色)。"""
    db = SessionLocal()
    try:
        return _role_of(db, role_id)[1]
    finally:
        db.close()


def user_perms(username: Optional[str]) -> dict:
    """**這個帳號實際的權限**(角色 + 個人加減)。不存在、停用的帳號 = 什麼都沒有。

    每次都查資料庫、不快取:管理員改了角色,下一個請求就生效。
    """
    if not username:
        return dict(NONE)
    from sqlalchemy import func

    db = SessionLocal()
    try:
        u = db.get(models.User, username)
        if u is None:
            # 跟 users.get 一樣不分大小寫(登入身分已經正規化過,但這支也會拿到別處來的字串)
            u = (
                db.query(models.User)
                .filter(func.lower(models.User.username) == username.strip().lower())
                .order_by(models.User.username)
                .first()
            )
        if u is None or u.disabled:
            return dict(NONE)
        return apply(_role_of(db, u.role)[1], _own(u))
    finally:
        db.close()


def user_access(u: "models.User", db) -> dict:
    """帳號管理頁那一列要的東西:實際算哪個角色、個人加減、實際權限(停用的照算,畫面上要看得到他原本有什麼)。"""
    rid, base = _role_of(db, u.role)
    own = diff(base, apply(base, _own(u)))
    return {"role": rid, "own": own, "perms": apply(base, own)}


def _sorted_roles(db) -> list:
    """角色表照畫面上的順序:種子角色在前(預設角色第一),其他照建立時間。@ 選單、角色分頁都用這個順序。"""
    rows = db.query(models.Role).all()
    order = {rid: i for i, rid in enumerate(_SEED_ORDER)}
    rows.sort(key=lambda r: (order.get(r.id, len(order)), r.created_at or datetime.min, r.name))
    return rows


def list_roles() -> list[dict]:
    """角色分頁的清單:id / name / perms / is_default / member_count / flow_refs,照 `_sorted_roles` 的順序。

    `member_count` 連停用的帳號也算(停用的人還掛著這個角色,刪掉的話他重新啟用就對不上了)。
    `flow_refs` = 通知名單用到「All <角色>」的 Work Flow 數 —— 有就不能刪,畫面上的刪除也要灰。
    """
    from . import workflows  # 延後 import:workflows 也會反過來用這個模組

    # 開機時就建了(main.py);這裡再確認一次是給沒走開機流程的路(測試、腳本)—— 表有東西就只是一次查詢
    ensure_seeded()
    db = SessionLocal()
    try:
        rows = _sorted_roles(db)
        counts = _member_counts(db)
    finally:
        db.close()
    return [
        {
            "id": r.id,
            "name": r.name,
            "perms": clean_perms(r.perms),
            "is_default": r.id == DEFAULT_ROLE,
            "member_count": counts.get(r.id, 0),
            "flow_refs": len(workflows.flows_using_role(r.id)),
        }
        for r in rows
    ]


def role_ranks() -> dict[str, tuple[str, int]]:
    """id → (畫面上的名字, 第幾個)。給 @ 名單把 `users.role` 翻成字、排群組順序用(一次查詢)。"""
    db = SessionLocal()
    try:
        return {r.id: (r.name, i) for i, r in enumerate(_sorted_roles(db))}
    finally:
        db.close()


def role_names() -> dict[str, str]:
    """id → 畫面上的名字。給 @ 選單、帳號清單把 `users.role` 翻成字用。"""
    db = SessionLocal()
    try:
        return {r.id: r.name for r in db.query(models.Role.id, models.Role.name).all()}
    finally:
        db.close()


def get_role(role_id: str) -> Optional[dict]:
    return next((r for r in list_roles() if r["id"] == role_id), None)


def _members_by_role(db) -> dict[str, list[str]]:
    """角色 id → 掛著它的帳號(含停用的)。空的、對不上的 `users.role` 算預設角色。"""
    ids = {r.id for r in db.query(models.Role.id).all()}
    out: dict[str, list[str]] = {}
    for name, role in db.query(models.User.username, models.User.role).order_by(models.User.username).all():
        out.setdefault(role if role in ids else DEFAULT_ROLE, []).append(name)
    return out


def _member_counts(db) -> dict[str, int]:
    return {rid: len(names) for rid, names in _members_by_role(db).items()}


# ------------------------------------------------------------------ 寫


def _check_name(db, name: str, exclude_id: Optional[str] = None) -> str:
    name = (name or "").strip()
    if not name:
        raise RoleError("請填角色名稱")
    if len(name) > MAX_NAME:
        raise RoleError(f"角色名稱最多 {MAX_NAME} 個字")
    if name.lower() in RESERVED_NAMES:
        raise RoleError(f"「{name}」是管理員的職稱,換一個名字")
    for rid, other in db.query(models.Role.id, models.Role.name).all():
        if rid != exclude_id and other.strip().lower() == name.lower():
            raise RoleError(f"已經有叫「{other}」的角色")
    return name


def create_role(name: str, perms: Any, created_by: Optional[str] = None) -> dict:
    db = SessionLocal()
    try:
        clean = _check_name(db, name)
        rid = "r_" + secrets.token_hex(4)
        while db.get(models.Role, rid) is not None:
            rid = "r_" + secrets.token_hex(4)
        db.add(
            models.Role(id=rid, name=clean, perms=json.dumps(clean_perms(perms)), created_by=created_by)
        )
        db.commit()
    finally:
        db.close()
    return get_role(rid)  # type: ignore[return-value]


def update_role(role_id: str, name: Optional[str] = None, perms: Any = None) -> dict:
    """改名或改權限(帶 None 的不動)。回改之前的那一份,呼叫端拿去寫稽核。"""
    db = SessionLocal()
    try:
        row = db.get(models.Role, role_id)
        if row is None:
            raise RoleError("找不到這個角色")
        before = {"name": row.name, "perms": clean_perms(row.perms)}
        if name is not None:
            row.name = _check_name(db, name, exclude_id=role_id)
        if perms is not None:
            row.perms = json.dumps(clean_perms(perms))
        db.commit()
        return before
    finally:
        db.close()


def delete_roles(role_ids: list[str]) -> list[str]:
    """刪一個或好幾個角色。回被刪的名字。

    擋三種:預設角色、還有帳號掛著(停用的也算)、有 Work Flow 的通知名單用到「All <角色>」。
    **一個刪不掉就全部不刪**:檢查與刪除在同一個交易裡,原因一次講完(角色分頁的「刪除 N 個角色」)。
    """
    from . import workflows  # 延後 import:workflows 也會反過來用這個模組

    db = SessionLocal()
    try:
        members = _members_by_role(db)
        rows, problems = [], []
        for rid in dict.fromkeys(role_ids):
            row = db.get(models.Role, rid)
            if row is None:
                raise RoleError("找不到這個角色")
            who = members.get(rid, [])
            refs = workflows.flows_using_role(rid)
            if rid == DEFAULT_ROLE:
                problems.append(f"「{row.name}」是預設角色")
            elif who:
                problems.append(f"「{row.name}」還有 {len(who)} 個帳號在用({'、'.join(who[:5])}{'…' if len(who) > 5 else ''})")
            elif refs:
                problems.append(f"Work Flow「{'、'.join(refs[:5])}」的通知名單用到 All {row.name}")
            rows.append(row)
        if problems:
            raise RoleError(";".join(problems))
        names = [r.name for r in rows]
        for row in rows:
            db.delete(row)
        db.commit()
        return names
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def access_of(username: str) -> Optional[dict]:
    """{role, own, perms}(見 `user_access`);帳號不存在回 None。"""
    db = SessionLocal()
    try:
        u = db.get(models.User, username)
        return user_access(u, db) if u is not None else None
    finally:
        db.close()


def set_user_access(username: str, role_id: Optional[str] = None, value: Any = None) -> dict:
    """改某人的角色與(或)實際權限。

    `role_id` None = 角色不動;`value` 是畫面上那份**完整**的清單,None = 個人加減照留(換角色時)。
    這裡只存跟角色不同的那幾項;存過一次之後就不再看舊的兩個勾選(見 `_own`)。
    回 {"before": {role, own, perms}, "after": {role, own, perms}},給稽核用。
    """
    db = SessionLocal()
    try:
        u = db.get(models.User, username)
        if u is None:
            raise RoleError("找不到這個帳號")
        before = user_access(u, db)
        if role_id is not None and _role_of(db, role_id)[0] != role_id:
            raise RoleError("找不到這個角色")
        rid, base = _role_of(db, role_id if role_id is not None else u.role)
        target = clean_perms(value) if value is not None else apply(base, before["own"])
        own = diff(base, target)
        u.role = rid
        u.perm_overrides = json.dumps(own)
        db.commit()
        return {"before": before, "after": {"role": rid, "own": own, "perms": apply(base, own)}}
    finally:
        db.close()


# ------------------------------------------------------------------ 開機


def ensure_seeded() -> bool:
    """角色表是空的(第一次上這一版)→ 建兩個種子角色。回有沒有建。

    既有帳號不用搬:`users.role` 存的就是種子角色的 id,`perm_overrides` 是 NULL = 跟角色一樣(見 `_own`)。
    預設角色被刪掉(理論上擋住了,但資料庫是可以直接改的)→ 補回來,不然沒角色的人一項權限都對不上。
    """
    db = SessionLocal()
    try:
        if db.query(models.Role.id).first():
            if db.get(models.Role, DEFAULT_ROLE) is None:
                db.add(models.Role(id=DEFAULT_ROLE, name=DEFAULT_ROLE, perms=json.dumps(SEEDS[DEFAULT_ROLE])))
                db.commit()
                logger.warning("預設角色 %s 不見了,已照種子補回", DEFAULT_ROLE)
            return False
        for rid in _SEED_ORDER:
            db.add(models.Role(id=rid, name=rid, perms=json.dumps(SEEDS[rid])))
        db.commit()
        return True
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
