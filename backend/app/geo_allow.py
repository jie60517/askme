# -*- coding: utf-8 -*-
"""地理封鎖的例外清單:哪些境外來源仍然可以登入(例如出差時),在 Security 頁增刪、不用重啟。

分工跟 `mfa.py` 一樣:這裡只負責「把名單存好、讀對、比對中不中」,
端點在 `routers/geo_allow.py`,擋的那一刻在 `routers/auth.py`。

⚠️ **這份名單跟 `LOGIN_IP_ALLOWLIST` 是兩件事,不要互相代入。**

    LOGIN_IP_ALLOWLIST(.env)  = 自家網路的出口。免 IP 層永久封鎖,
                                而且(開了 MFA_SKIP_ON_TRUSTED_IP 之後)免第二關。
    這張表(資料庫)            = 暫時放行的境外來源。**只免地理封鎖那一關**,
                                密碼、第二關、IP 層鎖定全部照舊。

    合成一份的話,替出差的人開一條路會順手把那個 IP 升成「內部網路」——
    那正好是這個功能最不該發生的事:境外 IP 免二階段驗證。

⚠️ **這裡放行的是「網段」,不是「人」**(不綁帳號):
一條白名單開著的時候,從那個來源打過來的**任何帳號**都能通過地理這一關。
旅館、機場、共用辦公室的出口是很多人共用的 —— 所以清單要短、要即時刪。

⚠️ **這份清單只有 IP,刻意不設備註欄。**「這條是誰開的」查稽核紀錄。
"""
from __future__ import annotations

import ipaddress
import logging
from datetime import datetime
from typing import List, Optional

from . import clientip, models
from .database import session_scope as _session

logger = logging.getLogger(__name__)

#: 網段最大能開多大。**不是效能考量,是誤植的防線**:`/8` 打成 `/0` 或
#: 隨手填一個 `1.0.0.0/8` 等於把整個地理封鎖關掉,而症狀是「功能還開著、
#: 稽核也沒有被擋的紀錄」—— 沒有人會發現。出差要用的是一個位址或一段 /24,
#: 真的需要更大,就分成幾條加。
MIN_PREFIX_V4 = 16
MIN_PREFIX_V6 = 32

#: 清單的長度上限。防的是「加了就忘」累積成一份沒人看得懂的名單 ——
#: 到頂的時候該做的是刪掉過期的那幾條,不是再加一條。
MAX_ENTRIES = 50


class InvalidEntry(ValueError):
    """填的東西不能當白名單。訊息是**直接給使用者看的中文**。"""


def normalize(raw: str) -> str:
    """使用者打的字 → 存進資料庫的正規形式(`1.2.3.4` → `1.2.3.4/32`)。

    擋下來的四種(都丟 `InvalidEntry`,訊息直接顯示在畫面上):

      1. 讀不懂的字串。
      2. `0.0.0.0/0` / `::/0` —— 等於把地理封鎖整個關掉。要關的話 .env 裡
         `GEO_BLOCK_MODE=off` 才是誠實的做法,用一條看起來很正常的白名單
         偷偷關掉它,下一個人會看著「封鎖:啟用」百思不得其解。
      3. 太大的網段(見 `MIN_PREFIX_V4` / `MIN_PREFIX_V6`)。
      4. **不是對外位址的那些**:私有(10./172.16./192.168.)、loopback、
         link-local、CGNAT(100.64/10)、文件用途的 `203.0.113.0/24` 與
         `2001:db8::/32`。判準是 `is_global`(「這個位址在公開網際網路上路由得到嗎」)
         而不是 `is_private` —— 兩者**不是互補的**:CGNAT 那一段 `is_private`
         是 False 但也不是公網位址,只看 private 會把它放進來。
         用標準函式庫的分類而不是自己列清單,那份清單遲早會跟標準漂掉。
         擋它們的理由不只是「加了沒用」——**上線後真的看到私有位址的時候,
         代表 `FORWARDED_ALLOW_IPS` 設錯了**(`client_ip()` 對所有人回 nginx
         自己的位址),那時候把它加進白名單等於一次替全世界開門。要修的是代理設定。
         ⚠️ 所以**文件裡拿來舉例的 `203.0.113.5` 在這裡會被拒**,那是刻意的:
         照著範例打的人應該當場知道「這不是一個真的能上網的位址」。

    ⚠️ `strict=False`:允許 `1.2.3.4/24` 這種主機位址帶前綴的寫法,
    照網段解讀(跟 `ratelimit._allow_networks` 同一個理由 —— 要求嚴格的話,
    填的人只會看到一句「格式錯誤」而不知道差在哪)。正規化之後存的是
    `1.2.3.0/24`,清單上看得出實際放行的範圍比他打的字大。
    """
    text = (raw or "").strip()
    if not text:
        raise InvalidEntry("請填一個 IP 位址或網段。")

    try:
        net = ipaddress.ip_network(text, strict=False)
    except ValueError:
        raise InvalidEntry(f"「{text}」看不懂。格式是 1.2.3.4 這樣的位址,或 1.2.3.0/24 這樣的網段。")

    if net.prefixlen == 0:
        raise InvalidEntry("這一條等於放行全世界,地理封鎖就沒有意義了。要停用請改 .env 的 GEO_BLOCK_MODE。")

    floor = MIN_PREFIX_V4 if net.version == 4 else MIN_PREFIX_V6
    if net.prefixlen < floor:
        raise InvalidEntry(
            f"網段太大了(/{net.prefixlen})。最多開到 /{floor},"
            "要放行更多請分成幾條加。"
        )

    # ⚠️ 判的是**整段的起點**,而起點不是公網位址就代表這一段不該出現在白名單裡
    # (合法的對外網段不會從保留位址開始)。
    if not net.network_address.is_global:
        raise InvalidEntry(
            "這不是一個對外的 IP(內網或保留位址),加進來不會有作用。"
            "要填的是同事在當地上網時的對外 IP —— 請他開瀏覽器查 whatismyip。"
        )

    return str(net)


