// @vitest-environment jsdom
/**
 * 畫布的動態:
 *  - 補間中再按下:從畫面上看得到的值(computed transform)接手,不是跳到補間的終點
 *  - 接點位置 = 拼圖位置 + 快取的偏移(拖拼圖不重量 DOM)
 *  - 觸控放手的慣性:Apple 的 project()、放手速度;每一幀是位移量(滑的途中視角被別人改了不會被拉回去);
 *    停住滑動的那一下不算點一下
 *  - 格線那一層的偏移(x mod g,落在 [-g, 0))
 *  - 拼圖盒小卡的抓點
 */
import {createRef} from 'react';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {act, cleanup, createEvent, fireEvent, render, screen} from '@testing-library/react';

import {FlowCanvas, glideStep, gridShift, portsAt, presentedView, project, type FlowCanvasHandle} from '../FlowCanvas';
import {releaseVelocityPxPerMs} from '../../../lib/velocity';

/** 畫布的慣性吃 px/s(`project` 的單位);共用的那一支回 px/ms,在這裡換 */
const releaseVelocity = (samples: {x: number; y: number; t: number}[], now: number) => {
  const v = releaseVelocityPxPerMs(samples, now);
  return {x: v.x * 1000, y: v.y * 1000};
};
import {FRAME_MS} from '../../../lib/frameEase';
import {cardRest, ghostGrab} from '../paletteGhost';
import type {FlowGraph} from '../../../lib/workflowApi';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom 沒有 pointer capture
  Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('presentedView', () => {
  it('解 computed 的 matrix():x = e、y = f、k = a', () => {
    expect(presentedView('matrix(0.5, 0, 0, 0.5, 12.5, -30)')).toEqual({x: 12.5, y: -30, k: 0.5});
  });
  it('none / 解不了 → null', () => {
    expect(presentedView('none')).toBeNull();
    expect(presentedView('')).toBeNull();
    expect(presentedView('translate(1px, 2px)')).toBeNull();
  });
});

describe('慣性', () => {
  it('project 是 Apple 的公式:(v / 1000) × d / (1 − d)', () => {
    expect(project(1000, 0.998)).toBeCloseTo(499, 6);
    expect(project(-500)).toBeCloseTo(-249.5, 6);
    expect(project(0)).toBe(0);
  });
  it('放手速度:最近 100ms 內第一筆到最後一筆的平均(px/s)', () => {
    const samples = [
      {x: 0, y: 0, t: 0}, // 太舊,不算
      {x: 100, y: 0, t: 200},
      {x: 110, y: 5, t: 250},
      {x: 130, y: 15, t: 300},
    ];
    const v = releaseVelocity(samples, 300);
    expect(v.x).toBeCloseTo(300, 6);
    expect(v.y).toBeCloseTo(150, 6);
  });
  it('停住一下才放(最近只剩一筆)= 沒有速度', () => {
    expect(releaseVelocity([{x: 0, y: 0, t: 0}, {x: 50, y: 0, t: 20}, {x: 50, y: 0, t: 300}], 300)).toEqual({x: 0, y: 0});
  });
});

describe('glideStep', () => {
  it('一幀走掉剩餘的 1 − 0.998^dt,回的是位移量', () => {
    const g = glideStep({x: 100, y: -50}, FRAME_MS, {x: 0, y: 0});
    const s = 1 - Math.pow(0.998, FRAME_MS);
    expect(g.step.x).toBeCloseTo(100 * s, 6);
    expect(g.step.y).toBeCloseTo(-50 * s, 6);
    expect(g.remaining.x).toBeCloseTo(100 - 100 * s, 6);
  });
  it('120Hz 兩幀 = 60Hz 一幀', () => {
    const a = glideStep({x: 100, y: 0}, FRAME_MS / 2, {x: 0, y: 0});
    const b = glideStep(a.remaining, FRAME_MS / 2, {x: 0, y: 0});
    expect(a.step.x + b.step.x).toBeCloseTo(glideStep({x: 100, y: 0}, FRAME_MS, {x: 0, y: 0}).step.x, 6);
  });
  it('滑出界線越遠阻力越大,出去 PAN_RUBBER_DIM(80)就停', () => {
    const free = glideStep({x: 100, y: 0}, FRAME_MS, {x: 0, y: 0}).step.x;
    const half = glideStep({x: 100, y: 0}, FRAME_MS, {x: 40, y: 0});
    expect(half.step.x).toBeCloseTo(free / 2, 6);
    expect(glideStep({x: 100, y: 0}, FRAME_MS, {x: 80, y: 0})).toEqual({step: {x: 0, y: 0}, remaining: {x: 0, y: 0}});
  });
});

