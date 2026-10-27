/**
 * 框選截圖的座標換算:畫面上的框 → 抓到的那一格上的像素。
 * 錯了的症狀是「存下來的圖不是框的那一塊」(偏移、被壓扁),只有高解析螢幕或分享列出現時才看得出來。
 */
import {describe, expect, it} from 'vitest';

import {rectFrom, toImageRect} from '../regionShot';

describe('rectFrom', () => {
  it('往哪個方向拖都是同一個框', () => {
    const want = {x: 10, y: 20, w: 30, h: 40};
    expect(rectFrom({x: 10, y: 20}, {x: 40, y: 60})).toEqual(want);
    expect(rectFrom({x: 40, y: 60}, {x: 10, y: 20})).toEqual(want);
    expect(rectFrom({x: 40, y: 20}, {x: 10, y: 60})).toEqual(want);
  });
});

describe('toImageRect', () => {
  it('高解析螢幕(圖是畫面的兩倍寬):兩軸都乘二', () => {
    expect(toImageRect({x: 100, y: 50, w: 200, h: 80}, 1440, {width: 2880, height: 1700})).toEqual({
      x: 200,
      y: 100,
      w: 400,
      h: 160,
    });
  });

  it('兩軸用同一個倍率(分享列讓那一格比視窗矮,不能拿高度另外算)', () => {
    // 畫面 1440 寬;那一格 1440×860(比 900 高的視窗矮 40):倍率 1,y 不能被拉伸
    expect(toImageRect({x: 0, y: 400, w: 100, h: 100}, 1440, {width: 1440, height: 860})).toEqual({
      x: 0,
      y: 400,
      w: 100,
      h: 100,
    });
  });

  it('框拖到圖外面(圖比視窗矮時的下緣):裁到圖為止', () => {
    expect(toImageRect({x: 1400, y: 800, w: 200, h: 200}, 1440, {width: 1440, height: 860})).toEqual({
      x: 1400,
      y: 800,
      w: 40,
      h: 60,
    });
  });
});
