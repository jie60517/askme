// @vitest-environment jsdom
/**
 * 筆記的純邏輯:資料庫的篩選 / 排序 / 顯示字、頁面樹的順序、內建模板、
 * 新節點的 Markdown(搜尋與摘要靠它)、區塊拖曳搬動。
 */
import {Editor} from '@tiptap/core';
import {describe, expect, it} from 'vitest';

import type {NoteSummary} from '../../../lib/notebookApi';
import {moveBlock} from '../BlockHandle';
import {cellText, emptyDatabase, parseDatabase, visibleRows, type Column, type DatabaseData} from '../databaseModel';
import {databaseToMarkdown, noteExtensions} from '../noteExtensions';
import {childrenMap} from '../NoteTree';
import {formatIcon, iconOf, parseIcon} from '../pageIcons';
import {BUILTIN_TEMPLATES, renderTemplate} from '../templates';

function sampleDb(): DatabaseData {
  const status: Column = {
    id: 's',
    name: '狀態',
    type: 'select',
    options: [
      {id: 'todo', name: '未開始', color: 'gray'},
      {id: 'doing', name: '進行中', color: 'blue'},
      {id: 'done', name: '完成', color: 'green'},
    ],
  };
  return {
    title: '工作',
    columns: [{id: 't', name: '名稱', type: 'title'}, status, {id: 'n', name: '工時', type: 'number'}, {id: 'c', name: '確認', type: 'checkbox'}],
    rows: [
      {id: 'a', cells: {t: '據點', s: 'done', n: 3, c: true}},
      {id: 'b', cells: {t: '稅別', s: 'todo', n: 10}},
      {id: 'c', cells: {t: '單別', s: 'doing', n: 1}},
    ],
    views: [{id: 'v', name: '表格', type: 'table'}],
    activeView: 'v',
  };
}

describe('資料庫', () => {
  it('壞掉的資料退回一個空的資料庫,不是整頁炸掉', () => {
    const db = parseDatabase('not json');
    expect(db.columns.map((c) => c.type)).toEqual(['title', 'select']);
    expect(db.views.map((v) => v.type)).toEqual(['table', 'board']);
    expect(parseDatabase(JSON.stringify(emptyDatabase())).rows).toHaveLength(3);
  });

  it('顯示字:選項顯示名稱、勾選顯示 ✓、空的是空字串', () => {
    const db = sampleDb();
    expect(cellText(db.columns[1], 'doing')).toBe('進行中');
    expect(cellText(db.columns[3], true)).toBe('✓');
    expect(cellText(db.columns[3], null)).toBe('');
  });

  it('排序:數字照大小、選項照選項的順序;篩選可以疊', () => {
    const db = sampleDb();
    const ids = (view: DatabaseData['views'][number]) => visibleRows(db, view).map((r) => r.id);
    expect(ids({id: 'x', name: '', type: 'table', sort: {column: 'n', dir: 'desc'}})).toEqual(['b', 'a', 'c']);
    expect(ids({id: 'x', name: '', type: 'table', sort: {column: 's', dir: 'asc'}})).toEqual(['b', 'c', 'a']);
    expect(ids({id: 'x', name: '', type: 'table', filters: [{column: 's', op: 'equals', value: 'todo'}]})).toEqual(['b']);
    expect(ids({id: 'x', name: '', type: 'table', filters: [{column: 'c', op: 'unchecked'}, {column: 't', op: 'contains', value: '別'}]})).toEqual(['b', 'c']);
  });

  it('轉成 Markdown 表格給搜尋與摘要用', () => {
    const md = databaseToMarkdown(JSON.stringify(sampleDb()));
    expect(md).toContain('**工作**');
    expect(md).toContain('| 名稱 | 狀態 | 工時 | 確認 |');
    expect(md).toContain('| 據點 | 完成 | 3 | ✓ |');
  });
});

describe('頁面樹', () => {
  const row = (id: number, parent: number | null, position: number): NoteSummary => ({
    id,
    title: `p${id}`,
    summary: '',
    source_kind: null,
    has_image: false,
    updated_at: '',
    parent_id: parent,
    position,
    icon: null,
  });

  it('每一層照 position 排;上一層不在清單裡(分享給我的子頁、上一層被刪)當成最上層', () => {
    const map = childrenMap([row(1, null, 2), row(2, null, 1), row(3, 1, 1), row(4, 1, 0), row(5, 99, 0)]);
    expect(map.get(null)?.map((r) => r.id)).toEqual([5, 2, 1]);
    expect(map.get(1)?.map((r) => r.id)).toEqual([4, 3]);
  });
});

describe('內建模板', () => {
  it('每一個都轉得出 doc 與 Markdown;問題追蹤帶一個資料庫', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const {doc, body} = renderTemplate(t);
      expect(JSON.parse(doc).type).toBe('doc');
      expect(body.length).toBeGreaterThan(0);
    }
    const issues = renderTemplate(BUILTIN_TEMPLATES.find((t) => t.key === 'issues')!);
    expect(JSON.parse(issues.doc).content.some((n: {type: string}) => n.type === 'database')).toBe(true);
    expect(issues.body).toContain('| 問題 | 狀態 | 優先 | 負責人 | 期限 |');
  });
});

