/**
 * 管理頁的 API(用量監控 / 安全 / 帳號管理)。
 *
 * 全部集中在這裡的理由跟 `conversationsApi` 一樣:**元件不自己組網址**。
 * 這幾頁的路徑有 query string、有路徑參數、有 204 沒有 body,散在頁面裡
 * 遲早會有人少帶一個參數而查不出來。
 *
 * 型別逐欄對著後端的 `schemas.py` 抄 —— 對不上的欄位在這裡就會被 tsc 抓到,
 * 而不是等到畫面上出現 undefined。
 */
import {api} from './api';

/** 提問人(用量明細用)。沒有 asked_by 的紀錄退回 owner —— 不是共用續問的題目,送出的人就是 owner */
export function askerOf(record: {asked_by?: string | null; owner?: string | null}): string {
  return record.asked_by || record.owner || '—';
}

// ── 用量監控 ──────────────────────────────────────────────────────────────

/**
 * 期間的分組粒度。
 *
 * 鍵一律是絕對時間,不是只有時分:`quarter` 是 `2026-09-17 14:30`、
 * `hour` 是 `2026-09-17 14` —— 跨日的區間才不會把不同天的同一個鐘點併成一格。
 * 用量頁在「起訖同一天」時用 `hour`(24 格),其餘用 `day`。
 * `quarter`(15 分鐘,96 格)後端支援、**畫面上沒有入口**(見 `pages/Stats.tsx` 的 `granularityFor()`)。
 */
export type Granularity = 'quarter' | 'hour' | 'day' | 'month' | 'year';

/** `schemas.StatsPrevious`。對照期 = 同樣長度、緊接在前的一段。 */
export type StatsPrevious = {
  total_questions: number;
  avg_duration_ms: number;
  account_count: number;
  login_user_count?: number;
  logged_in_questions?: number;
};

/** `schemas.StatsOut`。`by_period` / `by_user` 是 key → 次數的物件,不是陣列。 */
export type Stats = {
  total_questions: number;
  total_cost_usd: number;
  avg_duration_ms: number;
  by_period: Record<string, number>;
  by_user: Record<string, number>;
  /** 各帳號的平均耗時(ms)。key 跟 `by_user` 一樣。 */
  by_user_avg_duration?: Record<string, number>;

  /*
   * ↓ dashboard 版面用的。後端全部給了預設值,但**這裡還是都標成可選** ——
   * 後端版本比前端舊時回的 JSON 裡沒有這些鍵,標成必填的話
   * TypeScript 會讓人以為讀得到,實際拿到 undefined 就是一個 runtime 錯誤。
   */

  /** 有帳號的發問者人數。後端算,不要再從 by_user 算一次。 */
  account_count?: number;

  /** 大圖的第二條線(已登入的人問的題數)。 */
  by_period_logged_in?: Record<string, number>;

  /** KPI 卡的 sparkline(提問數那張直接用 `by_period`)。 */
  avg_duration_by_period?: Record<string, number>;

  /** 堆疊橫條:專案(NULL 歸「(未指定)」)。畫面上的標題是「專案」。 */
  by_knowledge_base?: Record<string, number>;
  /** 耗時分布。鍵固定是 fast / medium / slow 三個,沒有那一段也會是 0。 */
  by_duration_bucket?: Record<string, number>;
  /** 題目狀態。畫面上沒有用到。 */
  by_status?: Record<string, number>;

  /**
   * 登入成功過的不重複人數。
   *
   * ⚠️ 跟 `account_count`(有問過問題的帳號數)**不是同一件事** ——
   * 登入了沒問問題的人算在這裡、不算在那裡。畫面上的「登入人數」用這個。
   */
  login_user_count?: number;
  /** 已登入的人問的題數。「每人平均題數」的分子。 */
  logged_in_questions?: number;
  /** 登入人數的 sparkline */
  logins_by_period?: Record<string, number>;

  /** 沒指定完整區間時是 null —— 前端靠這個決定不畫漲跌箭頭。 */
  previous?: StatsPrevious | null;
};

