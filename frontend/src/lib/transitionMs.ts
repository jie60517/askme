/**
 * 一個元素的 CSS 過場要跑多久(ms)—— **去問那條 CSS 規則本人**,不要在 JS 抄一份數字。
 *
 * 用在「動畫是 CSS 在跑、JS 只決定什麼時候把東西拿掉 / 切狀態」的地方(側邊欄收合、開機蓋子淡掉)。
 * 抄一份就會有一邊過期:抄大了白等,抄小了動畫還沒跑完就被砍。
 *
 * 回 0 的情況都剛好該當場處理、不要等:根本沒有那個元素;或那條過場規則包在 `prefers-reduced-motion`
 * 的 media query 裡而使用者開了它(側邊欄是這樣;開機蓋子那條刻意沒包,照樣回 300)。有好幾條 transition 時取第一條。
 */
export function transitionMs(el: Element | null): number {
  if (!el) return 0;
  return cssDurationMs(getComputedStyle(el).transitionDuration.split(',')[0]) ?? 0;
}

/**
 * 一個 CSS 時間字串(`165ms`、`0.225s`)換成毫秒;讀不出數字回 null。
 *
 * **全站只有這一份**(`useFlip`、`rubberband` 都用它):
 * 要多支援什麼寫法(calc、多個值)改這裡就好。
 */
export function cssDurationMs(raw: string): number | null {
  const text = raw.trim();
  const n = parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return text.endsWith('ms') ? n : n * 1000;
}

/**
 * 讀一個時間 token(例如 `--duration-fast-max`)的毫秒數。
 *
 * rAF 補間沒辦法直接吃 CSS 變數,只好在開始那一刻去問一次 —— **不要在 JS 抄一份數字**,
 * `theme-neutral` 的值(165ms)跟 core 的預設(230ms)本來就不一樣。讀不到就用 `fallback`。
 */
export function durationTokenMs(name: string, fallback: number): number {
  try {
    return cssDurationMs(getComputedStyle(document.documentElement).getPropertyValue(name)) ?? fallback;
  } catch {
    return fallback;
  }
}