describe('頁面圖示與顏色記號(顏色用主側欄那組 key)', () => {
  it('存成「名字:顏色 key」;只有名字、emoji、不認得的顏色都照樣讀得懂', () => {
    expect(formatIcon('Star', 'blue-soft')).toBe('Star:blue-soft');
    expect(formatIcon('Star', null)).toBe('Star');
    expect(formatIcon(null, null)).toBeNull();
    // 只選了顏色:清單上畫點,頁面裡不畫大圖示(不能被寫成 FileText、多出一個大圖示)
    expect(formatIcon(null, 'blue-soft')).toBe(':blue-soft');
    expect(parseIcon(':blue-soft')).toEqual({name: null, color: 'blue-soft'});
    expect(iconOf(':blue-soft')).toBeNull();
    // 調色盤的自訂色碼也存得下
    expect(parseIcon('Truck:#12ab34')).toEqual({name: 'Truck', color: '#12ab34'});
    expect(parseIcon('Truck')).toEqual({name: 'Truck', color: null});
    expect(parseIcon('Truck:nope')).toEqual({name: 'Truck', color: null});
    // 色碼要完整:主側欄的 hasColor 只看開頭是不是 #,筆記這邊再擋一層
    expect(parseIcon('Truck:#zz')).toEqual({name: 'Truck', color: null});
    expect(iconOf('Truck:red-soft')).not.toBeNull();
    expect(iconOf('📒')).toBeNull();
  });

  it('10-14 那版存的文字色票名字:紅藍黃綠橘紫粉剛好是主側欄深色那一階的 key,照舊有效;灰色當作沒選', () => {
    for (const c of ['red', 'blue', 'yellow', 'green', 'orange', 'purple', 'pink']) {
      expect(parseIcon(`Truck:${c}`).color).toBe(c);
    }
    expect(parseIcon('Truck:gray').color).toBeNull();
  });

  it('最長的名字帶最長的顏色 key(或色碼)也在後端上限(32)以內', () => {
    expect(formatIcon('CircleDollarSign', 'yellow-soft')!.length).toBeLessThanOrEqual(32);
    expect(formatIcon('CircleDollarSign', '#abcdef')!.length).toBeLessThanOrEqual(32);
  });
});

describe('區塊把手拖曳搬動(moveBlock)', () => {
  const make = (content: object[]) => new Editor({extensions: noteExtensions(), content: {type: 'doc', content}});
  const p = (t: string) => ({type: 'paragraph', content: [{type: 'text', text: t}]});
  const li = (t: string) => ({type: 'listItem', content: [p(t)]});
  const texts = (ed: Editor) => {
    const out: string[] = [];
    ed.state.doc.forEach((n) => out.push(`${n.type.name}:${n.textContent}`));
    // 最後一塊不是段落時編輯器自己補一行空段落(trailingNode),不是搬出來的
    if (out[out.length - 1] === 'paragraph:') out.pop();
    return out;
  };
  const posOf = (ed: Editor, index: number) => {
    let pos = 0;
    ed.state.doc.forEach((_n, offset, i) => {
      if (i === index) pos = offset;
    });
    return pos;
  };

  it('段落往上搬到第一塊前面(往上拉也行,只看落在哪一塊)', () => {
    const ed = make([p('一'), p('二'), p('三')]);
    expect(moveBlock(ed, posOf(ed, 2), {pos: posOf(ed, 0), after: false})).toBe(true);
    expect(texts(ed)).toEqual(['paragraph:三', 'paragraph:一', 'paragraph:二']);
    ed.destroy();
  });

  it('清單項目拖出清單:包一層原本的清單;清單只剩它一項時整個清單一起拿走', () => {
    const ed = make([p('前'), {type: 'bulletList', content: [li('甲')]}, p('後')]);
    expect(moveBlock(ed, posOf(ed, 1) + 1, {pos: posOf(ed, 2), after: true})).toBe(true);
    expect(texts(ed)).toEqual(['paragraph:前', 'paragraph:後', 'bulletList:甲']);
    ed.destroy();
  });

  it('段落拖到清單項目旁邊:放在整個清單的前面 / 後面', () => {
    const ed = make([{type: 'bulletList', content: [li('甲'), li('乙')]}, p('段落')]);
    expect(moveBlock(ed, posOf(ed, 1), {pos: 1, after: false})).toBe(true);
    expect(texts(ed)).toEqual(['paragraph:段落', 'bulletList:甲乙']);
    ed.destroy();
  });

  it('放在自己身上不動', () => {
    const ed = make([p('一'), p('二')]);
    expect(moveBlock(ed, posOf(ed, 1), {pos: posOf(ed, 1), after: true})).toBe(false);
    expect(texts(ed)).toEqual(['paragraph:一', 'paragraph:二']);
    ed.destroy();
  });
});
