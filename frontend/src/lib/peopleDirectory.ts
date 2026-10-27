/**
 * 所有使用者的一份小名冊:帳號 → 顯示名 / 職稱 / 頭像。
 *
 * 為什麼要一份共用的(共用區塊要顯示每個人自己的頭像):側邊欄的共用名單只拿得到一串帳號字串,
 * 沒有名冊的話那裡的頭像永遠是名字縮寫;對話頁再自己抓一份 `mentionable`
 * 也是浪費。
 *
 * **抓一次、放模組層、大家共用**。這份名單一天不會變幾次,而每換一組對話
 * 重抓等於每次點側邊欄都多一支請求。
 *
 * ⚠️ `/api/shareable-users` **會把「你自己」排除掉**(後端刻意的:那是
 * 「可以分享給誰」的清單)。所以自己的頭像要另外由 `registerSelf()` 併進來,
 * 不然共用名單裡只有你自己那一顆是縮寫。
 */
import {useEffect, useState} from 'react';

import {listShareableUsers, type ShareablePerson} from './conversationsApi';

let roster: ShareablePerson[] = [];
let started = false;
/**
 * 上一次抓**失敗**了。
 *
 * ⚠️ 不能只看 `roster.length === 0` —— 抓失敗跟「系統裡只有你一個」長得
 * 一模一樣。分不出來的話,「@ming 你看一下」會整句送進 AI,而使用者
 * 以為喊了人。這個旗標就是為了把那兩件事分開。
 */
let failed = false;
/**
 * 抓完了嗎(不管成功或失敗)。
 *
 * ⚠️ 跟 `roster.length === 0` **不是同一件事**,也跟 `failed` 不是 ——
 * 「還在抓」與「抓完了,系統裡只有你一個」都是空陣列,但畫面上一個該轉圈、
 * 一個該說「沒有人可以分享」。呼叫端要分得出來(`ShareDialog` 就靠這個)。
 */
let loaded = false;
/** 「自己」的帳號(小寫)。`mentionablePeople()` 靠它把自己排除掉。 */
let selfKey: string | null = null;
/**
 * 「自己」那一筆。`registerSelf()` 寫進來,`loadPeopleDirectory()` 抓完之後再併回去。
 *
 * ⚠️ **單獨留一份是必要的,不能只靠 `roster` 裡那一筆。** 兩支是**賽跑**關係:
 * `registerSelf()` 由 `/api/me` 觸發,`loadPeopleDirectory()` 由
 * `/api/shareable-users` 觸發,而後者是**整個 roster 直接指派**。
 * `/api/me` 先回來的話,自己那一筆會被後到的名冊蓋掉 —— 而那條 API 刻意不含自己,
 * 所以自己就這樣從名冊上消失了。症狀:**共用名單上只有自己是名字縮寫**,
 * 換過頭像也一樣。
 */
let selfEntry: ShareablePerson | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((cb) => cb());
}

/** 依帳號排序後的位置。**顏色就是照這個位置分的**,見 `avatar-colors.ts`。 */
let orderIndex = new Map<string, number>();

/**
 * `mentionablePeople()` 的快取。
 *
 * ⚠️ **不要拿掉**:呼叫端(`Chat`)拿它當 `useMemo` 的相依,每次呼叫都回一個
 * 新陣列的話那些 memo 等於沒有作用 —— 名冊沒變就該是同一個參考。
 * 名冊一變(載完、或 `registerSelf`)就跟著 `reindex()` 作廢。
 */
let mentionableCache: ShareablePerson[] | null = null;

function reindex() {
  mentionableCache = null;
  orderIndex = new Map(
    [...roster]
      .map((p) => p.username.toLowerCase())
      .sort()
      .map((name, i) => [name, i]),
  );
}

