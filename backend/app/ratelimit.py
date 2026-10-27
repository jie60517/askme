"""登入嘗試次數限制。

只擋登入,不擋其他 API —— 其他路徑要 token 才進得來,而 token 是猜不到的
(secrets.token_urlsafe(32),256 bits)。真正能被硬撞的只有 /api/login。

失敗計數放在記憶體(重啟清空),**但「已經鎖上的 IP」會寫進資料庫,重啟後載回來**。
兩者分開處理:每失敗一次就寫一列的話,對方猛撞幾十萬次等於替他開一條塞硬碟的路;
而「鎖上」是每 10 次失敗最多一列、同一個 IP 只有一列,寫入量有上限。

⚠️ **記憶體那份才是查詢時的真相。** 資料庫那張表(models.LoginIPBlock)只在
三個時機被碰:開機載回(`load_persisted_blocks`)、鎖上、解鎖。`check()` 一律
不查資料庫 —— 登入路徑上多一次查詢沒有意義,而且兩份都能回答的時候,遲早
會出現只更新其中一份的路徑。

⚠️ **兩層鎖的到期行為不一樣,不要以為都會自己解開**:

- 帳號層:預設 **5 次鎖 15 分鐘**。取捨見 config.py ——
  它 15 分鐘就自動解、擋不了認真攻擊,還能被拿來惡意鎖別人。**不落地**:
  它 15 分鐘就過期,重啟等於提早幾分鐘放行,不值得為它寫資料庫。
- IP 層:預設 `LOGIN_IP_LOCKOUT_SEC=0` = **永久封鎖**(`PERMANENT`),
  不會自己解開,要管理員到「安全」頁按解鎖(見 routers/locks.py)。**會落地**,
  所以「永久」在重啟之後仍然有效。

也就是說,實際跑起來唯一會生效的那一層是**不自動到期、而且重啟還在**的。

⚠️ **重啟解不開,所以要有另一條退路:** `LOGIN_IP_ALLOWLIST`
(公司的對外 IP):名單裡的來源連計數都不記,永遠鎖不上 —— 這是唯一的例外,
帳號層與地理封鎖都不看它。真的把自己鎖在外面又不在公司,見 routers/locks.py
檔頭的手動解法。
"""

import ipaddress
import logging
import math
import threading
import time
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Request
from starlette.requests import HTTPConnection

from . import clientip, config, models
from .database import SessionLocal

logger = logging.getLogger(__name__)

# check() 與 snapshot() 用它表示「不會自己解開,要人來放」。
# 用 -1 而不是 None,呼叫端才不用為了這件事多一種型別分支。
PERMANENT = -1

# key -> (失敗次數, 這一輪的計數從什麼時候開始, 鎖到什麼時候為止)
# 第三個值是 math.inf 就代表永久封鎖。
_Entry = tuple[int, float, float]

_lock = threading.Lock()
_accounts: dict[str, _Entry] = {}
_ips: dict[str, _Entry] = {}

# 落地那幾支共用的鎖。**跟 `_lock` 是兩把,不能合併也不能對調順序。**
#
# 為什麼要第二把:寫資料庫的動作刻意放在 `_lock` 外面(那把鎖擋著所有人的登入
# 判斷,不能塞 I/O 進去),但「寫入」與「刪除」彼此仍然要排隊,否則有這個競態:
#
#   攻擊者第 10 次失敗 → 在 `_lock` 內把記憶體設成永久封鎖 → 放開鎖(還沒寫 DB)
#   管理員此刻按解鎖   → 清掉記憶體、DELETE(當時表裡還沒有那一列)
#   前一條路才 INSERT  → 記憶體是解鎖的、資料庫留著一列 → **重啟後自己回來**
#
# 那正是 `reset()` 宣稱要修掉的症狀,而且最可能發生的時機就是「攻擊者在猛撞、
# 管理員正在處理」——也就是這個功能唯一真正被用到的場合。
#
# ⚠️ 取鎖順序永遠是 `_db_lock` → `_lock`,**不准反過來**(`_lock` 裡面不取
# `_db_lock`)。兩邊都只在自己那層停留,所以不會死鎖。
_db_lock = threading.Lock()

# 超過這個數量就順手清一次過期的。不清的話,被字典攻擊掃過一輪之後
# 這兩張表會留著幾萬個永遠不會再用到的 key。
_SWEEP_THRESHOLD = 1024


