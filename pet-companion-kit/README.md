# 小夥伴(PetCompanion)元件包

從「問我問我(AskME)」抽出來的桌面小夥伴 —— 一隻待在畫面右下角、**用動作反映系統真實狀態**的角色。

> 它不是裝飾。一件工作跑 3~15 分鐘時,畫面幾乎是靜止的;進度條和文字解決的是
> 「它在做什麼」,這隻解決的是**餘光掃過去就知道「它還活著」**。
> 所以它的每一個狀態都對應一個真的送得出來的訊號,不做隨機的狀態或台詞。

完整規格請看 **[SPEC.md](SPEC.md)**。這份 README 只講怎麼裝上去。

> ⚠️ **原始碼不在這個資料夾裡。** 小夥伴的程式碼、樣式與角色圖住在 `frontend/` 底下
> (`frontend/src/pet/`、`frontend/src/styles/pet.css`、`frontend/public/pet/`),
> 那份就是正本。這個資料夾只有這裡才有的東西:`SPEC.md`、本檔、`examples/`。

---

## 5 分鐘上手

### 1. 複製檔案

下面「從這裡」欄位是**相對於 repo 根目錄**的路徑。

| 從這裡 | 放到你的專案 |
| --- | --- |
| `frontend/src/pet/` | `src/pet/`(或任何你放元件的地方;裡面的 `讀我.txt` 是角色圖的說明,一起帶著) |
| `frontend/src/styles/pet.css` | 你的樣式資料夾 |
| `frontend/public/pet/` | 你的 `public/pet/`(17 張 GIF) |
| `frontend/src/styles/pet-shim.css` | 你的樣式資料夾 —— **只有沒 Tailwind 的專案需要**,而且要照自己的 token 重寫一遍 |
| `frontend/src/lib/pointerOwner.ts`、`frontend/src/lib/transitionMs.ts` | `src/pet/` 的上一層 `lib/`(`src/pet/` 用 `../lib/…` import 這兩支;要放別處就改那兩行 import) |

⚠️ **`pet.css` 只管動畫,不管版面。** 版面(`fixed`、`size-36`、`bottom-28`、
`hidden md:block` 那幾十個 class)是 kit 直接寫在 `className` 上的 Tailwind 工具類。
沒有 Tailwind 又漏掉第四份的話,你會拿到一隻**會動但沒有版面**的小夥伴:
GIF 會播、會散步,但不是 144px、不在右下角、手機也不會隱藏。

