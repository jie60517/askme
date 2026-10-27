/**
 * 佈景(淺色 / 深色)。
 *
 * 兩份設定分工:
 *   localStorage 負責「不閃白底」—— index.html 在 JS 載入前就套 data-theme;
 *   伺服器負責「換一台電腦也一樣」—— 登入後 adoptServerTheme() 採用一次。
 *
 * store 放在模組層而不是某個畫面的 useState:App 層的 Toast 也要拿得到,
 * 藏在 Chat 裡的話深色模式下 toast 會是一塊白的。
 */
import {useSyncExternalStore} from 'react';

import {api} from './api';
import {resolveCssColor} from './cssColor';
import {readString, writeString} from './safeStorage';

export type ThemeMode = 'light' | 'dark';

const KEY = 't100_theme';

/**
 * 畫面上**現在**是哪一個 —— `useThemeMode` 的 snapshot、`data-theme`、訂閱者三者永遠一起換(見 `commit`)。
 *
 * ⚠️ 跟 `target` 分開:換佈景有淡過去的過場,屬性要等 View Transition
 * 拍完舊畫面才換。`current` 若一按就改,中間只要有任何 React render(從選單按切換,
 * 選單一關就會重畫)就會讀到新佈景,把新色的圖表 / 終端機 / 圖示畫進「舊」那張快照裡。
 */
let current: ThemeMode = read();
/** 使用者**想要**的那一個(最後一次 setTheme / 跨分頁同步給的)。只拿來判斷「要不要換」與切換的下一個 */
let target: ThemeMode = current;
/**
 * 每次改 `target` 就 +1。過場的 update 是非同步的:它跑的時候若已經不是最新的那一次
 *(連按兩下、或別的分頁同步進來),就什麼都不做 —— 不然晚到的 update 會把畫面換回舊的佈景。
 */
let generation = 0;
const listeners = new Set<() => void>();

function read(): ThemeMode {
  return readString(KEY) === 'dark' ? 'dark' : 'light';
}

function emit() {
  for (const l of listeners) l();
}

function apply(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
  syncThemeColor();
}

/** snapshot、屬性、訂閱者**同一刻**換過去(見 `current` 的說明) */
function commit(mode: ThemeMode) {
  if (mode === current) return;
  current = mode;
  apply(mode);
  emit();
}

/**
 * 手機狀態列 / 網址列跟著換色。
 *
 * `index.html` 有一條 `<meta name="theme-color">` 撐 JS 載入前那一下;換佈景之後改成從
 * `--color-background-body` 算出來的那一份(頂列是透明的,看到的就是這個底色)——
 * 不寫死色碼,換佈景才不會對不上。
 */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta || !document.body) return;
  meta.setAttribute('content', resolveCssColor(document.body, '--color-background-body'));
}

/** View Transitions 的最小型別(TS 的 lib.dom 還不一定有;同 `components/terminal/morph.ts`) */
type ViewTransition = {finished: Promise<void>; skipTransition?: () => void};
type StartViewTransition = (cb: () => void) => ViewTransition;

/** 換佈景那一段過場期間掛在 <html> 上的 class(global.css 認它,不碰 SSH 那段的 `vt-terminal`) */
export const THEME_VT_CLASS = 'vt-theme';

/** 最後一次開始的換佈景過場 —— 連按兩下時,只有最後那一段結束才拿掉 class */
let themeVt: ViewTransition | null = null;

/**
 * 換佈景 + 整頁淡過去。
 *
 * 直接改 `data-theme` 是整頁亮度一格跳(白 ↔ 黑),眼睛會被閃一下。用 View Transitions 拍舊畫面、
 * 換屬性,root 用 `--duration-medium-min` 交叉淡過去(節奏在 global.css 的 `html.vt-theme`)。
 *
 * ⚠️ **減少動態下照樣淡**:只有 opacity,沒有位移或縮放 —— 跟本專案「更少更輕,不是歸零」同一條;
 * 硬切的亮度跳反而是要避免的那種突兀。不支援 `startViewTransition` 的瀏覽器直接換。
 * ⚠️ `commit()`(snapshot + 屬性 + `emit()`)整個放進 update 裡:訂閱佈景的畫面(圖表、終端機的色票)
 * 要畫在**新**畫面那一張,不能在拍舊畫面之前就先換掉。React 的同步更新在 microtask 裡跑完,趕得上拍新畫面。
 * ⚠️ update 跑的時候先對 `generation`:被後來的那一次取代了就不動(見 `generation`)。
 */
