# CLAUDE

Project-specific guidance for AI coding agents.

<!-- ASTRYX:START -->
Astryx v0.4.4 · 158 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing, page frame included.
- Frame first: read `astryx docs layout` before writing any page or screen — page frame, region widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (This project does have the StyleX compiler — see 「這個專案的例外與慣例」 below; no Tailwind.)
- Tokens for every value (`astryx docs tokens`). Brand/accent belongs in the theme (`astryx theme list` / `theme add <slug>`, or `astryx theme template` for a custom one) — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   158 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->

<!-- 專案補充(不在 ASTRYX 產生的區塊裡,重跑 astryx init 不會被蓋掉) -->

## ⚠️ 先讀這個

程式註解記著不少**刻意偏離設計系統的決定**。動前端程式碼之前先讀該檔開頭的註解,
不要把刻意保留的決定改回去(例如小夥伴的拖曳門檻跟對話列的長按拖曳是**兩種手勢**,不要合)。

## 這個專案的例外與慣例

- **這裡有 StyleX 編譯器**:`vite.config.ts` 掛了 `astryxStylex()`(@astryxdesign/build/vite),
  所以 `xstyle` + `stylex.create()` + `stylex.keyframes()` 都可以用,而且是首選寫法。
  沒有 Tailwind,不要用 utility class。
- **佈景用出廠的 `@astryxdesign/theme-neutral`,不做任何客製**。
  沒有自己的 theme 檔;要調外觀照上面 ASTRYX 的規則走 theme,不要自己覆寫 token。
- **「必須保留的行為」寫在各檔開頭的註解裡**,寫 UI 前先讀 —— 那些規則用哪套 UI 都要成立。
- **圖表只有 recharts 一套**。用量頁 `/stats` 整頁照
  Astryx 的 `dashboard`(Analytics Dashboard)模板套用,而模板用的就是 recharts
  (`components/TrendChart.tsx`、`MetricCard.tsx`、`ShareBarCard.tsx`)。
  顏色在 `components/dashboardChart.ts` —— **唯一一處寫死的圖表色票**
  (不是全專案唯一寫死色碼的地方,`terminal/ansi-palette.ts`、Bloub 的身體色票 `pet/bloub/skins.ts`(設定頁的色點 `components/CompanionLook.tsx` 也用它;調色盤的色相環與漸層 `components/BlobPalette.tsx`、`CompanionLook` 的 `ring`)等處另有記錄),
  來源是模板自己的 `var(--color-data-categorical-*, #hex)`,而
  `theme-neutral` 沒有那組 token,所以實際生效的一律是 fallback。動它之前讀那個檔的開頭。
  要畫新的圖就用 recharts,不要再裝第二套圖表引擎。
- **個人筆記的編輯器是 Tiptap**(`components/notes/`)。
  版本**釘死 3.31.3**,`@tiptap/*` 每一包要同一版,不要只升其中一包。
  內文樣式在 `styles/note-editor.css` —— **刻意的例外**:編輯器裡的標題、清單、表格是 ProseMirror 自己長的 DOM,
  StyleX 碰不到;值一律用 token,選擇器一律 `.note-editor` 開頭(`.note-editor-content`、`-image`)。
  ⚠️ 那個檔**只能在 `main.tsx` 匯入**:放在筆記頁那一包(lazy)裡,正式 build 會把全站 StyleX 樣式一起搬進 `Notes-*.css`,
  沒開過筆記頁的人整站沒樣式(dev 看不出來,只有正式 build 會壞)。
  升版或換寫法之前先跑 `components/notes/__tests__/noteMarkdown.test.tsx`(Markdown 進出不改壞、打開不改寫)。
  筆記不支援分享、共編、留言、封面、全寬;刪除是軟刪除(`deleted_at`)、30 天後清除,前端沒有垃圾桶畫面;
  不要裝 Yjs 或 `@tiptap/extension-collaboration` 那一系列。
  留言標記 `CommentMark` 刻意留在編輯器的擴充裡:帶留言標記的內容讀進來才不會掉字,畫出來是普通的字。
  **不要裝 `@tiptap/extension-drag-handle`**:它要整套協作套件才跑得起來,區塊把手是自己寫的(`components/notes/BlockHandle.tsx`)。
  ⚠️ **唯一不是 `.note-editor` 開頭的選擇器**:`note-editor.css` 最後那條 `[role='menu'][data-testid='note-turn-into']`。
  區塊選單「轉換成」子選單掛在 body、Astryx 寫死最高 300px,而那一層只開放 `menuDataTestId` —— 只能這樣蓋;
  值 520px 跟 `slashCommand.tsx` 的 `MENU_MAX_HEIGHT` 同一個,改一個要改另一個。不要再新增這種選擇器。
  節點外觀裡有幾個**沒有框的原生輸入**(大標題、圖片說明、資料庫的格子 `note-db-input`):Astryx 的輸入框都有框,
  一格一格框起來太吵 —— 跟大標題同一個理由的刻意例外,樣式一樣只用 token。
