/**
 * SSH 頁籤現在看到的是「選主機」還是「終端機」—— 螢幕保護計不計閒置、視窗要不要深色,都看這一份(`pages/Terminal.tsx`)。
 *
 * 選主機的畫面不進螢幕保護(否則看起來像壞掉),而且跟著淺色 / 深色佈景走;只有終端機固定深色。
 */

export type PickerTab = {
  /** null = 還沒選主機(這個頁籤畫的是主機卡片) */
  hostId: string | null;
  /** 連線現在活著沒(連上 → true,斷了 → false) */
  isLive: boolean;
  /** 收過後端第一則狀態沒。還沒收過 = 卡片網格還在「連線中」 */
  hasStatus: boolean;
};

/**
 * 這個頁籤畫的是不是主機卡片:還沒選主機,或選了但還在「連線中」(後端一則狀態都還沒回)。
 * ⚠️ 不能只看 `isLive`:斷線的頁籤 `isLive` 也是 false,但它畫的是終端機(上面印著斷線原因)。
 */
export function showsPicker(tab: PickerTab): boolean {
  return !tab.hostId || !tab.hasStatus;
}

/**
 * 要不要計閒置(螢幕保護):**畫面上看得到的每一塊都是連著的終端機**才算。
 * 停在選主機的畫面、分割畫面其中一塊還在選主機 —— 都不計,按鍵也不重新開始算。
 */
export function watchesIdle(shown: readonly PickerTab[]): boolean {
  return shown.length > 0 && shown.every((t) => !showsPicker(t) && t.isLive);
}
