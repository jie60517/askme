/** formatBytes:1024 進位、10 以上不留小數。 */
import {describe, expect, it} from 'vitest';

import {formatBytes} from '../files';

describe('formatBytes', () => {
  it('null / undefined 回 null(缺大小的列不畫)', () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(undefined)).toBeNull();
  });

  it('1024 以下講 B', () => {
    expect(formatBytes(120)).toBe('120 B');
  });

  it('KB / MB,10 以下留一位小數', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
  });

  it('10 以上不留小數(那個 .4 只是噪音)', () => {
    expect(formatBytes(123.4 * 1024 * 1024)).toBe('123 MB');
  });

  it('進位之後到了 1024 就升一個單位 —— 不會出現「1024 KB」', () => {
    expect(formatBytes(1_048_575)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 - 1)).not.toContain('1024');
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1 GB');
    // GB 已經是最後一階:再大也停在 GB
    expect(formatBytes(2048 * 1024 * 1024 * 1024)).toBe('2048 GB');
  });
});
