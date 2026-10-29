# 問我問我(AskME)

用網頁問自家程式碼與文件的問題。後端呼叫主機上的 `claude` CLI(Claude Code,headless 模式),
直接沿用各專案已經寫好的 `CLAUDE.md`、規則檔、文件與 skills,外面加一層網頁介面、問答紀錄、
用量統計與檔案上傳 / 下載。

## 功能

- **問答**:一個輸入框,問題原封不動交給 claude;答案附上它實際讀過的檔案。關掉分頁、換一台電腦,回答照樣跑完、接得回來
- **多專案**:`workspace\` 底下每個資料夾就是一個專案,輸入框旁的選單切換
- **檔案**:上傳附件給它讀;請它產生 Excel / Word / PDF / 簡報 / zip,直接下載
- **協作**:對話分享、在對話裡 @ 同事留便條、側邊欄資料夾、個人筆記
- **管理**:帳號管理、多因子驗證(手機驗證碼)、登入失敗鎖定、地理封鎖、用量統計、安全頁
- **選配**:網頁上的 SSH 終端機、Work Flow 排程

## 需求

- Python 3.11 以上
- Node.js 22.12 以上(或 20.19 以上)
- Claude Code CLI,裝好並登入過一次(終端機打 `claude` 能問答)。
  沒有它網站照樣開得起來,只是問答會回「無法啟動 claude CLI」
- Poppler(`pdftoppm`),claude 讀 PDF 要用。`setup.cmd` 會用 winget 自動裝;
  沒有它問答只讀得了小份的 PDF,大份的手冊會回「pdftoppm is not installed」,其他照常

## 快速開始(Windows)

在 PowerShell 裡:

**1. 下載並安裝**(安裝只要一次;重跑也沒關係,已經有的設定不會被蓋掉)

```powershell
git clone https://github.com/jie60517/askme.git
cd askme
.\setup.cmd
```

最後印出綠字「安裝完成」就好了。npm 若顯示「N vulnerabilities」是套件的已知漏洞提醒,不影響使用;
**不要跑 `npm audit fix`**(它會改掉 `package-lock.json`)。

**2. 把專案放進 `workspace\`**(見下面〈放自己的專案〉)

**3. 啟動**(之後每次都只要這一行)

```powershell
.\start.cmd
```

前後端在同一個視窗裡起來,好了會自動開瀏覽器到 <http://localhost:5173>。視窗會停在那裡不動,這是正常的,
**不要關**;要停就按 Ctrl+C。用 **tiptop / tiptop** 登入(`backend\.env` 的 `ADMIN_USERNAME` /
`ADMIN_PASSWORD`,**給別人用之前一定要改**),管理員到「帳號管理」建同仁的帳號。

- 8123 是後端的 API,不是網頁;在瀏覽器開它只會看到 404。
- 埠被佔了就換:`.\start.cmd -BackendPort 8124 -FrontendPort 5174`。

想讓 AI 帶你裝:把 repo 連結給 Claude Code,說「照 INSTALL.md 帶我安裝」,步驟寫在 [`INSTALL.md`](INSTALL.md)。

<details>
<summary>手動安裝與啟動(不用腳本、或在 Linux / macOS)</summary>

後端、前端各開一個終端機,都從 repo 根目錄起算。Linux / macOS 把 `.venv\Scripts` 換成 `.venv/bin`、`Copy-Item` 換成 `cp`。

```powershell
# 後端(API,http://127.0.0.1:8123)
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt
Copy-Item .env.example .env
.venv\Scripts\python -m uvicorn app.main:app --port 8123
```

```powershell
# 前端(網頁,http://localhost:5173;/api 由 vite 轉到 8123)
cd frontend
npm install
npm run dev
```

後端印出 `Uvicorn running on http://127.0.0.1:8123`、前端印出 `Local: http://localhost:5173/` 就是起來了。
Windows 上後端**不要加 `--reload`**(問答會跑不起來)。

</details>

## 放自己的專案