def client_ip(request: HTTPConnection) -> str:
    """請求的來源 IP。`Request` 與 `WebSocket` 都收(兩者都是 HTTPConnection,標頭與 client 同一個形)。

    放在 nginx 後面時**這裡通常不用做任何事**:uvicorn 的 `--proxy-headers`
    會在來源位址落在 `FORWARDED_ALLOW_IPS` 時,照 X-Forwarded-For / X-Forwarded-Proto
    把 `request.client` 與 `request.url.scheme` 換成真的。nginx 跑在 docker
    容器裡的話,來源是容器網段(不是 127.0.0.1),`.env` 要填容器位址
    (見 deploy/env.server.example);填錯的症狀是所有人都變成同一個來源。
    不要開下面這個旗標來補救 —— 那條路不看來源,誰送標頭都信。

    TRUST_PROXY_HEADER 留給「uvicorn 前面還有一層 uvicorn 認不出來的代理」的情況。
    開了就取 X-Forwarded-For **最右邊**那一跳:代理是往右追加的,最右邊是最後一個
    代理看到的來源;最左邊那個是客戶端自己填的,誰都能寫,拿它當 key 等於 IP 層不存在。
    """
    if config.TRUST_PROXY_HEADER:
        forwarded = request.headers.get("x-forwarded-for", "")
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.client.host if request.client else "unknown"


def is_https(request: Request) -> bool:
    """這一次連線是不是 https。

    跟 `client_ip` 放在一起、用同一個依據(`TRUST_PROXY_HEADER`):放在
    nginx 後面時,uvicorn 自己看到的 scheme 永遠是 http —— 只看
    `request.url.scheme` 會漏判。**「代理標頭能不能信」這件事只該有一份判斷**,
    所以不要在別的模組再讀一次 X-Forwarded-*。

    用途是決定登入 cookie 要不要標 Secure(見 routers/auth.py)。
    """
    if config.TRUST_PROXY_HEADER:
        proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
        if proto:
            return proto == "https"
    return request.url.scheme == "https"


# ------------------------------------------------------------------- 白名單
#
# 解析過的 `config.LOGIN_IP_ALLOWLIST`。存成 (原始字串, 網段清單):設定值變了
# 就重算 —— 測試會 monkeypatch 那個字串,用 lru_cache 的話改了不生效,
# 而那種失效是安靜的(測試過了,實際上比對的還是舊名單)。
_allow_cache: tuple[Optional[str], list] = (None, [])


def _allow_networks() -> list:
    global _allow_cache
    raw = config.LOGIN_IP_ALLOWLIST
    if _allow_cache[0] == raw:
        return _allow_cache[1]

    nets = []
    for item in raw.replace(";", ",").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            # strict=False:允許 `203.0.113.5/24` 這種主機位址帶前綴的寫法,
            # 照網段解讀。要求嚴格的話,填的人只會看到啟動失敗而不知道差在哪。
            nets.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            # 不讓一行打錯就擋住服務起來,但要留下痕跡 —— 這個設定的失效是
            # 安靜的(白名單少一條,症狀是「公司偶爾被鎖」,幾週後才有人抱怨)。
            logger.warning("LOGIN_IP_ALLOWLIST 裡有一項讀不懂,略過:%r", item)

    _allow_cache = (raw, nets)
    return nets


def is_allowlisted(ip: str) -> bool:
    """這個來源是不是公司自己的 IP(`LOGIN_IP_ALLOWLIST`)。

    **唯一的例外清單。** 帳號層照樣會鎖(在公司裡連打錯 5 次,那個帳號還是鎖
    15 分鐘),地理封鎖也不看這裡(那一關的例外在 `geo_allow.py`)。

    ⚠️ **這支不只被鎖定用到**:`routers/auth.py` 也拿它判斷
    「這次登入要不要跳過第二關」(`config.MFA_SKIP_ON_TRUSTED_IP`)。
    也就是說,往 `LOGIN_IP_ALLOWLIST` 加一個 IP 同時做了兩件事 ——
    改那個設定之前先看 config 裡它的說明。

    解析與 IPv4-mapped 的還原走 `clientip.parse`(三道判定共用一份)——
    不還原的話公司的 IP 會比不中,而症狀是「白名單有時候有用有時候沒用」。
    """
    nets = _allow_networks()
    if not nets:
        return False
    addr = clientip.parse(ip)
    if addr is None:
        # `unknown`(client_ip 抓不到來源時的回傳值)會走到這裡。**不能算白名單** ——
        # 那是「不知道是誰」,不是「是公司」。
        return False
    return any(addr.version == net.version and addr in net for net in nets)


