// @vitest-environment jsdom
/**
 * `AutoHeight` 掛上那一刻的高度:平常是 auto(不演),`startCollapsed` 從 0 長出來
 * (例如 `HostLogin` 的撥接步驟)。
 * jsdom 不排版:ResizeObserver 換成手動觸發的假貨,量到的高度自己給。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render} from '@testing-library/react';

import {AutoHeight} from '../AutoHeight';

const observers: (() => void)[] = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({height: 120} as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 外面那一層(補間的殼):`render` 的容器底下第一個元素 */
const shell = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('AutoHeight', () => {
  it('平常:掛上時不設高度(內容已經在就一幀到位,打開對話框不演);量到之後才寫明確的高度', () => {
    const {container} = render(<AutoHeight><p>內容</p></AutoHeight>);
    expect(shell(container).style.height).toBe('');
    act(() => observers.forEach((cb) => cb()));
    expect(shell(container).style.height).toBe('120px');
  });

  it('startCollapsed:掛上時是 0,量到之後才長到內容的高度(補間有起點)', () => {
    const {container} = render(<AutoHeight startCollapsed><p>內容</p></AutoHeight>);
    expect(shell(container).style.height).toBe('0px');
    act(() => observers.forEach((cb) => cb()));
    expect(shell(container).style.height).toBe('120px');
  });
});
