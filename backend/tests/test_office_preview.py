# -*- coding: utf-8 -*-
"""產出檔預覽。

這一支守三件事:
1. 轉成 Word / PDF 成功的 .md 原稿不列進下載清單(但留在磁碟上),轉失敗的照列;
2. Excel 讀成表格資料(截斷、壞檔);
3. `/api/preview/...?as=pdf|sheet` 的權限與轉不了時的狀態碼(前端靠 503 / 415 退回純文字)。

真的叫 LibreOffice 的那一條只在本機裝了才跑。
"""
import base64
import json

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app import agent, auth, config, docgen, models, officepreview, outputs_common, pdfgen
from app.database import SessionLocal
from app.main import app

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
NOW, PREV, OTHER = "a" * 32, "b" * 32, "c" * 32


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "outputs")
    for sid in (NOW, PREV, OTHER):
        (tmp_path / "uploads" / sid).mkdir(parents=True)
        (tmp_path / "outputs" / sid).mkdir(parents=True)
    return tmp_path


def _out(sid):
    return config.OUTPUT_DIR / sid


# ---------------------------------------------------------------- 1. 前幾題的附圖














# ---------------------------------------------------------------- 2. md 原稿不列


def test_轉成功的md不列_但留在磁碟上(dirs):
    (_out(NOW) / "說明.md").write_text("# 說明\n", encoding="utf-8")
    (_out(NOW) / "附註.md").write_text("沒有要轉的", encoding="utf-8")
    (_out(NOW) / docgen.MANIFEST_NAME).write_text("說明.md\n", encoding="utf-8")
    docgen.apply_docx_manifest(NOW)
    files = agent.list_output_files(NOW)
    assert sorted(files) == sorted(["附註.md", "說明.docx"])  # 沒點名轉的照列
    assert (_out(NOW) / "說明.md").is_file()  # AI 續問要讀得到原稿


def test_同一份md有一次轉失敗就照列(dirs, monkeypatch):
    (_out(NOW) / "說明.md").write_text("# 說明\n", encoding="utf-8")
    (_out(NOW) / docgen.MANIFEST_NAME).write_text("說明.md\n", encoding="utf-8")
    (_out(NOW) / pdfgen.MANIFEST_NAME).write_text("說明.md\n", encoding="utf-8")
    docgen.apply_docx_manifest(NOW)

    def boom(*args, **kwargs):
        raise RuntimeError("壞了")

    monkeypatch.setattr(pdfgen, "render", boom)
    pdfgen.apply_pdf_manifest(NOW)
    assert "說明.md" in agent.list_output_files(NOW)


# ---------------------------------------------------------------- 3. Excel 讀成表格


def _xlsx(path, rows, sheets=1):
    from openpyxl import Workbook

    wb = Workbook()
    for n in range(sheets):
        ws = wb.active if n == 0 else wb.create_sheet()
        ws.title = "表%d" % (n + 1)
        for row in rows:
            ws.append(row)
    wb.save(str(path))


def test_Excel讀成每張工作表的值(tmp_path):
    import datetime

    path = tmp_path / "a.xlsx"
    _xlsx(path, [["品號", "數量", "日期", None], ["0012", 3, datetime.date(2026, 11, 2), None], [None]], sheets=2)
    got = officepreview.sheets(path)
    assert [s["name"] for s in got] == ["表1", "表2"]
    # 尾端的空欄、空列拿掉;補零的代號是字串、數字是數字、日期轉成字
    assert got[0]["rows"] == [["品號", "數量", "日期"], ["0012", 3, "2026/11/02"]]
    assert got[0]["truncated"] is False


def test_Excel超過上限的列截掉並標出來(tmp_path, monkeypatch):
    monkeypatch.setattr(officepreview, "MAX_ROWS", 3)
    path = tmp_path / "a.xlsx"
    _xlsx(path, [[i] for i in range(10)])
    got = officepreview.sheets(path)[0]
    assert len(got["rows"]) == 3 and got["truncated"] is True


def test_壞掉的Excel丟Failed不丟500(tmp_path):
    path = tmp_path / "a.xlsx"
    path.write_bytes(b"not a zip")
    with pytest.raises(officepreview.Failed):
        officepreview.sheets(path)


def test_沒裝LibreOffice丟Unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PREVIEW_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(officepreview, "_find_soffice", lambda: None)
    path = tmp_path / "a.docx"
    Document().save(str(path))
    with pytest.raises(officepreview.Unavailable):
        officepreview.to_pdf(path)