# --------------------------------------------------------------- 落地與載回
#
# 只有 IP 層會落地。這幾支都**不在 `_lock` 裡面呼叫**:它們會碰資料庫,
# 而那個鎖擋著所有人的登入判斷,不該把一次 I/O 放進去。


def _db_session():
    """開一個 session。**開不起來就回 None**,呼叫端據此放棄這次落地。

    連 `SessionLocal()` 這一步都要保護,不能只包住後面的查詢:engine 掛掉、
    連線池爆掉的時候是它先丟例外,而這幾支跑在使用者登入失敗的請求裡 ——
    讓它往上冒等於「資料庫一有問題,登入就變成 500」,而登入正是攻擊者
    有辦法一直重打的那條路。
    """
    try:
        return SessionLocal()
    except Exception:  # noqa: BLE001
        logger.warning("開不了資料庫連線,這次的 IP 封鎖落地跳過", exc_info=True)
        return None


def _still_locked(ip: str) -> bool:
    """記憶體那份現在還鎖著這個 IP 嗎(呼叫端**不可**持有 `_lock`)。"""
    now = time.time()
    with _lock:
        entry = _ips.get(ip)
    return entry is not None and entry[2] > now


def _persist_block(ip: str, locked_until: float) -> None:
    """把「這個 IP 被鎖了」寫進資料庫。`locked_until` 是 inf 就是永久(存 NULL)。

    寫不進去只記 log,不往上丟:這條路是在使用者登入失敗的請求裡跑的,
    資料庫出問題時該退化成「這次鎖定只活在記憶體」,而不是把登入變成 500 ——
    後者等於讓攻擊者用猛撞把服務打掛(形狀同 `audit.record`)。
    """
    expires_at = (
        None
        if math.isinf(locked_until)
        else datetime.utcnow() + timedelta(seconds=max(0.0, locked_until - time.time()))
    )
    with _db_lock:
        # ⚠️ **寫之前再確認一次記憶體還鎖著。** 從呼叫端放開 `_lock` 到這裡,
        # 管理員可能剛好按了解鎖(見 `_db_lock` 的說明)—— 少了這一步,
        # 那次解鎖會被這筆寫入蓋回去,而症狀要等到下次重啟才出現。
        if not _still_locked(ip):
            logger.info("IP %s 在寫入資料庫之前就被解鎖了,這筆封鎖不寫", ip)
            return

        db = _db_session()
        if db is None:
            return
        try:
            row = db.get(models.LoginIPBlock, ip)
            if row is None:
                db.add(models.LoginIPBlock(ip=ip, expires_at=expires_at))
            else:
                # 已經有一列(上次鎖過、解鎖後又被鎖)。覆蓋成這次的到期時間,
                # 並把 blocked_at 更新成現在 —— 管理員看的是「什麼時候被鎖的」,
                # 留著幾個月前那個時間會讓他以為這是一筆沒清乾淨的舊資料。
                row.blocked_at = datetime.utcnow()
                row.expires_at = expires_at
            db.commit()
        except Exception:  # noqa: BLE001 —— 任何資料庫問題都不該擋住登入流程
            db.rollback()
            logger.warning(
                "IP 封鎖沒能寫進資料庫(%s),這次鎖定只會留在記憶體", ip, exc_info=True
            )
        finally:
            db.close()


def _forget_block(ip: Optional[str]) -> bool:
    """解鎖時把資料庫那一列刪掉。`ip` 是 None 代表全部清掉。回傳有沒有成功。

    ⚠️ **不刪的話,解鎖只有這一次有效** —— 下次重啟又被載回來,而管理員
    完全看不出為什麼他解過的 IP 自己回來了。

    ⚠️ **這裡回傳成功與否、而不是像寫入那樣默默吞掉**,因為兩邊的使用者不一樣:
    寫入跑在陌生人登入失敗的請求裡(炸了等於送對方一個打垮服務的手段),刪除
    跑在管理員按下解鎖的請求裡 —— 他需要知道這次到底成不成功。吞掉的話,
    畫面顯示解鎖成功、重啟後那個 IP 又回來,而唯一的線索在伺服器日誌裡。
    """
    with _db_lock:
        db = _db_session()
        if db is None:
            return False
        try:
            query = db.query(models.LoginIPBlock)
            if ip is not None:
                query = query.filter(models.LoginIPBlock.ip == ip)
            query.delete(synchronize_session=False)
            db.commit()
            return True
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.warning("IP 封鎖沒能從資料庫刪除(%s)", ip, exc_info=True)
            return False
        finally:
            db.close()


