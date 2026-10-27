/**
 * 個人筆記(側邊欄 Notes,`/notes`)的 API 與小工具。後端是 `app/routers/notebook.py`。
 *
 * 筆記是**私人的**,永遠不會送給 claude。
 * 從對話存的三種(反白一段、整題、截圖)都是「直接新增一則」;後端自己讀那一題,所以這裡只傳 qa id。
 *
 * 另有頁中頁與排序、複製一份、模板、編輯器格式 doc。
 * 刪除是丟進垃圾桶(30 天後後端清掉),刪除後的「復原」用 `restoreNote`。
 */
import {api} from './api';
import {httpStatus} from './errors';

const BASE = import.meta.env.VITE_API_BASE || '';

export type NoteKind = 'qa' | 'selection' | 'screenshot';

export type NoteSummary = {
  id: number;
  title: string;
  summary: string;
  source_kind: NoteKind | null;
  /** 內文裡有圖(自己寫的那幾則,清單列首用圖片圖示) */
  has_image: boolean;
  updated_at: string;
  /** 上一層(頁中頁);null = 最上層 */
  parent_id: number | null;
  /** 同一層裡的順序(小的在上面) */
  position: number | null;
  icon: string | null;
};

export type NoteAccess = 'owner' | 'edit' | 'view';
export type Crumb = {id: number; title: string; icon: string | null};

export type Note = {
  id: number;
  title: string;
  body: string;
  source_kind: NoteKind | null;
  source_conversation_id: string | null;
  source_qa_id: number | null;
  /** 原對話還看得到嗎;不是從對話存的 = null */
  source_available: boolean | null;
  created_at: string;
  updated_at: string;
  /** 編輯器格式(Tiptap JSON 文字);null = 舊筆記,從 body 讀 */
  doc: string | null;
  parent_id: number | null;
  icon: string | null;
  is_template: boolean;
  owner: string;
  /** 我對這頁能做什麼。筆記只有主人看得到,後端一律回 owner;Notes.tsx 用它決定唯讀與主人才有的操作 */
  access: NoteAccess;
  /** 上層一路到最上面(看得到的部分) */
  crumbs: Crumb[];
};

export const UNTITLED = '未命名';

export function noteTitle(title: string, untitled = UNTITLED): string {
  return title.trim() || untitled;
}

/** 左側清單上的標題:左側清單是英文(跟主側邊欄一樣),沒標題寫 Untitled */
export const listTitle = (title: string): string => noteTitle(title, 'Untitled');

export async function listNotes(q = ''): Promise<NoteSummary[]> {
  const res = await api.get<NoteSummary[]>('/api/notebook', {params: q.trim() ? {q: q.trim()} : undefined});
  return res.data;
}

export async function getNote(id: number): Promise<Note> {
  return (await api.get<Note>(`/api/notebook/${id}`)).data;
}

/** 自己寫的一則。可以指定上一層(子頁)、內容(內建模板)、自己存的模板 */
export async function createNote(
  init: {parent_id?: number | null; title?: string; body?: string; doc?: string | null; icon?: string | null; template_id?: number} = {},
): Promise<Note> {
  return (await api.post<Note>('/api/notebook', init)).data;
}

export async function listTemplates(): Promise<NoteSummary[]> {
  return (await api.get<NoteSummary[]>('/api/notebook/templates')).data;
}

/** 拖曳排序 / 拖進別頁(index = 新的那一層的第幾個) */
export async function moveNote(id: number, parentId: number | null, index: number): Promise<Note> {
  return (await api.post<Note>(`/api/notebook/${id}/move`, {parent_id: parentId, index})).data;
}

export async function duplicateNote(id: number): Promise<Note> {
  return (await api.post<Note>(`/api/notebook/${id}/duplicate`)).data;
}

export async function saveAsTemplate(id: number): Promise<NoteSummary> {
  return (await api.post<NoteSummary>(`/api/notebook/${id}/template`)).data;
}

export async function restoreNote(id: number): Promise<Note> {
  return (await api.post<Note>(`/api/notebook/${id}/restore`)).data;
}

/** 整題(問 + 答)存成一則 */
export async function saveQaToNotes(qaId: number): Promise<Note> {
  return (await api.post<Note>('/api/notebook', {source: {kind: 'qa', qa_id: qaId}})).data;
}

/** 反白的那一段存成一則 */
export async function saveSelectionToNotes(qaId: number, text: string): Promise<Note> {
  return (await api.post<Note>('/api/notebook', {source: {kind: 'selection', qa_id: qaId, text}})).data;
}

