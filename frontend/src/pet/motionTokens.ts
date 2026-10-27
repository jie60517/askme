import { durationTokenMs } from "../lib/transitionMs";

/**
 * 小夥伴用 JS 驅動的動畫(framer 的氣泡退場、Web Animations 的回正)要用的設計 token。
 *
 * framer 與 `el.animate()` 都吃不了 `var(--…)`,只好在需要的那一刻去問一次 ——
 * **不要在 JS 抄一份數字**:`theme-neutral` 的值跟 core 的預設本來就不一樣
 * (`--duration-fast-max` 是 165ms 對 230ms,見 `lib/transitionMs.ts` 的 `durationTokenMs`)。
 * 讀不到(測試環境、token 被拿掉)就用 fallback。
 *
 * ⚠️ kit 本來不 import 宿主程式碼;這裡跟 `PetCompanion` 的 `lib/pointerOwner` 一樣是本地例外,
 * 見 `PetCompanion.tsx` 檔頭那張清單。
 */

export type Bezier = [number, number, number, number];

/** 讀一個 CSS 自訂屬性的字串值(去掉前後空白);讀不到回空字串 */
function readToken(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

/** `cubic-bezier(a, b, c, d)` → `[a, b, c, d]`;不是這個形狀(關鍵字、壞值)就回 null */
export function parseCubicBezier(css: string): Bezier | null {
  const m = /^cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/i.exec(css.trim());
  if (!m) return null;
  const nums = m.slice(1, 5).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  // x 座標規定在 0~1 之間,超出的是壞值
  if (nums[0]! < 0 || nums[0]! > 1 || nums[2]! < 0 || nums[2]! > 1) return null;
  return nums as Bezier;
}

/** 緩動 token(例如 `--ease-standard`)換成 framer 吃的 `[a, b, c, d]` */
export function easeTokenBezier(name: string, fallback: Bezier): Bezier {
  return parseCubicBezier(readToken(name)) ?? fallback;
}

/** 緩動 token 換成 `el.animate()` 吃的 easing 字串 */
export function easeTokenCss(name: string, fallback: Bezier): string {
  const b = easeTokenBezier(name, fallback);
  return `cubic-bezier(${b.join(", ")})`;
}

/** 時間 token 的毫秒數:用 `lib/transitionMs.ts` 那一支,這裡不再寫一份解析 */
export { durationTokenMs };

/**
 * 小夥伴動畫用到的那幾個值。`--duration-fast-max` + `--ease-standard` 是設計系統浮層退場那一組
 * (`TerminalSession` 的 scaleIn 也是),fallback 是 theme-neutral 的值。
 */
export const PET_EXIT_DURATION_TOKEN = "--duration-fast-max";
export const PET_EXIT_EASE_TOKEN = "--ease-standard";
export const PET_EXIT_FALLBACK_MS = 165;
export const PET_EXIT_FALLBACK_EASE: Bezier = [0.24, 1, 0.4, 1];
