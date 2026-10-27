// @vitest-environment jsdom
/**
 * 換功能頁的過場(`lib/pageSwap.ts`)。
 *
 * 守的是三件會靜悄悄壞掉的事:
 *  1. 點下去那一刻就通知側邊欄(選取底色要馬上滑,不能等新頁掛上);
 *  2. 新頁一直沒掛上時,舊頁不能停在全透明 —— 一段時間後自己淡回來;
 *  3. 只換查詢字串不演(同一頁換篩選條件不該整頁淡一次)。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  PAGE_SWAP_CANCEL_EVENT,
  PAGE_SWAP_EVENT,
  bindPageSwapHost,
  finishPageSwap,
  isPageSwapping,
  shouldSwapPage,
  startPageSwap,
} from '../pageSwap';

type Recorded = {frames: Keyframe[]; options: KeyframeAnimationOptions};

let host: HTMLElement;
let calls: Recorded[];

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = ((query: string) => ({matches: false, media: query})) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  calls = [];
  // jsdom 沒有 Web Animations:記下呼叫就好,不是這裡要測的
  host.animate = ((frames: Keyframe[], options: KeyframeAnimationOptions) => {
    calls.push({frames, options});
    return {cancel: () => {}} as unknown as Animation;
  }) as HTMLElement['animate'];
  bindPageSwapHost(host);
});

afterEach(() => {
  finishPageSwap();
  bindPageSwapHost(null);
  vi.useRealTimers();
});

describe('換功能頁', () => {
  it('點下去那一刻就通知側邊欄要去哪裡,舊頁開始淡出', () => {
    const seen: string[] = [];
    const onSwap = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(PAGE_SWAP_EVENT, onSwap);
    startPageSwap('/notes');
    window.removeEventListener(PAGE_SWAP_EVENT, onSwap);
    expect(seen).toEqual(['/notes']);
    expect(isPageSwapping()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].frames.at(-1)?.opacity).toBe(0);
  });

  it('新頁掛上就淡入,而且只淡一次', () => {
    startPageSwap('/ssh');
    finishPageSwap();
    finishPageSwap();
    expect(isPageSwapping()).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1].frames.at(-1)?.opacity).toBe(1);
  });

  it('新頁一直沒掛上,兩秒後自己淡回來、通知側邊欄回到原本那一列', () => {
    let cancelled = 0;
    const onCancel = () => cancelled++;
    window.addEventListener(PAGE_SWAP_CANCEL_EVENT, onCancel);
    startPageSwap('/stats');
    vi.advanceTimersByTime(2000);
    window.removeEventListener(PAGE_SWAP_CANCEL_EVENT, onCancel);
    expect(isPageSwapping()).toBe(false);
    expect(calls.at(-1)?.frames.at(-1)?.opacity).toBe(1);
    expect(cancelled).toBe(1);
  });

  it('換到一半又點一下:淡出接著跑、不從頭來(不然舊頁會閃回全亮),但側邊欄照樣收到新的去處', () => {
    const seen: string[] = [];
    const onSwap = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(PAGE_SWAP_EVENT, onSwap);
    startPageSwap('/ssh');
    startPageSwap('/notes');
    window.removeEventListener(PAGE_SWAP_EVENT, onSwap);
    expect(seen).toEqual(['/ssh', '/notes']);
    expect(calls).toHaveLength(1);
  });

  it('淡入不帶位移(往下偏會撐出外層的捲軸)', () => {
    startPageSwap('/ssh');
    finishPageSwap();
    expect(calls[1].frames.every((f) => !('translate' in f) && !('transform' in f))).toBe(true);
  });

  it('沒在換頁時呼叫 finish 什麼都不做(網址列直接打、上一頁)', () => {
    finishPageSwap();
    expect(calls).toHaveLength(0);
  });

  it('只換查詢字串不演', () => {
    expect(shouldSwapPage('/stats', '/stats?range=7d')).toBe(false);
    expect(shouldSwapPage('/stats', '/users')).toBe(true);
    expect(shouldSwapPage('/', '/ssh')).toBe(true);
    expect(shouldSwapPage('/ssh', null)).toBe(false);
  });
});
