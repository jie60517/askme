// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  clampColumn,
  COLUMN_MAX_PX,
  COLUMN_MIN_PX,
  COLUMNS,
  DEFAULT_WIDTHS,
  GAP_PX,
  ICON_PX,
  PANEL_DEFAULT_PX,
  readColumnWidths,
  ROW_PAD_PX,
  rowMinPx,
  charUnits,
  splitNameTail,
  writeColumnWidths,
} from '../fileColumns';

/**
 * ⚠️ 這個檔案要 **jsdom**(第一行那個註解):`readColumnWidths` / `writeColumnWidths`
 * 走的是 localStorage。`lib/` 底下那些純函式測試不需要 DOM,這一份需要。
 */
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('COLUMNS', () => {
  it('六欄,而且**名稱也在裡面** —— 它不再是特例', () => {
    expect(COLUMNS.map((c) => c.key)).toEqual(['name', 'size', 'mtime', 'owner', 'group', 'access']);
  });

  it('**檔案欄的預設寬度剛好切在 Size 後面那個 gap 上** —— 第三欄一個 px 都不露', () => {
    // 裁切邊 = 面板寬本身(padding box)。
    // ⚠️ **不要扣捲軸那 10px**:`scrollbar-gutter: stable`
    // 只是把那 10px 空下來給捲軸,溢出的欄位照樣畫進去 —— 扣掉它等於把面板多開 10px,
    // 第三欄就露出那 10px。
    const clip = PANEL_DEFAULT_PX;
    // 從列的左內距開始往右排:圖示 → gap → Name → gap → Size
    const sizeRight = ROW_PAD_PX + ICON_PX + GAP_PX + DEFAULT_WIDTHS.name + GAP_PX + DEFAULT_WIDTHS.size;
    // 剛好差一個 gap:Size 完整,而下一欄連邊都還沒開始畫
    expect(clip - sizeRight).toBe(GAP_PX);
    expect(sizeRight + GAP_PX + DEFAULT_WIDTHS.mtime).toBeGreaterThan(clip);
  });
});

describe('clampColumn', () => {
  it('夾在上下限之間,而且回整數', () => {
    expect(clampColumn(10)).toBe(COLUMN_MIN_PX);
    expect(clampColumn(9999)).toBe(COLUMN_MAX_PX);
    expect(clampColumn(120.6)).toBe(121);
  });
});

describe('rowMinPx', () => {
  it('= 圖示 + 六欄 + 每一欄後面那個 gap', () => {
    const expected =
      ICON_PX + COLUMNS.reduce((sum, c) => sum + DEFAULT_WIDTHS[c.key], 0) + GAP_PX * COLUMNS.length;
    expect(rowMinPx(DEFAULT_WIDTHS)).toBe(expected);
  });

  it('拖寬一欄,整列就跟著寬 —— 不然選取的底色蓋不滿整列', () => {
    const wider = {...DEFAULT_WIDTHS, name: DEFAULT_WIDTHS.name + 100};
    expect(rowMinPx(wider) - rowMinPx(DEFAULT_WIDTHS)).toBe(100);
  });
});

describe('readColumnWidths / writeColumnWidths', () => {
  it('沒存過就是預設值', () => {
    expect(readColumnWidths()).toEqual(DEFAULT_WIDTHS);
  });

  it('存什麼讀什麼', () => {
    const mine = {...DEFAULT_WIDTHS, name: 200, access: 100};
    writeColumnWidths(mine);
    expect(readColumnWidths()).toEqual(mine);
  });

  it('**壞掉的值一律當沒有**(localStorage 裡什麼都可能出現)', () => {
    localStorage.setItem('t100_terminal_cols_v1', '這不是 JSON');
    expect(readColumnWidths()).toEqual(DEFAULT_WIDTHS);
  });

  it('少了幾欄 / 混進怪值,只有那幾欄退回預設,其他照舊', () => {
    localStorage.setItem(
      't100_terminal_cols_v1',
      JSON.stringify({name: 200, size: 'wide', owner: null}),
    );
    const widths = readColumnWidths();
    expect(widths.name).toBe(200);
    expect(widths.size).toBe(DEFAULT_WIDTHS.size);
    expect(widths.owner).toBe(DEFAULT_WIDTHS.owner);
    expect(widths.access).toBe(DEFAULT_WIDTHS.access);
  });

  it('舊鍵(v1)搬過來:使用者拖過的欄照舊,只有「還是舊預設 62」的 Size 換成新的預設', () => {
    localStorage.setItem('t100_terminal_cols_v1', JSON.stringify({...DEFAULT_WIDTHS, name: 200, size: 62}));
    const widths = readColumnWidths();
    expect(widths.name).toBe(200);
    expect(widths.size).toBe(DEFAULT_WIDTHS.size);
    // 自己拖過的 Size 不動(先清掉:上面那次讀取已經搬成新鍵了)
    localStorage.clear();
    localStorage.setItem('t100_terminal_cols_v1', JSON.stringify({size: 90}));
    expect(readColumnWidths().size).toBe(90);
  });

  it('搬完舊鍵就刪掉,寫進新鍵', () => {
    localStorage.setItem('t100_terminal_cols_v1', JSON.stringify({name: 200}));
    readColumnWidths();
    expect(localStorage.getItem('t100_terminal_cols_v1')).toBeNull();
    expect(JSON.parse(localStorage.getItem('t100_terminal_cols_v2') ?? '{}').name).toBe(200);
  });

  it('新鍵裡的 62 是使用者自己拖的,不換', () => {
    writeColumnWidths({...DEFAULT_WIDTHS, size: 62});
    expect(readColumnWidths().size).toBe(62);
  });

  it('讀回來的值也夾在上下限裡 —— 手動編過的檔案不該讓某一欄寬到看不到別欄', () => {
    localStorage.setItem('t100_terminal_cols_v1', JSON.stringify({name: 99999}));
    expect(readColumnWidths().name).toBe(COLUMN_MAX_PX);
  });
});

