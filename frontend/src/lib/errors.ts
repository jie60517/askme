/**
 * 把丟出來的東西翻成一句**給人看**的話。
 *
 * ⚠️ 不要直接把 error 丟進 toast:axios 的錯誤 `String(err)` 出來是
 * 「AxiosError: Request failed with status code 409」—— 對使用者毫無意義,
 * 而且真正有用的那句(後端寫的 `detail`)藏在 `response.data.detail` 裡。
 *
 * 順序是刻意的:**後端的 detail 優先**。那幾句是照情境寫的
 * (「這個帳號已經存在」「不能用管理員的帳號名」),永遠比前端的通用字串準。
 */
/** axios 錯誤的 HTTP 狀態碼;不是 HTTP 錯誤(斷網、程式錯)就 undefined */
export function httpStatus(err: unknown): number | undefined {
  return (err as {response?: {status?: number}})?.response?.status;
}

export function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as {response?: {data?: {detail?: unknown}}})?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  /*
   * FastAPI 的 422(欄位驗證)`detail` 是一個陣列,不是字串 ——
   * 直接顯示會變成 `[object Object]`。取第一條的 msg 就夠了:
   * 這種錯誤對使用者來說只需要知道「哪裡填錯」。
   */
  if (Array.isArray(detail)) {
    const first = detail[0] as {msg?: unknown} | undefined;
    if (typeof first?.msg === 'string' && first.msg.trim()) return first.msg;
  }
  return fallback;
}
