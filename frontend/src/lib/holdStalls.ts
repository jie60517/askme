/**
 * ⚠️ **卡住的時間不算進動畫**(`components/ComposerSlot.tsx` 的過場在用)。
 *
 * WAAPI 照牆上時間走,但輸入框底列那一格換 key 常跟著整個對話頁重畫:按 ✕、連上主機之後,commit 到第一格、
 * 或第一格到第二格之間會卡一個 ~48ms 的長任務。強 ease-out 下 48 / 220ms 等於七成的距離,
 * 右邊的 Model 鈕一格就跳 44–52px,剩下才慢慢滑 —— 看起來還是「跳」。
 *
 * 所以這些動畫還在跑時,每一格(rAF,畫之前)看離上一格多久:超過 `STALL_MS` 就把多出來的(留一格)從動畫時間扣回去,
 * 長任務變成「停一下」而不是「跳一段」。扣完仍 ≥ 上一格畫出來的位置,所以不會倒退;每一支扣一樣多,彼此對得上。
 * 分頁藏起來時 rAF 不跑、動畫照樣跑完(playState 變 finished,就不再碰);藏得比動畫短,回來那一格接著上次畫的位置走。
 *
 * 回傳取消函式:換 key 或卸載時收掉這一輪的迴圈。全部跑完(沒有 running 的)自己停。
 */

/** 一格的時間(60Hz)。卡住時扣回去之後留一格的量給動畫走 */
export const FRAME_MS = 1000 / 60;

/**
 * 兩格之間超過這個才算卡住。比 30Hz 的一格(33ms)長:螢幕本來就 30Hz 或省電降頻時不扣,
 * 不然每一格都被扣成 1/60 秒、整段動畫慢一倍。實測的長任務是 ~48ms + 一格。
 */
export const STALL_MS = 40;

/** 只用到 WAAPI `Animation` 的這兩個欄位(測試給假的) */
type Clocked = Pick<Animation, 'playState' | 'currentTime'>;

export function holdStalls(animations: readonly Clocked[]): () => void {
  let prev = performance.now();
  let id = requestAnimationFrame(function tick(now) {
    const gap = now - prev;
    prev = now;
    const stall = gap > STALL_MS ? gap - FRAME_MS : 0;
    let alive = false;
    for (const a of animations) {
      if (a.playState !== 'running') continue;
      alive = true;
      if (stall > 0) a.currentTime = Math.max(0, Number(a.currentTime ?? 0) - stall);
    }
    if (alive) id = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(id);
}
