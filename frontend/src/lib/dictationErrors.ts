/**
 * 語音輸入失敗時要跟使用者講的那一句。
 *
 * 設計系統的 `useChatDictation` 出錯只會呼叫 `onError`,畫面上**什麼都不會變**
 * (看起來就是「錄音鈕點下去沒有反應」)。最常見的情況根本不是壞掉:
 * - 網址是 `http://<主機>`(不是 localhost 也不是 https)—— 瀏覽器不給麥克風,
 *   SpeechRecognition 直接回 `not-allowed`;用 http 部署時一定會遇到。
 * - 麥克風權限被擋(使用者按過「封鎖」,或這個瀏覽器分頁不准用裝置)。
 * - Chrome 的語音辨識要連 Google 的服務,離線 / 內網回 `network`。
 * 每一種要講的話不一樣,所以照錯誤碼對表;對不到的一律講「失敗了 + 代碼」,
 * 不要吞掉 —— 吞掉就回到「沒有反應」。
 *
 * 錯誤碼是 Web Speech API 的 `SpeechRecognitionErrorCode`,加上設計系統自己
 * 在 `onnomatch` 時補的 `no-speech`。
 */

/** 回 `null` 表示不用打擾 —— 目前只有一種:使用者自己按停(`aborted`)。 */
export function describeDictationError(
  code: string,
  isSecureContext: boolean = typeof window !== 'undefined' && window.isSecureContext,
): string | null {
  switch (code) {
    case 'aborted':
      // 使用者自己停的(toggle → abort),不是錯
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return isSecureContext
        ? 'Microphone access is blocked. Allow the microphone for this site in the browser, then try again.'
        : 'Voice input needs a secure connection. Open the site over https:// (or localhost) to use the microphone.';
    case 'audio-capture':
      return 'No microphone was found. Connect one and try again.';
    case 'network':
      return 'Voice recognition could not reach the speech service. Check the network connection and try again.';
    case 'no-speech':
      return 'No speech was heard. Tap the microphone and speak again.';
    case 'language-not-supported':
      return 'This language is not supported for voice input in this browser.';
    default:
      return `Voice input failed (${code}).`;
  }
}

/**
 * `toggle()` **同步丟例外**的那條路。
 *
 * 上面那支處理的是「開起來之後才出事」(走 `onError`);這支處理「根本沒開成」——
 * `recognition.start()` 是同步呼叫,在辨識器還沒收乾淨的時候再按一次,瀏覽器丟
 * `InvalidStateError`,而設計系統沒有接。沒接的結果一樣是**畫面完全沒反應**,所以這條也要講。
 */
export function describeDictationStartError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'InvalidStateError') {
    return 'Voice input is still finishing the last session. Wait a moment and tap the microphone again.';
  }
  return name ? `Voice input could not start (${name}).` : 'Voice input could not start.';
}
