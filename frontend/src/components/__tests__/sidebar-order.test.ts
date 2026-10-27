/**
 * 側邊欄自訂順序的兩支純函式(`sidebar-order.ts`)。
 *
 * 右鍵的 ^/v(`moveWithin`)與長按對調(`swapWithin`)是**同一個語意**——
 * 都是「兩個位置對調」,回傳原物件代表「什麼都沒發生」。這裡釘的是那個契約。
 */
import {describe, expect, it} from 'vitest';

import {applyOrder, moveWithin, swapWithin, type OrderMap} from '../sidebar-order';

const keys = ['a', 'b', 'c'];

describe('moveWithin', () => {
  it('往下一格 = 跟下一個對調', () => {
    const next = moveWithin({}, 'list', keys, 'a', 1);
    expect(next.list).toEqual(['b', 'a', 'c']);
  });

  it('到頭/到尾移不動 → 回原物件(參照相同)', () => {
    const order: OrderMap = {};
    expect(moveWithin(order, 'list', keys, 'a', -1)).toBe(order);
    expect(moveWithin(order, 'list', keys, 'c', 1)).toBe(order);
  });
});

describe('swapWithin', () => {
  it('對調任意兩個,不是插入', () => {
    const next = swapWithin({}, 'list', keys, 'a', 'c');
    expect(next.list).toEqual(['c', 'b', 'a']);
  });

  it('自己跟自己、或有一邊不在清單裡 → 回原物件', () => {
    const order: OrderMap = {};
    expect(swapWithin(order, 'list', keys, 'a', 'a')).toBe(order);
    expect(swapWithin(order, 'list', keys, 'a', 'zzz')).toBe(order);
  });

  it('存的是整份順序,applyOrder 照它重排', () => {
    const next = swapWithin({}, 'list', keys, 'a', 'b');
    const items = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
    expect(applyOrder(next, 'list', items, (x) => x.id).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
});
