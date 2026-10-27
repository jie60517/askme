/**
 * 個人顯示設定:字級與對比。
 *
 * 跟 `theme.ts` 同一個形狀,而且刻意同一套做法:
 *  - **先套本機、再送伺服器**。網路慢的時候拉桿還是要即時跟著動。
 *  - localStorage 是為了**在 JS 載入之前就套上**(見 index.html 的那段
 *    inline script)—— 不然每次重新整理都會先閃一下預設的字級。
 *  - 伺服器那份是「跟著人走」的:換一台電腦、或共用電腦時,localStorage
 *    記到的會是這台機器上一個人的設定。
 *
 * ⚠️ **字級的下限是 50 不是 0**:字級 0
 * 的畫面上什麼都看不見,**包含那條把它調回來的拉桿本身** —— 設下去就再也
 * 救不回來(只能清 localStorage 或改資料庫)。50% 已經很小,但還讀得到。
 * 後端 `users.MIN_FONT_SCALE` 是同一個數字,兩邊要一起改。
 */
import {readJson, writeJson} from './safeStorage';

/**
 * **兩條拉桿共用同一個範圍**:範圍不同的話,同樣的 100% 會落在拉桿上不同的位置。
 *
 * ⚠️ 下限 50 是字級的需求(字級 0 連調回來的拉桿都看不見,見檔案開頭),
 * 對比因為要跟字級對齊,也跟著用同一個範圍。
 */
export const SLIDER_MIN = 50;
export const SLIDER_MAX = 200;
const SLIDER_MID = 100;

/**
 * 拉桿畫面上用的是「位置」,不是實際值 —— 這樣才能讓 50~100 跟 100~200
 * 這兩段**各佔版面一半寬度**,100% 就會落在拉桿正中央。
 */
export const SLIDER_POSITION_MIN = 0;
export const SLIDER_POSITION_MAX = 100;
/**
 * 拉桿一格走多少「位置」。
 *
 * ⚠️ **0.5 不是 5**:拖起來要滑順。軌道約 330px、位置域 0~100 —— 一格 5 等於拇指
 * 一次跳 **16.5px**,拖起來是一格一格的;0.5 是 1.65px,拖起來才連續。
 *
 * ⚠️ **值因此不保證是整數**(一格在下半段是 0.5%、上半段 1%)。
 * 畫面上的百分比與 `aria-valuetext` 都要自己 `Math.round()`;
 * 存檔那一端本來就會round(`normalizePrefs`),所以伺服器拿到的仍然是整數。
 *
 * ⚠️ 鍵盤:方向鍵一次 0.5 個位置、**PageUp/PageDown 是 10 倍**(設計系統的
 * Slider 內建),Home/End 直接到底 —— 所以用鍵盤的人不會被逼著按一百下。
 */
export const SLIDER_POSITION_STEP = 0.5;

/** 位置域的正中央 —— `SLIDER_MID`(100%)就固定落在這裡。 */
const POSITION_MID = (SLIDER_POSITION_MIN + SLIDER_POSITION_MAX) / 2;
/** 下半段:一格位置代表多少實際值。 */
const LOWER_VALUES_PER_POSITION = (SLIDER_MID - SLIDER_MIN) / (POSITION_MID - SLIDER_POSITION_MIN);
/** 上半段:同上。兩段的值域跨度不同(50 vs 100),所以這兩個數字本來就不會一樣。 */
const UPPER_VALUES_PER_POSITION = (SLIDER_MAX - SLIDER_MID) / (SLIDER_POSITION_MAX - POSITION_MID);

/*
 * ⚠️ **上面那幾個常數是算出來的,不要改回字面值。**
 *
 * 寫成 `value - SLIDER_MIN` 與 `50 + (value - SLIDER_MID) / 2` 這種字面值的話,
 * 那個 `50` 與 `/ 2` 只是從「MIN=50、MID=100、MAX=200、位置域 0~100」湊巧推出來的。
 * 字級下限跟後端 `users.MIN_FONT_SCALE` 是同一個數字、兩邊要一起改:
 * 哪天真的改了下限,字面值會**安靜地算錯**(拉桿位置偏掉、100% 不再置中),
 * 不會有任何錯誤訊息。從常數導出就不會有這個問題。
 *
 * ⚠️ **刻度密度兩段不一樣是數學上的必然,不是漏寫。** 上半段要用 100 個百分點
 * 走完一半的寬度,下半段只有 50 個 —— 所以同樣一格,在下半段是 0.5%、上半段是 1%。
 * 這件事本身沒辦法消除(除非放棄「100% 置中」),但格子切得夠細,使用上看不出來。
 */
