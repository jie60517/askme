# -*- coding: utf-8 -*-
"""個人筆記。

**只有寫的人看得到** —— 看不到的一律 404(不是 403,連「這則存在」都不透露)。管理員也一樣,網站上沒有看別人筆記的路。
沒有分享、也沒有留言。
**筆記永遠不會送給 claude。**

從對話存的三種(整題、反白一段、截圖)都是「直接新增一則」,而且存的是**複製一份**:
後端自己去讀那一題的問答,前端不用把整段答案傳上來 —— 順便確認他看得到那一題
(別人沒分享給他的對話存不進來)。

其他功能:頁中頁(parent_id / position)、垃圾桶(deleted_at,30 天後清)、複製一份、
模板(is_template)、編輯器格式(doc,Tiptap JSON —— 有就以它為準,body 也一起存給搜尋與摘要)。

網址是 `/api/notebook/…`。schema 寫在這個檔裡,不放 schemas.py。
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, defer

from .. import auth, config, models
from ..database import get_db


def _require_enabled() -> None:
    """功能關著(config.NOTEBOOK_ENABLED)就整組當作不存在。查的是當下的值,測試可以臨時打開。"""
    if not config.NOTEBOOK_ENABLED:
        raise HTTPException(status_code=404, detail="Not Found")


router = APIRouter(prefix="/api/notebook", tags=["notebook"], dependencies=[Depends(_require_enabled)])

TITLE_MAX = 200
# 從對話存的時候,標題取前幾個字
_AUTO_TITLE_CHARS = 30
# 清單上那一行摘要
_SUMMARY_CHARS = 80
# 摘要只從內文開頭這麼多字裡取 —— 清單不用把每則 200 KB 的內文整份讀出來
_SUMMARY_SOURCE_CHARS = 600
# 頁面圖示存的是線條圖示的名字,可以帶顏色「名字:顏色」(frontend components/notes/pageIcons.tsx,最長 16 + 1 + 6 字);
# 上限留寬一點,不是圖示名的短字串(例如 emoji)也收得下 —— 前端把認不得的值當作沒選
_ICON_MAX = 32

_IMAGE_REF = re.compile(r"!\[[^\]]*\]\(notebook-image:[0-9a-f]{32}\)")
_IMAGE_SRC = re.compile(r"^notebook-image:[0-9a-f]{32}$")
_CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}
# 同 routers/files.py:瀏覽器不要自己猜型別;共用電腦登出之後 back/forward 讀不回來
_IMAGE_HEADERS = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"}



# ------------------------------------------------------------------ schema
class NoteSource(BaseModel):
    kind: Literal["qa", "selection"]
    qa_id: int
    # selection 才有:反白的那一段
    text: Optional[str] = None


class NoteCreate(BaseModel):
    title: str = Field(default="", max_length=TITLE_MAX)
    body: str = ""
    doc: Optional[str] = None
    icon: Optional[str] = Field(default=None, max_length=_ICON_MAX)
    # 放在哪一頁底下(頁中頁)。None = 最上層
    parent_id: Optional[int] = None
    # 從哪一個模板(自己存的)新增
    template_id: Optional[int] = None
    source: Optional[NoteSource] = None


class NoteUpdate(BaseModel):
    """自動儲存。沒帶的欄位不動(None = 不改);title / body 照舊每次都帶。"""

    title: Optional[str] = Field(default=None, max_length=TITLE_MAX)
    body: Optional[str] = None
    doc: Optional[str] = None
    icon: Optional[str] = Field(default=None, max_length=_ICON_MAX)
    cover: Optional[str] = None
    full_width: Optional[bool] = None
    # 前端手上那一版的 updated_at(就是上一次回應給它的字串)。對不上 = 別的分頁 / 別台電腦 / 別人
    # 先存過了 → 409,前端重讀。不給就不檢查(第一次存)。
    base_updated_at: Optional[str] = None


class NoteMove(BaseModel):
    """拖曳排序 / 拖進別頁。index = 放到新的那一層的第幾個(0 = 最上面)。"""

    parent_id: Optional[int] = None
    index: int = Field(default=0, ge=0)


class NoteSummary(BaseModel):
    id: int
    title: str
    summary: str
    source_kind: Optional[str]
    # 內文裡有圖(自己寫的那幾則清單列首用圖片圖示)
    has_image: bool
    updated_at: str
    parent_id: Optional[int] = None
    position: Optional[float] = None
    icon: Optional[str] = None


class Crumb(BaseModel):
    id: int
    title: str
    icon: Optional[str] = None


class NoteOut(BaseModel):
    id: int
    title: str
    body: str
    # 編輯器格式;None = 舊筆記,前端從 body 讀
    doc: Optional[str] = None
    source_kind: Optional[str]
    source_conversation_id: Optional[str]
    source_qa_id: Optional[int]
    # 原對話還看得到嗎。不是從對話存的 → None
    source_available: Optional[bool]
    created_at: str
    updated_at: str
    parent_id: Optional[int] = None
    icon: Optional[str] = None
    cover: Optional[str] = None
    full_width: bool = False
    is_template: bool = False
    owner: str = ""
    # 前端(pages/Notes.tsx)讀這個欄位決定能不能編輯。筆記只有主人看得到,所以一律是 owner。
    access: Literal["owner"] = "owner"
    # 上層一路到最上面(看得到的部分),給麵包屑
    crumbs: List[Crumb] = []


class ImageOut(BaseModel):
    id: str
    # 寫進內文的那一段(`![](notebook-image:<id>)`)
    ref: str


# ------------------------------------------------------------------ 小工具
def _iso(dt: datetime) -> str:
    # 微秒一定要寫出來:base_updated_at 是拿這個字串原封不動比對的
    return dt.isoformat(timespec="microseconds") + "Z"


def _summary(head: str) -> str:
    text = _IMAGE_REF.sub(" ", head or "")
    # 程式碼區塊(```sql、```json 之類)整段略過:摘要是給人認出這則的,不是一串 SQL / JSON。
    # 開頭有、結尾被 600 字截掉的那種也要略過
    text = re.sub(r"```.*?(```|$)", " ", text, flags=re.S)
    lines = []
    for line in text.splitlines():
        line = re.sub(r"^\s*(>\s*)+", "", line)  # 引用
        line = re.sub(r"^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+)", "", line)  # 標題、清單
        line = re.sub(r"^\[[ xX]\](\s+|$)", "", line)  # 待辦的勾(筆記編輯器可以直接勾);空的待辦也算
        line = line.replace("**", "").replace("`", "").strip(" |")
        if line and not re.fullmatch(r"[-:| ]+", line):  # 表格的分隔列
            lines.append(line)
    return re.sub(r"\s+", " ", " ".join(lines)).strip()[:_SUMMARY_CHARS]


def _auto_title(text: str) -> str:
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line[:_AUTO_TITLE_CHARS]
    return ""


def _quote(text: str) -> str:
    """引用區塊。每一行尾巴補兩個空白(Markdown 的硬換行)—— 問題原本分三行,存進來也要分三行。"""
    out = []
    for line in (text or "").strip("\n").splitlines():
        line = line.rstrip()
        out.append(f"> {line}  " if line else ">")
    return "\n".join(out)


def _check_body(body: Optional[str]) -> None:
    if body is not None and len(body.encode("utf-8")) > config.NOTEBOOK_MAX_BODY_BYTES:
        raise HTTPException(
            status_code=413, detail=f"筆記超過 {config.NOTEBOOK_MAX_BODY_BYTES // 1024} KB"
        )


def _check_doc(doc: Optional[str]) -> None:
    if doc is not None and len(doc.encode("utf-8")) > config.NOTEBOOK_MAX_DOC_BYTES:
        raise HTTPException(
            status_code=413, detail=f"筆記超過 {config.NOTEBOOK_MAX_DOC_BYTES // 1024} KB"
        )


def _check_cover(cover: Optional[str]) -> None:
    # 封面只能是自己的筆記圖片(空字串 = 拿掉);不收外部網址 —— 打開筆記時瀏覽器不該去連陌生網站
    if cover and not _IMAGE_SRC.match(cover):
        raise HTTPException(status_code=422, detail="封面只能用筆記裡的圖片")


def _check_count(db: Session, viewer: str, adding: int = 1) -> None:
    """再加 adding 則會不會超過上限(複製一整棵子頁要一次算,一則一則檢查會超過)。"""
    n = db.query(func.count(models.UserNote.id)).filter(models.UserNote.username == viewer).scalar()
    if n + adding > config.NOTEBOOK_MAX_NOTES:
        raise HTTPException(status_code=413, detail=f"筆記已經有 {config.NOTEBOOK_MAX_NOTES} 則")


def _children_map(db: Session, owner: str, *, include_deleted: bool = False) -> Dict[Optional[int], List[models.UserNote]]:
    """主人所有的筆記,照上一層分組(模板不在樹裡)。一個人上限 1000 則。
    內文與 doc 延後讀(用到才讀那一則):搬、刪、找子頁都只要結構,整份讀出來每則最多 1.2 MB。"""
    q = db.query(models.UserNote).options(defer(models.UserNote.body), defer(models.UserNote.doc)).filter(
        models.UserNote.username == owner, or_(models.UserNote.is_template.is_(None), models.UserNote.is_template.is_(False))
    )
    if not include_deleted:
        q = q.filter(models.UserNote.deleted_at.is_(None))
    out: Dict[Optional[int], List[models.UserNote]] = {}
    for n in q.all():
        out.setdefault(n.parent_id, []).append(n)
    return out


def _descendants(children: Dict[Optional[int], List[models.UserNote]], note_id: int) -> List[models.UserNote]:
    """底下所有子頁(不含自己)。用堆疊不用遞迴;看過的不再走(資料被弄成環也不會無窮迴圈)。"""
    out: List[models.UserNote] = []
    seen = {note_id}
    stack = list(children.get(note_id, []))
    while stack:
        n = stack.pop()
        if n.id in seen:
            continue
        seen.add(n.id)
        out.append(n)
        stack.extend(children.get(n.id, []))
    return out


def _ancestors(db: Session, note: models.UserNote) -> List[models.UserNote]:
    """上層一路到最上面(近的在前)。同一個主人;斷掉或繞圈就停。"""
    out: List[models.UserNote] = []
    seen = {note.id}
    pid = note.parent_id
    while pid is not None and pid not in seen:
        seen.add(pid)
        p = db.query(models.UserNote).filter(models.UserNote.id == pid, models.UserNote.username == note.username).first()
        if p is None:
            break
        out.append(p)
        pid = p.parent_id
    return out


def _owned(db: Session, note_id: int, viewer: str, *, allow_deleted: bool = False) -> models.UserNote:
    """拿自己的一頁。別人的、不存在的、在垃圾桶裡的(除非 `allow_deleted`)一律 404 ——
    連「這則存在」都不透露。垃圾桶裡的也是主人的:刪除與復原要拿得到。"""
    note = db.query(models.UserNote).filter(models.UserNote.id == note_id).first()
    if note is None or note.username != viewer or (note.deleted_at is not None and not allow_deleted):
        raise HTTPException(status_code=404, detail="找不到這則筆記")
    return note


def _visible_qa(db: Session, qa_id: int, viewer: str) -> Optional[models.QARecord]:
    """這個人看得到的那一題。判斷不自己寫,一律走 conversations.visible_to(隔離的唯一出入口)。"""
    from .conversations import visible_to

    return (
        visible_to(db.query(models.QARecord), db, viewer)
        .filter(models.QARecord.id == qa_id)
        .first()
    )


def _require_qa(db: Session, qa_id: int, viewer: str) -> models.QARecord:
    qa = _visible_qa(db, qa_id, viewer)
    if qa is None or not qa.conversation_id:
        raise HTTPException(status_code=404, detail="找不到這一題")
    return qa


def _out(db: Session, note: models.UserNote, viewer: str) -> NoteOut:
    available = None
    if note.source_qa_id is not None:
        # 「回到對話」看的是**我**現在還看不看得到那一題:對話的分享被收回之後就看不到了
        available = _visible_qa(db, note.source_qa_id, viewer) is not None
    chain = _ancestors(db, note)
    return NoteOut(
        id=note.id,
        title=note.title or "",
        body=note.body or "",
        doc=note.doc,
        source_kind=note.source_kind,
        source_conversation_id=note.source_conversation_id,
        source_qa_id=note.source_qa_id,
        source_available=available,
        created_at=_iso(note.created_at),
        updated_at=_iso(note.updated_at),
        parent_id=note.parent_id,
        icon=note.icon,
        cover=note.cover,
        full_width=bool(note.full_width),
        is_template=bool(note.is_template),
        owner=note.username,
        crumbs=[Crumb(id=a.id, title=a.title or "", icon=a.icon) for a in reversed(chain)],
    )


def _top_position(db: Session, owner: str, parent_id: Optional[int]) -> float:
    """新的那一則放在這一層最上面。"""
    low = (
        db.query(func.min(models.UserNote.position))
        .filter(
            models.UserNote.username == owner,
            models.UserNote.parent_id.is_(None) if parent_id is None else models.UserNote.parent_id == parent_id,
            models.UserNote.deleted_at.is_(None),
        )
        .scalar()
    )
    return (low if low is not None else 1.0) - 1.0


def _add_note(db: Session, viewer: str, **fields) -> models.UserNote:
    """加進 session(還沒 commit)。截圖那條要先拿 id 掛圖片、最後才一起 commit,所以拆成兩段。"""
    now = datetime.utcnow()
    fields.setdefault("position", _top_position(db, viewer, fields.get("parent_id")))
    note = models.UserNote(username=viewer, created_at=now, updated_at=now, **fields)
    db.add(note)
    return note


def _new_note(db: Session, viewer: str, **fields) -> models.UserNote:
    note = _add_note(db, viewer, **fields)
    db.commit()
    db.refresh(note)
    return note


def _ensure_positions(db: Session, owner: str) -> None:
    """舊資料沒有 position:照「新的在上」補號(接在這一層已經排過的後面)。只在有 NULL 的時候寫。"""
    missing = (
        db.query(models.UserNote.id)
        .filter(models.UserNote.username == owner, models.UserNote.position.is_(None))
        .first()
    )
    if missing is None:
        return
    groups = _children_map(db, owner, include_deleted=True)
    for siblings in groups.values():
        placed = [n.position for n in siblings if n.position is not None]
        nxt = (max(placed) if placed else 0.0) + 1.0
        for n in sorted((n for n in siblings if n.position is None), key=lambda n: (n.created_at, n.id), reverse=True):
            n.position = nxt
            nxt += 1.0
    db.commit()


def _renumber(siblings: Iterable[models.UserNote]) -> None:
    for i, n in enumerate(siblings):
        n.position = float(i)


def _image_path(image_id: str, ext: str):
    return config.NOTEBOOK_DIR / f"{image_id}.{ext}"


def _sniff(data: bytes) -> Optional[str]:
    """看檔頭認型別,不信副檔名也不信瀏覽器給的 content-type。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


