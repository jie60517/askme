/**
 * 資料表共用的兩件事:**點表頭排序**、**拖表頭右緣改欄寬**。全站的資料表都用這一支,行為一致:
 *
 * - 排序:點表頭 → 升冪 → 降冪 → 回到原本的順序。還沒排序的欄位平常不顯示箭頭,
 *   滑鼠移上去才出現;排序中的那一欄一直顯示 ↑ / ↓(樣式在 `styles/global.css` 的 `[data-sort-on-hover]`)。
 * - 欄寬:表頭平常就畫出分界線(`[data-col-resize-lines]`),拖一欄的右緣,**後面的欄位整排跟著移**
 *   (不是只跟隔壁那欄互換寬度),可以往左也可以往右。拖過的寬度記在這個瀏覽器裡。
 *   最後一欄吃剩下的寬度,右緣就是表格的邊,沒有拖把。
 *
 * 為什麼要這樣包(Astryx 欄寬外掛的三個脾氣):
 * 1. 按「比例」宣告的欄位,拖的時候是跟隔壁互換寬度;**px 宣告的才是「這欄變寬、後面往右推」** ——
 *    所以除了最後一欄,一律換成 px(沒拖過的照宣告的比例分當下的表格寬)。
 * 2. px 欄位的最小寬度被當成「它現在的寬度」,結果只能往右拉 —— 給外掛的欄位定義要換成真正的最小寬。
 * 3. 那條拖拉線的高度是整張表(`--table-resize-height`),在表頭格子上蓋回 100% 才只畫在表頭。
 *
 * 用法:
 * ```tsx
 * const table = useTableKit({storageKey: 't100_table_cols:users', columns, data: rows, comparators: {...}, notSortable: ['actions']});
 * <Stack ref={table.wrapRef} {...table.wrapProps}>
 *   <TableCard><Table data={table.data} columns={table.columns} plugins={{...table.plugins, 其他外掛}} /></TableCard>
 * </Stack>
 * ```
 * ⚠️ 要分組(`useTableGroupedRows`)的表:把 `table.data`(排好序的)再交給分組,排序就會套在每一組裡。
 */
import {useLayoutEffect, useMemo, useRef, useState} from 'react';

import {
  pixel,
  proportional,
  useTableColumnResize,
  useTableSortable,
  useTableSortableState,
  type TableColumn,
  type TablePlugin,
} from '@astryxdesign/core/Table';

type ColumnWidth = NonNullable<TableColumn<Record<string, unknown>>['width']>;

/** 沒給最小寬的欄位:最窄拖到多少(px) */
const DEFAULT_MIN_PX = 96;

export type TableKitOptions<T extends Record<string, unknown>> = {
  /**
   * 拖過的欄寬存在這個 localStorage 鍵(每張表各一把)。新表一律用 `t100_table_cols:<表名>`。
   * ⚠️ 鍵名不要改 —— 改了,使用者拖過的寬度就全部回到預設
   */
  storageKey: string;
  /** 照平常那樣宣告的欄位;`width` 是**預設**寬(px 就是那個寬、比例就是分剩下的寬) */
  columns: TableColumn<T>[];
  data: T[];
  /** 排序的比較方式,依欄位 key(一律寫升冪)。沒給的欄位照 `String(row[key])` 比 */
  comparators?: Partial<Record<string, (a: T, b: T) => number>>;
  /**
   * 這一欄「沒有值」的列(從未執行、沒有平均耗時…):**升冪降冪都排最後**。
   * 只靠比較函式做不到 —— 降冪是把比較結果整個反過來,排最後的會變成排最前。
   */
  emptyLast?: Partial<Record<string, (row: T) => boolean>>;
  /** 不能排序的欄位(按鈕欄之類)。表頭是空字串的欄位本來就不排序 */
  notSortable?: string[];
  /** false = 不能拖欄寬(手機、或欄位被換成窄版的時候);排序照樣可以用 */
  isResizable?: boolean;
  /**
   * 外掛自己加的欄佔掉多寬(px),例如勾選框那一欄(`SELECTION_COLUMN_PX`)。
   * 比例欄分的是扣掉它之後剩下的寬 —— 不扣的話每欄都多分一點,加起來比容器寬,冒出橫向捲軸
   */
  reservedPx?: number;
};

/** 設計系統勾選外掛那一欄的寬(它內部的 SELECTION_COLUMN_WIDTH,沒有匯出;升級設計系統時對一下) */
export const SELECTION_COLUMN_PX = 36;

function loadWidths(storageKey: string): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && v > 0 && v < 4000),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

/** 每一欄最窄能拖到多少:比例欄位照它的 minWidth,px 欄位是 96 與它的寬取小的那個 */
function minOf(width: ColumnWidth | undefined): number {
  if (!width) return DEFAULT_MIN_PX;
  if (width.type === 'pixel') return Math.min(width.value, DEFAULT_MIN_PX);
  return width.type === 'proportional' ? width.minWidth ?? DEFAULT_MIN_PX : DEFAULT_MIN_PX;
}

