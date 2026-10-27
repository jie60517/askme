# -*- coding: utf-8 -*-
"""容器進入點(`deploy/docker/entrypoint.py`)啟動 uvicorn 的參數。

WebSocket 在驗身分之前就要把整則收進記憶體,uvicorn 預設一則 16 MiB。`--ws-max-size` 要:
  - 比專案裡最大的合法訊息(終端機一塊 64 KiB,外加貼上)寬裕得多 —— 不然正常的訊息會被 uvicorn 直接斷線;
  - 比預設的 16 MiB 小 —— 不然等於沒設。
"""
import re
from pathlib import Path

from app import terminal

ENTRYPOINT = Path(__file__).resolve().parents[2] / "deploy" / "docker" / "entrypoint.py"


def test_ws_max_size_fits_the_biggest_legit_message():
    text = ENTRYPOINT.read_text(encoding="utf-8")
    sizes = [int(v) for v in re.findall(r'"--ws-max-size",\s*"(\d+)"', text)]
    assert len(sizes) == 1, "uvicorn 的啟動參數要帶 --ws-max-size"
    assert 8 * terminal.CHUNK <= sizes[0] < 16 * 1024 * 1024
