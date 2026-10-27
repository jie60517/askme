// @vitest-environment jsdom
/**
 * 截圖存筆記的框選那一層(`RegionPicker`)。
 * 守的是這幾條:**按 ✓ 才存**(放開滑鼠不存)、✕ / Esc 取消、Enter = ✓、
 * 太小的框(點一下沒拖)不算、在框外再拖一次就重選。
 *
 * jsdom 沒有排版:舞台的 getBoundingClientRect 是 0、圖的 clientWidth 是 0 → 換算用視窗寬(1024)。
 * 假的那一格是 2048 寬 → 倍率 2。
 */
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';

import {RegionPicker} from '../RegionPicker';

beforeAll(() => {
  // jsdom 沒有(按 ✓ 之後的轉圈會查「減少動態」)
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
});
afterEach(cleanup);

const IMAGE = {width: 2048, height: 1400} as HTMLCanvasElement;

function setup() {
  const onConfirm = vi.fn(async () => {});
  const onCancel = vi.fn();
  render(<RegionPicker image={IMAGE} imageUrl="blob:frame" onConfirm={onConfirm} onCancel={onCancel} />);
  const stage = screen.getByRole('dialog');
  const drag = (from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(stage, {clientX: from[0], clientY: from[1], pointerId: 1});
    fireEvent.pointerMove(stage, {clientX: to[0], clientY: to[1], pointerId: 1});
    fireEvent.pointerUp(stage, {clientX: to[0], clientY: to[1], pointerId: 1});
  };
  return {stage, drag, onConfirm, onCancel};
}

describe('RegionPicker', () => {
  it('拖好一個框:放開不存,出現 ✕ ✓;按 ✓ 才存,交出去的是圖上的像素', async () => {
    const {drag, onConfirm} = setup();
    expect(screen.queryByRole('button', {name: 'Save to notes'})).toBeNull();
    drag([100, 50], [300, 130]);
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Save to notes'}));
    });
    expect(onConfirm).toHaveBeenCalledWith({x: 200, y: 100, w: 400, h: 160});
  });

  it('點一下沒拖(框太小)不算:沒有 ✕ ✓', () => {
    const {drag} = setup();
    drag([100, 50], [103, 52]);
    expect(screen.queryByRole('button', {name: 'Save to notes'})).toBeNull();
  });

  it('在框外再拖一次就重選,存的是新的那個框', async () => {
    const {drag, onConfirm} = setup();
    drag([100, 50], [300, 130]);
    drag([10, 10], [60, 40]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Save to notes'}));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({x: 20, y: 20, w: 100, h: 60});
  });

  it('Esc 取消;Enter 等於 ✓(還沒拖時 Enter 不做事)', async () => {
    const {stage, drag, onConfirm, onCancel} = setup();
    fireEvent.keyDown(stage, {key: 'Enter'});
    expect(onConfirm).not.toHaveBeenCalled();
    drag([100, 50], [300, 130]);
    await act(async () => {
      fireEvent.keyDown(stage, {key: 'Enter'});
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    cleanup();

    const second = setup();
    fireEvent.keyDown(second.stage, {key: 'Escape'});
    expect(second.onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('焦點在 ✕ 上按 Enter 不會變成存檔(不會冒泡到這一層被當成 ✓);右鍵不會拖框', () => {
    const {stage, drag, onConfirm} = setup();
    fireEvent.pointerDown(stage, {clientX: 100, clientY: 50, pointerId: 1, button: 2});
    fireEvent.pointerMove(stage, {clientX: 300, clientY: 130, pointerId: 1});
    fireEvent.pointerUp(stage, {clientX: 300, clientY: 130, pointerId: 1});
    expect(screen.queryByRole('button', {name: 'Save to notes'})).toBeNull();
    drag([100, 50], [300, 130]);
    fireEvent.keyDown(screen.getByRole('button', {name: 'Cancel'}), {key: 'Enter'});
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('✕ 取消', () => {
    const {drag, onCancel, onConfirm} = setup();
    drag([100, 50], [300, 130]);
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
