/**
 * 側邊欄的邊線:拖曳改寬度、拖過頭收合、收合時按一下展開。
 *
 * 為什麼不用 SideNav 內建的 `resizable`:
 * 1. 它的命中區定位是錯的 —— 往上偏了自己高度的一半,
 *    所以只有畫面上半部抓得到,下半部完全沒有反應。
 * 2. 收合時它會把當下量到的寬度(0)寫進 autoSaveId,重新載入側邊欄就變成 0px 寬,
 *    看起來像整個消失。
 * 3. 收合時它自己會隱藏,於是沒有東西可以把側邊欄叫回來。
 *
 * 這裡一次解決:整條邊都是把手、寬度永遠夾在範圍內、收合時仍然在。
 * 行為:220–420、拖到 < 170 放開就收合、鍵盤 ←→ 每次 16px、
 * Home/End 到極值、Enter/Space 切換收合。
 */
import {useCallback, useEffect, useRef, useState, type RefObject} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Stack} from '@astryxdesign/core/Layout';

import {createPointerOwner} from '../lib/pointerOwner';
import {clampElastic as clampElasticBy} from '../lib/rubberband';

export const MIN_WIDTH = 220;
export const MAX_WIDTH = 420;
/**
 * 預設寬度。
 * ⚠️ 只影響「還沒調過寬度的人」—— 調過的存在 localStorage,不會被這個值蓋掉。
 */
export const DEFAULT_WIDTH = 305;
/**
 * 拖到比這個還窄就放手 = 收合。
 *
 * ⚠️ **這是收合的唯一條件**,沒有「往左甩得夠快就收合」的速度捷徑。
 *
 * 速度捷徑的問題是**它沒有距離下限**:速度 = 位移 ÷ 時間,所以「往左推 12px、花 80ms」
 * 就是 0.15 px/ms —— 使用者只是想把側邊欄調窄一點,手一快就整條收掉,
 * 而且**寬度還會被還原成拖之前的值**(見 `widthBeforeDrag`),看起來像「調寬度失敗」。
 * 真正想收合的人會一路拖到底,由這個距離門檻接住就夠了。
 * **要加速度捷徑的話一定要配一個距離下限**(至少 `MIN_WIDTH - COLLAPSE_THRESHOLD`),
 * 不要只看速度。
 */
const COLLAPSE_THRESHOLD = 170;
const STEP = 16;
/**
 * 按下去到放開之間動了幾 px 才**算拖曳**(而不是點一下)。
 *
 * ⚠️ 沒有這道門檻的話,`onMove` 一進來就把 `dragged` 設成 true ——
 * 觸控板點一下常有 1–2px 的漂移,於是「點邊界切換收合」變成有時有、有時沒有,
 * 而且**收合狀態下是完全沒反應**(`onUp` 判成拖曳,而收合中那條路直接 return)。
 *
 * 6 跟 `useLongPressDrag` 的 `DRAG_MIN_MOVE` 同一個數 —— 同一個 repo 裡
 * 「多少距離才算真的在拖」應該只有一個答案。
 */
const CLICK_SLOP = 6;
/**
 * 鍵盤調完寬度之後多久才把寬度過場放回來。
 * 要比按鍵重複的間隔(~30ms)大,又要小到放手時感覺不出殘留。
 */
const KEY_SETTLE_MS = 120;
/**
 * 邊線的感應寬度與拖曳中那條線的寬度。
 *
 * 都是「手指按得到」的人因尺寸,不是間距 —— 設計系統沒有對應的 token,
 * 套一個 spacing 只會讓下次調命中區的人找不到該改哪裡。
 * 線比感應區窄一半:感應區要好按,線只是回饋。
 */
const HIT_WIDTH = 12;
const INDICATOR_WIDTH = 6;

const styles = stylex.create({
  hitArea: {
    position: 'fixed',
    width: HIT_WIDTH,
    cursor: 'col-resize',
    zIndex: 5,
    touchAction: 'none',
  },
  indicator: {
    position: 'absolute',
    insetBlockStart: 0,
    insetBlockEnd: 0,
    insetInlineStart: (HIT_WIDTH - INDICATOR_WIDTH) / 2,
    width: INDICATOR_WIDTH,
    borderRadius: 'var(--radius-full)',
    backgroundColor: 'var(--color-accent)',
    opacity: 0.35,
  },
});

const clamp = (v: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v));

/**
 * 拖過邊界之後還能再走一點、但越拉越沉(曲線在 `lib/rubberband.ts`,頭像裁切與檔案欄欄寬共用)。
 * 硬夾住的話畫面完全不動,跟「拖曳斷了」長得一樣;使用者要知道的是「到頭了」而不是「壞了」。
 * 拖曳中用這個(可以超界);放手時仍然用 clamp 收回來。
 */
