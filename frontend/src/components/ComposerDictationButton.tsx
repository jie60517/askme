/**
 * 輸入框的錄音鈕。**整個語音狀態關在這一顆元件裡**,這是重點。
 *
 * ⚠️ 為什麼要獨立一個檔:
 * `useChatDictation` 在錄音中會用 `requestAnimationFrame` **每一格**更新
 * `volume` / `bands`(那排音量條要動)—— 一秒六十次的 setState。
 * 這個 hook 若呼叫在 `Chat.tsx` 的本體裡,**整頁**就跟著一秒重繪六十次。
 *
 * 後果不是變慢而已:設計系統的浮層用 CSS anchor positioning 定位,而它把
 * `anchor-name` 寫在觸發元素的 inline style 上,靠一個**每次 render 都重新建立**的
 * ref callback 掛上去(`Layer/useLayer.tsx`:`removeAnchorName` / `addAnchorName`)。
 * React 在每一次 commit 都會把這種 ref 先卸再掛,於是錄音中那個錨點一秒被拆裝六十次;
 * 錨點一旦解析不到,浮層就失去定位基準,**掉到視窗左上角**(錄音中打開的選單,
 * 尤其是觸發列住在上一層浮層裡的子選單)。
 *
 * 把 hook 關進這顆葉子元件,那六十次重繪只影響這顆鈕自己,
 * 選單、輸入框、訊息串都不會重繪,錨點也就不會被反覆拆裝。
 *
 * ⚠️ **不要為了「少一個檔案」把 `useChatDictation` 搬回 `Chat.tsx`。**
 */
import {useMemo} from 'react';

import {ChatDictationButton, useChatDictation} from '@astryxdesign/core/Chat';
import type {ChatComposerInputHandle} from '@astryxdesign/core/Chat';

import {describeDictationError, describeDictationStartError} from '../lib/dictationErrors';
import {toastError} from '../lib/toast';

type Props = {
  /**
   * 輸入框的 handle。逐字稿要直接以淡字出現在輸入框裡,hook 要拿得到它。
   * ref 物件的**識別是穩定的**,所以傳下來不會害這顆元件多重繪。
   */
  inputRef: React.RefObject<ChatComposerInputHandle | null>;
  /**
   * 顏色與漂浮框的記號(`Chat.tsx` 的 `COMPOSER_ACTION`),原封不動轉給那顆鈕。
   * ⚠️ 要**明寫在型別裡**:JSX 對帶連字號的屬性不做檢查,只靠 `...rest` 的話
   * 這個契約在型別上是隱形的,下一個人會以為這顆元件不吃外部樣式記號。
   */
  'data-hover-lift'?: string;
  'data-composer-action'?: string;
};

export function ComposerDictationButton({inputRef, ...rest}: Props) {
  /**
   * 瀏覽器不支援 SpeechRecognition 時那顆鈕**會自己隱藏**,不必自己判斷。
   */
  const dictation = useChatDictation({
    inputRef,
    /*
     * 出錯要講:設計系統出錯時畫面什麼都不變 —— 沒有 https、麥克風被擋、離線,
     * 全部長得跟「鈕壞了」一樣。哪一句對哪一種在 lib/dictationErrors.ts。
     * uniqueID 固定:連續失敗只留一張,不要疊一排。
     */
    onError: ({error}) => {
      const message = describeDictationError(error);
      if (message) toastError(message, 'dictation');
    },
  });

  /**
   * 上面那個 `onError` 只接得到「開起來之後」的錯。**還有一條同步的路**:
   * `toggle()` 裡的 `recognition.start()` 會直接丟例外(辨識器還沒收乾淨時
   * 再按一下就是 `InvalidStateError`),設計系統沒有接 —— 那條路上畫面一樣
   * 完全沒反應。包一層把它講出來。
   *
   * ⚠️ 只包 `toggle`,其餘原封不動轉交:`ChatDictationButton` 會讀
   * `isListening` / `bands` / `volume` 畫那排音量條,少一個都不會動。
   */
  const guarded = useMemo(
    () => ({
      ...dictation,
      toggle: () => {
        try {
          dictation.toggle();
        } catch (error) {
          toastError(describeDictationStartError(error), 'dictation');
        }
      },
    }),
    [dictation],
  );

  return <ChatDictationButton dictation={guarded} {...rest} />;
}
