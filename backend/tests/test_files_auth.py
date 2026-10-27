# -*- coding: utf-8 -*-
"""檔案路徑(下載/縮圖/預覽)要登入,**而且要看得到那組對話**。

網址會被複製、貼進聊天室、留在瀏覽器紀錄與 nginx log,「session_id 猜不到」不能當成保護。
所以有兩層:

第一層 —— 要登入:登出之後把 `/api/files/{sid}/{檔名}` 貼進網址列不能下載得到。

第二層 —— 要看得到那組對話:先把 session_id 換回它屬於哪組對話,再走
conversations.visible_to。只檢查登入的話,任何人拿到網址就下載得到別人的檔案,
**取消共用之後也照樣下載得到**。

要放寬之前先想清楚:網址本身不是秘密。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_files_auth.py
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, models
from app.database import SessionLocal
from app.main import app

SID = "0" * 32
NAME = "conversation.md"
CONV = "c" * 32


@pytest.fixture
def outfile():
    """在 outputs/ 底下放一個真的檔案,測試結束刪掉。

    要放真的檔案:不然 404(找不到檔案)會蓋過 401(沒登入),
    測試就算通過也證明不了任何事。
    """
    path = config.OUTPUT_DIR / SID / NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("hello", encoding="utf-8")
    yield path
    path.unlink(missing_ok=True)
    path.parent.rmdir()


@pytest.fixture
def record():
    """一筆屬於 tester 的問答紀錄,session_id 就是上面那個 SID。

    ⚠️ 沒有對應紀錄的 session_id 一律 404(對話刪掉只剩殘檔的情況也走這條),所以測「拿得到」的案例
    一定要先有紀錄,不然測到的是 404 而不是權限。
    """
    db = SessionLocal()
    row = models.QARecord(
        session_id=SID,
        conversation_id=CONV,
        question="q",
        answer="a",
        owner="tester",
    )
    db.add(row)
    db.commit()
    yield row
    db.query(models.ConversationShare).filter(
        models.ConversationShare.conversation_id == CONV
    ).delete()
    db.query(models.QARecord).filter(models.QARecord.session_id == SID).delete()
    db.commit()
    db.close()


@pytest.mark.parametrize(
    "url",
    [
        f"/api/files/{SID}/{NAME}",
        f"/api/uploads/{SID}/{NAME}",
        f"/api/preview/files/{SID}/{NAME}",
    ],
)
def test_anonymous_is_refused(url, outfile):
    with TestClient(app) as client:
        resp = client.get(url)
    assert resp.status_code in (401, 403), (
        f"{url} 對未登入的人回了 {resp.status_code} —— 檔案匿名下載得到"
    )


def test_bearer_token_works(outfile, record):
    """axios 那條路(Authorization 標頭)還通。"""
    with TestClient(app) as client:
        token = auth._issue("tester")
        resp = client.get(
            f"/api/files/{SID}/{NAME}", headers={"Authorization": f"Bearer {token}"}
        )
    assert resp.status_code == 200
    assert resp.text == "hello"


def test_cookie_works(outfile, record):
    """`<a href>` / `<img src>` 那條路(cookie)。

    那兩種標籤帶不了 Authorization 標頭,
    所以認證非得有 cookie 這條路,否則下載只能整個開放或整個壞掉。
    """
    with TestClient(app) as client:
        token = auth._issue("tester")
        client.cookies.set(auth.SESSION_COOKIE, token)
        resp = client.get(f"/api/files/{SID}/{NAME}")
    assert resp.status_code == 200
    assert resp.text == "hello"


@pytest.mark.parametrize(
    "url",
    [
        f"/api/files/{SID}/{NAME}",
        f"/api/uploads/{SID}/{NAME}",
        f"/api/preview/files/{SID}/{NAME}",
    ],
)
def test_another_logged_in_user_is_refused(url, outfile, record):
    """**這一條是第二層的重點。** 別人登入了、檔案也真的在磁碟上,還是不能拿。

    404 而不是 403 —— 不要順便確認「這個 session_id 存在」。
    """
    with TestClient(app) as client:
        token = auth._issue("somebody-else")
        client.cookies.set(auth.SESSION_COOKIE, token)
        resp = client.get(url)
    assert resp.status_code == 404, (
        f"{url} 讓非本人的登入者拿到了 {resp.status_code} —— 檔案沒有做到「只有看得到的人」"
    )


def test_shared_user_can_read(outfile, record):
    """共用給誰,誰就拿得到 —— 這條在守「別修過頭」。

    權限收緊最常見的失敗不是漏擋,是把合法的人一起擋掉:共用對話裡
    同事看得到對話卻下載不了附件的話,共用功能等於半殘。
    """
    db = SessionLocal()
    db.add(
        models.ConversationShare(
            conversation_id=CONV, username="colleague", shared_by="tester"
        )
    )
    db.commit()
    db.close()

    with TestClient(app) as client:
        token = auth._issue("colleague")
        client.cookies.set(auth.SESSION_COOKIE, token)
        resp = client.get(f"/api/files/{SID}/{NAME}")
    assert resp.status_code == 200
    assert resp.text == "hello"


def test_orphan_file_without_a_record_is_refused(outfile):
    """對話刪掉了、磁碟上還留著檔案 —— 那些不該再被拿到。

    刪對話只刪資料庫的列,uploads/{sid}/ 與 outputs/{sid}/ 沒有任何東西會清,
    所以至少網址要失效。
    這裡刻意**不用** record fixture,模擬的就是「只剩殘檔」。
    """
    with TestClient(app) as client:
        token = auth._issue("tester")
        client.cookies.set(auth.SESSION_COOKIE, token)
        resp = client.get(f"/api/files/{SID}/{NAME}")
    assert resp.status_code == 404


def test_login_hands_out_the_cookie(monkeypatch):
    """登入的回應要真的把 cookie 種下去,不然上面那條路沒人走得到。"""
    monkeypatch.setattr(config, "ADMIN_USERNAME", "admin")
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "pw-for-test")
    with TestClient(app) as client:
        resp = client.post("/api/login", json={"username": "admin", "password": "pw-for-test"})
    assert resp.status_code == 200
    cookie = resp.cookies.get(auth.SESSION_COOKIE)
    assert cookie, "登入沒有發下載用的 cookie"
    assert cookie == resp.json()["token"], "cookie 跟 token 應該是同一串(不是第二種身分)"
    # HttpOnly 一定要在:JS 讀得到的話,一個 XSS 就等於把下載權限也交出去
    assert "httponly" in resp.headers.get("set-cookie", "").lower()
