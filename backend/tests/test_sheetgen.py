# -*- coding: utf-8 -*-
"""csv 自動轉 Excel(sheetgen.apply_csv_exports)。

不碰資料庫、不跑 agent:輸出資料夾用 tmp_path 假造,直接呼叫收尾時那支函式。
"""
import pytest
from openpyxl import load_workbook

from app import config, sheetgen


@pytest.fixture
def out_dir(tmp_path, monkeypatch):
    output = tmp_path / "outputs"
    output.mkdir()
    monkeypatch.setattr(config, "OUTPUT_DIR", output)
    session = output / "s-1"
    session.mkdir()
    return session


def sheet_of(session, name):
    return load_workbook(str(session / name)).active


def test_csv_轉成同名_xlsx_而且_csv_留著(out_dir):
    (out_dir / "料表.csv").write_text("品號,數量\nA-100,3\n", encoding="utf-8")

    assert sheetgen.apply_csv_exports("s-1") == []

    assert (out_dir / "料表.csv").is_file()  # 兩份都要在下載清單裡
    sheet = sheet_of(out_dir, "料表.xlsx")
    assert [c.value for c in sheet[1]] == ["品號", "數量"]
    assert [c.value for c in sheet[2]] == ["A-100", 3]


def test_開頭補零的代號不可以變成數字(out_dir):
    """料號、廠商編號常常是補零的字串,轉成數字就對不起來了。"""
    (out_dir / "a.csv").write_text("代號,金額,單價\n0012345,1200,3.5\n", encoding="utf-8")

    sheetgen.apply_csv_exports("s-1")

    assert [c.value for c in sheet_of(out_dir, "a.xlsx")[2]] == ["0012345", 1200, 3.5]


def test_太長的數字與千分位留成文字(out_dir):
    """16 位以上會被浮點數吃掉尾數;千分位猜不準,一律不猜。"""
    (out_dir / "a.csv").write_text("a,b\n12345678901234567,\"1,200\"\n", encoding="utf-8")

    sheetgen.apply_csv_exports("s-1")

    assert [c.value for c in sheet_of(out_dir, "a.xlsx")[2]] == ["12345678901234567", "1,200"]


def test_等號開頭的字串不可以變成公式(out_dir):
    (out_dir / "a.csv").write_text("欄位\n=1+1\n", encoding="utf-8")

    sheetgen.apply_csv_exports("s-1")

    cell = sheet_of(out_dir, "a.xlsx")["A2"]
    assert cell.value == "=1+1"
    assert cell.data_type == "s"


def test_big5_的檔案不會變亂碼(out_dir):
    """繁體中文 Windows 上從 Excel 另存的 csv 通常是 Big5。"""
    (out_dir / "a.csv").write_bytes("品名\n螺絲\n".encode("cp950"))

    sheetgen.apply_csv_exports("s-1")

    assert [c.value for c in sheet_of(out_dir, "a.xlsx")["A"]] == ["品名", "螺絲"]


def test_tab_分隔也認得(out_dir):
    (out_dir / "a.csv").write_text("a\tb\n1\t2\n", encoding="utf-8")

    sheetgen.apply_csv_exports("s-1")

    assert [c.value for c in sheet_of(out_dir, "a.xlsx")[1]] == ["a", "b"]


def test_標題列粗體並凍結(out_dir):
    (out_dir / "a.csv").write_text("a,b\n1,2\n", encoding="utf-8")

    sheetgen.apply_csv_exports("s-1")

    sheet = sheet_of(out_dir, "a.xlsx")
    assert sheet["A1"].font.bold is True
    assert sheet.freeze_panes == "A2"


def test_只有一列時不凍結(out_dir):
    (out_dir / "a.csv").write_text("a,b\n", encoding="utf-8")

    sheetgen.apply_csv_exports("s-1")

    assert sheet_of(out_dir, "a.xlsx").freeze_panes is None


def test_空檔案不產生任何東西(out_dir):
    (out_dir / "a.csv").write_text("\n \n", encoding="utf-8")

    assert sheetgen.apply_csv_exports("s-1") == []
    assert not (out_dir / "a.xlsx").exists()


def test_撞名不覆蓋也不跳過_改加序號(out_dir):
    """既有的那份可能是 copy manifest 剛複製進來的正本。

    蓋掉會毀了正本;跳過則是使用者要了 Excel 卻什麼都沒拿到,而畫面上一句話都沒有。
    加序號兩份都留得住,下載清單上也看得出來。
    """
    (out_dir / "a.csv").write_text("a\n1\n", encoding="utf-8")
    (out_dir / "a.xlsx").write_bytes(b"original")

    assert sheetgen.apply_csv_exports("s-1") == []
    assert (out_dir / "a.xlsx").read_bytes() == b"original"
    assert (out_dir / "a(2).xlsx").is_file()


def test_太大的檔案只回訊息(out_dir, monkeypatch):
    monkeypatch.setattr(sheetgen, "MAX_BYTES", 10)
    (out_dir / "a.csv").write_text("a,b\n" * 20, encoding="utf-8")

    notices = sheetgen.apply_csv_exports("s-1")

    assert len(notices) == 1 and "太大" in notices[0]
    assert not (out_dir / "a.xlsx").exists()


