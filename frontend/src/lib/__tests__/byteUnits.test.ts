/** 位元組升階規則(檔案欄與檔案區共用)。 */
import {describe, expect, it} from 'vitest';

import {scaleBytes} from '../byteUnits';

const UNITS = ['KB', 'MB', 'GB'] as const;
const oneDecimal = (v: number) => Math.round(v * 10) / 10;

describe('scaleBytes', () => {
  it('還沒到 1024 就停在這一階,回傳的是沒進位的值', () => {
    expect(scaleBytes(1536, UNITS, oneDecimal)).toEqual({value: 1.5, unit: 'KB'});
  });

  it('進位之後到了 1024 就升一階', () => {
    const r = scaleBytes(1_048_575, UNITS, oneDecimal);
    expect(r.unit).toBe('MB');
    expect(oneDecimal(r.value)).toBe(1);
  });

  it('進位的精度由呼叫端決定:整數進位比一位小數更早升階', () => {
    // 1023.6 KB:一位小數是 1023.6(不升),整數是 1024(升)
    const bytes = 1023.6 * 1024;
    expect(scaleBytes(bytes, UNITS, oneDecimal).unit).toBe('KB');
    expect(scaleBytes(bytes, UNITS, Math.round).unit).toBe('MB');
  });

  it('最後一階就停住', () => {
    expect(scaleBytes(4096 * 1024 ** 3, UNITS, oneDecimal).unit).toBe('GB');
  });
});
