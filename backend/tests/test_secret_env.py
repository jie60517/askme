# -*- coding: utf-8 -*-
"""終端機主機的密碼(terminal_hosts.json 的 `password_env`)不能流進子行程。

SECRET_ENV_KEYS 除了固定的 SSH_TERMINAL_PASSWORD 那幾個,還要包含設定檔裡每台主機的密碼變數名;
漏了的話,拿得到 Bash 的帳號叫 agent 跑一次 `env` 就看得到。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from app import config

BACKEND = Path(__file__).resolve().parents[1]


def _hosts_file(tmp_path: Path, junk: bool = False) -> Path:
    path = tmp_path / "terminal_hosts.json"
    path.write_text(
        json.dumps(
            {
                "hosts": [
                    {"id": "a", "host": "10.0.0.1", "password_env": "CUST_A_PW"},
                    # 缺 host、會被 _load_terminal_hosts_file 略過的那一筆:它的密碼一樣在 .env 裡
                    {"id": "b", "password_env": " CUST_B_PW "},
                    {"id": "c", "host": "10.0.0.3", "key_file": "/k"},
                ]
                + (["不是物件"] if junk else [])
            }
        ),
        encoding="utf-8",
    )
    return path


def test_names_come_from_every_entry(tmp_path):
    path = _hosts_file(tmp_path, junk=True)
    assert config.terminal_password_env_names(path) == ("CUST_A_PW", "CUST_B_PW")
    assert config.terminal_password_env_names(tmp_path / "沒有.json") == ()
    (tmp_path / "bad.json").write_text("[1, 2]", encoding="utf-8")
    assert config.terminal_password_env_names(tmp_path / "bad.json") == ()


def test_agent_children_do_not_inherit_host_passwords(tmp_path):
    """真的用一份設定檔起一個新行程 import(SECRET_ENV_KEYS 是 import 當下算好的)。"""
    path = _hosts_file(tmp_path)
    env = {**os.environ, "TERMINAL_HOSTS_FILE": str(path), "CUST_A_PW": "s3cret", "CUST_B_PW": "s3cret2"}
    code = (
        "import json\n"
        "from app import agent, config\n"
        "print(json.dumps([sorted(k for k in agent._child_env() if k.startswith('CUST_')),"
        " 'SSH_TERMINAL_PASSWORD' in config.SECRET_ENV_KEYS]))\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120, encoding="utf-8", errors="replace"
    )
    assert out.returncode == 0, out.stderr[-2000:]
    assert json.loads(out.stdout.strip().splitlines()[-1]) == [[], True]
