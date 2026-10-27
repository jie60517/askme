// @vitest-environment jsdom
/**
 * 頭像裁切拖過邊界的橡皮筋。
 *
 * 要守住的兩件事:預覽上**看得到**超界(不是硬停);交出去的裁切框**永遠是夾好的**
 * (超界那一段只活在預覽上,存進資料庫的頭像不會有白邊)。
 */
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render} from '@testing-library/react';

import {AvatarCropper} from '../AvatarCropper';

let reduceMotion = false;
const drawImage = vi.fn();

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect() {},
    drawImage,
  })) as unknown as HTMLCanvasElement['getContext'];
  window.matchMedia = ((q: string) => ({
    matches: q.includes('reduce') ? reduceMotion : false,
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
  reduceMotion = false;
  drawImage.mockClear();
});
afterEach(cleanup);

// 512×256、放大 2 倍:裁切框邊長 128 = 預覽邊長,畫面上拖 1px = 裁切中心反向動 1px。
// cx 的合法範圍是 64~448;從 cx 64(已經貼左邊)再往右拖就是超界。
const source = {image: {} as CanvasImageSource, width: 512, height: 256, close: () => {}};
const crop = {zoom: 2, cx: 64, cy: 128};
const finger = (clientX: number) => ({pointerId: 1, isPrimary: true, clientX, clientY: 0, button: 0});
/** 最後一次畫出來的來源矩形左上角 x */
const lastDrawX = () => drawImage.mock.calls[drawImage.mock.calls.length - 1][1] as number;

describe('AvatarCropper:拖過照片邊界', () => {
  it('預覽上可以超界一小段,交出去的裁切框照樣夾在邊界上', () => {
    const onCropChange = vi.fn();
    const {getByRole} = render(<AvatarCropper source={source} crop={crop} onCropChange={onCropChange} />);
    const stage = getByRole('application');
    fireEvent.pointerDown(stage, finger(0));
    fireEvent.pointerMove(stage, finger(40));
    expect(onCropChange).toHaveBeenLastCalledWith({zoom: 2, cx: 64, cy: 128});
    // 合法的左上角是 0;超界之後往負的方向走,但走不到 40(越拉越沉)
    expect(lastDrawX()).toBeLessThan(0);
    expect(lastDrawX()).toBeGreaterThan(-40);
  });

  it('回彈到一半又抓住:從畫面上的位置接著拖,不會先跳回邊界', () => {
    const {getByRole} = render(<AvatarCropper source={source} crop={crop} onCropChange={() => {}} />);
    const stage = getByRole('application');
    fireEvent.pointerDown(stage, finger(0));
    fireEvent.pointerMove(stage, finger(40));
    const stretched = lastDrawX();
    // 放手:回彈開始(rAF 還沒跑,畫面停在超界的位置)—— 馬上又按下去、原地動一下
    fireEvent.pointerUp(stage, finger(40));
    fireEvent.pointerDown(stage, finger(100));
    expect(lastDrawX()).toBeCloseTo(stretched, 6);
    fireEvent.pointerMove(stage, finger(100));
    expect(lastDrawX()).toBeCloseTo(stretched, 6);
  });

  it('減少動態時不超界(超界之後要靠一段動畫收回來,那正是要拿掉的東西)', () => {
    reduceMotion = true;
    const {getByRole} = render(<AvatarCropper source={source} crop={crop} onCropChange={() => {}} />);
    const stage = getByRole('application');
    fireEvent.pointerDown(stage, finger(0));
    fireEvent.pointerMove(stage, finger(40));
    expect(lastDrawX()).toBe(0);
  });

  it('方向鍵維持硬夾', () => {
    const {getByRole} = render(<AvatarCropper source={source} crop={crop} onCropChange={() => {}} />);
    fireEvent.keyDown(getByRole('application'), {key: 'ArrowRight'});
    expect(lastDrawX()).toBe(0);
  });
});
