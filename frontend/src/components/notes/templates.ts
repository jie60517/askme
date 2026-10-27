/**
 * 內建模板:空白頁下面那一排「從模板開始」。
 * 套用 = 把這一頁的標題、圖示、內容換成模板的(跟 Notion 一樣是套在這一頁上,不是另開一頁)。
 *
 * 內容用 Markdown 寫(好讀好改),套用時用不掛畫面的編輯器轉成 doc —— 存檔一樣是 doc + Markdown 兩份。
 * 「問題追蹤」要一個資料庫,Markdown 寫不出來,轉完再接上去。
 */
import {Editor, type JSONContent} from '@tiptap/core';

import {newId, type DatabaseData} from './databaseModel';
import {noteExtensions} from './noteExtensions';

export type BuiltinTemplate = {key: string; label: string; /** 線條圖示的名字(pageIcons.tsx) */ icon: string; title: string; markdown: string; extra?: () => JSONContent[]};

function issueTracker(): DatabaseData {
  const status = {
    id: newId('c'),
    name: '狀態',
    type: 'select' as const,
    options: [
      {id: newId('o'), name: '待處理', color: 'gray'},
      {id: newId('o'), name: '處理中', color: 'blue'},
      {id: newId('o'), name: '等客戶', color: 'yellow'},
      {id: newId('o'), name: '已解決', color: 'green'},
    ],
  };
  const priority = {
    id: newId('c'),
    name: '優先',
    type: 'select' as const,
    options: [
      {id: newId('o'), name: '高', color: 'red'},
      {id: newId('o'), name: '中', color: 'orange'},
      {id: newId('o'), name: '低', color: 'gray'},
    ],
  };
  const title = {id: newId('c'), name: '問題', type: 'title' as const};
  const owner = {id: newId('c'), name: '負責人', type: 'person' as const};
  const due = {id: newId('c'), name: '期限', type: 'date' as const};
  const table = {id: newId('v'), name: '表格', type: 'table' as const};
  return {
    title: '問題清單',
    columns: [title, status, priority, owner, due],
    rows: [{id: newId('r'), cells: {[status.id]: status.options[0].id, [priority.id]: priority.options[1].id}}],
    views: [table, {id: newId('v'), name: '看板', type: 'board', groupBy: status.id}],
    activeView: table.id,
  };
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'meeting',
    label: '會議紀錄',
    icon: 'CalendarDays',
    title: '會議紀錄',
    markdown: `## 基本資訊

- 日期:
- 參加:
- 地點:

## 議程

1.

## 討論

## 決議

## 待辦

- [ ] `,
  },
  {
    key: 'todo',
    label: '待辦清單',
    icon: 'ListChecks',
    title: '待辦清單',
    markdown: `## 今天

- [ ]

## 這週

- [ ]

## 之後

- [ ] `,
  },
  {
    key: 'issues',
    label: '問題追蹤',
    icon: 'Bug',
    title: '問題追蹤',
    markdown: `每個問題一列,點開成一頁寫細節。`,
    extra: () => [{type: 'database', attrs: {data: JSON.stringify(issueTracker())}}, {type: 'paragraph'}],
  },
];

/** 模板轉成這一頁要存的那兩份(doc + Markdown) */
export function renderTemplate(t: BuiltinTemplate): {doc: string; body: string} {
  const editor = new Editor({extensions: noteExtensions(), content: t.markdown, contentType: 'markdown'});
  if (t.extra) editor.commands.insertContentAt(editor.state.doc.content.size, t.extra());
  const out = {doc: JSON.stringify(editor.getJSON()), body: editor.getMarkdown().trimEnd()};
  editor.destroy();
  return out;
}