async def _store_image(
    db: Session, viewer: str, note_id: int, file: UploadFile, *, commit: bool = True
) -> models.UserNoteImage:
    """存一張圖(檔案 + 資料表)。`commit=False`:只 add 不提交,交給呼叫端跟別的改動一起提交
    (截圖那條要「筆記 + 圖 + 內文」一次寫進去);那時候提交失敗要由呼叫端刪掉檔案。

    圖算在**上傳的人**名下(每人圖片總量有上限)。
    """
    data = await file.read(config.NOTEBOOK_MAX_IMAGE_BYTES + 1)
    if len(data) > config.NOTEBOOK_MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"圖片超過 {config.NOTEBOOK_MAX_IMAGE_BYTES // (1024 * 1024)} MB",
        )
    ext = _sniff(data)
    if ext is None:
        raise HTTPException(status_code=415, detail="只收 PNG、JPG、WebP 圖片")
    used = (
        db.query(func.coalesce(func.sum(models.UserNoteImage.bytes), 0))
        .filter(models.UserNoteImage.username == viewer)
        .scalar()
    )
    if used + len(data) > config.NOTEBOOK_MAX_IMAGE_TOTAL_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"筆記圖片總量超過 {config.NOTEBOOK_MAX_IMAGE_TOTAL_BYTES // (1024 * 1024)} MB",
        )
    image = models.UserNoteImage(
        id=uuid.uuid4().hex, username=viewer, note_id=note_id, ext=ext, bytes=len(data)
    )
    config.NOTEBOOK_DIR.mkdir(parents=True, exist_ok=True)
    path = _image_path(image.id, ext)
    path.write_bytes(data)
    db.add(image)
    if commit:
        try:
            db.commit()
        except Exception:
            path.unlink(missing_ok=True)
            raise
    return image


