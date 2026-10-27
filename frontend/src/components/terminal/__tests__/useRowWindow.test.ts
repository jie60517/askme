import {describe, expect, it} from 'vitest';

import {FALLBACK_ROWS, OVERSCAN_ROWS, drawPlan, rowWindow, type DrawPlan} from '../useRowWindow';

/** 空白 + 畫出來的列,加起來一定要等於總列數 —— 不然捲軸長度跟全部畫出來時不一樣 */
function totalRows(plan: DrawPlan): number {
  return plan.top + plan.rows.reduce((sum, r) => sum + r.gapBefore + 1, 0) + plan.bottom;
}

describe('drawPlan(看得到的那段 + 焦點 / anchor 那幾列,中間用空白撐開)', () => {
  it('沒有要額外留的列:上下各一塊空白', () => {
    const plan = drawPlan({start: 10, end: 13}, 100, []);
    expect(plan).toEqual({
      top: 10,
      rows: [
        {index: 10, gapBefore: 0},
        {index: 11, gapBefore: 0},
        {index: 12, gapBefore: 0},
      ],
      bottom: 87,
    });
    expect(totalRows(plan)).toBe(100);
  });

  it('焦點那一列捲到上面去了:它照畫,跟看得到的那段之間空出中間那幾列', () => {
    const plan = drawPlan({start: 50, end: 52}, 100, [3]);
    expect(plan).toEqual({
      top: 3,
      rows: [
        {index: 3, gapBefore: 0},
        {index: 50, gapBefore: 46},
        {index: 51, gapBefore: 0},
      ],
      bottom: 48,
    });
    expect(totalRows(plan)).toBe(100);
  });

  it('anchor 在下面、焦點在上面:兩列都留,順序照位置', () => {
    const plan = drawPlan({start: 50, end: 52}, 100, [90, 3]);
    expect(plan.rows.map((r) => r.index)).toEqual([3, 50, 51, 90]);
    expect(plan.rows.map((r) => r.gapBefore)).toEqual([0, 46, 0, 38]);
    expect(plan.bottom).toBe(9);
    expect(totalRows(plan)).toBe(100);
  });

  it('要留的列本來就在範圍裡、重複、超出範圍:不會多畫也不會畫出界', () => {
    const plan = drawPlan({start: 50, end: 52}, 100, [51, 51, 3, 3, 200, -1, 1.5]);
    expect(plan.rows.map((r) => r.index)).toEqual([3, 50, 51]);
    expect(totalRows(plan)).toBe(100);
  });

  it('空目錄', () => {
    expect(drawPlan({start: 0, end: 0}, 0, [])).toEqual({top: 0, rows: [], bottom: 0});
  });

  it('大目錄換到小目錄的那一瞬間(舊範圍整段落在外面):不畫出界,空白補滿', () => {
    const plan = drawPlan({start: 5000, end: 5060}, 8, []);
    expect(plan.rows).toEqual([]);
    expect(totalRows(plan)).toBe(8);
  });
});

describe('rowWindow(檔案欄只畫看得到的那一段)', () => {
  it('還沒捲:從第 0 列畫到看得到的最後一列再多 OVERSCAN', () => {
    // 600px 高、一列 30px → 看得到 20 列
    expect(rowWindow(0, 600, 30, 20000)).toEqual({start: 0, end: 20 + OVERSCAN_ROWS});
  });

  it('捲到中間:前後各多畫 OVERSCAN 列', () => {
    // 捲過 30000px = 第 1000 列在最上面
    expect(rowWindow(30000, 600, 30, 20000)).toEqual({start: 1000 - OVERSCAN_ROWS, end: 1020 + OVERSCAN_ROWS});
  });

  it('捲到底:不超過總列數', () => {
    expect(rowWindow(30 * 19990, 600, 30, 20000)).toEqual({start: 19990 - OVERSCAN_ROWS, end: 20000});
  });

  it('列的區塊還在捲動框下面(上面疊著表頭 / 上傳進度):從第 0 列開始', () => {
    expect(rowWindow(-120, 600, 30, 20000)).toEqual({start: 0, end: 16 + OVERSCAN_ROWS});
  });

  it('量不到捲動框高度(第一次畫、jsdom):先畫 FALLBACK_ROWS 列', () => {
    expect(rowWindow(0, 0, 30, 20000)).toEqual({start: 0, end: FALLBACK_ROWS});
    expect(rowWindow(0, 0, 30, 12)).toEqual({start: 0, end: 12});
  });

  it('空目錄、少於一頁:全部畫', () => {
    expect(rowWindow(0, 600, 30, 0)).toEqual({start: 0, end: 0});
    expect(rowWindow(0, 600, 30, 8)).toEqual({start: 0, end: 8});
  });

  it('捲動位置比清單還長(大目錄換到小目錄的那一瞬間):不畫出界', () => {
    const r = rowWindow(30 * 5000, 600, 30, 8);
    expect(r.start).toBeLessThanOrEqual(r.end);
    expect(r.end).toBeLessThanOrEqual(8);
  });
});
