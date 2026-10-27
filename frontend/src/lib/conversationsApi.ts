/**
 * 對話清單、搜尋、改名、刪除、資料夾。
 */
import {api} from './api';
import {forgetConversation} from './chatApi';

export type ConversationSummary = {
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
  /** 伺服器判斷的「這組還有題目在跑」—— 換一台電腦也看得到 */
  running: boolean;
  /** 別人分享給我的 */
  shared_with_me: boolean;
  shared_by: string | null;
  /** 我分享出去的(自己的對話才會是 true) */
  shared_out: boolean;
  /** @ 我而我還沒讀的則數 */
  unread_mentions: number;
  /** 共用成員顯示名稱,擁有者排第一 */
  share_members: string[];
};

export type SearchHit = {
  conversation_id: string;
  title: string;
  updated_at: string;
  snippet: string;
};

export type Folder = {id: number; name: string; parent_id: number | null};
export type FoldersOut = {
  folders: Folder[];
  /** conversation_id → folder_id;沒歸類的不在裡面 */
  items: Record<string, number>;
};

export const CONVERSATIONS_UPDATED = 't100:conversations-updated';

export function notifyConversationsUpdated() {
  window.dispatchEvent(new Event(CONVERSATIONS_UPDATED));
}

/**
 * 上一次拿到的對話清單。
 *
 * 側邊欄一載入就會問一次,所以命令面板不必自己再等一支請求就有東西可以先畫
 * (見 `peekConversations`)。
 *
 * ⚠️ **這是「這個人的」資料,登出一定要清**(`resetConversationsCache`,
 * 由 `signOut()` 叫)。模組層的東西活得比頁面久 —— 登出不重新整理頁面,
 * 不清的話同一個分頁換一個人登入,面板一打開鋪上去的是**上一個人的對話標題**。
 * 規矩跟 `peopleDirectory` 一樣:有全域狀態就要有清掉它的那一支。
 * ⚠️ 形狀像 `chatApi` 的 `peekAllowedModels()`,但**生命週期不一樣**:那邊裝的是
 * `/api/config` 的全站設定,換人登入照樣成立,所以它不需要清。不要照抄它的處置。
 */
let lastList: ConversationSummary[] = [];

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await api.get<ConversationSummary[]>('/api/conversations');
  lastList = res.data;
  return res.data;
}

/**
 * 上一次問到的那份,**不會自己去問**。
 *
 * 搜尋面板用它把清單**當下**就畫出來:真的去等一支請求的話,第一次打開會先閃一下
 * 空面板再跳出清單。還沒問過就是空陣列,那時候面板自己會去問
 * (見 `CommandPalette.tsx` 的搜尋 effect)。
 * ⚠️ 面板打字之後的本地標題過濾也是讀這裡 —— **它篩的不是側邊欄的 `merged`**,
 * 所以剛按下送出、還沒落地的那組對話在面板裡搜不到。已知落差,不是 bug。
 */
export function peekConversations(): ConversationSummary[] {
  return lastList;
}

/** 登出時清掉(見 `lastList` 上面那段)。`signOut()` 會叫它,不要漏。 */
export function resetConversationsCache(): void {
  lastList = [];
}

export async function searchConversations(q: string): Promise<SearchHit[]> {
  const res = await api.get<SearchHit[]>('/api/conversations/search', {params: {q}});
  return res.data;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await api.patch(`/api/conversations/${id}`, {title});
}

export async function deleteConversation(id: string): Promise<void> {
  await api.delete(`/api/conversations/${id}`);
  // 對話頁的快取(`chatApi`)也要忘掉:不然按上一頁回去,先畫出來的是已刪的內容
  forgetConversation(id);
}

export async function listFolders(): Promise<FoldersOut> {
  const res = await api.get<FoldersOut>('/api/folders');
  return res.data;
}

export async function markConversationRead(id: string): Promise<number> {
  const res = await api.post<{marked: number}>(`/api/conversations/${id}/mentions/read`);
  return res.data.marked;
}

// ── 分組 ────────────────────────────────────────────────────────────────────

/** 一則還沒彈過的 @ 提及(小夥伴輪詢拿到的)。 */
export type PendingMention = {
  id: number;
  created_at: string;
  conversation_id: string;
  author_name: string;
  /** 已經把他自己那個 @token 拿掉了(後端做的:氣泡上再唸一次自己的帳號只是佔寬度) */
  body: string;
};

