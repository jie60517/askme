/**
 * 手機版的品牌列:`[選單鈕] [logo + AskME 置中] [跟選單鈕同寬的空位]`。
 *
 * 畫在兩個地方,長得一樣:
 * - **頂列**(`App.tsx` 交給 `AppShell` 的 `banner` 插槽):鈕是兩條槓,按了開抽屜。
 * - **抽屜標頭**(`Sidebar.tsx` 在手機版把它當 `header`):鈕已經是 X,按了關抽屜。
 *   抽屜從左邊滑進來蓋住頂列時,兩顆鈕位置重合,看起來是同一顆在變形
 *   (見 `MenuToggle`)。
 *
 * 三件事都在這裡:鈕在左上、AskME 在中間、
 * 長按的膠囊只包住品牌字(`BrandHold variant="bar"`)。
 *
 * 為什麼不用 `AppShell` 自帶的手機頂列:它把 `SideNav` 用 topbar 模式畫成
 * `[品牌列(撐滿)] [漢堡鈕(右)]`,鈕的位置與圖示都不開放,而且品牌列撐滿整條
 * 會讓空白區域的寬度占比太多。`mobileNav={{hasToggle: false}}`
 * 之後它整條不畫,抽屜本身照舊由它管。
 */
import * as stylex from '@stylexjs/stylex';

import {HStack, Stack} from '@astryxdesign/core/Layout';
import {SideNavHeading} from '@astryxdesign/core/SideNav';

import {BRAND_LOGO_SIZE, BRAND_NAME} from '../lib/brand';
import {BrandHold} from './BrandHold';
import {Logo} from './Logo';
import {MenuToggle} from './MenuToggle';

const styles = stylex.create({
  /** 頂列:自己撐 48px 高、左右各 8px(照設計系統 autoMobileTopBar 的尺寸) */
  bar: {
    width: '100%',
    height: 'var(--spacing-12)',
    paddingInline: 'var(--spacing-2)',
    boxSizing: 'border-box',
  },
  /** 抽屜標頭:外面那層(MobileNav 的 header)已經有高度與內距,這裡只要撐滿 */
  barInDrawer: {
    flexGrow: 1,
    minWidth: 0,
  },
  /** 中間那格:吃掉剩下的寬度,品牌字在裡面置中 */
  center: {
    flexGrow: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  /**
   * 右邊的空位:跟左邊的選單鈕同寬(icon-only md 鈕 = --spacing-8),
   * 品牌字才會真的在整條的正中間,而不是「扣掉鈕之後的中間」。
   */
  spacer: {
    width: 'var(--spacing-8)',
    flexShrink: 0,
  },
});

export function MobileBrandBar({isDrawer = false}: {isDrawer?: boolean}) {
  return (
    <HStack
      gap={2}
      vAlign="center"
      xstyle={isDrawer ? styles.barInDrawer : styles.bar}
      /*
       * 抽屜標頭掛一個自己的記號:global.css 靠它把設計系統**內建的**關閉鈕藏起來
       * (關閉改由左邊那顆 X 負責,留著會有兩顆)。
       * ⚠️ 掛在這裡而不是用結構選擇器去數 `.astryx-mobile-nav > div > div > button`:
       * 那要依賴兩層沒有名字的容器,而且依賴內建的鈕永遠排在最後 —— 設計系統升版
       * 就會靜靜地失效(兩顆 X 一起出現)。這是這個專案處理同類問題的做法
       * (同 `RunningNavDot` 的 data-* / `data-composer-footer`)。
       */
      {...(isDrawer ? {'data-drawer-header': ''} : {})}
    >
      <MenuToggle isInDrawer={isDrawer} data-testid={isDrawer ? 'mobile-nav-close' : undefined} />
      <Stack xstyle={styles.center}>
        <BrandHold variant="bar">
          <SideNavHeading heading={BRAND_NAME} icon={<Logo size={BRAND_LOGO_SIZE} />} headingHref="/" />
        </BrandHold>
      </Stack>
      <Stack aria-hidden xstyle={styles.spacer} />
    </HStack>
  );
}
