/**
 * 放手那一刻的速度 —— 燈箱左右滑(`components/FileLightbox.tsx`)用這一份。要算放手速度的地方都用它,
 * 不要另寫一支:各寫各的話單位(px/s 或 px/ms)與「停住才放」的判法會分岔。
 *
 * **單位寫在名字上:px/ms。** 要 px/s 的呼叫端自己乘 1000。
 */

/** 一筆指標位置。`y` 可省(只看橫向的手勢,例如燈箱的左右滑),省略當 0。 */
export type VelocitySample = {x: number; y?: number; t: number};

/** 速度只看放手前這麼久(ms)。整段平均會把「停住再放」算成還在動。 */
export const RELEASE_WINDOW_MS = 100;

/**
 * 最近 `windowMs` 內第一筆到最後一筆的平均速度(px/ms)。
 *
 * - `now`:放手的時間(通常是 pointerup 的 `timeStamp`),窗口從它往回算;省略就用最後一筆的時間。
 * - **手指停住一下才放 = 0**:窗口裡只剩一筆(或沒有)就沒有速度。呼叫端最好把 pointerup 那一筆
 *   也放進 `samples` —— 只靠 pointermove 的話,「甩到一半停住、過一會兒才抬手」也會因為 `now`
 *   把舊的那幾筆擠出窗口而得到 0,兩種寫法結果一致。
 */
export function releaseVelocityPxPerMs(
  samples: readonly VelocitySample[],
  now?: number,
  windowMs: number = RELEASE_WINDOW_MS,
): {x: number; y: number} {
  if (samples.length === 0) return {x: 0, y: 0};
  const end = now ?? samples[samples.length - 1].t;
  const recent = samples.filter((s) => end - s.t <= windowMs);
  if (recent.length < 2) return {x: 0, y: 0};
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (!(dt > 0)) return {x: 0, y: 0};
  return {x: (b.x - a.x) / dt, y: ((b.y ?? 0) - (a.y ?? 0)) / dt};
}
