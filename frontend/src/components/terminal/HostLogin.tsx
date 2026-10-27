/**
 * 點主機卡片之後「長成」的**方框**(連主機也有跟登入一樣的過渡)。
 *
 * 版面**照 `pages/Login.tsx`(Astryx login-split 範本)**:卡片 → Grid 兩欄 → 左邊 Section 表單、右邊 3:4 的圖
 * (這裡是那台的 logo)。窄的時候兩欄併成一欄、圖跑到上面(同一條容器查詢)。
 * logo 的放法見 README「SSH 終端機」一節;沒有圖(或缺其中一張)就顯示名稱的首字。
 * 標題底下**不放說明那一行**。
 *
 * 點了就開始連。方框裡放三格**唯讀**欄位(主機 / 帳號 / 密碼點點,不然只有一顆按鈕太空),
 * 內容是主機清單本來就有的副標(`app-server · deploy`),不多送任何位址或密碼。
 * 連上那一下按鈕變成打勾(`isConnected`),停一下才長滿視窗、暗成終端機(見 `TerminalSession` 的 `SUCCESS_BEAT_MS`)。
 *
 * 「長成」靠瀏覽器的 View Transitions:這張卡片與主機卡片共用 `host-card` 這個名字、右邊的圖與卡片上的 logo 共用
 * `host-logo`(見 `pages/Terminal.tsx` 的 `morph`)。
 */
import {useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Avatar} from '@astryxdesign/core/Avatar';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Center} from '@astryxdesign/core/Center';
import {Grid} from '@astryxdesign/core/Grid';
import {Icon} from '@astryxdesign/core/Icon';
import {Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Section} from '@astryxdesign/core/Section';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Check} from 'lucide-react';

import type {TerminalHost} from '../../lib/terminalApi';

/** 跟登入頁同一組幾何(`pages/Login.tsx` 的 COLUMN_MIN_WIDTH / CARD_MAX_WIDTH / SPLIT_QUERY,理由寫在那邊) */
const COLUMN_MIN_WIDTH = 240;
const CARD_MAX_WIDTH = 1000;
const SPLIT_QUERY = '@container host-login (max-width: 511px)';
/** 表單那一欄的最小高度(同 `pages/Login.tsx` 的 FORM_STAGE_MIN_HEIGHT):欄位少的時候按鈕不會貼著標題 */
const FORM_STAGE_MIN_HEIGHT = 280;

