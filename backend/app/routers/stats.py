"""用量統計(管理員)。

兩層:`/api/stats` 是**總覽**(幾題、多少錢、誰問得多),
`/api/stats/questions` 以下是**明細** —— 問了什麼、每一步碰了什麼、耗掉多少 token。

明細這一層的資料來自 `models.QAStep`,沒有流水帳的問答**一列明細都沒有**。
所以每一筆都帶 `has_steps`,
前端才分得出「這題沒查任何檔」跟「這題沒有流水帳」——
兩者在畫面上都是一片空白,但意思完全相反。
"""

import time
from datetime import date, datetime, timedelta
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import Integer, String, case, cast, func
from sqlalchemy.orm import Session

from .. import auth, config, models, runs, schemas
from ..database import DIALECT, chunked, get_db

router = APIRouter(prefix="/api", tags=["stats"])

def _asker():
    """「這一題算誰問的」。

    ⚠️ **總覽的排行榜跟明細的篩選必須用同一條規則**:排行照 `owner` 分組、
    明細照 `coalesce(asked_by, owner)` 篩的話,點進去看到的題數跟排行上那個
    數字會對不起來 —— 而畫面上完全看不出是哪邊算錯(共用對話用得越多差越大)。

    採用的是**送出的人**,不是 owner:共用對話裡別人續問的那幾題,owner 掛的是
    原作者(見 ask.py 的 record_owner),用 owner 算會把題目記到沒問過它的人頭上,
    而這兩頁要回答的正是「這個人問了什麼」。
    `asked_by` 是 NULL 的紀錄,送出的人就是 owner,所以退回比 owner。
    """
    return func.coalesce(models.QARecord.asked_by, models.QARecord.owner)


def _with_asker(query):
    """只留有發問者的題目(asker 是 NULL 的不是一個帳號)。

    帳號數、已登入的題數、每人平均題數的折線、排行榜都用這一條分界,不要各自再寫一次。
    """
    return query.filter(_asker().isnot(None))


#: 題目清單一次最多回幾筆。給得比一般分頁大,因為這一頁的 `question` 是全文,
#: 而管理員的動作通常是「掃過去找那幾題特別貴的」,翻頁翻半天很難用。
MAX_QUESTION_PAGE = 200

# 期間分組的格式:日/月/年 → (SQLite strftime 的樣板, Postgres to_char 的樣板)。
# 兩種資料庫沒有共同的日期格式化函式,所以一個粒度兩個樣板放在同一筆 ——
# 分成兩個 dict 的話少加一邊不會有人發現。這是後端唯一一處要分 dialect 的**查詢**,
# 其他 SQL 都靠 SQLAlchemy 抹平(連線與 PRAGMA 的分岔在 database.py)。
#
# ⚠️ `hour` 的鍵是「日期 + 空格 + 兩位小時」(`2026-09-17 14`),**不是只有小時**。
# 只給小時的話,跨日的區間會把不同天的同一個鐘點併成一格。這一頁目前只在
# 「起訖是同一天」時用 hour(見前端的 `GRANULARITY`),但格式不該依賴那個前提。
_GRANULARITY_FORMAT = {
    # `quarter` = 一刻鐘。鍵長 `2026-09-17 14:30`,分鐘只會是 00/15/30/45。
    # 它的表示式不是單純套格式(要先把分鐘往下取整到 15 的倍數),見 `_period_expr`。
    #
    # ⚠️ **用量頁沒有用它**(見前端 `Stats.tsx` 的 `granularityFor()`)。留著是因為
    # 它不花成本 —— 沒人指定就不會走到這條分支。對應的測試守的是 SQL 的形狀
    # (字串串接、往下取整、PG 分支編得出來),跟有沒有人用無關。
    "quarter": ("%Y-%m-%d %H:", "YYYY-MM-DD HH24:"),
    "hour": ("%Y-%m-%d %H", "YYYY-MM-DD HH24"),
    "day": ("%Y-%m-%d", "YYYY-MM-DD"),
    "month": ("%Y-%m", "YYYY-MM"),
    "year": ("%Y", "YYYY"),
}