/**
 * 這台機器跟 UTC 差幾分鐘(東時區為正,UTC+8 是 480)。
 *
 * ⚠️ **管理頁凡是帶日期的查詢都要送這個。** 後端的 `created_at` 存的是 UTC
 *(`datetime.utcnow`),而使用者挑的日期是他當地的日期 —— 不送的話後端照
 * UTC 切,UTC+8 看到的「今天」其實是當地今天早上八點到明天早上八點。按日看只是
 * 幾筆在相鄰兩天之間飄,按小時看就是整條曲線平移八小時。
 *
 * `getTimezoneOffset()` 的正負號跟直覺相反(UTC+8 回 -480),所以這裡取反。
 * 跟 `lib/time.ts` 的 `parseServerTime()` 是同一件事的兩面:
 * 那支負責把後端的 UTC 字串讀成當地時間,這支負責把當地的日期送回去。
 */
export function localTzOffset(): number {
  return -new Date().getTimezoneOffset();
}

export async function getStats(
  granularity: Granularity,
  start?: string,
  end?: string,
): Promise<Stats> {
  const res = await api.get<Stats>('/api/stats', {
    // 空字串不要送:後端的 `date` 解析會 422,而「沒選日期」本來就該是不帶參數
    params: {
      granularity,
      start: start || undefined,
      end: end || undefined,
      tz_offset: localTzOffset(),
    },
  });
  return res.data;
}

// ── 用量明細:問了什麼 + 每一步耗掉多少 ────────────────────────────────────

/**
 * `schemas.QuestionUsageItem`。
 *
 * ⚠️ **`has_steps` 不能省略、也不能用「turns > 0」代替。** 沒有每步紀錄的問答
 * 一列明細都沒有 —— 而「這題沒查任何檔」跟「這題沒有明細紀錄」在畫面上都是
 * 一片空白,意思卻完全相反。
 */
export type QuestionUsage = {
  id: number;
  created_at: string;
  owner: string | null;
  /** 實際送出的人。共用對話裡別人續問時,它跟 owner 不一樣。 */
  asked_by: string | null;
  conversation_id: string | null;
  /** **全文**,後端不截斷 —— 這一頁存在的理由就是「他到底問了什麼」 */
  question: string;
  knowledge_base: string | null;
  success: boolean;
  status: string;
  duration_ms: number | null;
  cost_usd: number | null;
  has_steps: boolean;
  turns: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /**
   * 使用者把這組對話刪掉了(ISO 時間字串),`null` = 沒刪。
   *
   * ⚠️ **這一頁刻意仍然列出被刪掉的題目** —— 成本與 token 要留得住,
   * 不然有人刪對話,統計就默默少一塊(所以對話是軟刪除)。
   * 刪除的當下內容就被清空了,所以 `question` 會是空字串:
   * 畫面上要顯示成「已刪除」,不要顯示成一題空白的問題。
   */
  deleted_at: string | null;
  /**
   * 這一題的每步明細已經過了保留期被清掉了(預設 90 天)。
   *
   * ⚠️ **這是「第三種空」**(另外兩種是「這題沒查任何檔」與「這題沒有明細紀錄」)。
   * 日期範圍預設是全部,畫面上會一次列出很多超過保留期的舊題目 ——
   * 它們的 token 欄位也是空的,不分開講就會被讀成「數字算錯了」。
   */
  steps_expired: boolean;
};

/** `total` 是符合篩選的總筆數,不是這一頁的長度 —— 靠它算共幾頁。 */
export type QuestionUsagePage = {items: QuestionUsage[]; total: number};

/**
 * 時間軸上的一步。`kind` 決定這一列長什麼樣:
 *  - `turn`    一次模型呼叫,token 記在這種列上
 *  - `tool`    一次工具呼叫,token 欄位一律是 null(理由見後端 models.QAStep)
 *  - `subturn` 子代理(Task)裡的模型呼叫,一樣要花錢但不算主線的一輪
 */
export type UsageStep = {
  seq: number;
  turn: number;
  kind: 'turn' | 'tool' | 'subturn';
  tool: string | null;
  target: string | null;
  /**
   * 沒縮短、沒截斷的標的 —— 明細頁顯示這一份,才看得出是哪個路徑、
   * 那條指令後半段做了什麼。`null` = 這一筆沒有存完整標的,退回 `target`。
   */
  target_full: string | null;
  detail: string | null;
  /** 第幾毫秒**發生**。⚠️ 這不是「花了多久」,相鄰兩列相減也得不到耗時。 */
  at_ms: number | null;
  /**
   * 這一步真正花了多久。只有工具列有值。
   * `null` = 沒等到 `tool_result`(被停止、逾時)—— 那是事實,不要當成 0。
   */
  duration_ms: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
};

