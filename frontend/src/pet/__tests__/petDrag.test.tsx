// @vitest-environment jsdom
/**
 * 拖小夥伴(`PetCompanion` 的 `usePetDrag`)。
 *
 *  1. 拖曳中只寫外層的 transform,**不重繪**;放手才把位置交給 React(left / top)並存起來。
 *  2. 多指保護:第二根手指的按下 / 移動 / 抬起都不影響第一根的拖曳(規則見 `lib/pointerOwner.ts`)。
 */
import {Profiler} from 'react';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render} from '@testing-library/react';

import PetCompanion from '../PetCompanion';
import {petPositionKey} from '../pet-sprites';

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => true;
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
beforeEach(() => {
  localStorage.clear();
  // 散步(usePetWander)每格也會寫外層的 transform;這裡只看拖曳寫的
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const finger = (pointerId: number, clientX: number, clientY: number, isPrimary = pointerId === 1) => ({
  pointerId,
  pointerType: 'touch',
  isPrimary,
  clientX,
  clientY,
  button: 0,
});

function mount() {
  let commits = 0;
  const utils = render(
    <Profiler id="pet" onRender={() => commits++}>
      <PetCompanion />
    </Profiler>,
  );
  const button = utils.getByRole('button');
  // 外層的位移層(moveRef):fixed 定位的那一層
  const mover = button.closest('.fixed') as HTMLElement;
  return {button, mover, commits: () => commits};
}

describe('拖小夥伴', () => {
  it('拖曳中只寫 transform、不重繪;放手才釘住並存起來', () => {
    const {button, mover, commits} = mount();
    fireEvent.pointerDown(button, finger(1, 100, 100));
    // 沒超過 4px 門檻:不算拖
    fireEvent.pointerMove(button, finger(1, 102, 101));
    expect(mover.style.transform).toBe('');

    fireEvent.pointerMove(button, finger(1, 120, 110));
    expect(mover.style.transform).toBe('translate(20px, 10px)');
    const afterStart = commits();
    for (let i = 1; i <= 10; i++) fireEvent.pointerMove(button, finger(1, 120 + i * 3, 110 + i));
    expect(mover.style.transform).toBe('translate(50px, 20px)');
    // 拖曳中不 setPinned —— 不然十個 move 就是十次 commit
    expect(commits()).toBe(afterStart);

    fireEvent.pointerUp(button, finger(1, 150, 120));
    expect(mover.style.transform).toBe('');
    expect(mover.style.left).toBe('50px');
    expect(mover.style.top).toBe('20px');
    expect(JSON.parse(localStorage.getItem(petPositionKey()) ?? 'null')).toEqual({x: 50, y: 20});
  });

  it('第二根手指的按下 / 移動 / 抬起都不影響第一根的拖曳', () => {
    const {button, mover} = mount();
    fireEvent.pointerDown(button, finger(1, 100, 100));
    fireEvent.pointerMove(button, finger(1, 110, 100));
    expect(mover.style.transform).toBe('translate(10px, 0px)');

    // 第二根按下去、動:起點沒有被覆寫,位置也不跟著它跑
    fireEvent.pointerDown(button, finger(2, 400, 400));
    fireEvent.pointerMove(button, finger(2, 450, 450));
    expect(mover.style.transform).toBe('translate(10px, 0px)');

    // 第二根抬起不收掉拖曳
    fireEvent.pointerUp(button, finger(2, 450, 450));
    fireEvent.pointerMove(button, finger(1, 130, 105));
    expect(mover.style.transform).toBe('translate(30px, 5px)');

    fireEvent.pointerUp(button, finger(1, 130, 105));
    expect(mover.style.left).toBe('30px');
    expect(mover.style.top).toBe('5px');
  });

  it('漏收了 pointerup:主指標再按下去,先把上一次釘住再重新開始', () => {
    const {button, mover} = mount();
    fireEvent.pointerDown(button, finger(1, 100, 100));
    fireEvent.pointerMove(button, finger(1, 140, 100));
    // 沒有 pointerup,同一種指標的主指標又按下來了
    fireEvent.pointerDown(button, finger(3, 300, 300, true));
    expect(mover.style.transform).toBe('');
    expect(mover.style.left).toBe('40px');
    fireEvent.pointerMove(button, finger(3, 310, 300, true));
    expect(mover.style.transform).toBe('translate(10px, 0px)');
  });
});
