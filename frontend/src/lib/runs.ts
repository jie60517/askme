/**
 * 進行中的問答(docs/architecture.md「一題問答是怎麼跑的」)。
 *
 * 回答**不是掛在 HTTP 連線上跑的**:後端一收到 /api/ask 就寫一筆 status="running"
 * 的紀錄、把 claude 丟到背景 task,HTTP 回應只是「在看」那條事件流。
 * 所以這一層的責任是:
 *
 *   1. 送出一題,把 ndjson 事件累積成一個 Pending
 *   2. 關掉分頁 / 重新整理之後,靠 GET /api/ask/runs 把還在跑的接回來
 *      (那條串流會從第一個事件重播,連中間讀過哪些檔案都補得回來)
 *   3. 停止是打 API,不是關瀏覽器這端的連線 —— 關連線它會照跑完、照計費
 *
 * ⚠️ Pending 是**就地修改的同一個物件**,參照永遠不變。React 那邊要靠
 * `subscribeAll()` 送出的通知強制重繪,不能指望 pending !== prevPending。
 */
import {getToken} from './auth';
import {ndjsonLines} from './ndjson';
import {toastError} from './toast';

export type RunSource = {
  tool: string;
  target: string;
  detail?: string | null;
  /** 前端收到的時間;工具真正的耗時還沒回來時,用它算「到現在/到下一步」 */
  at: number;
  /** 對得到後端 step_duration 的 id */
  toolUseId?: string | null;
  /** 工具真正花多久(source_duration 事件補上);有它就畫它 */
  durationMs?: number;
};

/**
 * 進行中那一題,某一步的狀態(聊天頁的執行過程用)。
 *
 * - 最後一步而整題失敗了:它就是失敗的那一步。
 * - 工具結果回來了(`source_duration`):做完了 —— 之後模型在想下一步或寫答案,
 *   那段時間不算在這個工具頭上。
 * - 整題已經失敗:沒回來的也不會再回來了,不要留一顆一直轉的圈。
 * - **有 `toolUseId` 而結果還沒回來:還在跑**,不管後面有沒有下一步。
 *   平行呼叫時前幾支常常比最後一支晚回來;用「後面有下一步 = 做完了」推斷的話,
 *   會先標成完成、耗時先顯示到下一通呼叫為止,之後才跳成真正的值。
 * - 沒有 `toolUseId`(舊紀錄,不會有 `source_duration`):只能用「後面有下一步」推斷。
 */
export function runningStepStatus(
  source: Pick<RunSource, 'toolUseId' | 'durationMs'>,
  isLast: boolean,
  failure?: string | null,
): 'running' | 'complete' | 'error' {
  if (isLast && failure) return 'error';
  if (source.durationMs !== undefined || failure) return 'complete';
  if (source.toolUseId) return 'running';
  return isLast ? 'running' : 'complete';
}

export type RunNotice = {
  level: 'info' | 'warning' | 'error';
  message: string;
};

export type Pending = {
  conversationId: string;
  question: string;
  /** 後端配的紀錄 id,start 事件才會知道 */
  finalId?: number;
  runId?: string;
  knowledgeBase?: string | null;
  /** 已經串流出來的答案 */
  text: string;
  sources: RunSource[];
  notices: RunNotice[];
  /** 排隊中的名次;沒排隊就是 undefined */
  queuePosition?: number;
  startedAt: number;
  done: boolean;
  success?: boolean;
  error?: string | null;
  files?: string[];
  /**
   * 伺服器**確認**停掉了。
   *
   * 只有 `POST /stop` 回 ok 才會是 true —— 這個旗標會讓畫面說「停下來了」,
   * 說了就要是真的。伺服器那條路徑另外會在 `error` 開頭寫「已停止」(後端原文),
   * 兩條都算,判斷統一走 `isStopped()`。
   */
  stopped?: boolean;
  /**
   * 使用者按了停止,但那時候還沒拿到 run_id。
   *
   * start 事件一到就補送。**不要**改成關掉自己這條連線 —— 見 stopStream 的說明。
   */
  stopRequested?: boolean;
  /**
   * 附件還在上傳(multipart 的 POST 還沒收到第一個事件)。
   * 小夥伴的 `uploading` 狀態靠它 —— 沒人設的話那是個死狀態。
   * 第一個事件一到就清掉:事件能到代表 body 送完了。
   */
  uploading?: boolean;
  /**
   * 這一題送出時附上去的檔名。**串流階段**提問泡泡上那排 Token 靠它 ——
   * 歷史那一筆有 `uploaded_filename`,但 pending 的當下歷史還沒回來,
   * 少了這份,送出的瞬間附件會從畫面上消失。
   */
  uploadedNames?: string[];
};