`workspace\` 底下**第一層的每一個資料夾就是一個專案**,資料夾名就是網頁上的專案名稱。
整個專案資料夾(含程式碼)複製進去,結構不用改;放好重新整理網頁就看得到,不用重啟。

```
askme\workspace\
├─ topprod\                  ← 一個專案(例:正式區)
│   ├─ CLAUDE.md             這個專案的規則:這是什麼專案、怎麼回答
│   ├─ RULES-web-context.md  網頁情境的通用規則(CLAUDE.md 引入它)
│   ├─ .claude\skills\       專案專用的 skill(選配)
│   └─ tiptop\aap\4gl\…      程式碼本身
└─ toptest\                  ← 另一個專案(例:測試區)
```

- **資料夾裡要有程式碼本身**。只放 `CLAUDE.md` 的話問什麼都讀不到東西,畫面上也不會提示。
- `CLAUDE.md` 從 [`deploy/workdirs/CLAUDE.template.md`](deploy/workdirs/CLAUDE.template.md) 複製來改;
  `RULES-web-context.md` 從 `deploy/workdirs/` 複製一份放在旁邊。引入的檔一定要在專案資料夾裡面,
  指到外面(`@../…`)的不會被載入。
- 新對話預設選清單上第一個專案(照資料夾名排序)。要固定預設哪一個,把 `backend\knowledge_bases.json`
  的 `"default"` 填成那個資料夾名,再重啟。
- 專案不在 `workspace\` 裡、或要設範例問題 / 預設模型 / 文件目錄,就在 `backend\knowledge_bases.json`
  加一筆(欄位說明在那個檔的 `_說明`)。改這個檔要重啟。

## 可以不開的功能

這幾項不用的話什麼都不必做(或只要一行設定),畫面上就不會出現:

| 功能 | 設定 | 預設 |
|---|---|---|
| SSH 終端機(側邊欄 SSH Server) | `.env` 的 `SSH_TERMINAL_*`、`backend\terminal_hosts.json` | 關(`SSH_TERMINAL_ENABLED=0`) |
| Work Flow(排程拼圖,經 SSH 在主機上跑指令) | `backend\workflow_actions.json`(範本 `workflow_actions.example.json`);也要 SSH 終端機開著 | 沒有這個檔就不出現 |
| 登入的地理封鎖(只放行台灣 IP) | `.env` 的 `GEO_BLOCK_MODE` | `off` |
| 個人筆記(側邊欄 Notes) | `.env` 的 `NOTEBOOK_ENABLED` | 開;設 `0` 重啟就關 |

## 設定

- 本機:`backend\.env`(安裝時從 `backend\.env.example` 複製,只列本機需要的幾行)
- 全部設定與每一條的理由:[`deploy/env.server.example`](deploy/env.server.example)
- **資料庫**:預設 SQLite(`backend\data\app.db`),不用另外裝。多人用改 PostgreSQL:把 `DATABASE_URL`
  換成 `postgresql+psycopg://帳號:密碼@主機:5432/資料庫名`(資料庫與帳號先建好)。
  搬資料、備份、升級見 [`docs/operations.md`](docs/operations.md)

## 部署給多人用

只用 Docker:網站、claude CLI、PostgreSQL 一起起。步驟在 [`deploy/docker/README.md`](deploy/docker/README.md)。

## 文件

| 文件 | 內容 |
|---|---|
| [`INSTALL.md`](INSTALL.md) | 第一次安裝引導(給帶人安裝的 AI) |
| [`deploy/docker/README.md`](deploy/docker/README.md) | Docker 部署、日常指令、更新與退版 |
| [`docs/operations.md`](docs/operations.md) | 資料庫(SQLite / PostgreSQL)、搬資料、備份、升級 |
| [`docs/architecture.md`](docs/architecture.md) | 問答怎麼跑、資料表、prompt cache、檔案上傳與產生、SSH 終端機等機制 |
| [`docs/security.md`](docs/security.md) | 帳號、登入、MFA、鎖定、地理封鎖、安全標頭 |
| [`docs/development.md`](docs/development.md) | 本機示範站、文件與註解慣例、前端介面慣例 |

## 目錄結構

```
backend/             FastAPI 服務:呼叫 claude CLI、問答紀錄、統計、上傳 / 下載 API
frontend/            React 19 + Astryx 設計系統(StyleX)的網頁
deploy/              docker/(部署)、env.server.example(全部設定)、nginx 範本、
                     workdirs/(專案 CLAUDE.md 範本與網頁情境規則)、security_test.py(安全檢查)
docs/                架構、安全、維運、開發說明
workspace/           放你自己的專案(repo 裡只有一份說明檔)
scripts/             Windows 一鍵安裝 / 啟動(setup.cmd、start.cmd 叫的就是這兩支)
pet-companion-kit/   小夥伴元件的規格與範例(程式碼在 frontend/src/pet)
```

## 開發

```powershell
# 後端測試,在 backend\ 底下
.venv\Scripts\python -m pytest
# 前端測試,在 frontend\ 底下
npm run test
```

改程式之前先看 [`docs/development.md`](docs/development.md),改哪個機制先讀 [`docs/architecture.md`](docs/architecture.md) 對應那一節。
