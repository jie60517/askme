/**
 * SSH Server 的選連線畫面。同一張畫面,四種樣子:
 *
 * | mode | 什麼時候 | 畫面 |
 * |---|---|---|
 * | `map` | 進 `/ssh`、或按「＋」開新連線 | 每一台一張卡片,點了才連 |
 * | `connecting` | 正在連 | 那一張右邊轉 Spinner,其他卡片變淡、不能點 |
 * | `connected` | 剛連上 | 那一張換成綠點,停一下 → `onSettled` → 頁面換成終端機 |
 * | `lock` | 閒置 3 分鐘的**螢幕保護** | **連線沒有斷**:還連著的卡片是綠點,其他變淡、不能點;點亮的那張就回到終端機 |
 *
 * ⚠️ `lock` **不是斷線**:點還連著的那一台是回到原本那條連線,不會重新連。
 *
 * 版面**照 Astryx 的 Card Grid 頁面範本(`npx astryx template library`)**,只換內容,
 * 不要另外做花俏的選單:
 * - 一區:`Divider` + `Heading level 2`(「主機」)+ `Grid`(範本的 LibrarySection;範本 minWidth 320,這裡是 `CARD_MIN_PX`,理由在那個常數)。
 * - 每一張:範本的 LibraryCard —— 上面 16:9 縮圖、底下 `Section padding={4}` + `Heading level 3`;
 *   整張可點照 `ClickableCardElevated` 用 `elevation="med"`。範本那行 secondary 說明不放。
 * - 縮圖是 logo(放法見 README「SSH 終端機」一節);沒有圖就顯示名稱的首字。
 *   **logo 照原圖白底,不鋪顏色**(不加品牌色的淡底;灰底頁面、卡片 `elevation="med"` 浮著、區塊上方有 Divider)。
 * - 狀態那行英文(Connecting to… / Connected to… / Idle)**只給報讀程式**,畫面上只有 Spinner / 綠點。
 */
import {useEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Avatar} from '@astryxdesign/core/Avatar';
import {Center} from '@astryxdesign/core/Center';
import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {Divider} from '@astryxdesign/core/Divider';
import {Grid} from '@astryxdesign/core/Grid';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Section} from '@astryxdesign/core/Section';
import {Spinner} from '@astryxdesign/core/Spinner';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Heading, Text} from '@astryxdesign/core/Text';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';

import {useMediaQuery} from '../../lib/media';
import type {TerminalHost} from '../../lib/terminalApi';

export type HostStageMode = 'map' | 'connecting' | 'connected' | 'lock';

/** 連上之後綠點停多久才換成終端機(ms)—— 一閃就切的話看不出「連上了」。減少動態時不等 */
const SETTLE_MS = 600;
/**
 * 卡片最窄多寬(px)與一排最多幾張。範本是 `minWidth 320`,但它是整頁寬(1440 → 一排四張);我們這一塊扣掉側邊欄
 * (預設 305)、頁面與捲動區的內距,1440 寬時只剩約 1000,照 320 只排得下三張。200 + 最多 4 欄:1280 寬以上都是一排四張;1920 寬也不會排成六欄(四張卡只佔三分之二)。
 */
const CARD_MIN_PX = 200;
const CARD_MAX_COLUMNS = 4;

const styles = stylex.create({
  /** 範本的 LayoutContent padding={6};主機一多就在這一塊裡捲 */
  scroll: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: 'var(--spacing-6)',
    backgroundColor: 'var(--color-background-body)',
    borderRadius: 'var(--radius-container)',
  },
  /** 範本的 thumbnailWrapper:16:9、裁掉超出的部分 */
  thumb: {
    position: 'relative',
    aspectRatio: '16 / 9',
    overflow: 'clip',
    flexShrink: 0,
    backgroundColor: 'var(--color-background-muted)',
  },
  /** 範本的 thumbnailImage:鋪滿(logo 圖本身已經是 16:9、置中留白) */
  thumbImage: {position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'},
});

