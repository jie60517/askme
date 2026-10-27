// @vitest-environment jsdom
/**
 * 跟 Notion 一致的編輯手感(不改畫面的那幾項):
 * Ctrl+Alt+數字、有字的段落轉可收合清單、Ctrl+Enter、Ctrl+Shift+↑↓、貼上 Markdown。
 */
import {Editor, type JSONContent} from '@tiptap/core';
import {afterEach, describe, expect, it} from 'vitest';

import type {NoteSummary} from '../../../lib/notebookApi';
import {BlockSelection, blockSelectionKey} from '../blockSelection';
import {htmlHasStructure, looksLikeMarkdown, noteExtensions, shiftBlock, turnInto} from '../noteExtensions';
import {DEFAULT_HOST, setHost} from '../noteHost';
import {childrenMap, dropMove, dropWhere} from '../NoteTree';
import {dateLabel, fromIsoDate, isoDate, pageLinkItems, parseDateQuery} from '../mentionMenu';

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

function make(content: JSONContent[]): Editor {
  const editor = new Editor({extensions: noteExtensions(), content: {type: 'doc', content}});
  editors.push(editor);
  return editor;
}
const p = (text: string): JSONContent => ({type: 'paragraph', content: text ? [{type: 'text', text}] : []});
const li = (type: 'listItem' | 'taskItem', text: string, attrs?: Record<string, unknown>): JSONContent => ({type, attrs, content: [p(text)]});

/** 游標放到某段字裡(第一個出現的位置之後 n 個字) */
function caret(editor: Editor, text: string, n = 1) {
  let pos = -1;
  editor.state.doc.descendants((node, offset) => {
    if (pos < 0 && node.isText && node.text!.includes(text)) pos = offset + node.text!.indexOf(text) + n;
  });
  editor.commands.setTextSelection(pos);
}

function key(editor: Editor, k: string, mods: {ctrl?: boolean; alt?: boolean; shift?: boolean} = {}) {
  const code = /^\d$/.test(k) ? `Digit${k}` : k;
  const event = new KeyboardEvent('keydown', {key: k, code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, bubbles: true, cancelable: true});
  editor.view.dom.dispatchEvent(event);
}

/** 最上層每一塊:種類(+ 標題層級) */
const blocks = (editor: Editor) => editor.getJSON().content!.map((b) => b.type + (b.attrs?.level ?? ''));

describe('Ctrl+Alt+數字(照 Notion)', () => {
  const want: Record<string, string> = {
    '0': 'paragraph',
    '1': 'heading1',
    '2': 'heading2',
    '3': 'heading3',
    '4': 'taskList',
    '5': 'bulletList',
    '6': 'orderedList',
    '7': 'details',
    '8': 'codeBlock',
  };
  for (const [k, type] of Object.entries(want)) {
    it(`一般段落按 Ctrl+Alt+${k} → ${type}`, () => {
      const editor = make([p('要轉換的段落')]);
      caret(editor, '要轉換');
      key(editor, k, {ctrl: true, alt: true});
      expect(blocks(editor)[0]).toBe(type);
    });
  }

  it('標題按 Ctrl+Alt+0 回到文字、按同一個數字不會又變回文字', () => {
    const editor = make([{type: 'heading', attrs: {level: 2}, content: [{type: 'text', text: '標題'}]}]);
    caret(editor, '標題');
    key(editor, '2', {ctrl: true, alt: true});
    expect(blocks(editor)[0]).toBe('heading2');
    key(editor, '0', {ctrl: true, alt: true});
    expect(blocks(editor)[0]).toBe('paragraph');
  });
});

