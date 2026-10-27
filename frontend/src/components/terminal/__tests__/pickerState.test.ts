import {describe, expect, it} from 'vitest';

import {type PickerTab, showsPicker, watchesIdle} from '../pickerState';

const tab = (over: Partial<PickerTab> = {}): PickerTab => ({
  hostId: 'web-a',
  isLive: true,
  hasStatus: true,
  ...over,
});

describe('showsPicker', () => {
  it('還沒選主機、或選了但後端還沒回第一則狀態(連線中)的頁籤,畫的是主機卡片', () => {
    expect(showsPicker(tab({hostId: null, isLive: false, hasStatus: false}))).toBe(true);
    expect(showsPicker(tab({isLive: false, hasStatus: false}))).toBe(true);
  });

  it('斷線的頁籤 isLive 也是 false,但它畫的是終端機(上面印著斷線原因)', () => {
    expect(showsPicker(tab({isLive: false, hasStatus: true}))).toBe(false);
  });
});

describe('watchesIdle', () => {
  it('看得到的全是連著的終端機才計閒置', () => {
    expect(watchesIdle([tab()])).toBe(true);
    expect(watchesIdle([tab(), tab({hostId: 'main'})])).toBe(true);
  });

  it('停在選主機的畫面不計(另一個頁籤連著也一樣 —— 那個頁籤不在 shown 裡)', () => {
    expect(watchesIdle([tab({hostId: null, isLive: false, hasStatus: false})])).toBe(false);
  });

  it('分割畫面其中一塊還在選主機,整個不計', () => {
    expect(watchesIdle([tab(), tab({hostId: null, isLive: false, hasStatus: false})])).toBe(false);
  });

  it('斷線的終端機不計(沒有東西好保護);沒有任何一塊也不計', () => {
    expect(watchesIdle([tab({isLive: false})])).toBe(false);
    expect(watchesIdle([])).toBe(false);
  });
});
