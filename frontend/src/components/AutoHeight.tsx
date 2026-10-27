/**
 * 高度跟著內容走,但**用補間**:量內容高度 → 寫成明確的 `height` → transition 接手。
 *
 * 給「內容整塊換掉、高度差很多」的地方用(例如發 QR 的對話框:確認頁 → QR 頁,
 * 高度連跳兩次)。只是「底下長出一塊」的話,用 0fr → 1fr 的殼就好
 * (`AccountSettingsDialog.actionsRow`),那個不用量。
 *
 * - 第一次量到之前不設高度(`auto`),所以掛上那一刻不演。
 *   例外是 `startCollapsed`(見那個 prop)。
 * - 時間 225ms + `--ease-panel`:跟分類卡那一組同一階(`Chat.tsx` 的 `growShell`);
 *   420ms 在大面積上會顯得拖。
 * - 減少動態時沒有補間,直接到新高度。
 * - 內容在補間中會被裁:長高時底下的東西是被慢慢「露出來」的。
 *   ⚠️ 裁切用 `overflow: clip` + `overflow-clip-margin`,
 *   **不是** `overflow: hidden`:hidden 會連裡面按鈕的焦點環一起裁掉(例如載入失敗時的
 *   「重新載入」、QR 頁的「複製金鑰」)。clip-margin 讓框外多留一圈焦點環的寬度
 *   (`--focus-outline-width` + `--focus-outline-offset`);代價是補間中最多多露出這一圈的內容,看不出來。
 *   不支援 `overflow-clip-margin` 的瀏覽器(Safari)照樣裁、焦點環照樣被切。
 *   `clip` 另外的好處:它不是捲動容器,焦點移進被裁的那一段時不會把內容捲上去。
 */
import {useLayoutEffect, useRef, useState} from 'react';

import {Stack} from '@astryxdesign/core/Layout';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  outer: {
    overflow: 'clip',
    overflowClipMargin: 'calc(var(--focus-outline-width) + var(--focus-outline-offset))',
    transition: {
      default: 'height var(--duration-medium-min) var(--ease-panel)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
});

type Props = {
  children: React.ReactNode;
  /**
   * 掛上的那一刻**從 0 長出來**,不是直接用內容的高度(例如 `HostLogin` 的撥接步驟)。
   *
   * 平常第一次量到之前是 `auto`,所以「掛上時內容就已經在」的話會一幀到位 —— 對多數呼叫端這是對的
   * (對話框打開時不該演一次)。但有些地方的「掛上」本身就是使用者看得到的變化:
   * 登入方框按了「連線」之後,頁面把**另一顆**方框(`TerminalSession` 的 `renderConnecting`)換上來,
   * 新的那顆一掛上就帶著三步清單,沒有這個的話清單一幀冒出來、置中的表單往上一跳。
   *
   * 作法:高度先寫 0,在 layout effect 裡**逼瀏覽器先算一次樣式**(讀 `offsetHeight`),
   * 之後 ResizeObserver 量到的真高度才算是一次「改變」,transition 才有起點可補。
   * 內容本來就是空的話量到 0,什麼都不會演。
   */
  startCollapsed?: boolean;
};

export function AutoHeight({children, startCollapsed = false}: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(startCollapsed ? 0 : null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    // startCollapsed:先讓 height: 0 被算過一次(見那個 prop),不然 0 → 真高度會被併成同一次樣式計算、不補間
    if (startCollapsed) void outer.current?.offsetHeight;
    const ro = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
    // 只在掛上時決定一次;之後改 `startCollapsed` 沒有意義(已經不是「掛上的那一刻」)
  }, []);
  return (
    <Stack ref={outer} xstyle={styles.outer} style={height === null ? undefined : {height}}>
      <Stack ref={inner}>{children}</Stack>
    </Stack>
  );
}