#: 一刻鐘幾分鐘(一天 96 點)。
_QUARTER_MINUTES = 15


def _floor_to_quarter(minute):
    """分鐘往下取整到 15 的倍數。

    ⚠️ **用取餘數,不要用 `minute / 15 * 15`。** SQLAlchemy 2.0 的 `/` 對 Integer
    走的是**真除法** —— `5 / 15 * 15` 會變成 `5.0`,結果 `09:05` 原封不動留著。
    `minute - minute % 15` 兩種資料庫都是整數運算,
    也不必擔心 dialect 之間的除法語意差異。

    ⚠️ 取整方向是**往下**:14:59 屬於 14:45 那一格。四捨五入的話,
    一筆資料會被算進**還沒發生**的那一格。
    """
    return minute - minute % _QUARTER_MINUTES


def _period_expr(granularity: str, column=None, tz_offset: int = 0):
    """`created_at` 依 granularity 截成字串('2026-09-04' / '2026-09' / '2026')。

    兩種資料庫回傳的字串格式一致,前端不用分。

    `column` 預設是 `QARecord.created_at`;登入人數那條序列要傳
    `AuditLog.created_at`(同一套格式,不然兩邊的期間鍵對不起來,
    sparkline 在時間軸上會錯開)。

    ⚠️ **`tz_offset` 一定要跟 `_apply_range` 傳同一個值。** 兩邊一個換算、一個沒換算
    的話,篩出來的區間跟分桶的邊界會錯開 —— 例如台灣選 9/17 單日,篩的是當地
    9/17 整天,卻照 UTC 分桶,畫面上會出現「9/16 16:00」這種不在區間裡的格子。
    """
    sqlite_format, pg_format = _GRANULARITY_FORMAT[granularity]
    if column is None:
        column = models.QARecord.created_at

    if DIALECT == "sqlite":
        # SQLite 的時間修飾詞要帶正負號(`+480 minutes` / `-300 minutes`)
        shifted = f"{tz_offset:+d} minutes"
        if granularity != "quarter":
            return func.strftime(sqlite_format, column, shifted)
        # 一刻鐘:小時之前照樣套格式,分鐘自己往下取整。
        #
        # ⚠️ **兩個 func 都要標 `type_=String`。** 不標的話 SQLAlchemy 當它們是
        # NullType,`+` 會編成**數值相加**而不是 `||` —— 出來的鍵變成 `2024`
        # 這種整數,pydantic 直接在回應那層炸。
        minute = cast(func.strftime("%M", column, shifted), Integer)
        return func.strftime(sqlite_format, column, shifted, type_=String) + func.printf(
            "%02d", _floor_to_quarter(minute), type_=String
        )

    # PG:讓 SQLAlchemy 把 timedelta 綁成 INTERVAL(它會編成
    # `make_interval(secs=>28800.0)` —— **具名**參數,所以不會把「分」放到「時」
    # 的位置上)。⚠️ 不要改成自己手寫的位置參數版本,那種錯只會在 Postgres 上出現,
    # 本機的 SQLite 測試一條都不會紅(`test_postgres_quarter_expression_compiles`
    # 把這個形狀釘住了)。
    shifted_col = column + timedelta(minutes=tz_offset)
    if granularity != "quarter":
        return func.to_char(shifted_col, pg_format)
    # ⚠️ 同上,`type_=String` 不能省(理由見 SQLite 那一段)。
    minute = cast(func.to_char(shifted_col, "MI"), Integer)
    return func.to_char(shifted_col, pg_format, type_=String) + func.to_char(
        _floor_to_quarter(minute), "FM00", type_=String
    )


#: 耗時分段的界線(毫秒)。10 秒 / 30 秒是使用者感受的兩道坎:
#: 10 秒內還算「等一下就好」,超過 30 秒就是「去做別的事再回來」。
_FAST_MS = 10_000
_SLOW_MS = 30_000


