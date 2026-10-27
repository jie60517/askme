"""沒有自訂標題時的那一行標題(`app.conv_title.summarize_title`)。

守的是三件事:
 1. **切在該切的地方** —— 一句 99 字的問句只留前言那一截,當成重點摘要顯示,
    側邊欄與搜尋面板才不會被它撐壞。
 2. **短的不要動** —— 「嗨一」這種本來就是重點,加工只會變差。
 3. **頓號不是斷點** —— 「品號、數量、日期」切在頓號會留下沒頭沒尾的一截。

⚠️ 輸入照真實問句的樣子寫 —— 這支函式的規則是照實際問句定的,測試也該對著同一類句子。
"""

from app.conv_title import TITLE_LIMIT, summarize_title


def test_切到第一個標點():
    q = "請把這三筆資料整理成 Excel 給我:品號 0012345 數量 3、品號 0023456 數量 10。"
    assert summarize_title(q) == "請把這三筆資料整理成 Excel 給我"


def test_問號也是斷點():
    q = "這支程式的標準流程是什麼?(請給檔名,例如 checkout.py)"
    assert summarize_title(q) == "這支程式的標準流程是什麼"


def test_短標題原樣不動():
    for q in ("嗨一", "這是哪裡", "我明天的午餐應該吃什麼", "/usage"):
        assert summarize_title(q) == q


def test_頓號不切():
    # 頓號連的是並列的東西,切在那裡會留下沒頭沒尾的一截
    assert summarize_title("品號、數量、日期要怎麼填") == "品號、數量、日期要怎麼填"


def test_第一個標點太遠就硬截():
    q = "幫我把 checkout 的欄位與作業流程整理成一份 markdown 文件,寫成檔案給我下載。"
    out = summarize_title(q)
    assert out.endswith("…")
    assert len(out) == TITLE_LIMIT + 1


def test_只取第一行():
    assert summarize_title("第一行問題\n第二行補充說明") == "第一行問題"


def test_開頭就是標點時不要切成空的():
    # 切出來是空的就退回整行,不能回一個空標題
    assert summarize_title("?怎麼會這樣") == "?怎麼會這樣"


def test_空字串進來就空字串出去():
    assert summarize_title("") == ""
    assert summarize_title("   \n  ") == ""


# ── 半形逗號 / 冒號是資料的一部分時不要切;全形標點是斷點 ──


def test_時間的冒號不切():
    assert summarize_title("14:30 的排程沒跑,幫我查一下") == "14:30 的排程沒跑"


def test_網址的冒號不切():
    out = summarize_title("https://app.example.com/orders/list 打不開")
    assert out.startswith("https://app.example")
    # 查詢字串的問號也不切
    assert summarize_title("http://app/a?id=3 打不開") == "http://app/a?id=3 打不開"
    # 但中文後面的問號照切,就算後面接的是料號
    assert summarize_title("怎麼查料號?A001 的庫存") == "怎麼查料號"


def test_英數字清單的逗號不切():
    assert summarize_title("order_v1, order_v2 差在哪") == "order_v1, order_v2 差在哪"
    assert summarize_title("1,000 筆以上的報表要怎麼匯出") == "1,000 筆以上的報表要怎麼匯出"


def test_中文後面的半形冒號照切():
    # 「請幫我做某件事:細節」—— 冒號前面那半是重點(不能被上面那幾條帶壞)
    assert summarize_title("幫我查庫存:料號 A001") == "幫我查庫存"
    assert summarize_title("ok, 那就這樣") == "ok"


def test_全形標點是斷點():
    # ⚠️ 用跳脫寫:直接打全形字的話,這條測試自己也可能被存成半形,跟著程式一起錯而照樣通過
    comma, bang, semi = "\uff0c", "\uff01", "\uff1b"
    assert summarize_title(f"請幫我整理上個月的採購入庫明細{comma}依供應商分組") == "請幫我整理上個月的採購入庫明細"
    assert summarize_title(f"這個好用{bang}謝謝你") == "這個好用"
    assert summarize_title(f"先關帳{semi}再跑成本") == "先關帳"


def test_冒號後面空一格再接說明照切():
    # 時間、網址的冒號後面不會有空白;「Error: …」「Note: …」的冒號是前言結束
    assert summarize_title("Error: connection refused on login page") == "Error"

