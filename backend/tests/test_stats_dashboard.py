# -*- coding: utf-8 -*-
"""`/api/stats` 給 dashboard 版面用的那幾個欄位。

守的是四件「壞掉了畫面上看不出來、只會顯示成一個怪數字」的事:

  1. **對照期的定義。** 同樣長度、緊接在前的一段;兩端沒給齊就是 None。
     算錯的話畫面上是一個看起來很正常的漲跌百分比,沒人查得出來。
  2. **沒有發問者的紀錄(`_asker()` IS NULL)不算任何帳號。** 排行榜不列、
     `by_period_logged_in` 不算,分界只有一條,不能另外定義一次。
  3. **帳號數只算有發問者的**,而且當期與對照期用同一套算法(`_summary`)。
  4. **status 是 NULL 的紀錄要算成 done。** 不 coalesce 的話畫面上會多出一條
     意義不明的「未標記」—— 欄位為 NULL 的題目都已經答完了(欄位預設就是 done)。

⚠️ 資料一律在 `with TestClient(app)` **裡面**才寫進去:`init_database()` 會跑
`close_orphan_runs()`,把所有 status="running" 改寫成 done。在外面建的 running
紀錄會被它吃掉,第 4 條會變成一條看不懂為什麼紅的測試。
"""
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import auth, config, models
from app.database import SessionLocal
from app.main import app
from app.routers.stats import _previous_window, _utc_window


# ── 時區換算與對照期(純函式,不碰資料庫)────────────────────────────────

#: 台灣。`created_at` 存的是 UTC,而使用者挑的日期是他當地的日期。
TPE = 480


def test_utc_window_shifts_local_days_back():
    """當地 5/11 整天 = UTC 5/10 16:00 起、5/11 16:00 止。

    ⚠️ 不換算的話,台灣的「今天」查到的是
    當地今天 08:00 到明天 08:00 —— 凌晨到早上八點的題目被算進前一天。
    """
    lo, hi = _utc_window(date(2019, 5, 11), date(2019, 5, 11), TPE)
    assert lo == datetime(2019, 5, 10, 16, 0)
    assert hi == datetime(2019, 5, 11, 16, 0)


def test_utc_window_without_offset_is_plain_utc():
    """預設 0 = 照 UTC 切(沒帶這個參數的呼叫端拿到的就是這個)。"""
    lo, hi = _utc_window(date(2019, 5, 11), date(2019, 5, 11), 0)
    assert lo == datetime(2019, 5, 11, 0, 0)
    assert hi == datetime(2019, 5, 12, 0, 0)


def test_utc_window_end_is_inclusive_of_that_day():
    """`end` 是包含當天的 —— 上界取隔天 00:00 且不含。"""
    _, hi = _utc_window(date(2019, 5, 11), date(2019, 5, 17), 0)
    assert hi == datetime(2019, 5, 18, 0, 0)


def test_previous_window_is_same_length_immediately_before():
    """05-11–05-17(7 天)的對照期是 05-04–05-10。區間已經過完,所以是整段。"""
    lo, hi = _previous_window(
        date(2019, 5, 11), date(2019, 5, 17), 0, now_utc=datetime(2026, 1, 1)
    )
    assert lo == datetime(2019, 5, 4, 0, 0)
    assert hi == datetime(2019, 5, 11, 0, 0)


def test_previous_window_of_a_single_day_is_the_day_before():
    lo, hi = _previous_window(
        date(2019, 5, 17), date(2019, 5, 17), 0, now_utc=datetime(2026, 1, 1)
    )
    assert lo == datetime(2019, 5, 16, 0, 0)
    assert hi == datetime(2019, 5, 17, 0, 0)


def test_previous_window_spans_month_boundaries():
    """跨月要照天數算,不是「上個月的同一段」。9/1–9/3 → 8/29–8/31。"""
    lo, hi = _previous_window(
        date(2026, 9, 1), date(2026, 9, 3), 0, now_utc=datetime(2027, 1, 1)
    )
    assert lo == datetime(2026, 8, 29, 0, 0)
    assert hi == datetime(2026, 9, 1, 0, 0)


