// @vitest-environment jsdom
/**
 * 登入頁場景的宿主排程。
 *
 * 這一檔釘住:
 * - 減少動態時只畫一格,之後沒有 rAF 迴圈,指標移動也不重畫;
 * - 卸載時 WebGL context 主動放掉;
 * - 場景模組下載失敗時換成底色那一格。
 *
 * three.js 與場景都換成假的:這裡驗的是宿主的排程,不是畫面。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render} from '@testing-library/react';

type Pointer = {x: number; y: number};

const h = vi.hoisted(() => ({
  loadFails: false,
  updates: [] as Array<{pointer: Pointer}>,
  forceContextLoss: vi.fn(),
}));

vi.mock('three', () => ({
  WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio() {}
    setSize() {}
    dispose() {}
    forceContextLoss = h.forceContextLoss;
  },
}));

vi.mock('../login-scenes', () => ({
  pickScene: () => ({
    name: 'fake',
    load: async () => {
      if (h.loadFails) throw new Error('chunk load failed');
      return {
        name: 'fake',
        create: () => ({
          update: (_elapsed: number, pointer: Pointer) => {
            h.updates.push({pointer: {...pointer}});
          },
          resize() {},
          dispose() {},
        }),
      };
    },
  }),
}));

vi.mock('../../lib/media', () => ({useMediaQuery: () => true}));
vi.mock('../../lib/theme', () => ({useThemeMode: () => 'light'}));
vi.mock('../../lib/cssColor', () => ({resolveCssColor: () => 'rgb(0, 0, 0)'}));

import {LoginScene} from '../LoginScene';

/** rAF 自己排、自己沖:才數得到畫了幾格 */
let frames: Array<FrameRequestCallback> = [];
function flushFrames() {
  for (let i = 0; i < 10 && frames.length > 0; i += 1) {
    const batch = frames;
    frames = [];
    for (const cb of batch) cb(performance.now());
  }
}

beforeEach(() => {
  h.loadFails = false;
  h.updates = [];
  h.forceContextLoss.mockClear();
  frames = [];
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    id += 1;
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  const view = render(<LoginScene />);
  // 等動態 import 與場景建好(第一格)
  await vi.waitFor(() => expect(h.updates.length).toBe(1));
  const host = view.container.firstElementChild as HTMLElement;
  host.getBoundingClientRect = () =>
    ({left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0}) as DOMRect;
  const canvas = host.querySelector('canvas') as HTMLCanvasElement;
  return {...view, host, canvas};
}

describe('LoginScene:減少動態', () => {
  it('只畫一格,之後沒有迴圈,指標移動也不重畫', async () => {
    const {canvas} = await mount();
    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointermove', {bubbles: true, clientX: 150, clientY: 25}));
    });
    flushFrames();
    expect(h.updates).toHaveLength(1);
  });

  it('卸載:WebGL context 主動放掉', async () => {
    const {unmount} = await mount();
    unmount();
    expect(h.forceContextLoss).toHaveBeenCalledTimes(1);
  });
});

describe('LoginScene:場景起不來', () => {
  it('場景模組下載失敗:換成底色那一格,不建 canvas', async () => {
    h.loadFails = true;
    const view = render(<LoginScene />);
    await vi.waitFor(() => expect(view.container.querySelector('[data-scene], [style*="position"]')).toBeNull());
    const fallback = view.container.firstElementChild as HTMLElement;
    expect(fallback.getAttribute('aria-hidden')).toBe('true');
    expect(view.container.querySelector('canvas')).toBeNull();
    expect(h.updates).toHaveLength(0);
  });
});