- **圖一律 `aria-hidden` + 配一份文字等價物。**
  recharts 沒有元件幫忙做,要自己補。等價物給到什麼程度看它是主資料還是補充:
  - **主資料的圖配整份 sr-only 表格**,每一格都要讀得到(見 `TrendChart.tsx` 的
    `VisuallyHidden` + `Table`)。
  - **sparkline 配一句摘要就好**(幾格 / 最低 / 最高 / 最後,見 `MetricCard.tsx`)。
    它旁邊那個大數字本身就念得出來,四張卡各掛一份 24 列的表格只是噪音。
  ⚠️ **「補充」不等於「可以不給」**:`avg_duration_by_period` / `logins_by_period` 兩條序列
  全站只有 sparkline 這個出口,只掛 `aria-hidden` 的話報讀程式完全讀不到。
- **介面語言是英文**(Astryx 內建字串只有 en/fr-FR,全站講英文就不必自己維護 catalog)。
  畫面上看得到的字串一律英文;程式碼註解用中文。
  **下面幾類是刻意的例外,不要改回英文**:
  1. **四個管理頁的「內容」是中文**:用量統計(/stats)、題目明細
     (/stats/questions,`Questions.tsx`)、安全(/security)、帳號管理(/users),
     含它們共用的 `LoadError`、`AdminPage`、`AsyncSection`。
     ⚠️ **側邊欄那幾條連結是英文**(Usage / Security / Users),進去之後的內容才是中文。
     **側邊欄不要翻**(見 `Sidebar.tsx` 的 `ADMIN_LINKS`)。
     ⚠️ **例外的例外:新增帳號時「帳號名稱格式不對」那句是英文**(`Users.tsx` 的 `USERNAME_RULE`)。
     同一格的 description(「只能用英數字…」)仍是中文。
  2. **小夥伴的台詞是中文**:`src/lib/petSetup.tsx`(名字「小夥伴」、停止狀態的
     「已停止」)、`src/lib/sharedWatch.ts`(「有人分享了一組對話給你」那幾句)
     與 `src/lib/usageLimit.ts`(答完之後那句「本次耗用 … 剩餘 … 後重置」)。
     標點用全形,跟 kit 的「完成了!」同一套。
     跟 kit 預設台詞同一個腔,不要翻成英文。
  3. **SSH 終端機頁 `/ssh` 的內容是中文**(`pages/Terminal.tsx`、`components/terminal/*`):
     頁名「SSH 終端機」、檔案欄、Banner 的斷線原因、刪除確認。側邊欄那一列 `SSH Server` 照慣例是英文。
     ⚠️ **例外的例外:`HostStage` 的 `status`(Connecting to… / Connected to… / Idle)是英文** ——
     這行只給報讀程式(畫面上只有 Spinner / 綠點),跟主機名一樣用英文。終端機、檔案欄、刪除確認仍然是中文。
     斷線原因那幾句**後端也有一份**(`app/terminal.py` 的 `CLOSE_REASONS`,原因 → (關閉碼, 中文)
     的唯一一張表),兩邊要同一個腔 —— `network` / `exit` / `idle` 那幾句要**逐字相同**,
     後端的 `test_close_messages_match_the_frontend_word_for_word` 會讀前端原始碼對。
  4. **「有新版本 / 重新整理」那則 toast 是中文**:`components/UpdateWatcher.tsx`
     (上版之後舊分頁自己換到新版,見 `lib/appVersion.ts`)。
     ⚠️ 這是唯一一則中文的**全站** toast —— 旁邊 `lib/toast.ts` 的其他呼叫端
     (`Answer copied.`、`Could not …`)仍然全是英文,不要跟著一起翻。
  5. **個人筆記頁 `/notes` 的內容是中文**(`pages/Notes.tsx`):狀態字、刪除確認。側邊欄那一列 `Notes` 是英文;
     ⚠️ **例外的例外:筆記頁左邊那一欄是英文**(跟主側邊欄一樣)—— 標題 Notes、Search、
     右鍵選單(Rename / Add page inside / Duplicate / 圖示與顏色兩排 / Delete;兩排跟主側欄資料夾同一套,顏色畫成列右邊的點)、沒標題的頁寫 Untitled(`listTitle`)、
     收起 / 打開清單的鈕(Collapse list / Expand list;收起來時 Expand list 畫在內文頁的標題列上,它仍屬於清單,英文)、
     從清單觸發的 toast(刪除的 Deleted "…" + Undo、各種失敗;頁面 ⋯ 的刪除 / 複製走同一支,也是英文)、一頁都沒有時的 No notes yet。
     右邊內文那一頁(大標題、「編輯於…」、「↗ 回到上次對話」、⋯ 選單、模板、存檔狀態)仍是中文;
     **對話頁裡存筆記的那幾個字也是英文**(`components/SaveToNotes.tsx`:`Save to notes`、`Question and answer`、
     `Screenshot`、toast `Saved to notes.` / `Open`)—— 對話頁照全站慣例。⚠️ 筆記頁裡兩個分頁同時改的那則 toast
     (`lib/noteDraft.ts`)是中文,它出現在筆記頁上。
  6. **Work Flow 頁 `/workflow` 的內容是中文**(`pages/Workflow.tsx`、`components/workflow/*`):
     拼圖名稱、出口(成功 / 失敗)、執行紀錄都是中文。側邊欄那一列 `Work Flow` 是英文。拼圖名稱**後端也有一份**
     (`app/workflows.py` 的 `LABELS` / `OUTS`),畫面上用的是後端 `/catalog` 給的那一份。
     這一頁是可選功能:部署的人沒放 `backend/workflow_actions.json` 就整個不出現(`/api/me` 的 `workflow_enabled`)。

