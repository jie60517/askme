// @vitest-environment jsdom
/**
 * New chat ↔ 對話的過場**誰能放行**(`lib/chatTransition.ts`)。
 *
 * 每次過場一個編號,對話頁掛上時記下自己是哪一次(`currentChatMorph`),只放行那一次。
 * 守的情況:A 頁的過場等到逾時才放行,使用者接著點 B 起第二次過場,這時 A 的資料才回來 ——
 * A 不能把第二次放掉(不然拍到的新畫面還是 A)。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {conversationIdFromPath, currentChatMorph, morphChat, notifyChatCommitted} from '../chatTransition';

beforeEach(() => {
  vi.useFakeTimers();
  // 只模擬「先跑 update、等它的 Promise」這一段;拍照與動畫不是這裡要測的
  Reflect.set(document, 'startViewTransition', (cb: () => Promise<void>) => ({finished: cb()}));
  window.matchMedia = ((query: string) => ({matches: false, media: query})) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'startViewTransition');
  document.documentElement.classList.remove('vt-chat');
});

describe('過場的放行', () => {
  it('在過場裡掛上的頁面讀得到這一次的編號;沒在演是 null', async () => {
    expect(currentChatMorph()).toBeNull();
    let seen: number | null = null;
    const done = morphChat(() => {
      seen = currentChatMorph();
    });
    expect(seen).not.toBeNull();
    notifyChatCommitted(seen!);
    await done;
    expect(currentChatMorph()).toBeNull();
  });

  it('別一次的編號放不掉這一次', async () => {
    let first: number | null = null;
    let released = false;
    void morphChat(() => {
      first = currentChatMorph();
    }).then(() => {
      released = true;
    });
    notifyChatCommitted(first! - 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(false);
    notifyChatCommitted(first!);
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
  });

  it('沒人放行的話最多等 400ms 就自己放', async () => {
    let released = false;
    void morphChat(() => {}).then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
  });
});

describe('conversationIdFromPath', () => {
  it('只認 /c/<id>', () => {
    expect(conversationIdFromPath('/c/abc')).toBe('abc');
    expect(conversationIdFromPath('/c/')).toBeNull();
    expect(conversationIdFromPath('/')).toBeNull();
    expect(conversationIdFromPath('/ssh')).toBeNull();
    expect(conversationIdFromPath(undefined)).toBeNull();
  });
});
