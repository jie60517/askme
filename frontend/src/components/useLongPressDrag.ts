/**
 * 長按拖曳。
 *
 * 為什麼不用 HTML5 的 draggable:
 * - 它在觸控裝置上等於沒有(手機瀏覽器不會從 touch 產生 dragstart)
 * - 一按下去移動就開始拖,而對話列本身是連結,想點開卻手抖一下就被拖走
 *
 * 所以改成 pointer events 自己做:按住 HOLD_MS 才進入拖曳,期間手指/滑鼠
 * 移超過 MOVE_TOLERANCE 就當作「他只是要捲動或點擊」,取消長按。
 * 這套在滑鼠、觸控、觸控筆上是同一條路。
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {easeStep, frameDelta} from '../lib/frameEase';
import {createPointerOwner} from '../lib/pointerOwner';

/**
 * 按住多久才算要拖。
 *
 * 120ms 已經進到「一次慢一點的點擊」的範圍裡 —— 所以光靠時間不夠,
 * 還要看**有沒有真的移動**:進入拖曳之後如果指標一路沒有離開起點
 * (`DRAG_MIN_MOVE`),放開時就當作那是一次點擊 —— 不放下、不吞掉 click。
 * 少了這條,按慢一點的人會點不開對話。
 */
const HOLD_MS = 120;
/** 長按判定期間容許的手抖 */
const MOVE_TOLERANCE = 8;
/** 進入拖曳後要移動超過這個距離,放開才算「放下」而不是「點一下」 */
const DRAG_MIN_MOVE = 6;

/**
 * 拖到清單上下緣多近就開始自己捲。
 *
 * 沒有這個的話,把一組對話拖進「看不到的那個資料夾」是做不到的:手指按著就
 * 不能再滾滾輪(滾輪要用同一隻手),而清單一長,目的地根本不在畫面上。
 *
 * 56px 大約是兩列的高度 —— 再小的話很難瞄準,再大的話清單中段也會誤觸發。
 */
const EDGE_PX = 56;
/**
 * 貼到最邊緣時一格捲多少 px。
 *
 * 這是**每一格 rAF** 的量(約 60 fps),所以 14 ≈ 每秒 840px,長清單一兩秒
 * 就到底,而且愈靠近邊緣愈快、剛進感應區時很慢 —— 靠下面那個比例值做出來的,
 * 不是兩段式的開/關(兩段式會讓人覺得「突然衝出去」)。
 */
const EDGE_SPEED_PX = 14;
/**
 * 幽靈追手指:每 60Hz 一幀走掉剩餘距離的比例。比側邊欄滾輪的 0.18 大 ——
 * 拿在手上的東西要貼著手,慢了就像拖不動;留一點落後只是為了不抖。
 */
const GHOST_EASE = 0.34;
/**
 * 沒放到目標(或被取消)時,幽靈飛回原本那一列要多久才卸載。
 *
 * 補間本身是 `--duration-medium`(下面 returnGhost 寫的 transition),這個數字要比它長一點,
 * 不然還沒落地就消失。同一個 app 裡「放手 → 回原位」只該有一種速度。
 */
export const GHOST_RETURN_MS = 340;
/**
 * 改成原地淡出(減少動態、或那一列看不到了)時多久卸載 —— 淡出是 `--duration-fast`(125ms),
 * 給一點餘裕。⚠️ 不能沿用上面的 340:幽靈早就淡完了,原本那一列卻還半透明地多等兩百毫秒,
 * 看起來像「東西不見了」。
 */
const GHOST_FADE_MS = 150;

/**
 * 幽靈要飛回去的落點 = 原本那一列**放手當下**在哪裡。拿不到就回 null(改成原地淡出)。
 *
 * ⚠️ 要在放手時才量,不能用按下去時記的 rect:拖到一半邊緣自動捲過(或資料夾收起來),
 * 那一列早就不在原處了。
 * - 不在文件裡了(清單重新整理把它換掉)、量出來是 0×0(所在的資料夾收起來)→ null;
 * - 被捲出清單的可視範圍 → null:幽靈是 fixed、疊在最上層,飛過去會落在側邊欄的標頭上,
 *   那不是「回到原位」,是「飛到一個看不出是哪裡的地方」。
 */
