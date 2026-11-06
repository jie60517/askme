// @vitest-environment jsdom
/**
 * 問答頁「New messages」:使用者**自己捲到底**也要收掉,不用手動點掉。
 *
 * jsdom 沒有版面,捲動容器的 scrollHeight / offsetHeight / scrollTop 自己定義;
 * 也沒有 ResizeObserver,換成一個手動觸發的假的(「內容長高了」那一下由測試來喊)。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';

import {ChatScrollButton} from '../ChatScrollButton';

afterEach(cleanup);

let resized: (() => void) | null = null;
beforeEach(() => {
  resized = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  return () => vi.unstubAllGlobals();
});

const HEIGHT = 500;

/** 捲動容器靠 overflow-y 認(跟 `ChatLayout` 的根一樣),按鈕自己往上找 */
function Harness() {
  return (
    <div data-testid="scroller" style={{overflowY: 'auto'}}>
      <div data-testid="area">
        <div className="astryx-chat-message">第一則</div>
      </div>
      <div>
        <ChatScrollButton />
      </div>
    </div>
  );
}

/** 掛上一個 scrollHeight 會跟著設定改的捲動容器,一開始停在最底 */
function setup() {
  render(<Harness />);
  const el = screen.getByTestId('scroller');
  const box = {scrollHeight: 1000, scrollTop: 1000 - HEIGHT};
  Object.defineProperty(el, 'scrollHeight', {get: () => box.scrollHeight});
  Object.defineProperty(el, 'offsetHeight', {get: () => HEIGHT});
  Object.defineProperty(el, 'scrollTop', {
    get: () => box.scrollTop,
    set: (v: number) => (box.scrollTop = v),
  });
  el.scrollTo = vi.fn() as unknown as typeof el.scrollTo;
  // 尺寸是掛上之後才定義的,元件記下的起點是 0 —— 先送一下「版面就位」的捲動把起點對齊
  act(() => void el.dispatchEvent(new Event('scroll')));
  return {
    el,
    /** 使用者捲到某個位置(高度沒變) */
    scrollTo(top: number) {
      act(() => {
        box.scrollTop = top;
        el.dispatchEvent(new Event('scroll'));
      });
    },
    scrollEnd() {
      act(() => void el.dispatchEvent(new Event('scrollend')));
    },
    /** 多一則訊息,內容長高 */
    addMessage() {
      act(() => {
        const msg = document.createElement('div');
        msg.className = 'astryx-chat-message';
        screen.getByTestId('area').appendChild(msg);
        box.scrollHeight += 400;
        resized?.();
      });
    },
    bottom: () => box.scrollHeight - HEIGHT,
  };
}

const newMessagesShown = () => screen.queryByRole('button', {name: 'New messages'}) !== null;

describe('ChatScrollButton', () => {
  it('人在上面時來了新訊息 → 出現 New messages', () => {
    const s = setup();
    s.scrollTo(100);
    s.addMessage();
    expect(newMessagesShown()).toBe(true);
  });

  it('自己用滾輪捲到底 → New messages 自己收掉(不用點)', () => {
    const s = setup();
    s.scrollTo(100);
    s.addMessage();
    expect(newMessagesShown()).toBe(true);
    s.scrollTo(s.bottom());
    expect(newMessagesShown()).toBe(false);
  });

  it('捲到離底 10px 內就算到底', () => {
    const s = setup();
    s.scrollTo(100);
    s.addMessage();
    s.scrollTo(s.bottom() - 8);
    expect(newMessagesShown()).toBe(false);
  });

  it('還沒到底不收', () => {
    const s = setup();
    s.scrollTo(100);
    s.addMessage();
    s.scrollTo(s.bottom() - 50);
    expect(newMessagesShown()).toBe(true);
  });

  it('人在最底(跟著走)時來了新訊息 → 不出現', () => {
    const s = setup();
    s.addMessage();
    expect(newMessagesShown()).toBe(false);
  });

  it('捲回底之後再往上捲,下一則新訊息照樣會提示', () => {
    const s = setup();
    s.scrollTo(100);
    s.addMessage();
    s.scrollTo(s.bottom());
    s.scrollEnd();
    s.scrollTo(200);
    s.addMessage();
    expect(newMessagesShown()).toBe(true);
  });

  it('按下去 → 收掉並往底部捲', () => {
    const s = setup();
    s.scrollTo(100);
    s.addMessage();
    act(() => screen.getByRole('button', {name: 'New messages'}).click());
    expect(newMessagesShown()).toBe(false);
    expect(s.el.scrollTo).toHaveBeenCalledWith({top: s.el.scrollHeight, behavior: 'smooth'});
  });
});
