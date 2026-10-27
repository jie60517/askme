# -*- coding: utf-8 -*-
"""本機看「個人筆記」(/notes)用的示範後端。**只給本機開發用,不要部署。**

暫存 SQLite + 暫存的筆記圖片目錄,塞一組對話(兩題:一般問答含表格、程式碼)
和一則筆記,開在 8126(不跟 SSH 示範的 8124 搶)。前端用 `frontend-notes-demo`(5176)。

用法(在 backend/ 底下;或 .claude/launch.json 的 `backend-notes-demo`):
    .venv/Scripts/python dev_notes_demo.py

登入:tiptop / tiptop(只存在暫存資料庫裡)。
第二個帳號 alice(同一組密碼):試兩個帳號之間的隔離用。
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

# ── 環境要在 import app 之前設好:config.py 的 load_dotenv 不會覆蓋已存在的變數 ──
TMP = Path(tempfile.mkdtemp(prefix="t100-notes-demo-"))
HTTP_PORT = int(os.environ.get("PORT") or "8126")
ADMIN_PASSWORD = "tiptop"

os.environ.update(
    {
        "DATABASE_URL": f"sqlite:///{TMP / 'demo.db'}",
        "NOTEBOOK_DIR": str(TMP / "notebook"),
        "MFA_REQUIRED": "0",
        "ADMIN_USERNAME": "tiptop",
        "ADMIN_PASSWORD": ADMIN_PASSWORD,
        # 筆記功能預設開(config.NOTEBOOK_ENABLED);這裡再寫一次,本機 .env 關掉了也照樣看得到。
        # 要看「關著」的樣子:啟動前設 NOTEBOOK_ENABLED=0
        "NOTEBOOK_ENABLED": os.environ.get("NOTEBOOK_ENABLED") or "1",
    }
)

# 前端的對話 id 是 UUID(lib/ids.ts),格式不對會被導回首頁
CONV = "0f1e2d3c-4b5a-4968-8776-6554433221a0"
FENCE = "`" * 3
QAS = [
    (
        "訂單要怎麼部分出貨?\n單號 SO-2026-0815\n只出一部分可以嗎",
        "可以部分出貨。出貨單建立時帶入 SO-2026-0815,把這次實際要出的數量改掉,"
        "沒有要出的那幾項直接刪掉那一列即可(`src/orders/shipment.py:120` 會檢查不超過未出數量)。\n\n"
        "| 欄位 | 填法 |\n|---|---|\n| 出貨數量 | 這次實際要出的數量 |\n| 保留數量 | 先不出、留著下次出的數量 |\n\n"
        "剩下沒出的數量會留在訂單上,下次再開一張出貨單帶入即可。",
    ),
    (
        "稅率帶錯要去哪裡改?",
        "稅率是從 **settings/tax.yaml** 讀進來的,改完重新整理一次訂單明細就會重算。\n\n"
        + FENCE + "sql\nSELECT code, rate, active FROM tax_rates WHERE active = 1;\n" + FENCE,
    ),
]


def seed() -> None:
    from app import models, users
    from app.database import SessionLocal

    now = datetime.utcnow()
    db = SessionLocal()
    try:
        for i, (q, a) in enumerate(QAS):
            db.add(models.QARecord(
                created_at=now - timedelta(minutes=30 - i * 5), session_id=f"notes-demo-s-{i}", conversation_id=CONV,
                question=q, answer=a, knowledge_base="example", owner="tiptop", asked_by="tiptop",
                status="done", success=True, duration_ms=12000 + i * 3000,
            ))
        db.add(models.User(
            username="alice", password=users.hash_password(ADMIN_PASSWORD), display_name="Alice", role=users.ROLE_ENGINEER,
        ))
        db.add(models.UserNote(
            username="tiptop", title="上線待辦", body="1. 環境設定\n2. 稅率設定\n3. 帳號權限\n4. 教育訓練排在 10/20",
            created_at=now - timedelta(days=3), updated_at=now - timedelta(days=3),
        ))
        db.commit()
    finally:
        db.close()


def main() -> None:
    import uvicorn

    from app import auth
    from app.main import init_database

    init_database()
    seed()
    print(f"[notes-demo] 網頁登入:tiptop / {ADMIN_PASSWORD}(暫存 {TMP})", flush=True)
    print(f"[notes-demo] 示範對話:/c/{CONV}", flush=True)
    print(f"[notes-demo] token:{auth.issue_token('tiptop')}", flush=True)
    print(f"[notes-demo] token(alice):{auth.issue_token('alice')}", flush=True)
    uvicorn.run("app.main:app", host="127.0.0.1", port=HTTP_PORT, log_level="info")


if __name__ == "__main__":
    if sys.platform == "win32":
        import asyncio

        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    main()
