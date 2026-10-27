/**
 * 手機版的選單鈕(左上角的展開鈕)—— **兩條槓 ⇄ X 的同一顆鈕**。
 * 點下去兩條槓從右邊往內交叉成 X、打開選單;點 X 再演回兩條槓、關掉選單。
 *
 * ## 圖形
 *
 * 兩條 2px 的槓,閉著時上下各離中線 4px。開著時**收到中線並各轉 ±45°**,
 * 合起來是一個 X。
 *
 * ⚠️ **X 的筆畫跟兩條槓一樣長,終點不縮放**。乘 `1/√2` 讓 X 的外接方框等於 16
 * 是把筆畫剪短 —— 兩者擺在一起時看得出來是兩種長度。
 * 只旋轉不縮放:筆畫一樣 16px,轉 45° 之後外接方框自然是 11.3px,
 * 仍然落在 16px 的圖示框裡,粗細也還是 2px。
 *
 * ## 動畫
 *
 * 「從右邊往內交叉」分兩段:先讓**右端**往內收(橫向縮短,同時往左補一段位移,
 * 所以左端不動、只有右端在跑 —— 見 `RIGHT_PULL`),再轉到 ±45° 交叉。
 *
 * ⚠️ 支點是**正中心**,不要改成 `left center`:改成左端的話兩條槓
 * 旋轉時共用左邊那一點、往右張開成一個「‹」箭頭,不是 X。
 * X 的交叉點要落在圖示正中間,支點就只能在中心;「從右邊」的感覺交給位移做。
 *
 * ⚠️ **這顆鈕會出現在兩個地方,而且動畫的機制不一樣**:
 * - **頂列那顆**一直掛著,狀態一翻就有 `transition`,開跟關都看得到。
 * - **抽屜標頭那顆是抽屜打開時才掛上去的**,一出生就已經是 X ——
 *   `transition` 對「剛掛上來的元素」不會播,看起來就是沒有動畫。
 *   那顆改用 `animation`(keyframes 在掛載當下就會播一次),把兩條槓折成 X 演出來。
 *   關的時候抽屜那顆被卸掉,換頂列那顆演 X → 兩條槓。
 *
 * ⚠️ 關的那一趟要**等面板讓開再演**(見 `CLOSE_DELAY`):抽屜是一片 320px 的面板
 *   往左滑出,而頂列那顆鈕就在左上角 8～40px —— 面板滑出去要 `--duration-medium`,
 *   鈕的過場也是 `--duration-medium`,兩個同時開始的話整段折疊都在面板背後演完,
 *   使用者看到的是「面板走了,鈕已經是兩條槓」,等於沒有動畫。
 *   **不要把抽屜那顆改回 transition,也不要拿掉關閉的延遲** —— 兩個都會讓動畫消失。
 */
import * as stylex from '@stylexjs/stylex';

import {useAppShellMobile} from '@astryxdesign/core/AppShell';
import {Stack} from '@astryxdesign/core/Layout';
import {MobileNavToggle} from '@astryxdesign/core/MobileNav';

/**
 * 過場**中途**把槓縮短的比例(`1/√2`)。只用在中間那一格,終點會回到 1 ——
 * 筆畫長度必須跟閉著時一致(見檔案開頭)。
 */
const MID_SCALE = 0.7071;

/**
 * 縮短的時候往左補的位移。
 *
 * `scaleX` 的支點在**中心**,所以縮短是兩端各往內收 `(1 - MID_SCALE) / 2`;
 * 往左補同樣的量之後,左端回到原位、**只剩右端在動** —— 也就是「從右邊往內」。
 * 支點不能改成左端:那樣旋轉時兩條槓會共用左邊那一點,張開成「‹」箭頭而不是 X。
 */
const RIGHT_PULL = `calc(var(--spacing-4) * ${(1 - MID_SCALE) / 2})`;

/** 閉著時兩條槓離中線的距離(上 -4px / 下 +4px),用的是 --spacing-1 */
const BAR_OFFSET = 'var(--spacing-1)';

/**
 * 關閉時晚一個抽屜滑出的時間再演(理由見檔案開頭)。
 *
 * ⚠️ 只掛在**閉著**那一組樣式上:CSS 的 transition-delay 取自「要轉去的那個狀態」,
 * 所以這條只會延後 X → 兩條槓;開的那一趟(轉去 open)沒有延遲。
 * 值跟抽屜的滑出時間同一個 token,設計系統調了兩邊會一起動。
 *
 * ⚠️ reduced-motion 下歸零:那時候抽屜沒有滑出動畫、槓也不補間
 * (`bar` 的 `transitionDuration` 是 0s),留著這 300ms 只是讓 X 白等一下才變回兩條槓。
 */
const CLOSE_DELAY = {
  default: 'var(--duration-medium)',
  '@media (prefers-reduced-motion: reduce)': '0s',
};

/** 交叉之後的樣子:回到中線、各轉 ±45°,**長度不變** —— 一個正 X */
const X_TOP = 'translate(0, 0) rotate(45deg)';
const X_BOTTOM = 'translate(0, 0) rotate(-45deg)';

