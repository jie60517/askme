/**
 * 手機版展開鈕上的「還在跑」小點。
 *
 * 手機上側邊欄是收起來的,問答跑到一半切走之後,畫面上**沒有任何地方**看得出來
 * 伺服器還在幫你算 —— 那顆展開鈕是唯一一直看得到的東西,所以訊號掛在它身上。
 *
 * 那顆鈕是**我們自己的** `MenuToggle`(包著設計系統的 `MobileNavToggle`,掛在 `MobileBrandBar`)。
 * 這裡走「直接在 DOM 上掛屬性、樣式寫在 `global.css`」(跟側邊欄的 `data-pinned` 同一招);
 * 也可以改成直接在 MenuToggle 裡畫(例如放一顆 `StatusDot`),畫面會一樣。
 * 這個元件自己不畫任何東西。
 */
import {useEffect, useState} from 'react';

import {MOBILE_QUERY, useMediaQuery} from '../lib/media';
import {getActiveStreams, subscribeAll} from '../lib/runs';

/**
 * 那顆鈕的 `data-testid`(`MobileNavToggle` 預設寫死的;抽屜裡那顆 MenuToggle 刻意給了另一個 id,見 MenuToggle)。
 * 用它找是因為 `MobileNavToggle` 沒有公開的 class,`aria-controls` 指的是一個每次都不一樣的產生 id(例如 `_r_2_`)。
 * 找不到就什麼都不做 —— 那表示現在不在手機斷點,本來就沒有這顆鈕。
 */
const TOGGLE = '[data-testid="mobile-nav-toggle"]';

function describe(count: number): string {
  return count === 1 ? '1 chat is still answering' : `${count} chats are still answering`;
}

export function RunningNavDot() {
  const [count, setCount] = useState(() => getActiveStreams().length);
  /*
   * ⚠️ 斷點也要當相依:那顆鈕只有手機寬度才存在,而視窗是會被拉的。
   * 只依賴 `count` 的話,「跑著一題然後把視窗縮窄」那條路徑上,
   * effect 不會重跑 —— 鈕出現了,點卻永遠不會出現。
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);

  // `pending` 是就地修改的同一個物件,參照永遠不變 —— 只能靠這個訂閱重算
  useEffect(() => subscribeAll(() => setCount(getActiveStreams().length)), []);

  useEffect(() => {
    /*
     * 每次都重新找一次:那顆鈕只在斷點以下才存在,而視窗是會被拉寬拉窄的。
     */
    const toggle = document.querySelector<HTMLElement>(TOGGLE);
    if (!toggle) return;

    /*
     * ⚠️ 原本的標籤要留一份再改:數字歸零時要還原成它原來那句(MenuToggle 給的 `Open navigation`)。
     * 從 DOM 讀而不是在這裡再寫一份,MenuToggle 改字的時候這邊才不會過期。
     */
    const base = toggle.dataset.baseLabel ?? toggle.getAttribute('aria-label') ?? '';
    toggle.dataset.baseLabel = base;

    if (count > 0) {
      toggle.dataset.running = String(count);
      toggle.setAttribute('aria-label', `${base} — ${describe(count)}`);
    } else {
      delete toggle.dataset.running;
      toggle.setAttribute('aria-label', base);
    }
  }, [count, isMobile]);

  return null;
}