def load_persisted_blocks() -> int:
    """開機時把還沒過期的 IP 封鎖載回記憶體,回傳載了幾筆。順手刪掉過期的列。

    載回來的 entry **失敗計數從 0 算起**:計數本來就是「多久內失敗幾次」的過程值,
    重啟後沒有意義,而且鎖上的那一刻本來就會歸零(見 `_register`)。

    白名單裡的 IP 會被跳過而不是載回來 —— 名單可能是在被鎖之後才加上的
    (「公司被鎖了,趕快把公司 IP 加進白名單」正是最可能發生的情境),
    這時候那一列該當作不存在,不然加了白名單還是進不來。順便把它刪掉。

    ⚠️ **這是有限秒數模式(`LOGIN_IP_LOCKOUT_SEC>0`)唯一會清掉過期列的地方。**
    服務跑著的時候,鎖自己到期不會有人回頭刪那一列 —— 記憶體那份由 `_sweep`
    清,資料庫那份留到下次開機。那不影響行為(`check()` 只看記憶體,而載回時
    過期的列會被跳過),代價只是表在兩次重啟之間會多留幾列。要為它加一支
    背景清理不划算:預設是永久封鎖,那種列本來就不該過期。
    """
    now_dt = datetime.utcnow()
    now = time.time()
    loaded = 0
    db = _db_session()
    if db is None:
        return 0
    try:
        rows = db.query(models.LoginIPBlock).all()
        stale = []
        with _lock:
            for row in rows:
                if row.expires_at is not None and row.expires_at <= now_dt:
                    stale.append(row.ip)
                    continue
                if is_allowlisted(row.ip):
                    stale.append(row.ip)
                    continue
                locked_until = (
                    math.inf
                    if row.expires_at is None
                    else now + (row.expires_at - now_dt).total_seconds()
                )
                _ips[row.ip] = (0, now, locked_until)
                loaded += 1
        for ip in stale:
            db.query(models.LoginIPBlock).filter(models.LoginIPBlock.ip == ip).delete(
                synchronize_session=False
            )
        if stale:
            db.commit()
    except Exception:  # noqa: BLE001 —— 載不回來不該擋住服務起來
        db.rollback()
        logger.warning("讀不回已封鎖的 IP 清單,這次啟動等於全部放行", exc_info=True)
    finally:
        db.close()
    return loaded


def _sweep(table: dict[str, _Entry], now: float, window: float) -> None:
    """清掉已經沒有意義的紀錄(呼叫端必須持有 _lock)。"""
    stale = [
        key
        for key, (_, started_at, locked_until) in table.items()
        if locked_until <= now and started_at + window <= now
    ]
    for key in stale:
        table.pop(key, None)


def _retry_after(table: dict[str, _Entry], key: str, now: float) -> int:
    """這個 key 還要等幾秒。0 代表沒有被鎖,PERMANENT 代表要人工解鎖。"""
    entry = table.get(key)
    if entry is None:
        return 0
    _, _, locked_until = entry
    if math.isinf(locked_until):
        return PERMANENT
    return max(0, int(locked_until - now + 0.999))


def _register(
    table: dict[str, _Entry], key: str, now: float, limit: int, lockout: float
) -> Optional[float]:
    """記一次失敗,滿了就上鎖(呼叫端必須持有 _lock)。

    lockout <= 0 代表永久封鎖 —— 時間到不會自己解開,只能由管理員在 /security 放行。

    回傳**這一次剛鎖上**的到期時間(永久是 `math.inf`),沒鎖上就回 None。
    IP 層的呼叫端拿它決定要不要寫資料庫 —— 讓這支自己去寫的話,寫入會發生在
    `_lock` 裡面,一次資料庫 I/O 就擋住所有人的登入判斷。
    """
    permanent = lockout <= 0
    count, started_at, locked_until = table.get(key, (0, now, 0.0))

    if math.isinf(locked_until):
        return None  # 已經永久封鎖了,不用再記(也不用再寫一次資料庫)

    # 計數的有效期。永久模式沒有「鎖定時長」可以拿來當視窗,用固定 15 分鐘 ——
    # 少了這個,計數永遠不歸零,一個偶爾打錯字的人累積幾個月也會被永久封鎖。
    window = 900.0 if permanent else lockout

    # 上一輪的計數已經過期(距離第一次失敗超過一個視窗,而且沒在鎖定中),
    # 從頭算起 —— 不然一個打錯過幾次密碼的人,幾天後再打錯一次就被鎖,
    # 而他完全不知道自己「累積」了什麼。
    if locked_until <= now and started_at + window <= now:
        count, started_at = 0, now

    count += 1
    if count >= limit:
        # 鎖上,並把計數歸零 —— 解鎖後重新給滿額度,而不是一失敗就再鎖一次
        until = math.inf if permanent else now + lockout
        table[key] = (0, now, until)
        return until

    table[key] = (count, started_at, locked_until)
    return None