export function valueToSliderPosition(value: number): number {
  return value <= SLIDER_MID
    ? SLIDER_POSITION_MIN + (value - SLIDER_MIN) / LOWER_VALUES_PER_POSITION
    : POSITION_MID + (value - SLIDER_MID) / UPPER_VALUES_PER_POSITION;
}

export function sliderPositionToValue(position: number): number {
  return position <= POSITION_MID
    ? SLIDER_MIN + (position - SLIDER_POSITION_MIN) * LOWER_VALUES_PER_POSITION
    : SLIDER_MID + (position - POSITION_MID) * UPPER_VALUES_PER_POSITION;
}

export const FONT_SCALE_MIN = SLIDER_MIN;
export const FONT_SCALE_MAX = SLIDER_MAX;
export const FONT_SCALE_DEFAULT = 100;

export const CONTRAST_MIN = SLIDER_MIN;
export const CONTRAST_MAX = SLIDER_MAX;
export const CONTRAST_DEFAULT = 100;

const KEY = 't100_display_prefs';

export type DisplayPrefs = {
  fontScale: number;
  contrast: number;
};

const DEFAULTS: DisplayPrefs = {
  fontScale: FONT_SCALE_DEFAULT,
  contrast: CONTRAST_DEFAULT,
};

/**
 * ⚠️ **值壞掉時回的是 `fallback`(預設 100),不是 `low`。**
 *
 * `index.html` 那段 inline script 的夾值要跟這裡一致,而它在讀不出數字時套的是 **100**。
 * 這裡若回 `low`(50),localStorage 被寫壞的人會看到**畫面先用 100% 畫出來、JS 一載入就跳成 50%**
 * —— 兩份程式各自都「合理」,不一致的只有壞值那條路,所以平常測不出來。
 */
function clamp(value: number, low: number, high: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(low, Math.min(high, Math.round(value)));
}

/** 把外面來的值(伺服器、localStorage、拉桿)收成一組一定合法的設定。 */
export function normalizePrefs(raw: Partial<DisplayPrefs> | null | undefined): DisplayPrefs {
  return {
    fontScale: clamp(
      raw?.fontScale ?? FONT_SCALE_DEFAULT,
      FONT_SCALE_MIN,
      FONT_SCALE_MAX,
      FONT_SCALE_DEFAULT,
    ),
    contrast: clamp(raw?.contrast ?? CONTRAST_DEFAULT, CONTRAST_MIN, CONTRAST_MAX, CONTRAST_DEFAULT),
  };
}

/**
 * 設計系統裡**可能**用 `rem` 的 token 名單。
 *
 * 用途只有一個:讓某一塊畫面**不要跟著根字級變**(見 `pinnedRemTokens`)。
 * 之所以列得完,是因為 `--spacing-*` 那些全是寫死的 px —— 會跟著字級走的就只有
 * 字級與圓角這兩組。
 *
 * ⚠️ **`--text-*-size` 那一排不能省,而且它才是真正要釘的那一層。**
 * 元件讀的是 `--text-body-size` 之類的語意 token,而它們在 `:root` 就被宣告成
 * `var(--font-size-base)` —— 自訂屬性的 `var()` 是**在宣告它的那個元素上**換掉的,
 * 所以往下傳的已經是 `0.875rem` 這個字面值。只覆寫 `--font-size-*` 的話,
 * 語意那層完全不受影響:對話框的 `--font-size-base` 確實變成 14px,
 * 而畫面上的字照樣跟著放大。
 *
 * ⚠️ 名單裡的東西**不一定真的是 rem** —— 佈景可以把它換掉
 * (`theme-neutral` 就把 `--radius-element` 換過)。所以 `pinnedRemTokens`
 * 會**讀實際的值**,不是 rem 就跳過,不會去動佈景的決定。
 *
 * ⚠️ 升級 `@astryxdesign/*` 之後要重掃一次它們的 dist,把新的 rem token 補進來。
 * 漏掉的症狀是「那塊畫面一半跟著字級變、一半不變」,而且不會有任何錯誤訊息。
 */
