# -*- coding: utf-8 -*-
"""檔案區的分組與版次(convfiles.group_files)。

不碰資料庫:QARecord / ConversationNote 直接 new(SQLAlchemy 模型不掛 session
也能當一般物件用),磁碟用 tmp_path 假造。
"""
from datetime import datetime, timedelta

import pytest

from app import config, convfiles, models


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    upload = tmp_path / "uploads"
    output = tmp_path / "outputs"
    upload.mkdir()
    output.mkdir()
    monkeypatch.setattr(config, "UPLOAD_DIR", upload)
    monkeypatch.setattr(config, "OUTPUT_DIR", output)
    return upload, output


def record(rec_id, session_id, *, uploaded=None, outputs=None, created_at=None, asked_by="alice"):
    return models.QARecord(
        id=rec_id,
        session_id=session_id,
        conversation_id="c-1",
        question=f"Q{rec_id}",
        answer="A",
        uploaded_filename=uploaded,
        output_files=outputs,
        created_at=created_at or datetime(2026, 8, 21, 1, 0, 0) + timedelta(minutes=rec_id),
        owner="alice",
        asked_by=asked_by,
    )


def write(base, session_id, name, content=b"x"):
    d = base / session_id
    d.mkdir(exist_ok=True)
    (d / name).write_bytes(content)


def test_versions_numbered_across_turns_and_latest_first(dirs):
    upload, output = dirs
    write(output, "s-1", "report.md")
    write(output, "s-3", "report.md")
    records = [
        record(1, "s-1", outputs="report.md"),
        record(2, "s-2"),
        record(3, "s-3", outputs="report.md"),
    ]
    groups = convfiles.group_files(records, display={"alice": "Alice"})
    report = next(g for g in groups if g.name == "report.md")
    # versions[0] 一定是目前版本(第 3 題那份,v2)
    assert [v.version for v in report.versions] == [2, 1]
    assert report.versions[0].turn == 3
    assert report.versions[0].asked_by == "Alice"


def test_missing_file_is_listed_but_flagged(dirs):
    # 資料庫說有、磁碟上沒有:要列出來並標 missing,不能悄悄消失
    records = [record(1, "s-1", outputs="gone.zip")]
    groups = convfiles.group_files(records, display={})
    assert groups[0].versions[0].missing is True


def test_upload_and_output_share_one_version_sequence(dirs):
    upload, output = dirs
    write(upload, "s-1", "spec.docx")
    write(output, "s-2", "spec.docx")
    records = [
        record(1, "s-1", uploaded="spec.docx"),
        record(2, "s-2", outputs="spec.docx"),
    ]
    groups = convfiles.group_files(records, display={})
    spec = next(g for g in groups if g.name == "spec.docx")
    # 跨 upload/output 一起編:AI 產出的那份是目前版本
    assert spec.versions[0].kind == "output"
    assert spec.versions[0].version == 2
    assert spec.versions[1].kind == "upload"
    assert spec.versions[1].version == 1


def test_dangerous_names_are_skipped(dirs):
    # 檔名會被組進下載網址 —— 帶路徑的怪東西不列,比列一個必 400 的連結乾淨
    records = [record(1, "s-1", uploaded="../etc/passwd,ok.txt")]
    upload, _ = dirs
    write(upload, "s-1", "ok.txt")
    groups = convfiles.group_files(records, display={})
    assert [g.name for g in groups] == ["ok.txt"]


def test_note_attachment_anchored_after_its_turn(dirs):
    upload, _ = dirs
    write(upload, "n-9", "shot.png")
    records = [record(1, "s-1"), record(2, "s-2")]
    note = models.ConversationNote(
        id=9,
        conversation_id="c-1",
        author="ming",
        body="@alice 看一下",
        created_at=records[0].created_at + timedelta(seconds=30),
        attachment_sid="n-9",
        attachments="shot.png",
    )
    groups = convfiles.group_files(records, display={"ming": "小明"}, notes=[note])
    shot = next(g for g in groups if g.name == "shot.png")
    v = shot.versions[0]
    # 便條不冒用任何一題的 qa_id;錨點是它前面那一題的題號
    assert v.qa_id is None
    assert v.note_id == 9
    assert v.turn == 1
    assert v.asked_by == "小明"


def test_written_at_never_earlier_than_asked_at(dirs, tmp_path):
    """copy2 交付的檔案會帶著來源的 mtime(可能是 2024 年)——
    顯示時間不能比問題還早,不然「剛拿到的」會被標成兩年前的。"""
    import os

    upload, output = dirs
    write(output, "s-1", "old.py")
    old = datetime(2020, 1, 1).timestamp()
    os.utime(output / "s-1" / "old.py", (old, old))
    records = [record(1, "s-1", outputs="old.py")]
    groups = convfiles.group_files(records, display={})
    assert groups[0].versions[0].created_at == records[0].created_at
