import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FRAME_MS, holdStalls} from '../holdStalls';

/*
 * 假的 rAF:`frame(at)` 跑一格、把時間設成 at。動畫只用到 playState / currentTime。
 * 理由與數字見 holdStalls.ts 開頭(模式 Token 過場被長任務吃掉前段)。
 */
let now = 0;
let queue: FrameRequestCallback[] = [];
const frame = (at: number) => {
  now = at;
  const run = queue;
  queue = [];
  for (const cb of run) cb(at);
};
const anim = (currentTime: number, playState: AnimationPlayState = 'running') => ({currentTime, playState});

beforeEach(() => {
  now = 0;
  queue = [];
  vi.stubGlobal('performance', {now: () => now});
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('holdStalls:卡住的時間不算進動畫', () => {
  it('commit 後卡 48ms 才畫第一格:扣回去,只留一格的進度', () => {
    const a = anim(64); // 動畫自己已經走了 64ms(牆上時間)
    holdStalls([a]);
    frame(64);
    expect(a.currentTime).toBeCloseTo(FRAME_MS);
  });

  it('正常 60Hz、30Hz 的間隔不扣(不然整段動畫會慢一倍)', () => {
    const a = anim(0);
    holdStalls([a]);
    frame(16);
    a.currentTime = 16;
    frame(49); // 33ms 一格(30Hz)
    expect(a.currentTime).toBe(16);
  });

  it('同一輪的每一支扣一樣多,扣完不會小於 0', () => {
    const w = anim(70);
    const enter = anim(30);
    holdStalls([w, enter]);
    frame(70);
    expect(70 - Number(w.currentTime)).toBeCloseTo(70 - FRAME_MS);
    expect(enter.currentTime).toBe(0);
  });

  it('全部跑完就不再排下一格;取消函式收掉還沒跑的那一格', () => {
    const a = anim(10, 'finished');
    holdStalls([a]);
    frame(16);
    expect(queue).toHaveLength(0);

    const b = anim(0);
    const cancel = holdStalls([b]);
    cancel();
    frame(500);
    expect(b.currentTime).toBe(0);
  });

  it('中途被 cancel(idle)的那支不碰', () => {
    const a = anim(80, 'idle');
    holdStalls([a]);
    frame(80);
    expect(a.currentTime).toBe(80);
  });
});
