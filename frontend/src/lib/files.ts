/**
 * 檔案網址(不經 axios)。
 *
 * 這些是給 `<a href>` / `<img src>` 用的,不走 axios —— 所以攔截器加的
 * `Authorization` 標頭它們拿不到。**但這些路徑一樣要登入**:後端收
 * 登入時發的 HttpOnly cookie(瀏覽器會自己附上),見 `auth.SESSION_COOKIE`。
 * 不能靠「session_id 猜不到」當保護 —— 那不是權限。
 *
 * ⚠️ 一定要自己補上 API base:axios 的 `baseURL` 只對經過它的請求有效,
 * 而 `VITE_API_BASE` 指到別的 origin 時,少了它會去要前端自己的
 * `/api/files/...`,回來的是 index.html,下載到一個壞掉的檔案。
 */

import {scaleBytes} from './byteUnits';

const BASE = import.meta.env.VITE_API_BASE || '';

/** 檔案區的單位(檔案欄多一階 TB,見 `terminalApi.formatSize`)。 */
const BYTE_UNITS = ['KB', 'MB', 'GB'] as const;

/**
 * 路徑片段要編碼:檔名可能有空白、`#`、中文。
 * 不編的話 `#` 之後會被當成 fragment,整個檔名被截斷。
 */
function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/** 這一題產出的檔案(下載)。 */
export function fileDownloadUrl(sessionId: string, name: string): string {
  return apiUrl(`/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`);
}

/**
 * 使用者上傳的檔案(便條夾帶的那些)。
 *
 * ⚠️ 跟 `fileDownloadUrl` 是**兩條不同的路徑**:`files/` 是這一題**產生**的東西,
 * `uploads/` 是人傳上去的。混用會 404,而且意思也不一樣。
 */
export function uploadUrl(sessionId: string, name: string): string {
  return apiUrl(`/api/uploads/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`);
}

/**
 * 同一個檔案的**預覽**網址(`?inline=1`)。
 *
 * ⚠️ 下載與預覽是**兩條不同的意圖**,不能共用一條網址:沒帶 `inline` 時後端一律
 * 回 `Content-Disposition: attachment`(files.py),燈箱裡的 `<img>` / PDF iframe
 * 拿到 attachment 會變成「點開燈箱結果瀏覽器開始下載」。
 *
 * 反過來也不能一律帶 inline:那份 `_INLINE_OK` 名單是**保守**的
 * (html/svg/xml 刻意不在裡面),而下載鈕本來就該下載。
 */
export function filePreviewUrl(sessionId: string, name: string): string {
  return `${fileDownloadUrl(sessionId, name)}?inline=1`;
}

export function uploadPreviewUrl(sessionId: string, name: string): string {
  return `${uploadUrl(sessionId, name)}?inline=1`;
}

/**
 * Word / Excel / PowerPoint 的**純文字**預覽(`GET /api/preview/{scope}/…`)。
 *
 * 這幾種是壓縮過的二進位,瀏覽器打不開,直接抓內容回來顯示只會是亂碼 ——
 * 後端用上傳時同一支 `extract_text` 抽出文字給前端當文字顯示。
 *
 * ⚠️ `scope` 對應的是檔案存在哪個目錄,跟上面兩條同一組概念:
 * `files` = 這一題產出的,`uploads` = 人傳上去的。給錯會 404。
 * 抽不出來後端回 **415**(不是 404)—— 那兩種要分開講,使用者要做的事不一樣。
 */
export function officePreviewTextUrl(
  scope: 'files' | 'uploads',
  sessionId: string,
  name: string,
): string {
  return apiUrl(
    `/api/preview/${scope}/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`,
  );
}

/**
 * 檔案大小。`null` = 磁碟上找不到這個檔案(後端的 `missing`)。
 *
 * 用 1024 進位並且**只留一位小數**:檔案區的用途是「認出這是不是我要的那份」,
 * 精確到 byte 對那件事沒有幫助,反而讓一整排數字對不齊。
 */
export function formatBytes(size: number | null | undefined): string | null {
  if (size === null || size === undefined) return null;
  if (size < 1024) return `${size} B`;
  // 10 以上不留小數(「1.2 MB」有意義,「123.4 MB」那個 .4 只是噪音)
  const shown = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  // 升單位看**進位之後**的值(規則在 `lib/byteUnits.ts`,跟檔案欄共用):
  // 1,048,575 B = 1023.999 KB,進位後是「1024 KB」—— 到了 1024 就當下一個單位的 1。
  const {value, unit} = scaleBytes(size, BYTE_UNITS, shown);
  return `${shown(value)} ${unit}`;
}