def _ref(image: models.UserNoteImage) -> str:
    return f"![](notebook-image:{image.id})"


def _uses_image(image_id: str):
    """「內文 / 編輯器格式 / 封面裡用到這張圖」的條件。"""
    ref = f"notebook-image:{image_id}"
    return or_(models.UserNote.body.contains(ref), models.UserNote.doc.contains(ref), models.UserNote.cover == ref)


def _hard_delete(db: Session, notes: List[models.UserNote]) -> List:
    """真的刪掉這幾頁,回傳要刪的圖片檔路徑(呼叫端 commit 成功後才刪檔)。

    ⚠️ 圖片掛在「上傳時那一則」底下,但參照可以被複製到別則(複製一份、模板、自己複製貼上)。
    別則還用著的圖不刪,改掛到那一則名下 —— 不然刪掉原本那則,副本裡的圖就壞了。
    """
    ids = [n.id for n in notes]
    if not ids:
        return []
    paths = []
    for i in db.query(models.UserNoteImage).filter(models.UserNoteImage.note_id.in_(ids)).all():
        keeper = (
            db.query(models.UserNote.id)
            .filter(models.UserNote.id.notin_(ids), _uses_image(i.id))
            .first()
        )
        if keeper is not None:
            i.note_id = keeper[0]
        else:
            paths.append(_image_path(i.id, i.ext))
            db.delete(i)
    for n in notes:
        db.delete(n)
    return paths


