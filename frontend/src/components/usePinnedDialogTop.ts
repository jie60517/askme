import {useLayoutEffect, useRef, useState, type RefObject} from 'react';

/**
 * 對話框**上緣釘死,只有下緣伸縮**——搜尋型 / 會換頁的對話框共用的那一份。
 *
 * ## 為什麼
 *
 * `<dialog>` 是 `inset: 0` + `margin: auto` **垂直置中**的,所以內容高度一變,上下兩邊會
 * **同時**往中間收 / 往外長。打字篩清單時,正在打字的那個搜尋框每打一個字就往下跳一次;
 * 換頁(確認頁 → QR 頁)長高時,一半是往上長的。規則是:最上面不要動,只有下面伸縮。
 *
 * 作法:打開的當下量一次「本來會被置中到哪裡」,把
 * `margin-block-start` 換成那個值、`margin-block-end` 留 `auto` —— 開的那一刻看起來
 * 跟原本一模一樣,之後多出來 / 少掉的高度全部落在下面。
 * (⌘K 釘的是「畫面中上」的固定比例,那是它自己的版面。內容常常很長、一開始只有 Loading 的
 *  對話框也可以這樣釘:給 `topRatio`,上緣一開始就放在視窗高度的那個比例,不從置中量起。)
 *
 * ## 跟 ⌘K 不一樣的地方:**會撞到地板**
 *
 * ⌘K 的內容長高頂多一列;這裡的 QR 頁、名單載入完可以長 400 多 px。
 * 置中時量到的上緣如果很低,往下長就會把底列推出視窗外(`<dialog>` 是 fixed,超出去的
 * 部分捲不到、按不到)。所以下緣碰到「視窗底 − `EDGE_PX`」之後,上緣才讓路往上移,
 * 而且**只移不夠的那一段**(不是跳回置中)。之後縮回來也不再往下掉回去:
 * 上緣只會因為「不移就超出畫面」而動,不會因為內容變短而動。
 *
 * - ⚠️ 量 `offsetHeight` 不是 `getBoundingClientRect()`:進場動畫是 transform,
 *   rect 會把它算進去,那時候量到的是縮小中的高度(同 `AccountSettingsDialog`)。
 * - ⚠️ 視窗大小變了要重新置中 —— 不重算的話對話框會黏在一個不再置中的位置上。
 * - ⚠️ 關掉要歸零(同 ⌘K),不然下一次打開會先用上一次的位置閃一下。
 *   `isOpen` 在退場那 165ms 還是 `true`(見 `useDialogExit`),所以歸零不會打斷退場。
 * - 呼叫端可以把「內容還沒到」也算進 `isOpen`(例如名單還在載入):載入中先照原本置中,
 *   內容到了才量、才釘 —— 不然釘的是 Loading 那一小塊的中心,名單一到就整個撞地板。
 *
 * ## 怎麼用
 *
 * ```tsx
 * const pin = usePinnedDialogTop(isOpen);
 * <Dialog isOpen={isOpen} … ref={pin.ref} style={pin.style}>
 * ```
 *
 * **ref 由這支 hook 自己發**,跟 `style` 一起回傳:
 * 分開傳的話呼叫端很容易只接了其中一個 —— 只接 style 的話永遠量不到、只接 ref 的話量了沒用,
 * 兩種都不會報錯,只是對話框安靜地回到置中。`style` 還沒量到時是 `undefined`(照原本置中);
 * 自己也有 style 要給的(`AccountSettingsDialog` 的 `pinnedTokens`)就攤在一起。
 */
export type PinnedDialogTop = {
  ref: RefObject<HTMLDialogElement | null>;
  style: React.CSSProperties | undefined;
};

export function usePinnedDialogTop(isOpen: boolean, opts: {topRatio?: number} = {}): PinnedDialogTop {
  const {topRatio} = opts;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [top, setTop] = useState<number | null>(null);

  /*
   * ⚠️ layout effect:釘的位置要在**第一次繪製之前**到位。置中模式量到的就是置中的位置,
   * 晚一格看不出來;`topRatio` 跟置中可以差到四成視窗高,晚一格就是「先在中間、再跳上去」。
   */
  useLayoutEffect(() => {
    if (!isOpen) {
      setTop(null);
      return;
    }
    const el = dialogRef.current;
    if (!el) return;
    let pinned = 0;
    let raf = 0;
    let waits = 0;
    const center = () => {
      // 置中要量高度;layout effect 跑在子元件的 effect(設計系統的 showModal)之前,
      // 那一刻還沒排版的話量到 0 —— 等下一格再量(`topRatio` 不用量高度,不受影響)
      // (最多等幾格:真的一直是 0 的話就照 0 算,不要每一格空轉)
      if (topRatio === undefined && el.offsetHeight === 0 && waits < 10) {
        waits += 1;
        raf = requestAnimationFrame(center);
        return;
      }
      pinned =
        topRatio === undefined
          ? Math.max(0, Math.round((window.innerHeight - el.offsetHeight) / 2))
          : Math.round(window.innerHeight * topRatio);
      setTop(pinned);
      keepOnScreen();
    };
    const keepOnScreen = () => {
      const room = Math.max(0, Math.floor(window.innerHeight - el.offsetHeight - EDGE_PX));
      if (pinned <= room) return;
      pinned = room;
      setTop(pinned);
    };
    center();
    window.addEventListener('resize', center);
    // jsdom 沒有 ResizeObserver;沒有的話就只是少了「撞地板」那一層
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(keepOnScreen);
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', center);
      ro?.disconnect();
    };
  }, [isOpen, topRatio]);

  return {
    ref: dialogRef,
    style: top === null ? undefined : {marginBlockStart: `${top}px`, marginBlockEnd: 'auto'},
  };
}

/**
 * 撞地板時下緣離視窗底留多少(px)。= `--spacing-4`,跟 `IssueMfaDialog` 寬度那條
 * `calc(100vw - var(--spacing-8))` 左右各留的那一格同一個量。這裡是 JS 算式,吃不到 `var()`。
 */
const EDGE_PX = 16;
