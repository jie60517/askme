import {describe, expect, it} from 'vitest';

import {easeStep, frameDelta, FRAME_MS, MAX_FRAME_GAP_MS} from '../frameEase';

describe('easeStep', () => {
  it('剛好一幀就是原本的比例', () => {
    expect(easeStep(0.18, FRAME_MS)).toBeCloseTo(0.18, 10);
  });

  it('120Hz 走兩次等於 60Hz 走一次(幀率無關)', () => {
    const half = easeStep(0.18, FRAME_MS / 2);
    const twoHalves = 1 - (1 - half) * (1 - half);
    expect(twoHalves).toBeCloseTo(0.18, 10);
  });
});

describe('frameDelta', () => {
  it('第一幀當一幀算,超過的夾在三幀', () => {
    expect(frameDelta(undefined, 1000)).toBe(FRAME_MS);
    expect(frameDelta(1000, 1008)).toBe(8);
    expect(frameDelta(1000, 1900)).toBe(MAX_FRAME_GAP_MS);
  });
});