describe('Size 欄的預設寬', () => {
  it('放得下最寬的 `1023.9 MB` 還有餘裕 —— 數字一律不能被截', () => {
    // 62 是「剛好塞得下」的量法,被捲軸蓋掉幾 px 就切到最後一個字母
    expect(DEFAULT_WIDTHS.size).toBeGreaterThanOrEqual(72);
  });
});

describe('splitNameTail(名稱欄從中間截)', () => {
  it('只差版本號的兩個名字,尾巴分得出來', () => {
    const a = splitNameTail('季度報告_v11_final.docx');
    const b = splitNameTail('季度報告_v12_final.docx');
    expect(a.tail).not.toBe(b.tail);
    expect(a.tail.endsWith('.docx')).toBe(true);
    expect(a.head + a.tail).toBe('季度報告_v11_final.docx');
  });

  it('整個名字放得進尾巴就不切', () => {
    expect(splitNameTail('README.md')).toEqual({head: 'README.md', tail: ''});
  });

  it('寬度看 East Asian Width:越南文、– 、… 是窄字,CJK、全形、韓文、emoji 是寬字', () => {
    for (const ch of ['a', '\u1EA1', '\u1EC1', '\u2013', '\u2026', '\u2192', '\u03A9', '\u00E9']) {
      expect(charUnits(ch)).toBe(1);
    }
    for (const ch of ['\u4E2D', '\uFF21', '\u3001', '\uAC00', '\u3042', '\u{1F600}', '\u{20000}']) {
      expect(charUnits(ch)).toBe(2);
    }
  });

  it('越南文的檔名:尾巴照半形算,保得住 12 個字', () => {
    // Bao_cao_tai_chinh_quy_3_nam_2026 的越南文寫法
    const name = 'B\u00E1o_c\u00E1o_t\u00E0i_ch\u00EDnh_qu\u00FD_ba_n\u0103m_\u0111\u00E3_duy\u1EC7t.xlsx';
    const {tail} = splitNameTail(name);
    expect(Array.from(tail).length).toBe(12);
    expect(tail.endsWith('.xlsx')).toBe(true);
  });

  it('– 與 … 不會讓尾巴縮水', () => {
    // 12 個半形寬 = 12 個字(… 算一格;算成兩格的話尾巴只剩 11 個字)
    expect(splitNameTail('report \u2013 final\u2026 v2.pdf').tail).toBe('inal\u2026 v2.pdf');
  });

  it('全形字算兩個半形寬', () => {
    // 12 個半形寬 = 6 個全形字
    expect(splitNameTail('一二三四五六七八九十').tail).toBe('五六七八九十');
  });

  it('不會把一個字素切開:分解形式的重音(macOS 的檔名)', () => {
    // 每個 é 都是 e + U+0301;12 個半形寬剛好落在第 12 個 é 的兩個 code point 之間也不能切開
    const name = 'r\u00e9sum\u00e9_' + 'e\u0301'.repeat(20) + '.pdf';
    const {head, tail} = splitNameTail(name);
    expect(head + tail).toBe(name);
    expect(tail.startsWith('\u0301')).toBe(false);
    expect(head.endsWith('e')).toBe(false);
  });

  it('不會把 ZWJ 黏起來的 emoji 切開', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const name = 'photo_' + family.repeat(8) + '.png';
    const {head, tail} = splitNameTail(name);
    expect(head + tail).toBe(name);
    // 尾巴是整數個家庭 + 副檔名
    expect(tail.replace('.png', '').split(family).join('')).toBe('');
  });

  it('不會把 emoji 切成兩半', () => {
    const {head, tail} = splitNameTail('😀😀😀😀😀😀😀😀😀😀.png');
    expect(head + tail).toBe('😀😀😀😀😀😀😀😀😀😀.png');
    expect(Array.from(tail).every((ch) => ch === '😀' || '.png'.includes(ch))).toBe(true);
    expect(tail.startsWith('\uDE00')).toBe(false);
  });
});
