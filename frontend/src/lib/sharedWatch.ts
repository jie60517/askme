/**
 * 通知輪詢。
 *
 * 8 秒一次:分頁在背景不打、沒登入不打、切回前景馬上補一次。
 *
 * **為什麼是輪詢不是推播**:問答的串流是「一題一條 ndjson,跑完就關」——
 * 為了一則通知另外架一條 SSE / WebSocket(還要處理重連、心跳、反向代理的逾時)
 * 不划算,而這裡的即時性要求是「幾秒內」不是「幾毫秒內」。
 *
 * 一次輪詢做四件事(順序有意義,見下面 `check`)。
 */

import {
  getPendingMentions,
  listConversations,
  markMentionsAnnounced,
  notifyConversationsUpdated,
  type ConversationSummary,
} from './conversationsApi';
import {petSay, SPEECH_MS} from '../pet/petSpeech';
import {syncActiveRuns} from './runs';

const POLL_MS = 8000;

/** 氣泡上的便條內容切這麼長。整段唸完會蓋掉半個畫面,而且氣泡是會自己消失的 */
const BUBBLE_BODY_CHARS = 60;

/**
 * 「這一組對話現在長什麼樣」的簽章。
 *
 * ⚠️ **一定要涵蓋共用關係與未讀數,不能只比 `updated_at`** ——
 * 有人把自己從共用裡移掉、或別人 @ 了我,那一組的 `updated_at` 都不會動,
 * 側邊欄就永遠停在舊的樣子。
 */
function shapeOf(c: ConversationSummary): string {
  return [
    c.updated_at,
    c.running,
    c.shared_with_me,
    c.shared_out,
    c.shared_by ?? '',
    c.unread_mentions,
  ].join('|');
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > BUBBLE_BODY_CHARS ? `${flat.slice(0, BUBBLE_BODY_CHARS)}…` : flat;
}

/**
 * 目前這個帳號的輪詢。整組狀態放在這裡,**換帳號時整組重來** ——
 * 留著上一個人的基準的話,新登入的人一進來就會被通報一輪
 * 「有新的共用對話」(其實是上一個人早就看過的那些)。
 */
/**
 * 要講的一句話。`mentionId` 有值的才要回報「已經彈過了」。
 *
 * ⚠️ **共用通知與 @ 提及走同一條佇列**,不能各自 `petSay()`:氣泡只有一個,
 * 同一輪輪詢裡兩邊都想講的話,後講的會在 0 毫秒後把前一句直接蓋掉,前一句等於沒出現過。
 */
type Speech = {
  text: string;
  href: string;
  mentionId?: number;
};