type Props = {
  mode: HostStageMode;
  /**
   * 上次連過的那一台。空字串 = 沒有紀錄。只影響**選主機**的畫面:焦點一開始在它那張卡片
   * (按 Enter 就連它),aria-label 多一句「上次連的」。螢幕保護那張不吃這個 —— 那時該點的是還連著的那台。
   */
  lastHostId?: string;
  hosts: TerminalHost[];
  /** 正在連 / 已連上的那一台(connecting / connected 時要標出來) */
  targetId?: string;
  /** 螢幕保護時**還連著**的那幾台;其他變淡、不可點 */
  liveIds?: readonly string[];
  /** 點了一台主機。`lock` 時意思是「回到那條連線」,其餘是「連這一台」 */
  onPick: (hostId: string) => void;
  /** connected 停完那一下(只有 connected 會叫) */
  onSettled?: () => void;
  /**
   * 要「長成」方框的那一張(見 `pages/Terminal.tsx` 的 `morph`)。
   * 只有這一張的外框與 logo 帶 View Transition 的名字 —— 名字一頁只能有一個,全部都帶會整個過場失效。
   */
  morphId?: string;
};

/** 卡片上方的 logo。圖載不到(那台沒有放 logo)就退回名稱第一個字的頭像 */
function HostLogo({host, isMorphing}: {host: TerminalHost; isMorphing: boolean}) {
  const [failed, setFailed] = useState(false);
  return (
    <Stack xstyle={styles.thumb} style={isMorphing ? {viewTransitionName: 'host-logo'} : undefined}>
      {failed ? (
        <Center axis="both" height="100%">
          {/* 只給第一個字:Avatar 會取每個詞的字首,「App Server」會變成「AS」 */}
          <Avatar name={Array.from(host.label)[0] ?? '?'} size={64} tooltip={false} />
        </Center>
      ) : (
        <img
          src={`/host-logos/${encodeURIComponent(host.id)}.jpg`}
          alt=""
          {...stylex.props(styles.thumbImage)}
          onError={() => setFailed(true)}
        />
      )}
    </Stack>
  );
}

/**
 * 一張卡片在這個樣態下的樣子 —— **能不能點、狀態要畫什麼,只在這裡判一次**,
 * 不要讓同一組條件散在好幾處。
 */
type CardState = {
  /** 點得下去(選主機時全部;螢幕保護只有還連著的;連線中一台都不行,免得連到一半又戳一台) */
  pickable: boolean;
  /** 變淡:連線中的其他卡片、螢幕保護時沒連著的。連線中的那一張不淡(它只是不能再點) */
  faded: boolean;
  badge: 'spinner' | 'live' | null;
};

function cardState(host: TerminalHost, mode: HostStageMode, targetId: string | undefined, live: ReadonlySet<string>): CardState {
  const isTarget = host.id === targetId;
  switch (mode) {
    case 'map':
      return {pickable: true, faded: false, badge: null};
    case 'lock':
      return live.has(host.id)
        ? {pickable: true, faded: false, badge: 'live'}
        : {pickable: false, faded: true, badge: null};
    case 'connecting':
      return {pickable: false, faded: !isTarget, badge: isTarget ? 'spinner' : null};
    case 'connected':
      return {pickable: false, faded: !isTarget, badge: isTarget ? 'live' : null};
  }
}