export type RepeatedTarget = {tool: string; target: string; count: number};

export type QuestionUsageDetail = {
  question: QuestionUsage;
  steps: UsageStep[];
  /** 被碰過兩次以上的標的,多的排前面 */
  repeats: RepeatedTarget[];
};

/** 排序方式。`tokens` **只排目前這一頁**(後端註解有說明為什麼)。 */
export type QuestionOrder = 'created_at' | 'cost_usd' | 'tokens';

/** 一頁幾筆。這一頁的問題是全文,所以比安全頁的事件清單少。 */
export const QUESTION_PAGE_SIZE = 20;

export async function getQuestions(filters: {
  user?: string;
  start?: string;
  end?: string;
  q?: string;
  order?: QuestionOrder;
  offset?: number;
}): Promise<QuestionUsagePage> {
  const res = await api.get<QuestionUsagePage>('/api/stats/questions', {
    // 空字串一律不送:後端的 date 解析會 422,而字串欄位空字串會被當成
    // 「搜尋空字串」,兩種都不是使用者的意思(他只是沒填)。
    params: {
      user: filters.user || undefined,
      start: filters.start || undefined,
      end: filters.end || undefined,
      /*
        ⚠️ **總覽跟明細一定要送同一個位移。** 排行表上寫「他問了 45 題」,點進去
        這一頁卻按 UTC 切,兩邊的題數就對不起來 —— 而畫面上看不出是哪邊算錯
        (`routers/stats._asker()` 那段註解講的是同一類毛病)。
      */
      tz_offset: localTzOffset(),
      q: filters.q || undefined,
      order: filters.order || undefined,
      limit: QUESTION_PAGE_SIZE,
      offset: filters.offset || 0,
    },
  });
  return res.data;
}

/**
 * 此刻正在跑的一題。
 *
 * ⚠️ 資料只在後端的記憶體裡,**服務一重啟就全空**,跑完 10 分鐘後也會消失。
 * 它回答的是「現在」,不是歷史 —— 所以這一區空白的意思是「現在沒人在問」,
 * 不是「查不到資料」。
 */
export type RunningQuestion = {
  run_id: string;
  conversation_id: string;
  question: string;
  /** `null` = 沒登入的人問的(公開池) */
  owner: string | null;
  knowledge_base: string | null;
  /**
   * 已經跑了多久。**由後端算** —— 用本機時鐘去減會因為時差變成負的。
   * (所以後端刻意**不回**開始時間:回了就會有人拿去減。)
   */
  elapsed_ms: number;
};

export async function getRunningQuestions(): Promise<RunningQuestion[]> {
  const res = await api.get<{items: RunningQuestion[]}>('/api/stats/running');
  return res.data.items;
}

export async function getQuestionDetail(id: number): Promise<QuestionUsageDetail> {
  const res = await api.get<QuestionUsageDetail>(`/api/stats/questions/${id}`);
  return res.data;
}

// ── 安全 ───────────────────────────────────────────────────────────

/** `retry_after === -1` = 永久封鎖;其餘是「還剩幾秒自動解開」。 */
export type LockEntry = {key: string; retry_after: number};
export type Locks = {accounts: LockEntry[]; ips: LockEntry[]};

export async function getLocks(): Promise<Locks> {
  const res = await api.get<Locks>('/api/locks');
  return res.data;
}

/** 解鎖。帳號與 IP 至少要給一個(後端會擋)。 */
export async function unlock(target: {username?: string; ip?: string}): Promise<void> {
  await api.post('/api/locks/unlock', target);
}

/**
 * 登入白名單的一條(`schemas.GeoAllowEntry`)。
 *
 * `cidr` 是**後端正規化過**的字串:打 `1.2.3.4` 存回來會是 `1.2.3.4/32`,
 * 打 `1.2.3.4/24` 會變成 `1.2.3.0/24`(實際放行的範圍比他打的字大)。
 * 所以新增之後要拿回應的值重畫,不要沿用使用者輸入的字。
 *
 * ⚠️ **只有 IP,沒有備註欄**。
 * `created_at` 後端還是有回,但畫面上不顯示。
 */
export type GeoAllowEntry = {
  cidr: string;
  created_at: string;
};

