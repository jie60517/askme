/**
 * 時間。
 *
 * 後端是 datetime.utcnow() 裸序列化,沒有時區標記。所有 API 時間都要走
 * parseServerTime(),各自 new Date() 會差一個時區(UTC+8 就是整整八小時)。
 */
export function parseServerTime(iso: string): Date {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasZone ? iso : `${iso}Z`);
}

/**
 * 筆記頁大標題底下「從對話存的 · 10/12 15:42」那個時間:月/日 時:分,往年連年一起寫。
 * 跟清單上的 `formatNoteTime` 不同:那個回答「多久沒動了」,這個是「哪一天哪個時候存的」,日期和時間都要有。
 */
export function formatNoteStamp(iso: string, now = new Date()): string {
  const d = parseServerTime(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${d.getFullYear()}/${day} ${time}`;
}

/**
 * 筆記頁右上「編輯於 3 分鐘前」(照 Notion):一分鐘內「剛剛」、一小時內幾分鐘前、
 * 今天之內幾小時前,再早就跟清單時間同一套(昨天 / 月/日 / 年/月/日)。
 */
export function formatEditedAgo(iso: string, now = new Date()): string {
  const d = parseServerTime(iso);
  if (Number.isNaN(d.getTime())) return '';
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes} 分鐘前`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${Math.floor(minutes / 60)} 小時前`;
  return formatNoteTime(iso, now);
}

/**
 * 筆記清單上那個時間(`pages/Notes.tsx`):今天只寫時分、昨天寫「昨天」、
 * 今年寫月/日、往年連年一起寫。回答的是「這則多久沒動了」,不需要秒。
 */
export function formatNoteTime(iso: string, now = new Date()): string {
  const d = parseServerTime(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff === 1) return '昨天';
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/**
 * 「還剩多久解鎖」(安全頁的封鎖清單)。
 *
 * 跟 `formatDuration` 分開:那一個回答「已經跑了多久」,會寫成 `3m 20s`;
 * 這一個回答「還要等多久」,而等待只需要一個粗略的量級 —— 「還有 9 分鐘」
 * 就夠決定要不要等,精確到秒反而讓人去讀那個數字。
 */
export function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

/**
 * 平均耗時(用量頁的摘要行):**90 秒以上改用分鐘,90 分鐘以上改用小時**。
 *
 * 「183 秒」要在腦子裡除一次才知道是三分鐘,而這個數字的用途就是一眼掃過。
 * 跟 `formatDuration` 分開是因為它給的是 `3m 3s` —— 平均值不需要那個精度,
 * 一位小數的分鐘比較好比較(2.0 min vs 3.4 min)。
 * 小時那一階同一個理由:「180.0 min」要在腦子裡再除一次 60。門檻跟秒 → 分同一個 90(1.5 個上一階)。
 * ⚠️ 換階看的是**四捨五入之後**的值:89.96 秒不要顯示成「90.0s」。
 */
export function formatAverageDuration(ms: number): string {
  const seconds = ms / 1000;
  if (Number(seconds.toFixed(1)) < 90) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (Number(minutes.toFixed(1)) < 90) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

/**
 * 一個執行步驟花多久。
 *
 * 跟 `formatDuration` 分開,因為量的是**不同尺度**的東西:
 * `formatDuration` 回答「這題已經跑了多久」(人的尺度,秒與分),
 * 這一個回答「這一步花多久」—— 讀一個檔案常常是幾百毫秒,
 * 用 `formatDuration` 會整排顯示「0s」,等於沒講。
 *
 * 格式對齊設計系統 `ChatToolCalls` 的 `duration`(它的例子就是 "1.2s" / "340ms")。
 */
export function formatStepDuration(ms: number): string {
  if (ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

/**
 * 執行過程每一步要顯示的耗時(毫秒)。
 *
 * **有工具真正的耗時就用它**(後端的 step_duration:模型寫完這通呼叫 → 工具結果回來)。
 * 沒有(舊紀錄、或去重後對不到那一列)才退回「這一步到下一步之前」的區間 ——
 * 那段混著模型思考與寫答案的時間:最後一步用區間算法會一路算到答案寫完,
 * 一支零點幾秒的工具可能被畫成十幾秒。
 *
 * 算不出來回 undefined(不要用 0 頂替,那是一個假的秒數)。
 */
export function stepDurationMs(
  real: number | null | undefined,
  startedAt: number | null | undefined,
  endedAt: number | null | undefined,
): number | undefined {
  if (typeof real === 'number' && real >= 0) return real;
  if (startedAt === null || startedAt === undefined) return undefined;
  if (endedAt === null || endedAt === undefined || endedAt < startedAt) return undefined;
  return endedAt - startedAt;
}

export function formatDayTime(iso: string, locale = 'en-US'): string {
  const d = parseServerTime(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'});
  if (sameDay) return time;
  return `${d.toLocaleDateString(locale, {month: 'numeric', day: 'numeric'})} ${time}`;
}

/**
 * 搜尋面板那一欄的日期時間:**固定 `YY/MM/DD HH:MM`**。
 *
 * ⚠️ 跟 `formatDayTime` 不一樣,而且是刻意的:
 *  - **每一筆都補到兩位數**,所以每一列的字串長度一模一樣 —— 那一欄才會真的對齊。
 *    (只靠 `tabular-nums` 不夠:右緣是齊了,但 `9/17` 與 `12/05` 本來就差一個字元,
 *    整欄的形狀還是歪的。)
 *  - **時間走 24 小時制**。`04:00 PM` 那種寫法多三個字元,而且 `AM`/`PM` 兩個字母
 *    在比例字體下不一樣寬,整欄會看起來歪掉。24 小時制補零之後
 *    每一列都是一模一樣的 14 個字元。
 *
 * ⚠️ 手動補零、不走 `toLocaleDateString`:`zh-TW` 會給「2026/9/17」(不補零)、
 * `en-US` 給「09/17/26」(月在前)——兩個都不是要的形狀,而 locale 是使用者的瀏覽器
 * 決定的,交給它等於每台電腦長得不一樣。
 */
export function formatShortDate(iso: string): string {
  const d = parseServerTime(iso);
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yy}/${mm}/${dd} ${hh}:${mi}`;
}

/**
 * 訊息串上那條日期分隔線的字(設計系統 `ai-chat` 範本的 `Today`)。
 *
 * 傳的是**毫秒**不是 iso:訊息串裡混著問答、便條、還有進行中的那一則
 * (它根本還沒有 `created_at`),排序用的已經是毫秒,再轉一次只會多一次時區出錯的機會。
 *
 * ⚠️ 「今天/昨天」要比**本地日期**,不能拿時間差除以 86400000 ——
 * 凌晨 1 點問的那題,跟前一天晚上 11 點那題只差 2 小時,但它們**不是同一天**。
 */
export function formatDayLabel(ms: number, locale = 'en-US'): string {
  const d = new Date(ms);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  // 同一年不必寫年份 —— 那是雜訊,而且分隔線本來就該短
  return d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * 管理頁(用量統計 / 安全 / 帳號管理)用的**中文絕對時間**。
 *
 * 那幾頁整頁是繁體中文,設計系統的 `Timestamp`
 * 只會講英文的相對時間(「4 hours ago」),塞在整頁中文裡是唯一的英文。
 * 而且查紀錄本來就該看**絕對時間** —— 「4 小時前」在對紀錄時還要心算回去。
 * 同一天只顯示時分,跟 formatDayTime 同一條規則。
 */
export function formatAdminTime(iso: string): string {
  return formatDayTime(iso, 'zh-TW');
}

/**
 * 管理頁分組標頭用的**日期**(安全頁把事件照天分組)。
 *
 * 跟 `formatAdminTime` 分開:那一個回答「這一筆是幾點發生的」(同一天只給時分),
 * 這一個回答「這一組是哪一天」—— 拿 `formatAdminTime` 當分組鍵的話,
 * 今天的每一筆各自變成一組(它們的字串是各自的時分,不是同一天)。
 *
 * ⚠️ 「今天/昨天」比的是**本地日期**,不是時間差除以 86400000
 *(理由同 `formatDayLabel`:凌晨 1 點跟前一晚 11 點只差兩小時,但不是同一天)。
 */
export function formatAdminDay(iso: string): string {
  const d = parseServerTime(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return d.toLocaleDateString('zh-TW', {
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
