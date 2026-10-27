# 小夥伴(PetCompanion)規格書

來源:「問我問我(AskME)」frontend。正本是 `frontend/src/pet/`,這份規格書寫的是它的行為契約。

---

## 目錄

1. [定位與設計原則](#1-定位與設計原則)
2. [檔案清單與責任分工](#2-檔案清單與責任分工)
3. [執行環境與相依](#3-執行環境與相依)
4. [接線契約](#4-接線契約)
5. [狀態機](#5-狀態機)
6. [說話氣泡](#6-說話氣泡)
7. [互動:戳、拖、開關](#7-互動戳拖開關)
8. [版面與視覺規格](#8-版面與視覺規格)
9. [動畫規格](#9-動畫規格)
10. [素材規格](#10-素材規格)
11. [無障礙](#11-無障礙)
12. [必須保留的行為](#12-必須保留的行為)
13. [客製化](#13-客製化)
14. [不做的事](#14-不做的事)
15. [驗收清單](#15-驗收清單)

---

## 1. 定位與設計原則

### 它要解決的問題

一件跨模組的工作跑 3~15 分鐘。中間系統去翻檔案那幾十秒,畫面幾乎是靜止的 ——
使用者不知道它是在做事還是卡死了,於是每隔一分鐘就重新整理一次,或是乾脆再送一次。

進度條、時間軸、邊框光解決的是**資訊**(它現在在做什麼)。
小夥伴解決的是**存在感**:餘光掃過去就知道「它還活著」,不用把視線移過去讀字。

### 四條不可以退讓的原則

1. **每個狀態都對應一個真實訊號,不做隨機的狀態或台詞。**
   這是它跟「裝飾用寵物」唯一的差別。一旦開始亂動,它就從指示器變成干擾,
   而且使用者從此不再相信它的動作有意義。(閒著時散步的路線是隨機挑點,
   但「在散步」本身就是「沒事」這個訊號。)

2. **幅度小、速度慢。**
   這是每天用八小時的工作工具。會動的東西一大就變干擾 ——
   所有疊加動畫的位移都在 ±4px 上下,散步也是小步、慢慢走。

3. **不新增後端欄位。**
   用的訊號(排隊中、進行中、成功、失敗、用了什麼工具)本來就都在,
   時間軸也在用同一組。加欄位就代表這個功能有維護成本,那它撐不過第一次改版。

4. **關得掉,而且叫得回來。**
   有人就是不喜歡畫面上有東西在動。開關必須存在,而且入口不能只長在小夥伴身上。

---

## 2. 檔案清單與責任分工

路徑相對於 `frontend/src/pet/`(正本位置見 [README](README.md));
最後四列不在那個資料夾底下,見 README 的複製清單。

| 檔案 | 責任 | 什麼時候要改它 |
| --- | --- | --- |
| `PetCompanion.tsx` | 狀態推導、互動、拖曳、版面、無障礙 | 幾乎不用改 |
| `index.ts` | 對外入口:元件、兩個 configure、`petSay`、開關/位置函式、時間常數 | 增減對外 API 時 |
| `pet-sprites.ts` | 圖、台詞、時間門檻、開關/位置的存取、氣泡高度 | 換角色、換台詞、調時間 |
| `petSource.ts` | 訊號來源介面 + 全域設定 | 接線時(必改) |
| `petSpeech.ts` | `petSay()` 事件通道 | 幾乎不用改 |
| `petWander.ts` / `usePetWander.ts` | 閒著時的散步:路線與走法 / 每一格寫 DOM | 調散步手感 |
| `BloubAvatar.tsx`、`bloub/`、`bloubMap.ts` | 第二個角色 bloub(程式繪製、會變形的一團;`bloub/` 是 MIT 授權的引擎,見 `bloub/LICENSE`)與它的狀態對應 | 調 bloub 的表情 |
| `motionTokens.ts` | 從設計系統的 CSS token 讀動畫時間與曲線 | 換設計系統時 |
| `tooltip-panel.ts` | 氣泡外觀 + 跟著滑鼠晃 | 換配色 |
| `useReducedMotion.ts` | 系統動畫偏好(內含一個通用的 `useMediaQuery`) | 幾乎不用改 |
| `cn.ts` | class 合併 | 你有同名函式就刪掉 |
| `讀我.txt` | 角色圖放在哪、授權上要注意什麼 | 換整組圖時 |
| `frontend/src/styles/pet.css` | 5 組狀態 keyframes(sleep / wait / work / cheer / sad)+ 減少動態時關掉 | 調動畫手感 |
| `frontend/public/pet/` | 17 張 GIF | 換角色 |
| `frontend/src/lib/pointerOwner.ts` | 拖曳的多點觸控保護(`PetCompanion.tsx` import 它) | 幾乎不用改 |
| `frontend/src/lib/transitionMs.ts` | 把 CSS 的時間 token 換成毫秒(`motionTokens.ts` import 它) | 幾乎不用改 |

⚠️ 最後兩支是 `src/pet/` **唯二 import 宿主的檔案**。整包搬走時要一起帶走(或換成你自己的等價實作)。

`useReducedMotion.ts` 裡的 `useMediaQuery` 是**刻意的重複**:kit 要能整包複製走,
所以自己帶一份。本專案另外有一份
`frontend/src/lib/media.ts`(側邊欄的手機斷點在用),兩份行為一樣、刻意並存 ——
動其中一份就把另一份一起看過。搬到別的專案時如果不介意多這一份,就照樣留著;
要合併的話刪掉這個檔案改 import 自己的即可。

**分層原則**:`PetCompanion.tsx` 不知道圖長什麼樣(問 `pet-sprites`),
也不知道資料哪來(問 `petSource`)。換圖與接線都不需要碰邏輯。

---

## 3. 執行環境與相依

### 必要

| 套件 | 版本 | 用在哪 |
| --- | --- | --- |
| `react` | 18+(本專案用 19) | 元件 |
| `framer-motion` | 11+(本專案用 13) | 氣泡進退場、跟著滑鼠晃的彈簧 |

### 可換掉的

| 套件 | 用在哪 | 不想裝的話 |
| --- | --- | --- |
| `clsx` | `cn()` | 換成任何 class 合併函式 |
| Tailwind CSS v4 | 元件裡的排版 class | 見下方(本專案就沒有,走的是墊片那條) |

### 關於 Tailwind

**動畫(`pet.css`)是純 CSS,不需要 Tailwind。**
需要 Tailwind 的只有元件裡的排版 class(`fixed`、`size-36`、`bottom-28` 那些)。

用到的色彩 token(shadcn 那一套):

| Token | 用在哪 | 沒有的話 |
| --- | --- | --- |
| `--foreground` / `--background` | 氣泡的深底白字 | 改 `TOOLTIP_PANEL_CLASS` |
| `--ring` | 鍵盤焦點框 | 改按鈕的 `focus-visible:ring-ring` |
| `--muted` | 退回替代圖示時的圓形底 | 改按鈕的 `bg-muted/60` |

沒有 Tailwind 的專案有**兩條路,都可以**,差別在代價落在哪:

| | A:另寫一份墊片 CSS | B:改元件的 `className` |
| --- | --- | --- |
| 做什麼 | kit 用到的那幾十個工具類,用你自己的 token 各實作一條 | 把 `PetCompanion.tsx` 的 `className` 換成你自己的樣式,**邏輯完全不用碰** |
| 代價 | 多一個檔案要跟著 kit 的 `className` 走。kit 改版多用了一個類、墊片沒補,**不會報錯**,只會版面歪掉 | `PetCompanion.tsx` 從此分岔,kit 改版不能直接覆蓋,得手動合 |
| 適合 | 想繼續跟著 kit 升級 | 不打算再升級,或版面本來就要照自己的設計大改 |

**本專案走的是 A**:`frontend/src/styles/pet-shim.css` 用 Astryx token 把 kit 用到的
工具類手工實作一份。所以在這個 repo 裡不要把 `className` 換成別的寫法 —— 換了的話 shim 整份變成死碼,
而且兩邊會各自漂移;`PetCompanion.tsx` 新用到一個工具類時,要在 `pet-shim.css` 補一條。

⚠️ 走 A 的人要自己顧**排版限制**(第 8 節):144px 顯示框、`fixed` 定位、
`bottom-28 right-4`、`hidden md:block`。少實作一條就等於少一個行為,
而且是沉默地少 —— 症狀是「小夥伴會動,但不在該在的位置」。

### 瀏覽器

- Pointer Events(`setPointerCapture`)—— 拖曳用,IE 以外都有。
- `matchMedia` + `prefers-reduced-motion`。
- `localStorage`。
- **手機不渲染**:本專案的斷點是 `(max-width: 768px)`(`frontend/src/lib/media.ts`
  的 `MOBILE_QUERY`)—— 768px 含在內算手機,769px 起才顯示。判斷放在
  `frontend/src/App.tsx` 的掛載處(`{!isMobile && <PetCompanion … />}`),
  不是元件內部:只有這樣 lazy chunk(含 framer-motion)在手機上才根本不會下載,
  元件裡的閒置偵測、10 秒一次的計時器與 GIF 的 `<img src>` 也都不會起跑。
  kit 自己 `className` 上的 `hidden md:block`(`min-width: 768px`)是第二道,
  兩條在 768px 那一格會同時成立,**以掛載處那條為準**。

---

## 4. 接線契約

### 4.1 `PetSource` —— 三個問題

```ts
interface PetSource {
  getCurrentTask(): PetTask | undefined;
  getActiveCount(): number;
  subscribe(cb: () => void): () => void;
}
```

| 方法 | 要回什麼 | 常見錯誤 |
| --- | --- | --- |
| `getCurrentTask` | **使用者現在看的這一頁**對應的那一件;這一頁沒事就回 `undefined` | 回「最新的那一件」→ 切到別頁時牠不會顯示 `background`,分不出「我這頁沒事」跟「全站沒事」。這一頁沒事卻回別的東西(例如自己合成的提示工作)也一樣 —— 見 5.2 下方的接線注意 |
| `getActiveCount` | 全站**還在跑**的件數(不含已完成) | 把剛完成的也算進去 → 結束後那 4 秒被誤判成「還有事在跑」 |
| `subscribe` | 有變化就呼叫 cb,回傳退訂函式 | 只在自己這頁有變化時通知 → 別頁開始跑時牠不會醒 |

⚠️ `getCurrentTask` **在送出的那一瞬間就要查得到**。
常見的錯法:用網址算 key,但送出新對話時網址還沒更新,
自己剛送出的那一題查不到 → 被判成 `background`,又被換圖節流鎖住 1.2 秒,使用者一定看得到。

解法是資料層多一條退路:網址查不到時,**剛送出**(`JUST_SENT_MS`,本專案取 4 秒)
的那一件也算這一頁的。程式在 `frontend/src/lib/petSetup.tsx`,節錄在
`examples/2-本專案的接法.ts`。

⚠️ 這條退路有一個**刻意留著的誤判**:它分不出「這一頁剛送出」與「別頁剛送出」。
在 A 頁送出後 4 秒內切到 B 頁,B 頁會把 A 那件當成自己的 —— 該顯示 `background`
的那 4 秒顯示成進行中。要擋掉就得在送出路徑上標記來源,而那 4 秒剛好是使用者最
可能盯著小夥伴看的 4 秒,所以取捨成「寧可切走的那頁多顯示,也不要自己剛送出的
那一題被顯示成別人的」。

### 4.2 `PetTask` —— 一件工作長什麼樣

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `id` | `string \| number` | ✅ | 這一件的識別碼。**生命週期內不可以變** —— 結束時的表情靠它去重,會變就會重複觸發 |
| `startedAt` | `number` | ✅ | `Date.now()`。用來判斷「跑很久了」 |
| `done` | `boolean` | ✅ | 跑完了沒 |
| `success` | `boolean` | ✅ | `done` 之後才有意義 |
| `queued` | `boolean` | | 還在排隊,還沒真的開始 |
| `uploading` | `boolean` | | 正在上傳附件 |
| `notices` | `string[]` | | 伺服器的提醒。有東西就蓋過動作狀態 |
| `latestTool` | `"read" \| "search" \| "run" \| "other"` | | 最近一次用的工具 |
| `streaming` | `boolean` | | 已經開始吐字。優先於 `latestTool` |
| `error` | `string \| null` | | 失敗訊息。用來分辨「失敗」與「使用者按停止」 |

**工具只分四類是刻意的** —— 圖只有這幾張,而使用者要的是粗略手感,不是工具名稱的忠實轉播。
你的後端工具集之後變了也不用改這裡,對應不到就給 `"other"`(顯示 `thinking`)。

**完成的那一件要在來源裡留幾秒**(建議 5 秒,`TRANSIENT_MS` 是 4 秒)。
立刻從 map 裡刪掉的話,小夥伴根本來不及看到 `done=true`,使用者不會知道成功了沒。

### 4.3 `PetConfig` —— 可調的東西

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `name` | `"小夥伴"` | 只出現在無障礙標籤 |
| `capacity` | `3` | 幾件同時在跑算滿載。到達用 `busy3` 的圖,少一件用 `busy2` |
| `storagePrefix` | `"pet"` | localStorage key 前綴(`{prefix}_hidden` / `{prefix}_pos`) |
| `fallbackIcon` | 內建 SVG | 圖載不到時顯示什麼 |
| `renderLink` | `<a href>` | 有 router 的話**一定要給**,不然點氣泡會整頁重載 |
| `isStoppedByUser` | `error?.startsWith("已停止")` | 拿到 `PetTask.error`,回 true 就給 `stopped` 而不是 `sad` |
| `spriteOverrides` | — | 只覆蓋指定狀態的 `src` / `hint` |
| `useBlob` | 永遠畫圖 | **一支 hook**,回 true 就改畫 bloub 而不是圖。每次重繪都呼叫,要傳穩定的函式 |
| `useBlobLook` | 圓形 + 跟著佈景 | **一支 hook**,回 bloub 的身體形狀與顏色(色票 id 或 `#rrggbb`) |

`configurePet()` 與 `configurePetSource()` 都是**模組層級的全域設定**,
要在 `<PetCompanion />` 掛上去之前呼叫(通常放在 app 進入點的最上面)。

---

## 5. 狀態機

### 5.1 全部 19 個狀態

| 狀態 | 觸發條件 | 預設圖 | 預設台詞 |
| --- | --- | --- | --- |
| `walking` | 沒事,使用者還在動 | `idle.gif` | 閒晃中,有問題就問 |
| `sleeping` | 沒事,而且閒置 > 60 秒 | `sleeping.gif` | 在打盹,有事再叫我 |
| `queued` | `task.queued` | `thinking.gif` | 排隊中,還沒輪到我們 |
| `uploading` | `task.uploading` | `carrying.gif` | 正在上傳你的檔案 |
| `busy3` | `activeCount >= capacity` | `juggling.gif` | 同時跑滿了,主機滿載 |
| `busy2` | `activeCount === 2` | `headphones-groove.gif` | 同時在跑 2 件 |
| `notice` | `task.notices` 非空 | `notification.gif` | 有一則提醒,看一下訊息 |
| `grinding` | 跑超過 5 分鐘 | `sweeping.gif` | 這件比較久,還在處理 |
| `writing` | `task.streaming` | `typing.gif` | 正在寫回答 |
| `reading` | `latestTool = "read"` | `idle-reading.gif` | 正在讀資料 |
| `searching` | `latestTool = "search"` | `debugger.gif` | 正在搜尋相關檔案 |
| `running` | `latestTool = "run"` | `building.gif` | 正在執行指令 |
| `thinking` | 進行中但沒有以上任何訊號 | `thinking.gif` | 正在想從哪裡查起 |
| `background` | 這頁沒事(`getCurrentTask` 回 `undefined`),但別處還在跑 | `bubble.gif` | 另一件事還在跑 |
| `happy` | 剛成功(4 秒) | `happy.gif` | 完成了! |
| `stopped` | 剛被使用者按停止(4 秒) | `react-annoyed.gif` | 被你按停了 |
| `sad` | 剛失敗(4 秒) | `error.gif` | 這件失敗了,可以重試 |
| `poked` | 使用者點一下(1.4 秒) | `react-double-jump.gif` | 欸! |
| `annoyed` | 3 秒內點 4 下(1.4 秒) | `react-annoyed.gif` | 好啦好啦,別戳了 |

### 5.2 推導優先序

```
進行中(task 存在且 !done):
  queued
    → uploading
      → busy3 (activeCount >= capacity)
        → busy2 (activeCount === 2)
          → notice (notices 非空)
            → grinding (now - startedAt > 5 分)
              → writing (streaming)
                → reading / searching / running (latestTool)
                  → thinking

非進行中:
  transient (happy / stopped / sad,4 秒)
    → background (activeCount > 0)
      → sleeping (閒置 > 60 秒)
        → walking
```

**為什麼 busy 蓋過工具狀態**:同時兩件以上時,「這張圖代表哪一件的工具」本來就講不清楚。
不如直接告訴人「你手上有幾件在跑」—— 那才是他這時候真正需要知道的事(再來就要排隊了)。

**為什麼 notice 蓋過動作**:附件沒上傳成功這種事,使用者現在就該知道,
不然他會拿到一個「沒看過那個檔案」的結果還不明白為什麼。

### 5.2.1 接線注意:合成的假工作會吃掉整個下半段

`deriveState` 第一行就是「`task` 存在且 `!done`」,所以 `getCurrentTask` 只要回了東西,
下半段那四格(`transient` → `background` → `sleeping` → `walking`)**整段跳過**。

宿主為了做出 kit 沒有的狀態而合成一件假工作是可以的 —— 本專案就用一件「沒在跑、
只帶 `notices`」的假工作做出「有人 @ 我而我還沒讀」,正好落在 `notice` 那一格,
不必去改 kit 的狀態機(`frontend/src/pet/` 要保持可以直接覆蓋升級)。
但那件假工作**只能在全站都沒事的時候餵下去**,不然 `background` 永遠出不來。

本專案接完之後的完整優先序(kit 這九段之外再包一層):

```
這一頁的工作 > background(別頁還在跑) > 未讀 @ > sleeping / walking
```

`background` 排在提示前面的理由:`background` 講的是「別頁**現在**還在跑」,
那件事跑完訊號就沒了;未讀提示會一直在,直到人去讀它,晚幾分鐘輪到不會少講。
反過來讓提示壓住 `background` 的話,只要有一則沒讀,`background` 就永遠出不來。
程式在 `frontend/src/lib/petSetup.tsx` 的 `getCurrentTask`。

⚠️ 那個提示**不靠這個狀態通知使用者** —— 真正會叫住人的是 `petSay()` 的氣泡
(見第 6 節)。狀態圖只是「還有東西沒看」的餘光提示,晚一點出現不會漏訊息。

### 5.3 覆蓋順序(最終顯示什麼)

```
結果狀態(happy / sad / stopped)
  > petSay 指定的表情
    > 戳的反應(poked / annoyed)
      > 推導出來的狀態
```

結果狀態蓋過一切,是因為那一刻使用者要看的是**結果**,不是牠在跳。

### 5.4 節流:`useSettledState`

換圖最短間隔 `MIN_STATE_MS = 1200ms`。

工具切換非常快 —— 一件工作翻五十幾個檔案是常態,讀一下、搜一下、跑個指令都在一兩秒內。
不擋的話小夥伴會在三張圖之間瘋狂閃,**比完全不動還吵**,而且 GIF 每次換 `src`
都會從第一格重播,看起來反而像卡住。

**例外(立刻生效,不等)**:`happy` / `sad` / `sleeping` / `walking`。
這些是「結果」與「進入待機」,慢半拍會讓人以為沒收到。

### 5.5 時間門檻總表

| 常數 | 值 | 意義 |
| --- | --- | --- |
| `MIN_STATE_MS` | 1200ms | 換圖最短間隔 |
| `TRANSIENT_MS` | 4000ms | happy / sad / stopped 顯示多久 |
| `POKE_MS` | 1400ms | 戳的反應持續多久 |
| `ANNOYED_WINDOW_MS` / `ANNOYED_CLICKS` | 3000ms / 4 下 | 「一直戳」的判定 |
| `SLEEP_AFTER_IDLE_MS` | 60000ms | 閒置多久從散步變睡覺 |
| `GRINDING_AFTER_MS` | 5 分鐘 | 跑多久算「久」 |
| `AUTO_SPEECH_MS` | 3500ms | 換狀態時台詞自己冒出來停多久 |
| `SPEECH_MS` | 6000ms | `petSay` 的氣泡停多久 |

`AUTO_SPEECH_MS = 3500` 的理由:狀態最快也要 1.2 秒才換一次,留 3.5 秒讓短命的狀態也讀得完;
真的連換好幾個時,後面那句直接蓋掉前一句。

---

## 6. 說話氣泡

### 兩件不同的事

| | 狀態台詞 | 通報(`petSay`) |
| --- | --- | --- |
| 內容 | 牠**自己在做什麼** | 牠**要告訴你什麼** |
| 來源 | `sprite.hint` | `petSay({ text, state?, href? })` |
| 何時出現 | 換狀態時自動 3.5 秒 / hover / focus | 收到事件時,6 秒 |
| 可否點擊 | 否 | 給了 `href` 就可以 |
| `role` | `tooltip` | `status` |

**只有一個氣泡,內容三選一,通報優先。**
同一隻角色頭上冒出兩種長得不一樣的框,在使用者眼裡就是兩個不同的東西。

### 為什麼通報不用 toast

toast 會跟「送出失敗」那類系統訊息混在同一個通道。
而「有人找你」跟「系統出事」是兩件事 —— 混在一起,重要的那則會被當雜訊滑過去。

### 用法

```ts
petSay({ text: "阿華 @你:這個簽核你熟", state: "happy", href: "/c/abc-123" });
```

事件通道是 `window` 上的 `CustomEvent`,所以**任何地方都能呼叫**,
不需要 React context,也不用把小夥伴的 ref 傳來傳去。

⚠️ 連續多則要**自己錯開**(建議間隔 `SPEECH_MS`),不然後面那則會把前面那則擠掉。

本專案的作法是**一條佇列**:`frontend/src/lib/sharedWatch.ts` 一則一則
`petSay()`,每則之間等 `SPEECH_MS`。
重點是**所有要講的話都走同一條佇列** —— 共用通知與 @ 提及各自 `petSay()` 的話,
同一輪裡兩邊都想講時,後講的會把前一句直接蓋掉(間隔 0 毫秒,
先講那句等於沒出現過)。氣泡只有一個,錯開就得在同一個地方排。

---

## 7. 互動:戳、拖、開關

### 戳

點一下 → `poked`(1.4 秒)。3 秒內點 4 下 → `annoyed`。

留著這個的理由:它**只有在使用者自己去點的時候才出現**,不會在他工作時自己跳出來 ——
跟會自己亂動的裝飾不是同一回事。

### 拖

- 位移超過 **4px** 才算拖;沒超過就是「戳」。
  不分的話,使用者只是想戳一下卻手抖了幾像素,就變成把牠拖走。
- 拖過之後**照樣會散步**,只是起點換成你擺的地方。
  使用者手動擺位置代表「我要牠待在這一區」,不是「我要牠從此站著不動」。
- 位置存 `localStorage`(`{prefix}_pos`),讀取時**夾回目前視窗範圍**。
- 散步方向會自動換:被拖到左邊、左側空間不足 60px(`WALK_MIN_PX`)時改往右走。
  只夾不換方向的話,拖到最左邊會變成距離 0,牠只會原地踏步。
- 拖曳中只寫外層的 transform,放手才把位置交給 React 並存檔 —— 每個 move 都 setState 的話,
  整隻小夥伴(氣泡、bloub)跟著手指一秒重繪幾十次。
- 多點觸控:一次拖曳只認一根主指標,第二根手指不理(`lib/pointerOwner.ts`)。

### 開關與回到原位

| 函式 | 作用 |
| --- | --- |
| `setPetHidden(bool)` / `isPetHidden()` | 顯示/隱藏 |
| `unpinPet()` / `isPetPinned()` | 位置清掉,回右下角 |

寫入時會 `dispatchEvent`(`pet:visibility` / `pet:position`),
小夥伴自己與你的外部入口都訂這個事件 —— **兩邊不會各記一份而對不起來**。

⚠️ 這兩個入口**必須做**,理由見 [README 第 6 步](README.md)。

---

## 8. 版面與視覺規格

### 尺寸

| 項目 | 值 | 為什麼 |
| --- | --- | --- |
| 顯示框 | **144px**(`size-36`) | 這批圖的角色只佔畫布寬度 33~42%,上方近 1/3 是留給道具的空白 —— 框不開大角色就看不清楚 |
| 退回替代圖示 | **64px** 圓形徽章 | 那張是滿版的,不需要留白 |
| 預設位置 | `bottom-28 right-4` | `bottom-28` 是為了避開底部輸入框那一排 |
| 氣泡最大寬 | `max-w-64` | 再寬就變成一段文章,那不是氣泡該做的事 |
| 顯示斷點 | `hidden md:block`(第二道;主要那道在掛載處,見第 3 節) | 手機沒有多餘空間,而且拖曳會跟捲動打架 |

### 氣泡的垂直位置

`pet-sprites.ts` 的 `bubbleDropPx(src)`:氣泡下緣離 144px 顯示框**頂端**往下多少 px,
**一張圖一個值** —— 照那張圖的內容最上緣(`SPRITE_CONTENT_TOP_PX`)再往上留 `BUBBLE_GAP_PX`(16px,
箭頭加空隙)。換圖時氣泡滑過去,不要一格跳。

- 為什麼要往下壓:角色只佔畫布下面一部分,氣泡貼在框上緣的話會浮在角色頭頂上方一大截,
  看起來跟牠沒關係。
- 為什麼不是全部用同一個值:只照最高那張(`happy.gif`)抓一個值的話,最常看到的閒晃圖內容頂端
  低了 50px,氣泡就飄在頭頂上方一大截。
- 認不得的圖(用 `spriteOverrides` 換掉的)退回 `FALLBACK_BUBBLE_DROP_PX`(28px,照最高那張抓的)。
- bloub 不分狀態用同一個高度(`PetCompanion.tsx` 裡的常數)。

### 滑鼠感應區

```
bottom-[8%] left-[17%] right-[20%] top-[34%]
```

對齊角色**實際**佔的位置(逐影格量出來的內容範圍:302×300 的畫布上 (50,103)–(243,275))。

整顆 144px 按鈕都算的話,滑鼠明明在角色頭頂上方的空白處就會被當成「移到牠身上」。

⚠️ **一定要放在按鈕裡面當子元素。** 放外面當兄弟節點的話它蓋在角色上,
滑鼠事件冒泡不到按鈕,**拖曳和點擊會整個失效**。

### DOM 結構(⚠️ 這幾層都不能合併)

```
<div ref={moveRef} class="fixed z-40 hidden md:block …">   ← 外層:位移(散步與拖曳都直接寫它的 transform)
  <div class="relative">
    <div class="absolute left-1/2 z-50 -translate-x-1/2">  ← 氣泡定位(只管擺哪)
      <motion.div>                                         ← 氣泡晃動(framer 寫 inline transform)
    <div ref={bodyRef} class="flex">                       ← 角色層:散步時的跳、傾斜、壓扁、滾動
      <button class="… size-36 [STATE_ANIMATION]">         ← 狀態動畫 pet-sleep/wait/work/…
        <img> 或 <BloubAvatar>
        <span>                                             ← 滑鼠感應區(必須在 button 裡)
```

| 分層 | 合併會怎樣 |
| --- | --- |
| 位移在外層,不在按鈕 | 氣泡與感應區不跟著跑 —— 牠走到旁邊了,滑鼠移到**原本**的位置反而跳出說明 |
| 身體動作只在角色層 | 掛在外層的話氣泡會跟著歪、跟著轉,字讀不了 |
| 狀態動畫在按鈕,身體動作在它的父層 | 按鈕的 transform 已經被 CSS 狀態動畫佔用,inline transform 會跟它打架 |
| 氣泡定位與晃動分兩層 | framer 的 `x`/`rotate` 寫 inline transform,會把 `-translate-x-1/2` 蓋掉(氣泡整個偏到右邊) |

---

## 9. 動畫規格

### 疊在 GIF 上的那一層

GIF 自己已經會動了,這層只負責整體的呼吸/晃動,所以幅度都很小 ——
兩層動畫加起來過頭的話會很吵。

| class | 週期 | 動作 | 用在 |
| --- | --- | --- | --- |
| `pet-sleep` | 3.2s | 上下 2px + 縮 2% | sleeping, reading, grinding |
| `pet-wait` | 1.6s | 左右擺 ±4° | queued, thinking, notice, background, annoyed |
| `pet-work` | 0.9s | 上下 4px + 轉 ±2° | uploading, searching, running, writing, busy2, busy3 |
| `pet-cheer` | 0.7s ×2 | 跳 10px + 放大 8% | happy, poked |
| `pet-sad` | 2s | 下沉 3px + 歪 -8° | sad, stopped |
| (無) | — | — | walking(散步的身體動作在角色層,這裡再套就是兩層動作疊在一起) |

狀態 class 拿掉的那一刻(例如 `pet-sad` 垂著頭、`pet-wait` 搖到一邊時換狀態),CSS transition
不會從動畫中的值起跳,所以由 `PetCompanion.tsx` 的 `useSettleBack` 讀當下的 transform、
用 Web Animations 補回 0,不會「啪」一下回正。

### 散步

閒晃(`walking`)時由 `usePetWander.ts` **每一格直接寫 DOM 的 transform,不經過 React state**
(一秒重繪 60 次只為了移幾 px 太浪費),路線與走法在 `petWander.ts`:
停一陣子 → 挑一個附近的點 → 預備動作 → 移過去(有起步有煞車)→ 穩住。

- **不翻面**:兩個角色都是正面朝向觀眾的,翻面在牠們身上不成立,腳不動就橫移則像在溜冰。
- 走法:圖片角色是一小步一小步跳(起跳前蹲、落地壓扁);bloub 是果凍滑行與滾動一趟換一趟。
- 可以去的範圍相對右下角的家,最多 200px(`WALK_MAX_PX`),由元件依剩下的空間算(見第 7 節)。
- 幅度刻意小 —— 牠只是在旁邊動一動,不是主角(原則 2)。

### ⚠️ 停下來,不是歸零

不是閒晃狀態、滑鼠指著牠或鍵盤焦點在牠身上、開了減少動態 —— 這些時候**停在原地**(位移保留)、
身體回正;回到閒晃時從原地接著逛。走到一半有工作進來,牠就在那裡開始做事。

滑鼠指著要停,除了「你指著牠、牠停下來」比較合理之外,還有一個實際理由:
氣泡的位置是打開那一刻算好的,牠繼續走的話氣泡會留在原地跟牠分家。

**唯一的例外是拖曳**:被拖的那一刻位移要**歸零**(`usePetWander` 的 `resetKey = dragging`)。
拖曳的起點是 `pointerdown` 當下量的 `getBoundingClientRect()`,那個矩形**含**散步的位移,
接著就把牠釘在同一個座標上 —— 位移不歸零的話,釘好的座標會再被推開一次
(眼睛看到的位置跟釘住的位置差一段)。放開之後從新的起點重新逛。

### 動畫偏好

系統關掉動畫效果(`prefers-reduced-motion: reduce`)時:

- CSS 那 5 個狀態 class 全部 `animation: none`,散步也不走。
- 氣泡的進退場改成瞬間、跟著滑鼠傾斜完全關掉(`useTooltipWobble` 讀 `useReducedMotion`)。
- **狀態不會漏掉** —— 圖片本身、頭上那句台詞、`aria-label` 都還在。
- GIF 本身沒辦法用 CSS 停。真的要連 GIF 都停的話,用 `spriteOverrides` 換成靜態 PNG。

---

## 10. 素材規格

### 這批圖(`public/pet/`)

- 17 張 GIF,畫布 **302×300**,角色內容約在 (50,103)–(243,275)。
- 上方近 1/3 是刻意留白,給終端機視窗、ERROR 字樣、zzz 那些道具用。
- 第二個角色 bloub 不用圖,是 `BloubAvatar.tsx` 用程式畫的(每一格直接寫 SVG),
  底下這幾節講的換圖、氣泡高度、感應區都只適用於圖片角色。

### 換一整組圖要做的事

1. 圖放進 `public/pet/`,改 `pet-sprites.ts` 的 `src`(開頭的斜線是網站根目錄,不能少)。
2. **重量氣泡高度**:逐格解碼掃整張 GIF 找內容最高的那一格
   —— 不能只看第一格,zzz、跳起來那幾格都在後面。更新 `pet-sprites.ts` 的 `SPRITE_CONTENT_TOP_PX`。
3. **重量感應區**:量角色實際佔的範圍,更新那四個百分比。
4. 角色如果是滿版的(沒有留白),把顯示框從 `size-36` 改小,並把氣泡改回貼上緣。

### 支援格式

| 格式 | 會動 | 備註 |
| --- | --- | --- |
| GIF | ✅ | 透明邊緣有鋸齒 |
| APNG / WebP | ✅ | 透明度乾淨,建議 |
| PNG / SVG | ❌ | 靜態,`prefers-reduced-motion` 時的好選擇 |

會動的格式瀏覽器自己會播,不用寫任何程式。

### 不用一次到齊

`src` 留 `null`、檔名打錯、圖還沒放進去 —— 那個狀態自動退回替代圖示,不會變成破圖或空白圓圈。
所以可以先把路徑都填好,圖慢慢補。

### ⚠️ 授權

放進來的圖必須是你們有權使用的:自己畫的、自己產的、外包買斷的,
或明確標示 CC0 / MIT 之類可商用的素材。

**網路上的同人素材多半標「All rights reserved」,看起來免費不代表可以用在公司系統上。**
`frontend/src/pet/讀我.txt` 裡有調查過的具體案例。bloub 引擎的授權在 `frontend/src/pet/bloub/LICENSE`(MIT)。

---

## 11. 無障礙

| 項目 | 作法 | 為什麼 |
| --- | --- | --- |
| 角色是 `<button>` | 不是 `<div onClick>` | 鍵盤 Tab 得到,報讀軟體知道它可以按 |
| `aria-label` | `「{name}:{hint}(可以拖著移動)」` | 狀態的意思在這裡,不靠視覺 |
| `<img alt="">` | 空字串 | 資訊已經在 `aria-label`,重複唸兩次更吵 |
| 狀態台詞 `role="tooltip"` | **不是** `status` | 它一兩秒換一次,用 `status` 報讀軟體會整天在唸「正在讀資料、正在搜尋…」 |
| 通報 `role="status"` | 是 | 那是即時訊息,而且不常出現 |
| `focus` 也會顯示台詞 | 不只 `hover` | 只認滑鼠的話,用鍵盤的人永遠看不到 |
| 焦點框 | `focus-visible:ring-2` | 圓形按鈕上看得出來 |
| 尖角 `aria-hidden` | 是 | 純裝飾 |
| 感應區 `aria-hidden` | 是 | 它只是個透明的偵測層 |

---

## 12. 必須保留的行為

> 這一節是這份規格書最重要的部分。每一條都是從程式碼表面看不出來、
> 改壞了也不會報錯的問題。改動時請先讀完這一節。

### 狀態

1. **`transient` 的倒數計時器要放 `ref`,不能放 effect cleanup。**
   effect 的相依是 task 的欄位,而「完成後 4 秒內切到別頁」會讓 task 變成 `undefined`
   → 相依變了 → cleanup 清掉計時器 → effect 重跑卻在第一行 return
   → **再也沒有人把 transient 收回去**。症狀是牠永遠停在「完成了!」,只有重新整理才會好。

2. **結束表情要用 `id` 去重。** 沒去重的話同一件工作每次重繪都觸發一次表情。

3. **「跑很久」要靠計時器推進。** 進行中每 10 秒重算一次 `now`,
   否則沒有任何事件的那 5 分鐘裡永遠不會切到 `grinding`。

4. **`getCurrentTask` 在送出瞬間就要查得到**(見 4.1)。

5. **停止的判定用 `startsWith` 不能用相等。**
   本專案的停止有兩條路徑,訊息不一樣:伺服器收尾是「已停止(還沒開始產生內容)」,
   前端中止是「已停止」。寫死相等只對得上後者,而實際上幾乎都走前者。

### 版面

6. **位移掛最外層、散步的身體動作只掛角色層、狀態動畫掛按鈕**(見第 8 節結構表)。

7. **換狀態時散步停在原地,不歸零**;回到閒晃從原地接著逛。
   **拖曳是例外**:被拖的那一刻位移要歸零,不然釘住的座標會被散步的位移
   再推開一次(見第 9 節)。

8. **感應區必須是按鈕的子元素**,放外面會讓拖曳與點擊整個失效。

9. **氣泡定位與晃動要分兩層**,合併會被 framer 的 inline transform 蓋掉置中。

### 互動

10. **拖曳門檻 4px。** 不分「戳」與「拖」的話,想戳卻手抖就把牠拖走了。

11. **`pointerdown` 要 `preventDefault()`。**
    沒有的話按住角色往旁邊拖會啟動瀏覽器原生的「把圖片拖出去」,
    而 Chrome 拖圖片時會把 `"Files"` 放進 `dataTransfer.types` ——
    剛好通過某些頁面 `types.includes("Files")` 的檢查,**上傳遮罩就跳出來蓋住整個畫面**。

12. **存位置要從 `latestRef` 讀,不能讀 state。**
    `pointerup` 的處理函式抓到的是它被建立那一輪的值;快速拖放不會發生重繪,
    結果就是位置沒存到,重新整理後又跳回右下角。

13. **`dragging` 要等真的拖了才開。** 在 `pointerdown` 就開的話,只是想戳一下也會讓牠先閃回原點。

14. **要 `setPointerCapture`。** 沒有的話拖快一點滑鼠會「掉」在半路。

15. **`readPinned()` 要把座標夾回目前視窗。**
    位置是絕對座標,寬螢幕拖到右邊之後換筆電開,那個座標落在畫面外 ——
    小夥伴等於消失,而且沒有任何入口叫得回來。`resize` 時也要重夾。

### 顯示

16. **圖片 `onError` 一律退回替代圖示**,不要留破圖 icon 或空白圓圈(使用者會以為壞了)。

17. **氣泡的 `motion.div` 刻意不給 `key`。**
    給了的話 `mode="wait"` 每換一句都要先退場再進場,而狀態台詞一兩秒換一次,
    等退場等於每次都慢半拍。現在是「冒出來/收回去」有動畫、中間換字直接換。

18. **`useTooltipWobble` 要照觸發區寬度換算,離開要歸零。**
    感應區只有 91px 寬,固定用 ±60px 當兩端的話滑到邊邊也只轉得到一半,看起來像沒反應;
    不歸零的話你把它弄歪之後,之後每次冒出來都是歪的 —— 那是狀態,不是回饋。

### 效能

19. **閒置偵測用 ref 記時間、每 10 秒才 `setState`。**
    每次 `mousemove` 都 `setState` 的話,整個 App 會跟著使用者的滑鼠瘋狂重繪。

20. **`mousemove` 監聽要 `{ passive: true }`。**

---

## 13. 客製化

### 換角色

改 `pet-sprites.ts` 的 `PET_SPRITES`,或在進入點:

```ts
configurePet({
  spriteOverrides: {
    walking: { src: "/pet/我的角色-idle.webp", hint: "在旁邊待命" },
    happy: { src: "/pet/我的角色-yay.webp" },
  },
});
```

換完記得重量氣泡高度與感應區(見第 10 節)。

### 換用語

這批預設台詞已經改成通用寫法(「這件」而不是「這題」)。
你的產品有自己的說法就整組覆蓋 `hint`。

### 換配色

改 `tooltip-panel.ts` 的 `TOOLTIP_PANEL_CLASS` 與 `TOOLTIP_ARROW_TOP_CLASS`。
兩個要一起改 —— 尖角跟框不同色的話會看起來像破圖。

### 調動畫手感

狀態動畫改 `frontend/src/styles/pet.css`,散步改 `petWander.ts`。
**幅度請維持在同一個量級** —— 放大到「明顯」就會變成干擾(原則 2)。

### 減少狀態

用不到 `uploading` / `notice` / `busy*` 的話,對應欄位不要給就好,不用改程式碼。
圖也可以不放(自動退回替代圖示)。

---

## 14. 不做的事

| 不做 | 為什麼 |
| --- | --- |
| 隨機動作、隨機台詞 | 一旦亂動,使用者就不再相信它的動作有意義(原則 1) |
| 音效 | 辦公室環境。而且一定會有人第一天就把它關掉,那這個功能等於不存在 |
| 拖到手機上 | 小螢幕沒有多餘空間,拖曳會跟捲動打架 |
| 記住「牠走到哪」 | 位置是使用者釘的,散步的當下位置沒有意義,存了反而會在重新整理時跳一下 |
| 一次顯示兩個氣泡 | 同一隻角色頭上兩個框看起來像兩個不同的東西 |
| 讓它變成主要的錯誤通知管道 | 系統錯誤請用 toast。小夥伴是狀態指示器,不是訊息中心 |
| 新增後端欄位 | 加了就有維護成本,撐不過第一次改版(原則 3) |

---

## 15. 驗收清單

接完線之後照這張表走一遍:

**基本**
- [ ] 沒事時牠在右下角附近散步,氣泡的字不會跟著歪或轉
- [ ] 閒置 60 秒後改成睡覺
- [ ] 滑鼠移上去牠會停下來,氣泡跟著牠而不是留在原地

**狀態**
- [ ] 送出一件工作 → 立刻(1.2 秒內)看得出狀態變了,不會停留在散步
- [ ] 工具切換時圖不會瘋狂閃(至少 1.2 秒才換一次)
- [ ] 跑超過 5 分鐘會換成 `grinding`
- [ ] 成功 → happy 4 秒 → 回到散步/睡覺
- [ ] 失敗 → sad;使用者按停止 → stopped(**不是** sad)
- [ ] 完成後 4 秒內切到別頁,牠會**收掉** happy 而不是永遠停在那裡
- [ ] 在 A 頁送出後切到 B 頁 → 顯示 `background`
      (送出後 4 秒內切走的話,`JUST_SENT_MS` 那條退路會先把它當成 B 頁自己的,見 4.1)
- [ ] 有合成假工作的話(如未讀提示):全站沒事時出得來,別頁一有事在跑就讓位給
      `background`,而不是把它壓掉(見 5.2.1)

**互動**
- [ ] 點一下 → poked;連點 4 下 → annoyed
- [ ] 拖動 → 不會觸發 poked;放開後重新整理,位置還在
- [ ] 把視窗縮很小再放大 → 牠沒有跑到畫面外
- [ ] 外部入口能隱藏,再從同一個入口叫回來
- [ ] 拖走之後,外部入口能讓牠回到右下角

**通報**
- [ ] `petSay({ text, href })` → 氣泡出現、可以點、跳對地方(SPA 不會整頁重載)
- [ ] 連續兩則 → 後面那則有完整的 6 秒,不會被前一則的倒數截掉

**無障礙 / 韌性**
- [ ] Tab 到牠身上會出現台詞與焦點框
- [ ] 報讀軟體不會一直唸狀態台詞(只有通報會被唸)
- [ ] 系統關掉動畫效果 → 牠靜止,但狀態與文字都還在
- [ ] 故意把某個 `src` 改成不存在的檔名 → 那個狀態退回替代圖示,不是破圖
- [ ] 視窗寬度 ≤ 768px → 完全不渲染(本專案的 `MOBILE_QUERY` 含 768;
      不只是看不見 —— lazy chunk 不下載、計時器與 GIF 都不起跑)

---

## 附錄:正本在哪

**正本在 `frontend/` 底下** —— `frontend/src/pet/`(元件)、
`frontend/src/styles/pet.css`(動畫)、`frontend/public/pet/`(圖)。
kit 這個資料夾只有 `SPEC.md`、`README.md`、`examples/` 三樣。

本專案的接線在 `frontend/src/lib/petSetup.tsx`:`PetSource` 那三個問題的答案來自
串流狀態層 `frontend/src/lib/runs.ts`。行為測試在 `frontend/src/pet/__tests__/`。