/**
 * 小夥伴輪詢一次拿到的東西。
 *
 * `announce` 是「還沒彈過的」,`unread` 是「還沒讀的則數」——
 * **兩者不一樣**:氣泡跳完 `unread` 還是留著,直到他真的打開那組對話。
 */
export type MentionPoll = {
  announce: PendingMention[];
  unread: number;
};

export async function getPendingMentions(): Promise<MentionPoll> {
  const res = await api.get<MentionPoll>('/api/mentions/pending');
  return res.data;
}

/**
 * 「這幾則已經彈過了,下次不要再講一次」。
 *
 * ⚠️ **這不是「已讀」** —— 未讀數不會因此變少,他還沒真的去看。
 * ⚠️ **講完一則才回報一則**,不要一次標掉整批 ——
 * 一次標掉的話第三則要等 12 秒才輪到,而使用者提早關掉分頁就永遠聽不到那一則,
 * 但伺服器已經記成「講過了」。
 */
export async function markMentionsAnnounced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await api.post('/api/mentions/announced', {ids});
}

export type ConversationSplit = {
  /** 別人分享給我的 + 我分享出去的 */
  shared: ConversationSummary[];
  /** 沒歸資料夾、也不是共用的 */
  personal: ConversationSummary[];
};

/**
 * 分兩堆:共用、個人。
 *
 * 不照 updated_at 分今天/昨天/7 天/更早 —— 一個人累積幾十組對話之後,
 * 那些時間標題會變成四個永遠都在的小標,而「這是三天前還是五天前問的」
 * 其實沒人在意。一個 Personal 節點收起來,要找特定一組用搜尋。
 */
export function splitConversations(
  list: ConversationSummary[],
  inFolder: (id: string) => boolean = () => false,
): ConversationSplit {
  const shared: ConversationSummary[] = [];
  const personal: ConversationSummary[] = [];
  for (const c of list) {
    // 資料夾優先。歸過檔的對話就算被分享了也留在資料夾裡 ——
    // 使用者自己分的類比系統的自動分類重要,而且一份對話只能出現在一個地方,
    // 兩邊都放會變成同一組對話有兩列。
    if (inFolder(c.conversation_id)) continue;
    if (c.shared_with_me || c.shared_out) shared.push(c);
    else personal.push(c);
  }
  return {shared, personal};
}

/**
 * 還在跑、但伺服器清單還沒有的對話,用問題本身當標題補上去 ——
 * 剛送出的第一題,清單要等下一次輪詢才會有,中間那段空窗使用者會以為沒送出去。
 */
export function withPendingConversations(
  list: ConversationSummary[],
  pending: Array<{conversationId: string; question: string; startedAt: number}>,
): ConversationSummary[] {
  const known = new Set(list.map((c) => c.conversation_id));
  const extra = pending
    .filter((p) => !known.has(p.conversationId))
    .map<ConversationSummary>((p) => ({
      conversation_id: p.conversationId,
      title: p.question,
      created_at: new Date(p.startedAt).toISOString(),
      updated_at: new Date(p.startedAt).toISOString(),
      turn_count: 1,
      running: true,
      shared_with_me: false,
      shared_by: null,
      shared_out: false,
      unread_mentions: 0,
      share_members: [],
    }));
  return [...extra, ...list];
}

// ── 資料夾 ──────────────────────────────────────────────────────────────────

export async function createFolder(name: string, parentId?: number | null): Promise<Folder> {
  const res = await api.post<Folder>('/api/folders', {name, parent_id: parentId ?? null});
  return res.data;
}

export async function renameFolder(id: number, name: string): Promise<void> {
  await api.patch(`/api/folders/${id}`, {name});
}

/** 把資料夾搬到別的資料夾底下;`parentId` 給 null 就是移回頂層。 */
export async function setFolderParent(id: number, parentId: number | null): Promise<void> {
  // 後端自己也擋環狀(folders.py 的 _would_cycle),前端擋是為了不要先壞給使用者看
  await api.patch(`/api/folders/${id}`, {parent_id: parentId});
}

export async function deleteFolder(id: number): Promise<void> {
  await api.delete(`/api/folders/${id}`);
}

