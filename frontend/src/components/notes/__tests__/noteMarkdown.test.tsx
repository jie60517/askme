// @vitest-environment jsdom
/**
 * 個人筆記編輯器的 Markdown 進出。
 *
 * 筆記仍然存 Markdown:這裡守的是「讀進來再寫回去」不會改壞內容 ——
 *   - 後端存進來的三種(整題 / 反白 / 截圖,`backend/app/routers/notebook.py` 的 `_quote`、`_ref`)一字不差;
 *   - 只會被「整理」的寫法(`*` 清單、表格空白)內容不變,而且整理一次之後就穩定;
 *   - 會改壞內容的寫法,`canEditVisually` 要認得出來(那一則退回原文編輯);
 *   - 打開不改寫:沒改字不送出;改了又改回原樣,送回去的是原文。
 */
import {Editor} from '@tiptap/core';
import {act, cleanup, render} from '@testing-library/react';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import {NoteEditor} from '../NoteEditor';
import {filterSlash} from '../slashCommand';
import {canEditVisually, noteExtensions} from '../noteExtensions';

const FENCE = '```';

function roundTrip(md: string) {
  const editor = new Editor({extensions: noteExtensions(), content: md, contentType: 'markdown'});
  const out = editor.getMarkdown();
  const text = editor.state.doc.textContent;
  editor.destroy();
  return {out, text};
}

/** 讀進來再寫回去必須一字不差的 */
const EXACT: Record<string, string> = {
  // 後端 `_quote`:每行 `> 字  `(兩個空白換行),空行是 `>`
  整題: `> 訂單要怎麼改成分批出貨?  \n> 單號 SO-1024  \n>\n> 只出一部分可以嗎  \n\n可以分批出貨。在 **出貨單** 頁新增一張。`,
  反白: `> 把這次實收的數量改成實際的數字  \n\n`,
  截圖: `![](notebook-image:b607886fd8bc40e7833bbec472ead75d)\n\n`,
  程式碼: `改這裡:\n\n${FENCE}sql\nSELECT id FROM users WHERE active = 'Y';\n${FENCE}`,
  標題與字型: `# 大標\n\n## 小標\n\n一段 *斜體* 與 ~~刪除~~ 與 \`code\` 與 [連結](https://example.com)。\n\n---\n\n行尾兩空白  \n換行`,
  編號與待辦: `1. 基本設定\n2. 權限設定\n\n- [x] 完成\n- [ ] 沒完成`,
  從第三項開始: `3. 第三\n4. 第四`,
  有說明的圖: `前面\n\n![說明圖](notebook-image:b607886fd8bc40e7833bbec472ead75d)\n\n後面`,
  符號: `A &amp; B &lt;tag&gt;,完成 ✅`,
};

/** 會被整理、但內容不變的 */
const TIDIED: Record<string, string> = {
  星號清單: `* 一\n* 二\n  * 二之一`,
  表格: `| 欄位 | 說明 |\n|---|---|\n| 狀態 | 第一行<br>第二行 |`,
  對齊的表格: `| 左 | 右 |\n|:---|---:|\n| 1 | 2 |`,
  底線斜體: `這是 _底線斜體_ 與 __粗__`,
  反斜線換行: `第一行\\\n第二行`,
  自動連結: `參考 <https://example.com/a_b>`,
};

/** 會改壞內容的:這幾則要退回原文編輯 */
const LOSSY: Record<string, string> = {
  手打HTML: `上面有 <b>HTML</b>`,
  區塊HTML: `<div>區塊</div>`,
  註腳: `註腳[^1]\n\n[^1]: 說明`,
  表格裡的直線: `| 指令 | 說明 |\n|---|---|\n| a \\| b | 管線 |`,
  清單裡的程式碼: `1. 先執行\n\n   ${FENCE}bash\n   ls -la\n   ${FENCE}\n\n2. 再看結果`,
};