describe('有字的段落轉成可收合清單:字變成標題(照 Notion)', () => {
  const summaryOf = (editor: Editor) => {
    const d = editor.state.doc.firstChild!;
    return {type: d.type.name, open: d.attrs.open, summary: d.child(0).textContent, body: d.child(1).textContent};
  };

  it('轉換成 → 可收合清單:原本的字在標題、內容是空的一行、打開著,游標停在原本的位置', () => {
    const editor = make([p('這段字要變成標題'), p('下一段')]);
    caret(editor, '這段', 2);
    turnInto(editor, 'toggle');
    expect(summaryOf(editor)).toEqual({type: 'details', open: true, summary: '這段字要變成標題', body: ''});
    expect(editor.state.selection.$from.parent.type.name).toBe('detailsSummary');
    expect(editor.state.selection.$from.parentOffset).toBe(2);
    expect(editor.state.doc.child(1).textContent).toBe('下一段');
  });

  it('從項目清單轉:一樣把字帶進標題', () => {
    const editor = make([{type: 'bulletList', content: [li('listItem', '清單的字')]}]);
    caret(editor, '清單');
    turnInto(editor, 'toggle');
    expect(summaryOf(editor)).toMatchObject({type: 'details', summary: '清單的字'});
  });

  it('有字的行首打「> 」:字變成標題', () => {
    const editor = make([p('行首的字')]);
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('>');
    const {from} = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, from, ' ', () => editor.state.tr));
    expect(handled).toBe(true);
    expect(summaryOf(editor)).toMatchObject({type: 'details', open: true, summary: '行首的字'});
  });

  it('空的一行打「> 」:開一個空的可收合清單,游標在標題', () => {
    const editor = make([p('')]);
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('>');
    const {from} = editor.state.selection;
    editor.view.someProp('handleTextInput', (f) => f(editor.view, from, from, ' ', () => editor.state.tr));
    expect(summaryOf(editor)).toMatchObject({type: 'details', summary: '', body: ''});
    expect(editor.state.selection.$from.parent.type.name).toBe('detailsSummary');
  });
});

describe('Ctrl+Enter(照 Notion)', () => {
  it('在待辦上:勾起來,再按一次取消', () => {
    const editor = make([{type: 'taskList', content: [li('taskItem', '待辦一', {checked: false})]}]);
    caret(editor, '待辦');
    const checked = () => editor.state.doc.firstChild!.firstChild!.attrs.checked;
    key(editor, 'Enter', {ctrl: true});
    expect(checked()).toBe(true);
    key(editor, 'Enter', {ctrl: true});
    expect(checked()).toBe(false);
  });

  it('在可收合清單的標題上:開 / 合', () => {
    const editor = make([
      {type: 'details', attrs: {open: true}, content: [{type: 'detailsSummary', content: [{type: 'text', text: '標題'}]}, {type: 'detailsContent', content: [p('內容')]}]},
    ]);
    caret(editor, '標題');
    key(editor, 'Enter', {ctrl: true});
    expect(editor.state.doc.firstChild!.attrs.open).toBe(false);
  });
});

describe('Ctrl+Shift+↑↓ 搬動這一塊(shiftBlock)', () => {
  it('段落往上、往下搬一格,游標跟著走', () => {
    const editor = make([p('一'), p('二'), p('三')]);
    caret(editor, '二', 0);
    expect(shiftBlock(editor, -1)).toBe(true);
    expect(editor.getText({blockSeparator: '|'})).toBe('二|一|三');
    expect(editor.state.selection.$from.parent.textContent).toBe('二');
    shiftBlock(editor, 1);
    shiftBlock(editor, 1);
    expect(editor.getText({blockSeparator: '|'})).toBe('一|三|二');
  });

  it('清單項目在清單裡面搬,不會搬整個清單', () => {
    const editor = make([p('前面'), {type: 'bulletList', content: [li('listItem', 'A'), li('listItem', 'B')]}]);
    caret(editor, 'B', 0);
    shiftBlock(editor, -1);
    const list = editor.state.doc.child(1);
    expect([list.child(0).textContent, list.child(1).textContent]).toEqual(['B', 'A']);
    expect(editor.state.doc.child(0).textContent).toBe('前面');
  });

  it('已經在最上面:不動,但按鍵還是吃掉(不會捲動頁面)', () => {
    const editor = make([p('一'), p('二')]);
    caret(editor, '一', 0);
    expect(shiftBlock(editor, -1)).toBe(true);
    expect(editor.getText({blockSeparator: '|'})).toBe('一|二');
  });

  it('鍵盤 Ctrl+Shift+↓ 有接上', () => {
    const editor = make([p('一'), p('二')]);
    caret(editor, '一', 0);
    key(editor, 'ArrowDown', {ctrl: true, shift: true});
    expect(editor.getText({blockSeparator: '|'})).toBe('二|一');
  });
});

