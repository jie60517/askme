/**
 * 前端版本偵測 —— 上版之後,「已經開著的分頁」要自己發現並換過去。
 *
 * 沒有它的話,一直開著的分頁會永遠停在舊版,新功能怎麼等都不出現。
 * `index.html` 有 `Cache-Control: no-cache`、`/api/me` 也沒有任何快取標頭 ——
 * **重整一定拿得到新版,問題是根本沒人重整**。
 * SPA 不會自己回頭問伺服器有沒有新版,這支就是那個「回頭問」。
 *
 * ⚠️ **比對的是 entry chunk 的檔名,不是 `index.html` 的 ETag。**
 * 那個 ETag 由 Starlette 的 `FileResponse` 從 mtime + size 算(見 main.py 的
 * serve_frontend),而每次部署解壓縮 mtime 一定變 —— 於是**只改後端、前端一行沒動**
 * 的那種上版也會讓 ETag 變,提示就會每次部署都跳一次。跳到大家開始忽略它,
 * 這個功能就等於沒做。entry 的 hash 是 Vite 從內容算的:前端沒變就不會變。
 *
 * 這支**不碰 UI**,只負責「現在是不是舊版了」這個事實。要拿它做什麼
 * (無感換頁 / 自動重整 / 出聲)在 `components/UpdateWatcher.tsx`。
 */

/**
 * 認 entry 的唯一規則。`readCurrentEntry()` 與 `entryFromHtml()` 都走它,兩邊才比得起來。
 *
 * ⚠️ 要定義在 `CURRENT` **上面** —— `CURRENT` 在模組載入當下就會執行
 * `readCurrentEntry()`,而 `const` 有 TDZ:放到下面去的話,整個模組
 * 一被 import 就是 `Cannot access 'ENTRY_SCRIPT_SELECTOR' before initialization`。
 */
const ENTRY_SCRIPT_SELECTOR = 'script[type="module"][src]';

/** 目前這一版(頁面載入當下那個 entry 的檔名),`null` = 測不出來,那就整支停用。 */
const CURRENT = readCurrentEntry();

/** 回頭問的間隔。15 分鐘 —— 真正有價值的是下面的 visibilitychange,這條只是兜底。 */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

/** 兩次檢查之間至少隔這麼久。擋的是「切分頁切很快」的人一直打。 */
const MIN_GAP_MS = 30 * 1000;

let stale = false;
let lastCheckedAt = 0;
let checking = false;

const listeners = new Set<() => void>();

/**
 * 頁面自己的 entry chunk 檔名。
 *
 * `index.html` 裡那顆 `<script type="module" src="/assets/index-XXXX.js">` 就是它。
 * 開發模式下 Vite 給的是 `/src/main.tsx`(沒有 hash),比對不出東西來 ——
 * 所以 `parseEntry` 認不得的一律回 null,由 `isWatchable()` 把整支關掉。
 */
function readCurrentEntry(): string | null {
  if (typeof document === 'undefined') return null;
  const tags = document.querySelectorAll<HTMLScriptElement>(ENTRY_SCRIPT_SELECTOR);
  for (const tag of tags) {
    const entry = parseEntry(tag.getAttribute('src'));
    if (entry) return entry;
  }
  return null;
}

/**
 * 從一段文字裡挑出 entry chunk 的檔名。
 *
 * 只認 `index-` 開頭的那一顆 —— `dist/assets` 底下其餘的 JS 都是
 * `lazy()` 切出來的分包(`Stats-xxx.js`…),它們的 hash 各自獨立,
 * 拿任何一個來比對都會漏掉「只有 entry 變了」的那種上版。
 *
 * ⚠️ **export 只是為了測得到。** 這支是整個功能唯一的判斷依據:它一旦
 * 認錯東西(例如改成連 `Stats-xxx.js` 也收),提示就會在不該跳的時候跳,
 * 而那種錯在畫面上看起來跟「部署失敗」一模一樣。見 `__tests__/appVersion.test.ts`。
 */