def _utc_window(
    start: Optional[date], end: Optional[date], tz_offset: int
) -> tuple[Optional[datetime], Optional[datetime]]:
    """當地的起訖日 → UTC 的 [下界, 上界) 這一對瞬間。

    ⚠️ **只有這一支在做時區換算。** 篩選、分桶、對照期全部從它拿邊界,
    各自寫一次的話遲早有一處忘了減 `tz_offset`,而那種錯在按日看只是幾筆資料
    在相鄰兩天之間飄,很難被發現。

    `end` 是**包含當天**的:使用者選 8/27 的意思是「連 8/27 一起看」,
    所以上界取 8/28 00:00 且不含。
    """
    lo = (
        datetime.combine(start, datetime.min.time()) - timedelta(minutes=tz_offset)
        if start
        else None
    )
    hi = (
        datetime.combine(end + timedelta(days=1), datetime.min.time())
        - timedelta(minutes=tz_offset)
        if end
        else None
    )
    return lo, hi


def _apply_window(query, column, lo: Optional[datetime], hi: Optional[datetime]):
    """把 [lo, hi) 套到某個時間欄位上。`None` = 那一端不設限。"""
    if lo is not None:
        query = query.filter(column >= lo)
    if hi is not None:
        query = query.filter(column < hi)
    return query


def _login_users_query(db: Session):
    """登入成功的事件。

    `login_failed` 的 actor 是「被嘗試的帳號名」,不保證是真帳號
    (見 models.AuditLog 的說明),所以只認成功那一種;actor 是 NULL 的也排除。
    """
    return (
        db.query(models.AuditLog)
        .filter(models.AuditLog.event == "login_success")
        .filter(models.AuditLog.actor.isnot(None))
    )


def _login_users(db: Session, lo: Optional[datetime], hi: Optional[datetime]) -> int:
    """這段期間**登入成功過**的不重複人數。

    ⚠️ 這跟「有幾個帳號問過問題」(`_summary` 的第三個值)**不是同一件事**:
    登入了卻沒問問題的人算在這裡、不算在那裡。畫面上的「登入人數」問的是
    「今天有幾個人進來」,所以走 audit_log 而不是 qa_records。
    """
    return (
        _apply_window(_login_users_query(db), models.AuditLog.created_at, lo, hi)
        .with_entities(models.AuditLog.actor)
        .distinct()
        .count()
    )


def _summary(query) -> tuple[int, float, int, int]:
    """(題數, 平均耗時 ms, 帳號數, 已登入的題數)。

    抽出來是因為**對照期要用同一套算法** —— 各算各的話,兩邊對「帳號數」的
    定義遲早分岔(例如一邊排除了沒有發問者的紀錄、另一邊沒有),而畫面上只會顯示成
    一個看不出哪裡怪的漲跌百分比。
    """
    asker = _asker()
    total = query.count()
    avg_duration = query.with_entities(
        func.coalesce(func.avg(models.QARecord.duration_ms), 0.0)
    ).scalar()
    asked = _with_asker(query)
    accounts = asked.with_entities(asker).distinct().count()
    logged_in = asked.count()
    return total, round(avg_duration, 1), accounts, logged_in


def _previous_window(
    start: Optional[date],
    end: Optional[date],
    tz_offset: int,
    now_utc: Optional[datetime] = None,
) -> Optional[tuple[datetime, datetime]]:
    """對照期的 UTC [下界, 上界)。同樣長度、緊接在目前區間之前。

    例:9/11–9/17(7 天)→ 9/4–9/10。

    ⚠️ **兩端都要有值才算**。只給一端(或選「全部」)時回 None ——
    那種情況下「同樣長度的前一段」沒有定義,拿資料裡的最早一筆去湊的話,
    區間長度會隨著資料庫內容變動,同一個畫面在不同時間點算出不同的漲跌。

    ⚠️ **目前這段還沒過完的話,對照期也只比到同樣的進度。**

    預設區間是「今天」,而今天到現在只過了半天;對照期若取昨天**一整天**,
    早上打開這一頁每一張卡都會顯示大幅衰退,而那個跌幅純粹是「還沒過完」
    造成的。

    所以 end 落在今天(或未來)時,對照期的上界取「對照期最後一天的同一個鐘點」:
    今天早上 9 點看到的就是「今天到 9 點」對「昨天到 9 點」。
    """
    if not start or not end:
        return None

    span = (end - start).days + 1
    prev_first = start - timedelta(days=span)
    prev_last = start - timedelta(days=1)

    lo_local = datetime.combine(prev_first, datetime.min.time())
    hi_local = datetime.combine(start, datetime.min.time())

    # 「現在」是呼叫端當地的現在(created_at 存 UTC,所以要加回位移)。
    # `now_utc` 只給測試注入 —— 沒有這個縫的話,「還沒過完」那條規則要嘛測不到,
    # 要嘛得去 patch `datetime`,而那會連帶影響同一支測試裡的其他時間。
    now_local = (now_utc or datetime.utcnow()) + timedelta(minutes=tz_offset)
    if end >= now_local.date():
        elapsed = now_local - datetime.combine(now_local.date(), datetime.min.time())
        hi_local = datetime.combine(prev_last, datetime.min.time()) + elapsed

    shift = timedelta(minutes=tz_offset)
    return lo_local - shift, hi_local - shift