describe('貼上 Markdown', () => {
  it('看起來像 Markdown 的才轉', () => {
    expect(looksLikeMarkdown('# 標題\n\n- 一\n- 二')).toBe(true);
    expect(looksLikeMarkdown('1. 第一步\n2. 第二步')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
    expect(looksLikeMarkdown('這是**粗體**')).toBe(true);
    expect(looksLikeMarkdown('```sql\nSELECT 1\n```')).toBe(true);
    // 一般文字、網址、單獨一個減號開頭的數字不算
    expect(looksLikeMarkdown('一般的一句話')).toBe(false);
    expect(looksLikeMarkdown('https://example.com/a/b')).toBe(false);
    expect(looksLikeMarkdown('-5 度')).toBe(false);
  });

  it('轉成標題、清單、粗體', () => {
    const editor = make([p('')]);
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('# 貼上的標題\n\n- 項目 A\n- 項目 B\n\n**粗體**字', {contentType: 'markdown'});
    expect(blocks(editor).filter((b) => b !== 'paragraph' || true)).toEqual(expect.arrayContaining(['heading1', 'bulletList']));
    expect(editor.getHTML()).toContain('<strong>粗體</strong>');
  });
});

// ------------------------------------------------------------------ 縮排、區塊選取、提及、拖曳落點
describe('Tab 縮排(照 Notion)', () => {
  const indentOf = (editor: Editor, i = 0) => editor.state.doc.child(i).attrs.indent;

  it('段落 Tab 縮一層、Shift+Tab 退一層;退到 0 也不讓游標跳出編輯器', () => {
    const editor = make([p('上一段'), p('這一段')]);
    caret(editor, '這一段');
    key(editor, 'Tab');
    key(editor, 'Tab');
    expect(indentOf(editor, 1)).toBe(2);
    key(editor, 'Tab', {shift: true});
    expect(indentOf(editor, 1)).toBe(1);
    expect(editor.view.someProp('handleKeyDown', (f) => f(editor.view, new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true})))).toBe(true);
    expect(editor.view.someProp('handleKeyDown', (f) => f(editor.view, new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true})))).toBe(true);
    expect(indentOf(editor, 1)).toBe(0);
  });

  it('縮排的那一段最開頭按 Backspace:先退一層,不併到上一段', () => {
    const editor = make([p('上一段'), {type: 'paragraph', attrs: {indent: 1}, content: [{type: 'text', text: '縮排的'}]}]);
    caret(editor, '縮排的', 0);
    key(editor, 'Backspace');
    expect(editor.state.doc.childCount).toBe(2);
    expect(indentOf(editor, 1)).toBe(0);
  });

  it('清單裡的 Tab 照清單自己的(變子項目),不是縮排屬性', () => {
    const editor = make([{type: 'bulletList', content: [li('listItem', '一'), li('listItem', '二')]}]);
    caret(editor, '二');
    key(editor, 'Tab');
    const list = editor.state.doc.firstChild!;
    expect(list.childCount).toBe(1);
    expect(list.firstChild!.childCount).toBe(2); // 「一」底下多了一層清單
  });

  it('Enter 換行時新的一行沿用同一層', () => {
    const editor = make([{type: 'paragraph', attrs: {indent: 2}, content: [{type: 'text', text: '縮兩層'}]}]);
    caret(editor, '縮兩層', 3);
    editor.commands.splitBlock();
    expect(indentOf(editor, 1)).toBe(2);
  });
});