/**
 * 這一題是不是被停掉的。
 *
 * 兩條路徑:伺服器停的(`error` 開頭是後端寫的「已停止」)、
 * 我們送出停止並收到 ok 的(`stopped`)。判斷只有這一份,
 * 呼叫端不要自己去比字串 —— 比錯了小夥伴會演成「答錯了」。
 */
export function isStopped(pending: Pending | undefined): boolean {
  if (!pending) return false;
  return pending.stopped === true || pending.error?.startsWith('已停止') === true;
}

const pendings = new Map<string, Pending>();
const listeners = new Set<() => void>();

export function subscribeAll(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 已經排了一次通知在等下一幀 —— 這一幀之內再來的 `emit()` 全部合併進那一次。 */
let emitScheduled = false;

function flushEmit() {
  emitScheduled = false;
  for (const cb of listeners) cb();
}

/**
 * 通知訂閱者。**一幀最多送一次**。
 *
 * ⚠️ 串流是**一行一個事件**(`consume()` 每讀到一行就 `emit()`),而 LLM 一秒
 * 吐得出 30–60 個 delta。沒有這一層的話,每一個 delta 都會連帶做完下面這些:
 *
 *   - `Chat` 整棵樹重繪(`subscribeAll(bumpStream)`,那個元件很大);
 *     裡面的 `Turn` / `AnswerContent` 跟著重跑 `parseSources`、
 *     `parseOutputFiles` 與**整段 Markdown 重新解析**
 *   - `Sidebar` 整棵樹重繪(它也自己訂了一份,`Sidebar.tsx` 的 `forceUpdate`)
 *   - `RunningNavDot` 與小夥伴的 `watchRunsForUsage()`(每次都掃一遍 `listPendings()`)
 *
 * 一秒做幾十次等於整段回答期間主執行緒都是滿的。畫面**一秒本來也只畫 60 次**,
 * 多出來的那些重繪一幀都沒有多畫出來 —— 純粹是丟掉的工。
 * 連帶受害的是側邊欄那條果凍捲動:它是自己寫 `scrollTop` 的 rAF 迴圈,
 * 跟這些重繪搶同一條執行緒,主執行緒一滿它就卡住。
 *
 * ⚠️ **合併掉的那幾次不會漏狀態。** `Pending` 是就地修改的同一個物件(見檔頭),
 * callback 執行的時候讀到的一定是當下最新的值;被合併掉的那幾次本來就畫不出來。
 *
 * ⚠️ **分頁在背景、或視窗被別的視窗蓋住時,rAF 一次都不會發**
 * (rAF 只有在頁面真的在合成畫面時才會跑)。接受這件事,但要知道
 * 被延後的**不只是畫面**:`Chat` 靠 `pending.done` 變了才去重抓 turns、
 * 小夥伴答完之後那句用量(`lib/petSetup` 的 `watchRunsForUsage`)也掛在這條通知上。
 * 回到前景的第一幀會補送一次,而那一次讀到的就是當下最新的狀態,
 * 所以不會停在半路 —— 背景分頁本來就不需要即時更新。
 *
 * ⚠️ 沒有 rAF 的環境(測試預設跑在 `node`)**同步送**:那裡沒有「幀」這種東西,
 * 排進微任務只會讓呼叫端要多 await 一層,換不到任何好處。
 */
function emit() {
  if (typeof requestAnimationFrame !== 'function') {
    flushEmit();
    return;
  }
  if (emitScheduled) return;
  emitScheduled = true;
  requestAnimationFrame(flushEmit);
}

export function getPending(conversationId: string | undefined): Pending | undefined {
  return conversationId ? pendings.get(conversationId) : undefined;
}

export function getActiveStreams(): Pending[] {
  return [...pendings.values()].filter((p) => !p.done);
}

/**
 * **全部**的 pending,含已經答完的。
 *
 * `getActiveStreams()` 刻意只回還在跑的(小夥伴的「現在忙不忙」靠它),
 * 但「剛剛答完的那一題」正好被它濾掉 —— 而那是 `lib/petSetup` 要在答完之後
 * 補講一句用量時唯一的入口。兩支分開,不要把過濾條件加參數化:
 * 「在跑的」是一個有名字的概念,不是 `listPendings(true)`。
 */
export function listPendings(): Pending[] {
  return [...pendings.values()];
}

export function clearPending(conversationId: string) {
  if (pendings.delete(conversationId)) emit();
}

type AskEvent =
  | {type: 'start'; id: number; run_id: string; conversation_id: string; knowledge_base?: string | null}
  | {type: 'queued'; position: number; capacity: number}
  | {type: 'notice'; level: RunNotice['level']; message: string}
  | {type: 'delta'; text: string}
  | {type: 'answer_reset'}
  | {type: 'source'; tool: string; target: string; detail?: string | null; tool_use_id?: string | null}
  | {type: 'source_duration'; tool_use_id: string; duration_ms: number}
  | {type: 'ping'; elapsed_ms: number}
  | {type: 'error'; message: string}
  | {
      type: 'done';
      id: number;
      success: boolean;
      error?: string | null;
      files?: string[];
    };

function apply(pending: Pending, event: AskEvent) {
  // 有事件進來 = multipart 的 body 已經送完了,不再是「上傳中」
  pending.uploading = false;
  switch (event.type) {
    case 'start':
      pending.finalId = event.id;
      pending.runId = event.run_id;
      pending.knowledgeBase = event.knowledge_base ?? null;
      // 按停止的時候還沒有 run_id,現在有了 —— 立刻補送
      if (pending.stopRequested) void requestStop(pending);
      break;
    case 'queued':
      pending.queuePosition = event.position;
      break;
    case 'notice':
      pending.notices.push({level: event.level, message: event.message});
      break;
    case 'delta':
      // 第一個字一到就不再是排隊中了。
      pending.queuePosition = undefined;
      pending.text += event.text;
      break;
    case 'answer_reset':
      /*
       * 它又要去呼叫工具了 —— 剛剛那幾句是過程,不是答案(後端 agent.py 的
       * `answer_start_index`)。畫面上要跟著清掉,不然串流當下看得到那幾句、
       * 重新整理之後又不見了(存進 DB 的 answer 已經切掉它們)。
       *
       * 它在講什麼、翻了哪些檔案,「執行過程」那一塊會即時顯示,不會沒東西看。
       */
      pending.text = '';
      break;
    case 'source':
      pending.sources.push({
        tool: event.tool,
        target: event.target,
        detail: event.detail,
        at: Date.now(),
        toolUseId: event.tool_use_id ?? null,
      });
      break;
    case 'source_duration': {
      // 工具真正的耗時晚到(要等 tool_result 回來),補回同一列
      const source = pending.sources.find((s) => s.toolUseId === event.tool_use_id);
      if (source) source.durationMs = event.duration_ms;
      break;
    }
    case 'error':
      pending.done = true;
      pending.success = false;
      pending.error = event.message;
      break;
    case 'done':
      pending.finalId = event.id ?? pending.finalId;
      pending.done = true;
      pending.success = event.success;
      pending.error = event.error ?? null;
      pending.files = event.files ?? [];
      break;
    case 'ping':
      break;
  }
}

/** 把一條 ndjson 串流讀完,邊讀邊更新 pending。 */
async function consume(response: Response, pending: Pending) {
  const body = response.body;
  if (!body) throw new Error('這條串流沒有內容');

  try {
    // 切行在 `lib/ndjson.ts`(半行的處理也在那裡),這裡只管「一行來了要做什麼」。
    for await (const line of ndjsonLines(body)) {
      try {
        apply(pending, JSON.parse(line) as AskEvent);
        emit();
      } catch {
        // 壞掉的一行不該讓整條串流掛掉。
      }
    }
  } finally {
    // 串流斷了但沒收到 done:那一題可能還在伺服器上跑(服務重啟、通道被切)。
    // 標成結束但不謊報成功 —— 重抓 turns 時後端會給真正的結果。
    if (!pending.done) {
      pending.done = true;
      pending.success = false;
      pending.error =
        pending.error ??
        (pending.stopped
          ? STOPPED_MESSAGE
          : 'The connection dropped — refresh to see how this question ended.');
    }
    emit();
  }
}

/** 停下來之後畫面上寫的那一句。伺服器停的那條會用後端的原文。 */
const STOPPED_MESSAGE = 'Stopped.';

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? {Authorization: `Bearer ${token}`} : {};
}

