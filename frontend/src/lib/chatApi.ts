/**
 * 問答頁要用到的 API。
 */
import {api} from './api';
import {getToken} from './auth';

export type KnowledgeBase = {
  id: string;
  label: string;
  suggestions: string[];
  /**
   * 這個環境預設用哪個模型(選填;後端已對過白名單)。優先序排在「這組對話手動選的」之後、
   * 「個人常用」之前(`pickModel`)。
   */
  default_model?: string | null;
};

export type AppConfig = {
  default_model: string;
  allowed_models: string[];
  knowledge_bases: KnowledgeBase[];
  default_knowledge_base: string;
  /** 單檔上限,0 = 不限制 */
  max_upload_mb: number;
  max_concurrent_asks: number;
};

export type HistoryItem = {
  id: number;
  created_at: string;
  session_id: string;
  question: string;
  answer: string;
  output_files: string | null;
  /**
   * 這一題**送出時附上去的檔案**(逗號分隔,存在 uploads/{session_id})。
   * 訊息串上把它們畫成一排 Token(設計系統的 ai-chat 範本的畫法)。
   */
  uploaded_filename: string | null;
  /** JSON 陣列字串,解析後才是「參考來源」 */
  sources: string | null;
  /**
   * 整題跑了多久。**最後一步的耗時**要靠它當結束點
   *(中間幾步是相鄰兩筆的 `at_ms` 相減)。
   * null = 沒有記錄,那一則就沒有耗時可顯示。
   */
  duration_ms?: number | null;
  knowledge_base: string | null;
  /** running = 這題還在跑(可能是別的分頁、甚至別台電腦送出的) */
  status: string;
  success: boolean;
  error: string | null;
  asked_by: string | null;
  asked_by_name: string | null;
  /**
   * Work Flow 通知寫進去的「這次的結果」。對話頁不畫,只畫那則 @ 便條。
   * 紀錄本身仍在:對話清單靠它、追問時是 AI 的前情提要(後端 `_post_note`)。
   */
  is_workflow_result?: boolean;
};

/**
 * 正在飛的那一次 `/api/config`。**這不是快取** —— 請求一結束(成功或失敗)就丟掉,
 * 所以每一次新的呼叫照樣重新問。它只把**同時**發生的那幾次合併成一個請求。
 *
 * 為什麼需要:側邊欄掛載時會預熱模型清單,而問答頁也會在同一瞬間問一次 config
 * —— 兩邊各打一次同一個端點。合併之後一次進站只有一個請求,
 * 而「不快取」那條規則(知識庫會改名,見 `lib/knowledgeBase.ts` 開頭)原封不動:
 * 下一次呼叫仍然會去問。
 */
let configInFlight: Promise<AppConfig> | null = null;

/** 已經問到的模型清單。**同步**讀得到 —— 見 `peekAllowedModels()`。 */
let allowedModelsValue: string[] | null = null;

/**
 * 上一次問到的設定(見 `peekConfig()`)。**帶著是誰問的**:專案清單、可用模型因人而異,
 * 換人登入(不重新整理)時不能先畫上一個人的那份。
 */
let configValue: {token: string | null; value: AppConfig} | null = null;

/**
 * 上一次問到的設定,**同步**讀得到;還沒問過是 null。
 *
 * 對話頁每換一組都重掛(`App.tsx` 的 key);每次都從 null 開始等 `/api/config` 的話,
 * 專案、模型按鈕在那段時間畫不出來,New chat ↔ 對話的過場拍到的終點畫面就少了它們,
 * 過場演完才冒出來、後面的按鈕整排位移。
 * 先用這份畫,背景照樣重問一次(`getConfig()`),設定改了下一格就換上。
 */
export function peekConfig(): AppConfig | null {
  return configValue && configValue.token === getToken() ? configValue.value : null;
}

export function getConfig(): Promise<AppConfig> {
  configInFlight ??= api
    .get<AppConfig>('/api/config')
    .then((res) => {
      // 順手把模型清單記下來 —— 誰問到的都算,見 `getAllowedModels()`
      allowedModelsValue = res.data.allowed_models;
      configValue = {token: getToken(), value: res.data};
      return res.data;
    })
    .finally(() => {
      configInFlight = null;
    });
  return configInFlight;
}