describe('Esc 選取整塊(照 Notion)', () => {
  function makeWithSelection(content: JSONContent[]) {
    const editor = new Editor({extensions: [...noteExtensions(), BlockSelection], content: {type: 'doc', content}});
    editors.push(editor);
    return editor;
  }
  const texts = (editor: Editor) => editor.getText({blockSeparator: '|'});

  it('Esc 選起游標那一塊;Backspace 整塊刪掉', () => {
    const editor = makeWithSelection([p('一'), p('二'), p('三')]);
    caret(editor, '二', 0);
    key(editor, 'Escape');
    expect(blockSelectionKey.getState(editor.state)).toEqual({anchor: 1, head: 1});
    key(editor, 'Backspace');
    expect(texts(editor)).toBe('一|三');
    expect(blockSelectionKey.getState(editor.state)).toBeNull();
  });

  it('Shift+↓ 多選、Ctrl+D 整段複製一份在下面;Esc 取消', () => {
    const editor = makeWithSelection([p('一'), p('二'), p('三')]);
    caret(editor, '一', 0);
    key(editor, 'Escape');
    key(editor, 'ArrowDown', {shift: true});
    expect(blockSelectionKey.getState(editor.state)).toEqual({anchor: 0, head: 1});
    key(editor, 'd', {ctrl: true});
    expect(texts(editor)).toBe('一|二|一|二|三');
    key(editor, 'Escape');
    expect(blockSelectionKey.getState(editor.state)).toBeNull();
  });

  it('選著的時候 ↑↓ 換一塊;Enter 回到那一塊的最後打字', () => {
    const editor = makeWithSelection([p('一'), p('二')]);
    caret(editor, '一', 0);
    key(editor, 'Escape');
    key(editor, 'ArrowDown');
    expect(blockSelectionKey.getState(editor.state)).toEqual({anchor: 1, head: 1});
    key(editor, 'Enter');
    expect(blockSelectionKey.getState(editor.state)).toBeNull();
    expect(editor.state.selection.$from.parent.textContent).toBe('二');
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });
});

describe('@ 日期與提及', () => {
  const now = new Date(2026, 9, 14);
  it('日期:今年寫月/日,別年加上年份;打的字像日期才算', () => {
    expect(dateLabel(new Date(2026, 9, 20), now)).toBe('10/20');
    expect(dateLabel(new Date(2027, 0, 5), now)).toBe('2027/1/5');
    expect(parseDateQuery('10/20', now)?.getDate()).toBe(20);
    expect(parseDateQuery('2026-11-03', now)?.getMonth()).toBe(10);
    expect(parseDateQuery('2/30', now)).toBeNull();
    expect(parseDateQuery('Alice', now)).toBeNull();
  });

  it('提及寫進 Markdown(搜尋與摘要):人是 @名字,頁面是標題', () => {
    const editor = make([
      {
        type: 'paragraph',
        content: [
          {type: 'text', text: '請 '},
          {type: 'noteMention', attrs: {kind: 'user', id: 'alice', label: 'Alice'}},
          {type: 'text', text: ' 看 '},
          {type: 'noteMention', attrs: {kind: 'page', id: 3, label: '客戶上線清單'}},
        ],
      },
    ]);
    expect(editor.getMarkdown()).toBe('請 @Alice 看 客戶上線清單');
  });
});

describe('左側清單的拖曳落點(dropMove)', () => {
  const row = (id: number, parent_id: number | null, position: number) =>
    ({id, parent_id, position, title: String(id), summary: '', source_kind: null, has_image: false, updated_at: '', icon: null}) as unknown as NoteSummary;
  const rows = [row(1, null, 0), row(2, null, 1), row(3, null, 2), row(4, 2, 0)];
  const children = childrenMap(rows);

  it('上緣 / 下緣 / 中間 = 前面 / 後面 / 變成子頁', () => {
    expect(dropWhere({top: 0, height: 32}, 4)).toBe('before');
    expect(dropWhere({top: 0, height: 32}, 30)).toBe('after');
    expect(dropWhere({top: 0, height: 32}, 16)).toBe('inside');
    expect(dropMove(children, rows, 3, 1, 'before')).toEqual({parent: null, index: 0});
    expect(dropMove(children, rows, 1, 3, 'after')).toEqual({parent: null, index: 2});
    expect(dropMove(children, rows, 3, 2, 'inside')).toEqual({parent: 2, index: 1});
  });

  it('放在自己或自己底下不動;放在清單空白處 = 最上層最後面', () => {
    expect(dropMove(children, rows, 2, 4, 'inside')).toBeNull();
    expect(dropMove(children, rows, 2, 2, 'after')).toBeNull();
    expect(dropMove(children, rows, 4, 'root', 'after')).toEqual({parent: null, index: 3});
  });
});

