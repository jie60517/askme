# -*- coding: utf-8 -*-
"""不要讓輪詢與收尾卡住事件迴圈。

服務只有一個 uvicorn 行程,事件迴圈上任何同步的重活都會讓**所有人**的串流停住。

1. `users.display_names()`:側欄每 8 秒的 `GET /api/conversations` 都會呼叫它。
   它不能從 `list_users()` 濾出來:那會對每個「從沒改過密碼」的帳號跑一次 PBKDF2
   (~270ms),還把每張頭像(最多 30 萬字元)讀出來再丟掉。
2. `ask._finalize`:產 docx/pdf/pptx/xlsx/zip 全是同步的,所以在工作執行緒裡跑;
   從執行緒 emit 的事件訂閱者要收得到,而收尾不能被取消打斷。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_event_loop_cost.py
"""

import asyncio
import threading
import time

import pytest

from app import config, models, runs, users
from app.database import Base, SessionLocal, engine
from app.routers import ask

Base.metadata.create_all(bind=engine)


def _put_user(username: str, *, disabled: bool = False, display_name=None, role=None):
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username == username).delete()
        db.add(
            models.User(
                username=username,
                password="x",
                display_name=display_name,
                role=role,
                disabled=disabled,
                password_changed_at=None,  # 從沒改過 —— 走 list_users() 會對它跑 PBKDF2
            )
        )
        db.commit()
    finally:
        db.close()


@pytest.fixture
def accounts(monkeypatch):
    monkeypatch.setattr(config, "DEFAULT_USER_PASSWORD", "初始密碼")
    monkeypatch.setattr(config, "ADMIN_USERNAME", "poll_admin")
    _put_user("poll_a", display_name="小明")
    _put_user("poll_b")  # 沒有顯示名稱 → 退回 username
    _put_user("poll_off", display_name="停用的人", disabled=True)
    yield
    db = SessionLocal()
    try:
        db.query(models.User).filter(models.User.username.like("poll_%")).delete(
            synchronize_session=False
        )
        db.commit()
    finally:
        db.close()


def test_display_names_不比對密碼也不讀頭像(accounts, monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("display_names 不該走到這裡")

    monkeypatch.setattr(users, "_matches", boom)
    monkeypatch.setattr(users, "_avatars_by_username", boom)

    names = users.display_names()
    assert names["poll_a"] == "小明"
    assert names["poll_b"] == "poll_b"
    assert names["poll_admin"] == "poll_admin"
    assert "poll_off" not in names


def test_list_active_仍帶頭像與職稱且不比對密碼(accounts, monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("list_active 不該比對預設密碼")

    monkeypatch.setattr(users, "_matches", boom)
    monkeypatch.setattr(users, "_avatars_by_username", lambda: {"poll_a": "data:image/png;base64,AA"})

    mine = [u for u in users.list_active() if u["username"].startswith("poll_")]
    assert [u["username"] for u in mine] == ["poll_a", "poll_admin", "poll_b"]
    by_name = {u["username"]: u for u in mine}
    assert by_name["poll_a"]["avatar"] == "data:image/png;base64,AA"
    assert by_name["poll_b"]["avatar"] is None
    assert by_name["poll_b"]["role"] == users.DEFAULT_ROLE
    assert by_name["poll_admin"]["role"] == users.ADMIN_ROLE
    # 一般帳號也打得到這份清單,不能多帶權限或密碼狀態出去
    assert set(by_name["poll_a"]) == {"username", "display_name", "role", "avatar"}


def test_從工作執行緒_emit_訂閱者收得到():
    async def main():
        run = runs.Run("run-thread", "conv-thread", 1, "q")
        got = []

        async def consume():
            async for event in run.follow():
                got.append(event["type"])

        follower = asyncio.create_task(consume())
        await asyncio.sleep(0)  # 讓訂閱者先掛上等待

        def from_thread():
            time.sleep(0.05)
            run.emit({"type": "notice"})
            time.sleep(0.05)
            run.emit({"type": "done"})
            run.finish()

        # ⚠️ 用裸的 threading.Thread,不要用 asyncio.to_thread:to_thread 結束時
        # 本身會叫醒迴圈,錯的寫法(執行緒裡直接 Event.set())也會碰巧過關。
        # 這裡迴圈上沒有任何別的事,叫醒只能靠 emit 自己 —— 叫不醒的話要等到
        # wait_for 的計時器響才動得了,所以量時間。
        threading.Thread(target=from_thread).start()
        started = time.monotonic()
        await asyncio.wait_for(follower, timeout=3)
        return got, time.monotonic() - started

    got, elapsed = asyncio.run(main())
    assert got == ["notice", "done"]
    assert elapsed < 1.0


def test_收尾在工作執行緒跑_而且取消打不斷(monkeypatch):
    seen = {}

    def slow_finalize(run, result):
        seen["thread"] = threading.get_ident()
        time.sleep(0.2)
        seen["finished"] = True

    monkeypatch.setattr(ask, "_finalize", slow_finalize)

    async def main():
        loop_thread = threading.get_ident()
        run = runs.Run("run-off", "conv-off", 1, "q")
        task = asyncio.create_task(ask._finalize_off_loop(run, {}))
        await asyncio.sleep(0.05)
        # 使用者在收尾那幾秒按停止(runs.Run.request_stop 會先立這個旗標再 cancel)
        run.stop_requested = True
        task.cancel()
        await task  # 答案已經答完,沒東西可停:取消吞掉,不丟 CancelledError
        return loop_thread

    loop_thread = asyncio.run(main())
    assert seen["finished"] is True
    assert seen["thread"] != loop_thread


def test_服務收攤時等收尾跑完再把取消丟回去(monkeypatch):
    seen = {}

    def slow_finalize(run, result):
        time.sleep(0.2)
        seen["finished"] = True

    monkeypatch.setattr(ask, "_finalize", slow_finalize)

    async def main():
        run = runs.Run("run-down", "conv-down", 1, "q")
        task = asyncio.create_task(ask._finalize_off_loop(run, {}))
        await asyncio.sleep(0.05)
        task.cancel()  # 不是使用者按停止 = 服務收攤
        with pytest.raises(asyncio.CancelledError):
            await task
        # 丟回去之前收尾已經跑完 —— 紀錄不會寫一半
        assert seen.get("finished") is True

    asyncio.run(main())


def test_收尾自己的例外照樣帶出去(monkeypatch):
    def broken(run, result):
        raise OSError("database is locked")

    monkeypatch.setattr(ask, "_finalize", broken)

    async def main():
        await ask._finalize_off_loop(runs.Run("run-err", "conv-err", 1, "q"), {})

    with pytest.raises(OSError, match="locked"):
        asyncio.run(main())