/**
 * 可選模型清單(`allowed_models`)。**問到過就不再問**。
 *
 * ⚠️ 只有這一個欄位會被留下來,`getConfig()` 仍然每次都問 —— 知識庫是會改名的
 * (`lib/knowledgeBase.ts` 開頭那段講的就是這件事),而模型清單只有在改後端的
 * 環境變數 + 重開服務之後才會變,重新整理一次就跟上。
 *
 * 為什麼要留:個人設定那排 `SegmentedControl` 若是「打開對話框才問、問到才畫」,
 * 使用者看到的會是「Text size / Contrast 先出現,Default model 才跳出來」。清單先備好,那一列就跟其他列
 * 同一幀出現。側邊欄掛載時會先預熱一次(見 `Sidebar.tsx` 的 `prefetchAllowedModels`)。
 *
 * ⚠️ **失敗不要留下任何東西**:`configInFlight` 自己會在 `finally` 裡清掉,
 * 所以下一次呼叫就是一次乾淨的重試 —— 一次斷線不會讓這個分頁再也問不到清單。
 */
export function getAllowedModels(): Promise<string[]> {
  if (allowedModelsValue) return Promise.resolve(allowedModelsValue);
  return getConfig().then((config) => config.allowed_models);
}

/**
 * 同一份清單,但**同步**回答:問到了就是那個陣列,還沒問到是 `null`。
 *
 * ⚠️ 只有 Promise 版是不夠的:`await` 到的值最快也要等一個 microtask,
 * React 會先畫一幀「還沒有模型」再畫一幀「有了」—— 對話框打開的那一下正好
 * 卡在這兩幀中間,那一列還是會在使用者眼前補上去。拿它當 `useState` 的初值,
 * 那一列就跟其他列同一幀存在。
 *
 * ⚠️ 回傳的是**同一個陣列參考**,所以之後 effect 再 `setState` 同一份不會重繪。
 */
export function peekAllowedModels(): string[] | null {
  return allowedModelsValue;
}

/**
 * 先去問、不等結果 —— 讓「點自己的名字」那一下不必再等一趟來回。
 * 失敗靜默:它只是預熱,真正要用的時候 `getAllowedModels()` 會自己再問一次。
 */
export function prefetchAllowedModels(): void {
  void getAllowedModels().catch(() => {});
}

export async function getConversationTurns(conversationId: string): Promise<HistoryItem[]> {
  const res = await api.get<HistoryItem[]>(`/api/conversations/${conversationId}`);
  remember(turnsCache, conversationId, res.data);
  return res.data;
}

/*
 * ── 對話歷史與檔案清單的小快取──────────────────────────────
 *
 * 滑鼠移到側邊欄某組對話上就先抓(`prefetchConversation`,`App.tsx` 的 AppLink 呼叫),
 * 點下去時對話頁掛上的**第一格**就有完整內容 —— New chat ↔ 對話的過場拍終點畫面用的就是那一格
 *(`lib/chatTransition.ts`)。沒有快取的話那一格是空的:專案名先畫成預設專案、Files (0),
 * 過場演完歷史才回來,專案名換掉、按鈕整排位移。
 *
 * - 只是「先畫」:對話頁掛上後照樣重抓,拿到新的就換。
 * - key 帶 token:換人登入不會讀到上一個人的對話。
 * - 最多留 `CACHE_LIMIT` 組,舊的先丟;`PREFETCH_FRESH_MS` 內抓過的不再預抓
 *   (滑鼠從側邊欄一路滑下去會碰到十幾列,每列都打兩支 API 就太多了)。
 * - 超過 `PEEK_MAX_AGE_MS` 的不拿來先畫:幾小時前的那份先畫上去,重抓回來時多了幾題,
 *   畫面照樣跳 —— 正是這份快取要避免的事。太舊就當沒有,讓過場等這一趟(最多 400ms)。
 * - 自己刪掉 / 離開的對話要 `forgetConversation`(`conversationsApi.deleteConversation` 會叫):
 *   不忘掉的話按上一頁回去,快取先畫出已刪的內容,重抓 404 又被「失敗維持現狀」留在畫面上。
 */