describe('portsAt', () => {
  it('接點位置 = 拼圖位置 + 偏移;拼圖移動不必重量', () => {
    const offsets = {'in:n1': {node: 'n1', x: -1, y: 19}, 'out:n1:0': {node: 'n1', x: 253, y: 90}, 'in:gone': {node: 'gone', x: 0, y: 0}};
    const at = (x: number, y: number) => portsAt([{id: 'n1', type: 'sync', x, y}], offsets);
    expect(at(100, 50)).toEqual({'in:n1': {x: 99, y: 69}, 'out:n1:0': {x: 353, y: 140}});
    // 拖過去:同一份偏移,跟著走
    expect(at(140, 10)).toEqual({'in:n1': {x: 139, y: 29}, 'out:n1:0': {x: 393, y: 100}});
  });
});

describe('gridShift', () => {
  it('落在 [-g, 0),跟 x 同餘(負的也對)', () => {
    for (const x of [0, 7, 20, 33.5, -1, -20, -47]) {
      const s = gridShift(x, 20);
      expect(s).toBeGreaterThanOrEqual(-20);
      expect(s).toBeLessThan(0);
      expect((((x - s) % 20) + 20) % 20).toBeCloseTo(0, 6);
    }
  });
});

describe('拼圖盒小卡的抓點', () => {
  const button = {left: 10, top: 100, height: 36};
  const card = {w: 120, h: 28};
  it('小卡坐在按鈕上:左緣往內 inset、垂直置中', () => {
    expect(cardRest(button, card, 4)).toEqual({left: 14, top: 104});
  });
  it('按在哪就抓哪:按在小卡範圍內,拿起來不跳', () => {
    expect(ghostGrab({x: 74, y: 118}, button, card, 4)).toEqual({x: 60, y: 14});
  });
  it('按在小卡右邊的空白處:夾在小卡寬度內(右緣停在指標下)', () => {
    expect(ghostGrab({x: 200, y: 118}, button, card, 4)).toEqual({x: 120, y: 14});
    expect(ghostGrab({x: 0, y: 90}, button, card, 4)).toEqual({x: 0, y: 0});
  });
});

describe('FlowCanvas 補間中再按下', () => {
  const GRAPH: FlowGraph = {nodes: [{id: 'start', type: 'start', x: 0, y: 0}], edges: []};
  const noop = () => {};

  function mount() {
    const ref = createRef<FlowCanvasHandle>();
    const {container} = render(
      <FlowCanvas
        ref={ref}
        graph={GRAPH}
        catalog={null}
        selected={null}
        onSelect={noop}
        onGraphChange={noop}
        onDuplicate={noop}
        run={null}
        isLocked={false}
        initialView={{x: 0, y: 0, k: 1}}
      />,
    );
    const world = () => container.querySelector<HTMLElement>('[style*="translate("]')!;
    const host = screen.getByRole('application');
    return {ref, world, host};
  }

  it('拖曳從畫面上看得到的值開始,不是補間的終點', () => {
    const {world, host} = mount();
    // 按「放大」:補間開始,world 的終點是 120%
    fireEvent.click(screen.getByRole('button', {name: '放大'}));
    expect(world().style.transform).toContain('scale(1.2)');
    // 補間跑到一半:畫面上是 110%、位移 (5, 6)
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === world() ? ({transform: 'matrix(1.1, 0, 0, 1.1, 5, 6)'} as CSSStyleDeclaration) : real(el, pseudo),
    );
    act(() => {
      fireEvent.pointerDown(host, {button: 0, clientX: 50, clientY: 50, pointerId: 1});
    });
    expect(world().style.transform).toBe('translate(5px, 6px) scale(1.1)');
    act(() => {
      fireEvent.pointerMove(host, {button: 0, clientX: 80, clientY: 50, pointerId: 1});
    });
    expect(world().style.transform).toBe('translate(35px, 6px) scale(1.1)');
    act(() => {
      fireEvent.pointerUp(host, {button: 0, clientX: 80, clientY: 50, pointerId: 1});
    });
  });

  it('沒有補間時按下:照舊從目前的視角開始', () => {
    const {world, host} = mount();
    const spy = vi.spyOn(window, 'getComputedStyle');
    act(() => {
      fireEvent.pointerDown(host, {button: 0, clientX: 50, clientY: 50, pointerId: 1});
    });
    expect(world().style.transform).toBe('translate(0px, 0px) scale(1)');
    // 沒有補間就不用讀 computed style(不強制同步排版)
    expect(spy.mock.calls.some(([el]) => el === world())).toBe(false);
  });
});