def _unlink(paths) -> None:
    # 資料庫先刪成功才刪檔:反過來的話,commit 失敗會留下一則圖片已經不見的筆記
    for p in paths:
        p.unlink(missing_ok=True)


def _purge_trash(db: Session, owner: str) -> None:
    """垃圾桶裡超過 30 天的真的清掉。讀清單時順手做,不另外排程。"""
    cutoff = datetime.utcnow() - timedelta(days=config.NOTEBOOK_TRASH_DAYS)
    old = (
        db.query(models.UserNote)
        .filter(models.UserNote.username == owner, models.UserNote.deleted_at.isnot(None), models.UserNote.deleted_at < cutoff)
        .all()
    )
    if not old:
        return
    paths = _hard_delete(db, old)
    db.commit()
    _unlink(paths)


def _summary_row(n: models.UserNote, **extra) -> NoteSummary:
    """單一則(存成模板之後回傳那一列用);清單一律走 `_summaries`,不要一則一則讀內文。"""
    body = n.body or ""
    return NoteSummary(
        id=n.id,
        title=n.title or "",
        summary=_summary(body[:_SUMMARY_SOURCE_CHARS]),
        source_kind=n.source_kind,
        has_image="](notebook-image:" in body,
        updated_at=_iso(n.updated_at),
        parent_id=n.parent_id,
        position=n.position,
        icon=n.icon,
        **extra,
    )


