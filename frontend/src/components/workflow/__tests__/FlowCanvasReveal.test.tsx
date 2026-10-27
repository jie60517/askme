// @vitest-environment jsdom
/**
 * `FlowCanvas.reveal` 的補間開關:上一步 / 下一步用 `{instant: true}`,
 * 畫布直接跳過去、不掛補間;狀態字那顆按鈕(不帶 opts)才補間。
 * 補間是 world 那一層多一個 class(`worldAnim`),所以比 reveal 前後那一層的 className。
 */
import {createRef} from 'react';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {act, cleanup, render} from '@testing-library/react';

import {FlowCanvas, type FlowCanvasHandle} from '../FlowCanvas';
import type {FlowGraph} from '../../../lib/workflowApi';

const GRAPH: FlowGraph = {nodes: [{id: 'start', type: 'start', x: 0, y: 0}], edges: []};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const noop = () => {};
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

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
  // 平移 / 縮放套在 world 那一層的 inline transform 上
  const world = () => container.querySelector<HTMLElement>('[style*="translate("]')!;
  return {ref, world};
}

describe('FlowCanvas.reveal', () => {
  it('instant:不掛補間', async () => {
    const {ref, world} = mount();
    await nextFrame();
    const before = world().className;
    act(() => ref.current!.reveal('start', {instant: true}));
    await nextFrame();
    expect(world().className).toBe(before);
  });

  it('不帶 opts(狀態字按鈕):照舊補間', async () => {
    const {ref, world} = mount();
    await nextFrame();
    const before = world().className;
    act(() => ref.current!.reveal('start'));
    await nextFrame();
    expect(world().className).not.toBe(before);
  });

  it('補間中再來一下 instant:前一下的補間一起收掉(連按上一步不會被拖著)', async () => {
    const {ref, world} = mount();
    await nextFrame();
    const before = world().className;
    act(() => ref.current!.reveal('start'));
    await nextFrame();
    expect(world().className).not.toBe(before);
    act(() => ref.current!.reveal('start', {instant: true}));
    await nextFrame();
    expect(world().className).toBe(before);
  });
});