type Watch = {
  username: string;
  /** 已經知道的「別人分享給我的」對話 id */
  known: Set<string>;
  /** 已經知道正在跑的對話 id */
  knownRunning: Set<string>;
  /** 對話 id → 上一次的長相簽章 */
  knownShape: Map<string, string>;
  /** 已經排進佇列、還沒講出口的提及 id */
  queued: Set<number>;
  /** 正在講(有人在跑 drain)。同時跑兩個的話兩句會疊在一起 */
  speaking: boolean;
  pending: Speech[];
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

let watch: Watch | null = null;

/** 未讀數變了要通知外面(小夥伴的 `notice` 訊號)。 */
let onUnread: ((unread: number) => void) | null = null;

/**
 * 一句一句講。
 *
 * ⚠️ **講完一則才 `markMentionsAnnounced([id])`**,不要一次標掉整批:
 * 一次標掉的話第三則要等 12 秒才輪到,而使用者提早關掉分頁就永遠聽不到,
 * 伺服器那邊卻已經記成「講過了」。
 */
async function drain(w: Watch) {
  if (w.speaking) return;
  w.speaking = true;
  while (w.pending.length > 0 && !w.stopped) {
    const speech = w.pending.shift() as Speech;
    petSay({text: speech.text, href: speech.href});
    if (speech.mentionId !== undefined) {
      w.queued.delete(speech.mentionId);
      try {
        await markMentionsAnnounced([speech.mentionId]);
      } catch {
        // 回報失敗就讓它下一輪再出現一次。多講一次比永遠不講好
      }
    }
    // 等這個氣泡講完再講下一句 —— 不等的話後面那句會把前一句直接蓋掉
    await new Promise((resolve) => setTimeout(resolve, SPEECH_MS));
  }
  w.speaking = false;
}

/**
 * 跑一次。`announce = false` 是**第一次**:只記基準、不彈通知
 * —— 一登入就被「有 12 個新的共用對話」轟一輪不是通知,是噪音。
 * ⚠️ 但**未讀數第一次就要抓**:那是小夥伴頭上的數字,不是通報。
 */
async function check(w: Watch, announce: boolean) {
  let list: ConversationSummary[];
  try {
    list = await listConversations();
  } catch {
    // 靜默:通知是加值功能,而使用者可能正在讀答案 ——
    // 為了一次沒抓到就在畫面上彈錯誤,比沒有通知更煩
    return;
  }
  if (w.stopped) return;

  const running = new Set(list.filter((c) => c.running).map((c) => c.conversation_id));
  const shared = new Set(
    list.filter((c) => c.shared_with_me).map((c) => c.conversation_id),
  );

  // 2. 正在跑的那一組變了 → 把串流接回來。
  //    **這一行才是「共用者看得到別人正在下 grep」真正生效的地方**
  const runningChanged =
    running.size !== w.knownRunning.size || [...running].some((id) => !w.knownRunning.has(id));
  if (runningChanged) void syncActiveRuns();

  // 3. 任何一組的長相變了 → 讓側邊欄自己去重抓
  let shapeChanged = list.length !== w.knownShape.size;
  for (const c of list) {
    if (w.knownShape.get(c.conversation_id) !== shapeOf(c)) shapeChanged = true;
  }

  // 4. 還沒彈過的提及 + 未讀數
  let poll: Awaited<ReturnType<typeof getPendingMentions>> | null = null;
  try {
    poll = await getPendingMentions();
  } catch {
    // 同上,靜默
  }
  if (w.stopped) return;

  if (poll) onUnread?.(poll.unread);

  if (announce) {
    /*
     * ⚠️ 被 @ 的那幾組**不要再講一次共用通知**:有人 @ 我的時候後端會順手把我
     * 拉進共用,所以同一件事會同時觸發「有人分享給你」與「某某 @ 了你」。
     * 兩句一起講不只囉唆,而且先講的是資訊比較少的那一句。
     */
    const mentioned = new Set((poll?.announce ?? []).map((m) => m.conversation_id));
    const fresh = list.filter(
      (c) =>
        c.shared_with_me && !w.known.has(c.conversation_id) && !mentioned.has(c.conversation_id),
    );
    if (fresh.length > 0) {
      /*
       * 一次只排**一句**:氣泡只有一個,而且下面那行會把整批都記成 known
       * —— 一次分五組進來時逐組講會唸掉半分鐘,所以多的那幾組講數量就好,
       * 不要默默吞掉(使用者只會看到側邊欄多了幾條卻沒人告訴他)。
       */
      const first = fresh[0];
      w.pending.push({
        // 小夥伴的台詞是中文(跟 kit 的預設台詞同一個腔)
        text:
          fresh.length > 1
            ? `有 ${fresh.length} 組對話分享給你`
            : first.shared_by
              ? `${first.shared_by} 分享了一組對話給你`
              : '有人分享了一組對話給你',
        href: `/c/${first.conversation_id}`,
      });
    }

    for (const mention of poll?.announce ?? []) {
      // ⚠️ `queued` 濾掉「已經排進佇列但還沒講出口」的 —— 少了它,
      // 下一輪輪詢會把同一則再排一次(它要等講完才會被標成已通報)
      if (w.queued.has(mention.id)) continue;
      w.queued.add(mention.id);
      w.pending.push({
        text: `${mention.author_name}:${shorten(mention.body)}`,
        href: `/c/${mention.conversation_id}`,
        mentionId: mention.id,
      });
    }
    if (w.pending.length > 0) void drain(w);
  }

  w.known = shared;
  w.knownRunning = running;
  w.knownShape = new Map(list.map((c) => [c.conversation_id, shapeOf(c)]));

  if (shapeChanged && announce) notifyConversationsUpdated();
}

function schedule(w: Watch) {
  w.timer = setTimeout(() => {
    if (w.stopped) return;
    // 分頁在背景不打:那時候沒有人在看,而每一次都是一趟連線與一次資料庫查詢
    if (!document.hidden) void check(w, true);
    schedule(w);
  }, POLL_MS);
}

/**
 * 開始輪詢。回傳停止函式(呼叫端在登出 / 換帳號 / 卸載時呼叫)。
 *
 * ⚠️ 一定要等 `me.username` 有值才呼叫 —— 未登入時打這幾支必定 401,
 * 而 401 攔截器會清 token,自己把狀態洗掉(跟 `syncActiveRuns` 同一條理由)。
 */
export function startSharedWatch(
  username: string,
  onUnreadChange: (unread: number) => void,
): () => void {
  stopSharedWatch();

  const w: Watch = {
    username,
    known: new Set(),
    knownRunning: new Set(),
    knownShape: new Map(),
    queued: new Set(),
    speaking: false,
    pending: [],
    stopped: false,
    timer: undefined,
  };
  watch = w;
  onUnread = onUnreadChange;

  // 第一次只記基準(`announce = false`),未讀數照樣會抓到
  void check(w, false);
  schedule(w);

  /*
   * 切回前景馬上補一次:8 秒的間隔在「人剛回到電腦前」那一刻太久了,
   * 而那正是他最可能有東西要看的時候(背景那段時間完全沒打)。
   */
  const onVisible = () => {
    if (!document.hidden && !w.stopped) void check(w, true);
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    stopSharedWatch();
  };
}

function stopSharedWatch() {
  if (!watch) return;
  watch.stopped = true;
  if (watch.timer) clearTimeout(watch.timer);
  watch = null;
  onUnread = null;
}
