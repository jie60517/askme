/** 時間格式。 */
import {describe, expect, it} from 'vitest';

import {
  formatAverageDuration,
  formatDayLabel,
  formatDuration,
  formatEditedAgo,
  formatStepDuration,
  parseServerTime,
  stepDurationMs,
} from '../time';

describe('formatDuration(人的尺度:秒與分)', () => {
  it('一分鐘以內只講秒', () => {
    expect(formatDuration(28_000)).toBe('28s');
  });
  it('超過一分鐘講分+秒', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
  it('負值不出現負號', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('formatStepDuration(步驟的尺度:毫秒起跳)', () => {
  it('一秒內講毫秒 —— 用 formatDuration 會整排 0s', () => {
    expect(formatStepDuration(340)).toBe('340ms');
  });
  it('一分鐘內講一位小數的秒', () => {
    expect(formatStepDuration(1_400)).toBe('1.4s');
  });
  it('超過一分鐘退回 formatDuration 的格式', () => {
    expect(formatStepDuration(65_000)).toBe('1m 5s');
  });
  it('壞值回空字串(舊紀錄沒有 at_ms 時不畫,不要畫出假數字)', () => {
    expect(formatStepDuration(-1)).toBe('');
  });
});

describe('formatDayLabel(日期分隔線)', () => {
  it('今天是 Today', () => {
    expect(formatDayLabel(Date.now())).toBe('Today');
  });
  it('昨天是 Yesterday(比本地日期,不是除以 86400000)', () => {
    expect(formatDayLabel(Date.now() - 24 * 3600 * 1000)).toBe('Yesterday');
  });
});

describe('parseServerTime', () => {
  it('沒有時區的 ISO 當成 UTC(後端存的就是 UTC)', () => {
    const withZ = parseServerTime('2026-08-21T02:00:00Z');
    const without = parseServerTime('2026-08-21T02:00:00');
    expect(without.getTime()).toBe(withZ.getTime());
  });
});

describe('stepDurationMs', () => {
  it('有工具真正的耗時就用它,不用「到下一步之前」的區間', () => {
    // 工具本身 282ms,區間算法(最後一步算到答案寫完)會算成 13.0s
    expect(stepDurationMs(282, 5_000, 18_000)).toBe(282);
  });

  it('沒有真正的耗時(舊紀錄)才退回相鄰兩步相減', () => {
    expect(stepDurationMs(undefined, 5_000, 6_900)).toBe(1_900);
    expect(stepDurationMs(null, 5_000, 6_900)).toBe(1_900);
  });

  it('算不出來就是 undefined,不用 0 頂替', () => {
    expect(stepDurationMs(undefined, undefined, 6_900)).toBeUndefined();
    expect(stepDurationMs(undefined, 5_000, null)).toBeUndefined();
    expect(stepDurationMs(undefined, 5_000, 4_000)).toBeUndefined();
  });

  it('真正的耗時是 0 也算數(很快的工具)', () => {
    expect(stepDurationMs(0, 5_000, 18_000)).toBe(0);
  });
});

describe('formatAverageDuration(平均值:秒 → 分 → 小時)', () => {
  it('90 秒以下講秒、以上講分', () => {
    expect(formatAverageDuration(12_400)).toBe('12.4s');
    expect(formatAverageDuration(186_000)).toBe('3.1 min');
  });

  it('90 分鐘以上講小時 —— 不要「180.0 min」', () => {
    expect(formatAverageDuration(3 * 3600_000)).toBe('3.0 h');
    expect(formatAverageDuration(89 * 60_000)).toBe('89.0 min');
    expect(formatAverageDuration(90 * 60_000)).toBe('1.5 h');
  });

  it('換階看四捨五入之後的值:89.96 秒不會顯示成「90.0s」', () => {
    expect(formatAverageDuration(89_960)).toBe('1.5 min');
  });
});

describe('formatEditedAgo(筆記右上「編輯於 …」)', () => {
  const now = new Date(2026, 9, 13, 15, 0, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it('一分鐘內剛剛、一小時內幾分鐘前、今天之內幾小時前', () => {
    expect(formatEditedAgo(ago(20_000), now)).toBe('剛剛');
    expect(formatEditedAgo(ago(3 * 60_000), now)).toBe('3 分鐘前');
    expect(formatEditedAgo(ago(2 * 3_600_000 + 60_000), now)).toBe('2 小時前');
  });
  it('昨天以前跟清單時間同一套', () => {
    expect(formatEditedAgo(ago(20 * 3_600_000), now)).toBe('昨天');
    expect(formatEditedAgo(new Date(2026, 8, 3, 9, 0).toISOString(), now)).toBe('9/3');
  });
});
