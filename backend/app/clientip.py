# -*- coding: utf-8 -*-
"""把 `ratelimit.client_ip()` 給的那串字變成**可以拿來比對的位址**。

`geoip.country_of`、`ratelimit.is_allowlisted`、`geo_allow.match` 三道安全判定
共用這一支解析字串、還原 IPv4-mapped,不要各自另寫一份。

漏掉還原那一步的那一份會「比不中」,而比不中的方向各不相同 —— 地理封鎖比不中是
把台灣使用者擋在門外,白名單比不中是自家網路被鎖,境外例外比不中是「明明加了他還是
登不進來」。三種症狀沒有一種看起來像「少了一行轉換」。
"""
from __future__ import annotations

import ipaddress
from typing import Optional, Union

Address = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]


def parse(ip: str) -> Optional[Address]:
    """`"140.112.8.116"` → 位址物件;讀不懂回 `None`。

    ⚠️ **IPv4-mapped 的 v6 寫法(`::ffff:140.112.8.116`)會被還原成 v4。**
    那是 uvicorn 綁在 `::` 上、或代理把 v4 來源寫成 v6 形式時的常見寫法;
    不還原的話它會被拿去跟 v6 的清單比,一律比不中。

    ⚠️ 回 `None` 的典型輸入是 `"unknown"` —— `client_ip()` 抓不到來源時的回傳值。
    **每個呼叫端都必須自己決定那代表什麼**,這支不替它們決定:對地理封鎖
    「不知道是誰」是擋(fail-closed),對白名單則是「不算在白名單內」。

    6to4(`2002::/16`)與 Teredo 沒有處理,理由見 `geoip.country_of`:
    實務上已經絕跡,沒有真實案例之前先寫轉換等於多一條沒人走過的路。
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    mapped = getattr(addr, "ipv4_mapped", None)
    return mapped if mapped is not None else addr