function landingRect(row: HTMLElement | null, scroller: HTMLElement | null): DOMRect | null {
  if (!row?.isConnected) return null;
  const r = row.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const view = scroller?.getBoundingClientRect() ?? {top: 0, bottom: window.innerHeight};
  if (r.bottom <= view.top || r.top >= view.bottom) return null;
  return r;
}

export type DragState<T> = {
  payload: T;
  /** 目前指標下方的放置目標 id;沒有就是 undefined */
  over: string | undefined;
  x: number;
  y: number;
  /**
   * 跟著指標走的那一塊要畫什麼 —— **被拿起來那一列的複本**
   *(見 `resolveVisual`)。沒有解析出來就是 null,呼叫端自己決定備援。
   */
  visual: HTMLElement | null;
  /** 那一列原本的寬度,複本要照著撐開,不然會縮成內容寬 */
  width: number;
  /**
   * 按下去的那一點在那一列裡的位置(相對於它的左上角)。
   *
   * 幽靈要照這個偏移擺,**不是**擺在指標正中間 —— 抓它的三分之一處,
   * 拿起來就該還是抓在三分之一處。置中的話手感像是「東西在手上跳了一下」。
   */
  grabX: number;
  grabY: number;
};

type Options<T> = {
  /** 從 DOM 找出目前指標下的放置目標。回傳 undefined 代表不能放。 */
  resolveTarget: (element: Element | null) => string | undefined;
  /**
   * 拖到邊緣時要自己捲的那個容器。不給就沒有邊緣自動捲動。
   *
   * 傳函式而不是元素:呼叫端那個捲動層是**用計算樣式當場找出來的**
   *(見 Sidebar 的滾輪那段),不是一個穩定的 ref。
   */
  resolveScroller?: () => HTMLElement | null;
  /**
   * 從按下去的位置找出「看得到的那一列」——拿起來之後要拿它的複本當幽靈。
   *
   * 拿起來的要跟原本那一列長得一樣:另外畫一顆 Token 的話,資料夾的圖示、
   * 顏色記號、未讀數全都不見了,看起來像另一個東西。
   */
  resolveVisual?: (element: Element | null) => HTMLElement | null;
  /**
   * 複本要**自己帶著走**的自訂屬性名(顏色那類是從祖先繼承下來的,
   * 複本掛在別的地方就沒有了)。
   *
   * 由呼叫端給:哪些屬性是「這一列的一部分」只有它知道,
   * 這支通用的 hook 不寫死。
   */
  inheritedProps?: readonly string[];
  /**
   * 指標底下的放置目標換了。**這支不是 setState,是叫呼叫端自己去畫。**
   *
   * ⚠️ 為什麼不走 state:拖過清單時,每經過一列 `over` 就換一次,而那個 state
   * 住在側邊欄上 —— 一次就是整棵樹重繪,拖曳會嚴重掉幀。
   * 高亮只是「哪一格上色」,那是一個屬性的事,不需要 React 走一遍。
   *
   * 呼叫端拿到的是**目標 id 與正在拖的東西**,自己決定要點亮哪一塊
   * (跨層的時候該亮的是資料夾,不是指標下那一列 —— 那個判斷在呼叫端)。
   * `over` 是 `undefined` 就是「現在沒有目標」,包含拖曳結束那一下。
   */
  onOverChange?: (over: string | undefined, payload: T) => void;
  onDrop: (payload: T, targetId: string) => void;
};

/**
 * 複製那一列,並且把它變成一塊**不會參與任何互動**的畫面。
 *
 * - `id` 全部拿掉:複本跟本尊會同時在文件裡,重複的 id 會讓
 *   `aria-controls` 那類關聯指到錯的元素。
 * - `inheritedProps` 裡的自訂屬性要**算出來寫死在複本上**:它們是從祖先
 *   繼承下來的,複本掛在別的地方就查不到了(哪些屬性算數見 `Options`)。
 */
