/**
 * @ 提及的規則。
 *
 * ⚠️ **這裡的規則必須跟後端 `notes.py` 的 `_MENTION` 一模一樣。**
 * 兩邊只要有一邊漂走,就會出現最難查的那種失配:前端判定「這是便條」、
 * 送出去後端解析不到人回 400,而使用者只看到「送出失敗」。
 * (反過來也一樣糟:前端當成問題送給 claude,使用者以為喊了人其實沒有。)
 *
 * 三條規則,每一條都有原因:
 *
 * - **前面不能是 `[A-Za-z0-9_.@-]`**,而不是「必須是空白或開頭」。
 *   中文打字不會在 @ 前面空一格 ——「請@ming看一下」必須算數;
 *   同時 `user@example.com` 裡的 `@example` 不會被誤判(前面是 `r`)。
 * - **後面不能再接帳號還能用的字元**,而不是用 `\b`。
 *   中文字算 word 字元,「@ming看」的 `g` 跟「看」之間根本沒有邊界。
 *   這條也讓 `@ming2` 不會被當成 `@ming` —— 那是另一個人。
 * - 帳號本身是 `[A-Za-z0-9_-]`,跟後端 `_NAME` 同一組。
 */

/** 跟後端 `_NOT_BEFORE` / `_NAME` / `_NOT_AFTER` 逐字對應。 */
const MENTION = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9_-]{1,64})(?![A-Za-z0-9_-])/g;

/**
 * 「這句話**看起來**在 @ 人」—— 不管對不對得上帳號。
 *
 * 用在使用者名單**抓失敗**的時候:
 * 抓失敗跟「系統裡只有你一個」長得一模一樣,兩種情況下 `mentionedUsernames()`
 * 都回空陣列。只看它的話,「@ming 這個你看一下」會整句被當成問題送進 AI ——
 * 使用者以為喊了人,其實沒有,而且畫面上完全看不出來。
 *
 * ⚠️ 另外開一個**不帶 `g`** 的 regex:帶 `g` 的 `test()` 會記住 `lastIndex`,
 * 同一個字串連續問兩次會一次 true 一次 false。
 */
const LOOKS_LIKE_MENTION = new RegExp(MENTION.source);

export function looksLikeMention(text: string): boolean {
  return LOOKS_LIKE_MENTION.test(text);
}

/**
 * 挑出**真的對得上帳號**的提及。保持出現順序、不重複。
 *
 * 對不上的 `@xxx` 一律當普通文字,不報錯 —— 打錯字很常見,
 * 為了一個錯字把整則退回去只會讓人覺得系統很難用(後端也是這樣處理的)。
 *
 * `self` 會被排除:@ 自己沒有意義,後端也會濾掉,前端跟著濾才不會出現
 *「畫面說會通知兩個人,實際只通知一個」。
 */
export function mentionedUsernames(
  text: string,
  known: readonly string[],
  self?: string,
): string[] {
  const valid = new Map(known.map((u) => [u.toLowerCase(), u]));
  const found: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const username = valid.get(match[1].toLowerCase());
    if (!username) continue;
    if (self && username.toLowerCase() === self.toLowerCase()) continue;
    if (found.includes(username)) continue;
    found.push(username);
  }
  return found;
}