const styles = stylex.create({
  /*
   * 主機名那行 display-1 大標收一點字距(同 `ErrorBoundary` 的 `title`):
   * 設計系統給的是 0,那個字級下英文字母之間看起來是散的。用 `em` 才會跟著字級走。
   */
  title: {letterSpacing: '-0.02em'},
  /** 這一塊可以捲(可用高度矮的時候,方框整張還是拿得到) */
  scroll: {flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: 'var(--spacing-6)'},
  cardWrap: {
    width: '100%',
    maxWidth: CARD_MAX_WIDTH,
    marginInline: 'auto',
    containerType: 'inline-size',
    containerName: 'host-login',
  },
  splitGrid: {padding: {default: 'var(--spacing-8)', [SPLIT_QUERY]: 'var(--spacing-4)'}},
  formStage: {minHeight: FORM_STAGE_MIN_HEIGHT},
  /** 範本的 3:4 圖格;併成一欄時排到上面、變矮(圖只是 logo,不用佔一整個手機畫面) */
  splitImage: {
    position: 'relative',
    width: '100%',
    alignSelf: 'start',
    aspectRatio: {default: '3 / 4', [SPLIT_QUERY]: '16 / 9'},
    order: {default: 0, [SPLIT_QUERY]: -1},
    overflow: 'clip',
    borderRadius: 'var(--radius-container)',
    backgroundColor: 'var(--color-background-muted)',
  },
  cover: {position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'},
  /**
   * 直的(3:4)與橫的(16:9)兩張都掛著、看寬度只露一張:併成一欄時圖格變 16:9,
   * 拿直的那張去裁會切掉 logo 的上下。
   */
  onlyWide: {display: {default: 'block', [SPLIT_QUERY]: 'none'}},
  onlyNarrow: {display: {default: 'none', [SPLIT_QUERY]: 'block'}},
});

type Props = {
  host: TerminalHost;
  /** false = 正在連(按鈕轉圈);true = 連上了(按鈕變成打勾,接著整塊長成終端機) */
  isConnected: boolean;
  /**
   * 帶 View Transition 的名字(`host-card` / `host-logo`)。只有作用中那一塊給 true:並排時兩塊同時停在方框上,
   * 同名兩個會讓瀏覽器整個跳過過場(`morph.ts` 的 ⚠️)。
   */
  isMorphTarget?: boolean;
};

export function HostLogin({host, isConnected, isMorphTarget = true}: Props) {
  const [logoFailed, setLogoFailed] = useState(false);
  // 三格唯讀欄位的內容:主機清單的副標「app-server · deploy」(沒有就空著)
  const [subHost = '', subUser = ''] = host.sub.split('·').map((x) => x.trim());
  const readOnly = (label: string, value: string, secret = false) => (
    <TextInput
      key={label}
      label={label}
      isLabelHidden
      placeholder={label}
      type={secret ? 'password' : 'text'}
      value={value}
      onChange={() => {}}
      size="lg"
      isDisabled
    />
  );

  return (
    <Stack xstyle={styles.scroll}>
      <Center axis="both" height="100%">
        <Stack xstyle={styles.cardWrap} style={isMorphTarget ? {viewTransitionName: 'host-card'} : undefined}>
          <Card padding={0} width="100%">
            <Grid columns={{minWidth: COLUMN_MIN_WIDTH, repeat: 'fit'}} gap={8} align="stretch" xstyle={styles.splitGrid}>
              <Section variant="transparent" padding={0} height="100%">
                <VStack gap={4} height="100%">
                  <Text type="body" weight="bold">
                    SSH Server
                  </Text>
                  <StackItem size="fill">
                    <Center axis="vertical" height="100%">
                      <VStack gap={4} hAlign="stretch" width="100%" xstyle={styles.formStage}>
                        <Text type="display-1" as="h1" xstyle={styles.title}>
                          {host.label}
                        </Text>
                        <VStack gap={2}>
                          {readOnly('主機', subHost)}
                          {readOnly('帳號', subUser)}
                          {/* 只是填滿方框的樣子:真的密碼在伺服器上,這裡是固定的假字 */}
                          {readOnly('密碼', 'xxxxxxxxxx', true)}
                        </VStack>
                        {isConnected ? (
                          <Button label="已連線" variant="primary" size="lg" icon={<Icon icon={Check} size="sm" />} />
                        ) : (
                          <Button label="連線" variant="primary" size="lg" isLoading />
                        )}
                      </VStack>
                    </Center>
                  </StackItem>
                </VStack>
              </Section>
              <Stack xstyle={styles.splitImage} style={isMorphTarget ? {viewTransitionName: 'host-logo'} : undefined}>
                {logoFailed ? (
                  <Center axis="both" height="100%">
                    <Avatar name={Array.from(host.label)[0] ?? '?'} size={96} tooltip={false} />
                  </Center>
                ) : (
                  <>
                    <img
                      src={`/host-logos/${encodeURIComponent(host.id)}-tall.jpg`}
                      alt=""
                      {...stylex.props(styles.cover, styles.onlyWide)}
                      onError={() => setLogoFailed(true)}
                    />
                    {/* 橫的這張也要接 onError,不然只缺橫圖的話窄版會露出一張破圖。
                        兩張不管哪張露出來都會下載,所以缺一張就整組退回字母頭像 ——
                        logo 是成對放的,缺一張本來就是「這台還沒放好」。 */}
                    <img
                      src={`/host-logos/${encodeURIComponent(host.id)}.jpg`}
                      alt=""
                      {...stylex.props(styles.cover, styles.onlyNarrow)}
                      onError={() => setLogoFailed(true)}
                    />
                  </>
                )}
              </Stack>
            </Grid>
          </Card>
        </Stack>
      </Center>
    </Stack>
  );
}
