// @vitest-environment jsdom
/**
 * 長按拖曳(`components/useLongPressDrag.ts`)的觸控收尾。
 *
 * 守的是三件事,在電腦上用滑鼠永遠測不出來:
 *  1. **瀏覽器取消的手勢不是放下** —— 觸控時瀏覽器接手捲動會送 `pointercancel`,
 *     跟放手走同一支的話,指著資料夾就會被當成「放進去」;
 *  2. 捲動層上**事先**掛好不被動的 `touchmove`(瀏覽器在手指按下那刻就決定擋不擋得住),
 *     只有拖曳中才擋 —— 而且呼叫端每次 render 換一支新的 `onDrop` 也不能把它拆掉;
 *     捲動層之後才掛上來的(手機抽屜)由呼叫端叫 `armTouchArea` 當場補掛;
 *  3. 多點觸控:第二根手指不能搶走、也不能結束第一根手指的拖曳;
 *     但漏收了一次 pointerup 的話,下一次主指標按下要能重新開始(不能整個卡死)。
 *
 * 最後一組是放手之後的幽靈:沒放下的話飛回原本那一列才卸載。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, renderHook} from '@testing-library/react';

import {useLongPressDrag} from '../useLongPressDrag';

afterEach(cleanup);

/** jsdom 沒有 PointerEvent;拿 MouseEvent 補上 pointerId 就夠這支 hook 用 */
function pointer(type: string, pointerId: number, x = 0, y = 0): Event {
  const e = new MouseEvent(type, {clientX: x, clientY: y, bubbles: true, cancelable: true});
  Object.defineProperty(e, 'pointerId', {value: pointerId});
  return e;
}

/** 呼叫端掛在列上的 React onPointerDown —— 只用得到這幾個欄位 */
function down(pointerId: number, x = 10, y = 10, isPrimary = pointerId === 1, pointerType = 'touch') {
  return {
    button: 0,
    pointerId,
    isPrimary,
    pointerType,
    clientX: x,
    clientY: y,
    target: null,
    nativeEvent: new Event('pointerdown'),
  } as unknown as React.PointerEvent;
}

/** jsdom 不排版,getBoundingClientRect 一律 0 —— 要量的那幾個自己給 */
function stubRect(el: HTMLElement, r: {left: number; top: number; width: number; height: number}) {
  el.getBoundingClientRect = () =>
    ({...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {}}) as DOMRect;
}

/** `target: null` = 指標底下沒有放置目標(undefined 會被當成「沒給」而吃到預設值) */
function setup({target = 'folder-1' as string | null, row = null as HTMLElement | null} = {}) {
  const onDrop = vi.fn();
  const scroller = document.createElement('div');
  document.body.append(scroller);
  stubRect(scroller, {left: 0, top: 0, width: 260, height: 800});
  // ⚠️ onDrop 每次 render 都包一支新的 —— Sidebar 真的就是這樣傳的
  const hook = renderHook(() =>
    useLongPressDrag<string>({
      resolveTarget: () => target ?? undefined,
      resolveScroller: () => scroller,
      resolveVisual: () => row,
      onDrop: (payload, target) => onDrop(payload, target),
    }),
  );
  return {onDrop, hook, scroller};
}

function touchmove(on: EventTarget): Event {
  const e = new Event('touchmove', {cancelable: true, bubbles: true});
  on.dispatchEvent(e);
  return e;
}

/** 按住、等長按成立、再移動一段(超過 DRAG_MIN_MOVE) */
function pickUpAndMove(hook: ReturnType<typeof setup>['hook'], pointerId = 1) {
  act(() => hook.result.current.onPointerDown('chat-A')(down(pointerId)));
  act(() => {
    vi.advanceTimersByTime(150);
  });
  act(() => {
    window.dispatchEvent(pointer('pointermove', pointerId, 60, 80));
  });
}

/** 減少動態的開關(幽靈飛回去 vs 淡出) */
let reduceMotion = false;

