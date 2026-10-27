/**
 * 檔案欄的欄位:**有哪幾欄、每一欄多寬、寬度記在哪**。
 *
 * 抽成自己的模組是這個專案的慣例:規則是純函式就放外面、配一份測試
 * (`selection.ts` 的選取規則、`fileSort.ts` 的排序都是這樣),元件只負責畫。
 *
 * ⚠️ **六欄一直都在,每一欄自己可以拖**:欄位不會依面板寬度自己長出來或消失,
 * 不夠寬就左右捲。預設只看到 Name + Size,因為預設寬度加起來剛好是這樣(見 `DEFAULT_WIDTHS`)。
 */
import {formatMtime, formatSize, type FileEntry} from '../../lib/terminalApi';
import {readString, removeKey, writeString} from '../../lib/safeStorage';
import type {SortKey} from './fileSort';

export type FileColumn = {
  key: SortKey;
  label: string;
  value: (entry: FileEntry) => string;
  /**
   * 名稱那一欄跟其他五欄**畫法不同**:正文字級、名字太長就**從中間**截斷(見 `splitNameTail`)。
   * 其他欄是 `supporting` 的次要字。
   * ⚠️ **沒有「滑上去看全名」** —— 那顆浮層要 hover 到字本身,
   * 而字為了讓滾輪過得去已經不吃滑鼠事件(理由在 `FilePanel` 的 `styles.cellText`)。
   * 看不完就把那一欄拖寬。
   *
   * ⚠️ 名稱欄與其他欄的差異只寫在這個旗標上,列渲染裡不要再寫 `column.key === 'name'` 之類的特例。
   *
   * ⚠️ **旗標只問一次**:它在 `FilePanel` 挑的是 `PRIMARY_CELL` / `SECONDARY_CELL`
   * 兩份具名 preset 其中之一(外層 `Stack` 的樣式與 `Text` 的屬性都在裡面),
   * 不是在 JSX 裡一項一項用三元式問。兩欄的畫法差在哪,看那兩個常數就好。
   */
  isPrimary?: boolean;
};

/**
 * 六欄,**順序就是畫面上的順序**。名稱欄也在裡面,跟其他欄共用同一套寬度與拖拉把手。
 */
export const COLUMNS: FileColumn[] = [
  {key: 'name', label: 'Name', value: (e) => e.name, isPrimary: true},
  {key: 'size', label: 'Size', value: (e) => (e.is_dir ? '' : formatSize(e.size))},
  {key: 'mtime', label: 'Last modified', value: (e) => formatMtime(e.mtime)},
  {key: 'owner', label: 'Owner', value: (e) => e.owner},
  {key: 'group', label: 'Group', value: (e) => e.group},
  {key: 'access', label: 'Access', value: (e) => e.access},
];

export type ColumnWidths = Record<SortKey, number>;

/**
 * 預設寬度(px)。量出來的:每一欄用等寬字量最長的內容(`2026-09-10 17:06` 16 字、
 * `drwxrwxrwt` 10 字、`1023.9 MB` 9 字)再留一點右邊界。
 *
 * ⚠️ `name` 的 120 + `size` 的 72 加上圖示與間距**就是**預設面板寬度
 * (`PANEL_DEFAULT_PX`,底下一項一項加出來的)—— **所以預設看到的就是 Name + Size**,
 * 後面四欄要往右捲或把前面拖窄。改這裡的寬度時,註解裡的量測值要一起更新。
 */
export const DEFAULT_WIDTHS: ColumnWidths = {
  name: 120,
  /*
   * ⚠️ 72 不是 62:62 是「`1023.9 MB` 剛好塞得下」的量法,
   * 而 `supporting` 字級加上等寬數字、再被垂直捲軸蓋掉最後幾 px(見 `PANEL_DEFAULT_PX`)
   * 之後就會被切掉最後一個字母。**數字一律不能被截** —— 寧可預設面板寬 10px。
   */
  size: 72,
  mtime: 104,
  owner: 58,
  group: 58,
  access: 78,
};

/** 一欄最窄 / 最寬。窄到 48 以下連兩個字都放不下,寬過 480 就只是在推別欄。 */
export const COLUMN_MIN_PX = 48;
export const COLUMN_MAX_PX = 480;

/** 每一列前面那顆圖示的寬度 —— 表頭要放一個一樣寬的空位,不然整排欄位會差這麼多。 */
export const ICON_PX = 16;
/**
 * 一列裡格與格之間的間距(px)。**要跟 JSX 上的 `gap={1}` 是同一個數字**(`--spacing-1` = 4)。
 *
 * ⚠️ 它得算進整列的最小寬度:漏掉 gap 的話,名稱欄拖寬之後
 * 選取的底色會差最後那一小段蓋不到。StyleX 的 `gap` 拿不回數值,所以只能在這裡對一次。
 */
export const GAP_PX = 4;

