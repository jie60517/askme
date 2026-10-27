/**
 * 筆記裡的資料庫的資料長相與純函式。整個資料庫存在 `database` 節點的 data 屬性(JSON 文字),
 * 跟著筆記的 doc 一起存 —— 所以沒有自己的 API,復原 / 重做也照筆記那一套。
 *
 * 欄位類型照 Notion 常用的那幾種;檢視有表格與看板,各自記排序、篩選、看板依哪一欄分組。
 * 「每一列點開是一頁」:列上記 pageId(第一次點開時才建那一頁,放在這則筆記底下)。
 */
export type ColumnType = 'title' | 'text' | 'number' | 'select' | 'multi' | 'date' | 'checkbox' | 'person';

export type SelectOption = {id: string; name: string; color: string};

export type Column = {id: string; name: string; type: ColumnType; options?: SelectOption[]};

export type CellValue = string | number | boolean | string[] | null;

export type Row = {id: string; cells: Record<string, CellValue>; pageId?: number | null};

export type FilterOp = 'contains' | 'equals' | 'not-empty' | 'empty' | 'checked' | 'unchecked';

export type Filter = {column: string; op: FilterOp; value?: string};

export type View = {
  id: string;
  name: string;
  type: 'table' | 'board';
  sort?: {column: string; dir: 'asc' | 'desc'} | null;
  filters?: Filter[];
  /** 看板依哪一欄(單選)分組 */
  groupBy?: string | null;
};

export type DatabaseData = {title: string; columns: Column[]; rows: Row[]; views: View[]; activeView: string};

/** 選項的顏色:Astryx 的色票(文字 / 底色成對),深色模式跟著換 */
export const OPTION_COLORS = ['gray', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  title: '標題',
  text: '文字',
  number: '數字',
  select: '選項',
  multi: '多選',
  date: '日期',
  checkbox: '勾選',
  person: '人員',
};

let seq = 0;
/** 欄 / 列 / 選項 / 檢視的 id:只要在這個資料庫裡不重複就好 */
export function newId(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyDatabase(): DatabaseData {
  const status: Column = {
    id: newId('c'),
    name: '狀態',
    type: 'select',
    options: [
      {id: newId('o'), name: '未開始', color: 'gray'},
      {id: newId('o'), name: '進行中', color: 'blue'},
      {id: newId('o'), name: '完成', color: 'green'},
    ],
  };
  const title: Column = {id: newId('c'), name: '名稱', type: 'title'};
  const table: View = {id: newId('v'), name: '表格', type: 'table'};
  return {
    title: '',
    columns: [title, status],
    rows: [0, 1, 2].map(() => ({id: newId('r'), cells: {}})),
    views: [table, {id: newId('v'), name: '看板', type: 'board', groupBy: status.id}],
    activeView: table.id,
  };
}

export function parseDatabase(data: string): DatabaseData {
  try {
    const d = JSON.parse(data) as DatabaseData;
    if (!Array.isArray(d.columns) || !Array.isArray(d.rows) || !Array.isArray(d.views) || !d.views.length) throw new Error('bad');
    return d;
  } catch {
    return emptyDatabase();
  }
}

/** 一格要怎麼顯示成字(搜尋、排序、篩選共用) */
export function cellText(col: Column, value: CellValue): string {
  if (value == null) return '';
  if (col.type === 'select') return col.options?.find((o) => o.id === value)?.name ?? '';
  if (col.type === 'multi') return (Array.isArray(value) ? value : []).map((v) => col.options?.find((o) => o.id === v)?.name ?? '').filter(Boolean).join(', ');
  if (col.type === 'checkbox') return value ? '✓' : '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function compare(col: Column, a: CellValue, b: CellValue): number {
  if (col.type === 'number') return (Number(a ?? Number.NEGATIVE_INFINITY) || 0) - (Number(b ?? Number.NEGATIVE_INFINITY) || 0);
  if (col.type === 'checkbox') return Number(!!a) - Number(!!b);
  if (col.type === 'select') {
    const order = col.options?.map((o) => o.id) ?? [];
    return order.indexOf(String(a ?? '')) - order.indexOf(String(b ?? ''));
  }
  return cellText(col, a).localeCompare(cellText(col, b), 'zh-Hant');
}

export function matches(col: Column, f: Filter, value: CellValue): boolean {
  const text = cellText(col, value);
  switch (f.op) {
    case 'contains':
      return text.toLowerCase().includes((f.value ?? '').toLowerCase());
    case 'equals':
      return col.type === 'select' || col.type === 'multi'
        ? (Array.isArray(value) ? value : [value]).includes(f.value ?? '')
        : text === (f.value ?? '');
    case 'empty':
      return text === '';
    case 'not-empty':
      return text !== '';
    case 'checked':
      return !!value;
    case 'unchecked':
      return !value;
  }
}

/** 這個檢視要顯示哪些列、什麼順序 */
export function visibleRows(db: DatabaseData, view: View): Row[] {
  const byId = new Map(db.columns.map((c) => [c.id, c]));
  let rows = db.rows.filter((r) =>
    (view.filters ?? []).every((f) => {
      const col = byId.get(f.column);
      return !col || matches(col, f, r.cells[f.column] ?? null);
    }),
  );
  const sort = view.sort;
  const col = sort ? byId.get(sort.column) : undefined;
  if (sort && col) {
    rows = [...rows].sort((a, b) => compare(col, a.cells[col.id] ?? null, b.cells[col.id] ?? null) * (sort.dir === 'asc' ? 1 : -1));
  }
  return rows;
}
