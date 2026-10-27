/**
 * 登入狀態。
 *
 * **token 存 sessionStorage,不是 localStorage。**
 * 規則是「網頁關掉就要重新登入」,而 sessionStorage 正好是那個生命週期:
 * 它跟著分頁走,關掉分頁就沒了,關掉整個瀏覽器當然也沒了。localStorage 則是
 * 存到有人主動清為止,關掉再開還會是登入狀態。
 *
 * **另外兩半也要成立,不然這個要求是假的:**
 *
 *   後端的下載 cookie 也是 session cookie(沒有 max_age,見
 *     `backend/app/auth.py` 的 `set_session_cookie`)。只改這裡的話,關掉瀏覽器
 *     再開會變成「畫面要重新登入,但檔案下載那三條路徑照樣通」。
 *   後端有**閒置逾時**(`AUTH_IDLE_TIMEOUT_SEC`)。瀏覽器的「回復上次工作階段」
 *     會把 sessionStorage 與 session cookie 一起帶回來 —— 純前端的做法擋不住,
 *     所以伺服器那邊也要讓閒置的 token 自己死掉。
 *
 * ⚠️ **sessionStorage 是每個分頁各自一份**,所以「在新分頁開啟連結」預設會是
 * 未登入。那個代價太大(使用者會以為系統一直把他踢出去),所以下面做了
 * 跨分頁交接:新分頁開口要,還開著的舊分頁把 token 遞過去。全部分頁都關掉之後
 * 就沒有人可以遞了 —— 這正是我們要的行為。
 *
 * setToken / clearToken 廣播 t100:identity-changed,讓 useIdentity 與側邊欄跟著更新。
 */
import {
  readSessionString,
  removeKey,
  removeSessionKey,
  writeSessionString,
  writeString,
} from './safeStorage';

const KEY = 't100_auth_token';

export const IDENTITY_CHANGED = 't100:identity-changed';

/**
 * 跨分頁交接用的三個 localStorage 鍵。
 *
 * ⚠️ **token 會短暫經過 localStorage**(`respond` 寫進去、同一個 tick 就刪掉)。
 * 這是這個做法的成本,而它是可以接受的:`storage` 事件是同源限定的,只有這個
 * 站台自己的分頁收得到,而且值馬上被移除,不會留到下一次開站。反過來說,
 * **不要因為「反正都寫進 localStorage 了」就乾脆存在那裡** —— 差別正是
 * 「關掉瀏覽器之後還在不在」。
 */
const HANDOFF_ASK = 't100_session_ask';
const HANDOFF_GIVE = 't100_session_give';
/** 有人按了登出。**每個分頁都要跟著登出**,理由見 `clearToken`。 */
const HANDOFF_REVOKE = 't100_session_revoke';

/** 等舊分頁回應的上限。等太久 = 每次開新分頁都空白一下;太短 = 接不到。 */
const HANDOFF_TIMEOUT_MS = 300;

/**
 * 這個分頁剛剛主動登出了,**不要再跟別的分頁要 token**。
 *
 * ⚠️ 沒有這個旗標的話登出根本不會發生,而且看不出原因:
 * `clearToken()` → 廣播 → `useIdentity.refresh()` → 本地沒有 token →
 * 跟還開著的分頁要一份 → **拿回剛剛作廢的那一張** → 畫面回到已登入。
 */
let isSignedOut = false;

export function getToken(): string | null {
  return readSessionString(KEY);
}

export function setToken(token: string) {
  isSignedOut = false;
  writeSessionString(KEY, token);
  window.dispatchEvent(new Event(IDENTITY_CHANGED));
}

export function clearToken() {
  // 本來就沒有 token 就不要廣播:登入頁會被重新掛載、輸入到一半的 state 歸零。
  if (!getToken()) return;
  isSignedOut = true;
  removeSessionKey(KEY);
  /*
   * **叫其他分頁也登出。** 不叫的話,那些分頁手上還有一張有效的 token,
   * 而且它們正是「跨分頁交接」會去要的對象 —— 等於按了登出卻只登出一個分頁,
   * 而且下一個新分頁又會把身分接回來。共用電腦上這是實際的風險。
   */
  poke(HANDOFF_REVOKE, String(Date.now()));
  window.dispatchEvent(new Event(IDENTITY_CHANGED));
}

/** 伺服器說沒登入但本地還有 token:直接移除,不走 clearToken(避免多一次廣播)。 */
export function dropTokenSilently() {
  isSignedOut = true;
  removeSessionKey(KEY);
}

