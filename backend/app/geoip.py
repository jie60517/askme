# -*- coding: utf-8 -*-
"""登入的地理封鎖:這個 IP 是不是台灣的。

擋的是境外來源冒用**帳號**登入,所以擋的點在「發 token 的那一刻」——
密碼對了也不發(見 `routers/auth.py`)。

判定方式是**離線查表**:`backend/tw_ranges.txt` 是 APNIC 公布的配發紀錄裡屬於 TW 的
那幾段(重建方式見 `build_tw_ranges.py`)。不打外部服務有兩個理由,兩個都不是效能:
  1. 對方掛掉的時候,所有人都登不進來 —— 把自家登入的可用性綁在別人身上不划算。
  2. 線上查詢等於把每位使用者的登入 IP 送給第三方。

⚠️ **這支的答案只跟「IP 落在哪一段」有關,不代表人在哪裡。** 用 VPN、用手機熱點漫遊、
用海外雲端跳板,都會讓答案跟事實不一樣 —— 這是所有 IP 地理判定共同的上限,
不是這份清單的缺陷。它擋得住的是「有人從境外拿你的密碼直接登入」,擋不住
「有人先連進台灣的機器再登入」。要更強的保證得靠 MFA(這個專案已經有 `mfa.py`)。
"""
from __future__ import annotations

import ipaddress
import logging
from bisect import bisect_right
from pathlib import Path
from typing import Optional

from . import clientip

logger = logging.getLogger(__name__)

#: 判定結果。`None` = 判不出來(位址讀不懂、或清單裡沒有)。
TAIWAN = "TW"
ELSEWHERE = "OTHER"


def _load(path: Path) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """把 CIDR 清單讀成**排序好的整數區間**(v4 一份、v6 一份)。

    存成區間而不是 CIDR 物件,是為了查的時候能二分搜尋:登入路徑上不該
    對一千多段逐一 `in network` 比對。
    """
    v4: list[tuple[int, int]] = []
    v6: list[tuple[int, int]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("讀不到台灣網段清單 %s:%s", path, exc)
        return [], []

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            net = ipaddress.ip_network(line, strict=False)
        except ValueError:
            logger.warning("網段清單裡有一行讀不懂,略過:%r", line)
            continue
        bucket = v6 if net.version == 6 else v4
        bucket.append((int(net.network_address), int(net.broadcast_address)))

    v4.sort()
    v6.sort()
    return v4, v6


def _contains(ranges: list[tuple[int, int]], value: int) -> bool:
    """排序區間的二分搜尋。

    `bisect_right` 找到第一個起點**大於** value 的位置,前一段就是唯一可能包含它的
    (區間互不重疊,因為來源是 CIDR 匯總出來的)。
    """
    i = bisect_right(ranges, (value, float("inf"))) - 1
    if i < 0:
        return False
    start, end = ranges[i]
    return start <= value <= end


class TaiwanRanges:
    """一份台灣網段清單。**是物件不是模組層變數**,測試才能各自給一份假的。"""

    def __init__(self, path: Path):
        self.path = path
        self.v4, self.v6 = _load(path)

    @property
    def count(self) -> int:
        return len(self.v4) + len(self.v6)

    def country_of(self, ip: str) -> Optional[str]:
        """`TAIWAN` / `ELSEWHERE` / `None`(判不出來)。

        判不出來有兩種:位址根本讀不懂(`unknown`、空字串 —— `ratelimit.client_ip`
        抓不到來源時就是這個),或清單是空的(檔案沒讀到)。
        **私有位址(10.x / 192.168.x / 127.x)算判不出來,不算台灣** ——
        它們在世界上每個角落都長一樣,說它是台灣是猜的。怎麼處置由 `is_allowed` 決定。
        """
        if not self.count:
            return None
        # 解析與 IPv4-mapped 的還原在 `clientip.parse`(三道判定共用一份;
        # 漏掉還原那一步的話,道地的台灣使用者會被拿去查 v6 表、查不到、
        # 判成境外,而 fail-closed 之下就是把他鎖在門外)。
        addr = clientip.parse(ip)
        if addr is None:
            return None
        if addr.is_private or addr.is_loopback or addr.is_link_local:
            return None
        ranges = self.v6 if addr.version == 6 else self.v4
        return TAIWAN if _contains(ranges, int(addr)) else ELSEWHERE


#: 內網那一段:`172.16.0.0/12`(172.16.x – 172.31.x),從內網連進來的放行。
#: 私有位址不會從國外直接連進來 —— 封鎖要擋的「境外拿密碼登入」不會長這樣。
#:
#: ⚠️ **只放 172 這一段,不放 10.x / 192.168.x。** 部署範本的 nginx 跑在容器裡、位址在 10.x
#: (`deploy/env.server.example` 的 `FORWARDED_ALLOW_IPS`):容器重建換了位址、代理設定沒跟上時,
#: 所有人都會被看成 nginx 的新位址 —— 那一段要是也放行,地理封鎖就**靜靜地整個失效**。
#: 要再加別段之前先確認它跟代理不在同一段。
INTRANET = (ipaddress.ip_network("172.16.0.0/12"),)


def _proxy_addresses() -> list:
    """`.env` 的 `FORWARDED_ALLOW_IPS`(uvicorn 信任的代理)。讀不懂的項目與 `*` 略過。

    每次現讀環境變數:登入才呼叫,便宜;而且測試可以直接 monkeypatch 環境。
    """
    import os

    nets = []
    for item in os.environ.get("FORWARDED_ALLOW_IPS", "").split(","):
        item = item.strip()
        if not item or item == "*":
            continue
        try:
            nets.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            continue
    return nets


def is_allowed(ranges: TaiwanRanges, ip: str) -> tuple[bool, str]:
    """這個來源 IP 能不能登入。回 `(可不可以, 給稽核看的理由)`。

    政策:
      - 判得出來是台灣 → 放行。
      - 內網(`INTRANET`)→ 放行,**但代理自己的位址除外**(見下)。
      - 其他一律擋,**判不出來也擋**(fail-closed)。

    ⚠️ **代理位址照擋**:`FORWARDED_ALLOW_IPS` 一旦設錯,`ratelimit.client_ip()`
    會對所有人回 nginx 自己的位址。那時候要的是「一個人都登不進來、馬上有人發現」,
    不是「全世界都放行、沒人發現」。所以這裡看到的來源若正是代理,一律擋(`proxy_address`)。
    這個功能預設關閉,而且有 `GEO_BLOCK_DRY_RUN`(只記錄不擋)讓你先跑幾天。
    """
    country = ranges.country_of(ip)
    if country == TAIWAN:
        return True, "taiwan"
    if country == ELSEWHERE:
        return False, "not_taiwan"
    addr = clientip.parse(ip)
    if addr is not None and any(addr in net for net in INTRANET if net.version == addr.version):
        if any(addr in net for net in _proxy_addresses() if net.version == addr.version):
            return False, "proxy_address"
        return True, "intranet"
    return False, "unknown_ip"


# --------------------------------------------------------------------------- 預設的那一份
_default: Optional[TaiwanRanges] = None


def default_ranges() -> TaiwanRanges:
    """服務用的那一份(`config.TW_RANGES_FILE`)。**第一次用到時讀一次**,
    清單改了要重啟服務。測試要自己的一份就直接 `TaiwanRanges(路徑)`,不要動這支。
    """
    global _default
    if _default is None:
        from . import config

        _default = TaiwanRanges(config.TW_RANGES_FILE)
        logger.info("台灣網段清單載入 %s 段(%s)", _default.count, _default.path)
    return _default