describe('FlowCanvas 觸控放手的慣性', () => {
  const GRAPH: FlowGraph = {nodes: [{id: 'start', type: 'start', x: 0, y: 0}], edges: []};

  /** 自己轉 rAF:一次跑一幀,時間戳自己給 */
  function fakeFrames() {
    let next = 1;
    const queue = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      queue.set(next, cb);
      return next++;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => void queue.delete(id));
    return {
      pending: () => queue.size,
      run: (ts: number) =>
        act(() => {
          const cbs = [...queue.values()];
          queue.clear();
          cbs.forEach((cb) => cb(ts));
        }),
    };
  }

  /** 收著每一個 ResizeObserver,測試裡自己觸發(畫布大小改變) */
  function fakeResizeObservers() {
    const all: Array<{cb: ResizeObserverCallback; els: Element[]}> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        rec: {cb: ResizeObserverCallback; els: Element[]};
        constructor(cb: ResizeObserverCallback) {
          this.rec = {cb, els: []};
          all.push(this.rec);
        }
        observe(el: Element) {
          this.rec.els.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    return (el: Element) => act(() => all.filter((r) => r.els.includes(el)).forEach((r) => r.cb([], {} as ResizeObserver)));
  }

  function mount(onSelect = vi.fn()) {
    const noop = () => {};
    const {container} = render(
      <FlowCanvas
        graph={GRAPH}
        catalog={null}
        selected={null}
        onSelect={onSelect}
        onGraphChange={noop}
        onDuplicate={noop}
        run={null}
        isLocked={false}
        initialView={{x: 0, y: 0, k: 1}}
      />,
    );
    const host = screen.getByRole('application');
    const x = () => Number(/translate\(([-\d.]+)px/.exec(container.querySelector<HTMLElement>('[style*="translate("]')!.style.transform)![1]);
    const touch = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', cx: number, t: number) => {
      const ev = createEvent[type](host, {button: 0, clientX: cx, clientY: 100, pointerId: 7});
      Object.defineProperty(ev, 'pointerType', {value: 'touch'});
      Object.defineProperty(ev, 'timeStamp', {value: t});
      act(() => {
        fireEvent(host, ev);
      });
    };
    /** 手指往右甩:每 16ms 5px,一共 20px(過了觸控的 10px 門檻) */
    const flick = () => {
      touch('pointerDown', 100, 1000);
      for (let i = 1; i <= 4; i++) touch('pointerMove', 100 + i * 5, 1000 + i * 16);
      touch('pointerUp', 120, 1064);
    };
    return {host, x, touch, flick, onSelect};
  }

  it('滑的途中視角被別人改了(畫布變寬、保持中心點):下一幀從新的位置接著滑,不會被拉回放手時算好的落點', () => {
    const resize = fakeResizeObservers();
    const frames = fakeFrames();
    const {host, x, flick} = mount();
    flick();
    expect(x()).toBe(20);
    expect(frames.pending()).toBe(1);
    frames.run(5000);
    const afterFirst = x();
    expect(afterFirst).toBeGreaterThan(20);
    // 畫布變寬 400px:保持中心點,視角往右 200
    Object.defineProperty(host, 'clientWidth', {configurable: true, get: () => 400});
    resize(host);
    expect(x()).toBeCloseTo(afterFirst + 200, 6);
    frames.run(5000 + FRAME_MS);
    // 照舊往右滑(朝絕對落點逼近的話,這一幀會往回拉 ~4.6px)
    expect(x()).toBeGreaterThan(afterFirst + 200);
  });

  it('碰一下停住滑動:那一下不算點一下(不取消選取),下一次點才算', () => {
    const frames = fakeFrames();
    const {x, touch, flick, onSelect} = mount();
    flick();
    frames.run(5000);
    touch('pointerDown', 50, 6000);
    touch('pointerUp', 50, 6050);
    expect(onSelect).not.toHaveBeenCalled();
    // 真的停了:之後的幀不再動(放開時的 settle 在 jsdom 會把視角夾一下,量不到大小;從那之後算)
    const stopped = x();
    frames.run(5000 + FRAME_MS);
    frames.run(5000 + FRAME_MS * 2);
    expect(x()).toBe(stopped);
    // 沒在滑的時候點一下:照舊取消選取
    touch('pointerDown', 50, 7000);
    touch('pointerUp', 50, 7050);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