export async function getGeoAllow(): Promise<GeoAllowEntry[]> {
  const res = await api.get<GeoAllowEntry[]>('/api/geo-allow');
  return res.data;
}

/** 新增一條。填錯(太大的網段、內網位址)後端回 400,訊息是給人看的中文。 */
export async function addGeoAllow(ip: string): Promise<GeoAllowEntry> {
  const res = await api.post<GeoAllowEntry>('/api/geo-allow', {ip});
  return res.data;
}

/** 刪一條。**刪不到會回 404** —— 那代表畫面上的清單已經過期,要重新載入。 */
export async function removeGeoAllow(ip: string): Promise<void> {
  await api.post('/api/geo-allow/remove', {ip});
}

export type AuditEntry = {
  id: number;
  created_at: string;
  event: string;
  actor: string | null;
  ip: string | null;
  detail: string | null;
};

/** `total` 是**符合這次篩選的總筆數**,不是這一頁的長度 —— 靠它算共幾頁。 */
export type AuditPage = {items: AuditEntry[]; total: number};

/**
 * 安全頁看得到的分類(後端 `routers/audit.py` 的 `SHOWN`);`all` = 不帶 category。
 * 其他事件後端照記、這裡不顯示。
 */
export type AuditCategory = 'all' | 'login';

/** 一頁幾筆。後端夾在 1~200,這個值同時是前端算頁數的除數。 */
export const AUDIT_PAGE_SIZE = 20;

export async function getAudit(category: AuditCategory, offset: number): Promise<AuditPage> {
  const res = await api.get<AuditPage>('/api/audit', {
    params: {
      category: category === 'all' ? undefined : category,
      limit: AUDIT_PAGE_SIZE,
      offset,
    },
  });
  return res.data;
}

// ── 帳號管理 ───────────────────────────────────────────────────────

/**
 * 職稱的兩個合法值,**順序就是下拉選單的順序**。對應後端的 `users.ROLES`。
 *
 * ⚠️ 大小寫要跟後端一模一樣(`Software engineer`,小寫 e)——
 * 後端用字串相等判斷要不要給完整權限,打錯一個字母就變成唯讀。
 */
