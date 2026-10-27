# -*- coding: utf-8 -*-
"""重建 `backend/tw_ranges.txt` —— 登入地理封鎖(`app/geoip.py`)查的那份台灣網段清單。

來源是 APNIC 的配發紀錄(delegated-apnic-latest):亞太區每一段 IP 配給哪個國家,
由 APNIC 自己公布,每天更新。我們只取 `TW` 那些,轉成 CIDR 存成一個純文字檔。

**為什麼是離線的一個檔,不是線上查詢**:登入是每個人每天都會走的路,不該掛一個
外部服務在上面(對方掛掉 = 所有人登不進來),也不該把使用者的登入 IP 送給第三方。

用法(在 backend/ 底下):

    .venv/Scripts/python build_tw_ranges.py            # 抓最新的,覆蓋 tw_ranges.txt
    .venv/Scripts/python build_tw_ranges.py --from 檔案 # 用手上已經下載好的那份

⚠️ **產出的檔要進版控**(`backend/tw_ranges.txt`)—— 服務不該在啟動時上網抓,
而且大家該看得到「今天這份清單長什麼樣」。網段變動很慢,幾個月跑一次就夠;
跑完 `git diff` 看得到增減。
⚠️ 這支**不會**自己被服務呼叫,是人手動跑的。
"""
from __future__ import annotations

import argparse
import ipaddress
import sys
import urllib.request
from datetime import date
from pathlib import Path

SOURCE_URL = "https://ftp.apnic.net/stats/apnic/delegated-apnic-latest"
OUT_FILE = Path(__file__).resolve().parent / "tw_ranges.txt"
COUNTRY = "TW"


def fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 (固定的官方網址)
        return resp.read().decode("utf-8", "replace")


def parse(text: str) -> list[str]:
    """把配發紀錄裡屬於 TW 的那幾行轉成 CIDR。

    格式是 `apnic|TW|ipv4|1.34.0.0|65536|20100325|allocated`:
      - ipv4 給的是**起點 + 位址數**,而那個數字**不保證是 2 的次方**,
        所以不能直接當前綴長度 —— 要用 `summarize_address_range` 拆成幾個 CIDR。
      - ipv6 給的直接就是前綴長度。
    狀態只收 `allocated` / `assigned`(`reserved`、`available` 還沒給人用)。
    """
    out: list[str] = []
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) < 7 or parts[1] != COUNTRY:
            continue
        _, _, kind, start, value, _, status = parts[:7]
        if status not in ("allocated", "assigned"):
            continue
        try:
            if kind == "ipv4":
                first = ipaddress.IPv4Address(start)
                last = ipaddress.IPv4Address(int(first) + int(value) - 1)
                out.extend(str(net) for net in ipaddress.summarize_address_range(first, last))
            elif kind == "ipv6":
                out.append(str(ipaddress.IPv6Network(f"{start}/{value}", strict=False)))
        except ValueError as exc:
            print(f"跳過一行讀不懂的:{line!r}({exc})", file=sys.stderr)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="重建台灣網段清單")
    ap.add_argument("--from", dest="src", help="改讀本機檔案,不上網")
    ap.add_argument("--out", default=str(OUT_FILE), help=f"輸出路徑(預設 {OUT_FILE})")
    args = ap.parse_args()

    text = Path(args.src).read_text(encoding="utf-8", errors="replace") if args.src else fetch(SOURCE_URL)
    nets = parse(text)
    if not nets:
        print("一段都沒抓到 —— 來源格式可能變了,**不覆蓋**原本的檔案。", file=sys.stderr)
        return 1

    v4 = sum(1 for n in nets if ":" not in n)
    header = [
        "# 台灣的 IP 網段(登入地理封鎖用,見 app/geoip.py)",
        f"# 來源:{SOURCE_URL}",
        f"# 產生於 {date.today().isoformat()},用 build_tw_ranges.py 重建",
        f"# 共 {len(nets)} 段(IPv4 {v4} / IPv6 {len(nets) - v4})",
        "#",
        "# ⚠️ 這個檔是**產生出來的**,不要手改 —— 下次重建就蓋掉了。",
        "#    少了哪一段就重跑 build_tw_ranges.py(來源每天更新)。",
        "#    **這份清單沒有白名單**:政策是「只有台灣、沒有例外」(見 geoip.is_allowed)。",
    ]
    Path(args.out).write_text("\n".join(header + sorted(nets)) + "\n", encoding="utf-8")
    print(f"寫入 {args.out}:{len(nets)} 段(IPv4 {v4} / IPv6 {len(nets) - v4})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
