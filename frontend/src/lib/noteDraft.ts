/**
 * 筆記頁的自動儲存:
 * 停手 `SAVE_DELAY_MS` 存一次(整則覆蓋)、沒存到自己再試、離開頁面用 `keepalive` 補送、登出清掉。
 *
 * 另外要處理的一件事:**兩個分頁同時改同一則**(409)。每次存都帶著「我手上是哪一版」
 * (`base` = 伺服器上次回給我的 `updated_at`),對不上後端回 409 —— 這時候換成伺服器那一版、跳一則 toast,
 * 不要把別的分頁剛存的內容蓋掉。代價是這個分頁最後那一兩秒打的字不見(兩邊同時改同一則本來就少見)。
 *
 * 狀態是模組層的一份(以筆記 id 為鍵),不是元件自己的 state:切到別則再切回來,還沒存完的字還在。
 */
import {useCallback, useSyncExternalStore} from 'react';

import {getToken} from './auth';
import {httpStatus} from './errors';
import {getNote, updateNote, type Note} from './notebookApi';
import {toastNotice} from './toast';

/** 停手多久存一次 */
export const SAVE_DELAY_MS = 1000;
/** 沒存到時多久再試一次 */
export const SAVE_RETRY_MS = 3000;

/**
 * saved:伺服器上就是畫面上這份;dirty:還沒送;saving:送出去了;
 * error:沒存到(`SAVE_RETRY_MS` 後再試);too-big:超過上限(413,不重試 —— 再送一次也一樣)
 */
export type DraftSave = 'saved' | 'dirty' | 'saving' | 'error' | 'too-big';
/**
 * 一則筆記手上的那一份。title / body 之外:
 * doc = 編輯器格式(Tiptap JSON 文字,null = 舊筆記還沒有,從 body 讀);icon = 頁面圖示。
 * (後端的封面、全寬兩欄前端不用:草稿不帶、存的時候不送,後端維持原值。)
 * **全部走同一條存檔**:另外送一筆的話會把 updated_at 往前推,下一次存內文就 409。
 */
export type Draft = {
  title: string;
  body: string;
  doc: string | null;
  icon: string | null;
  base: string | null;
  save: DraftSave;
};
export type DraftPatch = Partial<Pick<Draft, 'title' | 'body' | 'doc' | 'icon'>>;

/** 伺服器那一則 → 草稿 */
function fromNote(note: Note): Draft {
  return {
    title: note.title,
    body: note.body,
    doc: note.doc ?? null,
    icon: note.icon ?? null,
    base: note.updated_at,
    save: 'saved',
  };
}

/** 兩份一樣嗎(送出去之後有沒有又改過) */
function sameContent(a: Draft, b: Draft): boolean {
  return a.title === b.title && a.body === b.body && a.doc === b.doc && a.icon === b.icon;
}

/** 送到後端的那一包(icon 送空字串 = 拿掉;doc 沒有就不送,舊筆記不會被清成空的) */
function payload(d: Draft) {
  return {
    title: d.title,
    body: d.body,
    ...(d.doc !== null ? {doc: d.doc} : {}),
    icon: d.icon ?? '',
    base_updated_at: d.base,
  };
}

const drafts = new Map<number, Draft>();
const listeners = new Map<number, Set<() => void>>();
const timers = new Map<number, number>();
/**
 * 正在送的那幾則。**同一則一次只送一筆**:上一筆還沒回來就送下一筆的話,
 * 下一筆帶的 `base` 還是舊的,後端回 409 —— 畫面被換成伺服器那一版、最後打的字不見、還跳「別的地方改過了」。
 * 網路來回超過 `SAVE_DELAY_MS` 就會發生。上一筆回來時看到又改過,自己會再排一次。
 */
const inFlight = new Set<number>();
const savedListeners = new Set<(note: Note) => void>();

function emit(id: number, next: Draft) {
  drafts.set(id, next);
  listeners.get(id)?.forEach((fn) => fn());
}

/** 頁面讀到伺服器那一則。手上有還沒存的字就不換 —— 以畫面上的為準 */
export function adoptNote(note: Note) {
  const cur = drafts.get(note.id);
  if (cur && cur.save !== 'saved') return;
  if (cur && cur.base === note.updated_at) return;
  emit(note.id, fromNote(note));
}

async function save(id: number) {
  timers.delete(id);
  if (inFlight.has(id)) return; // 上一筆回來時看到 dirty 會再排一次(下面成功那段)
  const sent = drafts.get(id);
  if (!sent) return;
  inFlight.add(id);
  try {
    await send(id, sent);
  } finally {
    inFlight.delete(id);
  }
}

