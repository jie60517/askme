/**
 * 換功能頁的過場。
 *
 * 「我剛點了哪裡」交給側邊欄那塊選取底色滑過去(`Sidebar.tsx` 的 `SelectionPill`),內容區只快速淡換:
 *   - **點下去那一刻**:舊頁 150ms 淡出 + 2px 模糊;同時通知側邊欄,選取底色馬上開始滑(`PAGE_SWAP_EVENT`)。
 *   - **新頁掛上那一刻**(`App.tsx` 的 `PageSwapDone`):新頁 200ms 淡入、模糊收掉。
 *
 * ⚠️ **不用 View Transitions**(New chat ↔ 對話那段用的那套):那套要等新頁掛上才拍新畫面,等的那段
 * 畫面整個凍住 —— 一般換頁就要零點幾秒,第一次進某頁(要下載那一頁的程式)更久,選取底色也要等
 * 凍住結束才開始滑。點下去就要有反應,所以舊頁在點下去當下就開始淡,新頁好了再淡入;
 * 新頁晚到時看到的是「淡掉、晚一點出來」,不是卡住。
 *
 * ⚠️ **新頁淡入不帶位移**:內容區那一層是 `height: 100%`、
 * 外面那層(`#astryx-app-shell-main`)會捲 —— 往下偏 4px 就多出 4px 可捲範圍,Windows 的捲軸
 * (15px)在淡入那 0.2 秒冒出來又收掉,整頁被往左擠一下。模糊本身就把新舊兩頁糊在一起了。
 *
 * 不做「同一個框從這頁變形到下一頁」(輸入框 → SSH 視窗 → 工具列):
 * 那幾個不是同一個東西,硬變形看起來就怪。
 *
 * 減少動態:只淡,不模糊(側邊欄那塊也不滑,見它自己的樣式)。
 */
import {prefersReducedMotion} from './rubberband';

/** 側邊欄聽這個事件:detail 是要去的網址,選取底色馬上滑過去 */
export const PAGE_SWAP_EVENT = 'page-swap:start';
/** 換頁放棄了(新頁一直沒掛上):側邊欄的選取底色回到目前那一列 */
export const PAGE_SWAP_CANCEL_EVENT = 'page-swap:cancel';

/**
 * 時間寫死、不走 token(Web Animations 也吃不了 `var()`)。
 * 曲線讀全站的 `--ease-standard`(起步快、尾巴收住),讀不到才用寫死的同一條。
 */
const OUT_MS = 150;
const IN_MS = 200;
const EASE_FALLBACK = 'cubic-bezier(0.24, 1, 0.4, 1)';
/** 點了之後新頁一直沒掛上(換頁被擋、導去別處又沒換網址)就把舊頁淡回來,不能讓畫面停在空白 */
const GIVE_UP_MS = 2000;

let host: HTMLElement | null = null;
let outAnim: Animation | null = null;
let pending = false;
let giveUp: number | undefined;

function ease(): string {
  if (!host) return EASE_FALLBACK;
  return getComputedStyle(host).getPropertyValue('--ease-standard').trim() || EASE_FALLBACK;
}

/** 內容區的根節點(`App.tsx` 包住路由的那一層)掛上 / 卸下 */
export function bindPageSwapHost(el: HTMLElement | null): void {
  host = el;
}

/** 現在是不是換頁換到一半(新頁掛上時用來決定要不要再演自己的進場淡入) */
export function isPageSwapping(): boolean {
  return pending;
}

/**
 * 換頁時要不要演:路徑真的換了(只換 `?` 後面的不算)。
 * 對話頁之間那段有自己的 `morphChat`,呼叫端先判斷那一條。
 */
export function shouldSwapPage(from: string, to: string | null | undefined): boolean {
  if (!to) return false;
  return to.split(/[?#]/)[0] !== from;
}

function armGiveUp(): void {
  window.clearTimeout(giveUp);
  giveUp = window.setTimeout(() => {
    finishPageSwap();
    window.dispatchEvent(new CustomEvent(PAGE_SWAP_CANCEL_EVENT));
  }, GIVE_UP_MS);
}

/** 點下去那一刻:舊頁開始淡出,側邊欄的選取底色開始滑 */
export function startPageSwap(href: string): void {
  window.dispatchEvent(new CustomEvent<string>(PAGE_SWAP_EVENT, {detail: href}));
  if (!host || typeof host.animate !== 'function') return;
  /*
   * 換到一半又點了一下(新頁還沒掛上就點了另一個,或同一個點兩下):淡出**接著跑**,不要從頭來 ——
   * 取消重來的話舊頁會先閃回全亮再淡一次。只重新計時。
   */
  if (pending) {
    armGiveUp();
    return;
  }
  const out: Keyframe[] = prefersReducedMotion()
    ? [{opacity: 1}, {opacity: 0}]
    : [
        {opacity: 1, filter: 'blur(0px)'},
        {opacity: 0, filter: 'blur(2px)'},
      ];
  outAnim = host.animate(out, {duration: OUT_MS, easing: ease(), fill: 'forwards'});
  pending = true;
  armGiveUp();
}

/**
 * 新頁掛上了(`App.tsx` 的 `PageSwapDone`,在換頁那一次 commit 的 layout effect 裡):淡入。
 * 從舊頁當下淡到的那個透明度接著往上 —— 新頁掛得很快(舊頁才淡一點點)時,不會先掉到全透明再亮回來。
 */
export function finishPageSwap(): void {
  if (!pending) return;
  pending = false;
  window.clearTimeout(giveUp);
  if (!host) return;
  const from = Number(getComputedStyle(host).opacity);
  outAnim?.cancel();
  outAnim = null;
  const start = Number.isFinite(from) ? from : 0;
  const frames: Keyframe[] = prefersReducedMotion()
    ? [{opacity: start}, {opacity: 1}]
    : [
        {opacity: start, filter: 'blur(2px)'},
        {opacity: 1, filter: 'blur(0px)'},
      ];
  host.animate(frames, {duration: IN_MS, easing: ease()});
}