def test_previous_window_only_compares_the_elapsed_part_of_today():
    """⚠️ 目前這段還沒過完時,對照期也只比到同樣的進度。

    預設區間是「今天」,而今天只過了一部分,
    對照期卻是昨天一整天 —— 早上打開每張卡都會顯示大幅衰退,而那個跌幅純粹是
    「還沒過完」造成的。

    情境:台灣時間 9/17 上午 9 點看「今天」。對照期要是「昨天 00:00 到 09:00」,
    不是昨天一整天。
    """
    now_utc = datetime(2026, 9, 17, 1, 0)  # = 台灣 9/17 09:00
    lo, hi = _previous_window(date(2026, 9, 17), date(2026, 9, 17), TPE, now_utc=now_utc)
    # 台灣 9/16 00:00 = UTC 9/15 16:00
    assert lo == datetime(2026, 9, 15, 16, 0)
    # 台灣 9/16 09:00 = UTC 9/16 01:00
    assert hi == datetime(2026, 9, 16, 1, 0)
    assert hi - lo == timedelta(hours=9)


def test_previous_window_of_a_finished_range_is_a_whole_period():
    """相對的:區間已經整段過完就比整段,不要被上面那條影響。"""
    now_utc = datetime(2026, 9, 17, 1, 0)
    lo, hi = _previous_window(date(2026, 9, 10), date(2026, 9, 16), TPE, now_utc=now_utc)
    assert hi - lo == timedelta(days=7)


@pytest.mark.parametrize(
    "start,end",
    [
        (None, None),  # 「全部」
        (date(2026, 9, 11), None),  # 只填了起
        (None, date(2026, 9, 17)),  # 只填了迄
    ],
)
def test_previous_window_needs_both_ends(start, end):
    """少一端就沒有「同樣長度的前一段」—— 硬湊的話區間長度會隨資料飄。"""
    assert _previous_window(start, end, 0) is None


# ── 端點 ────────────────────────────────────────────────────────────────

SIDS = []


def _add(db, *, sid, when, asked_by, kb=None, status="done", duration_ms=1000.0):
    SIDS.append(sid)
    db.add(
        models.QARecord(
            session_id=sid,
            conversation_id=f"conv-{sid}",
            question="q",
            answer="a",
            created_at=when,
            owner=asked_by,
            asked_by=asked_by,
            knowledge_base=kb,
            status=status,
            duration_ms=duration_ms,
        )
    )


@pytest.fixture
def seeded():
    """當期 2019-05-11–05-17 四題、對照期 05-04–05-10 兩題。

    當期的四題:兩題 alice、一題 amy、一題沒有發問者(asked_by/owner 都是 NULL)。

    ⚠️ **年份刻意放在很久以前。** 暫存資料庫是整套測試共用的,而別的測試建
    `QARecord` 時 `created_at` 走欄位預設(`utcnow`)—— 也就是**今天**。
    把這裡的區間訂在「今天附近」的話,單獨跑會過、整套跑就會多算到別人的資料,
    而錯誤訊息看起來完全像是 SQL 寫錯。
    """
    with TestClient(app) as client:
        db = SessionLocal()
        _add(db, sid="cur-1", when=datetime(2019, 5, 11, 9, 0), asked_by="alice", kb="proj_a")
        _add(db, sid="cur-2", when=datetime(2019, 5, 12, 9, 0), asked_by="alice", kb="proj_a")
        _add(db, sid="cur-3", when=datetime(2019, 5, 15, 9, 0), asked_by="amy", kb="proj_b")
        # 沒有發問者 + 沒指定專案 + status 是 NULL(欄位為 NULL 的紀錄)
        _add(db, sid="cur-4", when=datetime(2019, 5, 17, 9, 0), asked_by=None, kb=None, status=None)
        # 對照期
        _add(db, sid="prev-1", when=datetime(2019, 5, 5, 9, 0), asked_by="alice", kb="proj_a")
        _add(db, sid="prev-2", when=datetime(2019, 5, 9, 9, 0), asked_by="bob", kb="proj_a")
        db.commit()
        db.close()

        token = auth._issue(config.ADMIN_USERNAME)
        client.headers.update({"Authorization": f"Bearer {token}"})
        yield client

    db = SessionLocal()
    db.query(models.QARecord).filter(models.QARecord.session_id.in_(SIDS)).delete(
        synchronize_session=False
    )
    db.commit()
    db.close()
    SIDS.clear()


