/**
 * 強制改密碼。
 *
 * password_is_default 為 true 時的唯一畫面。只有兩條路:改密碼、登出。
 * 一定要留登出出口 —— 沒有的話使用者只能關分頁,而下次打開還是這一頁。
 */
import {useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Center} from '@astryxdesign/core/Center';
import {useEntryAnimation} from '@astryxdesign/core/hooks';
import {VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {PasswordChangeFields, usePasswordChangeForm} from '../components/PasswordChangeFields';
import {IDENTITY_CHANGED} from '../lib/auth';
import {changePassword, describePasswordError, signOut} from '../lib/loginApi';

/** 跟登入頁同一套底(login-split 的頁面底就是 body 色,不是照片)。 */
const styles = stylex.create({
  page: {
    minHeight: '100%',
    backgroundColor: 'var(--color-background-body)',
  },
});

export default function ForcePasswordChange() {
  /** 從整頁的載入畫面接手過來的淡入。 */
  const entry = useEntryAnimation('fadeIn');
  // 三格、檢查規則、錯誤都在 PasswordChangeFields(跟修改密碼對話框共用)
  const form = usePasswordChangeForm();
  const [loading, setLoading] = useState(false);

  const canSubmit = form.isComplete && !loading;

  async function handleSubmit() {
    if (!canSubmit) return;
    setLoading(true);
    form.setError(null);
    try {
      await changePassword(form.current, form.next);
      // 只發身分變更事件,由 App 重問一次身分後放行。
      window.dispatchEvent(new Event(IDENTITY_CHANGED));
    } catch (err) {
      // 這一頁不能用 describeLoginError —— 401/400 在這裡的意思是
      //「目前的密碼不正確」,不是「帳號或密碼錯誤」。
      form.setError(describePasswordError(err));
      setLoading(false);
    }
  }

  return (
    <Center axis="both" padding={6} xstyle={[styles.page, entry]}>
      <Card padding={8} width="100%" maxWidth={400}>
          <VStack gap={4} hAlign="stretch">
            {/* 靠左,跟登入頁(Welcome back)同一個排法。不要置中:標題折成兩行後會撐滿整行、
                實際靠左,只剩副標置中,看起來歪一邊 */}
            <VStack gap={1} hAlign="start">
              <Text type="display-1" as="h1">
                Change your password
              </Text>
              <Text type="body" color="secondary" size="sm">
                Your account is still using the default password.
              </Text>
            </VStack>

            {/* 三格與錯誤的樣子(跟登入頁一樣)見 PasswordChangeFields;整頁這一頁用大欄位 */}
            <PasswordChangeFields form={form} variant="page" />

            <VStack gap={2}>
              <Button
                label="Change password"
                variant="primary"
                size="lg"
                width="100%"
                isDisabled={!canSubmit}
                isLoading={loading}
                onClick={() => void handleSubmit()}
              />
              <Button
                label="Sign out instead"
                variant="ghost"
                width="100%"
                onClick={() => void signOut()}
              />
            </VStack>
          </VStack>
      </Card>
    </Center>
  );
}
