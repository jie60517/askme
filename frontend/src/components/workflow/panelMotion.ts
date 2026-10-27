/**
 * Work Flow 畫布底部那兩塊浮動面板(執行紀錄、每一步的輸出)共用的進場:往上滑一點 + 淡入;
 * 減少動態只淡入。一份,兩塊共用。
 */
import * as stylex from '@stylexjs/stylex';

const rise = stylex.keyframes({from: {opacity: 0, transform: 'translateY(var(--spacing-3))'}});
const fadeIn = stylex.keyframes({from: {opacity: 0}});

export const panelMotion = stylex.create({
  enter: {
    animationName: {default: rise, '@media (prefers-reduced-motion: reduce)': fadeIn},
    animationDuration: 'var(--duration-medium)',
    animationTimingFunction: 'var(--ease-panel)',
  },
});