describe('讀進來再寫回去', () => {
  for (const [name, md] of Object.entries(EXACT)) {
    it(`一字不差:${name}`, () => {
      expect(canEditVisually(md)).toBe(true);
      expect(roundTrip(md).out).toBe(md);
    });
  }

  for (const [name, md] of Object.entries(TIDIED)) {
    it(`整理過、內容不變、而且穩定:${name}`, () => {
      expect(canEditVisually(md)).toBe(true);
      const first = roundTrip(md);
      const second = roundTrip(first.out);
      expect(second.text).toBe(first.text);
      expect(second.out).toBe(first.out);
    });
  }

  it('```chart 就是一般的程式碼區塊,讀進來寫回去不變', () => {
    const md = `${FENCE}chart\n{"type":"bar","data":[{"name":"A 廠","value":182}]}\n${FENCE}`;
    const editor = new Editor({extensions: noteExtensions(), content: md, contentType: 'markdown'});
    expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock');
    expect(editor.getMarkdown()).toBe(md);
    editor.destroy();
  });

  it('表格格子裡的 <br> 原樣留著', () => {
    expect(roundTrip(TIDIED['表格']).out).toContain('第一行<br>第二行');
  });

  for (const [name, md] of Object.entries(LOSSY)) {
    it(`會改壞的認得出來:${name}`, () => {
      expect(canEditVisually(md)).toBe(false);
    });
  }

  it('程式碼裡的 HTML、註腳寫法不算', () => {
    expect(canEditVisually(`用 \`<div>\` 包起來`)).toBe(true);
    expect(canEditVisually(`${FENCE}html\n<div>[^1]</div>\n${FENCE}`)).toBe(true);
  });
});

describe('「/」選單', () => {
  it('打字篩選:中文、英文都行', () => {
    expect(filterSlash('').length).toBe(16);
    expect(filterSlash('表').map((i) => i.label)).toEqual(['表格']);
    expect(filterSlash('h2').map((i) => i.label)).toEqual(['標題 2']);
    expect(filterSlash('todo').map((i) => i.label)).toEqual(['待辦清單']);
    expect(filterSlash('沒有這個')).toEqual([]);
  });

  it('頁面、資料庫、可收合清單、提示框都找得到', () => {
    expect(filterSlash('頁').map((i) => i.label)).toEqual(['頁面']);
    expect(filterSlash('db').map((i) => i.label)).toEqual(['資料庫']);
    expect(filterSlash('toggle').map((i) => i.label)).toEqual(['可收合清單']);
    expect(filterSlash('callout').map((i) => i.label)).toEqual(['提示框']);
  });
});

describe('Markdown 快速鍵', () => {
  /** 打一個字,走編輯器處理「打字」的那條路(輸入規則掛在那裡) */
  function type(editor: Editor, text: string) {
    for (const ch of text) {
      const {from, to} = editor.state.selection;
      const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
    }
  }
  const cases: [string, string][] = [
    ['# ', 'heading'],
    ['- ', 'bulletList'],
    ['1. ', 'orderedList'],
    ['[ ] ', 'taskList'],
    ['[] ', 'taskList'],
    // 照 Notion:「>」是可收合清單,引用改成「"」
    ['> ', 'details'],
    ['" ', 'blockquote'],
    ['``` ', 'codeBlock'],
  ];
  for (const [input, node] of cases) {
    it(`「${input.trim()}」+ 空白 → ${node}`, () => {
      const editor = new Editor({extensions: noteExtensions(), content: ''});
      editor.commands.focus('start');
      type(editor, input);
      expect(editor.state.doc.firstChild?.type.name).toBe(node);
      editor.destroy();
    });
  }
});

describe('打開不改寫', () => {
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
    const onChange = vi.fn();
    const view = render(<NoteEditor body={body} doc={null} onChange={onChange} host={{}} />);
    const editor = (view.container.querySelector('.ProseMirror') as HTMLElement & {editor: Editor}).editor;
    return {onChange, editor};
  }

  it('只是打開、點進去:不送出(即使寫回去會被整理)', () => {
    const {onChange, editor} = mount('* 一\n* 二');
    act(() => {
      editor.commands.focus('end');
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('改了字:送出新的 Markdown', () => {
    const {onChange, editor} = mount('* 一\n* 二');
    act(() => {
      editor.commands.focus('end');
      editor.commands.insertContent('三');
    });
    expect(onChange).toHaveBeenLastCalledWith({body: '- 一\n- 二三', doc: expect.stringContaining('二三')});
  });

  it('改了又改回原樣:送回去的是原文,不是整理過的版本', () => {
    const {onChange, editor} = mount('* 一\n* 二');
    act(() => {
      editor.commands.focus('end');
      editor.commands.insertContent('三');
    });
    act(() => {
      editor.commands.undo();
    });
    expect(onChange).toHaveBeenLastCalledWith({body: '* 一\n* 二', doc: null});
  });
});
