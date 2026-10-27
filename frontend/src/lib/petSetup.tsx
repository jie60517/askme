/**
 * 小夥伴(pet-companion-kit)的接線。
 *
 * kit 的 README 說得很清楚:`src/pet/` 是**不用改**的可攜版,唯一要動腦的是
 * 這裡 —— 把它要的三個訊號(這一頁在跑什麼、全站幾件在跑、有變化叫我)
 * 接到 `lib/runs.ts` 的模組層 store 上。kit 是自己來拉(pull)的,
 * Chat 不參與,不要做「Chat 每次 render 推一包訊號」的管線。
 *
 * ⚠️ 這個檔案**在模組層級就執行 configure**,所以要在 <PetCompanion /> 掛上
 * 之前被 import(App.tsx 的 import 就夠了,ES module 的執行順序保證這點)。
 * ⚠️ 不要從 '../pet'(index)import —— 那會把 PetCompanion 連 framer-motion
 * 一起拉進主 chunk;元件本體是 lazy 的,這裡只碰輕的那幾個模組。
 */
import type {ReactNode} from 'react';
import {useLinkComponent} from '@astryxdesign/core/Link';

import {useBlobColor, useBlobShape, useCompanion} from './companionPref';
import {TRANSIENT_MS} from '../pet/pet-sprites';
import {petSay} from '../pet/petSpeech';
import {configurePet, configurePetSource, type PetTask, type PetTool} from '../pet/petSource';
import {toolKind} from './tools';
import {
  getActiveStreams,
  getPending,
  isStopped,
  listPendings,
  subscribeAll,
  type Pending,
  type RunSource,
} from './runs';
import {describeUsage, getUsageLimit, usageDelta} from './usageLimit';

/**
 * 最近一次用到的工具是哪一類。
 *
 * ⚠️ 對照表在 **`lib/tools.ts`**(單一來源)—— 這裡跟匯出那邊
 * 各抄一份的話,後端加一種工具就會變成只有一邊認得。
 * kit 的 `PetTool` 恰好跟 `ToolKind` 是同一組字面值,所以直接通過去。
 */
function latestTool(sources: RunSource[]): PetTool | undefined {
  const last = sources[sources.length - 1];
  if (!last) return undefined;
  return toolKind(last.tool);
}

function toTask(p: Pending | undefined): PetTask | undefined {
  if (!p) return undefined;
  return {
    // finalId 是 start 事件之後才有;之前用「對話 + 送出時間」頂著。
    // kit 只拿它去重(結束表情一題只演一次),整個生命週期不變就好。
    id: p.finalId ?? `${p.conversationId}:${p.startedAt}`,
    startedAt: p.startedAt,
    queued: p.queuePosition !== undefined,
    uploading: p.uploading === true,
    notices: p.notices.map((n) => n.message),
    latestTool: latestTool(p.sources),
    streaming: p.text.length > 0,
    done: p.done,
    success: p.success === true,
    /*
     * 「是不是被停掉的」只有 runs.ts 的 isStopped() 一份判斷(它同時看
     * stopped 旗標與後端寫的「已停止」開頭)—— kit 只吃 error 字串,
     * 所以停掉的統一翻成「已停止」,正好落在 kit 預設的 isStoppedByUser 上。
     */
    error: isStopped(p) ? '已停止' : p.error,
  };
}

/** 網址上的對話 id(/c/xxx)。kit 每次重算都會來問,直接讀 location 不經 router。 */
function conversationIdFromPath(): string | undefined {
  const path = window.location.pathname;
  return path.startsWith('/c/') ? decodeURIComponent(path.slice(3)) : undefined;
}

/**
 * 這一頁的那一件工作。
 *
 * ⚠️ 退路是 kit 文件點名的坑:新對話送出的瞬間網址還是 `/`,照網址查會查不到
 * 自己這一題 → 被誤判成「別組在跑」(background)而且被換圖節流鎖 1.2 秒。
 * 所以網址查不到時,**剛送出**(4 秒內)的那一件也算這一頁的。
 */
