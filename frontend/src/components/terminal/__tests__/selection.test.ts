import {describe, expect, it} from 'vitest';

import {EMPTY_SELECTION, moveSelection, pruneSelection, selectRow, type Selection} from '../selection';

const NAMES = ['axm', 'flows', 'CLAUDE.md', 'README.md', 'notes.txt'];

describe('selectRow', () => {
  it('點一下只選那一列,並把它記成起點', () => {
    expect(selectRow(NAMES, EMPTY_SELECTION, 'flows')).toEqual({selected: ['flows'], anchor: 'flows'});
  });

  it('Ctrl / ⌘ 加一個、再按一次減一個', () => {
    const one = selectRow(NAMES, EMPTY_SELECTION, 'axm');
    const two = selectRow(NAMES, one, 'README.md', {toggle: true});
    expect(two.selected).toEqual(['axm', 'README.md']);
    expect(selectRow(NAMES, two, 'axm', {toggle: true}).selected).toEqual(['README.md']);
  });

  it('Shift 從起點選一段,方向反過來也一樣', () => {
    const start = selectRow(NAMES, EMPTY_SELECTION, 'CLAUDE.md');
    expect(selectRow(NAMES, start, 'notes.txt', {extend: true}).selected).toEqual([
      'CLAUDE.md',
      'README.md',
      'notes.txt',
    ]);
    expect(selectRow(NAMES, start, 'axm', {extend: true}).selected).toEqual(['axm', 'flows', 'CLAUDE.md']);
  });

  it('Shift 選一段不會移動起點 —— 同一個起點可以一直往外拉', () => {
    const start = selectRow(NAMES, EMPTY_SELECTION, 'flows');
    const once = selectRow(NAMES, start, 'CLAUDE.md', {extend: true});
    expect(once.anchor).toBe('flows');
    expect(selectRow(NAMES, once, 'notes.txt', {extend: true}).selected).toEqual([
      'flows',
      'CLAUDE.md',
      'README.md',
      'notes.txt',
    ]);
  });

  it('還沒有起點的 Shift 當成普通的點一下', () => {
    expect(selectRow(NAMES, EMPTY_SELECTION, 'flows', {extend: true})).toEqual({
      selected: ['flows'],
      anchor: 'flows',
    });
  });

  it('起點已經不在這個目錄裡(換過目錄)的 Shift 也不會爆炸', () => {
    const stale: Selection = {selected: [], anchor: '不在清單裡的檔案'};
    expect(selectRow(NAMES, stale, 'flows', {extend: true}).selected).toEqual(['flows']);
  });
});

describe('moveSelection', () => {
  it('往下一列、往上一列', () => {
    const at = selectRow(NAMES, EMPTY_SELECTION, 'flows');
    expect(moveSelection(NAMES, at, 1)?.selection.selected).toEqual(['CLAUDE.md']);
    expect(moveSelection(NAMES, at, -1)?.selection.selected).toEqual(['axm']);
  });

  it('還沒選過:往下從第一列開始,往上從最後一列開始', () => {
    expect(moveSelection(NAMES, EMPTY_SELECTION, 1)?.focus).toBe('axm');
    expect(moveSelection(NAMES, EMPTY_SELECTION, -1)?.focus).toBe('notes.txt');
  });

  it('到頭到尾就停著,不繞回去', () => {
    expect(moveSelection(NAMES, selectRow(NAMES, EMPTY_SELECTION, 'axm'), -1)).toBeNull();
    expect(moveSelection(NAMES, selectRow(NAMES, EMPTY_SELECTION, 'notes.txt'), 1)).toBeNull();
  });

  it('空目錄什麼都不做', () => {
    expect(moveSelection([], EMPTY_SELECTION, 1)).toBeNull();
  });
});

describe('pruneSelection', () => {
  const two = selectRow(NAMES, selectRow(NAMES, EMPTY_SELECTION, 'axm'), 'README.md', {toggle: true});

  it('都還在就回同一個物件(不讓整欄白重畫)', () => {
    expect(pruneSelection(two, new Set(NAMES))).toBe(two);
  });

  it('被刪掉的名字拿掉;起點被刪掉就清成 null', () => {
    expect(pruneSelection(two, new Set(['axm', 'flows']))).toEqual({selected: ['axm'], anchor: null});
  });

  it('只有起點不在了也要清掉', () => {
    const current: Selection = {selected: ['axm'], anchor: 'flows'};
    expect(pruneSelection(current, new Set(['axm']))).toEqual({selected: ['axm'], anchor: null});
  });
});
