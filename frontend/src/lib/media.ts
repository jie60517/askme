import {useEffect, useState} from 'react';

/**
 * 「現在是手機版(側邊欄收進抽屜)」。
 *
 * ⚠️ 數字要跟設計系統 `AppShell` 的 `md` 斷點一致(`BREAKPOINT_VALUES.md = 768`,
 * 它的 query 是 `(max-width: 768px)`):抽屜是它切的,我們這邊判斷「在不在抽屜裡」
 * 就得用同一條線。寫成 767 的話,剛好 768 那一格兩邊會不一致。
 *
 * ⚠️ CSS 與 StyleX 都讀不到這個常數,只能各寫一份。**這裡是那份清單的唯一出處** ——
 * 改這裡就要把底下每一處一起改,不然會出現「JS 認為是手機、CSS 認為不是」那一格的怪版面。
 * 同一個 768 另外還寫在這幾處:
 *
 * 1. `components/terminal/TerminalSession.tsx` 的 StyleX `@media` —— 檔案欄 / AskME 欄
 *    在手機改成蓋上去的抽屜(`styles.panel`),兩根 `ResizeHandle` 跟著收起來(`styles.handle`);
 * 2. `styles/global.css` —— 輸入框 footer 換行;
 * 3. `styles/global.css` —— 分類籤 2×2;
 * 4. `styles/global.css` —— `[data-term-panel]`,第 1 項那兩塊抽屜的滑入
 *    (配一份 `and (prefers-reduced-motion: reduce)`);
 * 5. `pages/Chat.tsx` 的 `landingPage` —— 空白頁上緣留白;
 * 6. `styles/pet-shim.css` 的 `@media (min-width: 768px)` —— **方向相反的那一份**,
 *    所以 768px 整數那一格要兩邊一起看(那個檔案自己的註解有寫);
 * 7. `pages/Notes.tsx` 的 StyleX `@media` —— 內文頁的留白;
 * 8. `pages/Terminal.tsx` 的頁籤(`tabLabel` / `tabStatusTextIdle`);
 * 9. `components/workflow/FlowCanvas.tsx` 的 StyleX `@media` —— 接點與圖示縮小。
 *
 * ⚠️ **新增一處寫死 768 的地方,就加進上面那張表,不要在別的檔案裡另外數一個總數。**
 */
export const MOBILE_QUERY = '(max-width: 768px)';

/**
 * 「這台裝置有真正的滑鼠指標」。
 *
 * 用途:只在 hover 才出現的**控制項**(不是資訊)必須有第二條路 —— 觸控裝置上
 * 沒有 hover,那些按鈕會變成永遠碰不到。判到不是精準指標就**一律顯示**。
 * (個人設定的頭像浮層就是這樣做的,見 `AccountSettingsDialog`。)
 *
 * ⚠️ 跟 `styles/global.css` 裡那條 `not ((hover: hover) and (pointer: fine))` 是
 * 同一條線的兩種寫法 —— 一個給 CSS、一個給 JS,改一邊要想到另一邊。
 */
//   抄字面值的(StyleX 的條件鍵只能寫字面值)有 `components/terminal/FilePanel.tsx`、`pages/Terminal.tsx` 的頁籤。改這條要一起改。
export const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}
