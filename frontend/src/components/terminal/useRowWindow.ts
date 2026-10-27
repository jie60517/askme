/**
 * 檔案欄只畫**看得到的那一段**列(虛擬捲動)。
 *
 * 為什麼要有它:一列約 30 個 DOM,整份清單全部畫出來的話,幾千個檔的資料夾光是瀏覽器排版
 * 幾萬個節點就會卡死整頁(每格量寬度的問題另外處理,見 FilePanel 的 `oneLine`)。
 * 只畫看得到的幾十列,沒畫的用空白撐出高度(`drawPlan`),捲軸長度跟全部畫出來一樣。
 * 看得到的那段以外,呼叫端指名要留的列(焦點、anchor)也照畫,中間再多一塊空白隔開。
 *
 * 前提:**每一列一樣高**(單行、同一個字級;選到只是變粗)。列高不是寫死的,是量第一列來的。
 */
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';

/** 看得到的範圍上下各多畫幾列:捲快一點時不會先看到空白,方向鍵往下一列時那一列也一定已經在 */
export const OVERSCAN_ROWS = 20;
/** 還量不到捲動框多高的時候(第一次畫、jsdom)先畫幾列 */
export const FALLBACK_ROWS = 200;
/** 還沒量到列高時先用的估計值(px);第一列畫出來之後就換成量到的 */
export const FALLBACK_ROW_PX = 28;

export type RowRange = {start: number; end: number};
/** 見 `drawPlan` */
export type DrawPlan = {top: number; rows: {index: number; gapBefore: number}[]; bottom: number};

/**
 * 要畫哪幾列(`start` 含、`end` 不含)。純函式。
 *
 * @param scrolledPast 列的區塊頂端已經捲過捲動框頂端多少 px(還沒捲到就是負的)
 * @param viewport 捲動框看得到的高度;0 表示還量不到
 */
export function rowWindow(scrolledPast: number, viewport: number, rowPx: number, count: number): RowRange {
  if (count <= 0) return {start: 0, end: 0};
  if (viewport <= 0 || rowPx <= 0) return {start: 0, end: Math.min(count, FALLBACK_ROWS)};
  const first = Math.floor(Math.max(0, scrolledPast) / rowPx);
  const last = Math.ceil(Math.max(0, scrolledPast + viewport) / rowPx);
  const start = Math.min(count, Math.max(0, first - OVERSCAN_ROWS));
  const end = Math.min(count, Math.max(start, last + OVERSCAN_ROWS));
  return {start, end};
}

/**
 * 實際要怎麼畫:哪幾列、每一列前面空幾列的高度、最上面與最下面各空幾列。單位都是「列」,乘上列高才是 px。
 *
 * - `top`:第一列之前要空幾列。**一定要畫**(0 也畫):`useRowWindow` 量它的頂端當作列的區塊從哪裡開始。
 * - `rows[i].gapBefore`:這一列跟上一列之間空幾列(第一列永遠是 0,前面那段算在 `top`)。
 * - `bottom`:最後一列之後還有幾列。
 * 三種空白加上畫出來的列,總數永遠等於 `count` —— 捲軸長度才會跟全部畫出來一樣。
 *
 * @param keep 範圍外也要畫的列(焦點、anchor)。超出 `count` 的、重複的自動略過。
 */
export function drawPlan(range: RowRange, count: number, keep: readonly number[]): DrawPlan {
  const start = Math.min(range.start, count);
  const end = Math.min(Math.max(range.end, start), count);
  const indexes = new Set<number>();
  for (const k of keep) if (Number.isInteger(k) && k >= 0 && k < count && (k < start || k >= end)) indexes.add(k);
  const sorted = [...indexes, ...Array.from({length: end - start}, (_, i) => start + i)].sort((a, b) => a - b);
  const rows = sorted.map((index, i) => ({index, gapBefore: i === 0 ? 0 : index - sorted[i - 1] - 1}));
  return {
    top: sorted[0] ?? 0,
    rows,
    bottom: sorted.length ? count - 1 - sorted[sorted.length - 1] : count,
  };
}