/** 列自己的左內距(`--spacing-2`)。右內距在裁切邊外面,算可視寬時用不到。 */
export const ROW_PAD_PX = 8;
/**
 * 檔案欄的**預設寬度**(px):裁切邊剛好落在 Size 後面那個 gap 上 —— 兩欄完整,
 * 第三欄**一個 px 都不露**。
 *
 * ⚠️ 這個數字要**照版面的組成一項一項加**,不能用一個概括的邊界值 ——
 * 少算 Size 後面那個 gap、或把用不到的右內距算進去,第三欄就會露出幾 px。
 * 順序就是畫面上的順序:左內距 + 圖示 +(每一欄前面的 gap + 欄寬)。
 *
 * ⚠️ **捲軸的位子不算在裡面**:溢出的內容裁在 padding box(= 面板的右緣),不是 scrollport;
 * `scrollbar-gutter: stable` 只是把捲軸那 10px 空下來,**不會**阻止後面的欄位畫進去。
 * 加了捲軸寬就等於把面板多開 10px,第三欄剛好露出那 10px。
 * (檢查法:把第三欄塗紅、表頭塗綠再截圖 —— 顏色出現在保留帶上就是畫進去了。)
 *
 * ⚠️ 代價:清單長到拖出垂直捲軸時,捲軸那 10px 會**蓋掉 Size 欄框的最後 6px**
 * (剩下那 4px 蓋到的是欄後面的 gap)。Size 的內容靠左,最寬的 `1023.9 MB` 跟捲軸之間
 * 約留 11px。**要調 `size` 的預設寬就得連捲軸蓋掉的那 6px 一起想**。
 */
export const PANEL_DEFAULT_PX =
  ROW_PAD_PX + ICON_PX + GAP_PX + DEFAULT_WIDTHS.name + GAP_PX + DEFAULT_WIDTHS.size + GAP_PX;

/**
 * **表頭**那一格要多寬。
 *
 * 除了名稱欄以外都跟資料列同寬;**名稱欄連前面那格圖示一起佔** ——
 * 列上那 16px 是每一列的圖示,表頭沒有圖示,留著就是一塊沒有用途的空白。
 * 併進來之後欄名從列的左緣開始寫,而**右緣與把手的位置跟資料列一致**
 * (多吃的剛好是 `ICON_PX` + 它後面那個 `GAP_PX`)。
 *
 * ⚠️ 放在這裡而不是寫在 JSX 裡:這個模組是「欄位的幾何值只有一份」的地方
 * (`PANEL_DEFAULT_PX`、`rowMinPx` 都在這),散出去就會有第三份加法要跟著維護。
 */
export function headColumnPx(column: FileColumn, widths: ColumnWidths): number {
  const own = widths[column.key];
  return column.isPrimary ? ICON_PX + GAP_PX + own : own;
}

/**
 * 名稱欄**從中間截**時,尾巴留多寬(以「半形字」為單位,全形字算兩個)。
 *
 * 從尾巴截的話,`報告_v11_final.docx` 和 `…_v12_…` 截出來一模一樣,
 * 而真的會排成一串的正是這種只差版本號的檔名。所以「頭可以縮、尾巴固定」:副檔名與最後一段永遠看得到。
 * 12 個半形字 ≈ 84px —— 預設的名稱欄 120px 扣掉它還剩三十幾 px 給頭(兩三個全形字 + 刪節號)。
 * 寬一點會把頭擠到只剩刪節號,窄一點就切進 `v11` 這種最需要看到的地方。
 *
 * ⚠️ 沒有 tooltip,看不完就拖寬。
 */
export const NAME_TAIL_UNITS = 12;

/**
 * 把字串拆成字素(grapheme)。
 *
 * ⚠️ 不能只用 `Array.from`(以 code point 切):macOS 存出來的檔名常是**分解形式**
 * (`é` = `e` + U+0301 組合重音),而 👨‍👩‍👧 是好幾個 emoji 用 ZWJ 黏起來的一個字 ——
 * 以 code point 切的話,刪節號那一側會留下一個孤零零的重音符號或半個家庭。
 * `Intl.Segmenter` 各家都有了;沒有的環境退回 code point,至少不會切開代理對。
 */
const graphemeSegmenter: {segment(input: string): Iterable<{segment: string}>} | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, {granularity: 'grapheme'})
    : null;
