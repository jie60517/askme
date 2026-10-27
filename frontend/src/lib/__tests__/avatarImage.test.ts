/**
 * 頭像裁切框的數學。
 *
 * 這幾支沒有畫面,也不會丟例外 —— 算錯的症狀是**存下去的頭像有一塊白邊**
 * (裁切框跑到照片外面,那一塊是鋪底的白色),而那要等使用者換好照片、
 * 在側邊欄看到那顆小圓點才發現。所以純數學那一半要單獨測。
 *
 * ⚠️ `drawAvatarCrop` / `avatarCropToDataUri` **不在這裡測**:它們要 canvas,
 * 而這個專案的 vitest 預設環境是 node(見 frontend/.claude/CLAUDE.md)。
 * 它們本身沒有分支,真正會算錯的是下面這兩支。
 */
import {describe, expect, it} from 'vitest';

import {clampCrop, cropOvershoot, cropRect, defaultCrop, MAX_ZOOM, MIN_ZOOM} from '../avatarImage';

/** 橫的、直的各一張 —— 短邊在哪一軸決定了整個換算。 */
const WIDE = {width: 400, height: 200};
const TALL = {width: 200, height: 400};

describe('defaultCrop', () => {
  /*
   * ⚠️ 預設值必須是**置中裁切**(取短邊、長邊兩側各切一半),
   * 沒去動裁切框的人換照片時構圖才是預期的樣子。
   */
  it('預設就是置中裁切:取短邊、長邊兩側各切一半', () => {
    expect(cropRect(WIDE, defaultCrop(WIDE))).toEqual({x: 100, y: 0, side: 200});
    expect(cropRect(TALL, defaultCrop(TALL))).toEqual({x: 0, y: 100, side: 200});
  });
});

describe('clampCrop', () => {
  it('倍率夾在 1~4', () => {
    expect(clampCrop(WIDE, {zoom: 0.2, cx: 200, cy: 100}).zoom).toBe(MIN_ZOOM);
    expect(clampCrop(WIDE, {zoom: 99, cx: 200, cy: 100}).zoom).toBe(MAX_ZOOM);
  });

  /*
   * ⚠️ 邊界是「半個邊長」不是照片的邊。用後者的話拖到角落時正方形會有一半
   * 跑到照片外面 —— 那一塊在輸出裡是白的。
   */
  it('中心被夾到「整個正方形還在照片裡」', () => {
    // zoom 1 → 邊長 200 → 中心的 x 只能在 100~300 之間
    expect(clampCrop(WIDE, {zoom: 1, cx: 0, cy: 100}).cx).toBe(100);
    expect(clampCrop(WIDE, {zoom: 1, cx: 9999, cy: 100}).cx).toBe(300);
    // y 軸上短邊撐滿,中心只有 100 這一個合法值
    expect(clampCrop(WIDE, {zoom: 1, cx: 200, cy: 0}).cy).toBe(100);
    expect(clampCrop(WIDE, {zoom: 1, cx: 200, cy: 9999}).cy).toBe(100);
  });

  it('放大之後可以走的範圍變大', () => {
    // zoom 2 → 邊長 100 → 中心的 y 可以在 50~150 之間
    expect(clampCrop(WIDE, {zoom: 2, cx: 200, cy: 0}).cy).toBe(50);
    expect(clampCrop(WIDE, {zoom: 2, cx: 200, cy: 9999}).cy).toBe(150);
  });

  /*
   * 壞值來自拖曳與拉桿(中間任何一步除到 0 就是 NaN)。不擋的話 NaN 會一路
   * 傳進 `drawImage`,畫出來是一片空白 —— 而且完全不會報錯。
   */
  it('NaN 一律退回置中 / 最小倍率', () => {
    expect(clampCrop(WIDE, {zoom: Number.NaN, cx: Number.NaN, cy: Number.NaN})).toEqual({
      zoom: MIN_ZOOM,
      cx: 200,
      cy: 100,
    });
  });
});

describe('cropRect', () => {
  it('邊長 = 短邊 ÷ 倍率', () => {
    expect(cropRect(TALL, {zoom: 2, cx: 100, cy: 200}).side).toBe(100);
    expect(cropRect(TALL, {zoom: 4, cx: 100, cy: 200}).side).toBe(50);
  });

  it('回的是左上角,而且已經夾過了', () => {
    expect(cropRect(TALL, {zoom: 2, cx: -50, cy: 200})).toEqual({x: 0, y: 150, side: 100});
  });
});

/*
 * 拖過邊界的橡皮筋。超界量只畫在預覽上,
 * 交出去的裁切框照樣是 `clampCrop` 夾好的 —— 所以這裡只要確定:界內是 0、界外有阻力、有上限。
 */
describe('cropOvershoot', () => {
  it('界內沒有超界量', () => {
    expect(cropOvershoot(WIDE, defaultCrop(WIDE), 32)).toEqual({dx: 0, dy: 0});
  });

  it('超界越多走越少,而且永遠到不了上限', () => {
    // WIDE、zoom 1:cx 合法範圍 100~300
    const a = cropOvershoot(WIDE, {zoom: 1, cx: 320, cy: 100}, 32).dx;
    const b = cropOvershoot(WIDE, {zoom: 1, cx: 400, cy: 100}, 32).dx;
    const far = cropOvershoot(WIDE, {zoom: 1, cx: 1e9, cy: 100}, 32).dx;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(20);
    expect(b).toBeGreaterThan(a);
    expect(far).toBeLessThan(32);
  });

  it('往另一邊超界是負的,兩軸各算各的', () => {
    const o = cropOvershoot(WIDE, {zoom: 1, cx: 50, cy: 100}, 32);
    expect(o.dx).toBeLessThan(0);
    expect(o.dy).toBe(0);
  });

  it('壞值當作沒有超界', () => {
    expect(cropOvershoot(WIDE, {zoom: 1, cx: Number.NaN, cy: 100}, 32)).toEqual({dx: 0, dy: 0});
  });
});
