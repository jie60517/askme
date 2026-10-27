// @vitest-environment jsdom
/**
 * 登入頁靠「型別上被拿掉、執行期照樣攤到 `<input>`」這件事給手機鍵盤提示
 * (`pages/Login.tsx` 的 `NativeInputHints`)。
 *
 * 那是設計系統的**實作細節**(`TextInput.js` 把 `...rest` 攤到 `<input>`),
 * 不是公開的介面 —— 升版改掉的話 `tsc` 一聲不吭,手機上驗證碼又跳回全鍵盤、
 * 帳號第一個字又被自動大寫。這一檔就是那條線上唯一的警報。
 *
 * ⚠️ 不 import `pages/Login.tsx`(它拖著 three.js 場景與整頁的 StyleX);
 * 這裡只驗那條前提:展開進去的屬性真的落在 `<input>` 上。
 */
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render} from '@testing-library/react';

import {TextInput} from '@astryxdesign/core/TextInput';

afterEach(cleanup);

describe('TextInput 把型別外的原生屬性攤到 <input>', () => {
  it('驗證碼:inputmode / autocomplete / enterkeyhint', () => {
    const hints = {inputMode: 'numeric', autoComplete: 'one-time-code', enterKeyHint: 'go'} as const;
    const {container} = render(
      <TextInput label="Verification code" value="" onChange={() => {}} {...hints} />,
    );
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('inputmode')).toBe('numeric');
    expect(input!.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input!.getAttribute('enterkeyhint')).toBe('go');
    // 不能靠 type=number 湊數字鍵盤(會吃掉開頭的 0)
    expect(input!.getAttribute('type')).not.toBe('number');
  });

  it('帳號:autocapitalize / autocorrect / spellcheck 關掉', () => {
    const hints = {
      autoCapitalize: 'none',
      autoCorrect: 'off',
      spellCheck: false,
    } as const;
    const {container} = render(
      <TextInput label="Username" value="" onChange={() => {}} {...hints} />,
    );
    const input = container.querySelector('input')!;
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });
});