def _summaries(db: Session, *filters) -> Dict[int, NoteSummary]:
    """清單那幾列:一次查完,內文只取開頭 `_SUMMARY_SOURCE_CHARS` 字、有沒有圖用 SQL 判斷,
    不要整則讀出來。回 {id: 那一列}。"""
    head = func.substr(models.UserNote.body, 1, _SUMMARY_SOURCE_CHARS)
    rows = db.query(
        models.UserNote.id,
        models.UserNote.title,
        head,
        models.UserNote.source_kind,
        models.UserNote.body.contains("](notebook-image:"),
        models.UserNote.updated_at,
        models.UserNote.parent_id,
        models.UserNote.position,
        models.UserNote.icon,
    ).filter(*filters)
    out: Dict[int, NoteSummary] = {}
    for nid, title, text, kind, has_image, updated, parent, position, icon in rows:
        out[nid] = NoteSummary(
            id=nid,
            title=title or "",
            summary=_summary(text or ""),
            source_kind=kind,
            has_image=bool(has_image),
            updated_at=_iso(updated),
            parent_id=parent,
            position=position,
            icon=icon,
        )
    return out


def _by_order(rows: Iterable[NoteSummary]) -> List[NoteSummary]:
    return sorted(rows, key=lambda r: (r.position if r.position is not None else 0.0, -r.id))


_NOT_TEMPLATE = or_(models.UserNote.is_template.is_(None), models.UserNote.is_template.is_(False))


# ------------------------------------------------------------------ 路由
# ⚠️ 固定路徑(/saved、/screenshot、/templates、/images/…)要排在 /{note_id} 前面
@router.get("", response_model=List[NoteSummary])
def list_notes(
    q: Optional[str] = Query(default=None, max_length=100),
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """我的頁面(整棵樹,平的,前端自己組)。`q` 比對標題與內文,只找自己的。"""
    _purge_trash(db, viewer)
    _ensure_positions(db, viewer)
    keyword = (q or "").strip()
    if not keyword:
        mine = models.UserNote.username == viewer
        return _by_order(_summaries(db, mine, _NOT_TEMPLATE, models.UserNote.deleted_at.is_(None)).values())

    # % 與 _ 是 LIKE 的萬用字元,使用者打的要當字面值
    escaped = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    match = or_(models.UserNote.title.ilike(pattern, escape="\\"), models.UserNote.body.ilike(pattern, escape="\\"))
    mine = _summaries(db, models.UserNote.username == viewer, models.UserNote.deleted_at.is_(None), _NOT_TEMPLATE, match)
    return sorted(mine.values(), key=lambda r: (r.updated_at, r.id), reverse=True)


@router.get("/templates", response_model=List[NoteSummary])
def list_templates(db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)):
    """自己存的模板(內建模板在前端)。"""
    rows = _summaries(db, models.UserNote.username == viewer, models.UserNote.is_template.is_(True), models.UserNote.deleted_at.is_(None))
    return sorted(rows.values(), key=lambda r: (r.updated_at, r.id), reverse=True)