/**
 * 把名冊清回「什麼都還沒抓」的狀態。**登出時一定要呼叫**(見 `loginApi.signOut`)。
 *
 * ⚠️ 這幾個變數放在模組層,而登出**不重新整理頁面**(`signOut()` 只清 token,
 * App 的三段式 gate 直接切回登入頁)—— 所以同一個分頁換一個人登入時,
 * `roster` 還是前一個人的那份,`selfKey` 也還指著前一個人:
 *
 *   - 共用名單、@ 選單裡出現的是**上一個使用者看得到的人**;
 *   - `mentionablePeople()` 濾掉的是**上一個人**,新登入的人反而 @ 得到自己。
 *
 * 這是模組層快取一定要配的另一半 —— 有全域狀態就要有清掉它的那一支。
 */
export function resetPeopleDirectory(): void {
  roster = [];
  started = false;
  failed = false;
  loaded = false;
  selfKey = null;
  selfEntry = null;
  reindex();
  notify();
}

/**
 * 抓一次就好。重複呼叫是安全的(第二次直接回)。
 *
 * 上一次**失敗**的話會重抓 —— 失敗時 `started` 有還原成 `false`(見下面 catch),
 * 所以這一支本身就是重試的入口,呼叫端只要再叫一次就好。
 */
export async function loadPeopleDirectory(): Promise<void> {
  if (started) return;
  started = true;
  try {
    // ⚠️ `withSelf` 不能省 —— 這裡是直接指派,不併的話會把 `registerSelf()`
    // 放進去的那一筆蓋掉(見 `selfEntry` 的說明)。
    roster = withSelf(await listShareableUsers());
    failed = false;
    loaded = true;
    reindex();
    notify();
  } catch {
    // 抓不到就維持空的 —— 呼叫端的每一支查詢都會回 undefined,
    // 而那些地方本來就有「查不到就用縮寫 / 只印名字」的退路。
    // 但**要記下來是「失敗」不是「沒有人」**,見 `failed` 的說明。
    failed = true;
    // 抓完了(結果是失敗)—— 呼叫端該停止轉圈,改顯示那條「載入失敗」的 Banner
    loaded = true;
    started = false;
    notify();
  }
}

/**
 * 把「自己」併進名冊。
 *
 * `/api/shareable-users` 不含自己,但共用名單裡的擁有者常常就是自己 ——
 * 不併的話,一整排的人都有照片、只有你自己是縮寫。
 */
export function registerSelf(me: {
  username: string;
  display_name?: string;
  avatar?: string | null;
}): void {
  selfKey = me.username.toLowerCase();
  selfEntry = {
    username: me.username,
    display_name: me.display_name || me.username,
    // 自己的職稱這條路拿不到(那支 API 不回自己),留空字串 —— 顯示端會略過
    role: '',
    avatar: me.avatar ?? null,
  };
  roster = withSelf(roster);
  reindex();
  notify();
}

/** 把「自己」那一筆併進一份名冊(有就換掉,沒有就加在最後)。 */
function withSelf(list: ShareablePerson[]): ShareablePerson[] {
  if (!selfEntry) return list;
  const key = selfEntry.username.toLowerCase();
  return [...list.filter((p) => p.username.toLowerCase() !== key), selfEntry];
}

/**
 * 可以 @ 的人。
 *
 * ⚠️ **把自己濾掉**:`roster` 為了共用名單的頭像把自己併了進來
 * (見 `registerSelf`),但 @ 選單裡不該出現自己 —— 而且自己那一筆的
 * `role` 是空字串,留著會讓「All Consultant / All Software Engineer」
 * 兩個群組都漏掉他、卻又出現在 ALL 裡面。
 */
export function mentionablePeople(): ShareablePerson[] {
  if (mentionableCache === null) {
    mentionableCache = selfKey
      ? roster.filter((p) => p.username.toLowerCase() !== selfKey)
      : roster;
  }
  return mentionableCache;
}

/**
 * 整份名冊,**含自己**(`registerSelf` 併進來的那一筆)。
 *
 * 撞名判斷用(`PersonDisplay` 的 `personDescription`):別人跟自己同名時,那個人的卡也要補
 * `@帳號` —— 拿不含自己的 `mentionablePeople()` 比的話,那種撞名永遠看不出來。
 */
export function allPeople(): ShareablePerson[] {
  return roster;
}

/** 名冊抓失敗了嗎。見 `failed`。 */
export function peopleDirectoryFailed(): boolean {
  return failed;
}