const JUST_SENT_MS = 4000;

function currentTask(): PetTask | undefined {
  const byPath = getPending(conversationIdFromPath());
  if (byPath) return toTask(byPath);
  const justSent = getActiveStreams().find((p) => Date.now() - p.startedAt < JUST_SENT_MS);
  return toTask(justSent);
}

/**
 * 「有人 @ 我而我還沒讀」——小夥伴閒著的時候要舉這個提示。
 *
 * 做法是**餵一件假的工作**給 kit,而不是去改 kit 的狀態機(`src/pet/` 要保持
 * 可以直接覆蓋升級):`deriveState` 的優先序是 排隊 → 上傳 → 忙 → **notice**
 * → 跑很久 → 工具,所以一件「沒在跑、只帶 notices」的工作正好落在 notice 那一格。
 *
 * ⚠️ 代價是這件假工作會**整段跳過** kit「非進行中」那一支推導(`pet-companion-kit/SPEC.md` 5.2 下半:
 * transient → background → sleeping → walking)—— 它是假的 `done: false`,
 * `deriveState` 第一行就收走了。所以它只在**全站都沒事**的時候才餵下去。
 * 完整優先序(與 kit SPEC §5.2 的接線註記一致):
 *
 *     這一頁的工作 > background(別頁還在跑) > 未讀 @ > sleeping / walking
 *
 * 兩個理由:
 *  - 真的有題目在跑時該看的是進度,不是提醒。
 *  - `background` 講的是「別頁**現在**還在跑」,那件事跑完這個訊號就消失了;
 *    未讀 @ 會一直在,直到人去讀它,晚幾分鐘輪到不會少講。反過來讓 @ 壓住
 *    `background` 的話,只要有一則沒讀,`background` 就永遠出不來。
 *
 * ⚠️ @ 本身**不靠這個狀態通知使用者** —— 真正會叫住人的是 `lib/sharedWatch.ts`
 * 那條 `petSay()` 佇列(氣泡 + 可以點進去的連結),它跟這裡的狀態圖無關,
 * 什麼時候都會講。這張圖只是「還有東西沒看」的餘光提示。
 */
let unreadMentions = 0;
let unreadSince = 0;
/** kit 只訂閱一次,所以未讀變化要跟串流事件走同一條通知管道(見 subscribe) */
const unreadListeners = new Set<() => void>();

/** 輪詢(`sharedWatch`)每次拿到新的未讀數就呼叫這裡。 */
export function setPetUnread(count: number) {
  if (count === unreadMentions) return;
  if (unreadMentions === 0) unreadSince = Date.now();
  unreadMentions = count;
  for (const cb of unreadListeners) cb();
}

/** 未讀那件假工作。`done: false` 才進得了 deriveState 的第一段。 */
function unreadTask(): PetTask {
  return {
    id: 'unread-mentions',
    startedAt: unreadSince,
    notices: [`${unreadMentions} unread mention${unreadMentions === 1 ? '' : 's'}`],
    done: false,
    success: false,
  };
}

/**
 * 「回答完成」之後,再講一句用量(本次耗用幾 %、剩餘幾 %、幾分鐘後重置)。
 *
 * 「本次耗用」= **答完時的用量減送出時的用量**,兩份快照都在這裡拿:
 * 送出的那一刻(pending 第一次出現)讀一次當基準,答完再讀一次。只有前端知道
 * 每一題的送出與答完是哪兩個時刻,後端那支只回當下的事實(差值放在後端算的話,
 * TTL 內的第二題會唸到第一題的差、視窗一重置就唸負數)。
 *
 * ⚠️ 順序是這件事的重點,而它是靠**等** kit 的結果表情演完來達成的:
 * 完成的那一刻 kit 會進 `happy` 並顯示「完成了!」,那個狀態撐 `TRANSIENT_MS`;
 * 期間 `petSay` 的氣泡會蓋掉那句話 —— 太早講的話使用者會**看不到「完成了!」**,
 * 而那正是要先出現的第一句。所以等滿 TRANSIENT_MS 再講。
 *
 * ⚠️ 這裡自己訂閱 `subscribeAll`,**不改 kit**(`src/pet/` 要維持可以整包覆蓋升級,
 * 見檔頭)。kit 是自己來拉的,沒有「答完了通知我」這種回呼。
 */

