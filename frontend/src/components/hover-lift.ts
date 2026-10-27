import * as stylex from '@stylexjs/stylex';

/**
 * 「滑過去的東西會浮起來一點點」——跟著它跑的高亮塊要用到的計算。
 *
 * 效果本身是 CSS 做的(`global.css` 的 `--row-float`),這裡**不另外寫一個數字**:
 * 兩邊對不上就會差 2px,而那是最難查的那種偏移。
 */

/**
 * 這個元素**還差多少**才浮到定位(px)。
 *
 * 高亮塊的位置是在 mouseover 當下量的 —— 那一刻轉場才剛開始,
 * 量到的是還沒浮起來的位置。右鍵(或鍵盤移過去)時它**已經**浮好了,
 * 那時候要補的是 0。少了這個補償,同一塊高亮在兩條路徑上會差 2px。
 */
export function pendingLift(el: Element): number {
  const style = getComputedStyle(el);
  const target = parseFloat(style.getPropertyValue('--row-float')) || 0;
  // translate: "none" / "0px" / "0px -2px"
  const y = style.translate.split(' ')[1];
  const now = y ? -parseFloat(y) : 0;
  return target - (Number.isFinite(now) ? now : 0);
}

/**
 * 那塊「會滑的高亮」長什麼樣子 —— **兩塊共用同一份**。
 *
 * 側邊欄那塊(`Sidebar` 的 `HoverRegion`)與選單那塊(`MenuHighlightLayer`)
 * 是同一個東西的兩個宿主:一個定在某一區裡面、還要能被右鍵釘住,
 * 一個是委派到當下那個選單面板裡(popover 開在 top layer,外面的畫不進去)。
 * **行為不同、長相必須相同** —— 顏色、圓角、影子、曲線各寫一份的話,
 * 改了其中一邊就會變成兩種手感。
 *
 * ⚠️ 用**組合**(`xstyle={[highlightStyles.pill, 自己那份]}`),不要用展開:
 * StyleX 的 `stylex.create` 裡展開別的模組匯出的物件,編譯器會把那個模組
 * 當成 theme 檔(要 `.stylex.ts` 副檔名)而整個 build 失敗。
 *
 * 位置相關的(`inset*`、`transitionProperty` 要不要含 width)留給各自的宿主:
 * 選單那塊撐滿面板寬度,側邊欄那塊要跟著每一列的寬度。
 */
export const highlightStyles = stylex.create({
  pill: {
    position: 'absolute',
    zIndex: 0,
    pointerEvents: 'none',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-overlay-hover)',
    boxShadow: 'var(--shadow-low)',
    // 快一點:medium(0.3s)在兩列之間滑會覺得拖泥帶水。
    // fast-max 是「還看得到過程,但已經到了」的那個長度。
    // ⚠️ reduced-motion 不在這裡壓時間:要拿掉的是**位移**,
    // 淡入淡出留著 —— 這兩塊高亮各自在 `transitionProperty` 裡把 transform 拿掉;
    // `[data-hover-lift]` 那三種宿主則是靠 `--row-float` 歸零(位移目標是 0,清單裡
    // 留著 translate 也沒東西可動)。
    transitionDuration: 'var(--duration-fast-max)',
    transitionTimingFunction: 'var(--row-float-ease)',
  },
});