## 跑測試

```bash
npm run test        # vitest,預設環境是 node
```

**預設環境是 `node`,不是 jsdom** —— `lib/` 底下那些純函式測試不需要 DOM,
給了只是變慢。需要 DOM 的檔案自己在**第一行**寫 `// @vitest-environment jsdom`
(例如 `components/__tests__/PersonDisplay.test.tsx`;現在有哪些用
`grep -rl "@vitest-environment jsdom" src` 查,不要照這裡的清單)。

⚠️ **元件測試不要 import `pages/Chat.tsx`。** 那個檔案很大、連著整組元件的
StyleX transform,在 jsdom 裡光是 import 就會讓 vitest 的 worker 逾時。
要測的東西先抽成自己的模組 —— `components/PersonDisplay.tsx`
就是為了這件事抽出來的。

⚠️ **`@testing-library` 的自動清理不會跑**,因為這個專案沒有開 vitest 的
`globals`。每個會 render 的測試檔都要自己 `afterEach(cleanup)` ——
不清的話上一條的浮層留在 `document.body`,下一條抓到的是上一條那張卡,
症狀是「有些條莫名其妙地過、有些條報一個像是元件壞了的錯」。

⚠️ **`npm run build` 之後第一次跑測試可能會怪怪的**,因為 vite 的 dep 快取被
動過。兩種症狀,**第二種很危險**:

1. worker 啟動逾時(`Timeout waiting for worker to respond`,而且
   transform/import 都是 0ms)—— 一看就知道有問題;
2. **安靜地少收一個測試檔,然後回報成功**(例如跑出 `9 passed` 而不是 `10`)。

所以**看到的數字要跟預期對得起來**:測試檔數用 `grep -rlE "^\s*(it|test)\(" src | wc -l` 之類的方式自己算,
條數對照上一次**完整跑過**的總數。新增或刪掉測試時要**實際跑一次看總數**,不要照著上一版的數字加減。
某個測試檔在測什麼,看那個檔案本身。
少了就是**還沒跑完**,不要當作「通過了」——怎麼救看下面那兩步(⚠️ 第一步不是清快取)。

⚠️ 最容易被丟掉的是最肥、import 最慢的那幾檔(例如 `components/__tests__/PersonDisplay.test.tsx`),
但**不保證只少那一檔**:dev server 與後端都開著時可能一次少好幾檔、一樣回報全過,整批重跑就回到滿數。少多少都一樣處理。

**照這個順序試:**

1. **先整批重跑一次** —— 有時候第二次就收得到。
2. **還是少就 `rm -rf node_modules/.vite` 再跑** —— 有時連跑兩次都少,清掉快取才回到滿數。

兩種都可能有效,不要因為其中一種有效過就跳過另一種。

🚨 **`rm -rf node_modules/.vite` 之前一定要先停掉 dev server。**

那是 Vite 的**依賴預先打包快取**,跑著的 dev server 正握著它。在它跑的時候刪掉,
server 不會當掉、也不會報錯,而是開始對每一個動態 import 回
**`504 (Outdated Optimize Dep)`** —— 症狀是所有 lazy 載入的頁面(`/users`、`/stats`、
`/security`、`/stats/questions`)全部變成「This page stopped working」,
而首頁與對話頁看起來好好的。

⚠️ **這個症狀騙人的地方**:`npm run build` 與 `npm test` **照樣全過**,
因為壞掉的只有那個被弄髒的 dev server 行程,原始碼一個字都沒問題。
主控台還會混進一堆 HMR 熱替換到一半留下的 `xxx is not defined`(都是剛被改名或
刪掉的舊識別字),很容易誤判成「剛才那個改動把東西改壞了」。

**修法:重啟 dev server,不要改任何程式碼。**
