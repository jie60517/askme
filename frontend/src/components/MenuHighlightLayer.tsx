/**
 * 選單裡那塊會滑的高亮 —— **一份就管全站的選單**。
 *
 * 跟側邊欄那一塊是同一個想法(同一條果凍曲線、同一個 token):
 * 每一列各自上底色的話,滑過去是「這裡亮、那裡亮」兩件事;
 * 一塊會動的則是同一個東西跟著你走。
 *
 * ⚠️ 為什麼是**委派**而不是把選單包起來:
 * 包起來的只有我們自己寫 `menuContent` 的那幾個選單有效 —— 而 `@` 的人名選單、
 * 模型下拉、工具箱那些是**設計系統自己畫的**,插不進任何東西。
 * 所以在 document 上認 `[role=menuitem]` / `[role=option]`,
 * 現在與以後的每一個選單都自動有,不必記得去包。
 *
 * ⚠️ 高亮**一定要畫在選單面板裡面**,不能用 `fixed` 掛在外面。
 * 選單是走 popover 開在 top layer 的 —— top layer 疊在所有一般內容之上,
 * 外面的 fixed 元素不管 z-index 多少都會被整片選單蓋住(等於看不見)。
 * 所以是 `createPortal` 進那個面板 + `absolute`(面板的 `position: relative`
 * 與項目的 z-index 在 global.css 一起下)。
 */