function applyWithFade() {
  const mine = generation;
  const update = () => {
    if (mine === generation) commit(target);
  };
  const start = (document as Document & {startViewTransition?: StartViewTransition}).startViewTransition;
  if (!start) {
    update();
    return;
  }
  const root = document.documentElement;
  root.classList.add(THEME_VT_CLASS);
  const t = start.call(document, update);
  themeVt = t;
  void t.finished
    .catch(() => {})
    .finally(() => {
      if (themeVt === t) {
        themeVt = null;
        root.classList.remove(THEME_VT_CLASS);
      }
    });
}

/**
 * 切到指定佈景(使用者切換、登入後採用伺服器那一份都走這裡)—— 有淡過去的過場。
 * 開機與跨分頁同步**不走這裡**:那兩條是「本來就該是這個樣子」,直接套。
 */
export function setTheme(mode: ThemeMode) {
  if (mode === target) return;
  target = mode;
  generation += 1;
  writeString(KEY, mode);
  applyWithFade();
}

/**
 * 存到伺服器(`PUT /api/me/theme`)。
 *
 * localStorage 那份負責「重新整理不閃白底」,這一份負責「換一台電腦也一樣」。
 * 失敗完全靜默:主題同步是加值功能,為了它跳一個錯誤訊息
 * 反而比沒存到更煩。
 */
async function saveTheme(mode: ThemeMode): Promise<void> {
  try {
    await api.put('/api/me/theme', {theme: mode});
  } catch {
    // 忽略
  }
}

/**
 * 使用者自己切換。
 *
 * **只有這條路會寫回伺服器** —— adoptServerTheme 走 setTheme,
 * 如果 setTheme 自己就存的話,採用伺服器的值會馬上再把同一個值 PUT 回去。
 */
export function toggleTheme() {
  // 以 `target` 為準:過場還沒換過去之前再按一次,要切回去,不是再切一次同一個
  const next: ThemeMode = target === 'dark' ? 'light' : 'dark';
  setTheme(next);
  void saveTheme(next);
}

/**
 * 這個 app 目前是淺色還是深色。
 *
 * 名字不能叫 useTheme —— Astryx 自己有一個 `useTheme()`(回傳 `{token, mode}`,
 * 圖表在用),兩個同名的東西擺在同一個 import 區裡遲早會拿錯。
 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

// 跨分頁同步:直接套,不淡。
// ⚠️ 這一頁若還有一段過場沒換過去,要先把它作廢(`generation` +1)—— 不然它的 update 晚一步跑,
// 會把別的分頁剛同步過來的佈景蓋回這一頁按的那一個。`skipTransition()` 讓那段動畫也別演了。
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  const next = read();
  if (next === target && next === current) return;
  target = next;
  generation += 1;
  themeVt?.skipTransition?.();
  commit(next);
});
// 開機:只掛屬性,不重算狀態列的顏色 —— `index.html` 已經依同一份 localStorage 設好了,
// 在這裡算的話是在 React 畫第一格之前多做一次強制樣式計算
document.documentElement.setAttribute('data-theme', current);

/**
 * 採用伺服器上存的佈景。
 * 同一個帳號只採用一次 —— 否則「使用者切成淺色 → 下一次重抓身分拿到舊的 dark」
 * 會讓畫面自己跳回去。
 */
const adopted = new Set<string>();

export function adoptServerTheme(username: string, theme?: string | null) {
  if (adopted.has(username)) return;
  adopted.add(username);
  if (theme === 'light' || theme === 'dark') setTheme(theme);
}
