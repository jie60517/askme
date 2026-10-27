import {afterEach, describe, expect, it, vi} from 'vitest';

import type {ISODateString} from '@astryxdesign/core/utils';

import {isoDateParam, openRangeLabel, todayIso} from '../urlParams';

const d = (s: string) => s as ISODateString;

describe('isoDateParam', () => {
  it('只收 YYYY-MM-DD,其餘當沒有', () => {
    expect(isoDateParam('2026-10-05')).toBe('2026-10-05');
    expect(isoDateParam('abc')).toBeUndefined();
    expect(isoDateParam(null)).toBeUndefined();
  });
});

describe('todayIso', () => {
  afterEach(() => vi.useRealTimers());

  it('用本地時區(早上 8 點前不能拿到昨天)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 7, 30)); // 本地 10/5 早上 7:30 —— UTC 還是 10/4
    expect(todayIso()).toBe('2026-10-05');
  });
});

describe('openRangeLabel(只帶一端日期 = 開放區間)', () => {
  it('只有起點 / 只有終點:講出開放的那一邊', () => {
    expect(openRangeLabel(d('2026-10-04'), undefined)).toBe('2026年10月4日 起');
    expect(openRangeLabel(undefined, d('2026-10-04'))).toBe('到 2026年10月4日 為止');
    expect(openRangeLabel(undefined, d('2025-01-09'))).toBe('到 2025年1月9日 為止');
  });

  it('兩端都有 / 都沒有:null(交給區間元件或預設的 placeholder)', () => {
    expect(openRangeLabel(d('2026-10-01'), d('2026-10-03'))).toBeNull();
    expect(openRangeLabel(undefined, undefined)).toBeNull();
  });
});
