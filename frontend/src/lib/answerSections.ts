/**
 * 把一則回答切成「結論」與「追查依據」兩段。
 *
 * 回答常常很長,而非工程背景的讀者看不懂的那些內容(檔案、行號、function),
 * 對工程師恰恰是最有用的。所以不是砍掉,是**摺起來**:結論給要答案的人,追查依據給接手改的人。
 *
 * ⚠️ **切點是模型印出來的一行標題,不是後端給的欄位。** 契約寫在
 * `deploy/workdirs/RULES-web-context.md` 的「你的回答會直接被人看」那一節,
 * 兩邊要一起改 —— 規則檔改了標題而這裡沒跟著改的話,整段追查依據會整個攤開,
 * 而**畫面上完全看不出來**(它看起來就只是一則比較長的回答)。
 */

/**
 * 標題那一行。規則要求 `## 追查依據`,也認帶方頭括號的 `## 【追查依據】` ——
 * 資料庫裡可能有用這種寫法的回答,不認得就不會摺疊。
 *
 * 井號數量放寬到 1~6:模型偶爾會寫成 `#` 或 `###`,為了那一個字元讓整段
 * 攤開來不值得。行首行尾允許空白,但**標題那一行不可以有別的字** ——
 * 只有「追查依據」四個字自成一行時才是切點,回答內文裡提到這四個字不算。
 */
const EVIDENCE_HEADING = /^[ \t]*#{1,6}[ \t]*【?[ \t]*追查依據[ \t]*】?[ \t]*$/m;

export type AnswerSections = {
  /** 標題以前的部分 —— 直接顯示,不摺疊。 */
  body: string;
  /** 標題以後的部分(不含標題那一行);沒有這一段時是 null。 */
  evidence: string | null;
};

/**
 * ⚠️ 只切**第一個**標題。一則回答應該只有一個追查依據(規則檔有寫),
 * 但模型偶爾會多印一個 —— 那時後面那個就當成追查依據的內文,一起摺進去。
 * 切成三段以上只會讓畫面多出一塊沒人知道是什麼的東西。
 */
export function splitAnswer(answer: string): AnswerSections {
  const match = EVIDENCE_HEADING.exec(answer);
  if (!match || match.index === undefined) {
    return {body: answer, evidence: null};
  }

  const body = answer.slice(0, match.index).trimEnd();
  const evidence = answer.slice(match.index + match[0].length).trim();

  // 標題後面什麼都沒有(串流切在標題上、或模型印了標題就沒下文)。
  // 這時摺疊區會是一顆點開來空無一物的按鈕,比不摺還糟 —— 整段照原樣顯示。
  if (!evidence) {
    return {body: answer, evidence: null};
  }

  // 標題**前面**什麼都沒有:整則回答只有追查依據、沒有結論。
  // 摺起來等於畫面上一個字都沒有,使用者會以為它壞了。
  if (!body) {
    return {body: answer, evidence: null};
  }

  return {body, evidence};
}

export type StreamingSections = {
  /** 現在可以顯示在上半段的部分。 */
  body: string;
  /** 追查依據的標題已經出現:畫面上先放一個摺起來的「追查依據」,內容邊收邊長。 */
  evidence: string | null;
};

/**
 * 串流中的切法 —— **標題一出現就收,依據一個字都不在上半段露臉。**
 *
 * 等答完才切的話,整段依據會先攤在畫面上、答完的那一刻才被收走。所以:
 *
 * 1. **最後一行還沒送完、而且是 `#` 開頭的,先不顯示。** 那可能是送到一半的
 *    `## 追查依據`;等換行送到、知道它是什麼再說。一般的小標題
 *    只是晚半拍出現,不會閃。
 * 2. 完整的「追查依據」標題出現 → 之後的內容全部進摺疊區(串流中也是)。
 *
 * 答完之後照舊用 `splitAnswer`;兩邊的標題規則是同一套 regex。
 */
export function splitStreamingAnswer(answer: string): StreamingSections {
  const lastNewline = answer.lastIndexOf('\n');
  const tail = answer.slice(lastNewline + 1);
  const complete = /^[ \t]*#/.test(tail) ? answer.slice(0, lastNewline + 1) : answer;

  const heading = EVIDENCE_HEADING.exec(complete);
  // 標題那一行要已經換行(送完整)才算:`$` 在字串結尾也會對上,
  // 但那時它已經被上面的「未完成的 # 行」擋掉了,這裡不會看到。
  let body = complete;
  let evidence: string | null = null;
  // 標題前面沒有結論(整則只有依據)就不收 —— 跟 splitAnswer 的第二道防呆同一條。
  // 串流中收了,答完 splitAnswer 會整段攤開,等於把「先攤開再收走」反過來演一次。
  // ⚠️ 「標題後面還沒有內容」**照收**(空的摺疊區):那是串流中標題剛到的常態,不收的話標題會先閃在
  // 上半段再被收走。代價是「印了標題就沒下文」這種少見的回答,答完那一刻標題會回到上半段。
  if (heading && heading.index !== undefined && complete.slice(0, heading.index).trim()) {
    body = complete.slice(0, heading.index);
    evidence = complete.slice(heading.index + heading[0].length).trim();
  }

  return {body: body.trimEnd(), evidence};
}
