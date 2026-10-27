// @vitest-environment jsdom
/** KPI 卡的「持平」判定。 */
import {describe, expect, it} from 'vitest';

import {isFlatChange} from '../MetricCard';

describe('isFlatChange', () => {
  it('顯示出來是 0.0% 的就是持平 —— 不畫綠色上箭頭配「+0.0%」', () => {
    // 1000 → 1000.4
    expect(isFlatChange((1000.4 - 1000) / 1000)).toBe(true);
    expect(isFlatChange(0)).toBe(true);
    expect(isFlatChange(-0.0004)).toBe(true);
  });

  it('看得到的變化照畫', () => {
    expect(isFlatChange(0.001)).toBe(false);
    expect(isFlatChange(-0.05)).toBe(false);
  });
});
