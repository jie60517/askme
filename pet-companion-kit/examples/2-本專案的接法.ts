/**
 * 例二:「問我問我(AskME)」是怎麼接的
 *
 * 你的專案已經有一層集中管理「正在跑的工作」的 store 時,照這個形狀接就好
 * ——(還沒有的話看例一,那一份連 store 一起附。)
 *
 * 這份是**節錄**,拿來說明 `PetSource` 這個介面為什麼長成三個問題;
 * 能直接跑的完整版是 `frontend/src/lib/petSetup.tsx`(還多接了未讀 @ 提及、
 * 用量通報與 `renderLink`),要照抄請照抄那一份。
 *
 * 本專案的模型是:每一組對話(conversation)最多有一個 `Pending`,那份資料放在
 * 模組層級的 Map 裡(不是 React state)—— 使用者切走再切回來時元件會重新掛載,
 * 放在元件裡的話正在跑的回答會跟著消失。
 *
 * ⚠️ **`examples/` 不在任何建置或型別檢查流程裡**(`frontend/tsconfig.json` 的
 * `include` 只有 `["src", "vite.config.ts"]`)。改 `frontend/src/pet/` 的對外 API
 * 時請回來把這三份看一遍 —— 它們跟正本分岔了不會有任何自動機制抓到。
 */

// 這兩個路徑寫成相對的,是因為 examples/ 在 frontend/ 外面。
// 在 frontend/ 裡面寫就是 `@/pet` 與 `@/lib/runs`(tsconfig 的 `@/*` → `./src/*`)。
import {
  configurePetSource,
  configurePet,
  type PetTask,
  type PetTool,
} from "../../frontend/src/pet";
import {
  getActiveStreams,
  getPending,
  isStopped,
  subscribeAll,
  type Pending,
} from "../../frontend/src/lib/runs";

/**
 * 後端的工具名稱 → 小夥伴的四種類別。
 *
 * 本專案把這張對照表放在 `lib/tools.ts`(`toolKind()`),匯出功能與這裡共用同一份 ——
 * 兩邊各抄一份的話,後端加一種工具就會變成只有一邊認得。
 */
function mapTool(tool: string): PetTool {
  switch (tool) {
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "Bash":
      return "run";
    default:
      // 後端的工具集會變,認不得的一律當「在做事」,不要漏掉狀態
      return "other";
  }
}

function toTask(p: Pending | undefined): PetTask | undefined {
  if (!p) return undefined;
  const last = p.sources[p.sources.length - 1];
  return {
    // finalId 是 start 事件之後才有;之前用「對話 + 送出時間」頂著。
    // kit 只拿它去重(結束表情一件只演一次),整個生命週期內不變就夠。
    id: p.finalId ?? `${p.conversationId}:${p.startedAt}`,
    startedAt: p.startedAt,
    queued: p.queuePosition !== undefined,
    uploading: p.uploading === true,
    notices: p.notices.map((n) => n.message),
    latestTool: last ? mapTool(last.tool) : undefined,
    streaming: p.text.length > 0,
    done: p.done,
    success: p.success === true,
    // 「是不是被使用者停掉的」只有 runs.ts 的 isStopped() 一份判斷;kit 只吃
    // error 字串,所以停掉的統一翻成「已停止」,正好落在下面的 isStoppedByUser 上
    error: isStopped(p) ? "已停止" : p.error,
  };
}

/** 網址上的對話 id(`/c/xxx`)。kit 每次重算都會來問,直接讀 location 不經 router。 */
function conversationIdFromPath(): string | undefined {
  const path = window.location.pathname;
  return path.startsWith("/c/") ? decodeURIComponent(path.slice(3)) : undefined;
}

/**
 * ⚠️ **這是 SPEC 4.1 點名的坑**:新對話送出的瞬間網址還是 `/`,照網址查會查不到
 * 自己這一題 —— 就會掉進「別組對話還在跑」(`background`),而且被換圖節流鎖住
 * 1.2 秒,使用者一定看得到那個錯誤狀態。
 *
 * 解法是資料層多一條退路:網址查不到時,**剛送出**(4 秒內)的那一件也算這一頁的。
 *
 * ⚠️ 代價寫在這裡:這條退路分不出「這一頁剛送出」與「別頁剛送出」——
 * 在 A 頁送出後 4 秒內切到 B 頁,B 頁會把 A 的那件當成自己的(該顯示 `background`
 * 的那 4 秒顯示成進行中)。用網址以外的方式標記送出來源才擋得掉,但那要動到送出
 * 路徑上的每一個呼叫點;而這 4 秒剛好是使用者最可能盯著小夥伴看的那 4 秒,
 * 所以取捨成「寧可這一頁多顯示,不要自己送出的那一題顯示成別人的」。
 */
const JUST_SENT_MS = 4000;

function currentTask(): PetTask | undefined {
  const byPath = getPending(conversationIdFromPath());
  if (byPath) return toTask(byPath);
  const justSent = getActiveStreams().find((p) => Date.now() - p.startedAt < JUST_SENT_MS);
  return toTask(justSent);
}

configurePetSource({
  getCurrentTask: currentTask,
  // 只算還在跑的。已完成的那幾秒還留在 store 裡(kit 要靠它演結果表情),
  // 算進來的話會被誤判成「還有事在跑」
  getActiveCount: () => getActiveStreams().length,
  subscribe: subscribeAll,
});

configurePet({
  name: "小夥伴",
  // 每人同時最多跑 3 題(後端 MAX_CONCURRENT_ASKS_PER_USER 的預設),所以 3 就是滿載
  capacity: 3,
  storagePrefix: "t100_pet",
  // 停止有兩條路徑,訊息不一樣,所以要用 startsWith 不能用相等:
  //   伺服器收尾(有 runId,正常情況):「已停止(還沒開始產生內容)」
  //   前端中止(還沒拿到 runId 的罕見情況):「已停止」
  // 寫死相等只對得上後者,實際上幾乎都會走前者。
  isStoppedByUser: (error) => !!error?.startsWith("已停止"),
});
