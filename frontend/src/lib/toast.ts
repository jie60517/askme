/**
 * 全站的提示。
 *
 * 「靜默失敗只用在加值功能(通知輪詢、主題同步、檔案清單);使用者主動觸發的
 * 動作(送便條、分享、刪除)失敗一定要提示。」
 *
 * **不用設計系統的 Toast**:全站提示跟附件通知
 * 長得一樣(白卡、左邊圖示、灰字,`components/NoticeCard.tsx`)。設計系統的 Toast
 * 是整塊反白主題(MediaTheme 深色),從外面蓋不回白卡,所以佇列與計時自己管,
 * 畫在 `components/NoticeStack.tsx`(App 掛一份)。
 *
 * 這裡是**模組層的 store**:要報錯的地方有一半不是元件(`lib/runs.ts` 的停止、
 * Sidebar 一堆 catch),直接呼叫 toastError() 就好,不用 hook。
 * 還沒有人畫的時候發生的也會留在佇列裡,NoticeStack 一掛上就看得到。
 *
 * 保留設計系統 Toast 原本的行為:
 *  - 同一個 `uniqueID` 再發一次是**換掉**那一則(預設),或忽略(`collision: 'ignore'`);
 *  - 失敗不會自己消失(5 秒後自己不見等於沒報),要按 ×;
 *  - 指標停在卡上、或視窗切到別的地方時暫停倒數;
 *  - 同時最多 5 則(`MAX_NOTICES`)。
 * 跟設計系統不一樣的一處:會自己消失的那幾則**不畫 ×**(跟附件卡一樣)。
 */
/**
 * 退場佔多久:收掉一則時先掛「退場中」讓 CSS 淡出,這麼久之後才真的從清單拿掉。
 * 全站提示與輸入框旁的附件通知共用(`useComposerAttachments.ts`)。
 * ⚠️ 要跟 global.css `[data-notice]` 的 `transition-duration`(`--duration-medium-min`,
 * 實際 225ms)同一階 —— 短了會淡到一半被拔掉,長了會在畫面上多停一段。
 */
export const NOTICE_EXIT_MS = 225;

/** 綠勾 = 完成、紅叉 = 失敗、藍 i = 單純告知(跟附件卡同一組三色) */
export type NoticeKind = 'success' | 'error' | 'info';

/** 卡片右邊那顆鈕(Undo / Open / 復原 / 重新整理) */
export type NoticeAction = {
  label: string;
  onClick: () => void;
  /** 按下去就轉圈並停用(「重新整理」:reload 不回 promise,而且要擋連按) */
  showsLoading?: boolean;
};

export type Notice = {
  id: number;
  kind: NoticeKind;
  text: string;
  action?: NoticeAction;
  /** 不會自己消失 —— 卡上畫 × */
  isPersistent: boolean;
  /** 正在退場(最後那 NOTICE_EXIT_MS):畫的那邊掛 `data-leaving` */
  isLeaving?: boolean;
};

export type NoticeOptions = {
  text: string;
  kind?: NoticeKind;
  action?: NoticeAction;
  uniqueID?: string;
  /** 幾毫秒後消失;`null` = 不自己消失。預設:失敗 null、其他 5 秒 */
  autoHideMs?: number | null;
  collision?: 'overwrite' | 'ignore';
};

const DEFAULT_HIDE_MS = 5000;
/**
 * 同時最多幾則(設計系統 ToastViewport 的 `maxVisible` 預設也是 5)。
 * 多出來時收掉**最舊的、會自己消失的**那一則;失敗與「有新版本」這種要人處理的不會被擠掉。
 */
export const MAX_NOTICES = 5;

type Entry = Notice & {key?: string};
/**
 * 一則的倒數。`holds` 是「為什麼暫停」:指標 / 焦點停在卡上(`card`)、
 * 視窗不在前景(`window`,設計系統 Toast 原本就這樣:切去別的視窗回來,提示不該已經不見)。
 * 兩個理由各自放開,全部放開才接著倒。
 */
type Timer = {
  handle?: ReturnType<typeof setTimeout>;
  remaining: number;
  startedAt: number;
  holds: Set<'card' | 'window'>;
};

let seq = 0;
let notices: readonly Entry[] = [];
const timers = new Map<number, Timer>();
/** 退場那 225ms 的計時器也要記著 —— 測試重置時要一起清,不然會刪到下一條測試裡同 id 的那則 */
const exitTimers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let isWindowAway = false;

function commit(next: readonly Entry[]) {
  notices = next;
  for (const fn of listeners) fn();
}

/** useSyncExternalStore 用 */
export function subscribeNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getNotices(): readonly Notice[] {
  return notices;
}

function stopTimer(id: number) {
  const t = timers.get(id);
  if (t?.handle) clearTimeout(t.handle);
  timers.delete(id);
}

