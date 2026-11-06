/**
 * Word / 簡報 / Excel 「看起來跟真的一樣」的預覽。
 *
 * 純文字預覽看不出版面;這裡讓這三種看起來跟原檔一樣:
 * - `DocumentPreview`:Word / 簡報由後端轉成 PDF(LibreOffice),放進跟 .pdf 同一個 PDF 框。
 * - `SheetPreview`:Excel 讀出每張工作表的值,畫成表格(轉 PDF 會被切成一頁頁 A4、沒有格線)。
 *
 * **轉不了一律退回 `fallback`**(呼叫端給的純文字預覽):主機沒裝轉檔程式回 503、
 * 這份轉不出來回 415、登入過期回 401 —— 三種都交給純文字那條,它自己會講清楚是哪一種。
 *
 * ⚠️ 跟 `FileLightbox` 分開放:那個檔已經很大,而這兩支的 PDF 框與純文字都由呼叫端傳進來,
 * 兩邊不互相 import(燈箱與右側面板共用 `Preview`,所以這裡也跟著被兩邊共用)。
 */
import {useEffect, useState, type ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Center} from '@astryxdesign/core/Center';
import {VStack} from '@astryxdesign/core/Layout';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {Table, proportional, type TableColumn, type TablePlugin} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';

import {LoadingScreen} from './LoadingScreen';
import type {LightboxItem} from '../lib/lightboxItem';

const styles = stylex.create({
  /**
   * 撐滿預覽區(燈箱的 stage 是固定高、右側面板是整欄):分頁列 + 表格 + 截斷提示。
   * 這一層**不捲**,捲動交給表格自己那一層(見 `tableScroll`)。
   */
  sheet: {
    flexGrow: 1,
    minHeight: 0,
    height: '100%',
    overflow: 'hidden',
    // 表格的 containerBleed 歸零在 global.css 的 [data-sheet-preview](xstyle 不收 --* 自訂屬性)
  },
  /**
   * 表格自己的捲動層(`Table` 包在 `<table>` 外面那個 div)撐滿剩下的高度,**上下左右都由它捲**。
   * 不這樣的話:它只負責左右,上下是外層在捲 —— 橫向捲軸在整張表的最底下,要先捲到底才找得到,
   * 而且右側面板會多出第二條直捲軸。
   * ⚠️ 不要改成「外層包一層 width: max-content」:那會把右側面板整欄撐寬,聊天欄被擠成一條(試過)。
   */
  tableScroll: {
    flexGrow: 1,
    minHeight: 0,
    overflow: 'auto',
  },
});

/** 把上面那個樣式掛到 `Table` 的捲動層上(它只開放用 plugin 改那一層) */
const fillScroll: TablePlugin<SheetRow> = {
  transformScrollWrapper: (props) => ({...props, xstyle: [...props.xstyle, styles.tableScroll]}),
};

/**
 * Word / 簡報。先問一次轉好了沒(第一次要轉 2 秒左右,這段放風),好了才把網址交給 PDF 框。
 *
 * 為什麼不直接把轉檔網址塞進 iframe:轉不了時 iframe 裡只會是一段 JSON 錯誤,
 * 而 iframe 看不到狀態碼,沒辦法退回純文字。先問的那一次只讀標頭就停(`body.cancel()`),
 * iframe 再拿的時候後端已經有快取,馬上給。
 */
