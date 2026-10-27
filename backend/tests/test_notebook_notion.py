# -*- coding: utf-8 -*-
"""個人筆記 Notion 式功能的後端:頁中頁、排序、垃圾桶、複製、模板、doc。

共用 test_notebook.py 的 fixture 與帳號(同一組 ME / OTHER,wipe 一起清)。
"""
from datetime import datetime, timedelta

import pytest

from app import auth, config, models
from app.database import SessionLocal

from test_notebook import ME, OTHER, PNG, _clean, _create, _headers, _tables, client  # noqa: F401

def _list(client, who=ME):
    return client.get("/api/notebook", headers=_headers(who)).json()


def _ids(rows):
    return [r["id"] for r in rows]


# ------------------------------------------------------------------ 順序與頁中頁
def test_new_page_goes_on_top_and_editing_does_not_reorder(client):
    a = _create(client, title="A")["id"]
    b = _create(client, title="B")["id"]
    assert _ids(_list(client)) == [b, a]
    client.put(f"/api/notebook/{a}", json={"title": "A2", "body": "改了"}, headers=_headers())
    assert _ids(_list(client)) == [b, a], "改內容不會跳到最上面"


def test_move_reorders_and_nests_and_refuses_cycles(client):
    a = _create(client, title="A")["id"]
    b = _create(client, title="B")["id"]
    c = _create(client, title="C")["id"]
    assert _ids(_list(client)) == [c, b, a]
    assert client.post(f"/api/notebook/{a}/move", json={"parent_id": None, "index": 0}, headers=_headers()).status_code == 200
    roots = [r for r in _list(client) if r["parent_id"] is None]
    assert _ids(roots) == [a, c, b]
    # B 拖進 A 底下
    moved = client.post(f"/api/notebook/{b}/move", json={"parent_id": a, "index": 0}, headers=_headers()).json()
    assert moved["parent_id"] == a and moved["crumbs"][0]["id"] == a
    # A 不能搬進自己的子頁
    assert client.post(f"/api/notebook/{a}/move", json={"parent_id": b, "index": 0}, headers=_headers()).status_code == 422


def test_child_page_and_breadcrumbs(client):
    parent = _create(client, title="專案", icon="📁")["id"]
    child = _create(client, title="會議", parent_id=parent)
    assert child["parent_id"] == parent
    assert child["crumbs"] == [{"id": parent, "title": "專案", "icon": "📁"}]
    # 不能放進別人的頁底下
    other = _create(client, who=OTHER, title="別人的")["id"]
    assert client.post("/api/notebook", json={"parent_id": other}, headers=_headers()).status_code == 404


def test_old_notes_without_position_get_numbered_newest_first(client):
    a = _create(client, title="舊 A")["id"]
    b = _create(client, title="舊 B")["id"]
    db = SessionLocal()
    try:
        db.query(models.UserNote).filter(models.UserNote.id.in_([a, b])).update({"position": None}, synchronize_session=False)
        db.query(models.UserNote).filter(models.UserNote.id == a).update({"created_at": datetime.utcnow() - timedelta(days=1)})
        db.commit()
    finally:
        db.close()
    assert _ids(_list(client)) == [b, a]


# ------------------------------------------------------------------ 垃圾桶
def test_delete_takes_children_and_restore_brings_them_back(client):
    parent = _create(client, title="上層")["id"]
    child = _create(client, title="子頁", parent_id=parent)["id"]
    assert client.delete(f"/api/notebook/{parent}", headers=_headers()).status_code == 204
    assert _list(client) == []
    restored = client.post(f"/api/notebook/{parent}/restore", headers=_headers()).json()
    assert restored["id"] == parent
    assert sorted(_ids(_list(client))) == sorted([parent, child])


def test_restore_child_whose_parent_is_still_in_trash_goes_to_top(client):
    parent = _create(client, title="上層")["id"]
    child = _create(client, title="子頁", parent_id=parent)["id"]
    client.delete(f"/api/notebook/{child}", headers=_headers())
    client.delete(f"/api/notebook/{parent}", headers=_headers())
    out = client.post(f"/api/notebook/{child}/restore", headers=_headers()).json()
    assert out["parent_id"] is None


