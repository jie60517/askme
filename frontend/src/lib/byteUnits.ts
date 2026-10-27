/**
 * 位元組 → 「數字 + 單位」的升階規則,檔案欄(`terminalApi.formatSize`)與檔案區(`files.formatBytes`)共用。
 *
 * 兩邊的**顯示格式不一樣**(檔案欄一律一位小數、檔案區 10 以上不留小數),但「什麼時候升一個單位」
 * 是同一條規則,所以只寫一份。
 *
 * ⚠️ 升階看的是**照呼叫端的精度四捨五入之後**的值:1,048,575 B 是
 * 1023.999 KB,只比 1024 小一點點,顯示出來卻是「1024.0 KB」—— 進位後到了 1024 就當下一個單位的 1。
 */

/**
 * 從 `units[0]`(= 1024 B)開始往上升,直到「照 `rounded` 進位之後」小於 1024 或沒有更大的單位。
 * 回傳的 `value` 是**還沒進位**的值,格式交給呼叫端(各自的 `toFixed` / `Math.round` 不變)。
 * 1024 以下(講 B 的那一段)由呼叫端自己處理。
 */
export function scaleBytes(
  bytes: number,
  units: readonly string[],
  rounded: (value: number) => number,
): {value: number; unit: string} {
  let value = bytes / 1024;
  let i = 0;
  while (rounded(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return {value, unit: units[i]};
}