/** 那則回答的截圖存成一則:建筆記與存圖是同一個請求,中間斷掉不會留下一則空的 */
export async function saveScreenshotToNotes(qaId: number, png: Blob): Promise<Note> {
  const form = new FormData();
  form.append('qa_id', String(qaId));
  form.append('file', png, 'screenshot.png');
  return (await api.post<Note>('/api/notebook/screenshot', form)).data;
}

export async function updateNote(
  id: number,
  draft: {
    title?: string;
    body?: string;
    doc?: string;
    icon?: string;
    base_updated_at: string | null;
  },
): Promise<Note> {
  return (await api.put<Note>(`/api/notebook/${id}`, draft)).data;
}

/** 刪除(連子頁;後端是軟刪除);前端給「復原」 */
export async function deleteNote(id: number): Promise<void> {
  await api.delete(`/api/notebook/${id}`);
}

/** 貼上 / 拖進一張圖。回傳要寫進內文的那一段(`![](notebook-image:<id>)`) */
export async function uploadNoteImage(noteId: number, file: Blob): Promise<{id: string; ref: string}> {
  const form = new FormData();
  form.append('file', file, file instanceof File ? file.name : 'image.png');
  return (await api.post<{id: string; ref: string}>(`/api/notebook/${noteId}/images`, form)).data;
}

/** 這組對話裡我存過筆記的那幾題(書籤鈕實心) */
export async function savedQaIds(conversationId: string): Promise<number[]> {
  return (await api.get<number[]>('/api/notebook/saved', {params: {conversation_id: conversationId}})).data;
}

/** 筆記收的圖片種類(後端也只收這三種):貼上、拖進、「/」選單選圖都用它篩 */
export const NOTE_IMAGE_TYPE = /^image\/(png|jpeg|webp)$/;

/** 上傳回來的那一段(`![](notebook-image:<id>)`)→ 裡面的 `notebook-image:<id>`(編輯器的圖片節點要的是它) */
export function imageSrcOfRef(ref: string): string | null {
  return /\((notebook-image:[0-9a-f]{32})\)/.exec(ref)?.[1] ?? null;
}

/**
 * 內文裡的圖片(`notebook-image:<id>`)→ 真的網址。
 * 給 `<img src>` 用,不經 axios —— 後端收登入時發的 cookie(同 `lib/files.ts` 的說明)。
 * 不是筆記圖片的網址原樣回傳。
 */
export function noteImageSrc(src: string): string {
  const m = /^notebook-image:([0-9a-f]{32})$/.exec(src);
  return m ? `${BASE}/api/notebook/images/${m[1]}` : src;
}

/** 對話裡的錨點 id(`turn-12` 提問、`answer-12` 答案)→ 那一題的 id。不是這兩種就 null */
export function qaIdFromAnchor(anchorId: string): number | null {
  const m = /^(?:turn|answer)-(\d+)$/.exec(anchorId);
  return m ? Number(m[1]) : null;
}

/** 在游標那裡插一段(前後補空行,圖片才會自己成一段)。回傳新的全文與插完之後游標的位置 */
export function insertBlock(text: string, start: number, end: number, block: string): {text: string; caret: number} {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = after.startsWith('\n') ? '' : '\n';
  const inserted = `${lead}${block}${tail}`;
  return {text: before + inserted + after, caret: before.length + inserted.length};
}

/**
 * 存失敗的那一句。⚠️ **不用 `errorMessage` 拿後端的 detail**:後端那幾句是中文(「筆記已經有 1000 則」),
 * 而對話頁照全站慣例是英文。照狀態碼各給一句。
 * 放在這裡而不是 `components/SaveToNotes.tsx`:測試載入那個元件要十幾秒,整套一起跑會逾時。
 */
export function saveErrorMessage(err: unknown): string {
  // 看名字不看 instanceof:那個類別在 lazy 載入的那包裡,這裡不 import 它
  if ((err as Error)?.name === 'ScreenshotError') return 'Could not take the screenshot. Please try again.';
  const status = httpStatus(err);
  if (status === 404) return 'This answer is no longer available.';
  // 413 可能是則數滿了,也可能是截圖太大 / 圖片總量滿了 —— 不分開講
  if (status === 413) return 'Could not save: your notes are over the limit.';
  if (status === 415) return 'Could not take the screenshot. Please try again.';
  return 'Could not save to notes. Please try again.';
}
