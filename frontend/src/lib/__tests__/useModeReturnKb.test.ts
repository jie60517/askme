// @vitest-environment jsdom
import {cleanup, renderHook} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {useModeReturnKb} from '../useModeReturnKb';

afterEach(cleanup);

type Props = {storeKey: string; active: boolean; projectKb: string | undefined; restore: (kb: string) => void};

describe('useModeReturnKb:離開模式回到進模式前的專案', () => {
  it('模式裡最後一則換成主機環境,離開時選回原本的專案', () => {
    const restore = vi.fn();
    const {rerender} = renderHook((p: Props) => useModeReturnKb(p), {
      initialProps: {storeKey: 'c1', active: false, projectKb: 'kb-main', restore},
    });
    rerender({storeKey: 'c1', active: true, projectKb: 'kb-main', restore});
    // 模式裡問過一題:conversationKb 變成主機的
    rerender({storeKey: 'c1', active: true, projectKb: 'kb-test', restore});
    expect(restore).not.toHaveBeenCalled();
    rerender({storeKey: 'c1', active: false, projectKb: 'kb-test', restore});
    expect(restore).toHaveBeenCalledWith('kb-main');
  });

  it('模式中自己換了專案:回到最後選的那個', () => {
    const restore = vi.fn();
    const {result, rerender} = renderHook((p: Props) => useModeReturnKb(p), {
      initialProps: {storeKey: 'c1', active: false, projectKb: 'kb-main', restore},
    });
    rerender({storeKey: 'c1', active: true, projectKb: 'kb-main', restore});
    result.current.notePick('kb-other');
    rerender({storeKey: 'c1', active: false, projectKb: 'kb-test', restore});
    expect(restore).toHaveBeenCalledWith('kb-other');
  });

  it('沒進過模式不會去動專案', () => {
    const restore = vi.fn();
    const {rerender} = renderHook((p: Props) => useModeReturnKb(p), {
      initialProps: {storeKey: 'c1', active: false, projectKb: 'kb-main', restore},
    });
    rerender({storeKey: 'c1', active: false, projectKb: 'x', restore});
    expect(restore).not.toHaveBeenCalled();
  });

  it('空白頁送出、整頁重掛:新掛上來的那一份離開時一樣選得回去', () => {
    const restore = vi.fn();
    const first = renderHook((p: Props) => useModeReturnKb(p), {
      initialProps: {storeKey: 'new', active: false, projectKb: 'kb-main', restore},
    });
    first.rerender({storeKey: 'new', active: true, projectKb: 'kb-main', restore});
    first.result.current.carryTo('c9');
    first.unmount();

    const second = renderHook((p: Props) => useModeReturnKb(p), {
      initialProps: {storeKey: 'c9', active: true, projectKb: 'kb-test', restore},
    });
    second.rerender({storeKey: 'c9', active: false, projectKb: 'kb-test', restore});
    expect(restore).toHaveBeenCalledWith('kb-main');
  });
});