def test_trash_older_than_30_days_is_purged(client):
    nid = _create(client, title="很久以前刪的")["id"]
    client.delete(f"/api/notebook/{nid}", headers=_headers())
    db = SessionLocal()
    try:
        db.query(models.UserNote).filter(models.UserNote.id == nid).update(
            {"deleted_at": datetime.utcnow() - timedelta(days=config.NOTEBOOK_TRASH_DAYS + 1)}
        )
        db.commit()
    finally:
        db.close()
    _list(client)  # 讀清單時順手清
    db = SessionLocal()
    try:
        assert db.get(models.UserNote, nid) is None
    finally:
        db.close()


# ------------------------------------------------------------------ 複製、模板
def test_duplicate_copies_children_and_sits_right_below(client):
    a = _create(client, title="A", body="內文", doc='{"type":"doc"}', icon="🚀")["id"]
    _create(client, title="A 的子頁", parent_id=a)
    b = _create(client, title="B")["id"]
    copy = client.post(f"/api/notebook/{a}/duplicate", headers=_headers()).json()
    assert copy["title"] == "A 的副本" and copy["doc"] == '{"type":"doc"}' and copy["icon"] == "🚀"
    roots = [r for r in _list(client) if r["parent_id"] is None]
    assert _ids(roots) == [b, a, copy["id"]]
    assert [r["title"] for r in _list(client) if r["parent_id"] == copy["id"]] == ["A 的子頁"]


def test_template_is_hidden_from_tree_and_creates_copies(client):
    src = _create(client, title="會議紀錄", body="## 出席\n\n## 結論")["id"]
    tpl = client.post(f"/api/notebook/{src}/template", headers=_headers()).json()
    assert tpl["id"] not in _ids(_list(client))
    assert _ids(client.get("/api/notebook/templates", headers=_headers()).json()) == [tpl["id"]]
    made = _create(client, template_id=tpl["id"])
    assert made["title"] == "會議紀錄" and made["body"].startswith("## 出席") and not made["is_template"]


# ------------------------------------------------------------------ doc 與部分更新
def test_update_only_touches_given_fields(client):
    nid = _create(client, title="T", body="b")["id"]
    out = client.put(f"/api/notebook/{nid}", json={"doc": '{"type":"doc","content":[]}', "full_width": True, "icon": "📝"}, headers=_headers()).json()
    assert out["title"] == "T" and out["body"] == "b"
    assert out["doc"] and out["full_width"] is True and out["icon"] == "📝"
    out = client.put(f"/api/notebook/{nid}", json={"icon": ""}, headers=_headers()).json()
    assert out["icon"] is None


def test_cover_must_be_a_notebook_image(client):
    nid = _create(client)["id"]
    assert client.put(f"/api/notebook/{nid}", json={"cover": "https://evil.example/x.png"}, headers=_headers()).status_code == 422
    ok = "notebook-image:" + "a" * 32
    assert client.put(f"/api/notebook/{nid}", json={"cover": ok}, headers=_headers()).json()["cover"] == ok


def test_doc_limit(client, monkeypatch):
    monkeypatch.setattr(config, "NOTEBOOK_MAX_DOC_BYTES", 10)
    nid = _create(client)["id"]
    assert client.put(f"/api/notebook/{nid}", json={"doc": "x" * 11}, headers=_headers()).status_code == 413


# ------------------------------------------------------------------ 別人:一律看不到
def test_others_get_no_access(client):
    """筆記只有主人看得到:別人看、改、搜尋、上傳圖片、讀圖片都沒有(連子頁)。"""
    page = _create(client, title="驗收流程", body="部分驗收")["id"]
    child = _create(client, title="子頁", parent_id=page)["id"]
    image = client.post(f"/api/notebook/{page}/images", files={"file": ("a.png", PNG)}, headers=_headers()).json()
    client.put(f"/api/notebook/{page}", json={"body": image["ref"]}, headers=_headers())

    for nid in (page, child):
        assert client.get(f"/api/notebook/{nid}", headers=_headers(OTHER)).status_code == 404
    assert client.put(f"/api/notebook/{page}", json={"body": "他改的"}, headers=_headers(OTHER)).status_code == 404
    assert client.post(f"/api/notebook/{page}/images", files={"file": ("a.png", PNG)}, headers=_headers(OTHER)).status_code == 404
    assert client.get("/api/notebook", params={"q": "驗收"}, headers=_headers(OTHER)).json() == []
    client.cookies.set(auth.SESSION_COOKIE, auth._issue(OTHER), path="/api")
    assert client.get(f"/api/notebook/images/{image['id']}").status_code == 404
    client.cookies.clear()
    # 主人自己照常
    assert client.get(f"/api/notebook/{page}", headers=_headers()).json()["access"] == "owner"
    assert _ids(client.get("/api/notebook", params={"q": "驗收"}, headers=_headers()).json()) == [page]


