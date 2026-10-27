# -*- coding: utf-8 -*-
"""把 SQLite 的 `app.db` 整份搬進 `DATABASE_URL` 指到的 PostgreSQL。**只跑一次。**

    cd backend
    DATABASE_URL=postgresql+psycopg://askme:密碼@localhost/askme \\
      ./.venv/bin/python -m app.migrate_sqlite data/app.db

做的事,照順序:

  1. 在目標資料庫 `create_all()`(表已經在就跳過)。
  2. **目標的每一張表都必須是空的**,不然直接停。這支只負責「從零搬」,
     不做合併 —— 合併要處理主鍵撞號、誰新誰舊,那是另一個問題,而搬遷只會發生一次。
  3. 一張一張表把資料列讀出來寫過去,**全部包在同一個交易裡**:中途任何一列失敗
     就整份 rollback,目標資料庫回到空的,不會留下半份資料。
  4. 把 Postgres 的序列(SERIAL 的計數器)撥到 MAX(id):明確帶 id 寫入的列
     不會推動序列,不撥的話新建的第一列會撞到 1 號而 IntegrityError。

只搬 **models 宣告的欄位**。來源 SQLite 裡 models 沒宣告的欄位不會過去 ——
沒有程式碼在讀,搬過去只是把垃圾換個地方放。

⚠️ 反過來,SQLite 那邊**缺**的欄位(來源是比現在的 models 舊的版本建的)
**不會是 NULL,而是 model 上的 Python 端 default**:insert 的 dict 裡沒有那個鍵時
SQLAlchemy 會替它套 `default=`,所以 `success` 會變 True、`status` 變 'done'、
`created_at` 變**搬遷當下的時間**。最後一個是假的 —— 所以來源要是同一版程式建的資料庫。

⚠️ **搬之前先把服務停掉。** 正在跑的問答會在停機時被 close_orphan_runs 收尾成失敗,
這跟平常重啟一樣;但搬到一半還有人在寫 SQLite 的話,那幾列不會過去。
"""
import sys
from pathlib import Path
from typing import Dict

from sqlalchemy import Integer, create_engine, func, inspect, insert, select, text

from .database import Base, chunked, engine as target_engine


class MigrationError(Exception):
    """搬不下去的理由(目標不是 Postgres、目標已有資料、來源檔不存在)。"""


def migrate(sqlite_path: Path, target=target_engine) -> Dict[str, int]:
    """回傳每張表搬了幾列。丟 `MigrationError` 代表**什麼都沒寫**。"""
    # ⚠️ 一定要 import:Base.metadata 是被 import 的那一刻才由 models 註冊進去的。
    from . import models  # noqa: F401

    if target.dialect.name == "sqlite":
        raise MigrationError(
            "DATABASE_URL 還指著 SQLite —— 這支是把 SQLite 搬到 PostgreSQL 用的,"
            "請把 DATABASE_URL 設成 postgresql+psycopg://... 再跑"
        )
    sqlite_path = Path(sqlite_path)
    if not sqlite_path.is_file():
        raise MigrationError(f"找不到來源資料庫:{sqlite_path}")

    source = create_engine(f"sqlite:///{sqlite_path.as_posix()}")
    source_inspector = inspect(source)
    source_tables = set(source_inspector.get_table_names())

    Base.metadata.create_all(bind=target)

    copied: Dict[str, int] = {}
    with source.connect() as src, target.begin() as dst:
        # 先整份檢查再開始寫:目標有資料就一列都不動。
        for table in Base.metadata.sorted_tables:
            existing = dst.execute(select(func.count()).select_from(table)).scalar()
            if existing:
                raise MigrationError(
                    f"目標資料庫的 {table.name} 已經有 {existing} 列 —— "
                    "這支只搬進空的資料庫。要重搬就先把目標的表清掉(或整個 DROP DATABASE 重建)"
                )

        # sorted_tables 是照外鍵相依排的(qa_records 在 qa_steps 前面),
        # 所以逐張寫不會撞到 FK。
        for table in Base.metadata.sorted_tables:
            if table.name not in source_tables:
                copied[table.name] = 0
                continue
            source_columns = {c["name"] for c in source_inspector.get_columns(table.name)}
            # 只挑兩邊都有的欄位。用 model 的 Column 物件去讀,SQLAlchemy 才會把
            # SQLite 存的 0/1 轉成 bool、日期字串轉成 datetime —— 直接讀原始值
            # 寫進 Postgres 會被型別擋下來。
            columns = [c for c in table.columns if c.name in source_columns]
            try:
                rows = src.execute(select(*columns)).mappings().all()
                for chunk in chunked([dict(r) for r in rows]):
                    dst.execute(insert(table), chunk)
            except Exception as exc:
                # 離開 with 區塊時整份 rollback。包一層是為了讓人知道**是哪張表**:
                # 原始例外只會說「某個日期字串解析不了」「某欄 NOT NULL」,不說在哪。
                raise MigrationError(f"{table.name} 搬到一半失敗,已整份 rollback:{exc}") from exc
            copied[table.name] = len(rows)

        _reset_sequences(dst)

    source.dispose()
    return copied


def _reset_sequences(conn) -> None:
    """把每張表的自增序列撥到目前的 MAX(id)。

    `pg_get_serial_sequence` 找不到序列(主鍵不是 SERIAL 的表,例如 users)
    會回 NULL,setval(NULL, ...) 也是 NULL —— 所以不用自己分哪幾張表有序列。
    第三個參數 `is_called`:表是空的時候要設成 false,下一個值才會是 1 而不是 2。
    """
    for table in Base.metadata.sorted_tables:
        for column in table.primary_key.columns:
            if not isinstance(column.type, Integer):
                continue
            conn.execute(
                text(
                    f"SELECT setval("
                    f"  pg_get_serial_sequence('{table.name}', '{column.name}'),"
                    f"  COALESCE(MAX({column.name}), 1),"
                    f"  MAX({column.name}) IS NOT NULL"
                    f") FROM {table.name}"
                )
            )


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__)
        return 2
    try:
        copied = migrate(Path(argv[0]))
    except MigrationError as exc:
        print(f"  沒有搬:{exc}")
        return 1
    for name, count in copied.items():
        print(f"  {name:28s} {count:>7d} 列")
    print(f"  完成,共 {sum(copied.values())} 列")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