@router.get("/stats", response_model=schemas.StatsOut, dependencies=[Depends(auth.require_admin)])
def get_stats(
    granularity: str = "day",
    start: Optional[date] = None,
    end: Optional[date] = None,
    #: 呼叫端所在時區跟 UTC 差幾分鐘(東時區為正,台灣是 480)。
    #: 前端送 `-new Date().getTimezoneOffset()`。預設 0 = 照 UTC 切
    #: (見 `_apply_range` 的說明)。
    #:
    #: ⚠️ **用 `Annotated` 寫,不要寫成 `tz_offset: int = Query(default=0, …)`。**
    #: 後者的預設值是一個 `Query` 物件,只有經過 FastAPI 才會變成 0 ——
    #: 而這兩支端點**有測試直接以 Python 函式呼叫**(`tests/test_qa_steps.py`),
    #: 那時 `tz_offset` 會是 `Query(0)`,一路帶到 SQL 才炸。
    tz_offset: Annotated[int, Query(ge=-840, le=840)] = 0,
    db: Session = Depends(get_db),
):
    if granularity not in _GRANULARITY_FORMAT:
        raise HTTPException(status_code=400, detail="granularity 只能是 quarter / hour / day / month / year")

    query = _apply_range(db.query(models.QARecord), start, end, tz_offset)

    total, avg_duration, account_count, logged_in_questions = _summary(query)
    total_cost = query.with_entities(func.coalesce(func.sum(models.QARecord.cost_usd), 0.0)).scalar()
    window_lo, window_hi = _utc_window(start, end, tz_offset)
    login_user_count = _login_users(db, window_lo, window_hi)

    period_expr = _period_expr(granularity, tz_offset=tz_offset)
    asker = _asker()

    by_period_rows = (
        query.with_entities(period_expr, func.count(models.QARecord.id))
        .group_by(period_expr)
        .order_by(period_expr)
        .all()
    )
    by_period = {p: c for p, c in by_period_rows}

    asked = _with_asker(query)

    # 有發問者的題目,依期間分組。只給「每人平均題數」那張卡的小折線當分子
    # (除以 logins_by_period,見 pages/Stats.tsx 的 perUserSeries)。
    by_period_logged_in = {
        p: c
        for p, c in (
            asked.with_entities(period_expr, func.count(models.QARecord.id))
            .group_by(period_expr)
            .order_by(period_expr)
            .all()
        )
    }

    # KPI 卡的 sparkline 各自一條序列(提問數那張直接用 by_period)
    avg_duration_rows = (
        query.with_entities(
            period_expr, func.coalesce(func.avg(models.QARecord.duration_ms), 0.0)
        )
        .group_by(period_expr)
        .order_by(period_expr)
        .all()
    )
    avg_duration_by_period = {p: round(v, 1) for p, v in avg_duration_rows}

    # 各帳號發問次數,多的排前面。沒有發問者(asker 是 NULL)的紀錄不列。
    # ⚠️ 分組的鍵一定要跟明細頁的篩選一致 —— 見 `_asker()`。
    by_user_rows = (
        asked.with_entities(asker, func.count(models.QARecord.id))
        .group_by(asker)
        .order_by(func.count(models.QARecord.id).desc())
        .all()
    )
    by_user = {name: c for name, c in by_user_rows}

    # 每個帳號的平均耗時。排行表的第四欄 —— 「誰問得多」旁邊接「他問的題跑多久」,
    # 那是同一個表格能回答的第二個問題。
    by_user_avg_rows = (
        asked.with_entities(
            asker, func.coalesce(func.avg(models.QARecord.duration_ms), 0.0)
        )
        .group_by(asker)
        .all()
    )
    by_user_avg_duration = {name: round(v, 1) for name, v in by_user_avg_rows}

    # 知識庫(哪個專案)。NULL 是沒指定專案的紀錄。
    kb_rows = (
        query.with_entities(models.QARecord.knowledge_base, func.count(models.QARecord.id))
        .group_by(models.QARecord.knowledge_base)
        .order_by(func.count(models.QARecord.id).desc())
        .all()
    )
    by_knowledge_base = {(kb or "(未指定)"): c for kb, c in kb_rows}

    # 題目狀態。⚠️ NULL 要當成 done:`status` 的欄位預設就是 "done",
    # 是 NULL 的紀錄都已經答完了。不 coalesce 的話畫面上會多出一條意義不明的「未標記」。
    status_expr = func.coalesce(models.QARecord.status, "done")
    status_rows = (
        query.with_entities(status_expr, func.count(models.QARecord.id))
        .group_by(status_expr)
        .order_by(func.count(models.QARecord.id).desc())
        .all()
    )
    by_status = {s: c for s, c in status_rows}

    # 耗時分三段。**平均看不出這件事** —— 少數跑很久的題目會把平均拉高,
    # 而平均回答不了「有幾題慢到讓人等不下去」。
    # NULL 的 duration_ms 當 0(還沒跑完或沒記到耗時的紀錄),歸到 fast。
    duration = func.coalesce(models.QARecord.duration_ms, 0.0)
    bucket_expr = case(
        (duration < _FAST_MS, "fast"),
        (duration < _SLOW_MS, "medium"),
        else_="slow",
    )
    bucket_rows = (
        query.with_entities(bucket_expr, func.count(models.QARecord.id))
        .group_by(bucket_expr)
        .all()
    )
    counted = {b: c for b, c in bucket_rows}
    # 固定照快→慢的順序,而且**沒有那一段也要出現(0)** ——
    # 少一段的話堆疊條的顏色會跟著位移,兩次查詢之間同一段變成不同顏色。
    by_duration_bucket = {b: counted.get(b, 0) for b in ("fast", "medium", "slow")}

    logins_rows = _apply_window(
        _login_users_query(db), models.AuditLog.created_at, window_lo, window_hi
    )
    login_period_expr = _period_expr(
        granularity, models.AuditLog.created_at, tz_offset=tz_offset
    )
    logins_by_period = {
        p: c
        for p, c in (
            logins_rows.with_entities(
                login_period_expr, func.count(func.distinct(models.AuditLog.actor))
            )
            .group_by(login_period_expr)
            .order_by(login_period_expr)
            .all()
        )
    }

    previous = None
    prev_window = _previous_window(start, end, tz_offset)
    if prev_window:
        prev_lo, prev_hi = prev_window
        prev_total, prev_avg, prev_accounts, prev_logged_in = _summary(
            _apply_window(
                db.query(models.QARecord), models.QARecord.created_at, prev_lo, prev_hi
            )
        )
        previous = schemas.StatsPrevious(
            total_questions=prev_total,
            avg_duration_ms=prev_avg,
            account_count=prev_accounts,
            login_user_count=_login_users(db, prev_lo, prev_hi),
            logged_in_questions=prev_logged_in,
        )

    return schemas.StatsOut(
        total_questions=total,
        total_cost_usd=round(total_cost, 4),
        avg_duration_ms=avg_duration,
        by_period=by_period,
        by_user=by_user,
        by_user_avg_duration=by_user_avg_duration,
        account_count=account_count,
        by_period_logged_in=by_period_logged_in,
        avg_duration_by_period=avg_duration_by_period,
        by_knowledge_base=by_knowledge_base,
        by_duration_bucket=by_duration_bucket,
        by_status=by_status,
        login_user_count=login_user_count,
        logged_in_questions=logged_in_questions,
        logins_by_period=logins_by_period,
        previous=previous,
    )


