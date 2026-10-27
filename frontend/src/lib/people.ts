import {fromZhuyin} from './zhuyin';

/**
 * 畫面上怎麼寫一個人的名字。
 *
 * 帳號是小寫的(`ming`、`chen`),直接印在畫面上會像是變數名而不是一個人。
 * 開頭那個字母大寫就有名字的樣子了(`Ming`)。
 *
 * ⚠️ **只動第一個字元,不要動後面的**:
 *   - `mingChen` 這種是他自己打的大小寫,不該被改掉;
 *   - 每個字都大寫(title case)會把 `o'brien`、`van der berg` 改成錯的樣子;
 *   - 中文顯示名稱沒有大小寫,`toUpperCase()` 對它是原字返回,不必另外判斷。
 *
 * ⚠️ 這是**顯示用**的。比對身分一律用原始的帳號(`isMine()` 是大小寫不敏感比對),
 * 送去 API 的也一定是原字 —— 後端的帳號是區分大小寫存的。
 */
export function personName(name: string | null | undefined): string {
  if (!name) return '';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * 搜尋使用者:**只比開頭**(帳號與顯示名稱兩邊都比,不分大小寫)。
 *
 * 打 a 表示要找開頭是 a 的,不是包含 a 的。
 * ⚠️ 不要加 includes(子字串比對)。
 * @ 按鈕的浮層與打 `@` 開的浮層是同一顆,天生同一條規則。
 *
 * 注音的還原**在這裡做,不在呼叫端的 onChange**:
 * 在 onChange 改寫值會把輸入法的組字整個打斷 ——
 * 打「王小明」的過程中欄位裡是「ㄨㄤˊ」,還沒選字就被換成 `j6`,
 * 於是名單永遠搜不了中文名。兩種寫法各比一次,中一個就算中。
 */
export function filterPeople<T extends {username: string; display_name?: string | null}>(
  people: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...people];
  const keys = [...new Set([q, fromZhuyin(q)])];
  return people.filter((p) => {
    const username = p.username.toLowerCase();
    const display = (p.display_name ?? '').toLowerCase();
    return keys.some((key) => username.startsWith(key) || display.startsWith(key));
  });
}
