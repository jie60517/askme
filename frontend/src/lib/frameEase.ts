/**
 * rAF 迴圈裡的「指數逼近」,**照兩幀之間實際過了多久**換算比例。
 *
 * 側邊欄的滾輪果凍捲動與拖曳幽靈追手指都是「每一幀走掉剩餘距離的固定比例」——
 * 但那個「固定」指的是**每 60Hz 一幀**,不是每一次 rAF:rAF 在 120Hz 的螢幕上
 * 一秒叫 120 次,直接每次走同一個比例會讓收斂快一倍,同一份程式在兩台機器上
 * 是兩種黏度。兩處共用這一份,不各自算。
 */

/** 60Hz 的一幀(ms)。各處的逼近比例都是以這個為基準定的。 */
export const FRAME_MS = 1000 / 60;

/**
 * 兩幀之間最多當成多久。分頁切回來(或被擋住一陣子)的第一幀 dt 會很大,
 * 不夾的話那一幀會直接跳到底;三幀是「看得出在動、又不會像卡住」的長度。
 */
export const MAX_FRAME_GAP_MS = FRAME_MS * 3;

/**
 * 這一幀該走掉剩餘距離的比例。
 * `perFrame` 是「每 60Hz 一幀走掉的比例」;過了 dtMs 就走 1 − (1 − perFrame)^(dtMs / FRAME_MS),
 * 所以 dt 剛好一幀時等於 perFrame,兩幀時等於「連走兩次」的總量。
 */
export function easeStep(perFrame: number, dtMs: number): number {
  return 1 - Math.pow(1 - perFrame, dtMs / FRAME_MS);
}

/** 上一幀的時間戳 → 這一幀的 dt。第一幀(沒有上一幀)當一幀算;超過的夾在 MAX_FRAME_GAP_MS。 */
export function frameDelta(lastTs: number | undefined, ts: number): number {
  return lastTs === undefined ? FRAME_MS : Math.min(ts - lastTs, MAX_FRAME_GAP_MS);
}
