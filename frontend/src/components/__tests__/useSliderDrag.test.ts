// @vitest-environment jsdom
/**
 * 拉桿的「正在拖」旗標(`components/useSliderDrag.ts`)。
 *
 * 守的是「點軌道的跳躍要有過場」:按在軌道上那一下**不能**掛 `data-dragging`
 * (那會把那一跳的過場一起關掉);按在拇指上、或壓著軌道移動超過一點點之後才算拖。
 */
import type {PointerEvent} from 'react';
import {afterEach, describe, expect, it} from 'vitest';
import {act, cleanup, renderHook} from '@testing-library/react';

import {useSliderDrag} from '../useSliderDrag';

afterEach(cleanup);

function slider() {
  const track = document.createElement('div');
  track.className = 'astryx-slider-track';
  const thumb = document.createElement('div');
  thumb.className = 'astryx-slider-thumb';
  const inner = document.createElement('span');
  thumb.appendChild(inner);
  track.appendChild(thumb);
  return {track, thumb, inner};
}

const ev = (target: Element, x = 0, y = 0) =>
  ({target, clientX: x, clientY: y}) as unknown as PointerEvent<HTMLElement>;

describe('useSliderDrag', () => {
  it('按在拇指(含它裡面的元素)上當場算拖', () => {
    const {inner} = slider();
    const {result} = renderHook(() => useSliderDrag());
    act(() => result.current.handlers.onPointerDown(ev(inner)));
    expect(result.current.isDragging).toBe(true);
    act(() => result.current.handlers.onPointerUp());
    expect(result.current.isDragging).toBe(false);
  });

  it('點軌道那一下不算拖(讓那一跳走過場)', () => {
    const {track} = slider();
    const {result} = renderHook(() => useSliderDrag());
    act(() => result.current.handlers.onPointerDown(ev(track, 10, 10)));
    expect(result.current.isDragging).toBe(false);
    // 手指點擊時抖出來的小移動不算
    act(() => result.current.handlers.onPointerMove(ev(track, 11, 11)));
    expect(result.current.isDragging).toBe(false);
    act(() => result.current.handlers.onPointerUp());
    expect(result.current.isDragging).toBe(false);
  });

  it('壓著軌道移動超過門檻之後才算拖,放手就收', () => {
    const {track} = slider();
    const {result} = renderHook(() => useSliderDrag());
    act(() => result.current.handlers.onPointerDown(ev(track, 10, 10)));
    act(() => result.current.handlers.onPointerMove(ev(track, 30, 10)));
    expect(result.current.isDragging).toBe(true);
    act(() => result.current.handlers.onPointerCancel());
    expect(result.current.isDragging).toBe(false);
  });

  it('沒按著的 pointermove(滑鼠只是滑過去)不會打開旗標', () => {
    const {track} = slider();
    const {result} = renderHook(() => useSliderDrag());
    act(() => result.current.handlers.onPointerMove(ev(track, 0, 0)));
    act(() => result.current.handlers.onPointerMove(ev(track, 50, 0)));
    expect(result.current.isDragging).toBe(false);
  });
});