# ------------------------------------------------------------------ 子頁改名
def _page_link_doc(child_id, title=""):
    import json as _json

    return _json.dumps(
        {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "上層的字"}]},
                {"type": "pageLink", "attrs": {"id": child_id, "title": title}},
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),  # 跟前端 JSON.stringify 一樣緊湊
    )


def test_renaming_a_subpage_updates_the_link_text_stored_in_the_parent(client):
    import json as _json

    parent = _create(client, title="上層")["id"]
    child = _create(client, title="", parent_id=parent)["id"]
    client.put(f"/api/notebook/{parent}", json={"body": "上層的字\n\n未命名", "doc": _page_link_doc(child)}, headers=_headers())
    before = client.get(f"/api/notebook/{parent}", headers=_headers()).json()

    assert client.put(f"/api/notebook/{child}", json={"title": "專案上線清單"}, headers=_headers()).status_code == 200

    after = client.get(f"/api/notebook/{parent}", headers=_headers()).json()
    link = _json.loads(after["doc"])["content"][1]
    assert link["attrs"]["title"] == "專案上線清單"
    assert after["body"] == "上層的字\n\n專案上線清單", "搜尋與摘要用的 Markdown 也跟著換"
    assert after["updated_at"] == before["updated_at"], "上層的「編輯於」不動:開著上層的人存檔不會撞版本"
    hits = _ids(client.get("/api/notebook", params={"q": "專案上線"}, headers=_headers()).json())
    assert parent in hits and child in hits

    # 再改一次:用上一次的名字找
    client.put(f"/api/notebook/{child}", json={"title": "專案上線清單 v2"}, headers=_headers())
    after2 = client.get(f"/api/notebook/{parent}", headers=_headers()).json()
    assert after2["body"] == "上層的字\n\n專案上線清單 v2"


def test_renaming_only_touches_lines_that_are_the_link(client):
    parent = _create(client, title="上層")["id"]
    child = _create(client, title="A", parent_id=parent)["id"]
    # 內文另外有一行剛好也叫 A:只換得掉跟連結一樣多的行數(一個連結 → 一行),而且只換整行剛好等於舊名字的
    client.put(f"/api/notebook/{parent}", json={"body": "A 開頭的句子\n\nA", "doc": _page_link_doc(child, "A")}, headers=_headers())
    client.put(f"/api/notebook/{child}", json={"title": "B"}, headers=_headers())
    after = client.get(f"/api/notebook/{parent}", headers=_headers()).json()
    assert after["body"] == "A 開頭的句子\n\nB"


def test_other_peoples_notes_are_not_touched(client):
    parent = _create(client, title="上層")["id"]
    child = _create(client, title="舊名", parent_id=parent)["id"]
    client.put(f"/api/notebook/{parent}", json={"body": "舊名", "doc": _page_link_doc(child, "舊名")}, headers=_headers())
    # 別人那一則剛好也有一個指到這個 id 的連結(不該發生,但不能被改)
    db = SessionLocal()
    try:
        other = models.UserNote(username=OTHER, title="別人的", body="舊名", doc=_page_link_doc(child, "舊名"), created_at=datetime.utcnow(), updated_at=datetime.utcnow())
        db.add(other)
        db.commit()
        other_id = other.id
    finally:
        db.close()
    client.put(f"/api/notebook/{child}", json={"title": "新名"}, headers=_headers())
    assert client.get(f"/api/notebook/{other_id}", headers=_headers(OTHER)).json()["body"] == "舊名"


def test_untitled_matches_the_frontend_word_for_word():
    """子頁連結沒有標題時,Markdown 裡寫的字前後端要一樣:前端畫連結、存 body 用 `notebookApi.ts` 的 UNTITLED,
    後端改名同步時(`_sync_page_links`)要認得那一行。對著前端原始碼比,不是對一份抄來的字面值(同 test_terminal_bridge 的
    test_close_messages_match_the_frontend_word_for_word)。"""
    import re
    from pathlib import Path

    from app.routers import notebook

    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "notebookApi.ts").read_text(encoding="utf-8")
    m = re.search(r"export const UNTITLED = '([^']*)';", src)
    assert m, "前端的 UNTITLED 解不出來 —— 它的寫法改了,這條測試要跟著改"
    assert notebook._UNTITLED == m.group(1)