/** 拖拉那條線只畫在表頭(外掛預設畫到整張表的底) */
function headerOnlyResizeLine<T extends Record<string, unknown>>(): TablePlugin<T> {
  return {
    transformHeaderCell: (props) => ({
      ...props,
      htmlProps: {...props.htmlProps, style: {...props.htmlProps?.style, ['--table-resize-height' as string]: '100%'}},
    }),
  };
}

/**
 * 表格窄到放不下全部欄位(手機,或視窗不寬、側邊欄又開著)就切成精簡版。
 * 寬度要等 useTableKit 量到(`tableWidth`),所以精簡與否的 state 放在呼叫端(欄位要先照它建),這裡只負責同步。
 * layout effect:畫出來之前就切好,窄的容器不會先閃一格全欄。
 */
export function useCompactTableSync(setIsCompact: (v: boolean) => void, isNarrow: boolean, tableWidth: number, minPx: number) {
  useLayoutEffect(() => {
    setIsCompact(isNarrow || (tableWidth > 0 && tableWidth < minPx));
  }, [setIsCompact, isNarrow, tableWidth, minPx]);
}

export function useTableKit<T extends Record<string, unknown>>({
  storageKey,
  columns,
  data,
  comparators,
  emptyLast = {},
  notSortable = [],
  isResizable = true,
  reservedPx = 0,
}: TableKitOptions<T>) {
  // 表格能用的寬度(卡片裡面那一層)。沒拖過的欄位照宣告的比例分它
  const [tableWidth, setTableWidth] = useState(0);
  // callback ref 不是 useRef:很多頁的表格要等資料來了才畫(空的時候畫一句「沒有資料」),
  // 元件掛上來那一刻包表格的那層還不存在 —— 用 useRef 的話就永遠量不到寬度
  const [wrapEl, wrapRef] = useState<HTMLElement | null>(null);
  // layout effect:在第一次畫出來之前就量好,不然會先用最小寬畫一格、下一格才跳成正確的寬
  useLayoutEffect(() => {
    const el = wrapEl;
    if (!el) return;
    const measure = () => setTableWidth(el.querySelector('table')?.parentElement?.clientWidth ?? el.clientWidth);
    // 掛上來先量一次:ResizeObserver 的第一次回報要等下一次繪製(分頁在背景時會一直等不到)
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrapEl]);

  /*
   * 外掛拖的時候直接在每一格表頭寫死 px 寬,放開後**不清**(下一次 render 由它蓋回 React 的值)。
   * 兩個地方因此會壞,都要把 React 原本給的樣式還回去:
   * - 最後一欄沒有 px 寬可以蓋,就一直卡在拖的當下那個寬:往右拖撐出捲軸之後再往左拖,表格縮不回來。
   *   放開時還原最後一欄(onColumnResizeEnd)。
   * - 拖到一半被取消(pointercancel,觸控捲動會觸發)時外掛把**每一格**的寬都清成空的 ——
   *   React 的 props 沒變就不會補回來,整排欄寬歸零。取消時全部還原。
   * ⚠️ 不能直接清空:React 本來就有給表頭寬度,清掉那欄就變成 0 寬。
   * 按下拖把(滑鼠)或在拖把上按方向鍵(鍵盤調欄寬也走同一條)之前先記下來;capture 才搶得在外掛前面。
   */
  const thStyles = useRef<{th: HTMLElement; width: string; minWidth: string; maxWidth: string}[] | null>(null);
  const restoreThStyles = (onlyLast: boolean) => {
    const all = thStyles.current ?? [];
    thStyles.current = null;
    for (const s of onlyLast ? all.slice(-1) : all) {
      s.th.style.width = s.width;
      s.th.style.minWidth = s.minWidth;
      s.th.style.maxWidth = s.maxWidth;
    }
  };
  useLayoutEffect(() => {
    if (!wrapEl) return;
    const remember = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.('[role="separator"]')) return;
      if (e instanceof KeyboardEvent && !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      thStyles.current = [...wrapEl.querySelectorAll<HTMLElement>('thead th')].map((th) => ({
        th,
        width: th.style.width,
        minWidth: th.style.minWidth,
        maxWidth: th.style.maxWidth,
      }));
    };
    // 外掛的取消是掛在 window 上的冒泡監聽;排到它後面再還原
    const onCancel = () => {
      if (thStyles.current) setTimeout(() => restoreThStyles(false));
    };
    wrapEl.addEventListener('pointerdown', remember, true);
    wrapEl.addEventListener('keydown', remember, true);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      wrapEl.removeEventListener('pointerdown', remember, true);
      wrapEl.removeEventListener('keydown', remember, true);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [wrapEl]);

  const [saved, setSaved] = useState<Record<string, number>>(() => loadWidths(storageKey));

  const {sortedData, sort, sortConfig} = useTableSortableState<T>({data, comparators: comparators as Record<string, (a: T, b: T) => number>});
  const sortKey = sort[0]?.sortKey;
  const isEmpty = sortKey ? emptyLast[sortKey] : undefined;
  const sortedRows = useMemo(
    () => (isEmpty ? [...sortedData.filter((r) => !isEmpty(r)), ...sortedData.filter(isEmpty)] : sortedData),
    // emptyLast 是呼叫端的字面值,每次都是新物件;排好的資料與排序的欄位沒變就不用重算
    // (不然分組的表每次 render 都要重新分一次組)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedData, sortKey, !!isEmpty],
  );
  const sortable = useTableSortable<T>(sortConfig);

  const lastKey = columns[columns.length - 1]?.key;
  const mins = useMemo(
    () => Object.fromEntries(columns.map((c) => [c.key, minOf(c.width as ColumnWidth | undefined)])),
    // 欄位的 key 與寬度沒變就不用重算(很多頁的 columns 沒有 useMemo,每次 render 都是新陣列)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns.map((c) => `${c.key}:${JSON.stringify(c.width)}`).join('|')],
  );

  /**
   * 還沒拖過的欄位的預設寬:px 宣告的就是那個寬,比例宣告的分剩下的寬。
   * 分到比最小寬還窄的欄先釘在最小寬,剩下的寬再由其他欄照比例重分 —— 只把它墊到最小寬的話,
   * 多出來的那幾 px 沒有人吐回去,整張表比容器寬、冒出橫向捲軸
   */
  const defaults = useMemo(() => {
    const fixed = columns.reduce((sum, c) => sum + (c.width?.type === 'pixel' ? c.width.value : 0), 0);
    const share = (c: TableColumn<T>) => (c.width?.type === 'proportional' ? c.width.value : 1);
    const pinned = new Set<string>();
    let flex = columns.filter((c) => c.width?.type !== 'pixel');
    let free = Math.max(0, tableWidth - fixed - reservedPx);
    for (;;) {
      const shares = flex.reduce((sum, c) => sum + share(c), 0) || 1;
      const tooNarrow = flex.filter((c) => (free * share(c)) / shares < mins[c.key]);
      if (!tooNarrow.length) break;
      for (const c of tooNarrow) {
        pinned.add(c.key);
        free = Math.max(0, free - mins[c.key]);
      }
      flex = flex.filter((c) => !pinned.has(c.key));
    }
    const shares = flex.reduce((sum, c) => sum + share(c), 0) || 1;
    return Object.fromEntries(
      columns.map((c) => {
        const w = c.width?.type === 'pixel' ? c.width.value : pinned.has(c.key) ? mins[c.key] : Math.floor((free * share(c)) / shares);
        return [c.key, Math.max(mins[c.key], w)];
      }),
    );
  }, [columns, tableWidth, mins, reservedPx]);

  // 存下來的寬度不能比最小寬窄(最小寬改過之後,舊的值可能就不合了)
  const widthOf = (key: string) => (saved[key] != null ? Math.max(mins[key], saved[key]) : defaults[key]);

  const out = useMemo<TableColumn<T>[]>(
    () =>
      columns.map((c) => {
        const isSortable = !notSortable.includes(c.key) && typeof c.header === 'string' && c.header !== '';
        const base = {...c, sortable: isSortable || undefined};
        if (!isResizable) return base;
        // 最後一欄吃剩下的寬度(它的右緣就是表格的邊,不放拖把);其他一律 px(見檔頭第 1 點)
        return c.key === lastKey
          ? {...base, width: proportional(1, {minWidth: c.width?.type === 'pixel' ? c.width.value : mins[c.key]})}
          : {...base, width: pixel(widthOf(c.key))};
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, isResizable, saved, defaults, lastKey, mins, notSortable.join('|')],
  );

  // 給外掛的欄位定義:寬度換成每欄的最小寬(外掛拿它算最窄能拖到多少、這欄是 px 還是比例,見檔頭第 2 點)
  const resizeColumns = useMemo(
    () => out.map((c) => (c.key === lastKey ? c : {...c, width: pixel(mins[c.key])})),
    [out, lastKey, mins],
  );
  const columnResize = useTableColumnResize<T>({
    columnWidths: Object.fromEntries(columns.filter((c) => c.key !== lastKey).map((c) => [c.key, widthOf(c.key)])),
    // 型別轉一下:hook 的簽名只收 Record<string, unknown> 的欄位定義
    columns: resizeColumns as TableColumn<Record<string, unknown>>[],
    onColumnResizeEnd: (updates) => {
      restoreThStyles(true); // 最後一欄還原成 React 給的樣式(見上面 thStyles 那段)
      const next = {...saved};
      for (const [k, w] of Object.entries(updates)) if (k !== lastKey) next[k] = Math.round(w);
      setSaved(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* 記不住只是下次要再拖一次 */
      }
    },
  });
  const headerLine = useMemo(() => headerOnlyResizeLine<T>(), []);

  const plugins: Record<string, TablePlugin<T>> = isResizable ? {sortable, columnResize, headerLine} : {sortable};
  return {
    data: sortedRows,
    columns: out,
    plugins,
    wrapRef,
    /** 放在包表格的那一層:排序箭頭平常不顯示、表頭畫分界線(規則在 styles/global.css) */
    wrapProps: {'data-sort-on-hover': '', 'data-col-resize-lines': ''} as const,
    /** 表格能用的寬度(量到之前是 0)。要自己決定「放不下就換窄版」的表用得到 */
    tableWidth,
  };
}