/** 一題的 key:對話 + 送出時間。從第一個事件起就不變(finalId 要到 start 事件才有)。 */
function runKey(p: Pending): string {
  return `${p.conversationId}:${p.startedAt}`;
}

/** 送出時讀到的用量(基準)。resolve 成 null = 那時候讀不到。 */
const baselines = new Map<string, Promise<number | null>>();
/**
 * 已經講過的題。
 *
 * 擋的是「done 之後的每一次 emit」—— 一題答完之後串流還會再 emit 幾次
 *(files、收尾、別題的事件也會叫到這裡),不去重的話同一題會被講好幾遍。
 *(**不是**防重新整理後的重播:這是模組層的 Set,重新整理就清空;而
 * `GET /api/ask/runs` 也只接回還在跑的,答完的本來就不會重播。)
 */
const spoken = new Set<string>();

function watchRunsForUsage() {
  const alive = new Set<string>();
  for (const p of listPendings()) {
    const key = runKey(p);
    alive.add(key);
    if (!baselines.has(key)) {
      // 送出的那一刻讀一次基準。拿到快取的也可以 —— 要的只是「這一題開始前的水位」。
      // (重新整理之後**接回**的題目,基準是接回當下、不是送出當下,差值會偏低 ——
      //  那一題送出時的水位已經沒有人記得了,偏低比編一個數字誠實。)
      baselines.set(key, getUsageLimit().then((u) => u?.used_percent ?? null));
    }
    // 只在**成功**答完之後講。失敗或被停止的時候,畫面上要講的是那件事,
    // 用量是個不相干的數字 —— 那一刻插一句百分比只會蓋掉錯誤訊息。
    if (!p.done || p.success !== true || isStopped(p) || spoken.has(key)) continue;
    spoken.add(key);
    void speakUsageSoon(baselines.get(key) ?? Promise.resolve(null));
  }
  // 題目被清掉(`clearPending`)之後把它的記錄一起清掉,兩張表才不會跟著一整天的題目長大
  for (const key of [...baselines.keys()]) {
    if (!alive.has(key)) {
      baselines.delete(key);
      spoken.delete(key);
    }
  }
}

/**
 * 先去問用量,等 kit 的「完成了!」演完再講。
 *
 * 三件事同時起跑而不是排隊做:後端那支可能要跑一個子行程(秒級),
 * 排隊做的話這句話會晚到「完成了!」結束之後好幾秒,中間小夥伴已經睡著了。
 */
async function speakUsageSoon(baseline: Promise<number | null>) {
  const [before, after] = await Promise.all([
    baseline,
    // 答完那一次要的是**現在**的水位,不吃快取(理由見 getUsageLimit)
    getUsageLimit({fresh: true}),
    new Promise((resolve) => setTimeout(resolve, TRANSIENT_MS)),
  ]);
  // 讀不到就什麼都不講(見 lib/usageLimit.ts):寧可少一句,也不要編一個數字
  if (!after) return;
  // 這 4 秒內使用者已經送出下一題的話,小夥伴正在演「思考中」—— 那時候該看的是
  // 進度,不要拿一句過期的用量把它蓋掉
  if (getActiveStreams().length > 0) return;
  petSay({text: describeUsage(after, usageDelta(before, after.used_percent)), state: 'happy'});
}

