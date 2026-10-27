/**
 * 「這條拉桿正在被拖」。
 *
 * 用途只有一個:**把拇指的位置過場關掉**。直接操作(手指壓著拖)必須 1:1 跟手,
 * 掛過場會變成拇指追在指標後面,那比沒有過場更難用;而「點軌道」與方向鍵那種
 * 跳躍式的改動,有過場才不會瞬移。
 *
 * ⚠️ 為什麼要自己認:設計系統的 `Slider` 內部有 `draggingThumb` 這個 state,
 * 但它只餵 tooltip,**沒有對外掛任何屬性或 class**。
 *
 * ⚠️ `pointerup` 收得到是因為 Slider 會 `setPointerCapture` —— 捕捉之後事件會
 * 重新導向到拇指身上,而拇指在這層底下,所以照樣冒泡上來。少了 `pointercancel`
 * 那條,手勢被系統打斷(例如切到別的視窗)時旗標會卡在 true。
 *
 * ⚠️ **按在軌道上不算拖**(點軌道的跳躍要有過場)。
 * 設計系統在 `pointerdown` 那一刻就把值跳到指標的位置;同一個事件就掛 `data-dragging` 的話,
 * 點軌道那一跳的過場也被關掉,拇指照樣瞬移。所以:
 *   - 按在**拇指**上(`.astryx-slider-thumb`)→ 當場算拖(拇指本來就在指標底下,沒有要補的跳躍);
 *   - 按在**軌道**上 → 先不算,讓那一跳走過場;壓著之後**第一個 `pointermove`** 才開始算拖,
 *     從那裡起 1:1 跟手(按著軌道直接拖也是常見的用法)。
 * 「壓著」記在 ref:沒按著的 `pointermove`(滑鼠只是滑過去)不能把旗標打開。
 * 手指點一下本來就會抖出幾個 `pointermove`,所以要離開按下去的那一點超過 `DRAG_SLOP_PX` 才算數,
 * 不然觸控上點軌道的過場一開始就被抖掉。
 */
import {useRef, useState, type PointerEvent} from 'react';

/** 設計系統的拇指(`themeProps('slider-thumb')` 給的穩定 class,global.css 也認這個) */
const THUMB_SELECTOR = '.astryx-slider-thumb';

/** 按在軌道上之後,指標要移動超過這個距離(CSS px)才算開始拖 —— 擋手指點擊時的抖動 */
const DRAG_SLOP_PX = 3;

export type SliderDrag = {
  /** 拖曳中。掛成 `data-dragging` 給 CSS 認(見 `styles/global.css`)。 */
  isDragging: boolean;
  /** 直接展開到包著拉桿的那一層上。 */
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
};

export function useSliderDrag(): SliderDrag {
  const [isDragging, setIsDragging] = useState(false);
  /** 按下去的那一點;`null` = 沒按著 */
  const pressedAt = useRef<{x: number; y: number} | null>(null);
  const end = () => {
    pressedAt.current = null;
    setIsDragging(false);
  };
  return {
    isDragging,
    handlers: {
      onPointerDown: (e) => {
        pressedAt.current = {x: e.clientX, y: e.clientY};
        const onThumb = e.target instanceof Element && e.target.closest(THUMB_SELECTOR) !== null;
        if (onThumb) setIsDragging(true);
      },
      onPointerMove: (e) => {
        const from = pressedAt.current;
        if (!from || isDragging) return;
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP_PX) setIsDragging(true);
      },
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
}