def _stats(client, **params):
    resp = client.get("/api/stats", params={"granularity": "day", **params})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_previous_reports_the_preceding_window(seeded):
    """05-11–05-17 的對照期就是 05-04–05-10 那兩題,不是「全部歷史」。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert data["total_questions"] == 4
    assert data["previous"]["total_questions"] == 2


def test_previous_is_null_without_a_range(seeded):
    """「全部」沒有對照期 —— 前端靠這個決定不畫漲跌箭頭。"""
    assert _stats(seeded)["previous"] is None


def test_account_count_excludes_records_without_asker(seeded):
    """當期四題裡有一題沒有發問者,帳號數是 2(alice / amy),不是 3。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert data["account_count"] == 2
    # 對照期是 alice / bob 兩個人,同一套算法
    assert data["previous"]["account_count"] == 2


def test_by_period_logged_in_excludes_records_without_asker(seeded):
    """大圖的第二條線只算有發問者的題目;05-17 那題沒有發問者,只算在 by_period。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert data["by_period"]["2019-05-17"] == 1
    assert data["by_period_logged_in"] == {"2019-05-11": 1, "2019-05-12": 1, "2019-05-15": 1}
    assert "by_period_anonymous" not in data


def test_ranking_excludes_records_without_asker(seeded):
    """沒有發問者的紀錄不單獨成一列,也不算進任何帳號。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert data["by_user"] == {"alice": 2, "amy": 1}
    assert set(data["by_user_avg_duration"]) == set(data["by_user"])


def test_status_null_counts_as_done(seeded):
    """status 是 NULL 的舊紀錄算 done —— 畫面上不該冒出「未標記」那一條。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert data["by_status"] == {"done": 4}
    assert None not in data["by_status"]


def test_knowledge_base_null_is_labelled(seeded):
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert data["by_knowledge_base"] == {"proj_a": 2, "proj_b": 1, "(未指定)": 1}


def test_sparkline_series_cover_the_same_periods(seeded):
    """KPI 卡的 sparkline 都要有資料,不然卡片上是一條空線。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert set(data["avg_duration_by_period"]) == set(data["by_period"])


def test_no_unused_per_period_series_in_the_response(seeded):
    """回應裡不要有 `accounts_by_period` —— 沒有卡片用它,但它要錢。

    四張 KPI 卡各自用的是 `by_period`、`avg_duration_by_period`、
    `logins_by_period`,第四張(每人平均題數)是前端拿兩條相除算出來的
    (`Stats.tsx` 的 `perUserSeries`)。`accounts_by_period` 一張都用不到,
    卻會讓**每一次**請求多跑一次 `GROUP BY` + `COUNT(DISTINCT)`。

    這條釘的是「別因為看起來該有就加上去」。真要加的話,先讓畫面用它。
    """
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert "accounts_by_period" not in data


