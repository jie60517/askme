/**
 * 手機鍵盤的提示屬性 —— 登入頁、SSH 登入方框、檔案欄的路徑欄共用。
 *
 * ⚠️ 這幾個屬性 Astryx 的 `TextInput` **只在型別上**拿掉了(`BaseProps` 把
 * `inputMode` / `autoCapitalize` / `autoCorrect` / `spellCheck` / `enterKeyHint`
 * 列在 Omit 裡,`autoComplete` 則根本不在 `HTMLAttributes` 上);執行期它會把
 * `...rest` 原樣攤到裡面那個 `<input>`(`TextInput.js` 的 `_jsx("input", {...rest, ...})`)。
 * 所以用一個有型別的物件**展開**進去(`{...NO_AUTOFIX}`)—— JSX 的展開不做多餘屬性檢查,
 * 而型別仍然擋得住拼錯的屬性名。設計系統升版後如果不再攤 `rest`,
 * `components/__tests__/TextInputNativeHints.test.tsx` 會先紅。
 */
import type {InputHTMLAttributes} from 'react';

export type NativeInputHints = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'inputMode' | 'autoComplete' | 'autoCapitalize' | 'autoCorrect' | 'spellCheck' | 'enterKeyHint'
>;

/**
 * 「打什麼就是什麼」的欄位(帳號、IP、路徑、密碼):關掉自動大寫、自動校正、拼字檢查。
 * iOS 會把帳號第一個字自動大寫(`admin` 變 `Admin` 就登不進去)、把路徑校正成別的字;
 * 密碼欄在「按住看密碼」換成 type="text" 的那一刻也一樣會被動到。
 */
export const NO_AUTOFIX = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const satisfies NativeInputHints;
