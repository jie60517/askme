from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from . import config

Path(config.DATA_DIR).mkdir(parents=True, exist_ok=True)

#: SQLite 等鎖的時間。預設是 5 秒,而「等不到」的表現是直接丟
#: `database is locked` —— 也就是使用者眼中的 500。
_SQLITE_BUSY_TIMEOUT_SEC = 30


def normalize_database_url(url: str) -> str:
    """把沒寫驅動的 `postgresql://` 補成 `postgresql+psycopg://`。

    SQLAlchemy 看到沒寫驅動的 `postgresql://` 會去找 **psycopg2**,而我們裝的是
    psycopg 3(requirements.txt)—— 症狀是啟動時 `No module named 'psycopg2'`,
    看起來像少裝套件,其實是 URL 少了 `+psycopg`。在這裡補掉,.env 兩種寫法都能用。
    """
    prefix = "postgresql://"
    if url.startswith(prefix):
        return "postgresql+psycopg://" + url[len(prefix) :]
    return url


def _make_engine(url: str):
    if url.startswith("sqlite"):
        return create_engine(
            url,
            connect_args={"check_same_thread": False, "timeout": _SQLITE_BUSY_TIMEOUT_SEC},
        )
    # PostgreSQL。
    #
    # `pool_pre_ping`:連線池裡的連線可能已經被對面關掉(資料庫重啟、閒置逾時),
    # 拿到手才發現壞掉的表現是使用者眼中的一次 500。pre-ping 先發一個 SELECT 1,
    # 壞的就換一條,代價是每次借連線多一個 round-trip,對這個流量可以忽略。
    #
    # 池的大小:uvicorn 單行程、問答上限 MAX_CONCURRENT_ASKS(預設 3)加上
    # 各分頁的輪詢,5 條常駐 + 10 條溢位綽綽有餘;比 Postgres 預設的 100 連線小很多。
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=10)


engine = _make_engine(normalize_database_url(config.DATABASE_URL))

#: 現在接的是哪一種資料庫("sqlite" / "postgresql")。
#: 要看它分家的地方:這裡的連線參數與 PRAGMA、routers/stats.py 的期間分組、
#: migrate_sqlite 的方向檢查。其他 SQL 都靠 SQLAlchemy 抹平,新程式不要再加分岔。
DIALECT = engine.dialect.name


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record) -> None:
    """每條新連線都設一次。**PRAGMA 是連線層級的,不是資料庫層級的。**

    ⚠️ 少了這兩條的症狀是間歇性的 `database is locked` 500 ——
    偏偏最容易中的時候是「同時有三題問答在跑、前端還在輪詢」,也就是最忙的時候。

    `journal_mode=WAL` —— 預設的 DELETE 模式下**讀會擋寫、寫會擋讀**。這個服務
    的形狀正好最吃虧:背景那幾題問答一直在寫(串流事件收尾、寫回答),而每個開著
    分頁的人都在讀(對話清單、輪詢 @ 提及)。WAL 讓讀寫不互相擋,只有寫跟寫要排隊。

    `busy_timeout` —— 真的撞到寫鎖時,**等一下**而不是當場放棄。預設 5 秒對
    「寫一筆問答紀錄」很夠,但這個服務有幾個長交易(例如帳號改名時改寫所有關聯欄位),
    給到 30 秒才不會在那幾個當下把其他人的請求打成 500。

    ⚠️ WAL 會在資料庫旁邊多出 `app.db-wal` 與 `app.db-shm` 兩個檔案。
    **備份時三個要一起帶**,或者用 `sqlite3 .backup`(它自己會處理)——
    只複製 `app.db` 會拿到一份少了最近交易的資料庫。
    """
    if DIALECT != "sqlite":
        return
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute(f"PRAGMA busy_timeout={_SQLITE_BUSY_TIMEOUT_SEC * 1000}")
        # 外鍵預設是關的(SQLite 的歷史包袱),開起來才擋得住孤兒列
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


