/**
 * SSH 選連線的過場:瀏覽器的 View Transitions。先拍舊畫面,`update` 同步畫完新畫面,
 * 兩邊名字相同的元素自己補中間那段:
 *   - `host-card`:主機卡片外框 ↔ 登入方框 ↔(連上那一下)終端機那一塊
 *   - `host-logo`:卡片上的 logo ↔ 方框右邊那張
 * 節奏寫在 `styles/global.css` 的「SSH 選連線的過場」那一段;`className` 掛在 <html> 上,讓那一次用自己的節奏
 * (`vt-terminal` = 方框長滿、整片暗成黑底終端機)。
 *
 * 不支援或使用者要求減少動態 → 直接換,沒有過場。回傳的 Promise 在過場結束(或被跳過)時 resolve,不會 reject。
 * ⚠️ 同一個名字一頁只能有一個看得到的元素,重複的話瀏覽器會整個跳過過場(畫面照樣換,只是沒有動畫)。
 */
import {flushSync} from 'react-dom';

type ViewTransition = {finished: Promise<void>};
type StartViewTransition = (cb: () => void) => ViewTransition;

export function morph(update: () => void, className?: string): Promise<void> {
  const start = (document as Document & {startViewTransition?: StartViewTransition}).startViewTransition;
  if (!start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return Promise.resolve();
  }
  const root = document.documentElement;
  if (className) root.classList.add(className);
  const t = start.call(document, () => flushSync(update));
  return t.finished
    .catch(() => {})
    .finally(() => {
      if (className) root.classList.remove(className);
    });
}
