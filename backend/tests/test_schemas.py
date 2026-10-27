# -*- coding: utf-8 -*-
"""回應模型的欄位契約 —— Pydantic 會把沒宣告的欄位濾掉,漏一個就是整條功能靜默失效。"""
from app import schemas


def test_history_item_has_uploaded_filename():
    """HistoryItem 漏了 uploaded_filename 的話,
    附件在 AI 答完、畫面改用歷史資料重畫之後就消失(泡泡上那排 Token 不見)。
    時間軸要的 sources / duration_ms 同一類:漏宣告就是整條功能靜默失效。
    """
    fields = schemas.HistoryItem.model_fields
    assert "uploaded_filename" in fields
    assert "sources" in fields
    assert "duration_ms" in fields


def test_history_item_optional_fields_have_defaults():
    # 部署交接的空窗會有「新前端 + 舊後端 / 舊資料」:這幾個欄位一定要可缺,
    # 缺了不能讓整個序列化炸掉
    fields = schemas.HistoryItem.model_fields
    for name in ("uploaded_filename", "duration_ms", "asked_by", "asked_by_name"):
        assert not fields[name].is_required(), name
