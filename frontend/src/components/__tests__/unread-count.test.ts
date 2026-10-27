/**
 * 側邊欄未讀數的顯示字(`unread-count.ts`)。
 * 釘的是「封頂 99+、99 以內原樣」這個邊界;確切數字給報讀軟體那一份在 `Sidebar.tsx` 的 `UnreadBadge`。
 */
import {describe, expect, it} from 'vitest';

import {formatUnreadCount, isUnreadCapped} from '../unread-count';

describe('formatUnreadCount', () => {
  it('99 以內原樣印', () => {
    expect(formatUnreadCount(1)).toBe('1');
    expect(formatUnreadCount(99)).toBe('99');
  });

  it('超過 99 封頂成 99+', () => {
    expect(formatUnreadCount(100)).toBe('99+');
    expect(formatUnreadCount(12345)).toBe('99+');
  });

  it('isUnreadCapped 跟顯示字的邊界一致', () => {
    expect(isUnreadCapped(99)).toBe(false);
    expect(isUnreadCapped(100)).toBe(true);
  });
});