@pytest.mark.skipif(officepreview._find_soffice() is None, reason="這台沒裝 LibreOffice")
def test_真的轉成PDF_第二次走快取(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PREVIEW_CACHE_DIR", tmp_path / "cache")
    path = tmp_path / "說明.docx"
    doc = Document()
    doc.add_paragraph("出貨流程說明")
    doc.save(str(path))
    first = officepreview.to_pdf(path)
    assert first.read_bytes().startswith(b"%PDF")
    calls = []
    monkeypatch.setattr(officepreview, "_run", lambda *a, **k: calls.append(a))
    assert officepreview.to_pdf(path) == first and calls == []


def test_轉檔卡住會被砍掉並丟Failed(monkeypatch):
    import sys
    import time

    monkeypatch.setattr(officepreview, "CONVERT_TIMEOUT_SEC", 0.5)
    started = time.monotonic()
    with pytest.raises(officepreview.Failed):
        officepreview._run([sys.executable, "-c", "import time; time.sleep(30)"], "卡住.docx")
    assert time.monotonic() - started < 10


# ---------------------------------------------------------------- 4. 路由


@pytest.fixture
def record(dirs, monkeypatch):
    from app.routers import files as files_router

    # 預覽路由在載入時就把目錄記成一張表(`_PREVIEW_DIRS`),換掉 config 它看不到
    monkeypatch.setitem(files_router._PREVIEW_DIRS, "files", config.OUTPUT_DIR)
    with TestClient(app):  # 資料表是 App 啟動時建的;這支單獨跑時要先啟動一次
        pass
    db = SessionLocal()
    db.add(models.QARecord(session_id=NOW, conversation_id="conv-preview", question="q", answer="a", owner="tester"))
    db.commit()
    yield
    db.query(models.QARecord).filter(models.QARecord.session_id == NOW).delete()
    db.commit()
    db.close()


def _get(url, user="tester"):
    with TestClient(app) as client:
        client.cookies.set(auth.SESSION_COOKIE, auth._issue(user))
        return client.get(url)


def test_表格預覽路由(record):
    _xlsx(_out(NOW) / "明細.xlsx", [["品號"], ["A1"]])
    resp = _get(f"/api/preview/files/{NOW}/明細.xlsx?as=sheet")
    assert resp.status_code == 200
    body = resp.json()
    assert body["sheets"][0]["rows"] == [["品號"], ["A1"]]
    assert body["max_rows"] == officepreview.MAX_ROWS


def test_別人拿不到表格預覽(record):
    _xlsx(_out(NOW) / "明細.xlsx", [["品號"]])
    assert _get(f"/api/preview/files/{NOW}/明細.xlsx?as=sheet", user="somebody-else").status_code == 404


def test_轉不了的狀態碼_前端靠它退回純文字(record, monkeypatch):
    Document().save(str(_out(NOW) / "a.docx"))
    monkeypatch.setattr(officepreview, "_find_soffice", lambda: None)
    monkeypatch.setattr(config, "PREVIEW_CACHE_DIR", config.OUTPUT_DIR.parent / "cache")
    assert _get(f"/api/preview/files/{NOW}/a.docx?as=pdf").status_code == 503
    (_out(NOW) / "壞.xlsx").write_bytes(b"x")
    assert _get(f"/api/preview/files/{NOW}/壞.xlsx?as=sheet").status_code == 415
    assert _get(f"/api/preview/files/{NOW}/a.docx?as=html").status_code == 400
    # 不帶 as 還是原本的純文字
    assert _get(f"/api/preview/files/{NOW}/a.docx").status_code == 200


# ---------------------------------------------------------------- 上限、排隊、轉不出來




def test_Excel欄數超過上限也標出來(tmp_path, monkeypatch):
    monkeypatch.setattr(officepreview, "MAX_COLS", 3)
    path = tmp_path / "a.xlsx"
    _xlsx(path, [list(range(10)), list(range(10))])
    got = officepreview.sheets(path)[0]
    assert len(got["rows"][0]) == 3 and got["truncated"] is True


def test_排隊等太久回Unavailable_不佔著執行緒等(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PREVIEW_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(officepreview, "_find_soffice", lambda: "soffice")
    monkeypatch.setattr(officepreview, "LOCK_WAIT_SEC", 0.1)
    path = tmp_path / "a.docx"
    Document().save(str(path))
    officepreview._lock.acquire()
    try:
        with pytest.raises(officepreview.Unavailable):
            officepreview.to_pdf(path)
    finally:
        officepreview._lock.release()


def test_轉不出來的那一份記住_再打開不重轉(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PREVIEW_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(officepreview, "_find_soffice", lambda: "soffice")
    monkeypatch.setattr(officepreview, "_failed", {})
    calls = []

    def boom(*a, **k):
        calls.append(a)
        raise officepreview.Failed("逾時")

    monkeypatch.setattr(officepreview, "_run", boom)
    path = tmp_path / "a.docx"
    Document().save(str(path))
    for _ in range(2):
        with pytest.raises(officepreview.Failed):
            officepreview.to_pdf(path)
    assert len(calls) == 1


def test_找不到LibreOffice不記住_之後裝了就用得到(monkeypatch, tmp_path):
    monkeypatch.setattr(officepreview, "_soffice", None)
    monkeypatch.setattr(config, "SOFFICE_PATH", "")
    monkeypatch.setattr(officepreview.shutil, "which", lambda name: None)
    monkeypatch.setattr(officepreview.os, "name", "posix")
    assert officepreview._find_soffice() is None
    fake = tmp_path / "soffice"
    fake.write_text("")
    monkeypatch.setattr(config, "SOFFICE_PATH", str(fake))
    assert officepreview._find_soffice() == str(fake)