beforeEach(() => {
  vi.useFakeTimers();
  reduceMotion = false;
  // jsdom 沒有這兩個;放置目標由 resolveTarget 決定,元素是什麼不重要
  document.elementFromPoint = () => document.body;
  window.matchMedia = ((q: string) => ({matches: reduceMotion, media: q}) as MediaQueryList) as typeof window.matchMedia;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useLongPressDrag 的觸控收尾', () => {
  it('pointerup 放下 —— 照常放進目標', () => {
    const {onDrop, hook} = setup();
    pickUpAndMove(hook);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 80));
    });
    expect(onDrop).toHaveBeenCalledWith('chat-A', 'folder-1');
    expect(hook.result.current.drag).toBeNull();
  });

  it('pointercancel 只收尾,不放下', () => {
    const {onDrop, hook} = setup();
    pickUpAndMove(hook);
    expect(hook.result.current.drag).not.toBeNull();
    act(() => {
      window.dispatchEvent(pointer('pointercancel', 1, 60, 80));
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(hook.result.current.drag).toBeNull();
  });

  it('捲動層事先掛好不被動的 touchmove,只有拖曳中才擋', () => {
    const {hook, scroller} = setup();
    // 長按判定期間不能擋:那時候手指一動是「他要捲動」
    act(() => hook.result.current.onPointerDown('chat-A')(down(1)));
    expect(touchmove(scroller).defaultPrevented).toBe(false);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // 拖曳開始的那次重繪(新的 onDrop)之後還要擋得住
    hook.rerender();
    expect(touchmove(scroller).defaultPrevented).toBe(true);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1));
    });
    expect(touchmove(scroller).defaultPrevented).toBe(false);
  });

  it('捲動層之後才掛上來(手機抽屜):呼叫端叫 armTouchArea 的當下就掛好,換一層會從舊的拔掉', () => {
    // 抽屜是打開才掛上的,而設計系統在抽屜模式不把 ref 往下傳 —— 掛載那一刻找不到捲動層
    //(沒補掛的話抽屜裡拖一下就被 pointercancel 收掉,見 Sidebar 的 bindDrawerList)
    let scroller: HTMLElement | null = null;
    const hook = renderHook(() =>
      useLongPressDrag<string>({
        resolveTarget: () => 'folder-1',
        resolveScroller: () => scroller,
        resolveVisual: () => null,
        onDrop: () => {},
      }),
    );
    const first = document.createElement('div');
    const add = vi.spyOn(first, 'addEventListener');
    scroller = first;
    // ⚠️ 要在手指按下**之前**就掛好:按下去才補掛的話,瀏覽器已經決定這一串 touchmove 擋不住了
    act(() => hook.result.current.armTouchArea());
    const armed = add.mock.calls.some(
      ([type, , opts]) => type === 'touchmove' && (opts as AddEventListenerOptions)?.passive === false,
    );
    expect(armed).toBe(true);
    pickUpAndMove(hook);
    expect(touchmove(first).defaultPrevented).toBe(true);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1));
    });

    // 抽屜關掉再打開 = 新的一層:舊的那層要拔掉、新的那層要掛上 ——
    // 都要在 armTouchArea 的**當下**(按下去也會補掛,所以在按下之前量)
    const second = document.createElement('div');
    const addSecond = vi.spyOn(second, 'addEventListener');
    const removeFirst = vi.spyOn(first, 'removeEventListener');
    scroller = second;
    act(() => hook.result.current.armTouchArea());
    expect(addSecond.mock.calls.some(([type]) => type === 'touchmove')).toBe(true);
    expect(removeFirst.mock.calls.some(([type]) => type === 'touchmove')).toBe(true);
    pickUpAndMove(hook);
    expect(touchmove(first).defaultPrevented).toBe(false);
    expect(touchmove(second).defaultPrevented).toBe(true);
  });

  it('卸載時拔掉監聽,長按計時器也不會在卸載後才觸發', () => {
    const {hook, scroller} = setup();
    const remove = vi.spyOn(scroller, 'removeEventListener');
    act(() => hook.result.current.onPointerDown('chat-A')(down(1)));
    hook.unmount();
    expect(remove.mock.calls.some(([type]) => type === 'touchmove')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(touchmove(scroller).defaultPrevented).toBe(false);
  });

  it('別種指標的主指標搶不走拖曳(觸控筆電:滑鼠拖到一半手碰到螢幕)', () => {
    const {onDrop, hook} = setup();
    act(() => hook.result.current.onPointerDown('chat-A')(down(1, 10, 10, true, 'mouse')));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // 觸控的第一根手指對觸控來說也是主指標 —— 但種類不同,不理
    act(() => hook.result.current.onPointerDown('chat-B')(down(5, 200, 200, true, 'touch')));
    expect(hook.result.current.drag?.payload).toBe('chat-A');
    act(() => {
      window.dispatchEvent(pointer('pointermove', 1, 60, 80));
    });
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 80));
    });
    expect(onDrop).toHaveBeenCalledWith('chat-A', 'folder-1');
  });

  it('漏收了 pointerup:下一次主指標按下要能重新開始', () => {
    const {onDrop, hook} = setup();
    pickUpAndMove(hook, 7);
    // pointer 7 的 pointerup 沒收到;下一次觸控是新的 pointerId,而且是主指標
    act(() => hook.result.current.onPointerDown('chat-B')(down(8, 10, 10, true)));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(hook.result.current.drag?.payload).toBe('chat-B');
    act(() => {
      window.dispatchEvent(pointer('pointermove', 8, 60, 80));
    });
    act(() => {
      window.dispatchEvent(pointer('pointerup', 8, 60, 80));
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('chat-B', 'folder-1');
  });

  it('第二根手指搶不走、也結束不了第一根手指的拖曳', () => {
    const {onDrop, hook} = setup();
    pickUpAndMove(hook, 1);
    // 第二根手指按下去:不重排長按、不換 payload
    act(() => hook.result.current.onPointerDown('chat-B')(down(2, 200, 200)));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(hook.result.current.drag?.payload).toBe('chat-A');
    // 第二根手指放開:拖曳還在
    act(() => {
      window.dispatchEvent(pointer('pointerup', 2, 200, 200));
    });
    expect(hook.result.current.drag).not.toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    // 第一根放開才放下
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 80));
    });
    expect(onDrop).toHaveBeenCalledWith('chat-A', 'folder-1');
  });
});