const REM_TOKEN_NAMES: readonly string[] = [
  // 字級(原始階)
  '--font-size-4xs',
  '--font-size-3xs',
  '--font-size-2xs',
  '--font-size-xs',
  '--font-size-sm',
  '--font-size-base',
  '--font-size-lg',
  '--font-size-xl',
  '--font-size-2xl',
  '--font-size-3xl',
  '--font-size-4xl',
  '--font-size-5xl',
  // 字級(語意階 —— 元件真正讀的是這些)
  '--text-body-size',
  '--text-code-size',
  '--text-label-size',
  '--text-large-size',
  '--text-supporting-size',
  '--text-heading-1-size',
  '--text-heading-2-size',
  '--text-heading-3-size',
  '--text-heading-4-size',
  '--text-heading-5-size',
  '--text-heading-6-size',
  '--text-display-1-size',
  '--text-display-2-size',
  '--text-display-3-size',
  // 圓角
  '--radius-inner',
  '--radius-element',
  '--radius-container',
  '--radius-page',
];

/**
 * 把那些 token 換算成**固定的 px**,給「不要跟著字級變」的那塊畫面掛上去。
 *
 * `rootPx` 是**釘住那一刻**的根字級,`readToken` 是「去讀 `:root` 上這個 token 現在
 * 是什麼」(呼叫端傳 `getComputedStyle(documentElement).getPropertyValue`)。
 * 讀實際的值有兩個好處:佈景把某個 token 換成 px 時會自動跳過(不會去改到外觀),
 * 而 `0.875rem` 這種字面值本來就是我們要乘的那個數。
 *
 * ⚠️ 為什麼不是用 `zoom` 或 `transform` 把那塊縮回去:那兩個會**連 px 一起縮**,
 * 而畫面上大部分尺寸(`--spacing-*`、元件的固定寬高)本來就不隨字級變 ——
 * 縮回去等於把它們縮壞。例如個人設定對話框 508px 高裡只有約 60px 會跟著字級走,
 * 照字級比例縮的結果是被壓成 284px。**唯一對的做法是只釘住真的會變的那些值。**
 */
export function pinnedRemTokens(
  rootPx: number,
  readToken: (name: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REM_TOKEN_NAMES) {
    const raw = (readToken(name) || '').trim();
    const match = /^(-?\d*\.?\d+)rem$/.exec(raw);
    // 不是 rem 就不必釘(佈景換成 px 的、或這個版本沒有這個 token)
    if (!match) continue;
    out[name] = `${parseFloat(match[1]) * rootPx}px`;
  }
  return out;
}

let current: DisplayPrefs = DEFAULTS;
const listeners = new Set<() => void>();

/**
 * 真正把設定套到畫面上。
 *
 * **字級**走 `<html>` 的 `font-size` 百分比。
 * ⚠️ 不要改 `body` 的字級:`rem` 是相對於 `<html>` 的,改 body 連字都不會全部跟上。
 *
 * ⚠️ **這不是「整個 app 等比放大」**:
 * `theme-neutral` 的 `--spacing-*` 是**寫死的 px**,只有字級是 `rem`
 * (`--font-size-base: 0.875rem`)—— 會變的是**文字、以及被文字撐開的高度**,
 * 間距與元件的固定尺寸不動(個人設定對話框從 100% 調到 200% 只是 508px → 568px)。
 * 想靠「乘一個倍率」把某一塊畫面還原回原樣的人先讀這一條 —— 做不到。
 *
 * **對比**走一個 CSS 變數,由 `global.css` 決定怎麼用它(見那邊的說明)。
 * ⚠️ 這裡刻意**不去覆寫 `--color-*`**:那是專案明令不做的事
 * (`frontend/.claude/CLAUDE.md`:「不要自己覆寫 token」)。
 */
