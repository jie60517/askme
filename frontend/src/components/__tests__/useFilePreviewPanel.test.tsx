// @vitest-environment jsdom
/**
 * 右側檔案預覽面板的開 / 關(`components/FilePreviewPanel.tsx` 的 `useFilePreviewPanel`)。
 *
 * 測的是退場的時序 —— 畫面上只差 165ms,壞了很難用眼睛抓:
 *  1. 關掉時**不是當場卸載**:先掛 `isLeaving`,`DIALOG_EXIT_MS` 之後 `panel` 才變 null;
 *  2. 退場演到一半又點了檔案:取消那次關閉,面板留著、換成新內容,計時器到了也不會關掉;
 *  3. 連按兩下關閉只排一次(不會讓下一次打開被殘留的計時器關掉);
 *  4. 退場時面板**畫出來的**寬是 0(聊天欄跟著變寬),但不動傳進來的寬 ——
 *     使用者拉過的寬度在 `useResizable` 那邊,下一次打開照舊。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render, renderHook, screen} from '@testing-library/react';

import {FilePreviewPanel, useFilePreviewPanel} from '../FilePreviewPanel';
import {DIALOG_EXIT_MS} from '../useDialogExit';
import type {LightboxItem} from '../../lib/lightboxItem';

const A = [{name: 'a.txt'}] as unknown as LightboxItem[];
const B = [{name: 'b.txt'}, {name: 'c.txt'}] as unknown as LightboxItem[];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useFilePreviewPanel', () => {
  it('關掉時先演退場,DIALOG_EXIT_MS 之後才卸載', () => {
    const {result} = renderHook(() => useFilePreviewPanel());
    act(() => result.current.open(A, 0));
    expect(result.current.panel).toEqual({items: A, index: 0});
    expect(result.current.isLeaving).toBe(false);

    act(() => result.current.close());
    expect(result.current.panel).not.toBeNull();
    expect(result.current.isLeaving).toBe(true);

    act(() => vi.advanceTimersByTime(DIALOG_EXIT_MS - 1));
    expect(result.current.panel).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.panel).toBeNull();
    // 旗標要收回來,不然下一次打開會帶著「正在離開」出場
    expect(result.current.isLeaving).toBe(false);
  });

  it('退場演到一半又打開:取消關閉、換成新內容,計時器到了也不關', () => {
    const {result} = renderHook(() => useFilePreviewPanel());
    act(() => result.current.open(A, 0));
    act(() => result.current.close());
    act(() => vi.advanceTimersByTime(DIALOG_EXIT_MS / 2));

    act(() => result.current.open(B, 1));
    expect(result.current.isLeaving).toBe(false);
    expect(result.current.panel).toEqual({items: B, index: 1});

    act(() => vi.advanceTimersByTime(DIALOG_EXIT_MS * 2));
    expect(result.current.panel).toEqual({items: B, index: 1});
  });

  it('連按兩下關閉只排一次,之後再打開不會被殘留的計時器關掉', () => {
    const {result} = renderHook(() => useFilePreviewPanel());
    act(() => result.current.open(A, 0));
    act(() => result.current.close());
    act(() => vi.advanceTimersByTime(DIALOG_EXIT_MS / 2));
    act(() => result.current.close());
    act(() => vi.advanceTimersByTime(DIALOG_EXIT_MS / 2));
    expect(result.current.panel).toBeNull();

    act(() => result.current.open(B, 0));
    act(() => vi.advanceTimersByTime(DIALOG_EXIT_MS * 2));
    expect(result.current.panel).toEqual({items: B, index: 0});
    expect(result.current.isLeaving).toBe(false);
  });

  it('setIndex 只換頁,面板關著時不會把它打開', () => {
    const {result} = renderHook(() => useFilePreviewPanel());
    act(() => result.current.setIndex(1));
    expect(result.current.panel).toBeNull();

    act(() => result.current.open(B, 0));
    act(() => result.current.setIndex(1));
    expect(result.current.panel).toEqual({items: B, index: 1});
  });
});

describe('FilePreviewPanel 的退場寬度', () => {
  // `none` 模式只畫「看不了,請下載」,不會去 fetch
  const items: LightboxItem[] = [
    {name: 'a.bin', mode: 'none', previewUrl: '/p', downloadUrl: '/d', textUrl: null},
  ];
  // jsdom 沒有 matchMedia(預覽裡的 LoadingScreen 會問);一律回「不符合」
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  // 面板的根(Card)是帶 inline `flex-shrink` 的那一層 —— 從工具列往上找
  const panelOf = () => {
    let el: HTMLElement | null = screen.getByRole('toolbar', {name: 'File preview'});
    while (el && !el.style.flexShrink) el = el.parentElement;
    if (!el) throw new Error('找不到面板的根');
    return el;
  };

  it('平常照傳進來的寬,退場時收成 0', () => {
    const props = {items, index: 0, onIndexChange: () => {}, onClose: () => {}, width: 480};
    const {rerender} = render(<FilePreviewPanel {...props} />);
    expect(panelOf().style.width).toBe('480px');

    rerender(<FilePreviewPanel {...props} isLeaving />);
    expect(panelOf().style.width).toBe('0px');

    // 被叫回來(取消退場)就回到原寬
    rerender(<FilePreviewPanel {...props} isLeaving={false} />);
    expect(panelOf().style.width).toBe('480px');
  });
});