export const USER_ROLES = ['Consultant', 'Software engineer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/*
 * ⚠️ 下面三個常數是**這兩個字串在前端的唯一出處**:散在 `roleGrantsFull`、
 * `GROUP_ORDER`、`groupKeyOf` 與職稱欄的預設文字裡各寫一次的話,
 * 大小寫打錯一個字母就是「畫面顯示 Consultant、實際上有 Bash」那種看不出來的錯。
 *
 * ⚠️ **一律寫字面值,不要用 `USER_ROLES[0]` / `[1]` 的位置去指**。
 * `USER_ROLES` 的順序是**下拉選單的順序**,
 * 是排版決定;拿位置當身分的話,哪天把工程師排到前面,
 * `DEFAULT_USER_ROLE` 就會靜靜變成 `Software engineer` —— 那是把所有
 * 沒設過職稱的人一次給上 Bash 權限,而畫面上完全看不出來。
 * 型別標成 `UserRole` 就夠了:字面值打錯編譯不會過。
 */

/**
 * `Consultant`(唯讀)這個**職稱本身**。分群、篩選、比對某個人是不是這個職稱時用這個。
 *
 * ⚠️ 跟 `DEFAULT_USER_ROLE` **是兩件事,值才剛好一樣**——
 * 後端 `users.py` 的 `ROLE_CONSULTANT` / `DEFAULT_ROLE` 也是這樣分的:
 * 一個是「這個職稱」,一個是「沒設過的人算什麼」。
 * 前端若只留 `DEFAULT_USER_ROLE` 一個、兩種用途共用,等於把後端刻意留的
 * 那條縫在這裡補起來 —— 哪天「沒設過的人」要改成別的預設(例如
 * 「未指定」),分群那幾處會跟著一起錯。
 */
export const CONSULTANT_ROLE: UserRole = 'Consultant';

/**
 * 沒設過職稱的人在畫面上等同這個(對應後端 `users.DEFAULT_ROLE`)。
 * **只用在「這個人沒有職稱,那該顯示/送出什麼」**,不要拿它去比對職稱 ——
 * 那是 `CONSULTANT_ROLE` 的事。
 */
export const DEFAULT_USER_ROLE: UserRole = CONSULTANT_ROLE;

/** 帶完整權限(可以在主機上跑 Bash)的那個職稱。對應後端的 `_FULL_ROLES`。 */
export const FULL_ACCESS_ROLE: UserRole = 'Software engineer';

/** 這個職稱帶不帶完整權限。跟後端 `users.role_grants_full()` 是同一條規則。 */
export function roleGrantsFull(role: string | null | undefined): boolean {
  return (role ?? '').trim() === FULL_ACCESS_ROLE;
}

/**
 * `schemas.UserOut`。
 *
 * ⚠️ **`tools` 是推導出來的,不要拿它當來源**(職稱就是權限)。
 * 後端由 `role` 算出 `tools`;畫面上要判斷權限請用 `roleGrantsFull(role)`,
 * 兩者永遠一致,而 `role` 才是使用者實際在改的東西。
 */
export type ManagedUser = {
  username: string;
  display_name: string;
  tools: string | null;
  disabled: boolean;
  /** 畫面上的職稱(@ 選單的副標)。null = 沒設,後端讀的那一側會退回預設值。 */
  role: string | null;
  created_at: string | null;
  password_changed_at: string | null;
  /** 還在用發下去的預設密碼 */
  is_default_password: boolean;
  /**
   * 已經被發過手機驗證碼(QR code)。
   *
   * `MFA_REQUIRED` 開著時,這一欄是 false 的人**登不進來** ——
   * 所以這一頁要把它標出來,管理員才知道還有誰沒發。
   */
  mfa_enabled: boolean;
};

export async function getUsers(): Promise<ManagedUser[]> {
  const res = await api.get<ManagedUser[]>('/api/users');
  return res.data;
}

/**
 * 新增帳號**只送帳號名**。
 * 職稱一律是後端的預設值(Consultant)= 唯讀;要完整權限就建完之後改職稱。
 */
export async function createUser(username: string) {
  const res = await api.post<ManagedUser>('/api/users', {username});
  return res.data;
}

/**
 * 只帶想改的欄位,沒帶的後端不動。
 * ⚠️ `role` 帶空字串是「清掉職稱」,**不帶**才是「不動」—— 後端用
 * `model_fields_set` 分辨這兩件事,所以不要為了省事把空值濾掉。
 */
export async function updateUser(
  username: string,
  // ⚠️ 沒有 `full` —— 權限由 role 推導,後端不收那個欄位
  patch: {disabled?: boolean; role?: string},
): Promise<ManagedUser> {
  const res = await api.patch<ManagedUser>(`/api/users/${encodeURIComponent(username)}`, patch);
  return res.data;
}

export async function resetUserPassword(username: string): Promise<void> {
  await api.post(`/api/users/${encodeURIComponent(username)}/reset-password`);
}

/** 管理員發放 QR code 時拿到的東西。**密鑰只在這一次回傳。** */
export type MfaEnrollment = {
  secret: string;
  /** 每 4 個字一組,給人照著敲進手機用。 */
  formatted_secret: string;
  /** `otpauth://…`,QR 就是拿這串畫的。 */
  otpauth_uri: string;
};

/**
 * 幫某個帳號產生手機驗證碼(QR code)。**發放與重新發放是同一支。**
 *
 * ⚠️ **舊的會在這一刻立刻失效**,而且那個人已經登入的分頁會被踢掉。
 * 手機壞了、換手機、掃失敗都按這個;呼叫端要先問過使用者。
 */
export async function issueUserMfa(username: string): Promise<MfaEnrollment> {
  const res = await api.post<MfaEnrollment>(`/api/users/${encodeURIComponent(username)}/mfa`);
  return res.data;
}

/**
 * 管理員自己的帳號狀態(只有手機驗證那一項)。
 *
 * ⚠️ **他不在 `/api/users` 那份清單裡**(密碼在 .env,不在 users 表),所以
 * 帳號管理頁上沒有他那一列 —— 少了這一支,權限最大的帳號永遠發不到 QR,
 * 而那會讓「全面強制」根本開不起來。
 */
export type AdminAccount = {
  username: string;
  mfa_enabled: boolean;
  };

export async function getAdminAccount(): Promise<AdminAccount> {
  const res = await api.get<AdminAccount>('/api/admin-account');
  return res.data;
}

export async function deleteUser(username: string): Promise<void> {
  await api.delete(`/api/users/${encodeURIComponent(username)}`);
}
