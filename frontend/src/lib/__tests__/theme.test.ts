// @vitest-environment jsdom
/**
 * 換佈景的淡過去(`lib/theme.ts` 的 `setTheme`)。
 *
 * 守的是:有 `startViewTransition` 就在 update 裡換 `data-theme`(拍完舊畫面才換),
 * 期間 <html> 掛著 `vt-theme`(global.css 只認它,不碰 SSH 那段的 `vt-terminal`),
 * 連按兩下時只有最後一段結束才拿掉;沒有就當場換。
 *
 * 後兩組:
 *  - `useThemeMode` 的 snapshot 要跟屬性**同一刻**換 —— update 之前任何 render 都還是舊佈景;
 *  - 跨分頁同步進來時,這一頁還沒跑的那段 update 要作廢,不能晚一步把畫面換回去。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, renderHook} from '@testing-library/react';

import {THEME_VT_CLASS, setTheme, toggleTheme, useThemeMode} from '../theme';

vi.mock('../api', () => ({api: {put: vi.fn(() => Promise.resolve())}}));

function fakeViewTransitions() {
  const runs: Array<{update: () => void; finish: () => void; skip: ReturnType<typeof vi.fn>}> = [];
  const start = vi.fn((update: () => void) => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const skip = vi.fn();
    runs.push({update, finish, skip});
    return {finished, skipTransition: skip};
  });
  // jsdom 沒有這支;lib.dom 的型別卻有,所以用 defineProperty 掛、用 Reflect 拆
  Object.defineProperty(document, 'startViewTransition', {value: start, configurable: true});
  return runs;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const root = document.documentElement;

/** 別的分頁改了佈景:localStorage 已經是新值,這一頁收到 storage 事件 */
function otherTabSets(mode: 'light' | 'dark') {
  localStorage.setItem('t100_theme', mode);
  window.dispatchEvent(new StorageEvent('storage', {key: 't100_theme'}));
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'startViewTransition');
  root.classList.remove(THEME_VT_CLASS);
});

describe('setTheme', () => {
  it('不支援 View Transitions 時當場換', () => {
    setTheme('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.classList.contains(THEME_VT_CLASS)).toBe(false);
  });

  it('支援時:拍完舊畫面(update)才換屬性,過場結束才拿掉 class', async () => {
    const runs = fakeViewTransitions();
    setTheme('light');
    expect(runs).toHaveLength(1);
    expect(root.classList.contains(THEME_VT_CLASS)).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('dark');
    runs[0].update();
    expect(root.getAttribute('data-theme')).toBe('light');
    runs[0].finish();
    await flush();
    expect(root.classList.contains(THEME_VT_CLASS)).toBe(false);
  });

  it('連按兩下:第一段先結束不能把第二段的 class 拿掉', async () => {
    const runs = fakeViewTransitions();
    setTheme('dark');
    setTheme('light');
    runs[0].update();
    runs[1].update();
    expect(root.getAttribute('data-theme')).toBe('light');
    runs[0].finish();
    await flush();
    expect(root.classList.contains(THEME_VT_CLASS)).toBe(true);
    runs[1].finish();
    await flush();
    expect(root.classList.contains(THEME_VT_CLASS)).toBe(false);
  });

  it('snapshot 跟屬性同一刻換:update 之前 render 讀到的仍是舊佈景', async () => {
    // 前一條結束在 light
    const runs = fakeViewTransitions();
    const {result} = renderHook(() => useThemeMode());
    expect(result.current).toBe('light');
    act(() => setTheme('dark'));
    expect(result.current).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    act(() => runs[0].update());
    expect(result.current).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    runs[0].finish();
    await flush();
  });

  it('過場還沒換過去前再按一次切換 → 切回去(以想要的那個為準),畫面一直沒動', async () => {
    const runs = fakeViewTransitions();
    const {result} = renderHook(() => useThemeMode());
    act(() => toggleTheme()); // dark → light(還在等 update)
    act(() => toggleTheme()); // 想要的又回到 dark
    act(() => runs[0].update());
    act(() => runs[1].update());
    expect(result.current).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    runs[0].finish();
    runs[1].finish();
    await flush();
  });

  it('跨分頁同步進來:當場套、跳過這一頁的過場,晚到的 update 不能把它蓋回去', async () => {
    // 現在是 dark
    const runs = fakeViewTransitions();
    const {result} = renderHook(() => useThemeMode());
    act(() => setTheme('light')); // 這一頁按了 light,update 還沒跑
    act(() => otherTabSets('dark')); // 別的分頁同時改成 dark
    expect(runs[0].skip).toHaveBeenCalled();
    act(() => runs[0].update()); // 被跳過的過場,瀏覽器照樣會叫 update
    expect(result.current).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    runs[0].finish();
    await flush();
    expect(root.classList.contains(THEME_VT_CLASS)).toBe(false);
  });

  it('跨分頁同步到跟畫面不同的佈景:直接換,不走過場', () => {
    const runs = fakeViewTransitions();
    const {result} = renderHook(() => useThemeMode());
    act(() => otherTabSets('light'));
    expect(runs).toHaveLength(0);
    expect(result.current).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
  });
});