@contextmanager
def session_scope():
    """一段自己開自己關的資料庫連線,給**不是 FastAPI 端點**的程式碼用。

    端點請用 `get_db`(它是 `Depends` 的形狀);`mfa.py`、`geo_allow.py` 那種
    「開連線 → 動一列 → 關連線」的存取層用這一支 —— 兩邊各抄一份 try/finally
    的結果是漏掉 `db.close()` 的那一份要等連線池耗盡才會被發現。

    ⚠️ **不自動 commit。** 呼叫端自己決定 —— 這幾個模組裡讀多於寫,
    而「離開 with 就 commit」會讓一次純讀取也去碰交易。
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def close_orphan_runs() -> None:
    """服務啟動時,把上次沒跑完就被中斷的問答收尾。

    問答紀錄在送出的當下就先寫成 status="running",答案由背景 task 補上(見 runs.py)。
    服務重啟時那些 task 全部消失,紀錄卻還停在 running —— 不收尾的話,那些對話
    在畫面上會永遠顯示「回答中」,使用者只能一直等一個不會來的答案。
    """
    from . import models

    db = SessionLocal()
    try:
        stale = db.query(models.QARecord).filter(models.QARecord.status == "running").all()
        for record in stale:
            record.status = "done"
            # 已經串流出來的片段沒有存在資料庫裡(只在記憶體),所以這裡多半是空的
            if not record.answer:
                record.success = False
                record.error = "這題在回答途中因為服務重新啟動而中斷,請重新問一次。"
        if stale:
            db.commit()
    finally:
        db.close()


#: SQLite 預設的參數上限是 999,所以 `IN (...)` 一次塞不下太多值。
#: 超過就直接炸 `too many SQL variables`,而那只會在資料變多之後才發生 ——
#: 開發時完全看不到,上線幾個月後才出現。
SQL_IN_CHUNK = 500


def chunked(items: list, size: int = SQL_IN_CHUNK):
    """把一串值切成塞得進 `IN (...)` 的批次。

    抽出來是因為它在兩個地方都要用(這裡的清理、`routers/stats.py` 的彙總),
    而兩份各自寫一個 `range(0, len, 500)` 的迴圈,改了其中一個上限
    另一個會悄悄留在舊值 —— 那種不一致要等到資料量剛好卡在中間才看得出來。
    """
    for i in range(0, len(items), size):
        yield items[i : i + size]


def purge_expired_steps() -> int:
    """把超過保留期的流水帳(models.QAStep)刪掉,回傳刪了幾列。開機時跑一次。

    只刪流水帳,**問答紀錄本身一列都不動** —— 題層級的成本與來源是永久保留的,
    這裡清掉的只有「每一步的明細」。理由見 config.QA_STEPS_RETENTION_DAYS。

    為什麼是開機時跑而不是排程:這個服務沒有排程器,而重啟的頻率(每次部署)
    已經足夠 —— 這件事晚幾天做完全沒有差別,為它多養一個背景 task 不划算。

    比對的是**問答的 created_at**,不是流水帳自己的時間:流水帳沒有時間欄位
    (它記的是相對毫秒),而且「這一題是什麼時候問的」本來就是要保留的那個單位
    —— 一題的明細要嘛整題都在、要嘛整題都不在,半題的時間軸看了只會誤導。
    """
    from datetime import datetime, timedelta

    from . import config, models

    days = config.QA_STEPS_RETENTION_DAYS
    if days <= 0:
        return 0

    cutoff = datetime.utcnow() - timedelta(days=days)
    db = SessionLocal()
    try:
        expired = [
            row[0]
            for row in db.query(models.QARecord.id)
            .filter(models.QARecord.created_at < cutoff)
            .all()
        ]
        if not expired:
            return 0
        deleted = 0
        for chunk in chunked(expired):
            deleted += (
                db.query(models.QAStep)
                .filter(models.QAStep.qa_record_id.in_(chunk))
                .delete(synchronize_session=False)
            )
        db.commit()
        return deleted
    finally:
        db.close()