本專案自己就沒有 Tailwind,走的是「另寫墊片、不改 kit」這條:`pet-shim.css` 用
Astryx token 把 kit 用到的工具類各實作一條,`frontend/src/pet/` 一行都不改。
另一條路是直接改 kit 的 `className`,兩條的代價比較寫在 [SPEC 第 3 節](SPEC.md#3-執行環境與相依)。

### 2. 裝相依套件

```bash
npm i react framer-motion clsx
```

`clsx` 只是為了 `cn()`,你的專案已經有的話刪掉 `src/pet/cn.ts` 改 import 自己的。
(`tailwind-merge` 是給**有 Tailwind** 的專案仲裁同性質工具類用的,沒有 Tailwind 就不需要
—— 見 `cn.ts` 的說明。)

### 3. 引入 CSS

```css
@import "./pet.css";
/* 沒有 Tailwind 的話,墊片也要引入(見第 1 步) */
@import "./pet-shim.css";
```

### 4. 接上訊號來源(**唯一要動腦的一步**)

```ts
import { configurePetSource, configurePet } from "@/pet";

configurePetSource({
  getCurrentTask: () => /* 這一頁正在跑的工作,沒有就 undefined */,
  getActiveCount: () => /* 全站還在跑幾件 */,
  subscribe: (cb) => /* 有變化就呼叫 cb,回傳退訂函式 */,
});

configurePet({ name: "小夥伴", capacity: 3, storagePrefix: "myapp_pet" });
```

還沒接也能跑 —— 預設來源永遠回「沒事做」,小夥伴會散步、會睡覺,不會壞掉。
照抄用的完整範例在 [`examples/1-最小接法.ts`](examples/1-最小接法.ts)。

### 5. 掛上去

```tsx
import PetCompanion from "@/pet";

<PetCompanion viewKey={location.pathname} />
```

放在最外層(跨頁常駐),不要放在單一頁面裡 —— 使用者切走時牠要還在。

### 6. ⚠️ 做兩個外部入口(**不是加分項,是必要的**)

```ts
import { setPetHidden, isPetHidden, unpinPet, isPetPinned } from "@/pet";
```

- **顯示/隱藏**:關閉的動作如果只長在小夥伴身上,關掉之後那顆鈕跟著消失,使用者再也叫不回來。
- **回到原位**:位置存在 localStorage,拖到角落之後重新整理還在那裡,同樣叫不回來。

本專案放在指令面板(Ctrl+K),放設定頁或選單也行,重點是**在小夥伴以外的地方**。
範例在 [`examples/3-掛進-App-與開關入口.tsx`](examples/3-掛進-App-與開關入口.tsx)。

---

## 資料夾地圖

```
pet-companion-kit/
├─ README.md                    ← 你正在看的這份
├─ SPEC.md                      ← 完整規格書(狀態機、行為契約、必須保留的行為)
└─ examples/
   ├─ 1-最小接法.ts              ← 自己寫一個小 store,約 60 行
   ├─ 2-本專案的接法.ts          ← 本專案是怎麼接的(節錄自 frontend/src/lib/petSetup.tsx)
   └─ 3-掛進-App-與開關入口.tsx  ← 掛載、router 連結、指令面板項目

要複製進專案的檔案都在 frontend/ 底下,見上面第 1 步的表。
```

⚠️ `examples/` **不在任何建置或型別檢查流程裡**(`frontend/tsconfig.json` 的 `include`
只有 `["src", "vite.config.ts"]`)。改 `frontend/src/pet/` 的對外 API 時要回來看一眼
這三份 —— 它們跟正本分岔了不會有任何自動機制抓到。

---

## 可攜版的接口是怎麼切的

`frontend/src/pet/` **既是本專案正在跑的那份,也是給別的專案用的可攜版** ——
沒有「內部版」跟「發佈版」兩份要同步。做得到是因為跟宿主綁在一起的東西都改成
注入或設定,本專案自己也只能透過同一組接口用它。唯二的例外是 `lib/pointerOwner.ts`
與 `lib/transitionMs.ts` 兩支小工具,複製時一起帶走(見第 1 步的表)。

| | 綁死宿主的寫法(不要這樣) | 可攜版(`frontend/src/pet/`) |
| --- | --- | --- |
| 訊號來源 | 直接 import 宿主的 store | `configurePetSource()` 注入 |
| 路由 | 直接用 `react-router` 的 `useLocation` / `Link` | `viewKey` prop + `renderLink` 設定,**不相依 router** |
| 替代圖示 | 宿主的 `<Logo />` | 內建一個,可用 `fallbackIcon` 換掉 |
| localStorage key | 寫死宿主的前綴 | `storagePrefix` 可設定 |
| 角色選擇 | 讀宿主的偏好設定 | `useBlob` / `useBlobLook` 兩支 hook 注入 |
| 台詞 | 綁「問答」用語 | 通用用語,可用 `spriteOverrides` 整組換 |
| z-index | 宿主自訂的工具類 | 直接用 Tailwind 的 `z-40` / `z-50` |

---

## 驗證

- `frontend/src/pet/__tests__/` 有拖曳、散步、氣泡高度、回正、bloub 的行為測試,跟著 `npm test`(vitest)跑。
- `src/pet/` 在 `frontend/tsconfig.json` 的 `include` 裡,型別檢查跟著前端一起跑;`examples/` 不在(見上面)。

---

程式碼的授權與本專案相同。
