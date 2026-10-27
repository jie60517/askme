import {describe, expect, it} from 'vitest';

import {hexToHsv, hsvToHex, parseHexInput} from '../hsv';

describe('HSV ↔ hex', () => {
  it('來回一趟不變', () => {
    for (const hex of ['#000000', '#ffffff', '#e8590c', '#2fb380', '#3b93f0', '#808080', '#ff00ff']) {
      expect(hsvToHex(hexToHsv(hex)!)).toBe(hex);
    }
  });

  it('純色的色相', () => {
    expect(hexToHsv('#ff0000')).toEqual({h: 0, s: 1, v: 1});
    expect(hexToHsv('#00ff00')!.h).toBe(120);
    expect(hexToHsv('#0000ff')!.h).toBe(240);
  });

  it('灰階與全黑:飽和度 / 亮度是 0,不會算出 NaN', () => {
    expect(hexToHsv('#000000')).toEqual({h: 0, s: 0, v: 0});
    expect(hexToHsv('#808080')!.s).toBe(0);
  });

  it('不是 #rrggbb 的回 null', () => {
    expect(hexToHsv('#fff')).toBeNull();
    expect(hexToHsv('red')).toBeNull();
  });
});

describe('色碼輸入框', () => {
  it('少打 # 、大寫、前後空白都收,一律小寫', () => {
    expect(parseHexInput('E8590C')).toBe('#e8590c');
    expect(parseHexInput(' #2FB380 ')).toBe('#2fb380');
  });

  it('還沒打完或打錯的回 null', () => {
    for (const t of ['', '#', '#e859', '#e8590g', '#e8590c0', 'url(#x)']) expect(parseHexInput(t)).toBeNull();
  });
});
