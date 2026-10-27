/**
 * 管理員幫某個帳號產生手機驗證碼。
 *
 * **這是管理員發放的模型**,使用者那一側沒有任何自助入口。
 * 流程只有一步:管理員按下去 → 後端當場配一組新密鑰、立刻生效
 * → 這裡把 QR 畫出來給人掃。
 *
 * ⚠️ **打開這個對話框就等於已經改了資料。** 按下「產生」的那一刻舊的密鑰就失效了,
 * 沒有「按取消就當作沒發生」這回事 —— 所以產生之前要先問一次,而且問句裡要講明
 * 「舊的會立刻失效」。這一頁最容易造成的事故就是管理員隨手點一下,
 * 結果把一個正在用的人擋在門外。
 *
 * ⚠️ QR 底下**一定要保留手動輸入的金鑰**:掃不到的情況很常見(鏡頭壞了、
 * 用桌機版的密碼管理員、遠端桌面把畫面縮糊了)。
 */
import {useEffect, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import QRCode from 'qrcode';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, Layout, LayoutContent, LayoutFooter, Stack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';

import {copyText} from '../lib/clipboard';
import {issueUserMfa, type MfaEnrollment} from '../lib/adminApi';
import {errorMessage} from '../lib/errors';
import {toastError, toastInfo} from '../lib/toast';
import {AutoHeight} from './AutoHeight';
import {useDialogExit} from './useDialogExit';
import {usePinnedDialogTop} from './usePinnedDialogTop';

const styles = stylex.create({
  /**
   * 密鑰要**等寬字**:管理員或使用者是照著螢幕一個字一個字敲進手機的,
   * 比例字型下 `l` / `1`、`0` / `O` 在不同位置寬度不一,很容易看丟位置。
   *
   * ⚠️ token 名字是 `--font-family-code`,**不是 `-mono`**(那個不存在,
   * 寫錯不報錯只會靜默退回比例字型)。
   */
  mono: {
    fontFamily: 'var(--font-family-code)',
    fontSize: 'var(--text-body-size)',
    userSelect: 'all',
    wordBreak: 'break-all',
  },
  secretBox: {
    backgroundColor: 'var(--color-background-muted)',
    borderRadius: 'var(--radius-element)',
    padding: 'var(--spacing-3)',
  },
  /**
   * QR 的底**一定要是白的,而且不跟著深色模式走**。
   *
   * 掃描器認的是黑白對比;深色模式下讓它變成深底淺點,很多 App 就對不到焦
   * (有些認得反相,有些不認,而使用者只會覺得「這個系統的 QR 掃不出來」)。
   * 白底 + 一圈留白(quiet zone)是 QR 規格本來就要求的,所以這裡寫死顏色,
   * 不是偷懶 —— 這是少數不該吃佈景 token 的地方。
   */
  qrBox: {
    backgroundColor: '#ffffff',
    borderRadius: 'var(--radius-element)',
    padding: 'var(--spacing-3)',
    width: 'fit-content',
    alignSelf: 'center',
    lineHeight: 0,
  },
  qrImage: {
    /*
     * ⚠️ 這兩個裸數字是**刻意的**。
     * QR 要能被手機掃到就必須有一個實體尺寸,而 spacing token 全都是版面用的
     * 間距級距(最大 12),沒有一個代表「一張圖多大」—— 硬湊一個只會讓下一個人
     * 以為改那個 token 是安全的。200px 是掃得到的下限再往上一點。
     */
    display: 'block',
    width: 200,
    height: 200,
  },
});

type Props = {
  /** 要發給誰。`null` = 對話框關著。 */
  username: string | null;
  onOpenChange: (open: boolean) => void;
  /** 發完要讓帳號清單重抓一次(那一頁有「發過了沒」那一欄)。 */
  onIssued: () => void;
};

export function IssueMfaDialog({username, onOpenChange, onIssued}: Props) {
  // 退場(淡出 + 縮一點點)要演得完,`close()` 就得延後 —— 全站共用同一支
  const exit = useDialogExit(onOpenChange);
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  /*
   * 上緣釘住,確認頁 → QR 頁那 400 多 px 只往下長,不要有往上長的動作。
   * 置中的話 `AutoHeight` 補間時上緣會往上長一半。
   * QR 頁在矮視窗會碰到視窗底,那時上緣才讓路 —— 見 `usePinnedDialogTop`。
   */
  const pin = usePinnedDialogTop(!!username);

  /*
   * 換一個人就整個重來。密鑰是憑證,不該從上一個人的狀態殘留下來 ——
   * 那會變成「打開 B 的對話框,看到 A 的 QR」,而管理員會照著把它給 B 掃。
   */
  useEffect(() => {
    setEnrollment(null);
    setQrDataUri(null);
    setError(null);
  }, [username]);

  /*
   * 拿到密鑰就把 QR 畫出來。
   *
   * `margin: 2` 是 QR 規格要求的留白(quiet zone),少了它貼齊邊緣的碼掃不到。
   * 畫不出來時**不擋住流程** —— 底下的手動金鑰照樣在,那條路自己就走得完。
   */
  useEffect(() => {
    if (!enrollment) {
      setQrDataUri(null);
      return;
    }
    let alive = true;
    QRCode.toDataURL(enrollment.otpauth_uri, {margin: 2, width: 400})
      .then((uri) => {
        if (alive) setQrDataUri(uri);
      })
      .catch(() => {
        if (alive) setQrDataUri(null);
      });
    return () => {
      alive = false;
    };
  }, [enrollment]);

  async function issue() {
    if (!username || isBusy) return;
    setIsBusy(true);
    setError(null);
    try {
      setEnrollment(await issueUserMfa(username));
      onIssued();
    } catch (err) {
      setError(errorMessage(err, '產生失敗,請再試一次。'));
    } finally {
      setIsBusy(false);
    }
  }

  async function copy(text: string) {
    // 複製不了是失敗:紅叉、不自己消失(不要跟「已複製」共用 toastInfo,那會畫成綠勾、5 秒就不見)
    if (await copyText(text)) toastInfo('已複製。');
    else toastError('複製不了,請直接選取文字。');
  }

  return (
    <Dialog
      isOpen={!!username}
      {...exit.dialogProps}
      /*
       * ⚠️ 寬度要**夾在視窗內**:寫死 460 的話,視窗比它窄的時候(手機、把瀏覽器拉窄)
       * 對話框就撐出畫面外,右邊那顆關閉鈕與底下的按鈕都按不到。`width` 收字串,直接交給 CSS 夾。
       * 32px = 左右各留一格 --spacing-4 的邊,讓對話框不會貼齊螢幕邊緣。
       */
      width="min(460px, calc(100vw - var(--spacing-8)))"
      purpose="form"
      ref={pin.ref}
      style={pin.style}
    >
      {/*
        標準的 Dialog 結構:標題列 / 內容(會捲)/ 底列(按鈕)。DialogHeader 跟內容直接疊在 Dialog 裡的話,
        標題會比內文多縮 16px,而且視窗矮時 QR 那一頁會超出 75vh 捲不到。
      */}
      <Layout
        header={
          <DialogHeader
            title={enrollment ? `${username} 的 QR code` : `幫 ${username} 產生 QR code`}
            onOpenChange={exit.dialogProps.onOpenChange}
          />
        }
        content={
          <LayoutContent>
          {/* 確認頁 → QR 頁差了 400 多 px:高度一次補完,不要一格跳(見 AutoHeight) */}
          <AutoHeight>
        {!enrollment ? (
          <VStack gap={3}>
            {/*
              ⚠️ 文案刻意只有一句,**這一句不能再省**:管理員最容易做錯的事就是對一個正在用的人
              隨手按一下重新產生,那會把他當場擋在門外,而且沒有人會通知他。
            */}
            <Text type="body">舊的 QR code 會立刻失效,他要重新掃描才能登入。</Text>
            {/*
              錯誤原因要**看得到**:StatusDot 的 label 只會變成 aria-label,畫面上只剩一顆紅點。
              Banner 的 error 自己就帶 role="alert"。
            */}
            {error ? <Banner status="error" title={error} /> : null}
          </VStack>
        ) : (
          <VStack gap={3}>
            <Text type="body">請他用驗證器 App 掃描。</Text>
            {/*
              ⚠️ **QR 的位置一拿到回應就留好**(200×200 的白底空格),畫好時只在原地淡入
              (global.css 的 `[data-qr-reveal]`)。畫好才把整格插進來的話,
              對話框在回應進來時長一次、QR 畫好時又長一次;淡入只蓋得住 QR 冒出來,蓋不住對話框長高。
              兩頁之間的高度差交給外面的 `AutoHeight` 一次補完。
            */}
            <Stack xstyle={styles.qrBox}>
              {qrDataUri ? (
                <Stack {...{'data-qr-reveal': ''}}>
                  {/*
                    `alt` 留空 + aria-hidden:報讀軟體念不出 QR,而底下那串設定金鑰
                    是同一份資料的文字版 —— 那才是不用眼睛的人真正要的東西。
                  */}
                  <img src={qrDataUri} alt="" aria-hidden {...stylex.props(styles.qrImage)} />
                </Stack>
              ) : (
                // 空白的白底留位,不放骨架:骨架是佈景色,深色時疊在這塊白底上會一閃一塊深灰。
                // 尺寸共用 `qrImage`,200 這個數字只有一份。
                <Stack xstyle={styles.qrImage} />
              )}
            </Stack>

            <Text type="body">掃不到就手動輸入:</Text>
            <VStack gap={1} xstyle={styles.secretBox}>
              <Text type="supporting" color="secondary">
                設定金鑰
              </Text>
              <Text type="body" xstyle={styles.mono}>
                {enrollment.formatted_secret}
              </Text>
              <HStack gap={2} wrap="wrap">
                <Button
                  label="複製金鑰"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copy(enrollment.secret)}
                />
                {/* 桌機版的密碼管理員(1Password、Bitwarden…)接受直接貼上這串 */}
                <Button
                  label="複製設定連結"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copy(enrollment.otpauth_uri)}
                />
              </HStack>
            </VStack>

            {/*
              ⚠️ 這句不能省:關掉之後就再也叫不出同一張 QR(密鑰不會再被回傳),
              只能重新產生一次 —— 那又會讓這一張失效。
            */}
            <Text type="supporting" color="secondary">
              關掉就看不到這張 QR 了,請先確認他掃到。
            </Text>
          </VStack>
        )}
          </AutoHeight>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              {!enrollment ? (
                <>
                  <Button label="取消" variant="ghost" onClick={exit.requestClose} />
                  <Button
                    label="產生 QR code"
                    variant="primary"
                    isLoading={isBusy}
                    onClick={() => void issue()}
                  />
                </>
              ) : (
                <Button label="他掃好了,關閉" variant="primary" onClick={exit.requestClose} />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
