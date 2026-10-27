// @vitest-environment jsdom
/**
 * 品牌長按彩蛋的進度。
 *
 * - 進度**等速**:按了一半時間就填一半。用 easeOutCubic 的話半時就填到 87.5%,
 *   剩下一半時間只爬最後一截 —— 進度條在騙人。
 * - 中途放開(`release`)已填的那段在指定時間內退回 0,不是整塊瞬間消失;
 *   放開之後 `burst` 不作用。
 *
 * 量的是畫到膠囊上的第一個 `fillRect` 的寬度(彩虹底那一層)。Canvas 2D 換成假的。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createBrandHoldScene} from '../brand-hold-scene';

const CAP = {left: 10, top: 5, width: 200, height: 20};

let now = 0;
let frames: FrameRequestCallback[] = [];
let fills: number[][] = [];

function tickAt(t: number) {
  now = t;
  const batch = frames;
  frames = [];
  for (const cb of batch) cb(t);
}

/** 這一格畫在膠囊上的已填寬度(第一個 fillRect = 彩虹底;沒畫就是 0) */
function filledAt(t: number): number {
  fills = [];
  tickAt(t);
  const first = fills.find(([x, y]) => x === CAP.left && y === CAP.top);
  return first ? first[2] : 0;
}

beforeEach(() => {
  now = 0;
  frames = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const gradient = {addColorStop() {}};
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
        if (prop === 'fillRect') return (...a: number[]) => fills.push(a);
        return () => {};
      },
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function makeHost() {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', {value: 400});
  Object.defineProperty(host, 'clientHeight', {value: 300});
  document.body.appendChild(host);
  return host;
}

describe('brand-hold-scene 的進度', () => {
  it('等速:半時填一半、四分之一時填四分之一', () => {
    const scene = createBrandHoldScene(makeHost(), {holdMs: 1000, capsule: CAP})!;
    expect(scene).not.toBeNull();
    expect(filledAt(250)).toBeCloseTo(CAP.width * 0.25, 5);
    expect(filledAt(500)).toBeCloseTo(CAP.width * 0.5, 5);
    scene.dispose();
  });

  it('放開:從放開那一刻的位置退回,ms 之後歸零;之後 burst 不作用', () => {
    const scene = createBrandHoldScene(makeHost(), {holdMs: 1000, capsule: CAP})!;
    expect(filledAt(500)).toBeCloseTo(100, 5);
    scene.release(200);
    // 退回中:比放開時少,但還沒歸零(看得出是「退」)
    const mid = filledAt(600);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    // ease-out:前半段退得比後半段多
    expect(100 - mid).toBeGreaterThan(50);
    expect(filledAt(700)).toBeCloseTo(0, 5);
    // 放開之後不能再爆開(元件的計時器理論上已清掉,這是第二道保險)
    scene.burst();
    expect(filledAt(800)).toBeCloseTo(0, 5);
    scene.dispose();
  });
});
