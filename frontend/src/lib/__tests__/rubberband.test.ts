import {describe, expect, it} from 'vitest';

import {clampElastic, easeOutCubic, OVERDRAG_MAX_PX, rubberBand} from '../rubberband';

describe('rubberBand', () => {
  it('沒有超界就是 0;超越多走越少,漸近到上限', () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-5)).toBe(0);
    expect(rubberBand(32)).toBe(16);
    expect(rubberBand(1e9)).toBeLessThan(OVERDRAG_MAX_PX);
    expect(rubberBand(64)).toBeGreaterThan(rubberBand(32));
  });
});

describe('clampElastic', () => {
  it('界內原樣、界外打折 —— 跟側邊欄那一支同一條曲線', () => {
    expect(clampElastic(100, 48, 480)).toBe(100);
    expect(clampElastic(480 + 32, 48, 480)).toBe(480 + 16);
    expect(clampElastic(48 - 32, 48, 480)).toBe(48 - 16);
  });
});

describe('easeOutCubic', () => {
  it('從 0 到 1,超出的夾住', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
