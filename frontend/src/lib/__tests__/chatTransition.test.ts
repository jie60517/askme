/**
 * New chat ↔ 對話的過場要在哪些換頁演(`lib/chatTransition.ts`)。
 *
 * 值得測的是邊界:只有兩端都是對話頁才演 —— 從對話頁點去用量頁、筆記,或在同一頁再點一次,
 * 都不該起過場(起了的話整頁凍住 450ms,而且沒有東西可以接)。
 */
import {describe, expect, it} from 'vitest';

import {isChatPath, shouldMorphChat} from '../chatTransition';

describe('對話頁之間的過場', () => {
  it('空白頁與某一組對話都算對話頁', () => {
    expect(isChatPath('/')).toBe(true);
    expect(isChatPath('/c/abc')).toBe(true);
    expect(isChatPath('/stats')).toBe(false);
    expect(isChatPath('/notes')).toBe(false);
    expect(isChatPath(undefined)).toBe(false);
  });

  it('New chat ↔ 對話、兩組對話互切 → 演', () => {
    expect(shouldMorphChat('/', '/c/abc')).toBe(true);
    expect(shouldMorphChat('/c/abc', '/')).toBe(true);
    expect(shouldMorphChat('/c/abc', '/c/def')).toBe(true);
  });

  it('同一頁再點一次 → 不演', () => {
    expect(shouldMorphChat('/', '/')).toBe(false);
    expect(shouldMorphChat('/c/abc', '/c/abc')).toBe(false);
  });

  it('進出其他頁面 → 不演', () => {
    expect(shouldMorphChat('/', '/stats')).toBe(false);
    expect(shouldMorphChat('/ssh', '/')).toBe(false);
    expect(shouldMorphChat('/c/abc', null)).toBe(false);
  });
});