const clampElastic = (v: number) => clampElasticBy(v, MIN_WIDTH, MAX_WIDTH);

type Props = {
  navRef: RefObject<HTMLElement | null>;
  width: number;
  isCollapsed: boolean;
  onWidthChange: (width: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
};

export function SidebarResizer({
  navRef,
  width,
  isCollapsed,
  onWidthChange,
  onCollapsedChange,
}: Props) {
  const [box, setBox] = useState<{left: number; top: number; height: number} | null>(null);
  const [isActive, setIsActive] = useState(false);
  /** 拖曳過程中的即時寬度,放手才決定要收合還是套用 */
  const liveWidth = useRef(width);
  /**
   * 進入拖曳那一刻要扣掉的死區位移(見 `CLICK_SLOP`)。
   *
   * ⚠️ **一定要是 ref,不能放在底下那支 effect 裡當 `let`。** 那支 effect 的相依含
   * `isCollapsed` 與 `width` —— 收合狀態往右拖過門檻會 `onCollapsedChange(false)`,
   * effect 當場重掛,區域變數歸零而 `dragged`(ref)還是 true,於是寬度跳 6px,
   * 正好是這個機制要避免的事。
   */
  const slop = useRef(0);
  const dragged = useRef(false);
  /** 這次拖曳開始前的寬度 —— 拖到收合之後要還原成這個,不是還原成拖到一半的窄值 */
  const widthBeforeDrag = useRef(width);
  /**
   * 這次拖曳的起點 x —— 拿來扣掉 `CLICK_SLOP` 那段死區(見 `onMove`)。
   * 只存 x:這條是垂直的邊線,手勢只有水平那一維有意義。
   * 跟寬度一樣走 ref 不走 state:拖曳路徑刻意不重繪。
   * 不記起始時間:收合不看速度(見 `COLLAPSE_THRESHOLD`)。
   */
  const startX = useRef(0);
  /** 這一次拖曳歸哪一根指標管(多點觸控保護,規則見 `lib/pointerOwner.ts`) */
  const owner = useState(createPointerOwner)[0];
  /** 這條感應帶自己。拖曳中直接寫它的 inline style,不走 `box` 那個 state —— 見 `onMove`。 */
  const hitRef = useRef<HTMLElement | null>(null);

  // 位置用 fixed + 量測:SideNav 的根元素不保證是 positioned ancestor,
  // 用 absolute 會對齊到更外層,位置整個跑掉。
  //
  // ⚠️ **拖曳中不走這裡**(`isActive` 時整支跳過):那時候寬度每一格都在變,
  // 每一格都 `setBox` 等於每一幀多一次 React 提交 —— 而拖曳那條路徑是
  // 刻意不重繪的(見 `onMove`)。拖曳中這條帶子的位置由 `onMove` 直接寫 inline style,
  // 放手之後這支 effect 會再跑一次(`isActive` 翻回 false)把 state 對回來。
  useEffect(() => {
    const el = navRef.current;
    if (!el || isActive) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({left: r.right - HIT_WIDTH / 2, top: r.top, height: r.height});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [navRef, isCollapsed, width, isActive]);

  /**
   * 拖曳期間掛 window 監聽,而不是只靠 setPointerCapture。
   * 快速拖曳時指標會離開這條 12px 的細帶,只靠元素自己的事件會斷在半路;
   * 而 setPointerCapture 在某些情況下會丟例外(例如那個 pointerId 已經不在了),
   * 一丟例外整個 handler 就中斷了。capture 當成加分項,包在 try 裡。
   */
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 已經有別的指標在拖了(第二根手指、別種指標):不理。收尾漏了的話這一下接手重來,
      // 底下照常把起點重設(`isActive` 本來就是 true,window 監聽不用重掛)
      if (owner.claim(e) === 'ignored') return;
      e.preventDefault();
      dragged.current = false;
      slop.current = 0;
      liveWidth.current = width;
      widthBeforeDrag.current = width;
      startX.current = e.clientX;
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 沒抓到就算了,下面的 window 監聽才是主力
      }
      setIsActive(true);
    },
    [owner, width],
  );

  useEffect(() => {
    if (!isActive) return;

    /*
     * 拖曳中在側邊欄上掛 `data-resizing`:global.css 給寬度的變化加了過場動畫
     * (收合 / 展開用的,見那條規則),但拖曳時寬度每一格都在變,再過場就會
     * 慢半拍、跟不上手 —— 這個屬性在的時候那條動畫不套。
     * 照這個專案處理「跟設計系統元件講話」的做法直接掛屬性(同 RunningNavDot)。
     */
    const nav = navRef.current;
    nav?.setAttribute('data-resizing', '');

    /*
     * ⚠️ **拖曳中不呼叫 `onWidthChange`** —— 寬度直接寫進 DOM。
     *
     * 寬度的 state 住在 `Sidebar` 上,每一個 `pointermove` 都 `setWidth` 的話,
     * 一動就是**整個側邊欄重繪**(所有對話列、共用區、資料夾、hover 層),
     * 拖曳時每一幀都是一個 long task,明顯掉幀。
     *
     * 瀏覽器本來就會因為 `<nav>` 寬度變了而重排版面 —— 那一份是必要的;
     * 要省掉的是「順便把整棵 React 樹重算一遍」。放手時再 `onWidthChange` 一次,
     * 那一次的重繪使用者看不到(手已經停了)。
     *
     * ⚠️ `left` 用 `startLeft` 那個定值,不要每一幀 `getBoundingClientRect()` ——
     * 那是一次強制排版(forced reflow),而且 `<nav>` 的左緣在拖曳中本來就不會動。
     * ⚠️ 這條帶子自己的位置也要跟著手走,同樣直接寫 inline style:
     * 走 `setBox` 的話剛剛省掉的那次提交又回來了。
     */
    const startLeft = navRef.current?.getBoundingClientRect().left ?? 0;

    /*
     * 進入拖曳的那一刻要把「門檻那段」扣掉,不然寬度會當場跳 6px。
     *
     * ⚠️ **最多只扣 `CLICK_SLOP`**,不是扣掉第一個 move 的整段位移 ——
     * 快速拖曳時第一個 `pointermove` 可能一次就跳好幾十 px,整段扣掉的話這一趟從頭到尾都跟游標差那麼多,
     * 使用者會覺得邊界黏不住手。扣 6px 是死區的標準做法:寬度仍然跟著游標的
     * 絕對位置走,只差一個固定的小量。
     * (值住在 `slop` 這支 ref 裡 —— 理由見它的宣告處,放這裡當區域變數會被重掛清掉。)
     */

    const onMove = (e: PointerEvent) => {
      // 只認按下去的那一根(見 owner)
      if (!owner.owns(e)) return;
      if (!dragged.current) {
        const dx = e.clientX - startX.current;
        if (Math.abs(dx) <= CLICK_SLOP) return;
        dragged.current = true;
        slop.current = Math.sign(dx) * CLICK_SLOP;
      }
      const next = e.clientX - startLeft - slop.current;
      liveWidth.current = next;
      // 收合狀態下往右拖:先展開,使用者才看得到自己在拉什麼
      if (isCollapsed && next > COLLAPSE_THRESHOLD) onCollapsedChange(false);
      if (isCollapsed) return;
      // 超過上下限還能再走一小段但越拉越沉(見 clampElastic);
      // 放手時才用 clamp 收回合法範圍。收合判定看的是上面那個原始的 liveWidth。
      const shown = clampElastic(next);
      if (nav) nav.style.width = `${shown}px`;
      if (hitRef.current) hitRef.current.style.insetInlineStart = `${startLeft + shown - HIT_WIDTH / 2}px`;
    };

    const onUp = (e: PointerEvent) => {
      if (!owner.owns(e)) return;
      owner.release();
      setIsActive(false);
      /*
       * ⚠️ **`data-resizing` 要在通知收合之前拿掉,而且是同步拿。**
       *
       * 那個屬性把 `<nav>` 的 width 過場關掉了(見上面),而呼叫端是
       * **量 CSS 的 duration 來決定要不要演**的(`lib/transitionMs.ts`)
       * —— 屬性還掛著的時候它量到 **0**,於是走「沒有過場」那條路:當場切過去,
       * 收合完全沒有動畫(只有第一次會演:那時 `pointerdown` 的 effect 還沒把屬性掛上去)。
       * ⚠️ 靠底下 effect 的 cleanup 移除是**來不及**的:那也要等下一次提交,
       * 而那時候呼叫端早就量完了。
       */
      nav?.removeAttribute('data-resizing');
      // 只是按一下沒有拖:當作切換收合
      if (!dragged.current) {
        onCollapsedChange(!isCollapsed);
        return;
      }
      if (isCollapsed) return;

      /*
       * (`data-resizing` 已經在上面拿掉了 —— 它要早於任何一條收合/寬度的路徑:
       * 屬性還在的時候寬度過場是關掉的,回彈那一段會瞬間跳回邊界。)
       */
      // 收合只看**拖到哪裡**,不看拖多快(理由見 `COLLAPSE_THRESHOLD`)
      if (liveWidth.current < COLLAPSE_THRESHOLD) {
        onCollapsedChange(true);
        // 還原成「開始拖之前」的寬度 —— 用當下的值會把展開後的寬度
        // 留在拖到一半的那個窄值(症狀:收合再展開就變窄了)
        onWidthChange(clamp(widthBeforeDrag.current));
        return;
      }
      /*
       * 沒收合:把超界那一段收回合法範圍,那一趟就是回彈(走既有的寬度過場)。
       *
       * ⚠️ **手寫的那個寬度要自己收尾。** 拖曳中寬度是直接寫進 `nav.style.width` 的,
       * 而 React 只有在 `width` 這個 prop **真的變了**的時候才會重寫它 ——
       * 「拖出界再放手」正好是值沒變的那一種(state 一直是 420,手寫的停在 430),
       * 那樣就會卡在超界的位置上,回彈永遠不會發生。值沒變就自己寫回去。
       */
      const settled = clamp(liveWidth.current);
      if (nav && Math.round(settled) === Math.round(width)) {
        nav.style.width = `${settled}px`;
      }
      onWidthChange(settled);
    };

    window.addEventListener('pointermove', onMove, {passive: false});
    // ⚠️ 放開 / 取消在**捕獲階段**收:冒泡階段的話,路上任何一個元件
    // stopPropagation 就收不到 —— owner 卡著舊的那根,這條邊線就拖不動了(要等它「太久沒動靜」才放行)
    window.addEventListener('pointerup', onUp, {capture: true});
    window.addEventListener('pointercancel', onUp, {capture: true});
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp, {capture: true});
      window.removeEventListener('pointercancel', onUp, {capture: true});
      nav?.removeAttribute('data-resizing');
    };
  }, [isActive, isCollapsed, navRef, onCollapsedChange, onWidthChange, owner, width]);

  /*
   * ⚠️ `isActive` 另外走一份 ref,**不能在計時器裡直接讀 state**:下面那個
   * `setTimeout` 捕捉的是排程當下的閉包。按方向鍵之後 `KEY_SETTLE_MS` 內才按下去
   * 開始拖曳的話,舊閉包裡的 `isActive` 還是 `false` —— 計時器會在**拖曳進行中**
   * 把 `data-resizing` 拔掉,寬度過場當場復活、拖曳慢半拍,正是這個屬性要防的事。
   * ref 在 effect 裡寫,不在 render 期間寫。
   */
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  /**
   * 鍵盤調寬度時也要關掉寬度過場 —— 理由跟拖曳那條一模一樣(見上面的
   * `data-resizing`):按住方向鍵時每 30ms 就一格,再補間就會落後手指。
   * 停手 `KEY_SETTLE_MS` 之後才還原,`Enter`/`Space` 的收合切換不受影響。
   */
  const keySettle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const suppressTransition = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    nav.setAttribute('data-resizing', '');
    clearTimeout(keySettle.current);
    keySettle.current = setTimeout(() => {
      // 拖曳中不要搶走它的屬性 —— 讀 ref 的**當下**值,不是排程當下的那個
      if (!isActiveRef.current) navRef.current?.removeAttribute('data-resizing');
    }, KEY_SETTLE_MS);
  }, [navRef]);

  // 卸載時把還沒到期的還原計時器清掉
  useEffect(() => () => clearTimeout(keySettle.current), []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        suppressTransition();
        onWidthChange(clamp(width - STEP));
      } else if (e.key === 'ArrowRight') {
        suppressTransition();
        onWidthChange(clamp(width + STEP));
      } else if (e.key === 'Home') {
        suppressTransition();
        onWidthChange(MIN_WIDTH);
      } else if (e.key === 'End') {
        suppressTransition();
        onWidthChange(MAX_WIDTH);
      } else if (e.key === 'Enter' || e.key === ' ') onCollapsedChange(!isCollapsed);
      else return;
      e.preventDefault();
    },
    [isCollapsed, onCollapsedChange, onWidthChange, suppressTransition, width],
  );

  /*
   * 收合時**一樣要在**:不在的話收起來之後邊線既拖不動也點不開,
   * 只剩 rail 的收合鈕 —— 那條邊是最順手的入口。
   * 它平常是完全透明的,只有拖曳中才畫那條線,不會礙眼。
   */
  if (!box) return null;

  return (
    <Stack
      role="separator"
      aria-orientation="vertical"
      aria-label={isCollapsed ? 'Expand sidebar' : 'Resize sidebar'}
      aria-valuenow={isCollapsed ? 0 : Math.round(width)}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      ref={hitRef}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      xstyle={styles.hitArea}
      // 位置是量出來的(側邊欄寬度會變),只有這三個值走 inline style
      style={{
        insetInlineStart: box.left,
        insetBlockStart: box.top,
        height: box.height,
      }}
    >
      {/* 感應區本身永遠透明,拖曳中只畫這一條 ——
          整塊感應區都上色的話會變成一條很粗的帶子,而且跟版面本身的
          分隔線疊在一起看起來像兩條。 */}
      {isActive ? <Stack aria-hidden xstyle={styles.indicator} /> : null}
    </Stack>
  );
}