@router.get(
    "/stats/running",
    response_model=schemas.RunningQuestionList,
    dependencies=[Depends(auth.require_admin)],
)
def running_questions():
    """**現在**有誰在問問題。管理員專用,全站一覽。

    為什麼要另外開一支,而不是用 `/api/ask/runs`:那一支**刻意**只回「自己的 +
    分享給自己的」(見 ask.py 的 list_runs),管理員也不例外 —— 它的用途是
    「把我離開前問到一半的對話接回來」,不是監看。兩種需求的可見範圍相反,
    共用一支端點只會讓其中一邊出錯。

    ⚠️ 資料只在記憶體裡(runs.py),所以**服務一重啟就全空**。而且這裡只列
    「還在跑」的(`runs.active()` 濾掉 `done`)—— 跑完的**當下**就從這份清單
    消失,不會停留。這一頁回答的是「此刻」,不是歷史;歷史看
    `/api/stats/questions` 裡 status=running 的那些。
    """
    now = time.time()
    return schemas.RunningQuestionList(
        items=[
            schemas.RunningQuestion(
                run_id=r.run_id,
                conversation_id=r.conversation_id,
                # 進行中的題目**在統計頁上要看得到問題原文**:管理員要判斷的正是
                # 「他在問什麼、值不值得跑這麼久」。這一頁本來就只有管理員進得來。
                question=r.question,
                owner=r.owner,
                knowledge_base=r.knowledge_base_id,
                elapsed_ms=int((now - r.started_at) * 1000),
            )
            for r in runs.active()
        ]
    )