function apply(prefs: DisplayPrefs) {
  const root = document.documentElement;
  root.style.fontSize = `${prefs.fontScale}%`;
  root.style.setProperty('--user-contrast', String(prefs.contrast / 100));
  // 100% 時整個效果要**完全不存在**,不是「乘以 1」—— 有些瀏覽器對
  // filter: contrast(1) 還是會另開一層合成,字會變糊。
  root.toggleAttribute('data-user-contrast', prefs.contrast !== CONTRAST_DEFAULT);
  // 字級調到 100% 以下:觸控裝置上的輸入框要墊到 16px,不然 iOS 一點就放大整頁(見 global.css)。
  // ⚠️ 判斷要跟 `index.html` 開機腳本那條一致
  root.toggleAttribute('data-user-font-small', prefs.fontScale < 100);
}

/** 開機時先套本機那份(在拿到伺服器的值之前)。`main.tsx` 呼叫一次。 */
export function initDisplayPrefs() {
  current = normalizePrefs(readJson<Partial<DisplayPrefs>>(KEY, (v) => v as DisplayPrefs));
  apply(current);
}

export function getDisplayPrefs(): DisplayPrefs {
  return current;
}

/**
 * 還沒套到畫面上的那一份(只有 rAF 收斂那條路會用到)。
 * `0` = 沒有排程中的 frame。
 */
let pendingFrame = 0;

/**
 * 使用者拖拉桿。**只套本機、不送伺服器、也不寫 localStorage。**
 *
 * ⚠️ **套用收斂成「一幀一次」**。這一支掛在 Slider 的
 * `onChange` 上,而那是**每一個 pointermove 都會來**的 —— 一幀可能來好幾個。
 * 而它做的事一點都不便宜:
 *   - 改 `<html>` 的 `font-size` = 整份文件重算樣式 + 重排;
 *   - 改 `--user-contrast` = 根層 `filter` 換值 = 整個畫面重繪。
 * 不收斂的話同一幀會把這兩件事做好幾遍,拖起來就是頓的。
 *
 * ⚠️ **這裡不寫 localStorage。** `setItem` 是**同步 I/O**,每個 pointermove 寫一次
 * 等於把磁碟寫入掛在拖曳的每一幀上。由呼叫端在收工時呼叫一次 `persistDisplayPrefs()`(見它的說明)。
 *
 * ⚠️ `current` 仍然**同步**更新 —— `getDisplayPrefs()` 的呼叫端讀得到的必須是
 * 最新的值,被延後的只有「畫到螢幕上」這件事。
 */
export function setDisplayPrefs(next: Partial<DisplayPrefs>) {
  current = normalizePrefs({...current, ...next});
  // 測試環境(vitest 預設是 node)沒有 rAF —— 那時候直接套
  if (typeof requestAnimationFrame !== 'function') {
    apply(current);
  } else if (!pendingFrame) {
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      apply(current);
    });
  }
  listeners.forEach((cb) => cb());
}

/**
 * 把目前這份寫進 localStorage。**拖完了才呼叫一次**,不要放在拖曳路徑上。
 *
 * 誰負責呼叫:個人設定對話框關掉的那一刻(四條關閉路徑共用同一支 effect)。
 * ⚠️ 代價講明:拖到一半直接關掉分頁的話,這一次的調整不會留在本機 ——
 * 但伺服器那一份也是同一個時機才送的,所以兩邊一致,下次登入會從伺服器拿回來。
 */
export function persistDisplayPrefs() {
  writeJson(KEY, current);
}

/**
 * 採用伺服器上那份(登入或 /api/me 回來時)。
 *
 * ⚠️ **這條不會再寫回伺服器** —— 跟 `theme.adoptServerTheme` 同一個坑:
 * 採用伺服器的值之後馬上又 PUT 同一個值回去,每次開頁面都多一次沒必要的寫入。
 */
export function adoptServerPrefs(fontScale?: number | null, contrast?: number | null) {
  // 兩個都沒設過就不要動 —— 那表示這個人從來沒調過,本機那份才是他要的
  if (fontScale == null && contrast == null) return;
  current = normalizePrefs({
    fontScale: fontScale ?? current.fontScale,
    contrast: contrast ?? current.contrast,
  });
  apply(current);
  writeJson(KEY, current);
  listeners.forEach((cb) => cb());
}
