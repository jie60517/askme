# 部署與維運

部署給多人用**只走 Docker**:`deploy/docker/` 的 Dockerfile + compose.yml 起三個容器
(網站與 claude CLI、PostgreSQL、apikey 模式用的 keyproxy),資料都在 volume 裡。
第一次安裝、放專案、日常指令、更新與退版都在 [`deploy/docker/README.md`](../deploy/docker/README.md)。

- 設定:常用的幾條在 `deploy/docker/askme.env.example`;其餘設定的完整清單與理由在
  `deploy/env.server.example`,要改哪一條就抄進 `askme.env`。
- 要 https(筆記的框選截圖、語音輸入需要)就在前面架 nginx,範本 `deploy/nginx.conf.example`;
  那時 `FORWARDED_ALLOW_IPS` 要跟著設(見[security.md](security.md)〈客戶端 IP 是 uvicorn 還原的〉)。
- 上線後可以跑 `python deploy/security_test.py --target <網址>` 做一輪不具破壞性的安全檢查
  (不加 `--target` 則是在本機起一個隔離實例跑完整測試,含登入鎖定與越權)。

## 資料庫:SQLite 與 PostgreSQL

開發版預設 SQLite(`sqlite:///./data/app.db`,相對於 `backend/`),clone 下來就跑得起來,
一兩個人試用可以一直用它。多人用改 PostgreSQL,`backend/.env` 換一行:
`DATABASE_URL=postgresql+psycopg://帳號:密碼@localhost:<port>/askme`
(驅動是 psycopg 3;寫成 `postgresql://` 也行,`database.py` 會補上 `+psycopg`)。
帳號與資料庫要先建好。⚠️ **port 不一定是 5432** —— 一台機器上可能不只一個 Postgres
(系統裝的一個、docker 裡又一個),寫死的話帳號建在 A、程式連到 B。
自己查:`sudo -u postgres psql -qtAc 'show port'`。

Docker 版已經是 PostgreSQL(compose 裡的 `postgres` 容器),`DATABASE_URL` 由 compose 給,不用設。

表由服務啟動時自己建(`create_all()`;只建缺少的表,見[architecture.md](architecture.md)〈資料庫:表與欄位〉)。

**SQLite 同時支援**:測試(`backend/tests/conftest.py`)走暫存的 SQLite 檔,
本機沒裝 Postgres 也跑得起來 —— 所以程式碼要**兩種都能跑**。
兩種資料庫的差異全部靠 SQLAlchemy 抹平,只有一處例外:用量統計的期間分組
(`routers/stats.py` 的 `_period_expr`,SQLite 是 `strftime`、Postgres 是 `to_char`)。
新寫查詢時要記得 Postgres 比 SQLite 嚴:`GROUP BY` 之外的欄位不能直接 SELECT、
型別不會自動轉、一個 statement 失敗後整個交易要先 `rollback()` 才能繼續用。

**已經在 SQLite 上跑、要把資料搬到 PostgreSQL**(只搬進空的資料庫,中途失敗會整份 rollback):

```bash
# 先停掉後端,在 backend/ 底下
DATABASE_URL='postgresql+psycopg://帳號:密碼@localhost:<port>/askme' \
  .venv/Scripts/python -m app.migrate_sqlite data/app.db
# 再把 .env 的 DATABASE_URL 改成同一個值,啟動
```

搬遷腳本是 `backend/app/migrate_sqlite.py`,它只搬 models 宣告的欄位,搬完會把 SERIAL 的序列
撥到 MAX(id)。舊的 `app.db` 留著當備份就好,程式不會再讀它。

**備份**用 `pg_dump`:`pg_dump "$DATABASE_URL" > app-$(date +%Y%m%d).sql`
(URL 裡的 `+psycopg` 要拿掉,psql 系列工具不認)。

連線池:每條連線借出前先 `SELECT 1`(`pool_pre_ping`),資料庫重啟後不會留下一批
壞掉的連線讓使用者吃 500;常駐 5 條、溢位 10 條,遠小於 Postgres 預設的 100。

> 在 SQLite 上跑時:`journal_mode=WAL` 與 `busy_timeout=30s` 在每條新連線上設
> (`database.py` 的 `_sqlite_pragmas`),備份要走 backup API 而不是 `cp`
> (`cp` 一個正在被寫入的 SQLite 檔可能複製到半個交易)。

## 升級

**先備份,再換新版。** 建表是自動的,但**既有的表加了欄位不會自己補**(見[architecture.md](architecture.md)〈資料庫:表與欄位〉),
升級前先看這次改了哪些 models 欄位,備份之後再動。

```bash
# Docker 版,在 deploy/docker 底下
docker compose exec postgres pg_dump -U askme askme > askme-$(date +%Y%m%d-%H%M).sql
# 然後照 deploy/docker/README.md「日常」那張表的「更新程式」:建新 image、改 ASKME_TAG、docker compose up -d
```

(開發版的 SQLite:先停掉後端,備份走 backup API,在 `backend/` 底下
`.venv/Scripts/python -c "import sqlite3;s=sqlite3.connect('data/app.db');d=sqlite3.connect('data/app.db.bak');s.backup(d);d.close()"`。)

> ⚠️ 建表與收尾收在 `main.py` 的 `init_database()`,由 lifespan 觸發 —— **不要把它
> 搬到模組層**,那會讓任何一次 `import app.main`(測試、`python -m app.migrate_sqlite` 這類工具)
> 都動到設定檔指的那個資料庫。守門測試:`backend/tests/test_startup.py`。

> ⚠️ **開機會刪超過保留期的流水帳。** `purge_expired_steps()` 會把超過
> `QA_STEPS_RETENTION_DAYS`(預設 90 天)的每步流水帳刪掉。它**只刪 `qa_steps`,
> 問答紀錄一列都不動**。不想讓它動就在設定檔設 `QA_STEPS_RETENTION_DAYS=0`。
> 服務 log 上會印一行「流水帳清理:刪掉 N 列」,沒印就是沒刪到東西。