function cloneRow(row: HTMLElement, inheritedProps: readonly string[]): HTMLElement {
  const clone = row.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  for (const node of clone.querySelectorAll('[id]')) node.removeAttribute('id');
  const style = getComputedStyle(row);
  for (const name of inheritedProps) {
    const value = style.getPropertyValue(name).trim();
    if (value) clone.style.setProperty(name, value);
  }
  return clone;
}

export function useLongPressDrag<T>({
  resolveTarget,
  resolveScroller,
  resolveVisual,
  inheritedProps = [],
  onOverChange,
  onDrop,
}: Options<T>) {
  const [drag, setDrag] = useState<DragState<T> | null>(null);
  /*
   * ⚠️ 這兩支放 ref。它們是呼叫端每次 render 重建的普通函式,而用到它們的
   * `refreshOver` / `edgeScroll` 要掛在 rAF 迴圈上 —— 直接列進相依的話,
   * 側邊欄每重繪一次就會把整條迴圈重建一次(拖到一半會斷)。
   */
  const resolveTargetRef = useRef(resolveTarget);
  resolveTargetRef.current = resolveTarget;
  const resolveScrollerRef = useRef(resolveScroller);
  resolveScrollerRef.current = resolveScroller;
  // 同上:它在 rAF 迴圈上被呼叫,不能列進相依
  const onOverChangeRef = useRef(onOverChange);
  onOverChangeRef.current = onOverChange;
  /*
   * ⚠️ **`resolveVisual` 也要走 ref**。呼叫端每次 render 都會重做一個新的箭頭函式,
   * 列進 `onPointerDown` 的相依的話,`onPointerDown` 也跟著換,一路傳到每一列上,
   * 讓 `ConversationRow` 的 `memo` 永遠判定「props 不一樣」。
   * **加相依前先想一下它會傳到哪裡去。**
   */
  const resolveVisualRef = useRef(resolveVisual);
  resolveVisualRef.current = resolveVisual;
  const inheritedPropsRef = useRef(inheritedProps);
  inheritedPropsRef.current = inheritedProps;
  /**
   * ⚠️ `onDrop` 也放 ref:呼叫端(Sidebar)每次 render 都給一支新的,
   * 放在下面 effect 的相依裡的話,拖曳一開始的那次重繪就讓 effect 拆掉重掛 ——
   * 那一刻掛著的東西(手勢的監聽)會被拆掉而沒有人補回來。
   */
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startPoint = useRef({x: 0, y: 0});
  const pending = useRef<T | null>(null);
  /**
   * 這一次手勢歸哪一根指標管(多點觸控保護,規則見 `lib/pointerOwner.ts`)。
   * 長按判定與拖曳中別的指標一律不理;收尾事件漏了的話,下一次按下會接手重來。
   */
  const owner = useState(createPointerOwner)[0];
  /*
   * 幽靈的位置**不走 React state**。
   * 每一個 pointermove 都 setDrag 的話,整棵側邊欄重繪一次,
   * 拖起來一格一格跳。所以 state 只管「開始/結束/放置目標變了」,
   * 座標由 rAF 迴圈直接寫在幽靈元素的 style 上,而且用**追趕式的緩動**
   * (每一格走剩餘距離的一個比例,見 GHOST_EASE)—— 拖快的時候幽靈微微落後再黏上來。
   */
  const ghostEl = useRef<HTMLElement | null>(null);
  const ghostOrigin = useRef({x: 0, y: 0});
  const targetPos = useRef({x: 0, y: 0});
  const shownPos = useRef({x: 0, y: 0});
  const rafId = useRef<number | undefined>(undefined);
  /** 被拿起來的那一列本尊(飛回去的落點,見 landingRect) */
  const sourceRow = useRef<HTMLElement | null>(null);
  /** 正在飛回去的那顆幽靈與它的卸載計時器(見 returnGhost) */
  const returningEl = useRef<HTMLElement | null>(null);
  const returnTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const applyGhost = useCallback(() => {
    const el = ghostEl.current;
    const d = dragRef.current;
    if (!el || !d) return;
    /*
     * 位置走 `transform`,不走 inset:inset 是排版屬性,每一幀都寫
     * 等於每一幀重排;transform 在合成層上動。幽靈的 inset 在 bindGhost 釘在 0,
     * 這裡的位移就是它離視窗左上角(扣掉 fixed 基準的偏移)的距離。
     */
    const x = shownPos.current.x - d.grabX - ghostOrigin.current.x;
    const y = shownPos.current.y - d.grabY - ghostOrigin.current.y;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  /**
   * 指標下面現在是哪一個放置目標。**只有變了才通知呼叫端** ——
   * 這支每一格 rAF 都會被叫到(邊緣捲動時內容在動,指標沒動答案也會變)。
   *
   * ⚠️ **它不 `setState`**(理由見 `Options.onOverChange`):
   * 目標存在 `dragRef` 上(放開時 `onDrop` 讀的就是它),高亮由呼叫端直接畫。
   * 改成 `setDrag` 的話,拖過清單就會變成「每經過一列重繪整棵側邊欄」。
   */
  const refreshOver = useCallback(() => {
    const current = dragRef.current;
    if (!current) return;
    const el = document.elementFromPoint(targetPos.current.x, targetPos.current.y);
    const over = resolveTargetRef.current(el);
    if (over === current.over) return;
    dragRef.current = {...current, over};
    onOverChangeRef.current?.(over, current.payload);
  }, []);

  /**
   * 拖到清單上下緣時把清單捲起來(見 EDGE_PX)。
   *
   * ⚠️ 捲完要**重算放置目標**:手指停在邊緣不動,但內容從它底下滑過去 ——
   * 不重算的話高亮會留在剛才那一格,放開時放進去的也是那一格,
   * 而畫面上指著的明明是另一個資料夾。
   *
   * ⚠️ 只有真的捲得動才算數(`scrollTop` 沒變就 return),不然到頂/到底之後
   * 每一格都在白算一次 elementFromPoint。
   */
  const edgeScroll = useCallback(() => {
    const scroller = resolveScrollerRef.current?.();
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const y = targetPos.current.y;
    // 比例:剛進感應區是 0,貼到邊緣是 1。負的往上、正的往下。
    let ratio = 0;
    if (y < rect.top + EDGE_PX) ratio = -(rect.top + EDGE_PX - y) / EDGE_PX;
    else if (y > rect.bottom - EDGE_PX) ratio = (y - (rect.bottom - EDGE_PX)) / EDGE_PX;
    if (ratio === 0) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(-1, Math.min(1, ratio)) * EDGE_SPEED_PX;
    if (scroller.scrollTop !== before) refreshOver();
  }, [refreshOver]);

  /** 上一幀的時間戳(逼近的比例要照實際過了多久換算,見 ghostTick) */
  const lastTick = useRef<number | undefined>(undefined);

  const ghostTick = useCallback((ts: number) => {
    if (!dragRef.current || !ghostEl.current) {
      rafId.current = undefined;
      lastTick.current = undefined;
      return;
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    /*
     * 幽靈追手指:每 60Hz 一幀走掉剩餘距離的 GHOST_EASE。
     * ⚠️ 是「每 60Hz 一幀」不是「每一次 rAF」:120Hz 的螢幕
     * 一秒叫 120 次,固定比例會讓幽靈跟得快一倍,兩台機器兩種手感。
     * 換算在 `lib/frameEase.ts`,跟 Sidebar.tsx 的滾輪 step 同一份。
     */
    const dt = frameDelta(lastTick.current, ts);
    lastTick.current = ts;
    const k = reduce ? 1 : easeStep(GHOST_EASE, dt);
    shownPos.current.x += (targetPos.current.x - shownPos.current.x) * k;
    shownPos.current.y += (targetPos.current.y - shownPos.current.y) * k;
    applyGhost();
    edgeScroll();
    rafId.current = requestAnimationFrame(ghostTick);
  }, [applyGhost, edgeScroll]);

  /**
   * 呼叫端把幽靈元素跟 fixed 的定位基準交進來(render 時掛在 ref 上)。
   * 位置從這一刻起由 hook 直接寫,呼叫端**不要**再用 inline style 排它。
   */
  const bindGhost = useCallback(
    (el: HTMLElement | null, origin: {x: number; y: number}) => {
      ghostEl.current = el;
      ghostOrigin.current = origin;
      if (el) {
        // 釘在左上角,之後只動 transform(見 applyGhost)
        el.style.insetInlineStart = '0';
        el.style.insetBlockStart = '0';
        applyGhost();
        if (rafId.current === undefined) rafId.current = requestAnimationFrame(ghostTick);
      }
    },
    [applyGhost, ghostTick],
  );
  /**
   * 剛拖完的那一下 click 要吞掉。
   * 不吞的話放開手指時,底下的連結會照常被觸發,畫面直接跳走。
   */
  const justDragged = useRef(false);
  const dragRef = useRef<DragState<T> | null>(null);
  /** 進入拖曳之後真的移動過了嗎(見 DRAG_MIN_MOVE) */
  const movedRef = useRef(false);
  /**
   * 同一次按下,只認**最內層**那一個來源。
   *
   * 資料夾是巢狀的:子資料夾的外框長在父資料夾的外框裡面,對話列又長在
   * 資料夾的外框裡面 —— 按一下會沿著冒泡路徑觸發每一層的 onPointerDown,
   * 最後跑到的(最外層那個資料夾)會蓋掉前面的 payload。於是「拖 C 進 B」
   * 實際上拖的是最上層的 A,「把資料夾裡的對話拖出來」拖的也是那個資料夾。
   *
   * 冒泡是由內往外,第一個看到這個原生事件的就是使用者真正按住的那一列 ——
   * 讓它認領,同一個事件後面再來的直接不理。
   */
  const claimedEvent = useRef<Event | null>(null);

  const cancelHold = useCallback(() => {
    clearTimeout(holdTimer.current);
    pending.current = null;
  }, []);

  /**
   * 收掉進行中的飛回去:清計時器、把飛行用的 inline style 拿掉。
   *
   * ⚠️ style 一定要清:飛回去途中又拿起下一列的話,React 沿用**同一顆**幽靈節點
   *(Sidebar 那邊是 `drag ? <Stack> : null`,兩次都是 truthy),留著 `transition` 的話
   * 新的那一次會從舊的落點「滑」過來,`opacity: 0` 的話乾脆看不到。
   */
  const stopReturn = useCallback(() => {
    clearTimeout(returnTimer.current);
    returnTimer.current = undefined;
    const el = returningEl.current;
    returningEl.current = null;
    if (!el) return;
    el.style.transition = '';
    el.style.opacity = '';
    el.style.boxShadow = '';
  }, []);

  /**
   * 沒放下的拖曳收尾:幽靈**從哪來回哪去**。放手當下直接 `setDrag(null)` 的話,
   * 東西在指尖憑空消失,看不出「沒搬成功、還在原位」。
   *
   * - 只動 `transform`(位置本來就是 applyGhost 寫的 translate3d,補間在合成層上)與影子
   *  (落回列上的樣子,影子收掉);
   * - 減少動態 / 原本那一列找不到(見 landingRect)→ 原地淡出;
   * - `drag` 在飛的期間**不清**:幽靈要繼續掛著,原本那一列也繼續是半透明的「空位」,
   *   落地那一刻兩者一起換回來。拖曳本身(`dragRef`)已經結束了 —— 不擋觸控捲動、不再算目標。
   *
   * ⚠️ 這裡寫的是 inline style,不是 StyleX:transition 必須跟新的 transform **同一次**寫進去,
   * 走 React render 換 class 的話,class 到的時候位移早就跳完了。
   */
  const returnGhost = useCallback(
    (el: HTMLElement | null) => {
      stopReturn();
      if (!el) {
        setDrag(null);
        return;
      }
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const rect = reduce ? null : landingRect(sourceRow.current, resolveScrollerRef.current?.() ?? null);
      if (rect) {
        el.style.transition =
          'transform var(--duration-medium) var(--ease-panel), box-shadow var(--duration-medium) var(--ease-panel)';
        el.style.boxShadow = 'none';
        // 幽靈的左上角對齊那一列的左上角(複本跟本尊同寬同高),扣法同 applyGhost
        el.style.transform = `translate3d(${rect.left - ghostOrigin.current.x}px, ${rect.top - ghostOrigin.current.y}px, 0)`;
      } else {
        el.style.transition = 'opacity var(--duration-fast) var(--ease-panel)';
        el.style.opacity = '0';
      }
      returningEl.current = el;
      returnTimer.current = setTimeout(
        () => {
          returningEl.current = null;
          returnTimer.current = undefined;
          setDrag(null);
        },
        rect ? GHOST_RETURN_MS : GHOST_FADE_MS,
      );
    },
    [stopReturn],
  );

  /**
   * 觸控拖曳中擋掉瀏覽器自己的捲動。
   *
   * ⚠️ 只在 `pointermove` 上 `preventDefault()` **擋不住**:觸控時手指一移動,瀏覽器照樣接手去捲
   * 清單(側邊欄抽屜是 `touch-action: pan-y`),並送出 `pointercancel` —— 拖曳當場斷掉,
   * 手機上就拖不進資料夾(歸類只靠長按拖曳)。只有**不被動的 `touchmove`** 擋得住。
   *
   * ⚠️ **而且要在手指按下去之前就掛好**:瀏覽器在觸控開始那一刻就決定這一串
   * touchmove 能不能被擋(iOS 要事先知道哪一塊有不被動的監聽),拖曳開始後才掛的話,
   * 拿到的事件 `cancelable` 已經是 false,擋了等於沒擋。
   * 所以元件一掛上就掛在**捲動層**上(`resolveScroller` 給的那一層 —— 會被拖的列都長在裡面),
   * 平常什麼都不做,只有拖曳中才 `preventDefault`。不掛在 window:那會讓全頁的觸控捲動
   * 都要等主執行緒(回答串流中會卡),範圍限在側邊欄就好。
   * ⚠️ 這要求呼叫端在**這支 hook 的 effect 之前**就找好捲動層:Sidebar 是在果凍捲動那支
   * effect(宣告在這支 hook 之前,同一次 commit 裡先跑)設好 `scrollerRef` 的,而那支 effect
   * 假設捲動層不會換。萬一真的換了,`armTouchArea` 會在下一次按下時改掛,只有那一次手勢擋不住。
   * ⚠️ 手機抽屜**一定會換**:手機版的側邊欄藏在 `<Activity>` 裡,抽屜每次打開 ref 才重新接上,
   * 而且設計系統在抽屜模式不把 ref 往下傳,上面那支 effect 找不到它(抽屜裡拖一下就被 pointercancel 收掉)。
   * 那條路由 Sidebar 在抽屜清單掛上的當下呼叫回傳的 `armTouchArea`(見 `bindDrawerList`)。
   */
  const blockTouchScroll = useRef((e: TouchEvent) => {
    if (dragRef.current && e.cancelable) e.preventDefault();
  }).current;
  /** 把進行中的手勢當成被取消收掉(見 onPointerDown 的「漏收了 pointerup」那段)。由下面的 effect 填 */
  const abortGesture = useRef<(keepOwner?: boolean) => void>(() => {});
  /** 目前掛著 blockTouchScroll 的那一層(捲動層可能換人,見 armTouchArea) */
  const touchArea = useRef<HTMLElement | null>(null);
  /**
   * 把 blockTouchScroll 掛到現在的捲動層上;已經掛對了就什麼都不做。
   * 掛載時跑一次,每次按下去也跑一次 —— 捲動層是呼叫端用計算樣式找的,可能被換掉,
   * 換掉之後至少從下一次手勢開始就對了。
   */
  const armTouchArea = useCallback(() => {
    const el = resolveScrollerRef.current?.() ?? null;
    if (el === touchArea.current) return;
    touchArea.current?.removeEventListener('touchmove', blockTouchScroll);
    el?.addEventListener('touchmove', blockTouchScroll, {passive: false});
    touchArea.current = el;
  }, [blockTouchScroll]);
  useEffect(() => {
    armTouchArea();
    return () => {
      // 拖到一半被卸載(換頁、抽屜關掉):整個手勢收乾淨 —— 高亮是呼叫端直接畫在 DOM 上的,
      // 不走 onOverChange(undefined) 的話會一直亮著;長按計時器也一起清掉
      abortGesture.current();
      // 飛回去飛到一半被卸載:計時器不能留著,但**落地那一下要補做**:
      // 手機上側邊欄住在 `<Activity>` 裡,抽屜關掉只跑 effect 的清理、state 留著 ——
      // 只清計時器的話 `drag` 永遠不會歸零,下次打開抽屜幽靈還掛著、原位一直半透明。
      // 真的卸載時這個 setState 什麼都不做。
      if (returningEl.current) setDrag(null);
      stopReturn();
      touchArea.current?.removeEventListener('touchmove', blockTouchScroll);
      touchArea.current = null;
    };
  }, [armTouchArea, blockTouchScroll, stopReturn]);

  const onPointerDown = useCallback(
    (payload: T) => (e: React.PointerEvent) => {
      // 只認主鍵;右鍵是給選單的
      if (e.button !== 0) return;
      // 巢狀的外框會讓同一個事件冒泡經過好幾層,最內層那一層說了算(見 claimedEvent)
      if (claimedEvent.current === e.nativeEvent) return;
      const claim = owner.claim(e);
      // 已經有別的指標在長按或拖曳了(第二根手指、別種指標):不理
      if (claim === 'ignored') return;
      // 上一次手勢的收尾漏了:把它當成被取消收掉(owner 已經換成這一根),重新開始
      if (claim === 'restarted') abortGesture.current(true);
      claimedEvent.current = e.nativeEvent;
      armTouchArea();
      clearTimeout(holdTimer.current);
      startPoint.current = {x: e.clientX, y: e.clientY};
      pending.current = payload;
      const {clientX, clientY} = e;
      // 按下去的當下就把那一列找出來 —— 長按計時器跑完時 e 已經回收了
      const row = resolveVisualRef.current?.(e.target instanceof Element ? e.target : null) ?? null;
      const rect = row?.getBoundingClientRect();
      const width = rect?.width ?? 0;
      const grabX = rect ? clientX - rect.left : 0;
      const grabY = rect ? clientY - rect.top : 0;
      holdTimer.current = setTimeout(() => {
        if (pending.current === null) return;
        // 上一顆還在飛回去的話直接收掉(手比動畫快),新的這一次從乾淨的節點開始(見 stopReturn)
        stopReturn();
        sourceRow.current = row;
        movedRef.current = false;
        const next = {
          payload: pending.current,
          over: undefined,
          x: clientX,
          y: clientY,
          visual: row ? cloneRow(row, inheritedPropsRef.current) : null,
          width,
          grabX,
          grabY,
        };
        dragRef.current = next;
        // 幽靈的追趕從按下去那一點開始(不然會從上一次拖曳的位置飛過來)
        targetPos.current = {x: clientX, y: clientY};
        shownPos.current = {x: clientX, y: clientY};
        setDrag(next);
      }, HOLD_MS);
    },
    // ⚠️ 只放穩定的東西:兩支 option 都走 ref(見上面),列進來會害到呼叫端的 memo
    [armTouchArea, owner, stopReturn],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (owner.isActive && !owner.owns(e)) return;
      // 還在長按判定中:移太多就當作不是要拖
      if (!dragRef.current) {
        if (
          pending.current !== null &&
          Math.hypot(e.clientX - startPoint.current.x, e.clientY - startPoint.current.y) >
            MOVE_TOLERANCE
        ) {
          cancelHold();
        }
        return;
      }
      e.preventDefault();
      if (
        Math.hypot(e.clientX - startPoint.current.x, e.clientY - startPoint.current.y) >
        DRAG_MIN_MOVE
      ) {
        movedRef.current = true;
      }
      // 座標只進 ref(rAF 迴圈會去追),不進 state —— 每一步 setState 就會卡
      targetPos.current = {x: e.clientX, y: e.clientY};
      dragRef.current = {...dragRef.current, x: e.clientX, y: e.clientY};
      // 只有「放置目標變了」才需要 React 重繪(外框亮起/熄滅)—— 判斷在 refreshOver
      refreshOver();
    };

    /**
     * 手勢結束。`cancelled` = 瀏覽器送了 `pointercancel`(例如它接手去捲動了)。
     *
     * ⚠️ 被取消的手勢**不是放下**:cancel 跟 up 共用同一條路的話,當下指著資料夾時,
     * 一個被瀏覽器打斷的拖曳會被當成「放進去」—— 東西跑到使用者沒放的地方。
     */
    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!owner.owns(e)) return;
      owner.release();
      end(cancelled);
    };
    /** `animate = false`:不飛回去,當場收掉(手勢被硬收的那兩條路,見 abortGesture) */
    const end = (cancelled: boolean, animate = true) => {
      cancelHold();
      const current = dragRef.current;
      dragRef.current = null;
      if (rafId.current !== undefined) {
        cancelAnimationFrame(rafId.current);
        rafId.current = undefined;
      }
      // 跟 ghostTick 自己收尾那條一樣要清:留著的話下一次拖曳的第一幀會吃到過期的時間戳
      lastTick.current = undefined;
      const el = ghostEl.current;
      ghostEl.current = null;
      if (!current) return;
      /*
       * ⚠️ **高亮要自己收掉。** 它不是 React 畫的(見 `onOverChange`),所以
       * `setDrag(null)` 收不掉它 —— 漏了這一行,放開之後那一格會一直亮著。
       * 放在 `movedRef` 那個分支的前面:沒移動過的那條路也會走到這裡。
       */
      if (current.over !== undefined) onOverChangeRef.current?.(undefined, current.payload);
      // 被取消的:只收尾,不放下、也不吞 click(見上面)。幽靈飛回原位(見 returnGhost)
      if (cancelled) {
        returnGhost(animate ? el : null);
        return;
      }
      /*
       * 拿起來了但**從頭到尾沒有移動** —— 那是一次按久了一點的點擊,不是拖曳。
       * 直接收掉:不放下、也不要吞掉接下來那一發 click(吞掉的話對話點不開)。
       */
      if (!movedRef.current) {
        setDrag(null);
        return;
      }
      justDragged.current = true;
      // 放開的下一個 tick 才解除,剛好蓋住那一發 click
      setTimeout(() => {
        justDragged.current = false;
      }, 0);
      // 沒指著目標就放開 = 沒搬成功:飛回原位。放進目標的話當場收掉(東西已經到新的地方了)
      if (current.over === undefined) {
        returnGhost(el);
        return;
      }
      setDrag(null);
      onDropRef.current(current.payload, current.over);
    };
    abortGesture.current = (keepOwner = false) => {
      if (!keepOwner) owner.release();
      // 硬收(卸載、漏收了 pointerup 被下一次按下接手):不飛,當場收
      end(true, false);
    };

    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    window.addEventListener('pointermove', onMove, {passive: false});
    // ⚠️ 放開 / 取消在**捕獲階段**收:冒泡階段的話,路上任何一個元件
    // stopPropagation 就收不到,owner 卡著舊的那根 —— 別種指標(觸控筆電上的滑鼠)要等它
    // 「太久沒動靜」才接得了手(見 lib/pointerOwner.ts)
    window.addEventListener('pointerup', onUp, {capture: true});
    window.addEventListener('pointercancel', onCancel, {capture: true});
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp, {capture: true});
      window.removeEventListener('pointercancel', onCancel, {capture: true});
    };
  }, [cancelHold, owner, refreshOver, returnGhost]);

  /** 掛在會被拖的那一列上,吞掉拖曳結束後的那一發 click */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!justDragged.current) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // cancelHold 沒有對外開放:它是長按判定的內部狀態機,
  // 外面拿到只會製造出「一半的拖曳」這種說不清楚的狀態。
  // armTouchArea 有開放:捲動層是**晚一點才掛上來的**時(手機抽屜,見 Sidebar 的 bindDrawerList),
  // 呼叫端要在它掛上的當下叫一次 —— 等到按下去才補掛就是「第一次手勢擋不住」。
  return {drag, onPointerDown, onClickCapture, bindGhost, armTouchArea};
}
