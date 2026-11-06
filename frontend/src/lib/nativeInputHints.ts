/**
 * 手機鍵盤的提示屬性 —— 登入頁、SSH 登入方框、檔案欄的路徑欄共用。
 *
 * Astryx 0.7 起 `TextInput` 自己有這幾個屬性(`enterKeyHint`、`inputMode`、`autoCapitalize`、
 * `hasAutoCorrect`、`hasSpellCheck`、`autoComplete`),這裡直接用正式屬性,
 * 不靠展開塞進 `<input>`。
 * `components/__tests__/TextInputNativeHints.test.tsx` 驗它們真的落在 `<input>` 上。
 */
import type {TextInputProps} from '@astryxdesign/core/TextInput';

export type NativeInputHints = Pick<
  TextInputProps,
  'inputMode' | 'autoComplete' | 'autoCapitalize' | 'hasAutoCorrect' | 'hasSpellCheck' | 'enterKeyHint'
>;

/**
 * 「打什麼就是什麼」的欄位(帳號、IP、路徑、密碼):關掉自動大寫、自動校正、拼字檢查。
 * iOS 會把帳號第一個字自動大寫(`admin` 變 `Admin` 就登不進去)、把路徑校正成別的字;
 * 密碼欄在「按住看密碼」換成 type="text" 的那一刻也一樣會被動到。
 */
export const NO_AUTOFIX = {
  autoCapitalize: 'none',
  hasAutoCorrect: false,
  hasSpellCheck: false,
} as const satisfies NativeInputHints;