function graphemes(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

/**
 * 東亞「寬」字(Unicode East Asian Width 的 W / F)的範圍,畫面上佔兩個半形寬。
 *
 * ⚠️ 不能用「U+1100 以上全算兩格」:越南文(U+1E00–1EFF 的 ạ ề ữ)、
 * 希臘文擴充、`–`(U+2013)、`…`(U+2026)、箭頭都在 U+1100 以上,卻是窄字 ——
 * 算成兩格的話尾巴少一半,越南文檔名截出來只剩副檔名。
 * 這裡列的是常見的寬字區段(不是完整的 EastAsianWidth.txt,但檔名會出現的都在):
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 韓文字母(初聲)
  [0x2e80, 0x303e], // CJK 部首、康熙部首、CJK 標點(、。「」)
  [0x3041, 0x33ff], // 平假名、片假名、注音、韓文相容字母、CJK 相容字
  [0x3400, 0x4dbf], // CJK 擴充 A
  [0x4e00, 0x9fff], // CJK 統一漢字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 韓文音節
  [0xf900, 0xfaff], // CJK 相容漢字
  [0xfe30, 0xfe4f], // CJK 相容形式(直排標點)
  [0xff00, 0xff60], // 全形 ASCII、全形標點
  [0xffe0, 0xffe6], // 全形符號(¥ ¢ 等)
  [0x1f300, 0x1f64f], // emoji:雜項符號與圖形、表情
  [0x1f680, 0x1f6ff], // emoji:交通與地圖
  [0x1f900, 0x1faff], // emoji:補充符號與圖形、擴充 A
  [0x20000, 0x3fffd], // CJK 擴充 B 以後
];

/** 一個字(字素)佔幾個半形寬:看它的第一個 code point 落不落在寬字區段,其餘一律一格。 */
export function charUnits(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp < lo) return 1;
    if (cp <= hi) return 2;
  }
  return 1;
}

/**
 * 把檔名切成「可以被刪節號吃掉的頭」與「一定要看得到的尾巴」。
 *
 * - 尾巴從最後一個字往前收,收到 `budget` 個半形寬為止(含副檔名);
 * - 整個名字都放得進尾巴的話**不切**(`tail` 是空字串),照一般的一顆字畫;
 * - 以**字素**(使用者看到的「一個字」)為單位切,見 `graphemes`。
 */
export function splitNameTail(
  name: string,
  budget: number = NAME_TAIL_UNITS,
): {head: string; tail: string} {
  const chars = graphemes(name);
  let units = 0;
  let cut = chars.length;
  while (cut > 0) {
    const next = units + charUnits(chars[cut - 1]);
    if (next > budget) break;
    units = next;
    cut -= 1;
  }
  if (cut === 0) return {head: name, tail: ''};
  return {head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('')};
}

export function clampColumn(px: number): number {
  return Math.max(COLUMN_MIN_PX, Math.min(COLUMN_MAX_PX, Math.round(px)));
}

/**
 * 一列真正的寬度:圖示 + 六欄 + 中間每一個 gap。表頭、清單、每一列都吃它(`--row-min`),
 * 對齊靠的就是「只有一份」。
 */
export function rowMinPx(widths: ColumnWidths): number {
  const columns = COLUMNS.reduce((sum, c) => sum + widths[c.key], 0);
  return ICON_PX + columns + GAP_PX * COLUMNS.length;
}

/** localStorage 的鍵。換寬度模型就換版號,不然舊值會蓋掉新的預設。 */
const WIDTHS_KEY = 't100_terminal_cols_v2';
/**
 * 上一版的鍵(Size 預設寬還是 62 的時候)。`FilePanel` 一掛上去就會把**預設值本身**寫進來,
 * 所以舊鍵裡的 `size: 62` 多半不是使用者拖的 —— 不換鍵的話新的 Size 預設寬對他們沒效果。
 * 但整份丟掉又會把使用者自己拖過的其他欄一起清掉,所以**搬過來、只把「還是舊預設值」的 Size 換掉**。
 */
const LEGACY_WIDTHS_KEY = 't100_terminal_cols_v1';
const LEGACY_SIZE_DEFAULT = 62;

/**
 * 讀回使用者拖出來的欄寬。**壞掉的值一律當沒有** —— 這是 localStorage,
 * 什麼都可能在裡面(改過版本、手動編過、別的分頁寫壞)。缺的那幾欄各自補預設值,
 * 所以之後多一欄也不會讓整份設定失效。
 */
export function readColumnWidths(): ColumnWidths {
  const current = readString(WIDTHS_KEY);
  const raw = current ?? readString(LEGACY_WIDTHS_KEY);
  const out: ColumnWidths = {...DEFAULT_WIDTHS};
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw) as Partial<Record<SortKey, unknown>>;
    // 舊鍵裡的 62 是當時的預設值,不是使用者拖出來的(見 `LEGACY_WIDTHS_KEY`)
    if (current === null && saved.size === LEGACY_SIZE_DEFAULT) delete saved.size;
    for (const column of COLUMNS) {
      const value = saved[column.key];
      if (typeof value === 'number' && Number.isFinite(value)) out[column.key] = clampColumn(value);
    }
  } catch {
    // 壞掉就用預設值,不要讓一個壞字串把檔案欄整個弄不出來
  }
  if (current === null) {
    // 搬完就把新鍵寫好、舊鍵刪掉:舊鍵留著的話它永遠躺在 localStorage 裡,
    // 而且新鍵哪天被清掉,又會把那份過期的值搬回來一次
    writeColumnWidths(out);
    removeKey(LEGACY_WIDTHS_KEY);
  }
  return out;
}

export function writeColumnWidths(widths: ColumnWidths): void {
  writeString(WIDTHS_KEY, JSON.stringify(widths));
}
