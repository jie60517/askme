# -*- coding: utf-8 -*-
"""終端機的主機清單。

`/ssh` 進來先看主機清單、點哪一台連哪一台,所以「有哪幾台」是
一份**會送到瀏覽器**的資料 —— 這裡守的就是那條界線:送出去的只有名字,
位址、帳號、憑證一個都不能出去。
"""
import json

import pytest

from app import config


@pytest.fixture
def hosts_file(tmp_path, monkeypatch):
    """給一份假的 terminal_hosts.json,並讓 config 讀它。"""

    def write(payload):
        path = tmp_path / "terminal_hosts.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(config, "TERMINAL_HOSTS_FILE", path)
        monkeypatch.setattr(config, "_TERMINAL_HOSTS_FILE_ENTRIES", config._load_terminal_hosts_file())
        return path

    return write


def test_falls_back_to_env_when_there_is_no_file(monkeypatch):
    """沒有設定檔的部署(開發機、只有一台主機的站)照樣有一台可以點。"""
    monkeypatch.setattr(config, "_TERMINAL_HOSTS_FILE_ENTRIES", [])
    monkeypatch.setattr(config, "SSH_TERMINAL_HOST", "10.1.2.3")
    monkeypatch.setattr(config, "SSH_TERMINAL_USER", "deploy")
    hosts = config.terminal_hosts()
    assert [h["id"] for h in hosts] == ["main"]
    assert hosts[0]["host"] == "10.1.2.3"


def test_fallback_reads_env_at_call_time(monkeypatch):
    """⚠️ 退路那一台要**每次算**:測試會 monkeypatch SSH_TERMINAL_*,
    在模組載入時就固定一份的話,那些測試會連到真的主機。"""
    monkeypatch.setattr(config, "_TERMINAL_HOSTS_FILE_ENTRIES", [])
    monkeypatch.setattr(config, "SSH_TERMINAL_HOST", "127.0.0.1")
    monkeypatch.setattr(config, "SSH_TERMINAL_PORT", 2222)
    assert config.terminal_hosts()[0]["port"] == 2222


def test_public_list_never_leaks_where_or_who(hosts_file):
    hosts_file(
        {
            "hosts": [
                {
                    "id": "main",
                    "label": "公司主機",
                    "sub": "main-server · deploy",
                    "host": "10.9.9.9",
                    "user": "deploy",
                    "key_file": "/secret/key",
                    "port": 2200,
                }
            ]
        }
    )
    public = config.public_terminal_hosts()
    assert public == [
        {"id": "main", "label": "公司主機", "sub": "main-server · deploy", "via": ""}
    ]
    # 白名單以外的鍵一個都不能有 —— 新增欄位時這一條會擋住「順手全部回傳」
    assert set(public[0]) == {"id", "label", "sub", "via"}


def test_label_falls_back_to_user_at_host(hosts_file):
    hosts_file({"hosts": [{"id": "x", "host": "10.9.9.9", "user": "deploy"}]})
    assert config.public_terminal_hosts()[0]["label"] == "deploy@10.9.9.9"


def test_unknown_id_is_none_not_the_first_host(hosts_file):
    """找不到**不能**退回第一台:那會變成「點 B 卻連到 A」。"""
    hosts_file({"hosts": [{"id": "main", "host": "a"}, {"id": "ca", "host": "b", "via": "main"}]})
    assert config.find_terminal_host("nope") is None
    assert config.find_terminal_host("ca")["via"] == "main"


def test_entry_without_id_or_host_is_skipped_not_fatal(hosts_file):
    """一筆打錯字不該讓所有人的終端機都用不了。"""
    hosts_file({"hosts": [{"label": "沒有 id"}, {"id": "ok", "host": "a"}]})
    assert [h["id"] for h in config.terminal_hosts()] == ["ok"]


def test_empty_file_falls_back_to_env(hosts_file, monkeypatch):
    hosts_file({"hosts": []})
    monkeypatch.setattr(config, "SSH_TERMINAL_HOST", "127.0.0.1")
    assert [h["id"] for h in config.terminal_hosts()] == ["main"]


def test_defaults_are_filled_in(hosts_file):
    hosts_file({"hosts": [{"id": "x", "host": "a"}]})
    host = config.find_terminal_host("x")
    assert host["port"] == 22
    assert host["start_dir"] == "~"
    # 沒填 known_hosts 就共用主設定那一份
    assert host["known_hosts"] == config.SSH_TERMINAL_KNOWN_HOSTS