import {useCallback, useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import * as stylex from '@stylexjs/stylex';

import {Stack} from '@astryxdesign/core/Layout';

import {highlightStyles} from './hover-lift';

/**
 * 算數的「一個選項」。
 * 下拉/右鍵選單是 `menuitem`(含 checkbox / radio 兩種變體),
 * `@` 與 `/` 那種打字叫出來的清單是 listbox,項目是 `option`。
 */
const ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';

/** 項目所在的那一塊面板(高亮就畫在它裡面) */
const PANEL_SELECTOR = '[role="menu"], [role="listbox"]';

type Box = {top: number; bottom: number; left: number; right: number};

/**
 * 選單面板開在 anchor 的哪一邊 → morph 從哪個角長出來、往哪個方向落。
 *
 * 比**中心點**:往下開的面板中心在 anchor 下面、翻到上面的在上面;水平同理
 *(下拉選單的 `minWidth` 是 `anchor-size(width)`,至少跟觸發鈕一樣寬,靠左對齊時中心不會在左邊)。
 * 打平就當成預設的左上。
 */
export function menuOrigin(panel: Box, anchor: Box): {x: 'left' | 'right'; y: 'top' | 'bottom'} {
  const mid = (a: number, b: number) => (a + b) / 2;
  return {
    x: mid(panel.left, panel.right) < mid(anchor.left, anchor.right) ? 'right' : 'left',
    y: mid(panel.top, panel.bottom) < mid(anchor.top, anchor.bottom) ? 'bottom' : 'top',
  };
}

/** 讀 / 比對 anchor 名字的寫法跟設計系統的 `Layer/anchorName.ts` 一樣(TS 的型別還沒有這兩個屬性) */
const styleProp = (el: HTMLElement, name: 'positionAnchor' | 'anchorName'): string =>
  (el.style as unknown as Record<string, string | undefined>)[name] ?? '';

/** popover 的 anchor(設計系統把 `position-anchor` 寫在 popover 的行內樣式、`anchor-name` 寫在觸發點上) */
export function findAnchor(popover: HTMLElement): HTMLElement | null {
  const name = styleProp(popover, 'positionAnchor').trim();
  if (!name) return null;
  for (const el of document.querySelectorAll<HTMLElement>('[style*="anchor-name"]')) {
    if (styleProp(el, 'anchorName').split(',').some((n) => n.trim() === name)) return el;
  }
  return null;
}

/**
 * 量一次、把方向寫到 `[role=menu]` 上(global.css 的 `menu-morph-in` 讀這三個變數)。
 *
 * ⚠️ 量的是 **popover 本人**,不是 `[role=menu]`:後者正在 morph(scale 0.7、支點在角上),
 * rect 是縮小又偏到一角的;popover 只有設計系統那個 0.95 的置中縮放,中心點幾乎不動。
 * 量不到(沒有 anchor、還沒排版)就把變數拿掉,回到 CSS 的預設值。
 */
export function orientMenu(popover: HTMLElement): void {
  const menu = popover.matches('[role="menu"]')
    ? popover
    : popover.querySelector<HTMLElement>(':scope > [role="menu"]');
  if (!menu) return;
  const anchor = findAnchor(popover);
  const panel = popover.getBoundingClientRect();
  if (!anchor || (panel.width === 0 && panel.height === 0)) {
    for (const v of ['--menu-origin-x', '--menu-origin-y', '--menu-drop']) menu.style.removeProperty(v);
    return;
  }
  const {x, y} = menuOrigin(panel, anchor.getBoundingClientRect());
  menu.style.setProperty('--menu-origin-x', x);
  menu.style.setProperty('--menu-origin-y', y);
  menu.style.setProperty('--menu-drop', y === 'bottom' ? '1' : '-1');
}

const styles = stylex.create({
  /**
   * 長相共用 `highlightStyles.pill`(見 hover-lift),這裡只補位置。
   * 兩份用**組合**掛上去,不是展開(展開會讓 StyleX 把那個模組當 theme 檔)。
   */
  pill: {
    // 撐滿面板的寬度:項目本來就是整列,高亮比項目窄一圈會看起來像沒對準
    insetInline: 0,
    insetBlockStart: 0,
    /*
     * ⚠️ `height` **不在**過場清單裡:高度是排版屬性,
     * 每一次滑動都在補它的幀。選單項目本來就等高,高度幾乎不變;真的變的時候
     * (子選單的觸發列比較高)讓它直接跳 —— 眼睛讀的是位移,不是那 2px 的高度差。
     * reduced-motion:位移也不做,只留淡入淡出。
     */
    transitionProperty: {
      default: 'transform, opacity',
      '@media (prefers-reduced-motion: reduce)': 'opacity',
    },
  },
});

type Spot = {panel: HTMLElement; top: number; height: number};

export function MenuHighlightLayer() {
  /**
   * ⚠️ 收起來的時候**只改 opacity,位置留著**。位置一起清掉的話,
   * transform 會退回 0 —— 下一次滑上來就是從面板最上面「掉」下來。
   *(側邊欄那塊是同一條規則。)
   */
  const [spot, setSpot] = useState<Spot | null>(null);
  const [isOn, setIsOn] = useState(false);
  /**
   * 這一次是**鍵盤**移過來的:高亮直接跳到位,不滑。
   *
   * 上下鍵在清單裡連按是很頻繁的動作;滑的話高亮永遠追在焦點後面,
   * 按得越快落後越多。滑鼠滑過去才滑 —— 那時候「同一個東西跟著你走」才講得通。
   */
  const [isSnap, setIsSnap] = useState(false);

  const track = useCallback((target: EventTarget | null, isKeyboard: boolean) => {
    if (!(target instanceof Element)) {
      setIsOn(false);
      return;
    }
    const item = target.closest(ITEM_SELECTOR);
    const panel = item?.closest(PANEL_SELECTOR);
    // 滑到不是項目的東西(挑選器那一排圓點、面板的內距)就把高亮收掉,
    // 不然它會停在上一個項目上,看起來像「選著那一項」
    if (!(item instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      setIsOn(false);
      return;
    }
    /*
     * ⚠️ focusin 不等於鍵盤:設計系統的選單在滑鼠滑過去時**也會** focus() 那一項
     * (hover 之後緊接一個 focusin),只看事件種類會把每一次 hover 都判成鍵盤、
     * 高亮從此不再滑。指標還壓在那一項上(`:hover`)就是滑鼠來的;鍵盤移過去的那一項
     * 指標不在它身上。
     */
    const viaKeyboard = isKeyboard && !item.matches(':hover');
    /*
     * 觸發列(會往右展開的)**也吃這一塊**。不要把觸發列跳掉、交給設計系統自己的底 ——
     * 那塊底畫在項目身上(面板內距以內),這一塊鋪滿面板,兩種寬度
     * 擺在同一個選單裡一眼就看得出來。全部走這一塊;
     * 「展開中的路徑」另由 global.css 的 `[aria-expanded='true']::before`
     * 畫一塊同寬同色的補上(這一塊全站只有一份,標不了路徑)。
     * 設計系統給觸發列的 hover/focus/open 底色在 global.css 整組關掉了。
     */
    /*
     * ⚠️ 用 **offsetTop / offsetHeight(排版座標),不要 getBoundingClientRect**。
     *
     * 選單開場有 morph(global.css 的 menu-morph-in,scale 從 0.7 長到 1),
     * 而使用者的指標幾乎總是在選單長出來的當下就壓在某一列上 —— mouseover
     * 在動畫進行中發生,那一刻 getBoundingClientRect 量到的是**縮小中**的
     * rect,高亮就以那個尺寸釘死,看起來永遠短一截。
     * offset* 回的是排版值,transform/scale 不影響它,什麼時候量都是對的。
     *
     * offsetTop 是「相對於 offsetParent」——從項目沿著 offsetParent 鏈
     * 往上加,加到面板為止(面板是 positioned 的,global.css 那條
     * `[role=menu]{position:relative}`,所以一定會出現在鏈上)。
     *
     * (選單項目不浮那 2px,所以不必扣 pendingLift;
     * 側邊欄那塊 HoverRegion 要補 —— 那邊的列會浮。)
     */
    let top = 0;
    let node: HTMLElement | null = item;
    while (node && node !== panel) {
      top += node.offsetTop;
      node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
    }
    // 鏈斷了(面板不在 offsetParent 鏈上 —— 不該發生)就退回視覺量測,
    // 寧可偶爾短一截也不要畫到外太空
    if (node !== panel) {
      const a = item.getBoundingClientRect();
      const b = panel.getBoundingClientRect();
      setSpot({panel, top: a.top - b.top + panel.scrollTop, height: a.height});
      setIsSnap(viaKeyboard);
      setIsOn(true);
      return;
    }
    setSpot({panel, top, height: item.offsetHeight});
    setIsSnap(viaKeyboard);
    setIsOn(true);
  }, []);

  useEffect(() => {
    const onOver = (e: Event) => track(e.target, false);
    // 鍵盤也要跟著走 —— 選單本來就是用上下鍵操作的,
    // 只認滑鼠的話用鍵盤的人完全看不到這個效果。
    // 用捕獲階段:有些面板會擋住冒泡。
    const onFocus = (e: Event) => track(e.target, true);
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, [track]);

  /*
   * 選單的 morph 從哪個角長出來(見 `orientMenu` 與 global.css 的 `menu-morph-in`)。
   *
   * 掛在 `beforetoggle`(popover 要打開的那一刻,同步發生在 `showPopover()` 裡面)——
   * 那時面板還是 `display: none`、量不到,所以排兩次:
   *   - **microtask**:`showPopover()` 回來、觸發它的那支事件處理結束就跑,面板已經排版好
   *     (`getBoundingClientRect` 會當場算完 anchor 定位與翻面),一定在第一幀畫出來之前;
   *   - **requestAnimationFrame**:畫第一幀之前再量一次,補「選單內容是 React 晚一步才畫進去」
   *     那種情況(面板的大小那時才定)。兩次寫的是同一份結果,沒變就沒有成本。
   * `beforetoggle` 不冒泡,所以用捕獲階段在 document 上接。
   * 不支援 Popover API 的瀏覽器(設計系統走行內 `display: block` 的退路)沒有這個事件 → 用 CSS 的預設(左上)。
   */
  useEffect(() => {
    const frames = new Set<number>();
    const onBeforeToggle = (e: Event) => {
      if ((e as Event & {newState?: string}).newState !== 'open') return;
      const popover = e.target;
      if (!(popover instanceof HTMLElement)) return;
      queueMicrotask(() => orientMenu(popover));
      const id = requestAnimationFrame(() => {
        frames.delete(id);
        orientMenu(popover);
      });
      frames.add(id);
    };
    document.addEventListener('beforetoggle', onBeforeToggle, true);
    return () => {
      document.removeEventListener('beforetoggle', onBeforeToggle, true);
      for (const id of frames) cancelAnimationFrame(id);
    };
  }, []);

  /*
   * 選單開著時,滾輪**不准捲到底下那頁**(症狀:在圖示挑選器裡
   * 滾滾輪,整個側邊欄跟著捲)。
   *
   * 光靠 CSS 的 `overscroll-behavior: contain` 不夠 ——
   * 指標落在面板裡**不會捲的區域**(選單項目、內距)時,瀏覽器直接把捲動
   * 交給 DOM 上的祖先(popover 只是畫在 top layer,DOM 還在側邊欄裡),
   * contain 只管「捲到底之後」那一段。所以在 JS 收尾:滾輪目標在面板裡的話,
   * 找它到面板之間**還捲得動**的捲動容器 —— 有就放行(裡面自己會處理,
   * contain 擋外溢),沒有就 preventDefault(這一格滾輪就到此為止)。
   *
   * 放這裡不另開檔案:這個元件本來就是「全站選單的共同行為」的家(委派同一套)。
   *
   * ⚠️ **只管畫在 top layer 的那種面板**(`[popover]`),不是每一個 `role="listbox"`。
   * SSH 檔案欄那份清單也是 `role="listbox"`,但它是**頁面裡的一塊**,捲動容器在它
   * **外面**一層 —— 管到它的話找不到人接、把滾輪吃掉,整欄捲不動。
   * 這條規則存在的理由(「popover 只是畫在 top layer,DOM 還在側邊欄裡」)只適用於浮層。
   *
   * 🚨 **往上找的邊界是「浮層的根」,不是那個 `role=` 的面板**。
   * @ 人名面板本身就是 popover,而它真正會捲的那一層同樣在 `role="listbox"` **外面**:
   *   `[role=listbox]` overflow visible(不會捲)
   *   → 上一層 overflow **auto**(這才是捲動容器)
   *   → … → `[popover]`
   * 邊界切在面板上的話,正好停在那個捲動容器**前面一格**,每一格滾輪都走到 `preventDefault()`。
   * 所以一路找到 `[popover]` 為止:浮層裡面誰捲得動都算數,而浮層**以外**一格都不給
   * (那才是這支 handler 存在的理由:別讓滾輪漏到底下那一頁)。
   */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!(e.target instanceof Element)) return;
      const panel = e.target.closest(PANEL_SELECTOR);
      if (!panel) return;
      const popover = panel.closest('[popover]');
      if (!popover) return;
      let node: Element | null = e.target;
      while (node) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const style = getComputedStyle(node);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            const up = e.deltaY < 0;
            const canScroll = up
              ? node.scrollTop > 0
              : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
            if (canScroll) return; // 裡面自己捲,不擋
          }
        }
        if (node === popover) break; // 浮層的根 —— 再上去就是底下那一頁了
        node = node.parentElement;
      }
      e.preventDefault(); // 沒有人接得住這一格 —— 吃掉,別讓底下那頁動
    };
    // passive:false 才能 preventDefault(wheel 預設是 passive 的)
    document.addEventListener('wheel', onWheel, {passive: false, capture: true});
    return () => document.removeEventListener('wheel', onWheel, {capture: true} as EventListenerOptions);
  }, []);

  /*
   * 面板關掉之後那個節點就不在文件裡了 —— 留著會把 portal 畫到孤兒節點上。
   * 每次要畫之前確認它還連著,沒連著就整個丟掉(下一次開選單自然會重新量)。
   */
  if (spot && !spot.panel.isConnected) {
    return null;
  }

  return spot
    ? createPortal(
        <Stack
          aria-hidden
          xstyle={[highlightStyles.pill, styles.pill]}
          style={{
            transform: `translate3d(0, ${spot.top}px, 0)`,
            height: spot.height,
            opacity: isOn ? 1 : 0,
            // 鍵盤移過來就直接到位(見 isSnap):只把 transform 拿出過場清單,
            // 淡入淡出留著 —— 鍵盤走到最後一項再關選單,高亮還是要淡掉不是消失。
            // 滑鼠那條路留給 class 上的清單。
            ...(isSnap ? {transitionProperty: 'opacity'} : null),
          }}
        />,
        spot.panel,
      )
    : null;
}
