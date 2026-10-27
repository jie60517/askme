/** 放手速度(FlowCanvas 慣性與燈箱左右滑共用)。 */
import {describe, expect, it} from 'vitest';

import {releaseVelocityPxPerMs} from '../velocity';

describe('releaseVelocityPxPerMs', () => {
  it('最近 100ms 內第一筆到最後一筆的平均,兩軸各算', () => {
    const v = releaseVelocityPxPerMs(
      [
        {x: 0, y: 0, t: 0}, // 太舊,不算
        {x: 100, y: 0, t: 200},
        {x: 110, y: 5, t: 250},
        {x: 130, y: 15, t: 300},
      ],
      300,
    );
    expect(v.x).toBeCloseTo(0.3, 9);
    expect(v.y).toBeCloseTo(0.15, 9);
  });

  it('停住一下才放 = 0:不管有沒有把放手那一筆放進來', () => {
    // 有放手那一筆(同一個位置、隔 280ms)
    expect(releaseVelocityPxPerMs([{x: 0, t: 0}, {x: 50, t: 20}, {x: 50, t: 300}])).toEqual({x: 0, y: 0});
    // 沒放,只給放手時間
    expect(releaseVelocityPxPerMs([{x: 0, t: 0}, {x: 50, t: 20}], 300)).toEqual({x: 0, y: 0});
  });

  it('沒有 y 的樣本當 0;不到兩筆 = 0', () => {
    expect(releaseVelocityPxPerMs([{x: 0, t: 0}, {x: 10, t: 10}])).toEqual({x: 1, y: 0});
    expect(releaseVelocityPxPerMs([{x: 1, t: 0}])).toEqual({x: 0, y: 0});
    expect(releaseVelocityPxPerMs([])).toEqual({x: 0, y: 0});
  });
});
