# 第一次安裝引導(給帶人安裝的 AI 看)

使用者剛 clone 這個 repo、請你(AI)帶他把**開發版**裝起來時,照這份走。
人自己看 README「怎麼用」那段就夠了,這份多的是「每一步要問什麼、會看到什麼、卡住怎麼辦」。

> 這份刻意**不叫 `CLAUDE.md`**:`workspace\` 底下的專案就在這個 repo 裡,網頁問答時
> claude 以專案資料夾為 cwd、會往上層找 `CLAUDE.md` —— 放在根目錄就會被載進每一題的問答。

## 帶法

- 一次只講一步:在哪個資料夾、打什麼、預期看到什麼。等使用者貼回結果再往下。
- 使用者想自己動手就讓他打;他說「你幫我跑」才替他跑。
- Windows 的終端機多半是 **Windows PowerShell 5.1**:不能用 `&&`,路徑用反斜線。
- 不要改 repo 裡的檔案,除非是下面寫到、而且使用者同意的(`knowledge_bases.json` 那一步)。

## 流程

### 0. 先確認環境

需要 Python 3.11+、Node 20.19+ 或 22.12+、Claude Code CLI 已登入(`claude` 能問答)。
`setup.cmd` 第一步也會檢查;缺 `claude` 只會警告(網站開得起來,問答會回「無法啟動 claude CLI」)。

### 1. 安裝

repo 根目錄:

```powershell
.\setup.cmd
```

- 會跑 1~3 分鐘,最後一段是綠字「安裝完成」。
- 「N vulnerabilities」:不影響啟動,**不要跑 `npm audit fix`**(會改 `package-lock.json`)。
- 紅字「[失敗]」:照那行說的處理(多半是 Python / Node 版本或網路),處理完重跑 `.\setup.cmd` 就好。
- `setup.cmd` / `start.cmd` 用 `-ExecutionPolicy Bypass` 叫 `scripts\*.ps1`(只放行那一次執行,
  不改系統設定),所以預設擋 `.ps1` 的電腦也跑得動。**要打 `.cmd`,不要直接打 `scripts\*.ps1`**
  —— 直接打會被執行原則擋下(「這個系統上已停用指令碼執行」)。

### 2. 放專案(安裝流程的一部分,不要跳過)

先問使用者:**要放哪些專案?各在電腦的哪個資料夾?** 然後說明規則並給完整路徑的例子:

- `workspace\` 底下**第一層的每個資料夾 = 一個專案**,資料夾名就是網頁上的專案名稱。
- 整個專案資料夾(含程式碼)複製進去,結構不用改。正式區、測試區各放一個資料夾,例如
  `askme\workspace\toptest\tiptop\aap\4gl`(測試區)、`askme\workspace\topprod\...`(正式區)。
- 專案資料夾放一份 `CLAUDE.md` 寫這個專案的規則(範本 `workspace\example\CLAUDE.md`),
  專用 skill 放 `.claude\skills\`。都是選配,但 `CLAUDE.md` 強烈建議。

放好後**幫他檢查**:每個專案資料夾裡真的有程式碼(不是只有 `CLAUDE.md` / `.claude`)。
只有 `CLAUDE.md` 的話,問什麼都讀不到東西,而畫面上不會提示 —— 要跟他講。

接著問:**`workspace\example` 這個範例專案要不要留?** 先講清楚它是 repo 附的、不是他的。

- 留著:什麼都不用做。
- 只想新對話預設他的專案:`backend\knowledge_bases.json` 的 `"default"` 改成他的資料夾名。
- 整個拿掉:刪 `workspace\example`,並把 `knowledge_bases.json` 改成 `"default": "<他的資料夾>"`、
  `"bases": []`。**只刪資料夾不夠**:json 那一筆還在,選單照樣列出「範例專案」、新對話也還是預設它。
  改完用 `python -c "import json;json.load(open('backend/knowledge_bases.json',encoding='utf-8'))"` 確認格式沒壞。

### 3. 啟動

```powershell
.\start.cmd
```

- 印出綠字「好了。打開 http://localhost:5173 …」並自動開瀏覽器。**視窗會停住不動,這是正常的,不要關**;要停按 Ctrl+C。
- 告訴他:**之後每次只要這一行。**
- 8123 是後端 API,**不是網頁**;在瀏覽器開 8123 會看到 404,那不是壞了。
- 「埠 xxxx 已經有程式在用」:另一份已經開著,或換埠 `.\start.cmd -BackendPort 8124 -FrontendPort 5174`。
- 改了 `knowledge_bases.json` 或 `backend\.env` 要重啟(Ctrl+C 再 `.\start.cmd`);`workspace` 新增資料夾不用,重新整理網頁就好。

### 4. 登入並問一題

- 帳密 **tiptop / tiptop**(`backend\.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`,給別人用之前要改)。
- 專案兩個以上時,輸入框旁有專案選單;選他的專案問一題,收到回答就算裝好了。
- 回「無法啟動 claude CLI」:這台的 `claude` 沒裝或不在 PATH(見 `backend\.env` 的 `CLAUDE_BIN`)。
