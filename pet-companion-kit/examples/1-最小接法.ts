/**
 * 例一:最小可動的接法(自己寫一個小 store)
 *
 * 你的專案如果還沒有集中管理「正在跑的工作」,直接抄這一份 —— 大約 60 行,
 * 之後把 startTask / updateTask / finishTask 接到你真正送出請求的地方就好。
 *
 * ⚠️ **`examples/` 不在任何建置或型別檢查流程裡**(`frontend/tsconfig.json` 的
 * `include` 只有 `["src", "vite.config.ts"]`)。改 `frontend/src/pet/` 的對外 API
 * 時請回來把這三份看一遍 —— 它們跟正本分岔了不會有任何自動機制抓到。
 */

// 正本在 frontend/src/pet/(見 README 開頭的說明),不在這個資料夾裡
import { configurePetSource, type PetTask } from "../../frontend/src/pet";

// ── 一個最陽春的 store ────────────────────────────────────────────────
// key = 這件工作屬於哪一頁 / 哪一組資料(例如對話 id、報表 id、訂單號)
const tasks = new Map<string, PetTask>();
const listeners = new Set<() => void>();

/** 使用者現在看的是哪一頁。換頁時要更新。 */
let currentKey: string | undefined;

function notify() {
  listeners.forEach((fn) => fn());
}

export function setCurrentKey(key: string | undefined) {
  currentKey = key;
  notify();
}

export function startTask(key: string, task: Omit<PetTask, "done" | "success">) {
  tasks.set(key, { ...task, done: false, success: false });
  notify();
}

export function updateTask(key: string, patch: Partial<PetTask>) {
  const prev = tasks.get(key);
  if (!prev) return;
  tasks.set(key, { ...prev, ...patch });
  notify();
}

export function finishTask(key: string, success: boolean, error?: string | null) {
  const prev = tasks.get(key);
  if (!prev) return;
  // ⚠️ 完成的那一件要**留在 map 裡**幾秒,小夥伴才看得到 done=true 而跳出
  // happy / sad。直接 delete 的話牠會直接回去睡,使用者完全不知道成功了沒。
  tasks.set(key, { ...prev, done: true, success, error: error ?? null });
  notify();
  window.setTimeout(() => {
    // 5 秒後才清掉(TRANSIENT_MS 是 4 秒,留一點餘裕)
    if (tasks.get(key)?.done) {
      tasks.delete(key);
      notify();
    }
  }, 5000);
}

// ── 接上小夥伴 ────────────────────────────────────────────────────────
configurePetSource({
  getCurrentTask: () => (currentKey ? tasks.get(currentKey) : undefined),
  // 只算還在跑的,已完成的不算 —— 不然剛跑完那 4 秒會被誤判成「還有事在跑」
  getActiveCount: () => [...tasks.values()].filter((t) => !t.done).length,
  subscribe: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
});

// ── 實際使用長這樣 ────────────────────────────────────────────────────
//
//   startTask("order-123", { id: "run-abc", startedAt: Date.now(), queued: true });
//   updateTask("order-123", { queued: false, latestTool: "search" });
//   updateTask("order-123", { latestTool: "read" });
//   updateTask("order-123", { streaming: true });        // 開始吐字
//   finishTask("order-123", true);
//
// 換頁時:
//   setCurrentKey(location.pathname.startsWith("/o/") ? location.pathname.slice(3) : undefined);