export type AskOptions = {
  conversationId: string;
  question: string;
  files?: File[];
  model?: string;
  kb?: string;
};

/** 送出一題。回傳的 promise 在串流結束時 resolve。 */
export function startStream(opts: AskOptions): Pending {
  const pending: Pending = {
    conversationId: opts.conversationId,
    question: opts.question,
    text: '',
    sources: [],
    notices: [],
    startedAt: Date.now(),
    done: false,
    // 有附件的那一題,第一個事件回來之前都算「上傳中」
    uploading: (opts.files?.length ?? 0) > 0,
    uploadedNames: (opts.files ?? []).map((f) => f.name),
  };
  pendings.set(opts.conversationId, pending);
  emit();

  const form = new FormData();
  form.append('question', opts.question);
  form.append('conversation_id', opts.conversationId);
  if (opts.model) form.append('model', opts.model);
  if (opts.kb) form.append('kb', opts.kb);
  for (const file of opts.files ?? []) form.append('files', file, file.name);

  void (async () => {
    try {
      const base = import.meta.env.VITE_API_BASE || '';
      const res = await fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);

        // 409 = 這組對話已經有一題在跑(多半是另一個分頁、或另一台電腦送的)。
        // 這**不是錯誤**:把自己這筆暫存收掉,改去 /api/ask/runs 找到那一題接上去
        // (那條串流會從第一個事件重播,連中間讀過哪些檔案都補得回來)。
        // 一定要先 delete —— attachStream 看到同一組已經有 pending 就會直接 return。
        if (res.status === 409) {
          pendings.delete(opts.conversationId);
          emit();
          await syncActiveRuns();
          if (!pendings.has(opts.conversationId)) {
            // 剛好在這一瞬間跑完了,接不到東西:照實說,不要留一個空畫面
            pending.done = true;
            pending.success = false;
            pending.error = detail?.detail ?? 'That chat already has a question running.';
            pendings.set(opts.conversationId, pending);
          }
          emit();
          return;
        }

        pending.done = true;
        pending.success = false;
        // 錯誤訊息要帶實際原因,不要一律「送出失敗」
        pending.error = detail?.detail ?? `The server responded with ${res.status}.`;
        emit();
        return;
      }
      await consume(res, pending);
    } catch (err) {
      pending.done = true;
      pending.success = false;
      pending.error = err instanceof Error ? err.message : 'Could not send the question.';
      emit();
    }
  })();

  return pending;
}

