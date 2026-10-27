/**
 * 「跳到這一則」之後亮一圈。
 *
 * 跟 `petSpeech` 同一個做法:發一個事件,掛在 App 層的 `<JumpSpotlight />` 訂閱。
 * 走事件而不是 props 的理由一樣 —— 呼叫端(檔案區的 onJump 在 `Chat`)跟
 * 畫的人(App 層的常駐元件)中間隔著整個版面,穿 props 要經過四五層。
 */

export const JUMP_SPOTLIGHT = 't100:jump-spotlight';

export type JumpSpotlightDetail = {
  /**
   * 要圈起來的那個 DOM id:提問是 `turn-{qaId}`、答案是 `answer-{qaId}`、
   * 便條是 `note-{noteId}`(哪一個由檔案的來源決定,見 `FileRow.jumpId`)。
   */
  anchorId: string;
};

/**
 * 圈住某個錨點。
 *
 * ⚠️ **要在捲動完成之後才呼叫** —— 這一圈是照當下的 `getBoundingClientRect()`
 * 定位的,捲到一半發的話它會先畫在舊位置再跳過去。
 * 找不到那個 id 就什麼都不會發生(元件自己會檢查),呼叫端不用先確認。
 */
export function spotlightAnchor(anchorId: string) {
  window.dispatchEvent(
    new CustomEvent<JumpSpotlightDetail>(JUMP_SPOTLIGHT, {detail: {anchorId}}),
  );
}