@router.get("/saved", response_model=List[int])
def saved_in_conversation(
    conversation_id: str = Query(..., max_length=64),
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """這組對話裡,哪幾題存過筆記(書籤鈕變實心)。只看自己的筆記;垃圾桶裡的不算。"""
    rows = (
        db.query(models.UserNote.source_qa_id)
        .filter(
            models.UserNote.username == viewer,
            models.UserNote.source_conversation_id == conversation_id,
            models.UserNote.source_qa_id.isnot(None),
            models.UserNote.deleted_at.is_(None),
        )
        .distinct()
        .all()
    )
    return sorted(r[0] for r in rows)


def _copy(db: Session, viewer: str, src: models.UserNote, *, parent_id: Optional[int], title: str, position: Optional[float] = None, is_template: bool = False) -> models.UserNote:
    """複製一頁(不含子頁)。圖片參照照抄 —— 圖算在原本那則名下,刪除時有 keeper 的規則照顧。"""
    fields = dict(
        title=title,
        body=src.body or "",
        doc=src.doc,
        icon=src.icon,
        cover=src.cover,
        full_width=src.full_width,
        parent_id=parent_id,
        is_template=True if is_template else None,
    )
    if position is not None:
        fields["position"] = position
    return _add_note(db, viewer, **fields)


@router.post("", response_model=NoteOut, status_code=201)
def create_note(
    req: NoteCreate,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """新增一則。不帶 source = 自己寫的(可以指定上一層、模板);帶 source = 從對話存(整題 / 反白一段)。"""
    _check_count(db, viewer)
    if req.parent_id is not None:
        # 只能放在自己的頁底下;模板底下也不行(同 move)
        parent = _owned(db, req.parent_id, viewer)
        if parent.is_template:
            raise HTTPException(status_code=422, detail="不能放進模板底下")
    if req.template_id is not None:
        tpl = _owned(db, req.template_id, viewer)
        if not tpl.is_template:
            raise HTTPException(status_code=404, detail="找不到這個模板")
        note = _copy(db, viewer, tpl, parent_id=req.parent_id, title=tpl.title or "")
        db.commit()
        db.refresh(note)
        return _out(db, note, viewer)
    if req.source is None:
        _check_body(req.body)
        _check_doc(req.doc)
        note = _new_note(
            db, viewer, title=req.title.strip(), body=req.body, doc=req.doc, icon=req.icon or None, parent_id=req.parent_id
        )
        return _out(db, note, viewer)

    qa = _require_qa(db, req.source.qa_id, viewer)
    if req.source.kind == "qa":
        body = f"{_quote(qa.question)}\n\n{qa.answer or ''}"
        title = _auto_title(qa.question)
    else:
        text = (req.source.text or "").strip()
        if not text:
            raise HTTPException(status_code=422, detail="沒有反白任何文字")
        # 引用底下留一行空白給他補註解
        body = f"{_quote(text)}\n\n"
        title = _auto_title(text)
    _check_body(body)
    note = _new_note(
        db,
        viewer,
        title=title,
        body=body,
        source_kind=req.source.kind,
        source_conversation_id=qa.conversation_id,
        source_qa_id=qa.id,
    )
    return _out(db, note, viewer)


@router.post("/screenshot", response_model=NoteOut, status_code=201)
async def create_from_screenshot(
    qa_id: int = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """把那一則回答的截圖存成一則新筆記。截圖是前端畫的,這裡只收圖。

    一次請求、**一次提交**(建筆記 + 存圖 + 內文):拆開的話中間斷掉會留下一則沒有圖的空筆記。
    """
    _check_count(db, viewer)
    qa = _require_qa(db, qa_id, viewer)
    note = _add_note(
        db,
        viewer,
        title=_auto_title(qa.question),
        body="",
        source_kind="screenshot",
        source_conversation_id=qa.conversation_id,
        source_qa_id=qa.id,
    )
    db.flush()  # 拿 id,圖片要掛在它底下
    image = None
    try:
        image = await _store_image(db, viewer, note.id, file, commit=False)
        note.body = f"{_ref(image)}\n\n"
        db.commit()
    except Exception:
        db.rollback()
        if image is not None:
            _image_path(image.id, image.ext).unlink(missing_ok=True)
        raise
    db.refresh(note)
    return _out(db, note, viewer)


@router.get("/images/{image_id}")
def get_image(
    image_id: str,
    db: Session = Depends(get_db),
    # <img src> 帶不了 Authorization 標頭,跟 /api/files、/api/uploads 一樣收 cookie(見 auth.require_user_file)
    viewer: str = Depends(auth.require_user_file),
):
    """一張圖。只有上傳的人看得到(複製一份、模板裡的圖也是同一個人的,`_hard_delete` 改掛別則時不換主人)。"""
    if not re.fullmatch(r"[0-9a-f]{32}", image_id):
        raise HTTPException(status_code=404, detail="找不到圖片")
    image = db.query(models.UserNoteImage).filter(models.UserNoteImage.id == image_id).first()
    allowed = image is not None and image.username == viewer
    path = _image_path(image_id, image.ext) if image and allowed else None
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="找不到圖片")
    return FileResponse(path, media_type=_CONTENT_TYPES[image.ext], headers=_IMAGE_HEADERS)


@router.get("/{note_id}", response_model=NoteOut)
def get_note(note_id: int, db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)):
    return _out(db, _owned(db, note_id, viewer), viewer)


@router.put("/{note_id}", response_model=NoteOut)
def update_note(
    note_id: int,
    req: NoteUpdate,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """自動儲存(前端停手一秒送一次,整則覆蓋)。超過上限 413、版本對不上 409,原本那份都不動。"""
    note = _owned(db, note_id, viewer)
    if req.base_updated_at is not None and req.base_updated_at != _iso(note.updated_at):
        raise HTTPException(status_code=409, detail="這則筆記在別的地方改過了")
    _check_body(req.body)
    _check_doc(req.doc)
    _check_cover(req.cover)
    old_title = note.title
    if req.title is not None:
        note.title = req.title.strip()
    if req.body is not None:
        note.body = req.body
    if req.doc is not None:
        note.doc = req.doc or None
    if req.icon is not None:
        note.icon = req.icon or None
    if req.cover is not None:
        note.cover = req.cover or None
    if req.full_width is not None:
        note.full_width = req.full_width
    note.updated_at = datetime.utcnow()
    if note.title != old_title:
        _sync_page_links(db, note, old_title)
    db.commit()
    db.refresh(note)
    return _out(db, note, viewer)


# 前端 lib/notebookApi.ts 的 UNTITLED:子頁連結沒有標題時,Markdown 裡寫這個
_UNTITLED = "未命名"


def _link_text(title: str) -> str:
    return title.strip() or _UNTITLED


def _sync_page_links(db: Session, note: models.UserNote, old_title: str) -> None:
    """子頁改名:引用它的那幾頁(同一個主人)存的連結字跟著換 —— doc 裡子頁連結的 title,
    與 Markdown 裡那一行(搜尋、清單摘要用它;不換的話會一直停在建立當下的「未命名」)。

    Markdown 只換「整行剛好等於舊名字」的行,而且最多換跟連結一樣多行(連結在 Markdown 裡就是自己一行)。
    **不動那幾頁的 updated_at**:開著那一頁的人下一次存檔帶的是舊的 updated_at,動了會變成版本衝突;
    他那邊的編輯器也會自己把連結字換成新名字(nodeViews 的 PageLinkView),存回來是同一個結果。"""
    if _link_text(old_title) == _link_text(note.title):
        return
    needle = f'"type":"pageLink","attrs":{{"id":{note.id},'
    parents = (
        db.query(models.UserNote)
        .filter(models.UserNote.username == note.username, models.UserNote.id != note.id, models.UserNote.doc.contains(needle))
        .all()
    )
    old_line, new_line = _link_text(old_title), _link_text(note.title)
    for parent in parents:
        try:
            doc = json.loads(parent.doc)
        except ValueError:
            continue
        count = 0
        stack = [doc]
        while stack:
            node = stack.pop()
            if not isinstance(node, dict):
                continue
            attrs = node.get("attrs") or {}
            if node.get("type") == "pageLink" and attrs.get("id") == note.id:
                attrs["title"] = note.title
                count += 1
            stack.extend(node.get("content") or [])
        if not count:
            continue
        parent.doc = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        lines = (parent.body or "").split("\n")
        for i, line in enumerate(lines):
            if count and line.strip() == old_line:
                lines[i] = line.replace(old_line, new_line, 1)
                count -= 1
        parent.body = "\n".join(lines)


@router.post("/{note_id}/move", response_model=NoteOut)
def move_note(note_id: int, req: NoteMove, db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)):
    """拖曳排序、拖進別頁變子頁。只有主人能搬自己的樹。"""
    note = _owned(db, note_id, viewer)
    children = _children_map(db, viewer)
    if req.parent_id is not None:
        parent = _owned(db, req.parent_id, viewer)
        if parent.id == note.id or parent.id in {d.id for d in _descendants(children, note.id)}:
            raise HTTPException(status_code=422, detail="不能把一頁搬進它自己底下")
        if parent.is_template:
            raise HTTPException(status_code=422, detail="不能放進模板底下")
    siblings = sorted(
        (n for n in children.get(req.parent_id, []) if n.id != note.id),
        key=lambda n: (n.position if n.position is not None else 0.0, -n.id),
    )
    siblings.insert(min(req.index, len(siblings)), note)
    note.parent_id = req.parent_id
    _renumber(siblings)
    db.commit()
    db.refresh(note)
    return _out(db, note, viewer)


@router.post("/{note_id}/duplicate", response_model=NoteOut, status_code=201)
def duplicate_note(note_id: int, db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)):
    """複製一份(連子頁),放在原本那頁的正下方。標題加「的副本」。"""
    src = _owned(db, note_id, viewer)
    children = _children_map(db, viewer)
    tree = [src] + _descendants(children, src.id)
    _check_count(db, viewer, adding=len(tree))
    copy = _copy(db, viewer, src, parent_id=src.parent_id, title=f"{src.title} 的副本" if src.title else "", position=(src.position or 0.0) + 0.5)
    db.flush()
    mapping = {src.id: copy.id}
    # 子頁照上下層一層一層複製(_descendants 是先上後下)
    for d in tree[1:]:
        c = _copy(db, viewer, d, parent_id=mapping.get(d.parent_id, copy.id), title=d.title or "", position=d.position)
        db.flush()
        mapping[d.id] = c.id
    siblings = sorted(
        (n for n in _children_map(db, viewer).get(src.parent_id, [])),
        key=lambda n: (n.position if n.position is not None else 0.0, -n.id),
    )
    _renumber(siblings)
    db.commit()
    db.refresh(copy)
    return _out(db, copy, viewer)


