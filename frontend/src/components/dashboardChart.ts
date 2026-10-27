/**
 * dashboard 版面的資料視覺化色票。
 *
 * ⚠️ **這是專案裡唯一一處寫死的「圖表」色票,而且是刻意的。**
 * (寫死色碼的地方不只這裡 —— `components/terminal/ansi-palette.ts` 有整盤
 * 16 色、`ColorPicker.tsx` 與 `brand-hold-scene.ts` 也各有幾個。)
 *
 * 來源是 Astryx 的 `dashboard`(Analytics Dashboard)模板,它自己就寫成
 * `var(--color-data-categorical-blue, #0171E3)` 這個形狀。而
 * `@astryxdesign/theme-neutral` **沒有 `--color-data-categorical-*` 這組 token**
 *(`theme-neutral/dist/theme.css` 與編譯結果裡都找不到),所以在這個專案裡
 * 實際生效的一律是後面那個 fallback。
 *
 * 保留 `var(...)` 的寫法不是裝飾:哪天佈景補上這組 token(或換佈景),
 * 顏色會自動跟著走,不必回來改這個檔。
 *
 * 這跟 `frontend/.claude/CLAUDE.md` 的「不要寫死 hex」慣例是衝突的 —— 整頁照
 * Analytics Dashboard 套用,包含它的圖表引擎與配色。
 * 要改成單色(全部吃 `--color-accent`)的話改這一個檔就夠,不用動各個元件。
 */

export const CHART_COLORS = {
  blue: 'var(--color-data-categorical-blue, #0171E3)',
  orange: 'var(--color-data-categorical-orange, #EB6E00)',
  purple: 'var(--color-data-categorical-purple, #6B1EFD)',
  green: 'var(--color-data-categorical-green, #0B991F)',
  neutral: 'var(--color-data-neutral, #8494A3)',
} as const;

/**
 * 堆疊橫條的取色順序。
 *
 * 超過五類之後一律用 `neutral` —— 再多的顏色分不出來,而那些尾巴本來就該被
 * 讀成「其他」。分類多的時候看的人要的是「前幾名佔多少」,不是每一類各是什麼色。
 */
export const CATEGORICAL_SEQUENCE = [
  CHART_COLORS.blue,
  CHART_COLORS.orange,
  CHART_COLORS.green,
  CHART_COLORS.purple,
  CHART_COLORS.neutral,
] as const;

export function colorAt(index: number): string {
  return CATEGORICAL_SEQUENCE[index] ?? CHART_COLORS.neutral;
}

/** 圖表用的框線 / 座標字色。這兩個 token 佈景裡是有的,照吃。 */
export const CHART_GRID = 'var(--color-border)';
export const CHART_TICK = 'var(--color-text-secondary)';
