/**
 * 全站唯一的一條彩虹。
 *
 * ⚠️ **這是刻意的字面色碼例外**(跟 `favicon.svg` 同一類):佈景沒有、也不該有
 * 「彩虹」這種 token —— 它不是語意色,是一個效果。
 *
 * 用它的地方只有兩個,而且都是「慶祝 / 指路」這種一次性的視覺:
 *   - 品牌列長按的彩蛋(`components/brand-hold-scene.ts`)
 *   - 從檔案區跳到某一則之後繞的那一圈(`components/JumpSpotlight.tsx`)
 * **其餘任何地方都不要引用**;要顏色請用 `--color-*`。
 *
 * ⚠️ 這份為什麼**單獨一個檔案**、不放在彩蛋那個場景檔裡:
 * `JumpSpotlight` 是常駐掛載的,而彩蛋的 Canvas 2D 場景是長按才動態載入的
 * (`Sidebar` 的 `void import('./brand-hold-scene')`)。從場景檔 import 顏色
 * 會把整包彩蛋拉進主 chunk,那條動態載入就白做了。
 */
export const RAINBOW_COLORS = [
  '#ff5f5f',
  '#ff9f43',
  '#feca57',
  '#2ecc71',
  '#54a0ff',
  '#5f27cd',
  '#c56cf0',
];
