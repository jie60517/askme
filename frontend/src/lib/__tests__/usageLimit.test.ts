/**
 * 小夥伴那句用量台詞(`lib/usageLimit.ts`)。
 *
 * 釘住的是「哪一半沒有資料就少講哪一半」與差值的三種「不知道」——
 * 這句話是唸給人聽的,講錯一個數字比不講更糟。
 */
import {describe, expect, it} from 'vitest';

import {describeUsage, formatResetIn, usageDelta} from '../usageLimit';

describe('usageDelta', () => {
  it('答完減送出', () => {
    expect(usageDelta(40, 43)).toBe(3);
  });

  it('沒有基準就是不知道,不是 0', () => {
    expect(usageDelta(null, 43)).toBeNull();
  });

  it('視窗在這一題進行中重置(答完比送出少)→ 不知道,不唸負數', () => {
    expect(usageDelta(80, 5)).toBeNull();
  });

  it('兩份一樣(這一題很小)→ 照講 0', () => {
    expect(usageDelta(40, 40)).toBe(0);
  });
});

describe('describeUsage', () => {
  const full = {used_percent: 43, remaining_percent: 57, resets_in_minutes: 135};

  it('三段都有', () => {
    expect(describeUsage(full, 3)).toBe('本次耗用 3%，剩餘 57%，2 小時 15 分後重置！');
  });

  it('沒有差值就不講「本次耗用」', () => {
    expect(describeUsage(full, null)).toBe('剩餘 57%，2 小時 15 分後重置！');
  });

  it('沒有重置時間就不講「後重置」', () => {
    expect(describeUsage({...full, resets_in_minutes: null}, 3)).toBe('本次耗用 3%，剩餘 57%！');
  });

  it('只剩「剩餘」也成句', () => {
    expect(describeUsage({...full, resets_in_minutes: null}, null)).toBe('剩餘 57%！');
  });
});

describe('formatResetIn', () => {
  it('一小時內講分鐘', () => {
    expect(formatResetIn(45)).toBe('45 分鐘');
  });
  it('整點只講小時', () => {
    expect(formatResetIn(120)).toBe('2 小時');
  });
  it('超過一小時講小時加分', () => {
    expect(formatResetIn(135)).toBe('2 小時 15 分');
  });
});