@router.post("/{note_id}/template", response_model=NoteSummary, status_code=201)
def save_as_template(note_id: int, db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)):
    """把這頁存成模板(只有這一頁,不含子頁)。"""
    src = _owned(db, note_id, viewer)
    _check_count(db, viewer)
    tpl = _copy(db, viewer, src, parent_id=None, title=src.title or "", is_template=True)
    db.commit()
    db.refresh(tpl)
    return _summary_row(tpl)


@router.delete("/{note_id}", status_code=204)
def delete_note(
    note_id: int,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """軟刪除(連子頁一起;前端給「復原」)。超過保留天數的由 `_purge_trash` 真的清掉。只有主人能刪。"""
    note = _owned(db, note_id, viewer, allow_deleted=True)
    if note.deleted_at is not None:
        return Response(status_code=204)
    now = datetime.utcnow()
    for n in [note] + _descendants(_children_map(db, viewer), note.id):
        n.deleted_at = now
    db.commit()
    return Response(status_code=204)


@router.post("/{note_id}/restore", response_model=NoteOut)
def restore_note(note_id: int, db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)):
    """從垃圾桶復原。同一批刪的子頁一起回來;上一層還在垃圾桶的話放到最上層。"""
    note = _owned(db, note_id, viewer, allow_deleted=True)
    if note.deleted_at is None:
        return _out(db, note, viewer)
    batch = note.deleted_at
    children = _children_map(db, viewer, include_deleted=True)
    for n in [note] + _descendants(children, note.id):
        if n.deleted_at == batch:
            n.deleted_at = None
    if note.parent_id is not None:
        parent = db.query(models.UserNote).filter(models.UserNote.id == note.parent_id, models.UserNote.username == viewer).first()
        if parent is None or parent.deleted_at is not None:
            note.parent_id = None
            note.position = _top_position(db, viewer, None)
    db.commit()
    db.refresh(note)
    return _out(db, note, viewer)


@router.post("/{note_id}/images", response_model=ImageOut, status_code=201)
async def upload_image(
    note_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """筆記裡貼上 / 拖進一張圖、封面圖。回傳要寫進內文的那一段,由前端插進游標的位置。"""
    note = _owned(db, note_id, viewer)
    image = await _store_image(db, viewer, note.id, file)
    return ImageOut(id=image.id, ref=_ref(image))
