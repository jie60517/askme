# -*- coding: utf-8 -*-
"""整條收尾鏈:一題問答從 `/api/ask` 送進去,產出的檔案要真的進得了下載清單。

**為什麼要有這一支**:其他測試都是**個別**呼叫那七支後處理,而順序測試釘的是
`_finalize` 的原始碼字串。兩種都不會執行整條鏈 —— 少了這一支,
「`_finalize` 自己壞掉」或「`list_output_files` 跟後處理接不起來」不會有人發現,
而症狀是使用者那邊「答案說產生了檔案,下載清單卻是空的」。

做法:把 `agent.stream_agent` 換成一支假的,它做的事跟真的 claude 一模一樣 ——
**用 Write 在這一題的產出資料夾裡寫純文字檔**,然後回一個 done 事件。
真正被測到的是它後面那一整段:copy manifest → 攤平 → 產檔器 → 下載清單 → 資料庫。
不叫真的 claude:那要錢、要伺服器上的程式碼樹,而且它寫什麼不是這支要驗的事。

⚠️ 這也是 `agent.apply_copy_manifest`(交付伺服器上既有的原始檔)**唯一的測試**。
改收尾那段的人請連它一起跑過。
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import agent, auth, config, models, pdfgen, slidegen, zipgen
from app.database import SessionLocal
from app.main import app


@pytest.fixture
def outputs(tmp_path, monkeypatch):
    output = tmp_path / "outputs"
    output.mkdir()
    monkeypatch.setattr(config, "OUTPUT_DIR", output)

    # 假的程式碼樹。copy manifest 只肯複製這個專案的 code_roots / knowledge_dirs
    # 底下的檔案(那條界線擋的是「/etc/passwd 被塞進清單」),所以要有一棵真的樹。
    code_root = tmp_path / "code"
    code_root.mkdir()
    (code_root / "service.py").write_text("def main():\n    pass\n", encoding="utf-8")
    monkeypatch.setattr(
        config,
        "get_knowledge_base",
        lambda kb_id=None: {
            "id": "example",
            "code_roots": [str(code_root)],
            "knowledge_dirs": [],
        },
    )
    return output


def fake_agent(session_id, **kwargs):
    """假的 claude:寫出一個模型照著提示會寫的檔案組合。"""
    out = config.OUTPUT_DIR / session_id
    out.mkdir(parents=True, exist_ok=True)

    (out / "料件清單.csv").write_text("品號,數量\n0012345,3\n", encoding="utf-8")
    (out / "說明.md").write_text("# 出貨流程\n\n第一段。\n", encoding="utf-8")
    (out / pdfgen.MANIFEST_NAME).write_text("說明.md\n", encoding="utf-8")
    (out / slidegen.MANIFEST_NAME).write_text(
        json.dumps({"title": "簡報標題", "slides": [{"heading": "一", "bullets": ["甲"]}]},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    # 交付伺服器上既有的檔案:寫一份路徑清單,真正的複製由後端做
    (out / agent.COPY_MANIFEST_NAME).write_text(
        str(config.OUTPUT_DIR.parent / "code" / "service.py"), encoding="utf-8"
    )
    # 子資料夾:提示裡叫它不要建,但那是規則不是機制
    (out / "細項").mkdir(exist_ok=True)
    (out / "細項" / "備註.txt").write_text("備註", encoding="utf-8")
    # 打包要排在最後,所以這裡列得到上面那些**還沒產出來**的檔案
    (out / zipgen.MANIFEST_NAME).write_text(
        "交付.zip\n料件清單.xlsx\n說明.pdf\n", encoding="utf-8"
    )

    async def gen():
        yield {"type": "delta", "text": "好了。"}
        yield {
            "type": "done",
            "success": True,
            "answer": "好了。",
            "error": None,
            "duration_ms": 12,
            "cost_usd": 0.01,
            "conversation_id": kwargs.get("conversation_id"),
        }

    return gen()


def test_一題問答產出的檔案要全部進得了下載清單(outputs, monkeypatch):
    monkeypatch.setattr(agent, "stream_agent", fake_agent)

    with TestClient(app) as client:
        token = auth._issue("tester")
        with client.stream(
            "POST",
            "/api/ask",
            data={"question": "把料件整理成 Excel 跟簡報給我"},
            headers={"Authorization": f"Bearer {token}"},
        ) as resp:
            assert resp.status_code == 200
            events = [json.loads(line) for line in resp.iter_lines() if line.strip()]

    done = [e for e in events if e["type"] == "done"]
    assert len(done) == 1, "收尾沒有送出 done —— 畫面會一直停在「回答中」"
    files = done[0]["files"]

    # 每一支產檔/交付的後處理都要有產出,而且都要在清單裡
    assert "service.py" in files, "copy manifest 沒有把伺服器上既有的檔案複製進來"
    assert "料件清單.xlsx" in files, "csv 沒有轉成 Excel,或轉了但沒進清單"
    assert "說明.pdf" in files
    assert "簡報標題.pptx" in files
    assert "交付.zip" in files
    # 原始的純文字檔留著
    assert "料件清單.csv" in files and "說明.md" in files
    # 子資料夾裡的檔案被攤平到第一層,不然它等於不存在
    assert "備註.txt" in files
    # 清單檔是給後端看的中間產物,不可以出現在使用者面前
    assert not [f for f in files if f.startswith("__")], files

    session_id = done[0]["session_id"]
    out = config.OUTPUT_DIR / session_id
    # 磁碟上的東西要跟清單一致 —— 清單是 list_output_files 掃出來的,兩者不一致
    # 代表有人在它之後又動了資料夾
    assert sorted(files) == sorted(p.name for p in out.iterdir() if p.is_file())

    # 打包的內容:zipgen 排在最後,所以前面幾支的產出包得進去
    import zipfile

    with zipfile.ZipFile(out / "交付.zip") as zf:
        assert sorted(zf.namelist()) == ["料件清單.xlsx", "說明.pdf"]

    # 補零的代號一路到 xlsx 還是文字
    from openpyxl import load_workbook

    assert load_workbook(str(out / "料件清單.xlsx")).active["A2"].value == "0012345"

    # 資料庫那一欄也要寫進去(畫面重開之後靠它,不是靠 done 事件)
    db = SessionLocal()
    try:
        record = db.get(models.QARecord, done[0]["id"])
        assert record is not None and record.status == "done"
        assert sorted(record.output_files.split(",")) == sorted(files)
        db.query(models.QAStep).filter(models.QAStep.qa_record_id == record.id).delete()
        db.query(models.QARecord).filter(models.QARecord.id == record.id).delete()
        db.query(models.ConversationMeta).filter(
            models.ConversationMeta.conversation_id == record.conversation_id
        ).delete()
        db.commit()
    finally:
        db.close()