/** folderId 給 null 就是移回未歸類。 */
export async function setConversationFolder(
  conversationId: string,
  folderId: number | null,
): Promise<void> {
  await api.put(`/api/conversations/${conversationId}/folder`, {folder_id: folderId});
}

export type FolderTree = Folder & {children: FolderTree[]};

/**
 * 資料夾樹(遞迴,`FolderNode`)。
 *
 * 兩種壞資料都要撐住,不能讓側邊欄整個畫不出來:
 *   - `parent_id` 指向不存在的資料夾 → 當頂層(輪詢時序會有這種空窗)
 *   - 環狀(A 的父是 B、B 的父是 A)→ 從環裡拉一個出來當頂層。
 *     前端建立時有 `wouldCycle()` 擋,但別的客戶端或直接改資料庫都可能生出環,
 *     沒擋的話這裡會無限遞迴、整頁當掉。
 */
export function buildFolderTree(folders: Folder[]): FolderTree[] {
  const known = new Map(folders.map((f) => [f.id, f]));

  /** 從某個節點往上爬,爬得到根就不是環 */
  const isReachableRoot = (start: Folder): boolean => {
    const seen = new Set<number>([start.id]);
    let parent = start.parent_id;
    while (parent !== null) {
      if (seen.has(parent)) return false;
      seen.add(parent);
      const next = known.get(parent);
      if (!next) return true; // 父不存在 → 當頂層,不是環
      parent = next.parent_id;
    }
    return true;
  };

  const byParent = new Map<number | null, Folder[]>();
  for (const f of folders) {
    const hasLiveParent = f.parent_id !== null && known.has(f.parent_id);
    const parent = hasLiveParent && isReachableRoot(f) ? f.parent_id : null;
    const list = byParent.get(parent) ?? [];
    list.push(f);
    byParent.set(parent, list);
  }

  const build = (f: Folder): FolderTree => ({
    ...f,
    children: (byParent.get(f.id) ?? []).map(build),
  });
  return (byParent.get(null) ?? []).map(build);
}

/**
 * 把 `folder` 搬到 `target` 底下會不會形成環。
 * 前端先擋:後端擋不擋是它的事,但這裡不擋的話畫面會先壞給使用者看。
 */
export function wouldCycle(folders: Folder[], folderId: number, targetId: number | null): boolean {
  if (targetId === null) return false;
  if (folderId === targetId) return true;
  const known = new Map(folders.map((f) => [f.id, f]));
  const seen = new Set<number>();
  let parent: number | null = targetId;
  while (parent !== null) {
    if (parent === folderId) return true;
    if (seen.has(parent)) return true;
    seen.add(parent);
    parent = known.get(parent)?.parent_id ?? null;
  }
  return false;
}

// ── 共用 ────────────────────────────────────────────────────────────────────

export type ShareablePerson = {
  username: string;
  display_name: string;
  /**
   * 畫面上的職稱。**它同時決定權限**(Consultant = 唯讀、
   * Software engineer = 完整),見 `adminApi.roleGrantsFull`。
   */
  role: string;
  /**
   * 他的頭像(data URI)。null = 沒設過,畫面上顯示名字縮寫。
   * 共用對話裡其他成員的頭像就是從這裡來的。
   */
  avatar?: string | null;
};
export type ShareEntry = {username: string; display_name: string; shared_by: string | null};

/** 可以分享的對象。清單排除自己,所以「查不到自己」是正常的。 */
export async function listShareableUsers(): Promise<ShareablePerson[]> {
  const res = await api.get<ShareablePerson[]>('/api/shareable-users');
  return res.data;
}

export async function shareConversation(
  conversationId: string,
  usernames: string[],
): Promise<ShareEntry[]> {
  const res = await api.post<ShareEntry[]>(`/api/conversations/${conversationId}/share`, {
    usernames,
  });
  return res.data;
}

/**
 * 把一個人從共用名單上拿掉。
 *
 * ⚠️ 這支跟「離開共用」(`deleteConversation`)是兩件事,不要互相代用:
 * 這支是**別人**把他拿掉,那支是**他自己**走。後端兩邊都認,但稽核紀錄
 * 與可不可以再被加回來不一樣。
 */
export async function unshareConversation(
  conversationId: string,
  username: string,
): Promise<void> {
  await api.delete(`/api/conversations/${conversationId}/share/${encodeURIComponent(username)}`);
}
