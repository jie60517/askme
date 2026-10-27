# -*- coding: utf-8 -*-
"""`import app.main` 不准碰資料庫;`uvicorn app.main:app` 才准。

為什麼要有這一份:建表、`close_orphan_runs()` 這幾件事一旦寫在 `main.py` 的
**模組層**,import 當下就會全部執行。測試與工具腳本都會 import app 的模組,
而那時服務可能正在用同一份資料庫 —— 一次「只是 import」就會把所有
status="running" 的紀錄(包含別人此刻正在問的題目)標成中斷。

這兩個 case 一個守「import 要乾淨」、一個守「該做的事還是有做」。少了後面
那個,把 lifespan 整段刪掉也會綠。

⚠️ 兩個都開**子行程**跑,而且各自帶自己的 `DATABASE_URL`:
`app.main` 在這個 pytest 行程裡已經被別的測試 import 過了,再 import 一次
只會拿到快取的模組,什麼都驗不到。
"""
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _run(code: str, db_path: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"}
    # ⚠️ `load_dotenv()` 預設不覆蓋已存在的環境變數,所以這個值蓋得過 .env
    # (`conftest.py` 用的是同一招)。
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
    )


def test_importing_app_main_does_not_touch_the_database(tmp_path):
    """光是 import,連資料庫檔案都不該被建出來。

    SQLAlchemy 的 engine 是惰性的 —— 沒有人開連線,SQLite 的檔就不會出現。
    所以「檔案不存在」正好是「完全沒碰過資料庫」的證據。
    """
    db = tmp_path / "untouched.db"

    result = _run("from app.main import app; assert app is not None", db)

    assert result.returncode == 0, f"import 失敗:\n{result.stderr}"
    assert not db.exists(), (
        "import app.main 就建出了資料庫檔 —— 表示模組層又有人在動資料庫了。"
        "那些呼叫要放在 init_database() 裡,由 lifespan 觸發。"
    )


def test_lifespan_still_initialises_the_database(tmp_path):
    """反過來:真的把 app 跑起來時,表要建好。

    `TestClient` **要包 `with`** 才會觸發 lifespan,這是 Starlette 的規矩 ——
    也正是上面那個 case 能成立的原因。
    """
    db = tmp_path / "initialised.db"

    # 每一張 models 宣告的表都要在:少一張的症狀通常不是開機失敗,而是用到那張表的功能才 500
    result = _run(
        "from fastapi.testclient import TestClient\n"
        "from sqlalchemy import inspect\n"
        "from app.main import app\n"
        "from app.database import Base, engine\n"
        "assert 'users' in Base.metadata.tables\n"
        "with TestClient(app):\n"
        "    missing = set(Base.metadata.tables) - set(inspect(engine).get_table_names())\n"
        "    assert not missing, missing\n",
        db,
    )

    assert result.returncode == 0, f"lifespan 沒有把資料庫準備好:\n{result.stderr}"
    assert db.exists()


def test_static_cache_headers(tmp_path):
    """靜態檔案的快取標頭,三類三種待遇 —— **分界是「檔名會不會跟著內容變」**。

    回應完全沒有 Cache-Control 的話,瀏覽器會自己猜一個快取時間:上版之後,
    開過的 `/` 還是舊畫面、沒開過的 `/stats` 卻是新的,症狀長得像部署失敗
    (實際上部署是好的)。

    1. `index.html`(含所有前端路由)→ `no-cache`:每次回來驗一次,配 ETag 通常回 304。
    2. `assets/` → `immutable`:檔名帶內容雜湊,內容變檔名就變,同一個網址的內容
       永遠不會改,連驗都不必驗。不標的話功能上沒錯,但每次開站都要為每個檔各發一次 304。
    3. dist 根目錄那幾個**檔名固定**的(`favicon.svg`、`pet/*.gif`)
       → `no-cache`:它們沒有雜湊,換了圖還是同一個網址,
       少了標頭時瀏覽器猜的那個時間會讓人好幾天看不到新圖。

    ⚠️ 這裡斷言的是「意圖」:不要寫成 `assert cache-control is None` 這種只鎖住現況的斷言。
    """
    dist = BACKEND.parent / "frontend" / "dist"
    if not (dist / "index.html").exists():
        import pytest

        pytest.skip("沒有 frontend/dist(要先 npm run build)")

    result = _run(
        "from fastapi.testclient import TestClient\n"
        "from app.main import app\n"
        "import re\n"
        "with TestClient(app) as c:\n"
        "    r = c.get('/')\n"
        "    assert r.headers.get('cache-control') == 'no-cache', r.headers\n"
        "    assert c.get('/stats').headers.get('cache-control') == 'no-cache'\n"
        "    m = re.search(r'(assets/index-[A-Za-z0-9_-]+\.js)', r.text)\n"
        "    assert m, '找不到入口 js'\n"
        "    asset = c.get('/' + m.group(1))\n"
        "    assert asset.status_code == 200\n"
        "    cc = asset.headers.get('cache-control') or ''\n"
        "    assert 'immutable' in cc and 'no-cache' not in cc, asset.headers\n"
        "    icon = c.get('/favicon.svg')\n"
        "    assert icon.status_code == 200\n"
        "    assert icon.headers.get('cache-control') == 'no-cache', icon.headers\n"
        "print('cache headers ok')\n",
        tmp_path / "cache.db",
    )

    assert result.returncode == 0, result.stderr
