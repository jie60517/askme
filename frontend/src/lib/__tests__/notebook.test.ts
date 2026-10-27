// @vitest-environment jsdom
/**
 * 個人筆記:`lib/notebookApi.ts` 的小工具,以及 `lib/noteDraft.ts` 的自動儲存 ——
 * 停手一秒存一次、存的途中又打字不會被蓋掉、兩個分頁同時改(409)換成伺服器那一版、超過上限(413)不重試。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, renderHook} from '@testing-library/react';

type ServerNote = {id: number; title: string; body: string; updated_at: string};
const server = vi.hoisted(() => ({
  note: {id: 7, title: '標題', body: '舊的', updated_at: 'v1'} as {id: number; title: string; body: string; updated_at: string},
  puts: [] as Array<{title: string; body: string; base_updated_at: string | null}>,
  next: [] as Array<number>, // 下一次 PUT 要回的狀態碼(空 = 成功)
  version: 1,
  delayMs: 0, // PUT 要多久才回來(慢網路)
}));

function httpError(status: number) {
  return Object.assign(new Error(`status ${status}`), {response: {status, data: {detail: 'x'}}});
}

vi.mock('../notebookApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../notebookApi')>();
  const full = (n: ServerNote) => ({
    ...n,
    source_kind: null,
    source_conversation_id: null,
    source_qa_id: null,
    source_available: null,
    created_at: 'v0',
    doc: null,
    parent_id: null,
    icon: null,
    is_template: false,
    owner: 'me',
    access: 'owner' as const,
    crumbs: [],
  });
  return {
    ...real,
    getNote: vi.fn(async () => full(server.note)),
    updateNote: vi.fn(async (_id: number, draft: {title: string; body: string; base_updated_at: string | null}) => {
      server.puts.push(draft);
      if (server.delayMs) await new Promise((r) => setTimeout(r, server.delayMs));
      const status = server.next.shift();
      if (status) throw httpError(status);
      server.version += 1;
      server.note = {...server.note, title: draft.title, body: draft.body, updated_at: `v${server.version}`};
      return full(server.note);
    }),
  };
});
vi.mock('../toast', () => ({toastInfo: vi.fn(), toastNotice: vi.fn(), toastError: vi.fn()}));

import {imageSrcOfRef, insertBlock, noteImageSrc, noteTitle, qaIdFromAnchor, type Note} from '../notebookApi';
import {formatNoteStamp, formatNoteTime} from '../time';
import {SAVE_DELAY_MS, adoptNote, clearDrafts, editDraft, hasUnsavedDrafts, useDraft} from '../noteDraft';
import {toastNotice} from '../toast';

const asNote = (n: ServerNote): Note => ({
  ...n,
  source_kind: null,
  source_conversation_id: null,
  source_qa_id: null,
  source_available: null,
  created_at: 'v0',
  doc: null,
  parent_id: null,
  icon: null,
  is_template: false,
  owner: 'me',
  access: 'owner' as const,
  crumbs: [],
});

beforeEach(() => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  server.note = {id: 7, title: '標題', body: '舊的', updated_at: 'v1'};
  server.version = 1;
  server.puts.length = 0;
  server.next.length = 0;
  server.delayMs = 0;
  clearDrafts();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('notebookApi 小工具', () => {
  it('圖片參照換成網址;其他網址原樣', () => {
    const id = 'a'.repeat(32);
    expect(noteImageSrc(`notebook-image:${id}`)).toBe(`/api/notebook/images/${id}`);
    expect(noteImageSrc('notebook-image:../etc')).toBe('notebook-image:../etc');
    expect(noteImageSrc('https://example.com/x.png')).toBe('https://example.com/x.png');
  });

  it('對話錨點 → 題目 id', () => {
    expect(qaIdFromAnchor('turn-12')).toBe(12);
    expect(qaIdFromAnchor('answer-3')).toBe(3);
    expect(qaIdFromAnchor('note-3')).toBeNull();
    expect(qaIdFromAnchor('turn-')).toBeNull();
  });

  it('空白標題顯示「未命名」', () => {
    expect(noteTitle('  ')).toBe('未命名');
    expect(noteTitle('待辦')).toBe('待辦');
  });

  it('圖片插在游標處、前後補空行自成一段', () => {
    expect(insertBlock('', 0, 0, '![](x)')).toEqual({text: '![](x)\n', caret: 7});
    expect(insertBlock('第一行', 3, 3, '![](x)')).toEqual({text: '第一行\n\n![](x)\n', caret: 12});
    // 選了一段 → 換掉
    expect(insertBlock('甲乙丙', 1, 2, 'X').text).toBe('甲\n\nX\n丙');
    // 前面已經有空行就不再補
    expect(insertBlock('a\n\n', 3, 3, 'X').text).toBe('a\n\nX\n');
  });

  it('清單時間:今天寫時分、昨天、今年寫月/日、往年寫年', () => {
    const now = new Date(2026, 9, 12, 15, 0);
    expect(formatNoteTime(new Date(2026, 9, 12, 9, 5).toISOString(), now)).toBe('09:05');
    expect(formatNoteTime(new Date(2026, 9, 11, 23, 0).toISOString(), now)).toBe('昨天');
    expect(formatNoteTime(new Date(2026, 8, 3).toISOString(), now)).toBe('9/3');
    expect(formatNoteTime(new Date(2025, 0, 2).toISOString(), now)).toBe('2025/1/2');
  });

  it('大標題底下的存檔時間:日期和時間都有,往年連年', () => {
    const now = new Date(2026, 9, 12, 15, 0);
    expect(formatNoteStamp(new Date(2026, 9, 12, 9, 5).toISOString(), now)).toBe('10/12 09:05');
    expect(formatNoteStamp(new Date(2026, 9, 11, 23, 0).toISOString(), now)).toBe('10/11 23:00');
    expect(formatNoteStamp(new Date(2025, 0, 2, 8, 30).toISOString(), now)).toBe('2025/1/2 08:30');
  });

  it('上傳回來的那一段 → 圖片節點要的 notebook-image:<id>', () => {
    const id = 'b'.repeat(32);
    expect(imageSrcOfRef(`![](notebook-image:${id})`)).toBe(`notebook-image:${id}`);
    expect(imageSrcOfRef('![](https://x/y.png)')).toBeNull();
  });

  it('伺服器時間沒有時區標記也當 UTC(走 parseServerTime)', () => {
    const utc = new Date(Date.UTC(2026, 9, 12, 1, 5));
    const naive = utc.toISOString().replace('Z', '');
    const now = new Date(2026, 9, 12, 23, 0);
    expect(formatNoteTime(naive, now)).toBe(formatNoteTime(utc.toISOString(), now));
  });
});

describe('對話頁存筆記失敗的那句(SaveToNotes)', () => {
  it('照狀態碼給英文,不帶出後端的中文 detail', async () => {
    const {saveErrorMessage} = await import('../notebookApi');
    const http = (status: number) => Object.assign(new Error('x'), {response: {status, data: {detail: '筆記已經有 1000 則'}}});
    expect(saveErrorMessage(http(413))).toBe('Could not save: your notes are over the limit.');
    expect(saveErrorMessage(http(404))).toBe('This answer is no longer available.');
    expect(saveErrorMessage(Object.assign(new Error('x'), {name: 'ScreenshotError'}))).toMatch(/screenshot/);
    expect(saveErrorMessage(new Error('offline'))).toBe('Could not save to notes. Please try again.');
    for (const s of [404, 413, 415, 500]) expect(saveErrorMessage(http(s))).not.toMatch(/[一-鿿]/);
  });
});

describe('noteDraft 自動儲存', () => {
  it('連打幾個字只在停手之後存一次,帶著手上那一版', async () => {
    adoptNote(asNote(server.note));
    const {result} = renderHook(() => useDraft(7));
    act(() => editDraft(7, {body: '新 a'}));
    act(() => editDraft(7, {body: '新 ab'}));
    expect(result.current?.save).toBe('dirty');
    expect(hasUnsavedDrafts()).toBe(true);
    await flush(SAVE_DELAY_MS + 10);
    // 圖示也一起送(同一條存檔,見 noteDraft 的 Draft);doc 沒有就不送,舊筆記不會被清成空的;封面、全寬不送(拿掉了,後端維持原值)
    expect(server.puts).toEqual([{title: '標題', body: '新 ab', icon: '', base_updated_at: 'v1'}]);
    expect(result.current).toMatchObject({body: '新 ab', base: 'v2', save: 'saved'});
    expect(hasUnsavedDrafts()).toBe(false);
  });

  it('伺服器那一版不會蓋掉手上還沒存的字', async () => {
    adoptNote(asNote(server.note));
    act(() => editDraft(7, {body: '打到一半'}));
    adoptNote(asNote({...server.note, body: '別台電腦改的', updated_at: 'v9'}));
    const {result} = renderHook(() => useDraft(7));
    expect(result.current?.body).toBe('打到一半');
  });

  it('409(別的分頁先存了):換成伺服器那一版、跳一則 toast,不重試', async () => {
    adoptNote(asNote(server.note));
    server.note = {...server.note, body: '分頁 A 存的', updated_at: 'v5'};
    server.next.push(409);
    const {result} = renderHook(() => useDraft(7));
    act(() => editDraft(7, {body: '分頁 B 打的'}));
    await flush(SAVE_DELAY_MS + 10);
    expect(result.current).toMatchObject({body: '分頁 A 存的', base: 'v5', save: 'saved'});
    expect(toastNotice).toHaveBeenCalled();
    await flush(10_000);
    expect(server.puts).toHaveLength(1);
  });

  it('413(超過上限):狀態是 too-big,不重試;再改字才會再送', async () => {
    adoptNote(asNote(server.note));
    server.next.push(413);
    const {result} = renderHook(() => useDraft(7));
    act(() => editDraft(7, {body: '太長'}));
    await flush(SAVE_DELAY_MS + 10);
    expect(result.current?.save).toBe('too-big');
    await flush(10_000);
    expect(server.puts).toHaveLength(1);
    act(() => editDraft(7, {body: '短'}));
    await flush(SAVE_DELAY_MS + 10);
    expect(result.current?.save).toBe('saved');
  });

  it('網路錯誤:沒存到,過一下自己再試', async () => {
    adoptNote(asNote(server.note));
    server.next.push(500);
    const {result} = renderHook(() => useDraft(7));
    act(() => editDraft(7, {body: '網路閃一下'}));
    await flush(SAVE_DELAY_MS + 10);
    expect(result.current?.save).toBe('error');
    await flush(3_100);
    expect(result.current?.save).toBe('saved');
    expect(server.note.body).toBe('網路閃一下');
  });

  it('存的途中又打了字:那一份接著存,不會被剛回來的結果蓋成已儲存', async () => {
    adoptNote(asNote(server.note));
    const {result} = renderHook(() => useDraft(7));
    act(() => editDraft(7, {body: '第一段'}));
    await flush(SAVE_DELAY_MS + 1);
    act(() => editDraft(7, {body: '第一段 第二段'}));
    await flush(0);
    expect(result.current?.body).toBe('第一段 第二段');
    await flush(SAVE_DELAY_MS + 10);
    expect(server.note.body).toBe('第一段 第二段');
    expect(result.current?.save).toBe('saved');
  });

  it('慢網路:上一筆還沒回來就不送下一筆(不然帶著舊版本被回 409、吃掉剛打的字);回來後帶新版本補送', async () => {
    server.delayMs = 3000;
    vi.mocked(toastNotice).mockClear();
    adoptNote(asNote(server.note));
    const {result} = renderHook(() => useDraft(7));
    act(() => editDraft(7, {body: '第一段'}));
    await flush(SAVE_DELAY_MS + 1);
    expect(server.puts).toHaveLength(1);
    act(() => editDraft(7, {body: '第一段 第二段'}));
    await flush(SAVE_DELAY_MS + 1);
    // 第一筆還在路上:第二筆不能出去
    expect(server.puts).toHaveLength(1);
    await flush(3000 + SAVE_DELAY_MS + 3000 + 10);
    expect(server.puts).toHaveLength(2);
    expect(server.puts[1]).toMatchObject({title: '標題', body: '第一段 第二段', base_updated_at: 'v2'});
    expect(result.current?.save).toBe('saved');
    expect(toastNotice).not.toHaveBeenCalled();
  });

  it('登出清掉(換人登入看不到上一個人的草稿)', () => {
    adoptNote(asNote(server.note));
    clearDrafts();
    const {result} = renderHook(() => useDraft(7));
    expect(result.current).toBeUndefined();
  });
});