def _apply_range(
    query, start: Optional[date], end: Optional[date], tz_offset: int = 0
):
    """把起訖日套到 QARecord 上。兩支端點共用,避免只改到其中一支。

    `end` 是**包含當天**的:使用者選 8/27 的意思是「連 8/27 一起看」,
    直接拿它當上界會把當天整天濾掉,而畫面上只會顯示成「今天沒人問問題」。

    ⚠️ **`created_at` 存的是 UTC**(`datetime.utcnow`),而使用者挑的 8/27 是
    **他當地的** 8/27。`tz_offset`(分鐘,東時區為正)就是這兩者的差:
    當地 8/27 00:00 換成 UTC 是 `8/27 00:00 - tz_offset`。

    少了這個換算,台灣的「今天」實際查到的是 UTC 的今天 = 當地今天早上 8 點到
    明天早上 8 點 —— 當地凌晨到 08:00 的題目會被算進**前一天**。按日看只是幾筆
    在相鄰兩天之間飄,按小時看就是整條曲線平移八小時。

    預設 0 = 照 UTC 切。
    """
    lo, hi = _utc_window(start, end, tz_offset)
    # Work Flow 通知寫進去的那幾題是執行結果、不是有人問的問題(config.WORKFLOW_OWNER)。
    # 看「送出的人」:有人在那組對話裡續問的話,那一題的 owner 仍是 WORKFLOW_OWNER、asked_by 是真人,要算
    # 用 _asker(同一條「誰送出的」規則);coalesce 成空字串是為了讓兩欄都 NULL 的紀錄照樣算
    query = query.filter(func.coalesce(_asker(), "") != config.WORKFLOW_OWNER)
    return _apply_window(query, models.QARecord.created_at, lo, hi)


