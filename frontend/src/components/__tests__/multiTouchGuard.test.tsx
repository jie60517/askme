// @vitest-environment jsdom
/**
 * 多指保護:拖曳中只認按下去的那一根指標。
 *
 * 第二根手指(`isPrimary: false`)的 down / move / up 一律不理;**主指標**又按下來代表上一次的
 * pointerup 漏收了,當成重新開始(不然控制項會卡死,同 `useLongPressDrag`)。
 *
 * 只測 `AvatarCropper` 與 `SidebarResizer`:`FilePanel` 的 `ColumnResizer` 是同一套寫法,
 * 但它沒有匯出,為了測它去 render 整個檔案欄(WebSocket、檔案 API)不划算。
 */
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render} from '@testing-library/react';
import {createRef} from 'react';

import {AvatarCropper} from '../AvatarCropper';
import {SidebarResizer} from '../SidebarResizer';

beforeAll(() => {
  // jsdom 沒有這幾個;這裡只在乎事件怎麼分流,不在乎畫面
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => true;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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

const finger = (pointerId: number, clientX: number, clientY = 0, isPrimary = pointerId === 1) => ({
  pointerId,
  isPrimary,
  clientX,
  clientY,
  button: 0,
});

describe('AvatarCropper:拖照片只認第一根手指', () => {
  // 512×256、放大 2 倍:裁切框邊長 128 = 預覽邊長,畫面上拖 1px = 裁切中心反向動 1px
  const source = {image: {} as CanvasImageSource, width: 512, height: 256, close: () => {}};
  const crop = {zoom: 2, cx: 256, cy: 128};

  it('第二根手指的按下 / 移動 / 抬起都不影響第一根的拖曳', () => {
    const onCropChange = vi.fn();
    const {getByRole} = render(<AvatarCropper source={source} crop={crop} onCropChange={onCropChange} />);
    const stage = getByRole('application');

    fireEvent.pointerDown(stage, finger(1, 0));
    fireEvent.pointerDown(stage, finger(2, 100));
    fireEvent.pointerMove(stage, finger(2, 150));
    expect(onCropChange).not.toHaveBeenCalled();

    // 起點沒有被第二根手指覆寫:位移從 0 算,不是從 100 算
    fireEvent.pointerMove(stage, finger(1, 10));
    expect(onCropChange).toHaveBeenLastCalledWith({zoom: 2, cx: 246, cy: 128});

    // 第二根抬起不收掉拖曳
    fireEvent.pointerUp(stage, finger(2, 150));
    fireEvent.pointerMove(stage, finger(1, 20));
    expect(onCropChange).toHaveBeenLastCalledWith({zoom: 2, cx: 236, cy: 128});

    fireEvent.pointerUp(stage, finger(1, 20));
    onCropChange.mockClear();
    fireEvent.pointerMove(stage, finger(1, 40));
    expect(onCropChange).not.toHaveBeenCalled();
  });

  it('漏收了 pointerup 也不會卡死:主指標再按下去就重新開始', () => {
    const onCropChange = vi.fn();
    const {getByRole} = render(<AvatarCropper source={source} crop={crop} onCropChange={onCropChange} />);
    const stage = getByRole('application');

    fireEvent.pointerDown(stage, finger(1, 0));
    // pointerId 1 的 up 沒收到;下一次觸控是新的 pointerId(主指標)
    fireEvent.pointerDown(stage, finger(7, 50, 0, true));
    fireEvent.pointerMove(stage, finger(7, 60, 0, true));
    expect(onCropChange).toHaveBeenLastCalledWith({zoom: 2, cx: 246, cy: 128});
  });
});

describe('SidebarResizer:拖邊線只認第一根手指', () => {
  const setup = () => {
    const nav = document.createElement('nav');
    document.body.append(nav);
    const navRef = createRef<HTMLElement>() as {current: HTMLElement | null};
    navRef.current = nav;
    const onWidthChange = vi.fn();
    const onCollapsedChange = vi.fn();
    const {getByRole} = render(
      <SidebarResizer
        navRef={navRef}
        width={300}
        isCollapsed={false}
        onWidthChange={onWidthChange}
        onCollapsedChange={onCollapsedChange}
      />,
    );
    return {nav, strip: getByRole('separator'), onWidthChange, onCollapsedChange};
  };

  it('第二根手指的移動 / 抬起不改寬度、不結束拖曳', () => {
    const {nav, strip, onWidthChange, onCollapsedChange} = setup();

    fireEvent.pointerDown(strip, finger(1, 300));
    fireEvent.pointerDown(strip, finger(2, 200));
    fireEvent.pointerMove(window, finger(2, 380));
    expect(nav.style.width).toBe('');

    // nav 左緣在 0(jsdom),寬度 = 游標 x − 死區 6px
    fireEvent.pointerMove(window, finger(1, 350));
    expect(nav.style.width).toBe('344px');

    fireEvent.pointerUp(window, finger(2, 380));
    expect(onWidthChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, finger(1, 360));
    expect(nav.style.width).toBe('354px');

    fireEvent.pointerUp(window, finger(1, 360));
    expect(onWidthChange).toHaveBeenCalledWith(354);
    expect(onCollapsedChange).not.toHaveBeenCalled();
    nav.remove();
  });

  it('漏收了 pointerup 也不會卡死:主指標再按下去就重新開始', () => {
    const {nav, strip, onWidthChange, onCollapsedChange} = setup();

    fireEvent.pointerDown(strip, finger(1, 300));
    fireEvent.pointerDown(strip, finger(9, 300, 0, true));
    fireEvent.pointerUp(window, finger(9, 300, 0, true));
    // 沒拖 = 按一下 = 切換收合;重要的是這一下收得掉
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(onWidthChange).not.toHaveBeenCalled();
    nav.remove();
  });
});
