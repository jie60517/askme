// @vitest-environment jsdom
/**
 * Bloub 每一格直接寫 DOM,不經過 React。
 *
 *  1. `paintBloubSvg` 寫出來的 SVG 跟 React 直接畫那一格**一模一樣** —— 兩條路共用屬性算法,
 *     這條抓的是「其中一條漏寫了某個屬性」(例如加了新元素只改了 JSX)。
 *  2. 動畫在跑時 React **不會**每格重新 commit,但畫面上的身體輪廓有在動。
 *  3. 減少動態:不排 rAF,只畫一格。
 */
import {Profiler} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render} from '@testing-library/react';

import {BloubAvatar, BloubSvg, collectBloubParts, frameShape, paintBloubSvg} from '../BloubAvatar';
import {BotEngine, type BotFrame} from '../bloub/engine';
import {EXPRESSION_BY_ID} from '../bloub/expressions';
import {RAYON} from '../bloub/repere';
import type {StateId} from '../bloub/states';

let frames: FrameRequestCallback[] = [];
let reduce = false;

beforeEach(() => {
  frames = [];
  reduce = false;
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return ++id;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  // jsdom 沒有 canvas(`useInkPaper` 解析顏色用);回 null 時它退回預設色,不要讓 jsdom 每次印一段錯誤
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 跑 n 格 rAF,每格 16ms */
let clockMs = 0;
function runFrames(n: number) {
  for (let i = 0; i < n; i++) {
    clockMs += 16;
    const due = frames;
    frames = [];
    act(() => due.forEach((cb) => cb(clockMs)));
  }
}

const NEUTRE = EXPRESSION_BY_ID.get('neutre') ?? null;

/** 同一個狀態裡,找兩格結構相同、數值不同的 */
function twoFrames(state: StateId): [BotFrame, BotFrame] | null {
  const engine = new BotEngine(RAYON, state, null, NEUTRE);
  const times = [0.15, 0.4, 0.75, 1.1, 1.6, 2.2, 3.1];
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      const a = engine.sample(times[i]!);
      const b = engine.sample(times[j]!);
      if (frameShape(a) === frameShape(b) && a.bodyPath !== b.bodyPath) return [a, b];
    }
  }
  return null;
}

describe('paintBloubSvg', () => {
  const states: StateId[] = ['idle', 'thinking', 'alert', 'notify', 'exclaim', 'orbit', 'swirl', 'burst', 'play', 'comet'];
  for (const state of states) {
    for (const mono of [false, true]) {
      it(`${state}${mono ? '(mono)' : ''}:直接寫出來的跟 React 畫的一樣`, () => {
        const pair = twoFrames(state);
        expect(pair).not.toBeNull();
        const [a, b] = pair!;
        const props = {ink: '#123456', paper: '#fafafa', size: 112, mono, uid: 'u'};
        const painted = render(<BloubSvg frame={a} {...props} />).container;
        const svg = painted.querySelector('svg') as SVGSVGElement;
        paintBloubSvg(collectBloubParts(svg), b, '#654321', props.paper, mono, props.uid);
        const fresh = render(<BloubSvg frame={b} {...props} ink="#654321" />).container;
        expect(painted.innerHTML).toBe(fresh.innerHTML);
      });
    }
  }
});

describe('BloubAvatar', () => {
  it('動畫在跑時不會每格 re-render,但身體有在動', () => {
    let commits = 0;
    const {container} = render(
      <Profiler id="bloub" onRender={() => commits++}>
        <BloubAvatar step={{state: 'idle'}} size={112} />
      </Profiler>,
    );
    runFrames(5);
    const before = commits;
    const body = () => container.querySelector('[data-bloub="pad"]')?.getAttribute('d');
    const d0 = body();
    runFrames(60);
    expect(body()).not.toBe(d0);
    // 一秒 60 格,但只有結構變了才 commit(閒著時是 0),不是 60 次
    expect(commits - before).toBeLessThan(3);
  });

  it('減少動態:不排 rAF,畫一格就停', () => {
    reduce = true;
    const {container} = render(<BloubAvatar step={{state: 'idle'}} size={112} />);
    expect(frames).toHaveLength(0);
    expect(container.querySelector('[data-bloub="pad"]')?.getAttribute('d')).toBeTruthy();
  });
});
