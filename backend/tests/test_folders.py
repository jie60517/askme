# -*- coding: utf-8 -*-
"""側邊欄資料夾(`routers/folders.py`)。

這五條端點的共通風險不是「會不會壞」,
而是壞掉的方式都很安靜:

  隔離 —— 每一條查詢都掛 `username == viewer`。漏掉一條的症狀是「別人的
  資料夾出現在我的側邊欄」,而且要兩個帳號同時在線才看得出來。
  刪除語意 —— 刪資料夾是**退回未歸類 + 子資料夾接到上一層**,不是連鎖刪除。
  寫成 cascade 的話,使用者刪一個標籤會發現對話跟著不見了。
  迴圈 —— 把 A 拖進自己的子資料夾,樹就畫不出來,側邊欄整個空白。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_folders.py
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, models
from app.database import Base, SessionLocal, engine
from app.main import app

ME = "folder-owner"
OTHER = "folder-stranger"
MY_CONV = "f" * 32
OTHER_CONV = "g" * 32


@pytest.fixture(autouse=True, scope="module")
def _tables():
    """理由同 test_soft_delete.py:建表在 lifespan 裡,而 fixture 比它早。"""
    Base.metadata.create_all(engine)


@pytest.fixture(autouse=True)
def _clean():
    """每一條都從空的開始,兩個帳號的資料都清。"""

    def wipe():
        db = SessionLocal()
        try:
            db.query(models.ConversationFolderItem).filter(
                models.ConversationFolderItem.username.in_([ME, OTHER])
            ).delete(synchronize_session=False)
            db.query(models.ConversationFolder).filter(
                models.ConversationFolder.username.in_([ME, OTHER])
            ).delete(synchronize_session=False)
            db.query(models.QARecord).filter(
                models.QARecord.conversation_id.in_([MY_CONV, OTHER_CONV])
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    wipe()
    yield
    wipe()


def _headers(username: str) -> dict:
    return {"Authorization": f"Bearer {auth._issue(username)}"}


def _seed_conversation(conversation_id: str, owner: str) -> None:
    """造一組對話 —— `shares.can_access` 是靠 `qa_records.owner` 判斷的。"""
    db = SessionLocal()
    try:
        db.add(
            models.QARecord(
                session_id=conversation_id[:31] + "1",
                conversation_id=conversation_id,
                question="問題",
                answer="答案",
                owner=owner,
                asked_by=owner,
                status="done",
            )
        )
        db.commit()
    finally:
        db.close()


def _make_folder(client, name: str, parent_id=None, who: str = ME) -> int:
    body = {"name": name}
    if parent_id is not None:
        body["parent_id"] = parent_id
    resp = client.post("/api/folders", json=body, headers=_headers(who))
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ── 建立與列出 ──────────────────────────────────────────────────────


def test_create_and_list_round_trip():
    with TestClient(app) as client:
        fid = _make_folder(client, "專案相關")
        data = client.get("/api/folders", headers=_headers(ME)).json()

    assert [f["name"] for f in data["folders"]] == ["專案相關"]
    assert data["folders"][0]["id"] == fid
    assert data["folders"][0]["parent_id"] is None
    assert data["items"] == {}


def test_folders_come_back_in_creation_order():
    """順序是 `created_at asc` —— 側邊欄不該每次重整就換位置。"""
    with TestClient(app) as client:
        _make_folder(client, "第一個")
        _make_folder(client, "第二個")
        _make_folder(client, "第三個")
        data = client.get("/api/folders", headers=_headers(ME)).json()

    assert [f["name"] for f in data["folders"]] == ["第一個", "第二個", "第三個"]


def test_blank_name_is_rejected():
    """只有空白的名字要擋 —— 側邊欄上會變成一個點不到的空白列。"""
    with TestClient(app) as client:
        resp = client.post("/api/folders", json={"name": "   "}, headers=_headers(ME))
    assert resp.status_code == 400


def test_name_is_trimmed():
    with TestClient(app) as client:
        fid = _make_folder(client, "  前後有空白  ")
        data = client.get("/api/folders", headers=_headers(ME)).json()
    assert [f["name"] for f in data["folders"] if f["id"] == fid] == ["前後有空白"]


# ── 隔離:別人的東西一律 404 ────────────────────────────────────────


def test_other_peoples_folders_are_invisible():
    with TestClient(app) as client:
        _make_folder(client, "別人的", who=OTHER)
        mine = client.get("/api/folders", headers=_headers(ME)).json()
    assert mine["folders"] == []


def test_cannot_rename_someone_elses_folder():
    """要的是 404 不是 403 —— 403 等於告訴對方那個 id 存在。"""
    with TestClient(app) as client:
        theirs = _make_folder(client, "別人的", who=OTHER)
        resp = client.patch(
            f"/api/folders/{theirs}", json={"name": "我改的"}, headers=_headers(ME)
        )
    assert resp.status_code == 404


def test_cannot_delete_someone_elses_folder():
    with TestClient(app) as client:
        theirs = _make_folder(client, "別人的", who=OTHER)
        resp = client.delete(f"/api/folders/{theirs}", headers=_headers(ME))
        assert resp.status_code == 404
        # 真的還在
        still = client.get("/api/folders", headers=_headers(OTHER)).json()
    assert [f["id"] for f in still["folders"]] == [theirs]


def test_cannot_nest_under_someone_elses_folder():
    """掛在別人的資料夾底下沒有意義,而且會讓對方的樹長出看不見的枝。"""
    with TestClient(app) as client:
        theirs = _make_folder(client, "別人的", who=OTHER)
        resp = client.post(
            "/api/folders", json={"name": "我的", "parent_id": theirs}, headers=_headers(ME)
        )
    assert resp.status_code == 404


# ── 搬動與迴圈 ──────────────────────────────────────────────────────


def test_moving_to_top_level_needs_an_explicit_null():
    """`parent_id` **沒帶 = 不動**,帶 null = 搬回頂層。

    這兩者分不出來的話,使用者改個名字就會把資料夾從巢狀結構裡彈回頂層。
    """
    with TestClient(app) as client:
        parent = _make_folder(client, "上層")
        child = _make_folder(client, "下層", parent_id=parent)

        # 只改名字:parent_id 不該動
        client.patch(f"/api/folders/{child}", json={"name": "改過名"}, headers=_headers(ME))
        after_rename = client.get("/api/folders", headers=_headers(ME)).json()
        moved = [f for f in after_rename["folders"] if f["id"] == child][0]
        assert moved["parent_id"] == parent, "只改名字卻把它搬走了"

        # 明確帶 null:搬回頂層
        client.patch(f"/api/folders/{child}", json={"parent_id": None}, headers=_headers(ME))
        after_move = client.get("/api/folders", headers=_headers(ME)).json()
        moved = [f for f in after_move["folders"] if f["id"] == child][0]
        assert moved["parent_id"] is None


def test_cannot_move_a_folder_into_itself():
    with TestClient(app) as client:
        fid = _make_folder(client, "自己")
        resp = client.patch(
            f"/api/folders/{fid}", json={"parent_id": fid}, headers=_headers(ME)
        )
    assert resp.status_code == 400


def test_cannot_move_a_folder_into_its_own_descendant():
    """A → B → C,把 A 拖進 C。

    擋不住的話兩邊互為祖先,側邊欄那棵樹畫不出來,整個側邊欄空白。
    """
    with TestClient(app) as client:
        a = _make_folder(client, "A")
        b = _make_folder(client, "B", parent_id=a)
        c = _make_folder(client, "C", parent_id=b)
        resp = client.patch(f"/api/folders/{a}", json={"parent_id": c}, headers=_headers(ME))
    assert resp.status_code == 400


def test_a_legal_move_still_works():
    """擋迴圈不能連正常的搬動一起擋掉(把子樹搬到別的分支是合法的)。"""
    with TestClient(app) as client:
        a = _make_folder(client, "A")
        b = _make_folder(client, "B", parent_id=a)
        elsewhere = _make_folder(client, "另一支")
        resp = client.patch(
            f"/api/folders/{b}", json={"parent_id": elsewhere}, headers=_headers(ME)
        )
        assert resp.status_code == 200
    assert resp.json()["parent_id"] == elsewhere


# ── 刪除的語意:退回未歸類,不是連鎖刪 ──────────────────────────────


def test_deleting_a_folder_promotes_its_children():
    """子資料夾接到上一層,不連鎖刪 —— 刪一層不該把整棵子樹掃掉。"""
    with TestClient(app) as client:
        top = _make_folder(client, "上層")
        middle = _make_folder(client, "中間", parent_id=top)
        leaf = _make_folder(client, "葉子", parent_id=middle)

        assert client.delete(f"/api/folders/{middle}", headers=_headers(ME)).status_code == 204

        data = client.get("/api/folders", headers=_headers(ME)).json()

    ids = {f["id"]: f["parent_id"] for f in data["folders"]}
    assert middle not in ids
    assert leaf in ids, "刪中間那層把葉子一起刪掉了 —— 應該是接到上一層"
    assert ids[leaf] == top


def test_deleting_a_folder_keeps_the_conversations():
    """裡面的對話退回未歸類,**對話本身不動**。

    這是整支 router 的 docstring 特別寫明的語意:資料夾只是標籤,刪標籤
    不該讓人以為對話跟著沒了。
    """
    _seed_conversation(MY_CONV, ME)

    with TestClient(app) as client:
        fid = _make_folder(client, "要刪的")
        assert (
            client.put(
                f"/api/conversations/{MY_CONV}/folder",
                json={"folder_id": fid},
                headers=_headers(ME),
            ).status_code
            == 204
        )
        assert client.get("/api/folders", headers=_headers(ME)).json()["items"] == {MY_CONV: fid}

        assert client.delete(f"/api/folders/{fid}", headers=_headers(ME)).status_code == 204
        data = client.get("/api/folders", headers=_headers(ME)).json()

    assert data["items"] == {}, "歸類沒清掉,側邊欄會指向一個不存在的資料夾"

    db = SessionLocal()
    survived = (
        db.query(models.QARecord).filter(models.QARecord.conversation_id == MY_CONV).count()
    )
    db.close()
    assert survived == 1, "刪資料夾把對話一起刪了 —— 這是連鎖刪除,不是這支的語意"


# ── 把對話歸進資料夾 ────────────────────────────────────────────────


def test_cannot_file_a_conversation_you_cannot_see():
    """看不到的對話回 404,跟 conversations.py 同一個理由:403 等於確認它存在。"""
    _seed_conversation(OTHER_CONV, OTHER)

    with TestClient(app) as client:
        fid = _make_folder(client, "我的")
        resp = client.put(
            f"/api/conversations/{OTHER_CONV}/folder",
            json={"folder_id": fid},
            headers=_headers(ME),
        )
    assert resp.status_code == 404


def test_cannot_file_into_someone_elses_folder():
    _seed_conversation(MY_CONV, ME)

    with TestClient(app) as client:
        theirs = _make_folder(client, "別人的", who=OTHER)
        resp = client.put(
            f"/api/conversations/{MY_CONV}/folder",
            json={"folder_id": theirs},
            headers=_headers(ME),
        )
    assert resp.status_code == 404


def test_refiling_moves_instead_of_duplicating():
    """換一個資料夾是搬,不是多一筆。

    主鍵是 (username, conversation_id),寫成 insert 的話第二次會撞主鍵 500。
    """
    _seed_conversation(MY_CONV, ME)

    with TestClient(app) as client:
        first = _make_folder(client, "第一個")
        second = _make_folder(client, "第二個")
        client.put(
            f"/api/conversations/{MY_CONV}/folder",
            json={"folder_id": first},
            headers=_headers(ME),
        )
        resp = client.put(
            f"/api/conversations/{MY_CONV}/folder",
            json={"folder_id": second},
            headers=_headers(ME),
        )
        assert resp.status_code == 204
        data = client.get("/api/folders", headers=_headers(ME)).json()

    assert data["items"] == {MY_CONV: second}


def test_unfiling_works_even_for_an_unreachable_conversation():
    """移出**不檢查**對話還看不看得到。

    對話可能剛被取消共用,那筆歸類已經是孤兒 —— 「拿掉它」正是使用者要的
    結果。這裡故意不造那組對話,模擬「已經看不到了」。
    """
    db = SessionLocal()
    db.add(
        models.ConversationFolderItem(username=ME, conversation_id=OTHER_CONV, folder_id=1)
    )
    # folder_id=1 未必存在也沒關係:移出那條路根本不會去查資料夾
    db.commit()
    db.close()

    with TestClient(app) as client:
        resp = client.put(
            f"/api/conversations/{OTHER_CONV}/folder",
            json={"folder_id": None},
            headers=_headers(ME),
        )
        assert resp.status_code == 204
        data = client.get("/api/folders", headers=_headers(ME)).json()

    assert OTHER_CONV not in data["items"]


def test_folders_require_a_login():
    """整組都要登入 —— 沒登入拿到的不該是別人的樹,也不該是空的 200。"""
    with TestClient(app) as client:
        assert client.get("/api/folders").status_code == 401
