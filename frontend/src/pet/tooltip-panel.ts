import * as React from "react";
import { useMotionValue, useSpring, useTransform, type MotionValue } from "framer-motion";

import { useReducedMotion } from "./useReducedMotion";

/**
 * 「深底白字的小框 + 跟著滑鼠晃」這一套。
 *
 * 站上有兩個東西長這樣(按鈕的提示泡泡、小夥伴頭上的氣泡),所以抽出來
 * 共用 —— 兩邊各抄一份的話,調了其中一邊另一邊就默默漂走,而它們在使用者眼裡
 * 是同一種東西,差一點點就看得出來。
 *
 * 這裡只放「長相」與「動態」,不含觸發方式。
 *
 * ⚠️ 底下的 class 是 Tailwind v4 + shadcn 那套色彩變數(--foreground /
 * --background)。你的專案沒有那組變數的話,直接把這兩個字串換成自己的
 * 樣式即可 —— 邏輯完全不碰。
 */

/** 晃動與進場共用的彈簧 */
export const TOOLTIP_SPRING = { stiffness: 170, damping: 12, mass: 0.1 } as const;

/** 框本身(深底白字、小圓角、置中) */
export const TOOLTIP_PANEL_CLASS =
  "rounded-lg bg-foreground px-3 py-1.5 text-center text-xs font-medium text-background shadow-lg";

/** 指向目標的小尖角。用在 side=top;貼在框的下緣 */
export const TOOLTIP_ARROW_TOP_CLASS =
  "absolute left-1/2 top-[calc(100%-0.25rem)] size-2 -translate-x-1/2 rotate-45 bg-foreground";

/** 滑鼠從中心偏移多少算「到底」—— 傾斜與位移都對應到這個範圍的兩端 */
const TILT_RANGE = 60;
const TILT_DEGREES = 14;
const TILT_SHIFT_PX = 12;

export interface TooltipWobble {
  rotate: MotionValue<number> | number;
  x: MotionValue<number> | number;
  /** 滑鼠在觸發區裡移動時呼叫 */
  track: (e: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => void;
  /** 滑鼠離開時呼叫 —— 角度要歸零,不然會留到下一次 */
  reset: () => void;
  /** 系統關掉動畫效果時為 true,進場動畫也要一起跳過 */
  reduced: boolean;
}

/**
 * 跟著滑鼠左右晃。
 *
 * 兩件事跟直覺不同:
 *
 * 1. **要照觸發區的寬度換算**,不能直接把「離中心幾 px」餵進去。小夥伴的感應區
 *    只有 91px 寬(對齊角色實際佔的位置),固定用 ±60px 當兩端的話,滑到邊邊
 *    也只轉得到一半,看起來像沒反應。
 * 2. **離開要歸零**。角度停在最後一次滑鼠的位置的話,你把它弄歪之後手一移開,
 *    之後每一次冒出來都是歪的 —— 那是狀態,不是回饋。
 */
export function useTooltipWobble(): TooltipWobble {
  const reduced = useReducedMotion();
  const pointerX = useMotionValue(0);
  const rotate = useSpring(
    useTransform(pointerX, [-TILT_RANGE, TILT_RANGE], [-TILT_DEGREES, TILT_DEGREES]),
    TOOLTIP_SPRING,
  );
  const x = useSpring(
    useTransform(pointerX, [-TILT_RANGE, TILT_RANGE], [-TILT_SHIFT_PX, TILT_SHIFT_PX]),
    TOOLTIP_SPRING,
  );

  const track = (e: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => {
    if (reduced) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const offset = e.clientX - rect.left - rect.width / 2;
    // 換算成 ±TILT_RANGE 的比例,觸發區多寬都能轉到底
    pointerX.set((offset / (rect.width / 2)) * TILT_RANGE);
  };

  const reset = () => pointerX.set(0);

  // 系統關掉動畫效果時完全不轉 —— 傾斜是純裝飾,沒有它照樣讀得到字
  return reduced
    ? { rotate: 0, x: 0, track, reset, reduced }
    : { rotate, x, track, reset, reduced };
}
