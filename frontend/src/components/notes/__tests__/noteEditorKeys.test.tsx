// @vitest-environment jsdom
/**
 * 掛在 NoteEditor 上的按鍵(編輯器本身的 handleKeyDown 比各個 extension 的快捷鍵先拿到鍵)。
 *
 * 守的情境:打完標題,在內文第一行按 Tab 縮了一層,Backspace 要能退回來 ——
 * 「開頭按 Backspace 回到標題」不能先把鍵攔走,讓縮排的 Backspace 退一層輪不到。
 */
import {Editor} from '@tiptap/core';
import {act, cleanup, render} from '@testing-library/react';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import {NoteEditor} from '../NoteEditor';

beforeAll(() => {
  // jsdom 沒有;選字工具列會查「是不是觸控螢幕」
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  // ProseMirror 量游標位置要用,jsdom 沒有
  Range.prototype.getClientRects ??= () => ({length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator]}) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  document.elementFromPoint ??= () => null;
});
afterEach(cleanup);

function mount(body: string) {
  const onExitTop = vi.fn();
  const view = render(<NoteEditor body={body} doc={null} onChange={() => {}} host={{}} onExitTop={onExitTop} />);
  const editor = (view.container.querySelector('.ProseMirror') as HTMLElement & {editor: Editor}).editor;
  act(() => {
    editor.commands.focus('start');
  });
  return {onExitTop, editor};
}

function key(editor: Editor, k: string) {
  act(() => {
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {key: k, code: k, bubbles: true, cancelable: true}));
  });
}

const indentOf = (editor: Editor) => editor.state.doc.firstChild!.attrs.indent;

describe('內文第一行的 Tab / Backspace', () => {
  it('空的第一行按 Tab 縮排,Backspace 先退回去,不跳回標題', () => {
    const {onExitTop, editor} = mount('');
    key(editor, 'Tab');
    expect(indentOf(editor)).toBe(1);
    key(editor, 'Backspace');
    expect(indentOf(editor)).toBe(0);
    expect(onExitTop).not.toHaveBeenCalled();
    // 退到底了,再按才回標題
    key(editor, 'Backspace');
    expect(onExitTop).toHaveBeenCalledTimes(1);
  });

  it('有字的第一行縮兩層:開頭按 Backspace 一層一層退', () => {
    const {onExitTop, editor} = mount('第一行');
    key(editor, 'Tab');
    key(editor, 'Tab');
    expect(indentOf(editor)).toBe(2);
    key(editor, 'Backspace');
    expect(indentOf(editor)).toBe(1);
    key(editor, 'Backspace');
    expect(indentOf(editor)).toBe(0);
    expect(onExitTop).not.toHaveBeenCalled();
    expect(editor.state.doc.textContent).toBe('第一行');
  });
});
