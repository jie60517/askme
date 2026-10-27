/**
 * 改密碼的三格(目前的密碼 / 新密碼 / 再輸入一次)—— 修改密碼對話框(`ChangePasswordDialog`)
 * 與強制改密碼頁(`pages/ForcePasswordChange`)共用,兩個改密碼畫面的規則才不會不一樣。
 *
 * 錯誤一律跟登入頁同一個樣子(欄位紅框 + 從欄位底下長出來的訊息框,見 `FieldMessage.tsx`):
 * 後端回來的錯誤(多半是目前的密碼不對)掛在「Current password」底下;太短掛「New password」;
 * 兩次不一致掛「New password again」。後兩個是打字當下就跳的檢查,用 `role="status"`,不打斷輸入。
 *
 * 兩邊**刻意不同**的地方由 `variant` 決定:
 *  - `dialog`(修改密碼對話框):預設尺寸;給 `current-password / new-password / confirm-password` 這三個 name,
 *    讓密碼管理員認得(Astryx 的 TextInput 沒開放 `autoComplete`,理由見 `ChangePasswordDialog.tsx` 檔頭);
 *    打開就聚焦第一格。
 *  - `page`(強制改密碼頁):整頁的大欄位(lg);不給 name、不搶焦點。
 */
import {useCallback, useState} from 'react';

import {VStack} from '@astryxdesign/core/Layout';
import {TextInput} from '@astryxdesign/core/TextInput';

import {FieldWithMessage} from './FieldMessage';

/** 新密碼的最短長度。兩個改密碼畫面同一個下限 */
export const MIN_PASSWORD_LENGTH = 6;

/** 三格的值、後端錯誤,以及由它們算出來的檢查結果 */
export function usePasswordChangeForm() {
  const [current, setCurrentValue] = useState('');
  const [next, setNextValue] = useState('');
  const [again, setAgainValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 打字就清掉後端錯誤:錯誤講的是上一次送出的內容,改了就不再成立
  const clearingError = (set: (value: string) => void) => (value: string) => {
    set(value);
    setError(null);
  };
  const setCurrent = clearingError(setCurrentValue);
  const setNext = clearingError(setNextValue);
  const setAgain = clearingError(setAgainValue);

  const tooShort = next !== '' && next.length < MIN_PASSWORD_LENGTH;
  // 兩次不一致一定要在前端擋:後端只收到一個新密碼,打錯字等於把自己鎖在對話外面。
  const mismatch = again !== '' && next !== again;
  /** 三格都填好、而且過了前端檢查(還沒算「送出中」—— 那是呼叫端的狀態) */
  const isComplete = current !== '' && next.length >= MIN_PASSWORD_LENGTH && next === again;

  /** 全部清空。密碼留在 state 裡沒有任何好處,而且下次打開會看到上次打到一半的東西 */
  const reset = useCallback(() => {
    setCurrentValue('');
    setNextValue('');
    setAgainValue('');
    setError(null);
  }, []);

  return {current, setCurrent, next, setNext, again, setAgain, error, setError, tooShort, mismatch, isComplete, reset};
}

export type PasswordChangeForm = ReturnType<typeof usePasswordChangeForm>;

export function PasswordChangeFields({form, variant}: {form: PasswordChangeForm; variant: 'dialog' | 'page'}) {
  const isDialog = variant === 'dialog';
  const size = isDialog ? undefined : 'lg';
  return (
    <VStack gap={2}>
      <FieldWithMessage error={form.error}>
        <TextInput
          label="Current password"
          type="password"
          value={form.current}
          onChange={form.setCurrent}
          size={size}
          htmlName={isDialog ? 'current-password' : undefined}
          hasAutoFocus={isDialog}
        />
      </FieldWithMessage>
      {/* 刻意寫成 JSX 而不是樣板字串:兩種寫法的字距在次像素上不一樣 */}
      <FieldWithMessage error={form.tooShort ? <>Use at least {MIN_PASSWORD_LENGTH} characters.</> : null} role="status">
        <TextInput
          label="New password"
          type="password"
          value={form.next}
          onChange={form.setNext}
          size={size}
          htmlName={isDialog ? 'new-password' : undefined}
        />
      </FieldWithMessage>
      <FieldWithMessage error={form.mismatch ? 'The two passwords do not match.' : null} role="status">
        <TextInput
          label="New password again"
          type="password"
          value={form.again}
          onChange={form.setAgain}
          size={size}
          htmlName={isDialog ? 'confirm-password' : undefined}
        />
      </FieldWithMessage>
    </VStack>
  );
}
