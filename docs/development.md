# 開發

改程式之前的慣例、本機示範站,以及前端的介面慣例。架構說明在 [architecture.md](architecture.md)。

## 本機示範站


`.claude/launch.json` 裡有幾組可以直接起的設定(說明在各自的 `_comment`):

| 名稱 | 用途 |
|---|---|
| `backend` + `frontend` | 一般開發(8123 / 5173) |
| `backend-demo` + `frontend-demo` | SSH 終端機與 Work Flow 的示範:同一個行程裡跑假 sshd + 服務(8124 / 5174,暫存 SQLite、MFA 關) |
| `backend-demo-build` | 同 `backend-demo`,但另一組埠(8134 / 假 sshd 2232),直接服務 `frontend/dist`(先 `npm run build`),對著正式 build 驗畫面時用 |
| `backend-notes-demo` + `frontend-notes-demo` | 個人筆記的示範(8126 / 5176) |
| `frontend-dist` | 跑 `frontend/dist` 的 vite preview;量效能、驗 CSS 都要用正式 build |

示範用的 `dev_*_demo.py` 開頭寫死了示範帳密,只給本機看畫面用,不要部署。

## 寫文件與註解的慣例


**程式碼註解與文件只寫現況與理由,不寫沿革。**「以前寫成 X」「某次改的」這類敘述屬於
git log —— 留在檔案裡只會讓讀的人分不清哪一句是現在的規則。判準:拿掉這句之後,
還說得出「現在該怎麼做」嗎?說得出就拿掉。

`deploy/workdirs/**/CLAUDE.md`、`RULES-web-context.md` 是**模型每一題都會載入的檔案**,
那裡的每個字都要付 token,而且會影響回答,要寫得更省。

## 前端的視覺與互動慣例


> 樣式一律以 `frontend/.claude/CLAUDE.md` 為準。這一節記的是**為什麼**,跟用哪套 CSS 無關。

- **小夥伴的「位移」與「身體動作」分兩層**(`pet/usePetWander.ts`:`moveRef` 在最外層只管位移,
  `bodyRef` 在角色那層管跳、傾斜、壓扁)。氣泡在位移層裡面、角色層外面 —— 所以氣泡會跟著走,
  但字不會跟著歪、跟著轉。細節見 `pet-companion-kit/SPEC.md`。
- **對話串裡「誰講的」靠左右分邊 + 發話者小標**:自己的提問靠右、別人的靠左
  (`HistoryItem.asked_by` 對比登入帳號,沒有 `asked_by` 的退回 `owner`),泡泡下方掛
  「頭貼 + 帳號名」。別人的一定掛;**自己的只在對話裡有第二個發問者時才掛** ——
  自問自答的對話每題都標自己名字只是噪音。AI 的回答維持靠左 + Logo 頭貼,不在此列。
- **遮罩色用設計系統的 overlay token**(`--color-overlay`),不要在元件裡寫死色碼。
  深色模式的遮罩比淺色更深,寫死色碼兩邊會一樣。
- **浮層是有層級的,Esc 一次只關最上面那層。** Dialog 的鍵盤處理掛在 document
  捕獲階段,誰都搶不過它 —— 所以它自己讓:**焦點在自己 panel 外面(而且不在 body)
  就整個不動作**,Esc 和 Tab 都交給上面那層(例如檔案區裡打開的燈箱 `FileLightbox`)。
  上層關閉時把焦點還回來,下層就恢復。疊浮層時記得:上層要在掛載時 focus 自己、
  卸載時還焦點,不然下層的讓位判斷不成立。
- **點縮圖/檔名 = 頁內燈箱預覽,不是下載、也不開新分頁**(`FileLightbox`:左右切換、
  底部縮圖列、Esc 關閉)。下載永遠是獨立按鈕。保留 `<a href>` 讓中鍵照樣能開新分頁。
  四條路各自不同(判斷集中在 `lib/filekind.ts`):

  | 類型 | 怎麼顯示 |
  |---|---|
  | 圖片 | `<img>` 直接放 |
  | PDF | `<iframe>` 交給瀏覽器內建檢視器。**不能帶 `sandbox`** —— Chrome 不在沙箱裡開 PDF;安全靠後端的 inline 白名單與 nosniff |
  | Word / Excel / PowerPoint | 後端 `GET /api/preview/{files\|uploads}/{sid}/{檔名}` 用 `extract_text` 抽成純文字(**跟上傳時餵給 claude 的是同一份實作**,不要另外寫一份平行的解析);抽不出來回 415 |
  | 其餘(程式碼、txt、md、html…) | fetch 原檔,以 `<pre>{文字}</pre>` 渲染(React 會轉義,不會被當成 HTML 執行),太長會截斷 |

  壓縮檔、執行檔、影音只能下載。`lib/filekind.ts` 用**排除法**判斷(不是圖片、也不在二進位副檔名
  清單裡就當文字):各種語言與工具的副檔名,正面列舉一定會漏,而漏掉的症狀是「這個檔為什麼不能看」。
  漏判的保險在燈箱裡:內容含 NUL 或大量無法解碼的位元組時直說「這不是純文字,請下載」。

  > ⚠️ **「燈箱看得了」跟「可以讓瀏覽器直接開」是兩件事,名單刻意不同。**
  > 燈箱把 html 當原始碼顯示,安全;但同一個檔案若讓瀏覽器**導覽**過去
  > (中鍵開新分頁、`?inline=1`)就會被當文件執行,而前端跟 API 同一個 origin
  > —— 同事上傳的 html 就能拿到登入身分。所以後端 `routers/files.py` 的 `_INLINE_OK`
  > 維持保守(html/xml/svg 不放行),放寬它之前先問:「這個格式被瀏覽器當文件打開,
  > 會不會執行裡面的東西?」
- **掛在小圖示上的 hover 浮層要用 fixed + portal 自己畫。** `absolute` 掛在觸發元素上的浮層,
  收縮寬度是照**定位容器**算的 —— 觸發元素是 12px 的圖示,整段文字就被擠成一行兩三個字;
  而側邊欄清單是 `overflow-y-auto`,水平方向一併被裁,圖示靠邊時浮層直接看不到。
  多行內容一行一項 + `whitespace-nowrap`,不要讓它自己找地方斷。
- **動畫要尊重系統設定**:CSS 端有一段 `@media (prefers-reduced-motion: reduce)`
  會把 transition/animation 全部關掉;用 JS 量高度或自己補間的動畫(accordion 展開、
  「回到最新」的捲動、數字滾動、小夥伴散步)繞得過 CSS,那些地方要另外用 `useReducedMotion()`
  直接跳到最終狀態。
- **共用元件用 Astryx 的**(`@astryxdesign/core`),不要在頁面裡重刻 ——
  尤其是彈窗跟選單,焦點管理很容易漏掉。
- **每個可互動元素都要有名字**:純圖示的按鈕一定要補 `aria-label`(`title` 不夠,
  螢幕報讀軟體跟自動化測試都讀不到);輸入欄位要有 `<label>` 或 `aria-label`,
  只給 placeholder 不算。