// ------------------------------------------------------------------ 其他邊界情況
describe('Ctrl+Shift+↑↓ 搬的是游標那一段,不是整個容器', () => {
  it('提示框裡的段落在提示框裡面搬', () => {
    const editor = make([p('外面'), {type: 'callout', content: [p('甲'), p('乙')]}]);
    caret(editor, '乙', 0);
    shiftBlock(editor, -1);
    const callout = editor.state.doc.child(1);
    expect([callout.child(0).textContent, callout.child(1).textContent]).toEqual(['乙', '甲']);
    expect(editor.state.doc.child(0).textContent).toBe('外面');
  });

  it('游標在可收合清單的標題上:整個可收合清單一起搬', () => {
    const editor = make([
      p('上面'),
      {type: 'details', attrs: {open: true}, content: [{type: 'detailsSummary', content: [{type: 'text', text: '標題'}]}, {type: 'detailsContent', content: [p('內容')]}]},
    ]);
    caret(editor, '標題', 0);
    shiftBlock(editor, -1);
    expect(editor.state.doc.child(0).type.name).toBe('details');
    expect(editor.state.doc.child(1).textContent).toBe('上面');
  });
});

describe('@ 日期存含年份的日期', () => {
  it('存 2026-10-14、讀得回來;格式不對回 null', () => {
    expect(isoDate(new Date(2026, 9, 4))).toBe('2026-10-04');
    expect(fromIsoDate('2026-10-04')?.getDate()).toBe(4);
    expect(fromIsoDate('10/4')).toBeNull();
  });
});

describe('[[ 什麼時候出現「新增子頁」', () => {
  function withPages(titles: string[]) {
    const editor = make([p('')]);
    setHost(editor, {...DEFAULT_HOST, pages: () => titles.map((title, i) => ({id: i + 1, title, icon: null}))});
    return editor;
  }
  const labels = (items: {label: string}[]) => items.map((i) => i.label);

  it('還沒打字:只列頁面', () => {
    expect(labels(pageLinkItems('', withPages(['甲', '乙'])))).toEqual(['甲', '乙']);
  });
  it('打了字、沒有同名的頁:最後一項是「新增子頁「…」」;有同名的就不給', () => {
    expect(labels(pageLinkItems('丙', withPages(['甲'])))).toEqual(['新增子頁「丙」']);
    expect(labels(pageLinkItems('甲', withPages(['甲'])))).toEqual(['甲']);
  });
  it('一頁都沒有:給「新增子頁」,選單才不是空的', () => {
    expect(labels(pageLinkItems('', withPages([])))).toEqual(['新增子頁']);
  });
});

describe('貼上帶 HTML 的 Markdown', () => {
  it('HTML 只是上色的原始碼(VS Code、網頁上的原始碼框)= 照 Markdown 轉;有排版結構的照 HTML', () => {
    expect(htmlHasStructure('<meta charset="utf-8"><div style="color:#ccc"><span># 標題</span><br></div>')).toBe(false);
    expect(htmlHasStructure('<pre><code>- 一\n- 二</code></pre>')).toBe(false);
    expect(htmlHasStructure('<h1>標題</h1><ul><li>一</li></ul>')).toBe(true);
    expect(htmlHasStructure('<table><tr><td>1</td></tr></table>')).toBe(true);
  });
});
