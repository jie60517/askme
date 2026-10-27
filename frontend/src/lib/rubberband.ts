/**
 * 拖過邊界的「橡皮筋」—— 拖曳中可以超界一小段、越拉越沉,放手再收回合法範圍。
 *
 * 硬夾住的話畫面完全不動,跟「拖曳斷了」長得一樣;讓它還能再走一點、但越拉越沉,
 * 使用者就知道「到頭了」而不是「壞了」。
 *
 * ⚠️ **這裡是唯一的一份**:側邊欄邊線(`components/SidebarResizer.tsx`)、頭像裁切(`AvatarCropper`)、
 * 檔案欄欄寬(`terminal/FilePanel.tsx` 的 `ColumnResizer`)都 import 這裡 ——
 * 長得一樣的把手要**同一種手感**。
 * 要調手感就改這裡,不要在呼叫端再抄一份。
 */

/** 拖過邊界之後最多還能再走多遠(px)—— 阻力曲線會漸近到這個值,但永遠到不了。 */
export const OVERDRAG_MAX_PX = 32;

/** 超出邊界的位移要打幾折。超越多越沉,漸近到 `limit`。 */
export function rubberBand(overflow: number, limit: number = OVERDRAG_MAX_PX): number {
  if (!(overflow > 0) || !(limit > 0)) return 0;
  return limit * (1 - 1 / (overflow / limit + 1));
}

/**
 * `rubberBand` 的反函數:畫面上超出了 `shown`,當初拖了多遠。
 * 按下去時東西可能還在彈回的半路,從畫面上的位置接手才不會跳(登入場景的上下角度用它)。
 * 超出量逼近 `limit` 時原本的距離趨近無限大,夾在 99.9% 以內。
 */
export function rubberBandInverse(shown: number, limit: number = OVERDRAG_MAX_PX): number {
  if (!(shown > 0) || !(limit > 0)) return 0;
  const f = Math.min(shown, limit * 0.999);
  return limit * (1 / (1 - f / limit) - 1);
}

/** `clampElastic` 的反函數(見 `rubberBandInverse`)。 */
export function unclampElastic(shown: number, min: number, max: number, limit: number = OVERDRAG_MAX_PX): number {
  if (shown > max) return max + rubberBandInverse(shown - max, limit);
  if (shown < min) return min - rubberBandInverse(min - shown, limit);
  return shown;
}

/** 拖曳中用這個(可以超界);放手時仍然要用硬夾的那一支收回來。 */
export function clampElastic(
  value: number,
  min: number,
  max: number,
  limit: number = OVERDRAG_MAX_PX,
): number {
  if (value > max) return max + rubberBand(value - max, limit);
  if (value < min) return min - rubberBand(min - value, limit);
  return value;
}

/** 減速收尾的曲線(ease-out cubic):一開始就有速度,最後輕輕停進去 —— 回彈要的就是這個。 */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

// 讀時間 token 的那一支在 `lib/transitionMs.ts`(跟解析時間字串放在一起);這裡轉出去給從這裡 import 的呼叫端
export {durationTokenMs} from './transitionMs';

/**
 * 從 1 補到 0 的一段 rAF 補間(ease-out),每一幀把「還剩幾成」交給 `onFrame`。
 * 回傳的函式取消它(下一次拖曳開始、元件卸載)—— 取消不會再叫 `onFrame`。
 * `ms <= 0` 就當場給 0 收掉。
 */
export function tweenOut(ms: number, onFrame: (remaining: number) => void): () => void {
  if (!(ms > 0)) {
    onFrame(0);
    return () => {};
  }
  let raf = 0;
  let start: number | undefined;
  const step = (ts: number) => {
    start ??= ts;
    const t = (ts - start) / ms;
    onFrame(t >= 1 ? 0 : 1 - easeOutCubic(t));
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/** 使用者有沒有要求減少動態。讀不到(SSR、測試環境)當作沒有。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}
