/**
 * 小夥伴(Bloub)整天常駐也要一直眨眼。
 *
 * 上游的眨眼時間表只排到 900 秒左右(`bloub/face.ts`),外殼的時鐘整天累加 ——
 * 沒有取模的話,過了 15 分鐘就再也不眨眼。這是 `bloub/` 唯一的本地補丁,升級上游時這條會抓到漏帶。
 */
import {describe, expect, it} from 'vitest';

import {BLINK_PERIOD, liveliness} from '../bloub/face';

/** [from, to) 之間眼皮有沒有闔上過(取樣比一次眨眼的 0.18 秒密很多) */
function blinksBetween(from: number, to: number): number {
  let count = 0;
  let closed = false;
  for (let t = from; t < to; t += 1 / 240) {
    const isClosed = liveliness(t).lid < 0.5;
    if (isClosed && !closed) count++;
    closed = isClosed;
  }
  return count;
}

describe('Bloub 眨眼', () => {
  it('前 15 分鐘之內會眨眼', () => {
    expect(blinksBetween(840, 900)).toBeGreaterThan(5);
  });

  it('過了 900 秒還會眨眼', () => {
    expect(blinksBetween(900, 960)).toBeGreaterThan(5);
    expect(blinksBetween(8 * 3600, 8 * 3600 + 60)).toBeGreaterThan(5);
  });

  it('時間表循環', () => {
    for (const t of [12.3, 250.05, 777.7]) {
      expect(liveliness(t + BLINK_PERIOD).lid).toBeCloseTo(liveliness(t).lid, 9);
    }
  });

  it('接縫處不會眨到一半就張開(最後一次眨眼演得完)', () => {
    // 週期涵蓋整張表:最後一次眨眼結束之後才接回開頭
    expect(BLINK_PERIOD).toBeGreaterThan(900);
    let prev = liveliness(BLINK_PERIOD - 0.5).lid;
    for (let t = BLINK_PERIOD - 0.5; t < BLINK_PERIOD + 0.5; t += 1 / 240) {
      const lid = liveliness(t).lid;
      // 一格之內從快闔上跳回全開 = 被切斷了(正常的睜眼是 0.1 秒左右慢慢張開)
      expect(lid - prev).toBeLessThan(0.5);
      prev = lid;
    }
  });
});
