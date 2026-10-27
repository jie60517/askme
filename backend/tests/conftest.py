# -*- coding: utf-8 -*-
"""測試一律用自己的暫存資料庫,絕不碰 data/app.db。

`app.main.init_database()`(lifespan 觸發)會 `create_all()`、
`close_orphan_runs()`(把所有 status="running" 改寫成 done + 塞錯誤訊息)。
開發機的 data/app.db 可能是真資料:測試裡只要有人
`with TestClient(app)`,init 就會真的跑,沒有這份 conftest 就等於對那份資料庫
把進行中的紀錄改寫掉。單純 import 不會碰資料庫,那條有測試守著:`tests/test_startup.py`。

機制:pytest 保證 conftest 比任何測試模組先載入,所以在這裡把 DATABASE_URL
指到暫存目錄,晚一步才被 import 的 config.py 讀到的就是這個值
(config 的 load_dotenv() 不會覆蓋已存在的環境變數,.env 蓋不掉它)。

⚠️ 這招只對「還沒 import app 之前」有效 —— 不要在這裡 import 任何 app.* 模組。
"""
import os
import tempfile

_tmpdir = tempfile.mkdtemp(prefix="askme-test-")
# 預設走暫存的 SQLite(誰的機器都跑得起來)。要對真的 PostgreSQL 跑整套:
#   TEST_DATABASE_URL=postgresql+psycopg://app:app@localhost:5432/app_test pytest
# ⚠️ 給一個**專門給測試的空資料庫**,測試會 drop_all / create_all,裡面的東西會被清掉。
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or (
    f"sqlite:///{os.path.join(_tmpdir, 'test.db')}"
)

# **強制多因子一律關掉。** 這個旗標是從 `backend/.env` 讀進來的(config 有跑
# load_dotenv),所以開發者為了在本機試 MFA 而把它設成 1 之後,整套測試會突然
# 出現一條紅的 —— 而且症狀是 `test_files_auth.py` 的登入回 403,看起來完全像
# 程式壞了。
#
# 測試要驗的是「開/關兩種行為」,那由各自的測試用 monkeypatch 指定
# (見 test_mfa.py),不能靠跑測試的人本機碰巧設成什麼。
os.environ["MFA_REQUIRED"] = "0"

# **「公司 IP 免第二關」也一樣強制關掉。** 它跟 MFA_REQUIRED 是同一種陷阱:
# 開發者為了在本機試而在 .env 設成 1 之後,任何 monkeypatch 了
# LOGIN_IP_ALLOWLIST 的測試會突然走到「免驗」那條路,而斷言失敗的地方
# 看起來跟這個設定毫無關係。要測它的測試自己 monkeypatch(見 test_mfa.py)。
os.environ["MFA_SKIP_ON_TRUSTED_IP"] = "0"

# ADMIN_PASSWORD 沒設成真正的密碼時 `init_database()` 會拒絕啟動。所以任何
# `with TestClient(app)` 的測試都需要這一行 —— 而它必須是**不在**
# `config.ADMIN_PASSWORD_PLACEHOLDERS` 裡的值,不然等於沒設。
os.environ["ADMIN_PASSWORD"] = "test-admin-password-not-a-real-one"

# 初始密碼沒有預設值(config.DEFAULT_USER_PASSWORD 留空 = 關掉「還在用預設密碼」
# 的提示)。要測那條路的測試需要一個值,在這裡給,不要靠版控裡的字面值。
os.environ["DEFAULT_USER_PASSWORD"] = "test-default-pw-not-real"