@router.get(
    "/stats/questions",
    response_model=schemas.QuestionUsageList,
    dependencies=[Depends(auth.require_admin)],
)
def list_questions(
    user: Optional[str] = None,
    start: Optional[date] = None,
    end: Optional[date] = None,
    #: 呼叫端所在時區跟 UTC 差幾分鐘(東時區為正,台灣是 480)。
    #: 前端送 `-new Date().getTimezoneOffset()`。預設 0 = 照 UTC 切
    #: (見 `_apply_range` 的說明)。
    #:
    #: ⚠️ **用 `Annotated` 寫,不要寫成 `tz_offset: int = Query(default=0, …)`。**
    #: 後者的預設值是一個 `Query` 物件,只有經過 FastAPI 才會變成 0 ——
    #: 而這兩支端點**有測試直接以 Python 函式呼叫**(`tests/test_qa_steps.py`),
    #: 那時 `tz_offset` 會是 `Query(0)`,一路帶到 SQL 才炸。
    tz_offset: Annotated[int, Query(ge=-840, le=840)] = 0,
    q: Optional[str] = None,
    order: str = "created_at",
    limit: int = Query(default=50, ge=1, le=MAX_QUESTION_PAGE),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """題目清單:誰、什麼時候、問了什麼、花了多少。

    `order` 只吃三個值 —— 時間、成本、token。開放任意欄位等於讓請求決定
    ORDER BY 的內容,而這支端點的參數是從網址來的。
    """
    if order not in ("created_at", "cost_usd", "tokens"):
        raise HTTPException(status_code=400, detail="order 只能是 created_at / cost_usd / tokens")

    query = _apply_range(db.query(models.QARecord), start, end, tz_offset)
    if user:
        query = query.filter(_asker() == user)
    if q:
        # 只搜問題,不搜答案:答案動輒幾千字,`LIKE '%…%'` 掃過去會很慢,
        # 而管理員在這一頁找的是「誰又在問 XXX」,不是答案內容。
        # ilike 不是 like:Postgres 的 LIKE 分大小寫,搜 fqc 找不到 FQC;
        # 對話搜尋(conversations.py)用的也是 ilike,兩邊行為要一樣。
        query = query.filter(models.QARecord.question.ilike(f"%{q}%"))

    total = query.count()

    # 這一頁的彙總:先取出要顯示的那幾筆,再只對它們去彙總 qa_steps。
    # 反過來(先 join 再分頁)會讓資料庫把整張流水帳掃一遍才知道要哪 50 筆。
    if order == "cost_usd":
        # NULL 當 0:進行中/失敗的題目沒有成本,讓它們擠在「最貴」前面沒有意義
        rows = query.order_by(
            func.coalesce(models.QARecord.cost_usd, 0.0).desc(), models.QARecord.id.desc()
        )
    else:
        # created_at 與 tokens 都先照時間取這一頁,tokens 的排序在下面用 Python 做
        rows = query.order_by(models.QARecord.created_at.desc())

    records = rows.offset(offset).limit(limit).all()
    ids = [r.id for r in records]
    totals = _step_totals(db, ids)

    items = [_usage_item(record, totals) for record in records]

    # 照 token 排序要等彙總算完才做得到(它不在 qa_records 裡)。只排這一頁 ——
    # 跨頁的正確排序得先 join 整張流水帳,而那正是上面刻意避開的事。
    # ⚠️ 所以 order=tokens 的語意是「這一頁裡誰最耗」,不是「全站最耗的前 N 題」。
    if order == "tokens":
        items.sort(key=lambda i: i.input_tokens + i.output_tokens, reverse=True)

    return schemas.QuestionUsageList(items=items, total=total)


#: `QuestionUsageItem` 直接從 `QARecord` 抄過來的欄位。
#: 具名一次,清單頁與詳細頁共用 —— 兩邊各寫一份的話,加一個欄位只會有一頁看得到。
_RECORD_FIELDS = (
    "id", "created_at", "owner", "asked_by", "conversation_id",
    "question", "knowledge_base", "duration_ms", "cost_usd", "status",
    # 使用者把這組對話刪掉了。**這一頁刻意仍然列出它們** —— 帳要留得住,
    # 見 models.QARecord.deleted_at。內容(question)在刪除當下就被清空了,
    # 所以前端要靠這個欄位把它顯示成「已刪除」而不是一題空白的問題。
    "deleted_at",
)


def _steps_expired(record) -> bool:
    """這一題的流水帳是不是已經過了保留期被清掉了。

    這是「沒有明細」的第三種原因:超過 `QA_STEPS_RETENTION_DAYS` 的題目
    token 欄位一律是空的(`database.purge_expired_steps` 清掉的)。

    不分開講的話,那些空白會被讀成「這題沒查任何檔」或「數字算錯了」。
    所以由後端算好告訴前端:
    保留期是後端的設定,讓前端自己拿天數去減只會讓兩邊漂掉。
    """
    days = config.QA_STEPS_RETENTION_DAYS
    if days <= 0 or record.created_at is None:
        return False
    return record.created_at < datetime.utcnow() - timedelta(days=days)


def _usage_item(record, totals: dict) -> schemas.QuestionUsageItem:
    """一筆問答 + 它的流水帳彙總 → 回應物件。"""
    return schemas.QuestionUsageItem(
        **{c: getattr(record, c) for c in _RECORD_FIELDS},
        steps_expired=_steps_expired(record),
        # SQLite 的 boolean 是 0/1,而欄位可能是 NULL —— 都要收斂成真正的 bool,
        # 不然 pydantic 會為了 NULL 丟驗證錯誤。
        success=bool(record.success),
        **totals.get(record.id, _EMPTY_TOTALS),
    )


_EMPTY_TOTALS = {
    "has_steps": False,
    "turns": 0,
    "tool_calls": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_creation_tokens": 0,
}


def _step_totals(db: Session, record_ids: list) -> dict:
    """一次把這幾題的流水帳彙總起來,回傳 {record_id: 各項合計}。

    一定要一次查完:一頁 50 題、一題一次查詢就是 50 趟往返,而這一頁本來就
    是給人「掃過去找異常」用的,慢一秒就沒人會打開。
    """
    if not record_ids:
        return {}

    totals: dict = {}
    for chunk in chunked(record_ids):
        rows = (
            db.query(
                models.QAStep.qa_record_id,
                models.QAStep.kind,
                func.count(models.QAStep.id),
                func.coalesce(func.sum(models.QAStep.input_tokens), 0),
                func.coalesce(func.sum(models.QAStep.output_tokens), 0),
                func.coalesce(func.sum(models.QAStep.cache_read_tokens), 0),
                func.coalesce(func.sum(models.QAStep.cache_creation_tokens), 0),
            )
            .filter(models.QAStep.qa_record_id.in_(chunk))
            .group_by(models.QAStep.qa_record_id, models.QAStep.kind)
            .all()
        )
        for rid, kind, count, tin, tout, tcache_r, tcache_c in rows:
            entry = totals.setdefault(rid, dict(_EMPTY_TOTALS))
            entry["has_steps"] = True
            if kind == "tool":
                entry["tool_calls"] += count
            elif kind == "turn":
                entry["turns"] += count
            # subturn(子代理)不計進「輪」—— 它不是主線的一輪,混進去
            # 「跑了幾輪」會失真。但它花掉的 token 一定要算,所以下面不分 kind。
            entry["input_tokens"] += tin
            entry["output_tokens"] += tout
            entry["cache_read_tokens"] += tcache_r
            entry["cache_creation_tokens"] += tcache_c
    return totals


@router.get(
    "/stats/questions/{record_id}",
    response_model=schemas.QuestionUsageDetail,
    dependencies=[Depends(auth.require_admin)],
)
def question_detail(record_id: int, db: Session = Depends(get_db)):
    """單題的時間軸:第幾步、什麼工具、碰了哪個檔、那一輪耗掉多少 token。"""
    record = db.get(models.QARecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="找不到這一題")

    steps = (
        db.query(models.QAStep)
        .filter(models.QAStep.qa_record_id == record_id)
        .order_by(models.QAStep.seq)
        .all()
    )

    # 重複碰到的標的。只算工具列,而且只留真的重複的(≥2)——
    # 全部列出來的話這張表會跟時間軸一樣長,而它要回答的是一個很窄的問題:
    # 「它是不是在原地繞?」
    counts: dict = {}
    for step in steps:
        if step.kind != "tool" or not step.target:
            continue
        key = (step.tool or "", step.target)
        counts[key] = counts.get(key, 0) + 1
    repeats = [
        schemas.RepeatedTarget(tool=tool, target=target, count=count)
        for (tool, target), count in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        if count >= 2
    ]

    return schemas.QuestionUsageDetail(
        question=_usage_item(record, _step_totals(db, [record_id])),
        steps=[schemas.StepItem.model_validate(s) for s in steps],
        repeats=repeats,
    )
