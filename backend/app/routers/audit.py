from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..database import get_db

router = APIRouter(prefix="/api", tags=["audit"])

# 預設不顯示的中間狀態事件(理由見 _CATEGORIES 裡那段)。
HIDDEN_BY_DEFAULT_EVENT = "login_mfa_challenged"

# 事件分類(整張表的分法)。安全頁只用得到下面 SHOWN 那一類;這張表是給 `?all_events=1` 用的。
# 新增事件類型時記得歸到對應分類,不然它只會出現在「全部」。
_CATEGORIES = {
    # ⚠️ `login_mfa_failed` / `login_no_mfa_binding` 要列進來,不然它們只出現在
    # 「全部」——而那兩筆正是「密碼對了卻沒進來」的唯一線索,查登入問題的人
    # 一定是先點「登入」這一格。
    # `login_mfa_challenged` **刻意不在這裡,也不在「全部」**(預設):它是中間狀態,
    # 每一次正常登入都會多一列,畫面上一次登入只該看到一列成功。但後端**照記**
    # —— 它是「密碼對了卻沒完成第二關」的唯一證據。要看就帶
    # `?include_challenges=1`。
    # ⚠️ `login_blocked_geo` / `login_geo_dryrun`(地理封鎖)也要在這裡:
    # 開地理封鎖之前,要在「登入」這一格數試跑紀錄,找出「關掉試跑之後會被鎖在
    # 外面的人」。漏了的話那一步查不到東西。
    "login": [
        "login_success",
        "login_failed",
        "login_blocked",
        "login_blocked_geo",
        "login_geo_dryrun",
        "login_mfa_failed",
        "login_no_mfa_binding",
        # 前兩種是「這次登入少過了一關」的紀錄(境外白名單放行、公司 IP 免第二關),
        # 後兩種是名單本身被誰改了 —— 都只在「登入」這一格查得到,
        # 漏掉的話它們只會出現在「全部」裡,
        # 而查登入問題的人不會去那裡翻。
        "login_geo_allowlisted",
        "login_mfa_skipped_ip",
        "geo_allow_added",
        "geo_allow_removed",
    ],
    "account": [
        "account_created",
        "account_deleted",
        "account_disabled",
        "account_enabled",
        "role_changed",
        "password_reset",
        "password_changed",
        # 改密碼時「目前的密碼」打錯、打錯太多次被擋
        "password_change_failed",
        "password_change_blocked",
    ],
    # SSH 終端機(/ssh)。連線 / 斷線是「誰在什麼時候進了主機」;上傳與刪除是
    # 會改主機的動作。**不記鍵盤輸入與畫面內容**(會連 su 密碼一起記進去),
    # 也不記下載與列目錄(只是讀)。
    "terminal": [
        "terminal_connect",
        "terminal_connect_failed",
        "terminal_disconnect",
        "terminal_denied",
        "terminal_file_upload",
        "terminal_file_delete",
        # 收線時把這條連線開的程式結束掉:一樣是會改主機的動作,記幾支
        "terminal_end_programs",
        # 只記「誰在幾點問了一次」,問題與畫面內容一個字都不記
        "terminal_ai_ask",
        # Work Flow:一樣是「誰讓主機跑了東西」,歸在同一格。
        # 排程觸發的那幾筆 actor 是設定排程的人。
        "workflow_saved",
        "workflow_deleted",
        "workflow_run",
        "workflow_stop",
        # 排程到點、負責人失效(刪除、停用、沒有終端機權限)而跳過的那一次
        "workflow_run_denied",
    ],
}


# 安全頁「最近的事件」**只顯示這幾種**(只有登入這一類)。其他事件(帳號、職稱、白名單、
# 終端機、Work Flow…)**後端照記、畫面不顯示** —— 留著是為了事後還查得到
# 「誰刪了帳號、誰改了權限」。要看全部帶 `?all_events=1`(這時候才照上面的 _CATEGORIES 分類)。
#
# 登入:成功、失敗,加上「密碼沒問題卻沒進來」的幾種(被鎖、被地區擋、驗證碼錯、沒綁驗證器)。
# 放行類(境外白名單放行、公司 IP 免驗證碼)與試跑不在這裡。
SHOWN = {
    "login": [
        "login_success",
        "login_failed",
        "login_blocked",
        "login_blocked_geo",
        "login_mfa_failed",
        "login_no_mfa_binding",
    ],
}


@router.get(
    "/audit",
    response_model=schemas.AuditPage,
    dependencies=[Depends(auth.require_admin)],
)
def list_audit(
    category: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    include_challenges: bool = False,
    all_events: bool = False,
    db: Session = Depends(get_db),
):
    """稽核事件,最新的在前,分頁回傳。管理員專屬。

    category 是分類(目前只有 login),不給就是全部 —— 都只在 SHOWN 那幾種事件裡挑。
    all_events=1 才是整張表(category 照 _CATEGORIES 分,中間狀態照 include_challenges)。
    limit 夾在 1~200、offset 不得為負 —— 不夾的話一個 `?limit=99999999`
    就能把整張表撈進記憶體。

    分頁在後端做而不是前端切:每次登入都寫一筆稽核,這張表只會長不會短,
    整包送到前端再切等於每次開頁都把全部歷史下載一遍。
    """
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    # 不認得的分類要講,不要默默回全部(安全頁只有 login 一類)
    known = _CATEGORIES if all_events else SHOWN
    if category and category not in known:
        raise HTTPException(status_code=422, detail=f"不認得的分類 {category!r}")

    query = db.query(models.AuditLog)
    if not all_events:
        shown = SHOWN[category] if category in SHOWN else [e for events in SHOWN.values() for e in events]
        query = query.filter(models.AuditLog.event.in_(shown))
    elif category in _CATEGORIES:
        query = query.filter(models.AuditLog.event.in_(_CATEGORIES[category]))
    if not include_challenges:
        # 中間狀態預設不顯示(理由見 _CATEGORIES 上面那段);證據還在表裡
        query = query.filter(models.AuditLog.event != HIDDEN_BY_DEFAULT_EVENT)

    # total 要在套 limit/offset 之前算,而且要跟著同一組篩選條件走
    total = query.count()

    # 次要排序用 id:同一秒內的多筆(例如連續失敗的登入)光靠 created_at
    # 分不出先後,翻頁時順序可能跳動,同一筆會在兩頁都出現或兩頁都不見。
    items = (
        query.order_by(models.AuditLog.created_at.desc(), models.AuditLog.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {"items": items, "total": total}