/**
 * 瀏覽器「回復上次工作階段」把上次的網址帶回來時,退回新對話(一進站就是新的對話)。
 *
 * 「重新登入」那條路已經在 `Login.signIn` 退回 `/` 了;這裡補的是**不經登入頁**
 * 的那一種 —— 回復工作階段會把 sessionStorage 一起帶回來,token 在閒置逾時內
 * 還有效,於是直接掛在上次那組 `/c/<id>` 上。
 *
 * 判斷「這是回復,不是別的」靠三件事,缺一就不動:
 *   1. 開站當下 sessionStorage **已經**有 token —— 新分頁一定是空的(要靠交接),
 *      所以「在新分頁開別人分享的連結」不會被打斷。
 *   2. 這次是**全新的一次載入**(navigation type 是 `navigate`)—— F5(`reload`)
 *      要留在原地;在某組對話點了外站連結再按上一頁(`back_forward`)也要留在原地,
 *      那是使用者自己走回來的,不是瀏覽器幫他回復的。
 *   3. 網址是某組對話。
 * 代價是「在已登入的分頁手動打一個 /c/<id> 網址」也會被退回 `/` ——
 * 那是全站唯一會走到這裡的非回復情況,而它跟這條規則並不衝突。
 *
 * **在 main.tsx、render 之前呼叫**:網址要在 Router 讀到它之前改好,不然畫面會先
 * 掛上舊對話再跳走。
 */
export function resetRestoredSessionToNewChat() {
  if (!getToken()) return;
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (nav && nav.type !== 'navigate') return;
  if (!window.location.pathname.startsWith('/c/')) return;
  window.history.replaceState(null, '', '/');
}

// ---------------------------------------------------------------- 跨分頁交接

function poke(key: string, value: string) {
  /*
   * `storage` 事件**只會送到其他分頁**,自己這個分頁收不到 —— 這正是這套做法
   * 成立的原因。寫完馬上刪:留著的話,下一次開站會讀到一個過期的值,
   * 而且那是一張放在 localStorage 裡的登入憑證。
   *
   * 走 safeStorage 而不是直接碰 localStorage:那份 try/catch 只該有一份
   * (見 `safeStorage.ts` 的開頭)。
   */
  writeString(key, value);
  removeKey(key);
}

/**
 * 已經登入的分頁:聽別的分頁在講什麼。
 *
 * 兩件事:有人開新分頁在要 token 就遞過去;有人按了登出就跟著登出。
 *
 * **在 main.tsx 掛一次就好**,而且要在最外層 —— 掛在某個畫面裡的話,
 * 那個畫面沒顯示的時候就交接不了。
 */
export function serveSessionHandoff(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.newValue === null) return;

    if (e.key === HANDOFF_REVOKE) {
      // 別的分頁登出了。**用 clearToken 會再 poke 一次 revoke,無限繞圈**,
      // 所以這裡自己收尾:清掉、廣播,不再往外講。
      isSignedOut = true;
      removeSessionKey(KEY);
      window.dispatchEvent(new Event(IDENTITY_CHANGED));
      return;
    }

    if (e.key === HANDOFF_ASK) {
      const token = getToken();
      if (token) poke(HANDOFF_GIVE, token);
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

/**
 * 新分頁:跟還開著的分頁要一份 token。
 *
 * 拿到就寫進自己的 sessionStorage 並回傳 true;沒有人回應(全部分頁都關過了、
 * 或這本來就是今天第一次開站)就在 `HANDOFF_TIMEOUT_MS` 之後回 false。
 *
 * ⚠️ 呼叫端(useIdentity)**要先 await 這一支再判斷「沒登入」** ——
 * 不等的話,每次在新分頁開連結都會先閃一下登入頁再跳回來。
 */
export function requestSessionHandoff(): Promise<boolean> {
  // 剛剛才主動登出的分頁不要去要 —— 要回來的正是剛作廢的那一張(見 isSignedOut)
  if (isSignedOut) return Promise.resolve(false);
  if (getToken()) return Promise.resolve(true);

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('storage', onStorage);
      clearTimeout(timer);
      resolve(ok);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== HANDOFF_GIVE || !e.newValue) return;
      writeSessionString(KEY, e.newValue);
      finish(true);
    };

    window.addEventListener('storage', onStorage);
    const timer = setTimeout(() => finish(false), HANDOFF_TIMEOUT_MS);
    // 值本身沒有意義,重點是「值變了」這件事會觸發別的分頁的 storage 事件。
    // 用時間戳是為了確保每次都不一樣 —— 同樣的值寫兩次不會觸發事件。
    poke(HANDOFF_ASK, String(Date.now()));
  });
}