describe('useLongPressDrag 放手之後的幽靈(從哪來回哪去)', () => {
  /** 原本那一列(在清單裡、看得到)與 Sidebar 那顆幽靈外框 */
  function rowAndGhost() {
    const row = document.createElement('div');
    document.body.append(row);
    stubRect(row, {left: 12, top: 100, width: 200, height: 32});
    const ghost = document.createElement('div');
    document.body.append(ghost);
    return {row, ghost};
  }

  /** 拿起來、把幽靈交給 hook(Sidebar 是在 ref callback 裡 bindGhost)、移動一段 */
  function pickUpWithGhost(hook: ReturnType<typeof setup>['hook'], ghost: HTMLElement, payload = 'chat-A', pointerId = 1) {
    act(() => hook.result.current.onPointerDown(payload)(down(pointerId)));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => hook.result.current.bindGhost(ghost, {x: 0, y: 0}));
    act(() => {
      window.dispatchEvent(pointer('pointermove', pointerId, 60, 300));
    });
  }

  it('沒指著目標就放開:幽靈飛回原本那一列,飛完才卸載', () => {
    const {row, ghost} = rowAndGhost();
    const {onDrop, hook} = setup({target: null, row});
    pickUpWithGhost(hook, ghost);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 300));
    });
    expect(onDrop).not.toHaveBeenCalled();
    // 還掛著,正往那一列的左上角飛(只動 transform)
    expect(hook.result.current.drag).not.toBeNull();
    expect(ghost.style.transform).toBe('translate3d(12px, 100px, 0)');
    expect(ghost.style.transition).toContain('transform');
    expect(ghost.style.opacity).toBe('');
    act(() => {
      vi.advanceTimersByTime(339);
    });
    expect(hook.result.current.drag).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current.drag).toBeNull();
  });

  it('被瀏覽器取消也飛回去(不放下)', () => {
    const {row, ghost} = rowAndGhost();
    const {onDrop, hook} = setup({row});
    pickUpWithGhost(hook, ghost);
    act(() => {
      window.dispatchEvent(pointer('pointercancel', 1, 60, 300));
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(ghost.style.transform).toBe('translate3d(12px, 100px, 0)');
    act(() => {
      vi.advanceTimersByTime(340);
    });
    expect(hook.result.current.drag).toBeNull();
  });

  it('減少動態 / 那一列不見了:原地淡出,不飛', () => {
    const {row, ghost} = rowAndGhost();
    reduceMotion = true;
    const {hook} = setup({target: null, row});
    pickUpWithGhost(hook, ghost);
    const before = ghost.style.transform;
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 300));
    });
    expect(ghost.style.opacity).toBe('0');
    expect(ghost.style.transform).toBe(before);

    // 那一列被清單換掉了(不在文件裡)
    reduceMotion = false;
    const second = rowAndGhost();
    const other = setup({target: null, row: second.row});
    act(() => {
      vi.advanceTimersByTime(340);
    });
    pickUpWithGhost(other.hook, second.ghost, 'chat-B', 2);
    second.row.remove();
    act(() => {
      window.dispatchEvent(pointer('pointerup', 2, 60, 300));
    });
    expect(second.ghost.style.opacity).toBe('0');
    act(() => {
      vi.advanceTimersByTime(340);
    });
    expect(other.hook.result.current.drag).toBeNull();
  });

  it('放進目標:當場收掉,不飛', () => {
    const {row, ghost} = rowAndGhost();
    const {onDrop, hook} = setup({row});
    pickUpWithGhost(hook, ghost);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 300));
    });
    expect(onDrop).toHaveBeenCalledWith('chat-A', 'folder-1');
    expect(hook.result.current.drag).toBeNull();
    expect(ghost.style.transition).toBe('');
  });

  it('沒移動就放開(那是一次點擊):當場收掉,不吞 click', () => {
    const {row, ghost} = rowAndGhost();
    const {hook} = setup({target: null, row});
    act(() => hook.result.current.onPointerDown('chat-A')(down(1)));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => hook.result.current.bindGhost(ghost, {x: 0, y: 0}));
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 10, 10));
    });
    expect(hook.result.current.drag).toBeNull();
    const click = {preventDefault: vi.fn(), stopPropagation: vi.fn()} as unknown as React.MouseEvent;
    hook.result.current.onClickCapture(click);
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it('飛回去途中拿起下一列:舊的飛行收乾淨,新的拖曳不會被舊計時器收掉', () => {
    const {row, ghost} = rowAndGhost();
    const {onDrop, hook} = setup({target: null, row});
    pickUpWithGhost(hook, ghost);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 300));
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // 拖完那一發 click 照舊吞掉的時間已經過了;第二次長按成立
    act(() => hook.result.current.onPointerDown('chat-B')(down(1)));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(hook.result.current.drag?.payload).toBe('chat-B');
    // React 沿用同一顆節點 —— 飛行用的 style 要清掉,不然新的一次會滑過來 / 看不見
    expect(ghost.style.transition).toBe('');
    expect(ghost.style.opacity).toBe('');
    expect(ghost.style.boxShadow).toBe('');
    // 舊的卸載計時器已經取消
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(hook.result.current.drag?.payload).toBe('chat-B');
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 10, 10));
    });
    expect(hook.result.current.drag).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('飛到一半被卸載:不留計時器', () => {
    const {row, ghost} = rowAndGhost();
    const {hook} = setup({target: null, row});
    pickUpWithGhost(hook, ghost);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 60, 300));
    });
    // 吞 click 那一發(0ms)先讓它跑完,剩下的就只有飛回去的卸載計時器
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    hook.unmount();
    expect(clear).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