export function DocumentPreview({
  item,
  frame,
  fallback,
}: {
  item: LightboxItem;
  /** 呼叫端的 PDF 框(同一個 iframe,不要在這裡另刻一份) */
  frame: (src: string) => ReactNode;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'fallback'>('loading');

  useEffect(() => {
    if (!item.convertUrl) {
      setState('fallback');
      return;
    }
    // 換到下一份就取消這一份的請求:燈箱快速翻十份簡報,後端不要每一份都排隊轉
    const abort = new AbortController();
    setState('loading');
    fetch(item.convertUrl, {signal: abort.signal})
      .then((res) => {
        void res.body?.cancel();
        if (!abort.signal.aborted) setState(res.ok ? 'ready' : 'fallback');
      })
      .catch(() => {
        if (!abort.signal.aborted) setState('fallback');
      });
    return () => abort.abort();
  }, [item.convertUrl]);

  if (state === 'loading') return <LoadingScreen isCompact />;
  if (state === 'fallback' || !item.convertUrl) return <>{fallback}</>;
  // 不要 Chrome 左邊的縮圖欄、寬度貼齊面板(右側面板只有 45% 寬,縮圖欄會吃掉一半)
  return <>{frame(`${item.convertUrl}#navpanes=0&view=FitH`)}</>;
}

type Cell = string | number;
type Sheet = {name: string; rows: Cell[][]; truncated: boolean};
type SheetRow = Record<string, Cell>;

/** 一欄最寬那格的寬度(px):英數字 8、中文 15,加左右內距。給欄寬下限,欄位多就左右捲、不截字 */
function columnMin(values: Cell[]): number {
  const width = (v: Cell) =>
    [...(typeof v === 'number' ? v.toLocaleString() : v)].reduce(
      (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 15 : 8),
      0,
    );
  return Math.min(480, Math.max(48, ...values.map(width)) + 24);
}

function SheetTable({sheet}: {sheet: Sheet}) {
  const [head = [], ...body] = sheet.rows;
  const columns: TableColumn<SheetRow>[] = head.map((h, ci) => ({
    key: `c${ci}`,
    header: String(h),
    width: proportional(1, {minWidth: columnMin([h, ...body.map((r) => r[ci] ?? '')])}),
    // 數字靠右對齊(看第一個有值的格子)
    align: typeof body.find((r) => r[ci] !== '')?.[ci] === 'number' ? 'end' : 'start',
    renderCell: (row: SheetRow) => {
      const v = row[`c${ci}`];
      return typeof v === 'number' ? v.toLocaleString() : (v ?? '');
    },
  }));
  const data: SheetRow[] = body.map((r, ri) => ({
    id: String(ri),
    ...Object.fromEntries(r.map((c, ci) => [`c${ci}`, c])),
  }));
  return (
    <Table<SheetRow>
      dividers="rows"
      density="compact"
      idKey="id"
      data={data}
      columns={columns}
      plugins={{fillScroll}}
    />
  );
}

/** Excel:一張工作表一個分頁,第一列當表頭。 */
export function SheetPreview({item, fallback}: {item: LightboxItem; fallback: ReactNode}) {
  const [state, setState] = useState<
    {status: 'loading'} | {status: 'ready'; sheets: Sheet[]; maxRows: number; maxCols: number} | {status: 'fallback'}
  >({status: 'loading'});
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!item.convertUrl) {
      setState({status: 'fallback'});
      return;
    }
    const abort = new AbortController();
    setState({status: 'loading'});
    setActive(0);
    fetch(item.convertUrl, {signal: abort.signal})
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {sheets: Sheet[]; max_rows: number; max_cols?: number};
        if (!abort.signal.aborted) setState({status: 'ready', sheets: body.sheets, maxRows: body.max_rows, maxCols: body.max_cols ?? 0});
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({status: 'fallback'});
      });
    return () => abort.abort();
  }, [item.convertUrl]);

  if (state.status === 'loading') return <LoadingScreen isCompact />;
  if (state.status === 'fallback' || state.sheets.length === 0) return <>{fallback}</>;

  const sheet = state.sheets[Math.min(active, state.sheets.length - 1)];
  return (
    // 分頁列與截斷提示在捲動層外面:捲表格時它們留在原地
    <VStack width="100%" xstyle={styles.sheet} {...{'data-sheet-preview': ''}}>
      {state.sheets.length > 1 ? (
        <TabList value={String(active)} onChange={(v) => setActive(Number(v))} size="sm" hasDivider>
          {state.sheets.map((s, i) => (
            <Tab key={i} value={String(i)} label={s.name} />
          ))}
        </TabList>
      ) : null}
      {sheet.rows.length === 0 ? (
        <Center>
          <Text type="supporting" color="secondary">
            This sheet is empty.
          </Text>
        </Center>
      ) : (
        <SheetTable key={active} sheet={sheet} />
      )}
      {sheet.truncated ? (
        <Text type="supporting" color="secondary">
          Only the first {state.maxRows.toLocaleString()} rows{state.maxCols ? ` and ${state.maxCols} columns` : ''} are shown.
        </Text>
      ) : null}
    </VStack>
  );
}