def test_existing_fields_are_untouched(seeded):
    """舊欄位一個都沒動 —— 舊前端打新後端不會壞。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    for key in ("total_questions", "total_cost_usd", "avg_duration_ms", "by_period", "by_user"):
        assert key in data, f"{key} 不見了"
    assert data["avg_duration_ms"] == 1000.0


# ── 登入人數與耗時分布 ──────────────────────


def _login(db, *, actor, when):
    db.add(models.AuditLog(event="login_success", actor=actor, created_at=when, ip="127.0.0.1"))


@pytest.fixture
def logins(seeded):
    """在 `seeded` 的區間裡放幾筆登入事件。

    ⚠️ 重點是**這幾個人跟問過問題的人不是同一組**:
    `dana` 登入了但一題都沒問,`amy` 問過問題但這裡讓她登入兩次。
    「登入人數」如果被寫成「問過問題的帳號數」,這條就會紅。
    """
    db = SessionLocal()
    _login(db, actor="alice", when=datetime(2019, 5, 11, 8, 0))
    _login(db, actor="alice", when=datetime(2019, 5, 12, 8, 0))  # 同一個人第二次,不重複計
    _login(db, actor="amy", when=datetime(2019, 5, 15, 8, 0))
    _login(db, actor="dana", when=datetime(2019, 5, 16, 8, 0))  # 登入了但沒問問題
    _login(db, actor="oldie", when=datetime(2019, 5, 6, 8, 0))  # 落在對照期
    db.commit()
    db.close()
    yield seeded
    db = SessionLocal()
    db.query(models.AuditLog).filter(
        models.AuditLog.actor.in_(["alice", "amy", "dana", "oldie"])
    ).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_login_user_count_is_distinct_people(logins):
    """alice(兩次)、amy、dana → 3 個人,不是 4 次。"""
    data = _stats(logins, start="2019-05-11", end="2019-05-17")
    assert data["login_user_count"] == 3


def test_login_user_count_is_not_the_same_as_account_count(logins):
    """登入了沒問問題的人算在登入人數、不算在帳號數 —— 兩個數字必須分得開。

    這段期間:問過問題的是 alice / amy(2 人),登入過的是 alice / amy / dana(3 人)。
    寫成同一個查詢的話這條會紅。
    """
    data = _stats(logins, start="2019-05-11", end="2019-05-17")
    assert data["account_count"] == 2
    assert data["login_user_count"] == 3


def test_login_user_count_has_its_own_previous(logins):
    """對照期(05-04–05-10)只有 oldie 登入過。"""
    data = _stats(logins, start="2019-05-11", end="2019-05-17")
    assert data["previous"]["login_user_count"] == 1


def test_logged_in_questions_excludes_records_without_asker(logins):
    """「每人平均題數」的分子不含沒有發問者的題目。當期四題裡有一題沒有發問者。"""
    data = _stats(logins, start="2019-05-11", end="2019-05-17")
    assert data["logged_in_questions"] == 3
    assert data["total_questions"] == 4


def test_duration_buckets_always_have_all_three_keys(seeded):
    """⚠️ 沒有那一段也要出現(0)。

    少一段的話堆疊條的顏色會跟著位移,同一段在兩次查詢之間變成不同顏色 ——
    而畫面上看起來只是「顏色怪怪的」,沒人會想到是資料少一個鍵。
    """
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert list(data["by_duration_bucket"]) == ["fast", "medium", "slow"]


def test_duration_buckets_split_at_10s_and_30s(seeded):
    """seeded 的四題都是 1000ms,全部落在 fast。"""
    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    assert data["by_duration_bucket"] == {"fast": 4, "medium": 0, "slow": 0}


def test_duration_buckets_count_the_slow_ones(seeded):
    """邊界:剛好 10 秒算 medium、剛好 30 秒算 slow(界線是「未滿」)。"""
    db = SessionLocal()
    _add(db, sid="dur-1", when=datetime(2019, 5, 13, 9, 0), asked_by="alice", duration_ms=9_999.0)
    _add(db, sid="dur-2", when=datetime(2019, 5, 13, 9, 1), asked_by="alice", duration_ms=10_000.0)
    _add(db, sid="dur-3", when=datetime(2019, 5, 13, 9, 2), asked_by="alice", duration_ms=29_999.0)
    _add(db, sid="dur-4", when=datetime(2019, 5, 13, 9, 3), asked_by="alice", duration_ms=30_000.0)
    db.commit()
    db.close()

    data = _stats(seeded, start="2019-05-11", end="2019-05-17")
    # seeded 的四題(1000ms)+ dur-1 → fast 5;dur-2 / dur-3 → medium 2;dur-4 → slow 1
    assert data["by_duration_bucket"] == {"fast": 5, "medium": 2, "slow": 1}


# ── 小時粒度(只選一天時圖上不該只有一個點)────────────────────


def test_hour_granularity_keys_include_the_date(seeded):
    """⚠️ `hour` 的鍵是「日期 + 空格 + 兩位小時」,**不是只有小時**。

    只給小時的話,跨日的區間會把不同天的同一個鐘點併成一格。
    前端補齊 24 格時也是照這個格式組鍵(`hourKeys()`),兩邊對不上就畫不出東西。
    """
    data = _stats(seeded, granularity="hour", start="2019-05-11", end="2019-05-11")
    assert list(data["by_period"]) == ["2019-05-11 09"]


def test_hour_granularity_separates_hours(seeded):
    """同一天不同鐘點要分開,不能併成一格。"""
    db = SessionLocal()
    _add(db, sid="hr-1", when=datetime(2019, 5, 13, 9, 30), asked_by="alice")
    _add(db, sid="hr-2", when=datetime(2019, 5, 13, 9, 45), asked_by="alice")
    _add(db, sid="hr-3", when=datetime(2019, 5, 13, 14, 5), asked_by="amy")
    db.commit()
    db.close()

    data = _stats(seeded, granularity="hour", start="2019-05-13", end="2019-05-13")
    assert data["by_period"] == {"2019-05-13 09": 2, "2019-05-13 14": 1}


def test_unknown_granularity_is_rejected(seeded):
    """認不得的粒度要 400,不要默默當成 day —— 那會讓前端拿到對不上的鍵。"""
    resp = seeded.get("/api/stats", params={"granularity": "week"})
    assert resp.status_code == 400


# ── 端點層的時區(不換算的話,單日小時檢視整條曲線平移八小時)──────────


@pytest.fixture
def midnight_rows(seeded):
    """三筆刻意放在「UTC 與台灣不同一天」的紀錄。

    UTC 5/20 17:00 = 台灣 5/21 01:00 —— 台灣人眼中是 5/21 凌晨一點問的,
    不換算的話會被算進 5/20。
    """
    db = SessionLocal()
    _add(db, sid="tz-1", when=datetime(2019, 5, 20, 17, 30), asked_by="alice")  # 台灣 5/21 01:30
    _add(db, sid="tz-2", when=datetime(2019, 5, 20, 23, 0), asked_by="alice")   # 台灣 5/21 07:00
    _add(db, sid="tz-3", when=datetime(2019, 5, 21, 6, 0), asked_by="amy")    # 台灣 5/21 14:00
    db.commit()
    db.close()
    yield seeded


def test_day_bucket_follows_the_callers_timezone(midnight_rows):
    """台灣選 5/21 單日,三筆都要算進來;不換算的話只看得到一筆。"""
    utc = _stats(midnight_rows, start="2019-05-21", end="2019-05-21")
    tpe = _stats(midnight_rows, start="2019-05-21", end="2019-05-21", tz_offset=480)
    assert utc["total_questions"] == 1, "UTC 切法只涵蓋 tz-3"
    assert tpe["total_questions"] == 3, "台灣切法要涵蓋三筆"


def test_hour_buckets_are_labelled_in_the_callers_timezone(midnight_rows):
    """⚠️ 這是使用者看得到的那個症狀:整條曲線平移八小時。

    台灣 5/21 的三筆分別是 01:30 / 07:00 / 14:00。鍵要照當地時間分,
    不是 UTC 的 17 / 23 / 06。
    """
    data = _stats(
        midnight_rows,
        granularity="hour",
        start="2019-05-21",
        end="2019-05-21",
        tz_offset=480,
    )
    assert data["by_period"] == {
        "2019-05-21 01": 1,
        "2019-05-21 07": 1,
        "2019-05-21 14": 1,
    }


def test_hour_buckets_never_fall_outside_the_selected_day(midnight_rows):
    """篩選與分桶要用同一個位移。

    一邊換算、一邊沒換算的話,會冒出「2019-05-20 17」這種**不在選取區間裡**
    的格子 —— 前端補 24 格時對不到鍵,那一筆就靜靜消失。
    """
    data = _stats(
        midnight_rows,
        granularity="hour",
        start="2019-05-21",
        end="2019-05-21",
        tz_offset=480,
    )
    assert all(key.startswith("2019-05-21 ") for key in data["by_period"]), data["by_period"]


def test_login_count_follows_the_same_timezone(midnight_rows):
    """登入人數走 audit_log,也要吃同一個位移 —— 不然它跟提問數會對不起來。"""
    db = SessionLocal()
    _login(db, actor="dana", when=datetime(2019, 5, 20, 18, 0))  # 台灣 5/21 02:00
    db.commit()
    db.close()

    utc = _stats(midnight_rows, start="2019-05-21", end="2019-05-21")
    tpe = _stats(midnight_rows, start="2019-05-21", end="2019-05-21", tz_offset=480)
    assert utc["login_user_count"] == 0
    assert tpe["login_user_count"] == 1

    db = SessionLocal()
    db.query(models.AuditLog).filter(models.AuditLog.actor == "dana").delete(
        synchronize_session=False
    )
    db.commit()
    db.close()


# ── 一刻鐘分組(大圖是 96 點 / 24 小時)──────────────


def test_quarter_buckets_floor_minutes_to_15(seeded):
    """分鐘要**往下取整**到 00/15/30/45,不是四捨五入。

    14:14 → 14:00,14:15 → 14:15,14:29 → 14:15,14:59 → 14:45。
    取整方向搞反的話,一筆資料會被算進**還沒發生**的那一格。
    """
    db = SessionLocal()
    for i, minute in enumerate((0, 14, 15, 29, 30, 44, 45, 59)):
        _add(db, sid=f"q-{i}", when=datetime(2019, 5, 22, 14, minute), asked_by="alice")
    db.commit()
    db.close()

    data = _stats(seeded, granularity="quarter", start="2019-05-22", end="2019-05-22")
    assert data["by_period"] == {
        "2019-05-22 14:00": 2,
        "2019-05-22 14:15": 2,
        "2019-05-22 14:30": 2,
        "2019-05-22 14:45": 2,
    }


def test_quarter_keys_are_zero_padded(seeded):
    """`14:00` 不是 `14:0` —— 前端是拿字串當鍵對的,少一位就整格對不到。"""
    db = SessionLocal()
    _add(db, sid="q-pad", when=datetime(2019, 5, 23, 9, 5), asked_by="alice")
    db.commit()
    db.close()

    data = _stats(seeded, granularity="quarter", start="2019-05-23", end="2019-05-23")
    assert list(data["by_period"]) == ["2019-05-23 09:00"]


def test_quarter_buckets_honour_the_timezone(seeded):
    """一刻鐘也要吃 tz_offset,不然跟小時粒度一樣會整條平移。"""
    db = SessionLocal()
    # UTC 5/24 17:40 = 台灣 5/25 01:40 → 台灣的 01:30 那一格
    _add(db, sid="q-tz", when=datetime(2019, 5, 24, 17, 40), asked_by="alice")
    db.commit()
    db.close()

    data = _stats(
        seeded, granularity="quarter", start="2019-05-25", end="2019-05-25", tz_offset=480
    )
    assert data["by_period"] == {"2019-05-25 01:30": 1}


def test_quarter_is_an_accepted_granularity(seeded):
    """認得 quarter,而且沒把它當成認不得的值回 400。"""
    resp = seeded.get(
        "/api/stats", params={"granularity": "quarter", "start": "2019-05-11", "end": "2019-05-11"}
    )
    assert resp.status_code == 200, resp.text


def test_postgres_quarter_expression_compiles(monkeypatch):
    """PG 那條路要編得出來,而且是字串接字串。

    ⚠️ **本機測試跑的是 SQLite,PG 分支等於沒有人看過。** 這條不連資料庫,
    只把表示式編成 PG 的 SQL 再檢查形狀 —— 足以擋掉最容易犯的那兩種:
    `+` 被當成數值相加(少了 `type_=String`),以及分鐘取整寫成真除法。

    時區位移由 SQLAlchemy 自己編成 `make_interval(secs=>28800.0)` ——
    **具名參數**,所以不會有「把分放到時的位置上」那種事;這裡順便把它釘住,
    哪天有人改成自己手寫的位置參數版本會紅。
    """
    from sqlalchemy.dialects import postgresql

    from app.routers import stats as stats_mod

    monkeypatch.setattr(stats_mod, "DIALECT", "postgresql")
    sql = str(
        stats_mod._period_expr("quarter", tz_offset=480).compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )
    assert "to_char" in sql
    assert "||" in sql, f"字串要用 || 接起來,不是數值相加:{sql}"
    assert "%%" in sql or "%" in sql, f"分鐘要用取餘數往下取整:{sql}"
    assert "secs=>" in sql, f"時區位移要走具名的 make_interval(secs=>…):{sql}"
