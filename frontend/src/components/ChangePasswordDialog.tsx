/**
 * 改密碼。
 *
 * 三欄 + 前端擋兩次不一致 —— 後端只收到一個新密碼,打錯字等於把自己
 * 鎖在對話外面。成功後要講「其他裝置上的登入已經被登出」:後端會撤銷
 * 這個人其他地方的 token,不講的話他手機上突然被登出會以為出事了。
 *
 * ⚠️ 三欄理想上要標 `autoComplete`(密碼管理員靠它認出這是改密碼表單,
 * 不是註冊)。**Astryx 的 TextInput 沒有開放那個屬性** —— 它的 props 繼承的是
 * `HTMLAttributes`,而 `autoComplete` 在 `InputHTMLAttributes` 上。
 * 所以用 `htmlName`(current-password / new-password / confirm-password),
 * 多數密碼管理員也吃 name 這個訊號。要真正做到得等設計系統開放,或 swizzle 它。
 *
 * 對話框本身的契約(Esc、焦點循環、關閉後還焦點、鎖背景捲動…)
 * 交給 Astryx 的 Dialog。
 */
import {useEffect, useState} from 'react';

import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';

import {IDENTITY_CHANGED} from '../lib/auth';
import {changePassword, describePasswordError} from '../lib/loginApi';
import {toastInfo} from '../lib/toast';
import {PasswordChangeFields, usePasswordChangeForm} from './PasswordChangeFields';
import {useDialogExit} from './useDialogExit';

type Props = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ChangePasswordDialog({isOpen, onOpenChange}: Props) {
  // 退場(淡出 + 縮一點點)要演得完,`close()` 就得延後 —— 全站共用同一支
  const exit = useDialogExit(onOpenChange);
  // 三格、檢查規則、錯誤都在 PasswordChangeFields(跟強制改密碼頁共用)
  const form = usePasswordChangeForm();
  const [isSaving, setIsSaving] = useState(false);

  // 關掉就清乾淨:密碼留在 state 裡沒有任何好處,而且下次打開會看到上次打到一半的東西
  const {reset} = form;
  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);

  const canSubmit = form.isComplete && !isSaving;

  async function handleSubmit() {
    if (!canSubmit) return;
    setIsSaving(true);
    form.setError(null);
    try {
      await changePassword(form.current, form.next);
      // 後端會把這個人其他地方的登入一起撤掉 —— 一定要講,
      // 不然他手機上突然被登出會以為帳號出事了
      toastInfo('Password changed. You have been signed out on your other devices.');
      exit.requestClose();
      // 身分沒變,但重問一次最省事(密碼狀態、password_is_default 都在那支上)
      window.dispatchEvent(new Event(IDENTITY_CHANGED));
    } catch (err) {
      // 這裡的 401/400 是「目前的密碼不正確」,不是「帳號或密碼錯誤」
      form.setError(describePasswordError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} {...exit.dialogProps} width={420} purpose="form">
      {/*
        走 `Layout` + `LayoutContent`,跟 `FilesDialog` / `ShareDialog` 同一個形狀:
        內容直接塞進 `Dialog` 的話面板內層是 `overflow: hidden`,視窗矮的時候
        按鈕那排會落在 75vh 之外**捲不到也點不到**。
        標頭與按鈕釘住,只有中間那層捲。
      */}
      <Layout
        header={
          <DialogHeader title="Change password" onOpenChange={exit.dialogProps.onOpenChange} />
        }
        content={
          <LayoutContent>
            {/* 三格與錯誤的樣子(跟登入頁一樣)見 PasswordChangeFields;對話框版給 name 讓密碼管理員認得、打開就聚焦第一格 */}
            <PasswordChangeFields form={form} variant="dialog" />
          </LayoutContent>
        }
        footer={
          // LayoutFooter 給底列內距:裸放 HStack 時按鈕會貼在對話框右下角(右、下間距 0)
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={exit.requestClose} />
              <Button
                label="Change password"
                variant="primary"
                isDisabled={!canSubmit}
                isLoading={isSaving}
                onClick={() => void handleSubmit()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