async function send(id: number, sent: Draft) {
  emit(id, {...sent, save: 'saving'});
  try {
    const note = await updateNote(id, payload(sent));
    const now = drafts.get(id);
    if (!now) return; // 登出清掉了
    // 送出去之後又打了字:那一份還在等下一次存,只換掉 base
    const unchanged = sameContent(now, sent);
    emit(id, {...now, base: note.updated_at, save: unchanged ? 'saved' : now.save === 'saving' ? 'dirty' : now.save});
    if (!unchanged && !timers.has(id)) timers.set(id, window.setTimeout(() => void save(id), SAVE_DELAY_MS));
    savedListeners.forEach((fn) => fn(note));
  } catch (err) {
    const now = drafts.get(id);
    if (!now) return;
    if (httpStatus(err) === 409) {
      // 別的分頁 / 別台電腦先存過了:換成那一版
      window.clearTimeout(timers.get(id));
      timers.delete(id);
      try {
        const fresh = await getNote(id);
        emit(id, fromNote(fresh));
        savedListeners.forEach((fn) => fn(fresh));
      } catch {
        emit(id, {...now, save: 'error'});
      }
      toastNotice('這則筆記在別的地方改過了,已換成最新的版本', `note-conflict-${id}`);
      return;
    }
    if (httpStatus(err) === 413) {
      emit(id, {...now, save: 'too-big'});
      return;
    }
    if (httpStatus(err) === 404) {
      // 被刪掉了(別的分頁):不再重試
      drafts.delete(id);
      return;
    }
    emit(id, {...now, save: 'error'});
    if (!timers.has(id)) timers.set(id, window.setTimeout(() => void save(id), SAVE_RETRY_MS));
  }
}

/** 打字:改這一則、重新計時 */
export function editDraft(id: number, patch: DraftPatch) {
  const cur = drafts.get(id);
  if (!cur) return;
  emit(id, {...cur, ...patch, save: 'dirty'});
  window.clearTimeout(timers.get(id));
  timers.set(id, window.setTimeout(() => void save(id), SAVE_DELAY_MS));
}

/** 現在就存(切到別則、離開編輯時):有在等的才送 */
export function flushDraft(id: number) {
  if (!timers.has(id)) return;
  window.clearTimeout(timers.get(id));
  void save(id);
}

/** 刪掉之後:這一則不用再存了 */
export function forgetDraft(id: number) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  drafts.delete(id);
}

/** 還有沒存完的嗎(`unsavedWork` 的忙碌來源:舊版網頁不要趁這時候自己換新) */
export function hasUnsavedDrafts(): boolean {
  for (const d of drafts.values()) if (d.save !== 'saved') return true;
  return false;
}

/** 存好了一則(清單要跟著換標題、排到最上面) */
export function onDraftSaved(fn: (note: Note) => void): () => void {
  savedListeners.add(fn);
  return () => {
    savedListeners.delete(fn);
  };
}

/** 登出(`loginApi.signOut`):這是上一個人的筆記,整個清掉。還沒存的字送不出去了(token 已經清掉) */
export function clearDrafts() {
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
  const ids = [...drafts.keys()];
  drafts.clear();
  for (const id of ids) listeners.get(id)?.forEach((fn) => fn());
}

/**
 * `keepalive` 的請求本文上限(瀏覽器規定,所有還在送的 keepalive 加起來 64 KiB)。筆記上限是 200 KB,
 * 大的那幾則關分頁時補送不出去 —— 那種就在離開前讓瀏覽器問一聲(`beforeunload`),不要安靜地丟字。
 */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

function leavePayload(d: Draft): string {
  return JSON.stringify(payload(d));
}

/** 有沒有關分頁時補送不了的(還沒存、又大過 keepalive 上限) */
function hasUnflushableDraft(): boolean {
  for (const d of drafts.values()) {
    if (d.save !== 'saved' && new Blob([leavePayload(d)]).size > KEEPALIVE_MAX_BYTES) return true;
  }
  return false;
}

/** 離開頁面:還在等的那幾則馬上送(`keepalive` 讓瀏覽器在分頁關掉之後把它送完) */
function flushOnLeave() {
  for (const [id, timer] of timers) {
    window.clearTimeout(timer);
    const d = drafts.get(id);
    if (!d) continue;
    const body = leavePayload(d);
    // 太大的照樣送(分頁沒真的關、只是換頁的話還是送得到),只是不能 keepalive —— 帶了會直接失敗
    fetch(`${import.meta.env.VITE_API_BASE || ''}/api/notebook/${id}`, {
      method: 'PUT',
      keepalive: new Blob([body]).size <= KEEPALIVE_MAX_BYTES,
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${getToken() || ''}`},
      body,
    }).catch(() => {
      // 送不出去就算了:畫面上「已儲存」那個字本來就還沒出現
    });
  }
  timers.clear();
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushOnLeave);
  window.addEventListener('beforeunload', (e) => {
    if (hasUnflushableDraft()) e.preventDefault();
  });
}

/** 這一則的草稿(頁面先 `adoptNote` 過才會有;還沒讀到是 undefined) */
export function useDraft(id: number): Draft | undefined {
  const subscribe = useCallback(
    (fn: () => void) => {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    [id],
  );
  return useSyncExternalStore(subscribe, () => drafts.get(id));
}
