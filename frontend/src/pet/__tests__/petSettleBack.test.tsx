// @vitest-environment jsdom
/**
 * 垂頭 / 左右搖的狀態結束時平順回正(`PetCompanion` 的 `useSettleBack`)。
 *
 * CSS transition 不會從動畫中的值起跳,所以做法是:class 拿掉**之前**讀當下的 transform,
 * 拿掉之後用 Web Animations 從那裡補到 none。這裡測的就是「讀的時機對、補的方向對」:
 *  1. pet-sad → 閒晃:用拿掉之前讀到的角度起跳,補到 none,時間是 token(讀不到用 fallback);
 *  2. 不是垂頭 / 搖擺的狀態換掉時不補;
 *  3. 減少動態:不補(動畫本來就是 none)。
 */
import {act} from 'react';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render} from '@testing-library/react';

import PetCompanion from '../PetCompanion';
import {PET_SPEAK_EVENT, type PetSpeech} from '../petSpeech';
import {PET_EXIT_FALLBACK_MS} from '../motionTokens';

const TILTED = 'matrix(0.99, -0.14, 0.14, 0.99, 0, 3)';
let reduce = false;

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => true;
});
beforeEach(() => {
  reduce = false;
  localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // 狀態動畫在 jsdom 裡不會跑:按鈕掛著 pet-sad / pet-wait 時,假裝畫面上歪了一個角度
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const cs = real(el, pseudo);
    const tilted = el instanceof HTMLButtonElement && /\bpet-(sad|wait)\b/.test(el.className);
    return new Proxy(cs, {
      get(target, key) {
        if (key === 'transform') return tilted ? TILTED : 'none';
        const v = Reflect.get(target, key) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const say = (speech: PetSpeech) =>
  act(() => {
    window.dispatchEvent(new CustomEvent(PET_SPEAK_EVENT, {detail: speech}));
  });

function mount() {
  const utils = render(<PetCompanion />);
  const button = utils.getByRole('button') as HTMLButtonElement;
  // jsdom 沒有 Web Animations;只掛在這顆按鈕上(掛在原型上的話 framer 會以為可以用 WAAPI)
  const animate = vi.fn();
  (button as unknown as {animate: typeof animate}).animate = animate;
  return {button, animate};
}

describe('狀態動畫拿掉時回正', () => {
  it('pet-sad → 閒晃:從拿掉之前的角度補到 none', () => {
    const {button, animate} = mount();
    say({text: '唉', state: 'sad'});
    expect(button.className).toMatch(/\bpet-sad\b/);
    expect(animate).not.toHaveBeenCalled();

    say({text: '好了', state: 'walking'});
    expect(button.className).not.toMatch(/\bpet-sad\b/);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0]!;
    expect(frames).toEqual([{transform: TILTED}, {transform: 'none'}]);
    // jsdom 沒有設計 token:走 fallback(theme-neutral 的 --duration-fast-max)
    expect(options.duration).toBe(PET_EXIT_FALLBACK_MS);
    expect(options.easing).toMatch(/^cubic-bezier\(/);
  });

  it('pet-wait 換掉也會補', () => {
    const {animate} = mount();
    say({text: '等等', state: 'queued'});
    say({text: '好', state: 'walking'});
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('不是垂頭 / 搖擺的狀態換掉時不補', () => {
    const {animate} = mount();
    say({text: '嗨', state: 'sleeping'});
    say({text: '好', state: 'walking'});
    expect(animate).not.toHaveBeenCalled();
  });

  it('減少動態:不補', () => {
    reduce = true;
    const {button, animate} = mount();
    say({text: '唉', state: 'sad'});
    expect(button.className).toMatch(/\bpet-sad\b/);
    say({text: '好了', state: 'walking'});
    expect(animate).not.toHaveBeenCalled();
  });
});