/** 名冊抓完了嗎(成功或失敗都算)。**還沒抓完 = 該轉圈**,見 `loaded`。 */
export function peopleDirectoryLoaded(): boolean {
  return loaded;
}

/**
 * 名冊查一個人。**帳號與顯示名稱都比**。
 *
 * ⚠️ 比顯示名稱那一半不是多餘的:側邊欄共用名單拿到的
 * `share_members` 是後端組好的**顯示名稱**陣列,不是帳號
 * (`routers/conversations.share_members()` 走 `users.display_names()`)。
 * display_name 等於 username 時只比帳號也會中 ——
 * 但只要有人把顯示名稱改成中文,那份名單上的頭像就會全部退回名字縮寫,
 * 而且看起來跟「頭像沒存進去」一模一樣。
 */
function find(username: string | null | undefined): ShareablePerson | undefined {
  if (!username) return undefined;
  const key = username.toLowerCase();
  /*
   * ⚠️ **帳號先比,顯示名稱只是退路** —— 順序不能對調,也不能合成一個 `||`。
   * 顯示名稱**不保證唯一**:甲把顯示名稱改成乙的帳號,合起來比就會查到乙
   * (而且是拿乙的照片畫在甲頭上)。先比帳號的話,只有「這個字串根本不是任何人的
   * 帳號」時才會走到第二條,誤中的機會小得多。
   * 已知代價:兩個人的顯示名稱相同時,退路會拿到名冊上排前面的那一個。
   * 真要根治得由後端改發帳號而不是顯示名稱(見上面的說明)。
   */
  return (
    roster.find((p) => p.username.toLowerCase() === key) ??
    roster.find((p) => (p.display_name || '').toLowerCase() === key)
  );
}

/** 他自己設的頭像。沒設過回 undefined —— `Avatar` 會退回名字縮寫。 */
export function avatarOf(username: string | null | undefined): string | undefined {
  return find(username)?.avatar ?? undefined;
}

/** 他的顯示名稱。查不到回 undefined —— 呼叫端自己決定要退回什麼。 */
export function displayNameOf(username: string | null | undefined): string | undefined {
  return find(username)?.display_name;
}

/** 他的職稱。查不到或沒有回 undefined。 */
export function roleOf(username: string | null | undefined): string | undefined {
  return find(username)?.role || undefined;
}

/**
 * 這個人在名冊裡的位置(依帳號排序)。給頭像配色用。
 *
 * 查不到回 `undefined` —— 那時候配色會退回用名字雜湊(見 `avatar-colors.ts`),
 * 名冊還沒載完時就是這個狀態。
 */
export function rosterIndexOf(username: string | null | undefined): number | undefined {
  if (!username) return undefined;
  return orderIndex.get(username.toLowerCase());
}

/**
 * 訂閱名冊變動(載入完成、或自己的頭像換了)。
 *
 * ⚠️ 不必自己檢查「登入了沒」:`App.tsx` 的三段式 gate 保證未登入時整組
 * chrome(側邊欄、對話頁)根本不會掛上來,而這一支只在那裡面被呼叫。
 */
export function usePeopleDirectory(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const cb = () => setVersion((n) => n + 1);
    listeners.add(cb);
    void loadPeopleDirectory();

    /*
     * 上次抓**失敗**的話,回到這個分頁時再試一次。
     *
     * 少了這一段,失敗就是永久的:掛載時抓一次,而這個 effect 是 `[]` ——
     * 對話頁一開就是一整天,中間網路瞬斷過一次,`@` 選單就會整天說
     * 名單載入失敗,使用者只能自己想到要重新整理。
     *
     * 只在 `failed` 時才動,所以正常情況下切回分頁不會多打任何一支請求。
     */
    const retryIfFailed = () => {
      if (failed && document.visibilityState === 'visible') void loadPeopleDirectory();
    };
    document.addEventListener('visibilitychange', retryIfFailed);
    window.addEventListener('focus', retryIfFailed);

    return () => {
      listeners.delete(cb);
      document.removeEventListener('visibilitychange', retryIfFailed);
      window.removeEventListener('focus', retryIfFailed);
    };
  }, []);
  return version;
}
