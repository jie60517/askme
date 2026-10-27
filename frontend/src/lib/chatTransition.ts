/**
 * New chat ↔ 對話(以及兩組對話互切)的過場:輸入框從置中移到釘底(或反過來)、變寬變窄,都要平順地補過去。
 *
 * 兩種版面是**兩棵不同的 DOM 樹**(`App.tsx` 用 `key={id}` 重掛對話頁),CSS transition 接不起來,
 * 用瀏覽器的 View Transitions:
 *   - 輸入框外層兩種版面都叫 `composer` → 位置與寬高補過去(置中 720 ↔ 釘底 800),從中間往兩側長
 *   - 其他(招呼語 / 訊息串 / 側邊欄)跟著整頁原地交叉淡化(訊息串不單獨成一組,理由在 global.css)
 * 節奏寫在 `styles/global.css` 的「New chat ↔ 對話的過場」;`vt-chat` 掛在 <html> 上那一次才生效,
 * 不會動到 SSH 那幾種過場。
 *
 * ⚠️ **不能沿用 SSH 那支 `morph()`(它用 `flushSync` 把更新同步畫完)**:react-router 7 的 `BrowserRouter`
 * 把換頁包在 `startTransition` 裡(`useTransitions` 預設開),`flushSync` 逼不出來 —— 瀏覽器拍「新畫面」時
 * DOM 還是舊的,結果是舊輸入框在原地淡掉、新的一格跳出來。
 * 也**不能**為此把 `useTransitions` 關掉:那會讓換到 lazy 頁面時先閃一下載入中(全站的事)。
 * 所以這裡讓過場**等對話頁真的掛上、而且設定與歷史都到了**(`notifyChatCommitted`,對話頁的 layout effect 呼叫)
 * 才拍新畫面;最多等 `COMMIT_WAIT_MS`,等不到就照常放行,不會卡住。
 * 要等「設定與歷史都到了」:只等掛上的話終點畫面是空殼(沒有專案 / 模型按鈕、專案名是預設的),
 * 過場演完才換上、按鈕整排位移。通常一掛上就到(`lib/chatApi.ts` 的快取 + 滑鼠移上去就先抓)。
 *
 * 不支援 View Transitions 或使用者要求減少動態 → 直接換頁,沒有過場。
 */

/** 等對話頁掛上最多等多久(ms)。兩頁都已經載入過,正常是一兩格的事;這只是保險 */
const COMMIT_WAIT_MS = 400;

type ViewTransition = {finished: Promise<void>};
type StartViewTransition = (cb: () => Promise<void>) => ViewTransition;

/** 每一次過場一個編號(見 `notifyChatCommitted`) */
let generation = 0;
/**
 * 最新的那一次 —— 兩次疊在一起時(前一次還沒演完又點了下一組),瀏覽器會跳過前一次、
 * 讓它的 finished 提早結束;那時候不能把後一次掛著的 `vt-chat` 摘掉,不然後一次就沒有節奏了。
 */
let latest = 0;
let waiters: Array<{generation: number; done: () => void}> = [];

/**
 * 正在演的那一次過場的編號;沒在演是 null。
 *
 * 對話頁在**掛上那一刻**讀一次(`useState` 的初值),之後只能放行這一次 ——
 * 不然會有這種情況:A 頁沒快取、第一次過場等到逾時才放行,
 * 使用者接著點 B 起第二次過場,這時 A 慢吞吞的歷史才回來、A 一喊「好了」就把第二次放掉,
 * 瀏覽器拍到的新畫面還是 A。也拿來決定要不要再演自己的進場淡入(過場裡掛上的不演)。
 */
export function currentChatMorph(): number | null {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('vt-chat')
    ? generation
    : null;
}

/**
 * 對話頁掛上了、內容也到位了(`Chat` 的 layout effect 呼叫):編號 `morph` 那一次過場可以拍新畫面了。
 * 不給編號 = 全部放行(測試用)。
 */
export function notifyChatCommitted(morph?: number): void {
  const release = waiters.filter((w) => morph === undefined || w.generation === morph);
  waiters = waiters.filter((w) => !release.includes(w));
  for (const w of release) w.done();
}

/** `/c/<id>` 裡的對話 id;不是某一組對話的網址就是 null */
export function conversationIdFromPath(path: string | null | undefined): string | null {
  return path?.startsWith('/c/') ? path.slice(3) || null : null;
}

/** 對話頁:空白頁 `/` 與某一組對話 `/c/<id>` */
export function isChatPath(path: string | null | undefined): boolean {
  return path === '/' || !!path?.startsWith('/c/');
}

/** 換頁時要不要演這段過場:兩端都是對話頁、而且真的換了一頁 */
export function shouldMorphChat(from: string, to: string | null | undefined): boolean {
  return !!to && to !== from && isChatPath(from) && isChatPath(to);
}

/**
 * 用過場包住一次換頁(`update` 裡呼叫 `navigate`)。
 * 換**功能頁**不走這裡(那段不能凍住畫面等新頁),見 `lib/pageSwap.ts`。
 */
export function morphChat(update: () => void): Promise<void> {
  const start = (document as Document & {startViewTransition?: StartViewTransition}).startViewTransition;
  if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return Promise.resolve();
  }
  const root = document.documentElement;
  const morph = ++generation;
  latest = morph;
  root.classList.add('vt-chat');
  const t = start.call(
    document,
    () =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.clearTimeout(timer);
          resolve();
        };
        const timer = window.setTimeout(done, COMMIT_WAIT_MS);
        waiters.push({generation: morph, done});
        update();
      }),
  );
  return t.finished
    .catch(() => {})
    .finally(() => {
      if (latest === morph) root.classList.remove('vt-chat');
    });
}