/** 接回一個還在跑的 run。串流會從第一個事件重播。 */
export function attachStream(run: {
  run_id: string;
  conversation_id: string;
  question: string;
  started_at_ms: number;
  knowledge_base?: string | null;
}): void {
  const existing = pendings.get(run.conversation_id);
  // 已經有一筆**還在跑**的就不要重複接;已經結束的那筆可以被取代 ——
  // 不然停止失敗之後,「停不掉、也接不回來」的孤兒會永遠卡在那裡。
  if (existing && !existing.done) return;

  const pending: Pending = {
    conversationId: run.conversation_id,
    question: run.question,
    runId: run.run_id,
    knowledgeBase: run.knowledge_base ?? null,
    text: '',
    sources: [],
    notices: [],
    startedAt: run.started_at_ms,
    done: false,
  };
  pendings.set(run.conversation_id, pending);
  emit();

  void (async () => {
    try {
      const base = import.meta.env.VITE_API_BASE || '';
      const res = await fetch(`${base}/api/ask/runs/${run.run_id}/stream`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        pending.done = true;
        if (res.status === 404) {
          // 404 = 這題結束太久了,事件流已經被清掉。答案在對話紀錄裡,不是錯誤。
          pending.success = true;
        } else {
          // 其他狀態(500、401…)不能當成「答完了」—— 那會畫出一則
          // 空白但「成功」的回答,小夥伴還會演成答完了。
          pending.success = false;
          pending.error = `The server responded with ${res.status}.`;
        }
        emit();
        return;
      }
      await consume(res, pending);
    } catch {
      pending.done = true;
      pending.success = false;
      pending.error = 'The connection dropped.';
      emit();
    }
  })();
}