def check(username: str, ip: str) -> int:
    """還要等幾秒才能再試。0 = 可以試,PERMANENT = 要人工解鎖。

    兩層都在鎖時取「比較嚴」的那個,告訴他寬鬆的那個等於騙他 ——
    而永久一定比任何秒數嚴,所以不能直接拿 max 比(PERMANENT 是 -1)。

    帳號層停用時(LOGIN_MAX_ATTEMPTS<=0)完全不看帳號,只認 IP。

    白名單(公司 IP)直接跳過 IP 那層。**這裡也要判一次,不能只靠記錄那一側** ——
    名單可能是在鎖上之後才加的,那時候記憶體與資料庫裡都還留著那一列;
    只在 `record_*` 判斷的話,加了白名單仍然進不來,而那正是最需要它的時候。
    """
    now = time.time()
    allowlisted = is_allowlisted(ip)
    with _lock:
        account_wait = _retry_after(_accounts, username, now) if config.LOGIN_MAX_ATTEMPTS > 0 else 0
        ip_wait = 0 if allowlisted else _retry_after(_ips, ip, now)
    if PERMANENT in (account_wait, ip_wait):
        return PERMANENT
    return max(account_wait, ip_wait)


def record_second_factor_failure(username: str) -> None:
    """驗證碼打錯。**只記帳號層,刻意不碰 IP 層。**

    ⚠️ 這個區別是必要的:

      放在 nginx 後面時,`client_ip` 拿到真 IP 的前提是 `FORWARDED_ALLOW_IPS`
      填對(容器位址會變)。一填錯,`client_ip` 對**所有人回傳同一個來源**,
      而 IP 層是 10 次就**永久封鎖**。

      六位數打錯是家常便飯 —— 手機時鐘差幾秒、看到上一組碼、手殘。把它記進
      IP 層的話,所有人加起來十次就把大家一起鎖死,**而管理員也在同一個 IP 後面,
      他連 /security 都進不去解**。那是一個不需要任何攻擊者就會自己發生的故障。

    只記帳號層仍然擋得住暴力猜:5 次就鎖 15 分鐘,而那張中間憑證本來就只活
    5 分鐘(`MFA_CHALLENGE_TTL_SEC`)。走到第二關的人已經證明他有正確的密碼,
    他不是在掃帳號 —— 而「有人在掃」正是 IP 層要擋的東西。
    """
    if config.LOGIN_MAX_ATTEMPTS <= 0:
        return
    now = time.time()
    with _lock:
        _register(_accounts, username, now, config.LOGIN_MAX_ATTEMPTS, config.LOGIN_LOCKOUT_SEC)
        if len(_accounts) > _SWEEP_THRESHOLD:
            _sweep(_accounts, now, config.LOGIN_LOCKOUT_SEC)


def _note_ip_failure(ip: str) -> None:
    """記一次 IP 層的失敗,滿了就鎖上並落地。**IP 層的兩個入口都只走這一支。**

    抽出來是因為兩個入口(登入失敗、被擋下的嘗試)要做的完全是同一件事;
    抄兩份的話很容易有一份漏掉 `_sweep`,而那種漏在幾萬個 key
    累積起來之前完全看不出來。

    三段的順序不能換:白名單先擋掉(連計數都不記)→ 在 `_lock` 裡記一次 →
    **放開鎖之後**才寫資料庫(見 `_persist_block` 與 `_db_lock`)。
    """
    if is_allowlisted(ip):
        return
    now = time.time()
    with _lock:
        locked_until = _register(
            _ips, ip, now, config.LOGIN_IP_MAX_ATTEMPTS, config.LOGIN_IP_LOCKOUT_SEC
        )
        if len(_ips) > _SWEEP_THRESHOLD:
            _sweep(_ips, now, config.LOGIN_IP_LOCKOUT_SEC)
    if locked_until is not None:
        _persist_block(ip, locked_until)


