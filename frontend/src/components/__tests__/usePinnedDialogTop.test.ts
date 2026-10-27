// @vitest-environment jsdom
/**
 * 對話框上緣釘死、只讓下緣伸縮(`usePinnedDialogTop`)。
 * jsdom 不排版:`offsetHeight` 與 `innerHeight` 自己給,ResizeObserver 換成手動觸發的假貨。
 */
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {act, cleanup, render} from '@testing-library/react';
import {createElement} from 'react';

import {usePinnedDialogTop, type PinnedDialogTop} from '../usePinnedDialogTop';

let observed: (() => void) | null = null;
let height = 200;

beforeEach(() => {
  observed = null;
  height = 200;
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      observed = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {
      observed = null;
    }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: 900});
});
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {configurable: true, get: () => height});
});
afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
});

/**
 * 真的把 `ref` 接到一顆 `<dialog>` 上(hook 自己發 ref,呼叫端只負責接上)。
 * 回傳一個讀「最新一次 render 的回傳值」的函式。
 */
function mount(initialOpen: boolean) {
  let latest: PinnedDialogTop | null = null;
  function Probe({open}: {open: boolean}) {
    const pin = usePinnedDialogTop(open);
    latest = pin;
    return createElement('dialog', {ref: pin.ref, style: pin.style});
  }
  const view = render(createElement(Probe, {open: initialOpen}));
  return {
    style: () => latest!.style,
    setOpen: (open: boolean) => view.rerender(createElement(Probe, {open})),
    dialog: () => view.container.querySelector('dialog')!,
  };
}

describe('usePinnedDialogTop', () => {
  it('打開時釘在本來置中的位置;內容變短不動上緣(打字篩清單時搜尋框不跳)', () => {
    const pin = mount(true);
    expect(pin.style()).toEqual({marginBlockStart: '350px', marginBlockEnd: 'auto'});
    // ref 跟 style 是同一顆:畫到那顆 <dialog> 上的就是量出來的值
    expect(pin.dialog().style.marginBlockStart).toBe('350px');
    height = 80;
    act(() => observed?.());
    expect(pin.style()?.marginBlockStart).toBe('350px');
  });

  it('往下長到碰到視窗底才讓上緣往上,而且只讓不夠的那一段;縮回來不再掉回去', () => {
    const pin = mount(true);
    height = 500; // 350 + 500 = 850 ≤ 900 − 16:還放得下,不動
    act(() => observed?.());
    expect(pin.style()?.marginBlockStart).toBe('350px');
    height = 700; // 放不下:上緣移到 900 − 700 − 16
    act(() => observed?.());
    expect(pin.style()?.marginBlockStart).toBe('184px');
    height = 200;
    act(() => observed?.());
    expect(pin.style()?.marginBlockStart).toBe('184px');
  });

  it('還沒開 / 關掉之後不釘(下一次打開重新量);視窗大小變了重新置中', () => {
    const pin = mount(false);
    expect(pin.style()).toBeUndefined();
    pin.setOpen(true);
    expect(pin.style()?.marginBlockStart).toBe('350px');
    Object.defineProperty(window, 'innerHeight', {configurable: true, value: 600});
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(pin.style()?.marginBlockStart).toBe('200px');
    pin.setOpen(false);
    expect(pin.style()).toBeUndefined();
  });
});
