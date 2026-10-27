/**
 * 品牌標記。
 *
 * ⚠️ 不可寫死色碼:寫死的話 Logo 的紫跟介面主色會是兩個不一樣的紫,
 * 而且改主色時沒有人會記得回來改它。一律 currentColor / token,顏色由外面決定。
 *
 * ── 要換圖示就改下面這一行 ──
 * 圖示來自 lucide(已經是專案相依),全部 1500+ 個可以在 https://lucide.dev/icons/ 挑,
 * 挑好把名字加進 import、換掉 BRAND_ICON 就好,其他地方都不用動。
 *
 * 幾個候選(都試過大小 20px 還看得清楚):
 *   Speech       側臉 + 音波(不是對話框)  ← 目前用這個
 *   ZodiacAquarius  水瓶座,兩道波浪
 *   Aperture     光圈,幾何、對稱
 *   Orbit        軌道,有一顆小點繞著跑
 *   Radar        雷達掃描,對應「幫你把程式碼掃一遍」
 *   ScanSearch   掃描 + 放大鏡,最貼近它實際在做的事
 *   Waypoints    節點連線,像知識圖譜
 *   Terminal     終端機 —— 它底下就是在跑 claude CLI
 *   Command      ⌘,開發者味
 */
import {Speech} from 'lucide-react';

const BRAND_ICON = Speech;

type Props = {
  size?: number;
  title?: string;
};

/**
 * 線條粗細。
 *
 * 品牌字與圖示**都不要粗**:品牌字不加粗(`global.css`),
 * 這裡是 lucide 預設 2 再細一階。
 * ⚠️ 兩者是綁在一起的(細線配粗字會像「字是粗的、圖不是」),只改一邊就會
 * 變成「一粗一細」。
 */
const BRAND_STROKE = 1.75;

export function Logo({size = 24, title}: Props) {
  return (
    <BRAND_ICON
      size={size}
      strokeWidth={BRAND_STROKE}
      /*
       * ⚠️ 一定要是 currentColor,不能寫死 accent:
       * 品牌列與 AI 頭像把它放進 `--color-accent` 底的黑圓圈裡,
       * accent 上疊 accent = 整顆全黑,icon 完全看不見。
       * 顏色一律由容器決定 —— 圓圈給 `--color-on-accent`(白),
       * 其他地方跟著文字色,深淺模式都自己對。
       */
      color="currentColor"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
}