def record_failure(username: str, ip: str) -> None:
    now = time.time()
    with _lock:
        # 帳號層停用時完全不記帳號 —— 不然記憶體會累積永遠不會鎖的 entry
        if config.LOGIN_MAX_ATTEMPTS > 0:
            _register(_accounts, username, now, config.LOGIN_MAX_ATTEMPTS, config.LOGIN_LOCKOUT_SEC)
            if len(_accounts) > _SWEEP_THRESHOLD:
                _sweep(_accounts, now, config.LOGIN_LOCKOUT_SEC)
    # 白名單(公司 IP)在這一支裡連計數都不記(見 _note_ip_failure)。不記而不是
    # 「記了但不鎖」:記了的話,哪天名單被拿掉,一整間公司累積下來的計數會在
    # 下一次失敗時立刻鎖上。**帳號層不受白名單影響**,所以它在上面已經記過了。
    _note_ip_failure(ip)


def record_blocked_attempt(ip: str) -> None:
    """已經被擋下來的嘗試,仍然要算進 IP 那層。

    不算的話有一個大洞:對**同一個帳號**猛撞,第 5 次就把帳號鎖了,之後每一次
    都在 check() 那步就被回絕、永遠走不到 record_failure —— IP 計數卡在 5,
    撞五十次、五千次都一樣,IP 永遠不會被封鎖。

    只加 IP,**不碰帳號的計數**:帳號那層加下去等於讓攻擊者可以無限延長
    某個使用者的鎖定時間,那正是我們刻意要避免的事(見 config.py 的說明)。
    """
    _note_ip_failure(ip)


def record_success(username: str, ip: str) -> None:
    """登入成功就把這個人的失敗紀錄清掉。

    IP 那層**故意不清**:攻擊者只要自己有一組合法帳密,就能靠「每失敗幾次
    就成功登入自己的帳號一次」把計數器一直洗掉,IP 那層等於不存在。
    """
    with _lock:
        _accounts.pop(username, None)


def reset(username: Optional[str] = None, ip: Optional[str] = None) -> bool:
    """手動解鎖。管理員在網頁上按「解鎖」會走到這裡。

    一併把失敗計數清掉,不只是解除鎖定 —— 只解鎖不清計數的話,對方下一次
    打錯就立刻又被鎖上,管理員會以為解鎖沒有作用。

    ⚠️ **資料庫那一列也要刪**,不然解鎖只有這一次有效:下次重啟又被載回來,
    而管理員看到的是「我解過的 IP 自己回來了」。刪除在 `_lock` 外面做
    (那個鎖擋著所有人的登入判斷,不放 I/O 進去)。

    回傳 **False = 記憶體解開了,但資料庫那一列沒刪掉**(服務重啟後它會回來)。
    呼叫端要把這件事講給管理員聽,不能默默當成成功 —— 見 routers/locks.py。
    只解帳號、不碰 IP 的那種呼叫一律回 True:帳號層本來就不落地。
    """
    clear_all = username is None and ip is None
    with _lock:
        if clear_all:
            _accounts.clear()
            _ips.clear()
        else:
            if username is not None:
                _accounts.pop(username, None)
            if ip is not None:
                _ips.pop(ip, None)

    if clear_all:
        return _forget_block(None)
    if ip is not None:
        return _forget_block(ip)
    return True


def snapshot() -> dict[str, list[dict]]:
    """目前還在鎖定中的帳號與 IP,給管理員頁面看。

    只列**鎖定中**的,不列「失敗過但還沒滿」的 —— 後者是正常人打錯字的日常,
    列出來只會讓真正需要處理的那幾筆被淹沒。
    """
    now = time.time()

    def rows(table: dict[str, _Entry]) -> list[dict]:
        return [
            {
                "key": key,
                "retry_after": PERMANENT if math.isinf(until) else int(until - now + 0.999),
            }
            for key, (_, _, until) in sorted(table.items())
            if until > now
        ]

    with _lock:
        return {"accounts": rows(_accounts), "ips": rows(_ips)}