export function HostStage({mode, lastHostId = '', hosts, targetId, liveIds = [], onPick, onSettled, morphId}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const live = new Set(liveIds);

  // 連上了:綠點停一下再交棒(減少動態時不等)
  useEffect(() => {
    if (mode !== 'connected') return;
    const t = window.setTimeout(() => settledRef.current?.(), reduceMotion ? 0 : SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [mode, reduceMotion]);

  /**
   * 「上次那台」的初始焦點。只搶**一次**。
   * ⚠️ 頁籤一開始可能是藏著的(`hidden`,那時 focus() 是 no-op):用 ResizeObserver 等這一塊**有尺寸了**
   * (= 看得到了)再補,不是掛上去那一刻試一次就算了。
   * 卡片用 `data-host-id` 找(不用報讀名稱 —— 兩台同名同副標就會找錯);ClickableCard 的焦點在它裡面那顆隱形 button / a 上。
   *
   * 連線中(`TerminalSession` 重新掛一份)則是把那張捲進畫面:捲到下面才點的話,轉圈那張不能在畫面外。
   */
  const focusedOnce = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const wanted = mode === 'map' ? lastHostId : mode === 'connecting' ? targetId : '';
    if (!wanted) return;
    const tryNow = () => {
      if (focusedOnce.current || !root.offsetParent) return;
      const card = root.querySelector<HTMLElement>(`[data-host-id="${CSS.escape(wanted)}"]`);
      if (!card) return;
      focusedOnce.current = true;
      if (mode === 'map') card.querySelector<HTMLElement>('button, a')?.focus({preventScroll: false});
      else card.scrollIntoView({block: 'nearest'});
    };
    tryNow();
    const ro = new ResizeObserver(tryNow);
    ro.observe(root);
    return () => ro.disconnect();
  }, [mode, lastHostId, targetId]);

  const card = (host: TerminalHost) => {
    const state = cardState(host, mode, targetId, live);
    return (
      // data-host-id:找初始焦點 / 捲進畫面用(見上面那支 effect)
      <Stack
        key={host.id}
        {...{'data-host-id': host.id}}
        style={host.id === morphId ? {viewTransitionName: 'host-card'} : undefined}
      >
        <ClickableCard
          label={cardLabel(host, mode, lastHostId)}
          onClick={state.pickable ? () => onPick(host.id) : undefined}
          isDisabled={state.faded}
          padding={0}
          elevation="med"
        >
          <HostLogo host={host} isMorphing={host.id === morphId} />
          <Section variant="transparent" padding={4}>
            <HStack gap={3} vAlign="center">
              <StackItem size="fill">
                <Heading level={3}>{host.label}</Heading>
              </StackItem>
              {state.badge === 'spinner' ? <Spinner size="sm" /> : null}
              {state.badge === 'live' ? <StatusDot variant="success" label="連線中" /> : null}
            </HStack>
          </Section>
        </ClickableCard>
      </Stack>
    );
  };

  const target = hosts.find((h) => h.id === targetId);
  /**
   * 報讀用的狀態(畫面上不顯示)。⚠️ 閒置中 / 連線中這幾句刻意用**英文**,
   * 雖然 /ssh 其他內容是中文。
   * ⚠️ 掛上去之後才寫進去:有些報讀程式不唸「一出現就帶著字」的 live region(連線中那一份是新掛上去的)。
   */
  const statusText =
    mode === 'connecting'
      ? `Connecting to ${target?.label ?? 'host'}…`
      : mode === 'connected'
        ? `Connected to ${target?.label ?? 'host'}`
        : mode === 'lock'
          ? 'Idle'
          : '';
  const [announced, setAnnounced] = useState('');
  useEffect(() => setAnnounced(statusText), [statusText]);

  return (
    <Stack ref={rootRef} xstyle={styles.scroll}>
      <VStack gap={6}>
        <Divider />
        <VStack gap={6}>
          <Heading level={2}>主機</Heading>
          <Grid columns={{minWidth: CARD_MIN_PX, max: CARD_MAX_COLUMNS}} gap={4}>
            {hosts.map(card)}
          </Grid>
        </VStack>
      </VStack>
      <VisuallyHidden>
        <Text role="status">{announced}</Text>
      </VisuallyHidden>
    </Stack>
  );
}

/** 卡片的報讀名稱。副標與「上次連的」只留在這裡,畫面上不寫(找初始焦點用的是 `data-host-id`,不是這個) */
function cardLabel(host: TerminalHost, mode: HostStageMode, lastHostId: string): string {
  if (mode === 'lock') return `回到 ${host.label} 的連線`;
  const last = mode === 'map' && host.id === lastHostId ? '(上次連的)' : '';
  return `連線到 ${host.label}${host.sub ? `(${host.sub})` : ''}${last}`;
}