/*
 * 兩條槓折成 X 的過場,三個階段:
 * 1. 0%   兩條平行,各自離中線 4px
 * 2. 45%  **右端**先往內收(縮短 + 往左補位移),還沒轉 —— 這是「從右邊往內」
 * 3. 100% 轉到 ±45° 交叉成 X,長度回到 1(筆畫跟閉著時一樣長)
 *
 * ⚠️ 上下兩條的角度**符號相反**,所以要兩組;共用一組會變成兩條疊在一起。
 */
const FOLD_TOP = stylex.keyframes({
  '0%': {transform: `translate(0, calc(${BAR_OFFSET} * -1)) rotate(0deg) scaleX(1)`},
  '45%': {
    transform: `translate(calc(${RIGHT_PULL} * -1), calc(${BAR_OFFSET} * -1)) rotate(0deg) scaleX(${MID_SCALE})`,
  },
  '100%': {transform: X_TOP},
});

const FOLD_BOTTOM = stylex.keyframes({
  '0%': {transform: `translate(0, ${BAR_OFFSET}) rotate(0deg) scaleX(1)`},
  '45%': {
    transform: `translate(calc(${RIGHT_PULL} * -1), ${BAR_OFFSET}) rotate(0deg) scaleX(${MID_SCALE})`,
  },
  '100%': {transform: X_BOTTOM},
});

const styles = stylex.create({
  /** 圖示的框:跟設計系統 sm 圖示同尺寸(16px),兩條槓在裡面絕對定位 */
  glyph: {
    position: 'relative',
    width: 'var(--spacing-4)',
    height: 'var(--spacing-4)',
    flexShrink: 0,
  },
  bar: {
    position: 'absolute',
    insetInlineStart: 0,
    insetInlineEnd: 0,
    top: '50%',
    // 2px 粗(--spacing-0-5),圓頭
    height: 'var(--spacing-0-5)',
    marginBlockStart: 'calc(var(--spacing-0-5) / -2)',
    borderRadius: 'var(--radius-full)',
    backgroundColor: 'currentColor',
    // ⚠️ 支點在**中心**:X 的交叉點才會落在圖示正中間。
    // 「從右邊往內」靠 keyframes 的位移做(見 RIGHT_PULL),不是靠改支點。
    transformOrigin: 'center',
    transitionProperty: 'transform',
    transitionDuration: {
      default: 'var(--duration-medium)',
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionTimingFunction: 'var(--ease-standard)',
  },
  barTop: {
    transform: `translate(0, calc(${BAR_OFFSET} * -1))`,
    transitionDelay: CLOSE_DELAY,
  },
  barBottom: {
    transform: `translate(0, ${BAR_OFFSET})`,
    transitionDelay: CLOSE_DELAY,
  },
  barTopOpen: {transform: X_TOP},
  barBottomOpen: {transform: X_BOTTOM},
  /**
   * 抽屜裡那顆:掛上來的當下把「折成 X」演一次(見檔案開頭的說明)。
   * `forwards` 讓它停在 X;reduced-motion 直接跳到終點。
   */
  foldTop: {
    animationName: FOLD_TOP,
    animationDuration: {
      default: 'var(--duration-medium)',
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    animationTimingFunction: 'var(--ease-standard)',
    animationFillMode: 'forwards',
  },
  foldBottom: {
    animationName: FOLD_BOTTOM,
    animationDuration: {
      default: 'var(--duration-medium)',
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    animationTimingFunction: 'var(--ease-standard)',
    animationFillMode: 'forwards',
  },
});

export function MenuToggle({
  isInDrawer = false,
  'data-testid': testId,
}: {
  /** 這顆畫在抽屜標頭裡(掛上來就是 X,要用 animation 補那段過場) */
  isInDrawer?: boolean;
  /**
   * ⚠️ 抽屜那顆要給**不一樣**的 id。`MobileNavToggle` 預設是寫死的
   * `mobile-nav-toggle`,而 `RunningNavDot` 用 `querySelector` 找那個 id
   * 去掛「還在跑」的小點 —— 兩顆同名的話,抽屜一開文件裡就有兩個相符的元素,
   * 小點會掛到哪一顆變成看 DOM 順序。分開命名才咬得住頂列那一顆。
   */
  'data-testid'?: string;
}) {
  const {isMobileNavOpen: isOpen} = useAppShellMobile();
  return (
    <MobileNavToggle
      label={isOpen ? 'Close navigation' : 'Open navigation'}
      data-testid={testId}
    >
      <Stack aria-hidden xstyle={styles.glyph}>
        <Stack
          xstyle={[
            styles.bar,
            isOpen ? styles.barTopOpen : styles.barTop,
            isInDrawer && styles.foldTop,
          ]}
        />
        <Stack
          xstyle={[
            styles.bar,
            isOpen ? styles.barBottomOpen : styles.barBottom,
            isInDrawer && styles.foldBottom,
          ]}
        />
      </Stack>
    </MobileNavToggle>
  );
}