function run(id: number, t: Timer) {
  t.startedAt = Date.now();
  t.handle = setTimeout(() => dismissNotice(id), t.remaining);
}

/** 開始(或重新開始)倒數。暫停中的理由保留 —— 卡在指標底下被換掉,不能因此就被收走 */
function arm(id: number, ms: number) {
  const prev = timers.get(id);
  if (prev?.handle) clearTimeout(prev.handle);
  const holds = new Set(prev?.holds ?? []);
  if (isWindowAway) holds.add('window');
  const t: Timer = {remaining: ms, startedAt: Date.now(), holds};
  timers.set(id, t);
  if (holds.size === 0) run(id, t);
}

function hold(id: number, why: 'card' | 'window') {
  const t = timers.get(id);
  if (!t || t.holds.has(why)) return;
  if (t.holds.size === 0) {
    if (t.handle) clearTimeout(t.handle);
    t.handle = undefined;
    t.remaining = Math.max(t.remaining - (Date.now() - t.startedAt), 1000);
  }
  t.holds.add(why);
}

function release(id: number, why: 'card' | 'window') {
  const t = timers.get(id);
  if (!t || !t.holds.delete(why)) return;
  if (t.holds.size === 0) run(id, t);
}

/** 收掉一則:先掛退場讓它淡出,淡完才從清單拿掉 */
export function dismissNotice(id: number) {
  stopTimer(id);
  if (!notices.some((n) => n.id === id && !n.isLeaving)) return;
  commit(notices.map((n) => (n.id === id ? {...n, isLeaving: true} : n)));
  exitTimers.set(
    id,
    setTimeout(() => {
      exitTimers.delete(id);
      commit(notices.filter((n) => n.id !== id));
    }, NOTICE_EXIT_MS),
  );
}

/** 指標 / 焦點停在卡上:倒數暫停(看字、按 Undo 的時候不要被收走) */
export function pauseNotice(id: number) {
  hold(id, 'card');
}
export function resumeNotice(id: number) {
  release(id, 'card');
}

/** 視窗切走 / 回來(NoticeStack 掛 window 的 blur / focus) */
export function setWindowAway(away: boolean) {
  if (isWindowAway === away) return;
  isWindowAway = away;
  for (const id of [...timers.keys()]) {
    if (away) hold(id, 'window');
    else release(id, 'window');
  }
}

export function showNotice(options: NoticeOptions): void {
  const kind = options.kind ?? 'success';
  const hideMs = options.autoHideMs === undefined ? (kind === 'error' ? null : DEFAULT_HIDE_MS) : options.autoHideMs;
  const fields = {kind, text: options.text, action: options.action, isPersistent: hideMs === null};

  const same = options.uniqueID
    ? notices.find((n) => n.key === options.uniqueID && !n.isLeaving)
    : undefined;
  if (same) {
    if (options.collision === 'ignore') return;
    // 換掉原地那一則:位置不跳、不重演進場,倒數重來
    commit(notices.map((n) => (n.id === same.id ? {...n, ...fields} : n)));
    if (hideMs === null) stopTimer(same.id);
    else arm(same.id, hideMs);
    return;
  }

  const id = ++seq;
  commit([...notices, {id, key: options.uniqueID, ...fields}]);
  if (hideMs !== null) arm(id, hideMs);

  const live = notices.filter((n) => !n.isLeaving);
  if (live.length > MAX_NOTICES) {
    const oldest = live.find((n) => !n.isPersistent);
    if (oldest) dismissNotice(oldest.id);
  }
}

/** 動作失敗。不會自己消失,要使用者按 × */
export function toastError(message: string, uniqueID?: string) {
  showNotice({text: message, kind: 'error', uniqueID});
}

/** 完成了(存好了、送出了、複製了)。5 秒後自己消失 */
export function toastInfo(message: string, uniqueID?: string) {
  showNotice({text: message, kind: 'success', uniqueID});
}

/** 單純告知,不是誰做完了什麼(「正在復原…」「別的地方改過了」)。藍 i,5 秒 */
export function toastNotice(message: string, uniqueID?: string) {
  showNotice({text: message, kind: 'info', uniqueID});
}

/**
 * 帶一顆動作鈕的完成回報(例如「已刪除 …  復原」)。
 * 多留幾秒讓人來得及按(預設 8 秒);按了之後用**同一個 uniqueID** 再發一則,就會把這則換掉,
 * 不會疊兩則。
 */
export function toastWithAction(message: string, action: NoticeAction, uniqueID: string, autoHideMs = 8000) {
  showNotice({text: message, kind: 'success', action, uniqueID, autoHideMs});
}

/** 測試用:清掉所有提示與計時 */
export function resetNoticesForTest() {
  for (const id of [...timers.keys()]) stopTimer(id);
  for (const handle of exitTimers.values()) clearTimeout(handle);
  exitTimers.clear();
  isWindowAway = false;
  notices = [];
}
