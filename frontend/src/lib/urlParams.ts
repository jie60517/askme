/**
 * 網址上的參數 → 型別安全的值。認不得的一律當「沒有」,不能原樣送給後端 ——
 * 網址是使用者改得到的,`?start=abc` 直接丟出去只會換來一次 422,而畫面只會顯示
 * 「載入失敗」,看不出是網址壞了。用量統計與題目明細兩頁共用。
 *
 * 也放兩頁共用的日期小工具:本地時區的今天(`todayIso`)、單端日期網址的說法(`openRangeLabel`)。
 * **只放純函式** —— 讀寫網址的 hook 在 `useSearchParamsPatch.ts`(這支的測試跑在 node,不載 React / router)。
 */
import type {ISODateString} from '@astryxdesign/core/utils';

/** `YYYY-MM-DD` 才收。只驗形狀不驗真假(2 月 31 日交給後端回 422 —— 那是真的錯)。 */
export function isoDateParam(raw: string | null): ISODateString | undefined {
  return raw && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw) ? (raw as ISODateString) : undefined;
}

/** 只收白名單裡的值,其餘退回預設。 */
export function enumParam<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
}

/**
 * 今天,格式 `YYYY-MM-DD`(網址參數與日期元件都吃這個形狀)。
 *
 * ⚠️ **不能用 `toISOString().slice(0,10)`** —— 那個會先轉成 UTC。在 UTC+8,
 * 每天上午 8 點以前打開這一頁,拿到的會是**昨天**,而畫面上完全看不出來。
 * 用本地時區的年月日自己組。
 */
export function todayIso(): ISODateString {
  return isoDate(new Date());
}

function isoDate(d: Date): ISODateString {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}` as ISODateString;
}

/**
 * 只帶一端日期的網址是**開放區間**:只有起點 = 從那天起,只有終點 = 到那天為止(查詢照這個意思送)。
 * 日期區間元件只畫得出「兩端都有」,所以格子留空、用 placeholder 把這個開放區間講出來。兩端都有或都沒有回 null。
 * 日期區間元件做不出單端網址,只有手打或舊書籤的網址會遇到;不要把它補成完整區間(那會改掉查詢的意思)。
 */
export function openRangeLabel(start: ISODateString | undefined, end: ISODateString | undefined): string | null {
  // 一律帶年份,跟區間欄位本身(components/astryx/DateRangeInput)同一個寫法
  const ymd = (d: ISODateString) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  if (start && !end) return `${ymd(start)} 起`;
  if (end && !start) return `到 ${ymd(end)} 為止`;
  return null;
}