/**
 * `scrollerRef` 掛在會捲的那一層,`topSpacerRef` 掛在 `plan.top` 那塊空白上(它的頂端就是列的區塊頂端,
 * 上面不管疊了表頭、「回上一層」還是上傳進度,量它就對)。
 * `items` 換了(換目錄、重排、重列)就重算;`keep` 是範圍外也要畫的列(見 `drawPlan`)。
 */
export function useRowWindow(items: readonly unknown[], keep: readonly number[]) {
  const count = items.length;
  const scrollerRef = useRef<HTMLElement>(null);
  const topSpacerRef = useRef<HTMLElement>(null);
  const [rowPx, setRowPx] = useState(FALLBACK_ROW_PX);
  const [range, setRange] = useState<RowRange>(() => rowWindow(0, 0, FALLBACK_ROW_PX, count));
  const rowPxRef = useRef(rowPx);
  rowPxRef.current = rowPx;
  const countRef = useRef(count);
  countRef.current = count;
  /** 換了一份清單就要重量列高 —— 但要等**第一列真的畫出來**那一次 commit 才量得到(第一趟常常一列都還沒有) */
  const measuredFor = useRef<readonly unknown[] | null>(null);

  const recompute = useCallback(() => {
    const scroller = scrollerRef.current;
    const spacer = topSpacerRef.current;
    if (!scroller || !spacer) return;
    const scrolledPast = scroller.getBoundingClientRect().top - spacer.getBoundingClientRect().top;
    const next = rowWindow(scrolledPast, scroller.clientHeight, rowPxRef.current, countRef.current);
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  // 列高:每次 commit 都看一眼,但只有「這份清單還沒量過、而且第一列已經畫出來」才真的量 —— 平常只是一個比較。
  // ⚠️ 不用 `offsetHeight`:它取整數,列高若是 28.4px,2 萬列累積差 8000px,捲到底那一段會畫錯位置。
  // 用 `getBoundingClientRect` 拿小數,再除掉祖先 transform 的縮放(換頁過場會縮放整頁),兩個問題一起避開。
  useLayoutEffect(() => {
    if (measuredFor.current === items) return;
    const first = topSpacerRef.current?.nextElementSibling;
    const scroller = scrollerRef.current;
    if (!(first instanceof HTMLElement) || first.getAttribute('role') !== 'option' || !scroller) return;
    measuredFor.current = items;
    const shown = scroller.getBoundingClientRect().height;
    const scale = shown > 0 && scroller.offsetHeight > 0 ? scroller.offsetHeight / shown : 1;
    const h = first.getBoundingClientRect().height * scale;
    if (h > 0 && Math.abs(h - rowPxRef.current) > 0.01) {
      rowPxRef.current = h;
      setRowPx(h);
    }
  });

  // 換了清單、量到新的列高:重算要畫哪一段
  useLayoutEffect(() => {
    recompute();
  }, [items, rowPx, recompute]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    scroller.addEventListener('scroll', onScroll, {passive: true});
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => recompute());
    resize?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      resize?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [recompute]);

  /** 把第 `index` 列捲到看得到的地方(畫面中間),而且這一趟 render 就把它畫出來 —— 方向鍵跳到還沒畫的列時用 */
  const revealIndex = useCallback((index: number) => {
    const scroller = scrollerRef.current;
    const spacer = topSpacerRef.current;
    if (!scroller || !spacer || index < 0) return;
    const rowsTop = spacer.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, rowsTop + index * rowPxRef.current - scroller.clientHeight / 2);
    const start = Math.max(0, index - OVERSCAN_ROWS);
    setRange({start, end: Math.min(countRef.current, index + OVERSCAN_ROWS + 1)});
  }, []);

  return {scrollerRef, topSpacerRef, plan: drawPlan(range, count, keep), rowPx, revealIndex};
}
