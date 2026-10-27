// @vitest-environment jsdom
/**
 * 燈箱圖片的觸控左右滑:放手那一刻翻不翻、往哪翻。
 * 跟手的那一段寫在 DOM 上(沒有東西可以斷言),這裡只測判定本身。
 */
import {describe, expect, it} from 'vitest';

import {swipeStep} from '../FileLightbox';
import {releaseVelocityPxPerMs} from '../../lib/velocity';

/** 燈箱只看橫向(px/ms),共用的那一支回兩軸 */
const releaseVelocity = (samples: {t: number; x: number}[]) => releaseVelocityPxPerMs(samples).x;

const W = 300;

describe('swipeStep', () => {
  it('慢慢拖過三成寬再放:翻(往左 = 下一張、往右 = 上一張)', () => {
    expect(swipeStep(-120, 0, W)).toBe(1);
    expect(swipeStep(120, 0, W)).toBe(-1);
  });

  it('距離不到、速度也不夠:彈回原位', () => {
    expect(swipeStep(-40, -0.05, W)).toBe(0);
    expect(swipeStep(0, 0, W)).toBe(0);
  });

  it('距離很短但甩得夠快:翻', () => {
    expect(swipeStep(-20, -0.4, W)).toBe(1);
    expect(swipeStep(20, 0.4, W)).toBe(-1);
  });

  it('往左拖了一大段、最後往右甩回來 = 算了,不翻', () => {
    expect(swipeStep(-150, 0.8, W)).toBe(0);
  });

  it('量不到寬度(還沒排版)就不翻', () => {
    expect(swipeStep(-200, -1, 0)).toBe(0);
  });
});

describe('releaseVelocity', () => {
  it('一路在動:看最後 100ms 的平均', () => {
    expect(releaseVelocity([
      {t: 0, x: 300},
      {t: 50, x: 280},
      {t: 100, x: 250},
      {t: 120, x: 240},
    ])).toBeCloseTo((240 - 280) / 70);
  });

  it('甩到一半停住、過一會兒才抬手 = 0(放手那一筆有算進去)', () => {
    // 最後一筆是 pointerup:跟上一筆同一個位置,隔了 300ms
    expect(releaseVelocity([
      {t: 0, x: 300},
      {t: 30, x: 200},
      {t: 330, x: 200},
    ])).toBe(0);
    // 連帶 swipeStep 只剩距離可以判:100px 不到三成寬,彈回
    expect(swipeStep(-100, 0, 400)).toBe(0);
  });

  it('只有一筆 / 沒有資料:0', () => {
    expect(releaseVelocity([{t: 0, x: 1}])).toBe(0);
    expect(releaseVelocity([])).toBe(0);
  });
});