const CACHE_LIMIT = 30;
const PREFETCH_FRESH_MS = 30_000;
const PEEK_MAX_AGE_MS = 5 * 60_000;

type CacheEntry<T> = {value: T; at: number};
const turnsCache = new Map<string, CacheEntry<HistoryItem[]>>();
const filesCache = new Map<string, CacheEntry<ConversationFileGroup[]>>();
const prefetching = new Set<string>();

function cacheKey(conversationId: string): string {
  return `${getToken() ?? ''}|${conversationId}`;
}

function remember<T>(cache: Map<string, CacheEntry<T>>, conversationId: string, value: T): void {
  const key = cacheKey(conversationId);
  // 先刪再放 = 移到最後(Map 依插入順序),最久沒碰的永遠在最前面
  cache.delete(key);
  cache.set(key, {value, at: Date.now()});
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

function peekFresh<T>(cache: Map<string, CacheEntry<T>>, conversationId: string): T | null {
  const entry = cache.get(cacheKey(conversationId));
  return entry && Date.now() - entry.at < PEEK_MAX_AGE_MS ? entry.value : null;
}

/** 快取裡的歷史(同步);沒抓過或太舊是 null */
export function peekConversationTurns(conversationId: string): HistoryItem[] | null {
  return peekFresh(turnsCache, conversationId);
}

/** 快取裡的檔案清單(同步);沒抓過或太舊是 null */
export function peekConversationFiles(conversationId: string): ConversationFileGroup[] | null {
  return peekFresh(filesCache, conversationId);
}

/** 這組對話不在了(自己刪掉 / 離開共用):快取裡的歷史與檔案清單一起丟掉 */
export function forgetConversation(conversationId: string): void {
  const key = cacheKey(conversationId);
  turnsCache.delete(key);
  filesCache.delete(key);
}

/** 先把這組對話的歷史與檔案清單抓下來放著。失敗靜默:它只是預熱 */
export function prefetchConversation(conversationId: string): void {
  const key = cacheKey(conversationId);
  const at = turnsCache.get(key)?.at ?? 0;
  if (prefetching.has(key) || Date.now() - at < PREFETCH_FRESH_MS) return;
  prefetching.add(key);
  void Promise.allSettled([getConversationTurns(conversationId), listConversationFiles(conversationId)]).finally(
    () => prefetching.delete(key),
  );
}

/** 已答完的那一則,執行過程最多列幾步。 */
export const FINISHED_STEP_LIMIT = 6;

/**
 * 一則便條。
 *
 * **它永遠不會送給 claude** —— 不建立問答紀錄、不佔 session、不計成本,
 * 也不受「同一組對話同時只跑一題」的限制(問題正在跑的時候本來就最需要喊人)。
 * @ 到的人會被後端拉進共用並收到通知。
 */
export type NoteItem = {
  id: number;
  created_at: string;
  conversation_id: string;
  author: string;
  author_name: string;
  body: string;
  /** 這則 @ 到誰(帳號名) */
  mentioned: string[];
  /** 帳號名 → 顯示名稱(後端一定給,沒有 @ 到人就是空物件) */
  mentioned_names: Record<string, string>;
  attachments?: string[];
  attachment_sid?: string | null;
  /** **只在建立當下有值**:哪些檔案沒存成 */
  rejected_files?: string[];
};

/** 這組對話裡的所有便條。看得到對話的人都看得到。 */
export async function listNotes(conversationId: string): Promise<NoteItem[]> {
  const res = await api.get<NoteItem[]>(`/api/conversations/${conversationId}/notes`);
  return res.data;
}

/**
 * 寫一則便條。
 *
 * ⚠️ **沒附件就送 JSON,有附件才走 multipart**。部署時前端檔案一換就生效、
 * 後端要重啟才換 —— 交接的空窗裡後端可能還是只認 JSON 的版本,
 * 無條件送 multipart 會讓那段時間**所有不帶附件的便條都 422**。
 */
export async function createNote(
  conversationId: string,
  text: string,
  files: File[] = [],
): Promise<NoteItem> {
  const url = `/api/conversations/${conversationId}/notes`;
  if (files.length === 0) {
    const res = await api.post<NoteItem>(url, {text});
    return res.data;
  }
  const form = new FormData();
  form.append('text', text);
  for (const file of files) form.append('files', file, file.name);
  const res = await api.post<NoteItem>(url, form);
  return res.data;
}

/** 便條的長度上限。跟後端 `notes.MAX_NOTE_CHARS` 對齊。 */
export const MAX_NOTE_CHARS = 500;

/**
 * 檔案區的一份檔案。
 *
 * 版次與分組**由後端算好**(`convfiles.py`),前端不要自己再排一次:
 * 版次是跨 upload/output、照「第幾題」編的,而檔案的時間不可靠
 * ——交付主機上既有的檔案走 `shutil.copy2`,會把來源兩年前的 mtime 一起帶過來。
 */
export type ConversationFileVersion = {
  /** upload = 使用者附上去的,output = claude 產出或交付的 */
  kind: 'upload' | 'output';
  /** 組下載網址要用的那一段(每一題一個資料夾;便條附件是那則便條的 sid) */
  session_id: string;
  /** null = 檔案在磁碟上找不到了,跟 `missing` 一起看 */
  size: number | null;
  created_at: string;
  /** 這個檔案掛在哪一題。**null = 這是便條的附件**,改看 `note_id` */
  qa_id: number | null;
  /** 是便條附件時,那則便條的 id。跟 `qa_id` 恰好一個有值一個 null */
  note_id?: number | null;
  /** 這組對話裡的第幾題(便條附件放的是「它前面那一題」的題號) */
  turn: number;
  question: string;
  asked_by: string | null;
  /** 同名檔案裡的第幾版,1 起算(最舊的是 1) */
  version: number;
  /**
   * 磁碟上已經沒有這個檔案了。
   * ⚠️ **要留在清單裡顯示成失效,不能直接不畫** —— 悄悄消失的話,
   * 使用者會以為系統把他的檔案吃了,而且無從查起。
   */
  missing: boolean;
};

/** 同一個檔名的所有版本。`versions[0]` 一定是目前版本,舊版排在後面。 */
export type ConversationFileGroup = {
  name: string;
  versions: ConversationFileVersion[];
};

/**
 * 這組對話的所有檔案。
 *
 * 重抓時機:`finishedTurnCount` 或 `notes.length` 變才抓
 * —— **不要依賴 `displayTurns`**,串流時每個字都會生一個新陣列,
 * 那等於一題打幾千次這支 API。
 */
export async function listConversationFiles(
  conversationId: string,
): Promise<ConversationFileGroup[]> {
  const res = await api.get<ConversationFileGroup[]>(
    `/api/conversations/${conversationId}/files`,
  );
  remember(filesCache, conversationId, res.data);
  return res.data;
}

export type ParsedSource = {
  tool: string;
  target: string;
  detail?: string | null;
  /**
   * 這一步是在整題開始後第幾毫秒發生的。
   * 沒有就是沒記錄,那一則不畫耗時 —— **不要用 0 頂替**,那會算出假的秒數。
   */
  at_ms?: number | null;
  /**
   * 工具真正花多久(後端的 step_duration,舊紀錄沒有)。
   * 有它就畫它;沒有才用相鄰兩步的 at_ms 相減(見 time.ts 的 stepDurationMs)。
   */
  duration_ms?: number | null;
};

/** sources 是 JSON 字串;壞掉就當作沒有,不要讓一筆爛資料炸掉整頁。 */
export function parseSources(raw: string | null): ParsedSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ParsedSource[]) : [];
  } catch {
    return [];
  }
}

export function parseOutputFiles(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 「這一則是不是我問的」。
 * 沒有 askedBy、身分還在載入、或大小寫不敏感相符 → 算自己的。
 */
export function isMine(askedBy: string | null | undefined, username: string | undefined): boolean {
  if (!askedBy) return true;
  if (!username) return true;
  return askedBy.toLowerCase() === username.toLowerCase();
}
