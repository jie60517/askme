// @vitest-environment jsdom
/**
 * SSH 選連線的主機卡片(`HostStage`)。測**畫面上的行為**,不測排版:
 * 哪幾張點得下去、狀態圖示畫在哪一張、上次連的那張一開始有焦點、點了把哪一台交出去。
 *
 * ⚠️ jsdom 沒有 ResizeObserver / matchMedia / CSS.escape,這裡補最小的假貨;
 * `offsetParent` 在 jsdom 一律是 null(它不排版),所以焦點那條要把它改成「看得到」。
 */
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {HostStage} from '../HostStage';
import type {TerminalHost} from '../../../lib/terminalApi';

const HOSTS: TerminalHost[] = [
  {id: 'main', label: '主機', sub: '', via: ''},
  {id: 'web-a', label: 'Web A', sub: '', via: 'main'},
  {id: 'db-b', label: 'DB B', sub: '', via: 'main'},
  {id: 'app-c', label: 'App C', sub: '', via: 'main'},
];

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  (globalThis as {CSS?: {escape?: (s: string) => string}}).CSS ??= {};
  (globalThis.CSS as {escape?: (s: string) => string}).escape ??= (s: string) => s.replace(/["\\]/g, '\\$&');
  Element.prototype.scrollIntoView ??= function () {};
  // jsdom 不排版:讓「看得到」的判斷成立
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {configurable: true, get: () => document.body});
});
afterEach(cleanup);

const card = (name: string) => screen.getByRole('button', {name: new RegExp(name)});
/** 停用的標記掛在卡片外層(ClickableCard 的根),不在裡面那顆隱形按鈕上 */
const isDisabled = (name: string) => !!card(name).closest('[aria-disabled="true"], [disabled]');

describe('HostStage', () => {
  it('選主機:一區「主機」底下照後端給的順序排卡片;點了就把那一台交出去', async () => {
    const onPick = vi.fn();
    render(<HostStage mode="map" hosts={HOSTS} onPick={onPick} />);
    const headings = screen.getAllByRole('heading', {level: 2});
    expect(headings.map((h) => h.textContent)).toEqual(['主機']);
    expect([...document.querySelectorAll('[data-host-id]')].map((c) => c.getAttribute('data-host-id'))).toEqual([
      'main',
      'web-a',
      'db-b',
      'app-c',
    ]);
    await userEvent.click(card('連線到 DB B'));
    expect(onPick).toHaveBeenCalledWith('db-b');
  });

  it('上次連的那張一開始就有焦點(按 Enter 就連它)', () => {
    render(<HostStage mode="map" hosts={HOSTS} lastHostId="db-b" onPick={() => {}} />);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('連線到 DB B(上次連的)');
  });

  it('連線中:只有目標那張轉圈;任何一張都點不了', async () => {
    const onPick = vi.fn();
    render(<HostStage mode="connecting" hosts={HOSTS} targetId="db-b" onPick={onPick} />);
    await userEvent.click(card('連線到 App C'));
    await userEvent.click(card('連線到 DB B'));
    expect(onPick).not.toHaveBeenCalled();
    expect(isDisabled('連線到 App C')).toBe(true);
  });

  it('螢幕保護:只有還連著的點得下去,而且標著連線中', async () => {
    const onPick = vi.fn();
    render(<HostStage mode="lock" hosts={HOSTS} liveIds={['main', 'db-b']} onPick={onPick} />);
    expect(isDisabled('回到 App C 的連線')).toBe(true);
    expect(isDisabled('回到 DB B 的連線')).toBe(false);
    await userEvent.click(card('回到 App C 的連線'));
    await userEvent.click(card('回到 DB B 的連線'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('db-b');
    expect(screen.getAllByLabelText('連線中')).toHaveLength(2);
  });

  it('連上了:停一下才交棒給終端機', () => {
    vi.useFakeTimers();
    try {
      const onSettled = vi.fn();
      render(<HostStage mode="connected" hosts={HOSTS} targetId="db-b" onPick={() => {}} onSettled={onSettled} />);
      expect(onSettled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(onSettled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
