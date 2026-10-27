/** 注音還原成英打(#5 的「自動切英文」)。 */
import {describe, expect, it} from 'vitest';

import {fromZhuyin} from '../zhuyin';

describe('fromZhuyin', () => {
  it('注音符號還原成大千式的按鍵(想打 jacky 打出 ㄨㄇㄏㄜㄗ)', () => {
    expect(fromZhuyin('ㄨㄇㄏㄜㄗ')).toBe('jacky');
  });

  it('英文與數字原樣通過', () => {
    expect(fromZhuyin('sarah123')).toBe('sarah123');
  });

  it('中文字不動 —— 搜「小明」還是小明', () => {
    expect(fromZhuyin('小明')).toBe('小明');
  });

  it('調號也還原(ˇ→3、ˋ→4、ˊ→6、˙→7)', () => {
    expect(fromZhuyin('ˇˋˊ˙')).toBe('3467');
  });

  it('混排:注音夾英文各自處理', () => {
    expect(fromZhuyin('aㄨb')).toBe('ajb');
  });
});
