import {describe, expect, it} from 'vitest';

import {DEFAULT_SORT, nextSort, sortEntries} from '../fileSort';
import type {FileEntry} from '../../../lib/terminalApi';

const entry = (over: Partial<FileEntry> & {name: string}): FileEntry => ({
  is_dir: false,
  size: 0,
  mtime: 0,
  mode: 0o644,
  access: '-rw-r--r--',
  owner: 'app',
  group: 'app',
  ...over,
});

const ENTRIES: FileEntry[] = [
  entry({name: 'README.md', size: 150, mtime: 300, owner: 'root'}),
  entry({name: 'axm', is_dir: true, mtime: 100, access: 'drwxr-xr-x'}),
  entry({name: 'CLAUDE.md', size: 24, mtime: 200, owner: 'apple'}),
  entry({name: 'flows', is_dir: true, mtime: 400, access: 'drwxrwxr-x'}),
];

const names = (sorted: FileEntry[]) => sorted.map((e) => e.name);

describe('sortEntries', () => {
  it('資料夾永遠在前面 —— 升冪降冪都一樣', () => {
    expect(names(sortEntries(ENTRIES, {key: 'name', dir: 'asc'}))).toEqual([
      'axm',
      'flows',
      'CLAUDE.md',
      'README.md',
    ]);
    expect(names(sortEntries(ENTRIES, {key: 'name', dir: 'desc'}))).toEqual([
      'flows',
      'axm',
      'README.md',
      'CLAUDE.md',
    ]);
  });

  it('照大小、時間、擁有者排,都只在同一組之內比', () => {
    expect(names(sortEntries(ENTRIES, {key: 'size', dir: 'desc'}))).toEqual([
      'axm',
      'flows',
      'README.md',
      'CLAUDE.md',
    ]);
    expect(names(sortEntries(ENTRIES, {key: 'mtime', dir: 'asc'}))).toEqual([
      'axm',
      'flows',
      'CLAUDE.md',
      'README.md',
    ]);
    expect(names(sortEntries(ENTRIES, {key: 'owner', dir: 'asc'}))).toEqual([
      'axm',
      'flows',
      'CLAUDE.md',
      'README.md',
    ]);
  });

  it('名字不分大小寫,而且數字照數值大小(file2 在 file10 前面)', () => {
    const list = [entry({name: 'file10'}), entry({name: 'File2'}), entry({name: 'a'})];
    expect(names(sortEntries(list, DEFAULT_SORT))).toEqual(['a', 'File2', 'file10']);
  });

  it('主要欄位相同就照名字排 —— 同樣大小的兩個檔案順序要穩定', () => {
    const list = [entry({name: 'b', size: 10}), entry({name: 'a', size: 10})];
    expect(names(sortEntries(list, {key: 'size', dir: 'desc'}))).toEqual(['a', 'b']);
    expect(names(sortEntries(list, {key: 'size', dir: 'asc'}))).toEqual(['a', 'b']);
  });

  it('不會動到原本那份陣列', () => {
    const original = [...ENTRIES];
    sortEntries(ENTRIES, {key: 'size', dir: 'desc'});
    expect(ENTRIES).toEqual(original);
  });
});

describe('nextSort', () => {
  it('點同一欄反向,點別欄從升冪開始', () => {
    expect(nextSort({key: 'name', dir: 'asc'}, 'name')).toEqual({key: 'name', dir: 'desc'});
    expect(nextSort({key: 'name', dir: 'desc'}, 'name')).toEqual({key: 'name', dir: 'asc'});
    expect(nextSort({key: 'name', dir: 'desc'}, 'size')).toEqual({key: 'size', dir: 'asc'});
  });
});