export function parseEntry(src: string | null | undefined): string | null {
  if (!src) return null;
  const m = src.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

/** 這個環境值不值得偵測。開發模式、或連自己是哪一版都讀不出來的,就不要跑。 */
function isWatchable(): boolean {
  return CURRENT !== null;
}

/**
 * 伺服器上現在是哪一版。
 *
 * 抓的是 `/` 本身(5KB 的 `index.html`),`cache: 'no-store'` 確保問到的是真的現況。
 * 任何失敗都回 null 靜默收場 —— 離線、後端剛好在重啟、網路抖一下都會走到這裡,
 * 而這是加值功能,不該為了它跳錯誤訊息(靜默失敗只用在加值功能)。
 */
async function fetchLatestEntry(): Promise<string | null> {
  try {
    const res = await fetch('/', {cache: 'no-store', credentials: 'same-origin'});
    if (!res.ok) return null;
    return entryFromHtml(await res.text());
  } catch {
    return null;
  }
}

/**
 * 從一份 `index.html` 裡找出 entry chunk 的檔名。
 *
 * ⚠️ **跟 `readCurrentEntry()` 用同一個選擇器**,這件事比看起來重要:
 * 這支的答案要跟「本頁正在跑哪一版」放在同一個天平上比,兩邊只要用不同的
 * 規則去認,就會在**兩邊其實同版**的情況下得出不同答案 —— 而那個誤判的樣子
 * 正好是「每次上版都跳提示」。
 *
 * 不要用正則掃整份 HTML 抓第一個 `/assets/index-*.js`:哪天有人寫了
 * `pages/index.tsx` 之類的東西被切成同名分包,掃到的就會是別顆。用 `DOMParser` 走同一個選擇器就沒有這個問題
 * (它只建 DOM、不會執行裡面的 script)。
 */
export function entryFromHtml(html: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tag = doc.querySelector<HTMLScriptElement>(ENTRY_SCRIPT_SELECTOR);
    return parseEntry(tag?.getAttribute('src'));
  } catch {
    return null;
  }
}

/**
 * 回頭問一次。已經確定是舊版之後就不再問了 —— 答案不會再變,
 * 而且 `stale` 一旦為真,後面那三段處理會自己把分頁帶到新版去。
 */
export async function checkNow(force = false): Promise<void> {
  if (!isWatchable() || stale || checking) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const now = Date.now();
  if (!force && now - lastCheckedAt < MIN_GAP_MS) return;

  checking = true;
  lastCheckedAt = now;
  try {
    const latest = await fetchLatestEntry();
    // 讀不到就當沒事發生。**不要**把「讀不到」當成「有新版」:
    // 後端重啟的那幾秒所有人都會讀不到,那時候全站一起重整是最糟的時機。
    if (latest && latest !== CURRENT) markStale();
  } finally {
    checking = false;
  }
}

function markStale() {
  if (stale) return;
  stale = true;
  for (const fn of listeners) fn();
}

/** 伺服器上已經是更新的版本了(這個分頁是舊的)。 */
export function isStale(): boolean {
  return stale;
}

/** 給 `useSyncExternalStore` 用。 */
export function subscribeStale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 開始盯著。回傳的函式解除。
 *
 * 兩個觸發點,價值差很多:
 *   - `visibilitychange`:**主要靠這條**,而且切走、切回來都要問。切回來問到的是
 *     「我離開的時候你們上版了」;切走問到的則是接下來那段他不在的時間 ——
 *     那是整個功能裡最好的換頁時機(見下面那段註解)。
 *   - 15 分鐘的計時器:兜底,給「一整天都開著同一個分頁不切走」的人。
 */
export function startVersionWatch(): () => void {
  if (!isWatchable()) return () => {};

  // ⚠️ **切走跟切回來都要問,不要只問「切回來」。**
  //
  // 只在切回來時問(`if (!document.hidden) void checkNow()`)的話,
  // 「趁他不在的時候自動換掉」那一段幾乎沒有機會發生:切走的當下我們
  // 不知道有新版,而等他切回來才發現時,他人已經在看著這一頁了,重整就是打擾。
  // 切走時問到的話,接下來那段時間他不在,換頁最不痛 —— 他回來就是新版。
  const onVisibilityChange = () => void checkNow();
  document.addEventListener('visibilitychange', onVisibilityChange);
  const timer = window.setInterval(() => void checkNow(), POLL_INTERVAL_MS);

  // 開站當下也問一次(force):分頁可能是從 bfcache 回來的,那種情況
  // 連 visibilitychange 都不會發。
  void checkNow(true);

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.clearInterval(timer);
  };
}