def test_轉檔失敗只回訊息不丟例外_而且不留半個檔(out_dir, monkeypatch):
    """收尾階段:答案已經算完了,不該因為轉檔失敗把整題變成失敗。"""
    def boom(src, dst):
        dst.write_bytes(b"half written")
        raise RuntimeError("壞了")

    monkeypatch.setattr(sheetgen, "csv_to_xlsx", boom)
    (out_dir / "a.csv").write_text("a\n1\n", encoding="utf-8")

    notices = sheetgen.apply_csv_exports("s-1")

    assert len(notices) == 1 and "轉成 Excel 失敗" in notices[0]
    assert not (out_dir / "a.xlsx").exists()


def test_沒有_csv_的時候什麼都不做(out_dir):
    (out_dir / "答案.md").write_text("hi", encoding="utf-8")

    assert sheetgen.apply_csv_exports("s-1") == []
    assert list(out_dir.iterdir()) == [out_dir / "答案.md"]


def test_資料夾不存在也不會爆(out_dir):
    assert sheetgen.apply_csv_exports("沒這個 session") == []


def test_一題有好幾個_csv_就全部轉(out_dir):
    (out_dir / "a.csv").write_text("x\n1\n", encoding="utf-8")
    (out_dir / "b.csv").write_text("y\n2\n", encoding="utf-8")

    sheetgen.apply_csv_exports("s-1")

    assert (out_dir / "a.xlsx").is_file() and (out_dir / "b.xlsx").is_file()


# ---------------------------------------------------------------- 留下來的 csv 也要擋公式

def test_留下的_csv_公式開頭加前綴_xlsx_拿原值(out_dir):
    (out_dir / "a.csv").write_bytes(
        b'name,amount,note\n=HYPERLINK("http://x"),-120.5,+cmd|calc\n@SUM(A1),-,-0012\n"\tx",3,"\r=1"\n'
        b'-SUM(1),"-1,234.5",+5%\n'
    )

    assert sheetgen.apply_csv_exports("s-1") == []

    text = (out_dir / "a.csv").read_bytes().decode("utf-8")
    lines = text.split("\n")
    assert lines[1:3] == [
        "\"'=HYPERLINK(\"\"http://x\"\")\",-120.5,'+cmd|calc",
        # 單獨一個「-」、純數字(補零、千分位、百分比、正負號)Excel 只當數字,不加
        "'@SUM(A1),-,-0012",
    ]
    assert lines[4] == "'-SUM(1),\"-1,234.5\",+5%"
    assert "\n'\tx,3," in text and "\"'\r=1\"" in text
    assert "\r\n" not in text.replace("\r=1", "")  # 原本是 \n 換行,寫回去也是
    # xlsx 是用原值轉的(openpyxl 那邊另外擋了「=」),Excel 裡看不到多出來的 '
    sheet = sheet_of(out_dir, "a.xlsx")
    assert sheet["A2"].value == '=HYPERLINK("http://x")' and sheet["A2"].data_type == "s"
    assert sheet["B2"].value == -120.5


def test_沒有公式開頭的_csv_一個位元組都不動(out_dir):
    raw = "品名;數量\r\n螺絲;-3\r\n".encode("cp950")
    (out_dir / "a.csv").write_bytes(raw)

    sheetgen.apply_csv_exports("s-1")

    assert (out_dir / "a.csv").read_bytes() == raw


def test_big5_與_bom_寫回去還是原本的編碼(out_dir):
    (out_dir / "big5.csv").write_bytes("品名\r\n=螺絲\r\n".encode("cp950"))
    (out_dir / "bom.csv").write_bytes("品名\n=螺絲\n".encode("utf-8-sig"))

    sheetgen.apply_csv_exports("s-1")

    assert (out_dir / "big5.csv").read_bytes() == "品名\r\n'=螺絲\r\n".encode("cp950")
    assert (out_dir / "bom.csv").read_bytes() == "品名\n'=螺絲\n".encode("utf-8-sig")


def test_太大沒轉_xlsx_的_csv_一樣擋(out_dir, monkeypatch):
    monkeypatch.setattr(sheetgen, "MAX_BYTES", 5)
    (out_dir / "a.csv").write_bytes(b"a\n=1+1\n")

    sheetgen.apply_csv_exports("s-1")

    assert not (out_dir / "a.xlsx").exists()
    assert (out_dir / "a.csv").read_bytes() == b"a\n'=1+1\n"


def test_沒裝_openpyxl_時每一份_csv_都要擋(out_dir, monkeypatch):
    """一份都轉不了就提早收尾 —— 後面還沒輪到的 csv 一樣留在下載清單上,一樣要加前綴。"""

    def no_openpyxl(src, dst):
        raise ImportError("openpyxl")

    monkeypatch.setattr(sheetgen, "csv_to_xlsx", no_openpyxl)
    for name in ("a.csv", "b.csv", "c.csv"):
        (out_dir / name).write_bytes(b"x\n=1+1\n")

    notices = sheetgen.apply_csv_exports("s-1")

    assert notices  # 講了缺套件
    for name in ("a.csv", "b.csv", "c.csv"):
        assert (out_dir / name).read_bytes() == b"x\n'=1+1\n", name
