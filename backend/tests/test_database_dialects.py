# -*- coding: utf-8 -*-
"""SQLite 與 PostgreSQL 兩種都要能跑(部署可以用 Postgres,測試預設走 SQLite)。

這裡守的是「分 dialect 的那幾處」:URL 正規化、期間分組的表達式、
搬遷腳本拒絕搬進 SQLite。

真的接 Postgres 跑整套測試:設 `TEST_DATABASE_URL=postgresql+psycopg://...`
再跑 pytest(見 conftest.py)。
"""
import pytest
from sqlalchemy.dialects import postgresql, sqlite

from app import models  # noqa: F401  migrate() 要 Base.metadata 有表
from app.database import engine, normalize_database_url
from app.routers import stats


@pytest.mark.parametrize(
    "given, expected",
    [
        ("postgresql://u:p@h/db", "postgresql+psycopg://u:p@h/db"),
        ("postgresql+psycopg://u:p@h/db", "postgresql+psycopg://u:p@h/db"),
        ("sqlite:///./data/app.db", "sqlite:///./data/app.db"),
    ],
)
def test_normalize_database_url(given, expected):
    """沒寫驅動的 postgresql:// 會被 SQLAlchemy 導向 psycopg2,而我們裝的是 psycopg 3。"""
    assert normalize_database_url(given) == expected


def test_period_expr_uses_strftime_on_sqlite_and_to_char_on_postgres(monkeypatch):
    """兩種資料庫產出的字串格式要一樣('2026-09-04'),前端不分。"""
    literal = {"literal_binds": True}  # 格式字串是 bind 參數,要 inline 進來才看得到
    monkeypatch.setattr(stats, "DIALECT", "sqlite")
    sql = str(stats._period_expr("day").compile(dialect=sqlite.dialect(), compile_kwargs=literal))
    assert "strftime" in sql and "%Y-%m-%d" in sql

    monkeypatch.setattr(stats, "DIALECT", "postgresql")
    sql = str(
        stats._period_expr("day").compile(dialect=postgresql.dialect(), compile_kwargs=literal)
    )
    assert "to_char" in sql and "YYYY-MM-DD" in sql

    for granularity in ("month", "year"):
        monkeypatch.setattr(stats, "DIALECT", "postgresql")
        sql = str(
            stats._period_expr(granularity).compile(
                dialect=postgresql.dialect(), compile_kwargs=literal
            )
        )
        assert "to_char" in sql, granularity


def test_migrate_refuses_when_target_is_sqlite(tmp_path):
    """搬遷腳本的方向是 SQLite → Postgres;目標還是 SQLite 就什麼都不做。"""
    from app.database import DIALECT
    from app.migrate_sqlite import MigrationError, migrate

    if DIALECT != "sqlite":
        pytest.skip("測試資料庫是 Postgres,這條驗的是「目標是 SQLite 時要拒絕」")

    src = tmp_path / "old.db"
    src.write_bytes(b"")
    with pytest.raises(MigrationError):
        migrate(src, target=engine)
