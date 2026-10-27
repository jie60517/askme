# -*- coding: utf-8 -*-
"""個人筆記(`routers/notebook.py`)。

守的東西照風險排:
  隔離 —— 筆記是私人的。每一條查詢都掛 `username == viewer`,漏一條的症狀是
  「別人的筆記出現在我的清單」,要兩個帳號同時在線才看得出來。圖片網址收 cookie,更要守。
  從對話存 —— 後端自己讀那一題;沒分享給你的對話存不進來(不然等於拿筆記當後門讀別人的問答)。
  上限 —— 四項,超過時原本那份不能被動到。
  版本 —— 兩個分頁同時改,舊的那邊存不進去(409)。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_notebook.py
"""
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import auth, config, models, shares
from app.database import Base, SessionLocal, engine
from app.main import app

ME = "notebook-owner"
OTHER = "notebook-stranger"
MY_CONV = "n" * 32
OTHER_CONV = "m" * 32

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_folders.py:建表在 lifespan 裡,而 fixture 比它早。"""
    Base.metadata.create_all(engine)


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "NOTEBOOK_DIR", tmp_path / "notebook")
    # 功能預設開,但本機 .env 可能關著;這一檔測的是開著時的行為,關著的那條另外測
    monkeypatch.setattr(config, "NOTEBOOK_ENABLED", True)

    def wipe():
        db = SessionLocal()
        try:
            for model in (models.UserNote, models.UserNoteImage):
                db.query(model).filter(model.username.in_([ME, OTHER])).delete(
                    synchronize_session=False
                )
            db.query(models.QARecord).filter(
                models.QARecord.conversation_id.in_([MY_CONV, OTHER_CONV])
            ).delete(synchronize_session=False)
            db.query(models.ConversationShare).filter(
                models.ConversationShare.conversation_id.in_([MY_CONV, OTHER_CONV])
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    wipe()
    yield
    wipe()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _headers(username: str = ME) -> dict:
    return {"Authorization": f"Bearer {auth._issue(username)}"}


def _seed_qa(conversation_id: str, owner: str, question="採購單要怎麼轉成驗收單?\n只驗一部分可以嗎", answer="可以部分驗收。\n\n| 欄位 | 填法 |\n|---|---|\n| 收貨 | 實收 |") -> int:
    db = SessionLocal()
    try:
        qa = models.QARecord(
            session_id=f"{conversation_id[:24]}{datetime.utcnow().microsecond:08d}",
            conversation_id=conversation_id,
            question=question,
            answer=answer,
            owner=owner,
            asked_by=owner,
            status="done",
        )
        db.add(qa)
        db.commit()
        return qa.id
    finally:
        db.close()


def _create(client, who=ME, **body) -> dict:
    resp = client.post("/api/notebook", json=body, headers=_headers(who))
    assert resp.status_code == 201, resp.text
    return resp.json()


# ------------------------------------------------------------------ 自己寫的
def test_turned_off_hides_everything(client, monkeypatch):
    """功能關著(NOTEBOOK_ENABLED=0)時:/api/me 說沒有、整組 API 當作不存在。"""
    monkeypatch.setattr(config, "NOTEBOOK_ENABLED", False)
    assert client.get("/api/me", headers=_headers()).json()["can_notebook"] is False
    assert client.get("/api/notebook", headers=_headers()).status_code == 404
    assert client.post("/api/notebook", headers=_headers(), json={}).status_code == 404
    monkeypatch.setattr(config, "NOTEBOOK_ENABLED", True)
    assert client.get("/api/me", headers=_headers()).json()["can_notebook"] is True


def test_create_read_update_list(client):
    note = _create(client, title="專案B上線待辦", body="1. orders 模組\n2. billing 稅率")
    assert note["source_kind"] is None and note["source_available"] is None

    got = client.get(f"/api/notebook/{note['id']}", headers=_headers()).json()
    assert got["body"].startswith("1. orders")

    resp = client.put(
        f"/api/notebook/{note['id']}",
        json={"title": "改過的標題", "body": "新的內容", "base_updated_at": got["updated_at"]},
        headers=_headers(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "改過的標題"

    items = client.get("/api/notebook", headers=_headers()).json()
    assert [i["title"] for i in items] == ["改過的標題"]
    assert items[0]["summary"] == "新的內容"


def test_list_is_newest_first_and_summary_strips_markdown(client):
    _create(client, title="舊的", body="x")
    _create(client, title="新的", body="> 引用的字  \n\n| a | b |\n|---|---|\n**粗體** ![](notebook-image:" + "a" * 32 + ")")
    items = client.get("/api/notebook", headers=_headers()).json()
    assert [i["title"] for i in items] == ["新的", "舊的"]
    assert items[0]["summary"] == "引用的字 a | b 粗體"


def test_summary_strips_task_markers(client):
    _create(client, title="待辦", body="## 上線前\n\n- [x] orders 模組\n- [ ] 權限設定\n- [ ]")
    assert client.get("/api/notebook", headers=_headers()).json()[0]["summary"] == "上線前 orders 模組 權限設定"


def test_summary_skips_code_blocks(client):
    _create(client, title="有程式碼", body='```chart\n{"type":"bar"}\n```\n結論在這裡\n```sql\nSELECT 1')
    assert client.get("/api/notebook", headers=_headers()).json()[0]["summary"] == "結論在這裡"


def test_search_matches_title_and_body_and_treats_percent_literally(client):
    _create(client, title="billing 稅率", body="")
    _create(client, title="別的", body="內文提到 billing")
    _create(client, title="完全無關", body="100% 完成")
    titles = lambda q: sorted(i["title"] for i in client.get("/api/notebook", params={"q": q}, headers=_headers()).json())
    assert titles("billing") == ["billing 稅率", "別的"]
    assert titles("BILLING") == ["billing 稅率", "別的"], "搜尋不分大小寫"
    assert titles("%") == ["完全無關"], "% 要當字面值,不能變成萬用字元"


# ------------------------------------------------------------------ 隔離
def test_other_user_cannot_see_or_touch_my_note(client):
    note = _create(client, title="私人的", body="只有我看得到")
    nid = note["id"]
    assert client.get("/api/notebook", headers=_headers(OTHER)).json() == []
    assert client.get(f"/api/notebook/{nid}", headers=_headers(OTHER)).status_code == 404
    assert (
        client.put(f"/api/notebook/{nid}", json={"title": "x", "body": "y"}, headers=_headers(OTHER)).status_code
        == 404
    )
    assert client.delete(f"/api/notebook/{nid}", headers=_headers(OTHER)).status_code == 404
    assert client.get(f"/api/notebook/{nid}", headers=_headers()).json()["body"] == "只有我看得到"


def test_images_are_owner_only_even_with_cookie(client):
    nid = _create(client, title="有圖")["id"]
    resp = client.post(
        f"/api/notebook/{nid}/images", files={"file": ("a.png", PNG, "image/png")}, headers=_headers()
    )
    assert resp.status_code == 201, resp.text
    image = resp.json()
    assert image["ref"] == f"![](notebook-image:{image['id']})"

    # 自己:cookie 也拿得到(<img src> 帶不了標頭)
    client.cookies.set(auth.SESSION_COOKIE, auth._issue(ME), path="/api")
    got = client.get(f"/api/notebook/images/{image['id']}")
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["content-type"] == "image/png"
    client.cookies.clear()

    assert client.get(f"/api/notebook/images/{image['id']}", headers=_headers(OTHER)).status_code == 404
    assert (
        client.post(f"/api/notebook/{nid}/images", files={"file": ("a.png", PNG)}, headers=_headers(OTHER)).status_code
        == 404
    )


# ------------------------------------------------------------------ 從對話存
def test_save_whole_qa_copies_question_and_answer(client):
    qa_id = _seed_qa(MY_CONV, ME)
    note = _create(client, source={"kind": "qa", "qa_id": qa_id})
    assert note["title"] == "採購單要怎麼轉成驗收單?"
    assert note["body"] == (
        "> 採購單要怎麼轉成驗收單?  \n> 只驗一部分可以嗎  \n\n"
        "可以部分驗收。\n\n| 欄位 | 填法 |\n|---|---|\n| 收貨 | 實收 |"
    )
    assert note["source_kind"] == "qa"
    assert note["source_conversation_id"] == MY_CONV
    assert note["source_available"] is True


def test_save_selection_quotes_it_and_leaves_room(client):
    qa_id = _seed_qa(MY_CONV, ME)
    note = _create(client, source={"kind": "selection", "qa_id": qa_id, "text": "  把實收的數量改成實際的數字\n第二行 "})
    assert note["body"] == "> 把實收的數量改成實際的數字  \n> 第二行  \n\n"
    assert note["title"] == "把實收的數量改成實際的數字"
    assert client.post(
        "/api/notebook", json={"source": {"kind": "selection", "qa_id": qa_id, "text": "  "}}, headers=_headers()
    ).status_code == 422


def test_cannot_save_from_a_conversation_you_cannot_see(client):
    qa_id = _seed_qa(OTHER_CONV, OTHER)
    resp = client.post("/api/notebook", json={"source": {"kind": "qa", "qa_id": qa_id}}, headers=_headers())
    assert resp.status_code == 404
    assert client.get("/api/notebook", headers=_headers()).json() == []

    # 分享給我之後就可以
    db = SessionLocal()
    try:
        shares.add(db, OTHER_CONV, ME, shared_by=OTHER)
    finally:
        db.close()
    assert _create(client, source={"kind": "qa", "qa_id": qa_id})["source_available"] is True


def test_deleted_conversation_keeps_the_note_but_marks_source_gone(client):
    qa_id = _seed_qa(MY_CONV, ME)
    nid = _create(client, source={"kind": "qa", "qa_id": qa_id})["id"]
    db = SessionLocal()
    try:
        db.query(models.QARecord).filter(models.QARecord.id == qa_id).update({"deleted_at": datetime.utcnow()})
        db.commit()
    finally:
        db.close()
    got = client.get(f"/api/notebook/{nid}", headers=_headers()).json()
    assert got["source_available"] is False
    assert "可以部分驗收" in got["body"], "存的是複製一份,原對話刪掉內容還在"


def test_saved_lists_qa_ids_in_this_conversation_for_me_only(client):
    a = _seed_qa(MY_CONV, ME)
    b = _seed_qa(MY_CONV, ME, question="第二題")
    _create(client, source={"kind": "qa", "qa_id": b})
    _create(client, source={"kind": "selection", "qa_id": b, "text": "一段"})
    get = lambda who: client.get("/api/notebook/saved", params={"conversation_id": MY_CONV}, headers=_headers(who)).json()
    assert get(ME) == [b]
    assert a not in get(ME)
    assert get(OTHER) == []


def test_screenshot_creates_a_note_with_the_image(client):
    qa_id = _seed_qa(MY_CONV, ME)
    resp = client.post(
        "/api/notebook/screenshot",
        data={"qa_id": str(qa_id)},
        files={"file": ("shot.png", PNG, "image/png")},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["source_kind"] == "screenshot"
    assert note["title"] == "採購單要怎麼轉成驗收單?"
    image_id = note["body"].split("notebook-image:")[1][:32]
    assert (config.NOTEBOOK_DIR / f"{image_id}.png").read_bytes() == PNG


def test_screenshot_that_fails_leaves_no_empty_note(client):
    qa_id = _seed_qa(MY_CONV, ME)
    resp = client.post(
        "/api/notebook/screenshot", data={"qa_id": str(qa_id)}, files={"file": ("x.png", b"not an image")}, headers=_headers()
    )
    assert resp.status_code == 415
    assert client.get("/api/notebook", headers=_headers()).json() == []


def test_screenshot_never_commits_an_empty_note(client, monkeypatch):
    """筆記 + 圖 + 內文是**一次**提交:存圖時就先提交的話,空內文的筆記會先寫進去,
    後面那次提交失敗就留下一則空筆記。這裡在每次提交時看:session 裡有沒有內文還是空的截圖筆記。"""
    from sqlalchemy.orm import Session

    qa_id = _seed_qa(MY_CONV, ME)
    real_commit = Session.commit

    def guarded_commit(self):
        for obj in self.identity_map.values():
            if isinstance(obj, models.UserNote) and obj.source_kind == "screenshot" and not obj.body:
                raise AssertionError("內文還是空的就提交了")
        return real_commit(self)

    monkeypatch.setattr(Session, "commit", guarded_commit)
    resp = client.post(
        "/api/notebook/screenshot",
        data={"qa_id": str(qa_id)},
        files={"file": ("shot.png", PNG, "image/png")},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert "notebook-image:" in resp.json()["body"]


# ------------------------------------------------------------------ 刪除
def _purge_as_if_expired(client, nid):
    """把軟刪除的時間往前推到超過保留天數,再讀一次清單觸發清除。"""
    db = SessionLocal()
    try:
        db.query(models.UserNote).filter(models.UserNote.id == nid).update(
            {"deleted_at": datetime.utcnow() - timedelta(days=config.NOTEBOOK_TRASH_DAYS + 1)}
        )
        db.commit()
    finally:
        db.close()
    assert client.get("/api/notebook", headers=_headers()).status_code == 200


def test_delete_is_soft_and_expired_trash_removes_image_files(client):
    """刪除是軟刪除(圖還在、可以復原);超過保留天數被清掉時才真的刪檔。"""
    nid = _create(client, title="要刪的")["id"]
    image = client.post(f"/api/notebook/{nid}/images", files={"file": ("a.jpg", JPG)}, headers=_headers()).json()
    path = config.NOTEBOOK_DIR / f"{image['id']}.jpg"
    assert path.is_file()
    assert client.delete(f"/api/notebook/{nid}", headers=_headers()).status_code == 204
    assert path.is_file()
    assert client.get(f"/api/notebook/{nid}", headers=_headers()).status_code == 404
    _purge_as_if_expired(client, nid)
    assert not path.exists()
    assert client.post(f"/api/notebook/{nid}/restore", headers=_headers()).status_code == 404


def test_image_copied_to_another_note_survives_deleting_the_original(client):
    """參照被複製到別則(自己複製貼上)→ 刪原本那則,圖要留著、改掛到別則。"""
    first = _create(client, title="原本")["id"]
    image = client.post(f"/api/notebook/{first}/images", files={"file": ("a.png", PNG)}, headers=_headers()).json()
    second = _create(client, title="合併", body=f"抄過來的\n\n{image['ref']}\n")["id"]
    assert client.delete(f"/api/notebook/{first}", headers=_headers()).status_code == 204
    _purge_as_if_expired(client, first)
    assert (config.NOTEBOOK_DIR / f"{image['id']}.png").is_file()
    client.cookies.set(auth.SESSION_COOKIE, auth._issue(ME), path="/api")
    assert client.get(f"/api/notebook/images/{image['id']}").status_code == 200
    client.cookies.clear()
    # 再刪掉用著它的那一則:這次真的刪
    assert client.delete(f"/api/notebook/{second}", headers=_headers()).status_code == 204
    _purge_as_if_expired(client, second)
    assert not (config.NOTEBOOK_DIR / f"{image['id']}.png").exists()


def test_list_marks_notes_with_images(client):
    plain = _create(client, title="純文字")["id"]
    with_image = _create(client, title="有圖", body="x" * 2000 + "\n\n![](notebook-image:" + "b" * 32 + ")")["id"]
    flags = {i["id"]: i["has_image"] for i in client.get("/api/notebook", headers=_headers()).json()}
    assert flags == {plain: False, with_image: True}, "圖在內文很後面也要認得出來"


# ------------------------------------------------------------------ 上限
def test_body_limit_on_create_and_update_keeps_old_version(client, monkeypatch):
    monkeypatch.setattr(config, "NOTEBOOK_MAX_BODY_BYTES", 10)
    assert client.post("/api/notebook", json={"body": "一二三四"}, headers=_headers()).status_code == 413
    note = _create(client, body="短")
    resp = client.put(f"/api/notebook/{note['id']}", json={"title": "", "body": "一二三四"}, headers=_headers())
    assert resp.status_code == 413
    assert client.get(f"/api/notebook/{note['id']}", headers=_headers()).json()["body"] == "短"


def test_note_count_limit(client, monkeypatch):
    monkeypatch.setattr(config, "NOTEBOOK_MAX_NOTES", 2)
    _create(client)
    _create(client)
    assert client.post("/api/notebook", json={}, headers=_headers()).status_code == 413
    # 別人不受我的數量影響
    _create(client, who=OTHER)


def test_image_size_type_and_total_limits(client, monkeypatch):
    nid = _create(client)["id"]
    post = lambda data: client.post(f"/api/notebook/{nid}/images", files={"file": ("f", data)}, headers=_headers())
    assert post(b"GIF89a" + b"\x00" * 10).status_code == 415

    monkeypatch.setattr(config, "NOTEBOOK_MAX_IMAGE_BYTES", 32)
    assert post(PNG).status_code == 413

    monkeypatch.setattr(config, "NOTEBOOK_MAX_IMAGE_BYTES", 1024)
    monkeypatch.setattr(config, "NOTEBOOK_MAX_IMAGE_TOTAL_BYTES", len(PNG) * 2)
    assert post(PNG).status_code == 201
    assert post(PNG).status_code == 201
    assert post(PNG).status_code == 413


# ------------------------------------------------------------------ 版本(兩個分頁)
def test_stale_tab_gets_409_and_does_not_overwrite(client):
    note = _create(client, body="原本")
    base = note["updated_at"]
    first = client.put(f"/api/notebook/{note['id']}", json={"title": "", "body": "分頁 A", "base_updated_at": base}, headers=_headers())
    assert first.status_code == 200
    stale = client.put(f"/api/notebook/{note['id']}", json={"title": "", "body": "分頁 B", "base_updated_at": base}, headers=_headers())
    assert stale.status_code == 409
    assert client.get(f"/api/notebook/{note['id']}", headers=_headers()).json()["body"] == "分頁 A"


def test_no_collab_websocket(client):
    """不支援多人同時編輯:不能掛著 `/live` WebSocket,那會讓任何登入者都能拿來吃伺服器記憶體。"""
    assert not [r.path for r in app.routes if getattr(r, "path", "").endswith("/live")]
    note = _create(client, title="單人")["id"]
    with pytest.raises(Exception):
        with client.websocket_connect(f"/api/notebook/{note}/live") as ws:
            ws.receive_text()