def entries() -> List[models.GeoAllowIP]:
    """清單,新加的在前面。"""
    with _session() as db:
        return list(
            db.query(models.GeoAllowIP)
            .order_by(models.GeoAllowIP.created_at.desc())
            .all()
        )


def match(ip: str) -> Optional[str]:
    """這個來源有沒有中白名單。中了回**那一條網段**(給稽核記),沒中回 `None`。

    解析與 IPv4-mapped 的還原走 `clientip.parse`(三道判定共用一份)——
    不還原的話白名單會比不中,而症狀是「明明加了,他還是登不進來」。

    ⚠️ `unknown`(`client_ip()` 抓不到來源時的回傳值)讀不成位址,回 `None` ——
    「不知道是誰」不能算在白名單裡。
    """
    addr = clientip.parse(ip)
    if addr is None:
        return None

    for row in entries():
        try:
            net = ipaddress.ip_network(row.cidr, strict=False)
        except ValueError:
            # 手動改過資料庫才可能發生(寫進去的一律是 normalize 過的)。
            # 略過而不是整個爆掉:一列壞掉不該讓所有人登不進來。
            logger.warning("白名單裡有一列讀不懂,略過:%r", row.cidr)
            continue
        if addr.version == net.version and addr in net:
            return row.cidr
    return None


def add(raw: str, actor: str) -> models.GeoAllowIP:
    """新增一條。回新增(或已存在)的那一列。

    重複加同一條**不算錯**:回原本那一列、不換時間 —— 第二次點擊不該把
    第一次的紀錄洗掉。

    `actor` 只進日誌:「誰開的」記在稽核表(`routers/geo_allow.py`),
    這張表本身不存(見 `models.GeoAllowIP` 檔尾的說明)。
    """
    cidr = normalize(raw)

    with _session() as db:
        existing = db.get(models.GeoAllowIP, cidr)
        if existing is not None:
            return existing

        if db.query(models.GeoAllowIP).count() >= MAX_ENTRIES:
            raise InvalidEntry(
                f"白名單最多 {MAX_ENTRIES} 條。請先把已經回國的同事那幾條刪掉。"
            )

        row = models.GeoAllowIP(cidr=cidr, created_at=datetime.utcnow())
        db.add(row)
        db.commit()
        db.refresh(row)
        logger.info("登入白名單新增 %s(由 %s)", cidr, actor)
        return row


def remove(raw: str) -> Optional[str]:
    """刪一條。回**被刪掉的那一條**(正規化後的字串),沒刪到回 `None`。

    ⚠️ **回的是正規化後的值,不是呼叫端送進來的字。** 稽核那一列記的就是這個 ——
    新增記 `1.2.3.0/24`、刪除卻記使用者打的 `1.2.3.4` 的話,同一條白名單的
    開門與關門在稽核裡對不起來。

    ⚠️ 刪之前也要 `normalize`:清單上顯示的是正規形式,但**呼叫端不一定**
    ——測試與手動打 API 的人會送 `1.2.3.4`。不正規化的話那次刪除會
    安靜地什麼也沒刪,而回應看起來是成功的。
    """
    try:
        cidr = normalize(raw)
    except InvalidEntry:
        # 讀不懂的東西一定不在表裡(寫進去的都 normalize 過)。
        return None

    with _session() as db:
        row = db.get(models.GeoAllowIP, cidr)
        if row is None:
            return None
        db.delete(row)
        db.commit()
        logger.info("登入白名單刪除 %s", cidr)
        return cidr
