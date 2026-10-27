# -*- coding: utf-8 -*-
"""模型白名單、/api/config,以及專案設定(knowledge_bases.json)的載入與降級。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest
"""
import json
import logging

import pytest
from fastapi.testclient import TestClient

from app import auth, config
from app.main import app


@pytest.fixture
def client():
    """已登入的 TestClient。

    ⚠️ `/api/config` **要登入**(它的回應裡有專案清單,
    見 `app.main.get_config`)。這幾支測的是「內容對不對」,不是「權限對不對」,
    所以用 `dependency_overrides` 把認證換掉,不要在每支測試裡真的去登入 ——
    那會讓模型白名單的測試綁上帳號系統,壞一邊兩邊一起紅。

    權限本身另外有 `test_api_config_requires_login` 守著。
    """
    app.dependency_overrides[auth.require_user] = lambda: "tester"
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_api_config_requires_login():
    """匿名讀不到 `/api/config`。

    ⚠️ **這支是資安回歸測試,不要因為「只是拿個設定」就放寬。**
    回應裡的 `knowledge_bases` 標籤等於一份專案清單 ——
    匿名可讀的話,任何路人打開就能列舉這台主機放了哪些專案。

    要的是 401/403 而不是 200:掛 `require_user` 的話,還在用預設密碼的人也擋。
    """
    resp = TestClient(app).get("/api/config")
    assert resp.status_code in (401, 403), (
        f"/api/config 對未登入的人回了 {resp.status_code} —— 專案清單外洩"
    )


def test_safe_model_whitelist():
    assert config.safe_model("opus") == "opus"
    # fable 不在白名單:舊對話存的 model 是 fable 時要靜靜退回預設,不能原樣送給 CLI。
    assert config.safe_model("fable") == config.CLAUDE_MODEL
    # 白名單外的(含 None)一律退回預設 —— model 會接到 --model 後面,不能放行怪值
    assert config.safe_model("--dangerously-skip-permissions") == config.CLAUDE_MODEL
    assert config.safe_model(None) == config.CLAUDE_MODEL


def test_menu_order_covers_whitelist():
    # 排序表沒列到的模型會被 main.py 接在後面,但正常情況兩份要一致 ——
    # 加了模型忘了排,選單順序就會默默亂掉
    assert set(config.MODEL_MENU_ORDER) == set(config.ALLOWED_MODELS)


def test_api_config_model_order_and_default(client):
    data = client.get("/api/config").json()
    # 能力高的在前;只有這兩個
    assert data["allowed_models"] == ["opus", "sonnet"]
    assert data["default_model"] in config.ALLOWED_MODELS


def test_api_config_lists_all_knowledge_bases(client):
    """code_roots 不存在的專案**照樣要列出來**。

    路徑不存在就整個 continue 的話,開發機上(json 全是 Linux 路徑)
    前端的專案下拉會永遠是空的。
    """
    import json

    raw = json.loads(config.KNOWLEDGE_BASES_FILE.read_text(encoding="utf-8"))
    expected_ids = [b["id"] for b in raw.get("bases", [])]

    data = client.get("/api/config").json()
    got_ids = [b["id"] for b in data["knowledge_bases"]]
    assert got_ids == expected_ids


def test_api_config_knowledge_base_fields(client):
    """每一筆只回 id / label / suggestions / default_model —— 伺服器上的路徑不送到瀏覽器,
    也不帶其他欄位;回應裡沒有 `legacy_knowledge_base_ids`。"""
    data = client.get("/api/config").json()
    for base in data["knowledge_bases"]:
        assert set(base) == {"id", "label", "suggestions", "default_model"}, base
    assert "legacy_knowledge_base_ids" not in data


def test_workspace_folders_become_projects(tmp_path, monkeypatch):
    """workspace 底下每個子資料夾是一個專案(名字 = 資料夾名);json 已列的同一個資料夾不重複;
    `.` 開頭的不算;default 可以指自動找到的資料夾;新放進去的下一次呼叫就看得到。"""
    ws = tmp_path / "workspace"
    for name in ("toptest", "topprod", "listed", ".git"):
        (ws / name).mkdir(parents=True)
    listed = {"id": "listed_in_json", "label": "json 那筆", "workdir": str(ws / "listed")}
    monkeypatch.setattr(config, "WORKSPACE_DIR", ws)
    monkeypatch.setattr(config, "KNOWLEDGE_BASES", [listed])
    monkeypatch.setattr(config, "DEFAULT_KNOWLEDGE_BASE", "toptest")

    assert [b["id"] for b in config.knowledge_bases()] == ["listed_in_json", "topprod", "toptest"]
    test = config.get_knowledge_base("toptest")
    assert test["label"] == "toptest" and test["code_roots"] == [str((ws / "toptest").resolve())]
    assert config.default_knowledge_base() == "toptest"

    (ws / "newproj").mkdir()
    assert "newproj" in [b["id"] for b in config.knowledge_bases()]

    # default 指的資料夾不見了:退回清單第一個,不讓新對話送出一個不存在的專案
    (ws / "toptest").rmdir()
    assert config.default_knowledge_base() == "listed_in_json"
    assert config.get_knowledge_base("toptest")["id"] == "listed_in_json"


def test_workspace_folder_named_like_a_json_id_is_skipped_with_log(tmp_path, monkeypatch, caplog):
    """資料夾跟 json 某一筆同 id、路徑卻不同:用 json 那筆,但要留 log —— 不然只會看到資料夾安靜地沒出現。"""
    ws = tmp_path / "workspace"
    (ws / "erp").mkdir(parents=True)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.setattr(config, "WORKSPACE_DIR", ws)
    monkeypatch.setattr(config, "KNOWLEDGE_BASES", [{"id": "erp", "workdir": str(elsewhere)}])

    with caplog.at_level("WARNING", logger="app.config"):
        assert [b["id"] for b in config.knowledge_bases()] == ["erp"]
    assert "同名" in caplog.text


