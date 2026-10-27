/**
 * 選取整塊(照 Notion)。
 *
 *   - 打字時按 Esc:選起游標所在的那一塊(最上層那一塊)。
 *   - 選著的時候:↑↓ 換一塊、Shift+↑↓ 多選幾塊、Delete / Backspace 整塊刪、Ctrl+D 整塊複製一份在下面、
 *     Enter 回到那一塊的最後打字、Esc 或點一下滑鼠取消。其他按鍵:取消選取,按鍵照常。
 *
 * 只記「第幾塊到第幾塊」(外掛自己的狀態),用裝飾畫底色,不改內容:選的時候不會觸發存檔、也不會同步給別人。
 * 內容一改(自己刪了、別人打字)就取消,不用去追位置。
 * 「/」「@」「[[」選單開著的時候 Esc 是收選單,不是選整塊(它們的 Esc 要先處理)。
 */
import {Extension, type Editor} from '@tiptap/core';
import {Plugin, PluginKey, TextSelection, type EditorState} from '@tiptap/pm/state';
import {Decoration, DecorationSet} from '@tiptap/pm/view';

import {suggestionOpen} from './slashCommand';

type Range = {anchor: number; head: number} | null;

export const blockSelectionKey = new PluginKey<Range>('noteBlockSelection');

/** 現在有沒有選著整塊(NoteEditor 的 ↑ 回標題要讓它先) */
export function hasBlockSelection(state: EditorState): boolean {
  return blockSelectionKey.getState(state) != null;
}

/** 第 i 塊的開頭位置 */
function startOf(state: EditorState, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;
  return pos;
}

function span(range: NonNullable<Range>) {
  return {from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head)};
}

/** 第 from 塊到第 to 塊(含)在文件裡的起訖位置 */
function bounds(state: EditorState, from: number, to: number): {start: number; end: number} {
  return {start: startOf(state, from), end: startOf(state, to) + state.doc.child(to).nodeSize};
}

export const BlockSelection = Extension.create({
  name: 'noteBlockSelection',
  // 要比 NotionKeys(1100)早:選著的時候 Ctrl+D、Backspace 是整塊的事
  priority: 1200,
  addProseMirrorPlugins() {
    const editor = this.editor as Editor;
    const set = (range: Range) => editor.view.dispatch(editor.state.tr.setMeta(blockSelectionKey, range));
    /** 游標放到第 i 塊的最後(取消選取時) */
    const caretTo = (index: number) => {
      const {state} = editor;
      const end = startOf(state, index) + state.doc.child(index).nodeSize;
      const tr = state.tr.setMeta(blockSelectionKey, null);
      tr.setSelection(TextSelection.near(tr.doc.resolve(end - 1), -1));
      editor.view.dispatch(tr.scrollIntoView());
    };
    return [
      new Plugin<Range>({
        key: blockSelectionKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(blockSelectionKey) as Range | undefined;
            if (meta !== undefined) return meta;
            return tr.docChanged ? null : value;
          },
        },
        props: {
          decorations(state) {
            const range = blockSelectionKey.getState(state);
            if (!range) return null;
            const {from, to} = span(range);
            const decos: Decoration[] = [];
            let pos = startOf(state, from);
            for (let i = from; i <= to && i < state.doc.childCount; i++) {
              const node = state.doc.child(i);
              decos.push(Decoration.node(pos, pos + node.nodeSize, {class: 'note-block-selected'}));
              pos += node.nodeSize;
            }
            return DecorationSet.create(state.doc, decos);
          },
          // 選著的時候藏游標(底色已經說明「選了哪幾塊」)
          attributes: (state): Record<string, string> => (blockSelectionKey.getState(state) ? {class: 'has-block-selection'} : {}),
          handleDOMEvents: {
            mousedown: (view) => {
              if (blockSelectionKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(blockSelectionKey, null));
              return false;
            },
          },
          handleKeyDown: (view, event) => {
            const {state} = view;
            const range = blockSelectionKey.getState(state);
            if (!range) {
              if (event.key !== 'Escape' || suggestionOpen(state) || !editor.isEditable) return false;
              const index = state.selection.$from.index(0);
              if (index >= state.doc.childCount) return false;
              set({anchor: index, head: index});
              return true;
            }
            const count = state.doc.childCount;
            const {from, to} = span(range);
            const mod = event.ctrlKey || event.metaKey;
            switch (event.key) {
              case 'Escape':
                set(null);
                return true;
              case 'ArrowUp':
              case 'ArrowDown': {
                const dir = event.key === 'ArrowUp' ? -1 : 1;
                const head = Math.max(0, Math.min(count - 1, range.head + dir));
                set(event.shiftKey ? {anchor: range.anchor, head} : {anchor: head, head});
                return true;
              }
              case 'Backspace':
              case 'Delete': {
                const {start, end} = bounds(state, from, to);
                const tr = state.tr.delete(start, end).setMeta(blockSelectionKey, null);
                // 整份刪光:留一個空段落
                if (!tr.doc.childCount) tr.insert(0, state.schema.nodes.paragraph.create());
                tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(start, tr.doc.content.size)), -1));
                view.dispatch(tr.scrollIntoView());
                return true;
              }
              case 'Enter':
                caretTo(range.head);
                return true;
              default:
                if (mod && event.key.toLowerCase() === 'd') {
                  const {start, end} = bounds(state, from, to);
                  const slice = state.doc.slice(start, end);
                  const tr = state.tr.insert(end, slice.content);
                  const added = to - from + 1;
                  view.dispatch(tr.setMeta(blockSelectionKey, {anchor: from + added, head: to + added}));
                  return true;
                }
                // 修飾鍵本身(按著 Shift 準備按 ↑)不算
                if (['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return false;
                set(null);
                return false;
            }
          },
        },
      }),
    ];
  },
});