/**
 * 一載入就問「有哪些還在跑」,再接回去。
 *
 * ⚠️ 一定要等 me.username 有值才呼叫 —— 未登入時打這支必定 401,
 * 而 401 攔截器會清 token,自己把狀態洗掉。
 */
export async function syncActiveRuns(): Promise<void> {
  try {
    const base = import.meta.env.VITE_API_BASE || '';
    const res = await fetch(`${base}/api/ask/runs`, {headers: authHeaders()});
    if (!res.ok) return;
    const list = (await res.json()) as Parameters<typeof attachStream>[0][];
    for (const run of list) attachStream(run);
  } catch {
    // 靜默:接不回來最多是少看到進度,不該在畫面上報錯。
  }
}

/**
 * 停止。
 * 打 API,不是關這端的連線 —— 關連線它會照跑完、照計費。
 * 已經寫出來的內容後端會保留下來存進資料庫。
 */
export async function stopStream(conversationId: string): Promise<void> {
  const pending = pendings.get(conversationId);
  if (!pending || pending.done) return;

  if (!pending.runId) {
    /*
     * 送出後的前幾秒,start 事件還沒到,所以還不知道 run_id。
     *
     * ⚠️ **不要**改成關掉自己這條 fetch。那一題在 POST 進去的當下就已經
     * 在伺服器上跑了(見檔頭):關連線它照跑照計費,而且關了就再也收不到
     * start 事件、永遠拿不到 run_id —— 那一題會變成「停不掉、也接不回來」
     * 的孤兒,畫面上卻寫著已停止。
     *
     * 記一個旗標就好,start 事件一到 apply() 會立刻補送。
     */
    pending.stopRequested = true;
    emit();
    return;
  }

  await requestStop(pending);
}

/** 真的把停止送出去。只有伺服器回 ok 才算停掉了。 */
async function requestStop(pending: Pending): Promise<void> {
  pending.stopRequested = false;
  try {
    const base = import.meta.env.VITE_API_BASE || '';
    const res = await fetch(`${base}/api/ask/runs/${pending.runId}/stop`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(String(res.status));
    pending.stopped = true;
  } catch {
    // 停止失敗就讓串流自己跑完,不要在這裡假裝停掉了 ——
    // 但一定要講(使用者主動觸發的動作失敗要 toast),
    // 不然他會以為停掉了,而伺服器還在跑、還在計費。
    toastError('Could not stop this question — it is still running on the server.');
  }
  emit();
}
