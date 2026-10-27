/**
 * `useFlip` 讀 CSS 時間 token 的單位:`0.225s` 不能被當成 0.225ms。
 */
import {describe, expect, it} from 'vitest';

import {cssDurationMs} from '../useFlip';

describe('cssDurationMs', () => {
  it('ms 照收', () => {
    expect(cssDurationMs('225ms')).toBe(225);
    expect(cssDurationMs(' 300ms ')).toBe(300);
  });
  it('s 換成毫秒', () => {
    expect(cssDurationMs('0.225s')).toBe(225);
    expect(cssDurationMs('1s')).toBe(1000);
  });
  it('讀不懂回 null(呼叫端退回預設值)', () => {
    expect(cssDurationMs('')).toBeNull();
    expect(cssDurationMs('var(--x)')).toBeNull();
  });
});
