// @vitest-environment jsdom
/**
 * 登入頁、SSH 終端機檔案欄路徑欄的手機鍵盤提示(`lib/nativeInputHints.ts`)
 * 真的落在 `<input>` 上。
 *
 * Astryx 0.7 起這幾個是 TextInput 的正式屬性(0.4 時代只能靠展開塞進去);
 * 升版若又改名或改成不往 `<input>` 給,`tsc` 不一定會叫 —— 手機上驗證碼會跳回全鍵盤、
 * 帳號第一個字被自動大寫。這一檔就是那條線上的警報。
 *
 * ⚠️ 不 import `pages/Login.tsx`(它拖著 three.js 場景與整頁的 StyleX)。
 */
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render} from '@testing-library/react';

import {TextInput} from '@astryxdesign/core/TextInput';

import {NO_AUTOFIX} from '../../lib/nativeInputHints';

afterEach(cleanup);

describe('TextInput 的手機鍵盤提示落在 <input> 上', () => {
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
    const {container} = render(
      <TextInput label="Username" value="" onChange={() => {}} {...NO_AUTOFIX} />,
    );
    const input = container.querySelector('input')!;
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });
});
