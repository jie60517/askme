/**
 * 「現在重整的話,會不會弄丟使用者的東西?」
 *
 * 唯一的呼叫端是 `components/UpdateWatcher.tsx`(決定要不要自動換到新版),
 * 但抽成自己的模組有兩個理由:它一點都不碰元件自身的狀態,
 * 而且它**判斷錯的代價不對稱**,需要測試守著。
 *
 * ⚠️ **兩個方向的錯,後果差很遠**:
 *   - 漏抓 = **把人家做到一半的東西弄不見**;
 *   - 多抓 = 只是改成跳 toast 讓他自己按,沒有人損失什麼。
 * 所以一律往「不敢動」那邊倒。
 */
import {getActiveStreams} from './runs';

/**
 * 會被當成「打到一半的字」的 `input` 型別。
 *
 * ⚠️ **這份白名單是必要的,不能改成「只要 value 非空就算」。**
 * 站上有 `<input type="color">`(`components/ColorPicker.tsx`,資料夾換顏色用),
 * 而它的 `value` **永遠**是 `#rrggbb` —— 那個元件自己的註解就寫著「只收 #rrggbb」。
 * 用「value 非空」當條件的話,只要選色器還在 DOM 裡,這支就永遠回 `true`,
 * 於是「趁他不在的時候自動換掉」那一段永遠不成立,三段式直接退化成
 * 「每次上版都跳 toast 給所有人看」—— 正好是這個功能最想避免的結果。
 * `type="file"`(有三處)與 checkbox(`value` 預設 `'on'`)是同一類問題。
 */
const TEXTUAL_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  // `<textarea>` 的 `.type` 就是這個字串,所以同一份白名單管得到它
  'textarea',
]);

/**
 * 那些**狀態只活在 React 元件裡、DOM 上看不出來**的「正在進行的事」。
 *
 * 掃 DOM 抓得到「打了字」,抓不到「挑好了三個附件還沒送」——
 * `<input type="file">` 的 `value` 在那種情況下仍然是空字串,而檔案本身
 * 只存在 `useComposerAttachments` 的 state 裡。這種東西自己來登記。
 */
const busySources = new Set<() => boolean>();

/**
 * 登記一個「我現在很忙,不要重整」的來源。回傳的函式解除登記。
 *
 * 呼叫端要保證這支**便宜且不丟例外** —— 它會在每次判斷時被呼叫。
 */
export function registerBusySource(isBusy: () => boolean): () => void {
  busySources.add(isBusy);
  return () => {
    busySources.delete(isBusy);
  };
}

/**
 * 有問答正在跑。
 *
 * ⚠️ **這不是因為「答案會弄丟」** —— `lib/runs.ts` 開頭寫得很清楚:回答不掛在
 * HTTP 連線上,後端一收到就寫紀錄並丟到背景跑,重整之後靠 `GET /api/ask/runs`
 * 就接得回來(串流會從第一個事件重播)。
 *
 * 真正要擋的是**剛送出的那一瞬間**:`pages/Chat.tsx` 的送出流程是
 * 建 pending → 發 POST(附件是 FormData)→ 導頁,所以有一個「pending 已經在了、
 * POST 還在路上」的窗口。那時重整會中斷請求,後端從頭到尾不會收到那一題。
 * 其次才是體驗:把跑到一半的畫面重播一次,對使用者來說就是倒退。
 */
function hasRunningAnswer(): boolean {
  return getActiveStreams().length > 0;
}

/**
 * 人在 SSH 終端機那一頁。
 *
 * ⚠️ **這一頁整頁都不能自動重整。** 那裡「正在進行的事」不是打到一半的字,
 * 是一條開著的 WebSocket —— 重整等於把連線砍掉,而終端機裡跑到一半的指令
 * 不會因為重新連上就回來。xterm 的輸入又是讀一個隱藏 textarea 並即時清空,
 * 所以下面掃 DOM 那條完全看不到他打了什麼。
 *
 * 檔案欄(`components/terminal/FilePanel.tsx`)上傳中的檔案也在這一頁,一併涵蓋。
 *
 * ⚠️ 這條只管「人在這一頁」。換頁不斷線(`App.tsx` 的 `keepSsh`),人在別頁時
 * 連線還開在背景 —— 那一段由 `pages/Terminal.tsx` 自己 `registerBusySource` 登記(有開著的連線就算忙),
 * 不要以為這裡沒涵蓋就把它拿掉。
 */
function isOnTerminalPage(): boolean {
  return window.location.pathname.startsWith('/ssh');
}

/** 有打了還沒送出的字。 */
function hasUnsentText(): boolean {
  /*
   * ⚠️ 輸入框**不是 `<textarea>`** —— `ChatComposerInput` 是一顆 contenteditable
   * 的 div(見 `pages/Chat.tsx` 那段警告),所以兩種都要找。
   */
  for (const el of document.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
    /*
     * ⚠️ 用 `textContent` 不是 `innerText`,兩個理由:
     *   1. jsdom **沒有實作 `innerText`**(是 `undefined`),用它的話這支在測試裡
     *      直接丟 TypeError,等於這條路根本測不到;
     *   2. `innerText` 會看排版(隱藏的東西不算),而「藏起來的輸入框裡有字」
     *      仍然是「他打過字」—— 往不敢動那邊倒才對。
     */
    if ((el.textContent ?? '').trim() !== '') return true;
  }

  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )) {
    if (el.disabled || el.readOnly) continue;
    if (!TEXTUAL_INPUT_TYPES.has(el.type)) continue;
    if (el.value.trim() !== '') return true;
  }

  return false;
}

/** 登記的來源裡有沒有人說自己在忙。 */
function hasBusySource(): boolean {
  for (const isBusy of busySources) {
    try {
      if (isBusy()) return true;
    } catch {
      // 查詢函式自己壞掉不該連累整個判斷 —— 但也不能當成「不忙」,
      // 因為我們不知道它本來要回什麼。往不敢動那邊倒。
      return true;
    }
  }
  return false;
}

/** 現在重整會不會弄丟東西。 */
export function wouldLoseWork(): boolean {
  return isOnTerminalPage() || hasRunningAnswer() || hasUnsentText() || hasBusySource();
}