configurePetSource({
  /*
   * 優先序見 `unreadTask` 上面那一段:
   *   這一頁的工作 > background(別頁還在跑) > 未讀 @ > sleeping / walking
   *
   * 回 `undefined` 就是把場子讓給 kit 的 `deriveState` 去判 background /
   * sleeping / walking,所以「別頁在跑」時**不能**在這裡塞未讀那件假工作 ——
   * 塞了的話 `background` 這個狀態永遠出不來(在 A 頁送出後切到
   * B 頁要顯示 background)。
   */
  getCurrentTask: () => {
    const mine = currentTask();
    // 已經跑完的那一件也要回(kit 靠它的 done/success 演結果表情),所以不是只看「在跑的」
    if (mine) return mine;
    if (getActiveStreams().length > 0) return undefined;
    return unreadMentions > 0 ? unreadTask() : undefined;
  },
  getActiveCount: () => getActiveStreams().length,
  subscribe: (cb) => {
    /*
     * ⚠️ 用量那一句掛在**這條訂閱**上,不要放進 `getCurrentTask()` ——
     * 那支是 render 期間被拉的,在裡面送 API 與排計時器會跟著重繪次數跑。
     * 這裡則是「串流有動靜」才會進來一次。
     */
    const off = subscribeAll(() => {
      watchRunsForUsage();
      cb();
    });
    unreadListeners.add(cb);
    return () => {
      off();
      unreadListeners.delete(cb);
    };
  },
});

/**
 * 氣泡裡的連結。走全站的 LinkProvider(`App.tsx` 的 `AppLink`),跟側邊欄、對話列同一條路 ——
 * 「已經是舊版就整頁導覽」那一段(`lib/appVersion.ts`)才對小夥伴的連結也有效。
 * 不要直接用 react-router 的 `<Link>`,那會繞過這一層。
 * 小夥伴掛在 `Chrome` 底下,在 LinkProvider 裡面,所以拿得到 AppLink;外觀不變(都是一個 `<a>`)。
 */
function PetLink({href, onClick, children}: {href: string; onClick: () => void; children: ReactNode}) {
  const LinkComponent = useLinkComponent();
  return (
    <LinkComponent href={href} onClick={onClick}>
      {children}
    </LinkComponent>
  );
}

configurePet({
  // 只出現在無障礙標籤。中文是刻意的例外,跟台詞同一套(見下面 spriteOverrides 那段)
  name: '小夥伴',
  // 每個人同時最多跑 3 題(後端 MAX_CONCURRENT_ASKS_PER_USER 的預設值)
  capacity: 3,
  // 兩隻角色共用同一個前綴 —— 使用者藏起來/釘住的位置不因為換角色而歸零
  storagePrefix: 't100_pet',
  // 氣泡的連結要走 SPA 路由,不然點一下整頁重載、正在跑的串流全斷
  renderLink: (href, children, onClick) => (
    <PetLink href={href} onClick={onClick}>
      {children}
    </PetLink>
  ),
  /*
   * 台詞用 kit 的預設(台灣用語的繁體中文)。
   * ⚠️ 這是**刻意的例外**,不適用「畫面字串一律英文」的專案慣例 ——
   * 小夥伴的台詞是角色個性的一部分,kit 的預設就是照台灣的口語寫的,
   * 不要再套 spriteOverrides 翻回英文。
   */
  // 個人設定裡選了 Blob 就畫 bloub(`lib/companionPref.ts`)。這是 hook,kit 每次重繪都會呼叫
  useBlob: useBlobCompanion,
  // 個人設定裡挑的形狀與顏色(`auto` = 跟著佈景,在 kit 那邊是 null)
  useBlobLook: useBlobLookPref,
});

function useBlobCompanion(): boolean {
  return useCompanion() === 'blob';
}

function useBlobLookPref() {
  const shape = useBlobShape();
  const color = useBlobColor();
  return {shape, color: color === 'auto' ? null : color};
}