def test_unusable_skill_dir_is_dropped_and_logged(tmp_path, monkeypatch, caplog):
    """skill_dir 不合用就當沒填,而且**一定要留 log**。

    兩種不合用各測一次:
      b  路徑在,但底下沒有 `.claude/skills/` —— 填錯一層的典型症狀,
         過得了 `is_dir()` 卻一支也載不到
      c  路徑根本不存在

    ⚠️ warning 的斷言不能省。這個降級是靜默的:服務照跑、答案照出,那個環境
    只是安靜地少掉整組 skill —— log 是唯一看得出來的地方。
    """
    good = tmp_path / "good"
    (good / ".claude" / "skills").mkdir(parents=True)
    bad = tmp_path / "bad"
    bad.mkdir()

    spec = tmp_path / "kb.json"
    spec.write_text(
        json.dumps(
            {
                "default": "a",
                "bases": [
                    {"id": "a", "workdir": str(good), "skill_dir": str(good)},
                    {"id": "b", "workdir": str(good), "skill_dir": str(bad)},
                    {"id": "c", "workdir": str(good), "skill_dir": str(tmp_path / "nope")},
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "KNOWLEDGE_BASES_FILE", spec)

    with caplog.at_level(logging.WARNING, logger=config.logger.name):
        bases = {b["id"]: b for b in config._load_knowledge_bases()[0]}

    assert bases["a"]["skill_dir"] == str(good)
    assert bases["b"]["skill_dir"] == "", "少了 .claude/skills/ 就不該掛進 --add-dir"
    assert bases["c"]["skill_dir"] == "", "路徑不存在就當沒填"

    # 只比對識別 token,不比整句 —— 文案改一個字測試就碎,而它要守的是「有沒有 log」。
    warned = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    def logged(*tokens):
        return any(all(t in m for t in tokens) for m in warned)
    assert logged("知識庫 b", "skill_dir", ".claude/skills"), (
        f"b 降級了卻沒留 log —— 那就沒有人會發現。實際的 warning:{warned}"
    )
    assert logged("知識庫 c", "skill_dir", "不存在"), f"c 降級了卻沒留 log。實際的 warning:{warned}"
    assert not logged("知識庫 a", "skill_dir"), "a 是好的,不該有 warning"


def test_api_config_passes_knowledge_base_default_model(client, monkeypatch, tmp_path):
    """環境的預設模型要送到前端;不在白名單的當沒填。

    前端 pickModel 的優先序:這組對話選過的 → 這裡 → 個人常用 → 全站預設。
    白名單在輸出時才比:config._load_knowledge_bases 跑的時候 ALLOWED_MODELS 還沒定義。
    """
    base = {"suggestions": [], "workdir": ""}
    # 空的 workspace:只看這三筆,不要混進本機 workspace/ 底下放的專案
    monkeypatch.setattr(config, "WORKSPACE_DIR", tmp_path)
    monkeypatch.setattr(
        config,
        "KNOWLEDGE_BASES",
        [
            {**base, "id": "a", "label": "A", "default_model": "sonnet"},
            {**base, "id": "b", "label": "B", "default_model": "--dangerously-skip-permissions"},
            {**base, "id": "c", "label": "C", "default_model": None},
        ],
    )
    got = {b["id"]: b["default_model"] for b in client.get("/api/config").json()["knowledge_bases"]}
    assert got == {"a": "sonnet", "b": None, "c": None}


def test_範本是空的():
    """範本不列任何專案、default 留空:專案全部來自 workspace/ 底下的資料夾,
    新對話用專案清單的第一個(clone 下來不會多出一個不是自己的專案)。"""
    raw = json.loads(config.KNOWLEDGE_BASES_FILE.read_text(encoding="utf-8"))
    assert raw["bases"] == []
    assert raw["default"] == ""


def test_default留空時用專案清單的第一個(monkeypatch, tmp_path):
    (tmp_path / "toptest").mkdir()
    (tmp_path / "topprod").mkdir()
    monkeypatch.setattr(config, "WORKSPACE_DIR", tmp_path)
    monkeypatch.setattr(config, "KNOWLEDGE_BASES", [])
    monkeypatch.setattr(config, "DEFAULT_KNOWLEDGE_BASE", "")
    assert config.default_knowledge_base() == "topprod"


def test_範本的相對路徑相對於backend解析():
    """knowledge_bases.json 的 `../workspace/toptest` 要指到 repo 的 workspace/toptest,
    不管 pytest / uvicorn 從哪個目錄起(config._kb_path)。"""
    expected = str((config.BASE_DIR.parent / "workspace" / "toptest").resolve())
    assert config._kb_path("../workspace/toptest") == expected
    assert config._kb_path("") == ""
    assert config._kb_path("/abs/path") == "/abs/path"


def test_環境的預設模型與effort打錯字要留log(monkeypatch, caplog):
    """行為照舊退回預設,但不能安靜 —— 不然「這個環境怎麼又用回 Opus」沒有線索可查。"""
    monkeypatch.setattr(
        config,
        "KNOWLEDGE_BASES",
        [{"id": "d1", "default_model": "sonet", "effort": "lo"}, {"id": "ok", "default_model": "sonnet", "effort": "low"}],
    )
    with caplog.at_level("WARNING", logger=config.logger.name):
        config._warn_bad_kb_model_settings()
    messages = [r.getMessage() for r in caplog.records]
    assert any("d1" in m and "default_model" in m for m in messages)
    assert any("d1" in m and "effort" in m for m in messages)
    assert not any("ok" in m for m in messages)
