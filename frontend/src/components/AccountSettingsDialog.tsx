/**
 * 個人設定。
 *
 * 版面照設計系統 **0.7.8 的 settings-dialog** 範本:左欄 `SideNav`(標題、搜尋、分組),右邊是那一區;
 * 每組設定包在灰底卡片裡,一列一個設定(圖示 + 名稱 + 右邊控制項,見 `settingsRows.tsx`)。
 * 跟範本不同的:**沒有說明文字**(要極簡)、
 * 圖示用 Lucide、深淺色只有兩張卡、頭像改 / 刪仍是滑過才出現。
 * 手機寬(`MOBILE_QUERY`)換成範本的窄版:頂上一排只有圖示的分頁。
 *
 * ⚠️ **側邊欄的名字、Change password、Dark mode 三列收進這裡**:
 * 側邊欄只留名字那一列當入口(兩個入口開同一個東西是重複的)。
 * 改密碼在 Account 裡就地展開(範本的 ExpandableRow),深淺色在 Appearance。
 *
 * ⚠️ **沒有底列的 Reset / Done 了**(範本沒有底列):每一項改了就生效。頭像按 OK 就存,
 * 密碼按 Save;字級與對比照舊在關掉時送伺服器(見底下那支卸載 effect),Reset 搬進 Appearance。
 *
 * ⚠️ **每一區一直掛著,換區只是藏起來**(`display: none`,不是 `hidden` 屬性 —— 見 `body`)。拉桿的拇指位置住在 `PercentSlider`
 * 自己身上、而且拖曳時刻意不回寫對話框的 state —— 換區時卸載的話,回來會看到
 * 打開時的舊位置。打到一半的密碼也一樣留著。
 *
 * ⚠️ **這個對話框的字是英文**,跟全站慣例一致(`frontend/.claude/CLAUDE.md`)。
 * 那條「內容用繁中」的例外只涵蓋管理頁(/stats、/security、/users),
 * 不含這裡 —— 這一頁刻意用英文。
 *
 * ⚠️ **拉桿即時套到畫面上,但這塊面板自己不跟著變**
 * (調 Text size 跟 Contrast 時背景要看得到變動,只有 Settings 這塊先不動)。做法見 `pinnedTokens`。
 *
 * ⚠️ **不要用 `zoom` / `transform` 把面板縮回去。** 試過,不成立:
 * 設計系統的 `--spacing-*` 是寫死的 **px**,只有字級與圓角是 `rem` ——
 * 實測這個對話框 508px 高裡只有 60px 會跟著字級走(100% → 200% 是 508 → 568)。
 * 它不是等比例放大,照字級比例縮的結果是被壓成 284px。
 */
import {Suspense, useEffect, useId, useMemo, useRef, useState} from 'react';

import * as stylex from '@stylexjs/stylex';

import {AspectRatio} from '@astryxdesign/core/AspectRatio';
import {Avatar} from '@astryxdesign/core/Avatar';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Stack} from '@astryxdesign/core/Stack';
import {Dialog} from '@astryxdesign/core/Dialog';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack, Layout, LayoutContent, StackItem, VStack} from '@astryxdesign/core/Layout';
import {ListItem} from '@astryxdesign/core/List';
import {SelectableCard} from '@astryxdesign/core/SelectableCard';
import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {Slider} from '@astryxdesign/core/Slider';
import {Switch} from '@astryxdesign/core/Switch';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Theme} from '@astryxdesign/core/theme';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';

import {
  avatarCropToDataUri,
  AvatarImageError,
  defaultCrop,
  loadAvatarSource,
  type AvatarCrop,
  type AvatarSource,
} from '../lib/avatarImage';
import {getAllowedModels, peekAllowedModels} from '../lib/chatApi';
import {
  COMPANION_LABELS,
  COMPANIONS,
  isCompanion,
  setCompanion,
  setCompanionVisible,
  useCompanion,
  useCompanionVisible,
} from '../lib/companionPref';
import {
  CONTRAST_DEFAULT,
  FONT_SCALE_DEFAULT,
  getDisplayPrefs,
  persistDisplayPrefs,
  pinnedRemTokens,
  setDisplayPrefs,
  SLIDER_POSITION_MAX,
  SLIDER_POSITION_MIN,
  SLIDER_POSITION_STEP,
  sliderPositionToValue,
  valueToSliderPosition,
} from '../lib/displayPrefs';
import {
  ALargeSmall,
  Bot,
  ChevronRight,
  CircleUser,
  Contrast,
  Eye,
  Keyboard,
  KeyRound,
  MessageSquare,
  Moon,
  Paintbrush,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Shapes,
  Smile,
  Sun,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import {lazyChunk} from '../lib/lazyChunk';
import {changePassword, describePasswordError} from '../lib/loginApi';
import {HOVER_QUERY, MOBILE_QUERY, useMediaQuery} from '../lib/media';
import {chooseTheme, useThemeMode} from '../lib/theme';
import {
  saveAvatar,
  saveCompanion,
  saveCompanionVisible,
  saveDisplayPrefs,
  savePreferredModel,
} from '../lib/loginApi';
import {modelLabel, setPreferredModel, usePreferredModel} from '../lib/modelPref';
import {personName} from '../lib/people';
import {toastError, toastInfo} from '../lib/toast';
import {AvatarCropper, PREVIEW_PX} from './AvatarCropper';
import {PasswordChangeFields, usePasswordChangeForm} from './PasswordChangeFields';
import {CONTROL_WIDTH, ROW_PADDING, SettingsCard, SettingsRow, settingsPanelStyle} from './settingsRows';
import {ShortcutSettings} from './ShortcutSettings';
import {SHORTCUTS} from '../lib/shortcuts';
import {useDialogExit} from './useDialogExit';
import {usePinnedDialogTop} from './usePinnedDialogTop';
import {useSliderDrag} from './useSliderDrag';

/**
 * 對話框的寬度與高度,照 0.7.8 範本(`width={1120}`、`min(800px, calc(100dvh - 2rem))`)。
 * 範本的理由:每一區同一個高度,換區時外框不會跟著長短,是區域自己捲動。
 */
const DIALOG_WIDTH = 1120;
const DIALOG_HEIGHT = 'min(800px, calc(100dvh - 2rem))';

type SectionId = 'account' | 'appearance' | 'chat' | 'companion' | 'shortcuts';

/** 左欄的分組(手機寬是頂上一排只有圖示的分頁,順序同這份)。圖示用 Lucide,挑跟範本同一個意思的 */
const SECTION_GROUPS: {label: string; sections: {id: SectionId; label: string; icon: LucideIcon}[]}[] = [
  {label: 'Account', sections: [{id: 'account', label: 'Account', icon: CircleUser}]},
  {
    label: 'Preferences',
    sections: [
      {id: 'appearance', label: 'Appearance', icon: Paintbrush},
      {id: 'chat', label: 'Chat', icon: MessageSquare},
      {id: 'companion', label: 'Companion', icon: Smile},
      // 放在 Preferences 最後(範本也是這個位置)
      {id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard},
    ],
  },
];
const SECTIONS = SECTION_GROUPS.flatMap((g) => g.sections);

/**
 * 搜尋得到的設定(範本的 SEARCHABLE_SETTINGS,只比名稱)。加一列設定要記得補這裡,
 * 不然搜不到 —— 名稱跟那一列的 `title` 一字不差。
 * 唯一的例外是 Photo:頭像那一列畫的是頭像跟名字,沒有標題字,搜「photo」要找得到它。
 */
const SEARCHABLE: {title: string; section: SectionId; icon: LucideIcon}[] = [
  {title: 'Photo', section: 'account', icon: CircleUser},
  {title: 'Password', section: 'account', icon: KeyRound},
  {title: 'Theme', section: 'appearance', icon: Paintbrush},
  {title: 'Text size', section: 'appearance', icon: ALargeSmall},
  {title: 'Contrast', section: 'appearance', icon: Contrast},
  {title: 'Reset text size and contrast', section: 'appearance', icon: RotateCcw},
  {title: 'Default model', section: 'chat', icon: Bot},
  {title: 'Show companion', section: 'companion', icon: Eye},
  {title: 'Companion', section: 'companion', icon: Smile},
  {title: 'Shape', section: 'companion', icon: Shapes},
  {title: 'Color', section: 'companion', icon: Palette},
  {title: 'Keyboard shortcuts', section: 'shortcuts', icon: Keyboard},
  // 每一個快捷鍵的名字也搜得到(名稱就是 lib/shortcuts.ts 的 SHORTCUTS,那一頁每列的標題)
  ...SHORTCUTS.map((s) => ({title: s.label, section: 'shortcuts' as const, icon: Keyboard})),
];

const sectionLabelOf = (id: SectionId) => SECTIONS.find((sec) => sec.id === id)?.label ?? 'Settings';

/*
 * 這個檔案裡「殼變高」的那一塊(裁切的 OK / Cancel `actionsRow`)走 iOS 面板曲線
 * `var(--ease-panel)`。模型那一列沒有殼(見 Chat 那一區的註解)。
 *
 * 曲線本身(與「為什麼殼不能過衝、內容才過衝」的完整理由)住在 `global.css` 的
 * `:root`:`--ease-panel` / `--ease-overshoot`(落地頁的分類籤也用)。**時長仍然是這個檔案的字面值**
 * (420 / 320 / 260 / 80ms,刻意的字面值)。
 */

/**
 * Companion 底下的預覽台 + Bloub 的型態 / 顏色。
 * ⚠️ **分包**:它拉進了 bloub 引擎,靜態 import 的話引擎會被打進主程式(見那個檔案開頭)。
 * ⚠️ 走 `lazyChunk` 不是原生 `lazy`:上版後舊分頁去抓舊檔名會 404,原生 lazy 直接白畫面
 *    (理由見 `lib/lazyChunk.ts`)。
 * ⚠️ **閒下來就先載**:不預載的話第一次打開設定時這塊(144px 預覽台 + 兩列)會在對話框
 *    開好之後才一格撐出來,對話框會跳一下。這支檔案是 App 靜態 import 的,
 *    所以模組一載入就排一個 idle 預載;沒有 requestIdleCallback 的瀏覽器(Safari)退回 setTimeout。
 */
const loadCompanionLook = () => import('./CompanionLook');
const CompanionLook = lazyChunk(loadCompanionLook);
if (typeof window !== 'undefined') {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
  idle(() => void loadCompanionLook().catch(() => {}));
}

/** 頭貼 ↔ 裁切圈互換時的淡入。幾何已經完全對齊,只差把兩個狀態接起來。 */
const fadeIn = stylex.keyframes({from: {opacity: 0}, to: {opacity: 1}});

const styles = stylex.create({
  /*
   * ⚠️ **只淡入,不要加位移或縮放。** 這兩個狀態的圓圈是**同一個尺寸、同一個位置**
   * (128px,見 `AvatarCropper` 的 `PREVIEW_PX`),
   * 再加位移的話切換時圓圈會震一下。
   */
  photoStage: {
    /*
     * ⚠️ **`prefers-reduced-motion` 下不要關掉它**:
     * 標準講的是「更少、更溫和,不是零 —— 留下有助理解的過場,拿掉位移」。
     * 這段只有 opacity、沒有位移也沒有縮放,關掉等於把「這兩個狀態是同一個東西」
     * 這個訊息一起關掉。
     */
    animationName: fadeIn,
    animationDuration: 'var(--duration-fast)',
    animationTimingFunction: 'var(--ease-standard)',
  },
  /**
   * 頭像那一格:浮層靠它定位。
   *
   * ⚠️ **尺寸不在這裡** —— 它由 `PREVIEW_PX` 用 inline style 帶進去(見用到的地方)。
   * 兩邊必須是同一個數字,不同的話挑完照片那一瞬間頭貼會突然變大。
   * ⚠️ **不能寫成 `width: `${PREVIEW_PX}px`` 放在這裡**:StyleX 的 `create()` 只吃
   * 字面值與同檔案的常數,看到 import 進來的識別字會把它當成 theme 檔去解析,
   * 然後整個檔案編譯失敗(「Could not resolve the path to the imported file」)。
   * 這是實際撞到才知道的,不要「順手」搬回來。
   */
  avatarSlot: {
    position: 'relative',
    borderRadius: '50%',
  },
  /*
   * 滑到頭像上才出現的那組控制項(沒有 Add photo 鈕:滑鼠
   * 一到頭像才出現 + / 修改 / 刪除)。
   *
   * ⚠️ **只動 opacity,不動位移或縮放** —— 所以不必配 `prefers-reduced-motion`
   * (跟 global.css 底下那段同一條理由)。
   * ⚠️ `pointerEvents` 要跟著切:留 `auto` 的話看不見的按鈕照樣擋住底下的頭像。
   */
  avatarOverlay: {
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-overlay)',
    opacity: 0,
    pointerEvents: 'none',
    transition: 'opacity var(--duration-fast) var(--ease-standard)',
  },
  avatarOverlayShown: {opacity: 1, pointerEvents: 'auto'},
  /*
   * 裁切時的 OK / Cancel:**從頭貼底下長出來**,而且對話框跟著慢慢變高
   * (不預留空間;要像 iPhone 動態島一樣滑順)。
   *
   * ⚠️ 這裡**刻意 animate 了版面屬性**(`grid-template-rows`),違反「只動 transform
   * 與 opacity」那條通則 —— 因為要的就是「容器真的變高」,而那件事沒辦法用
   * transform 假裝(假裝的話底下三列會被蓋住而不是被推開)。`0fr → 1fr` 是這件事
   * 的標準做法,一次只跑一個元素、而且是使用者自己按出來的,代價付得起。
   *
   * ⚠️ `overflow: hidden` 要掛在**裡面那一層**(`actionsClip`),不能掛在 grid 上 ——
   * grid 自己要能量到內容的完整高度,`1fr` 才知道要長到多高。
   *
   * ── 為什麼曲線是自己寫的 cubic-bezier,而不是 `--ease-standard` ──
   *
   * 佈景只有**一條** easing token,而動態島那種手感需要兩條不同性格的曲線:
   *  - **殼**(高度)用 `cubic-bezier(0.32, 0.72, 0, 1)`:起步快、尾巴長長地收住,
   *    這是 iOS 面板那條味道。⚠️ 它**不能**過衝 —— `grid-template-rows` 的 `fr`
   *    超過 1 之後會被內容高度夾住,過衝等於「卡在頂點」,反而更僵。
   *  - **內容**(兩顆鈕)用 `cubic-bezier(0.34, 1.56, 0.64, 1)`:**會過衝**,
   *    那一下輕微的回彈就是「活的」的來源。它安全,因為動的是 `scale`,不是版面。
   *
   * ⚠️ **內容比殼晚 80ms 起跑**(曾寫 90,實際值一直是 80)。動態島的關鍵順序是「殼先開、東西才落定」——
   * 一起跑的話看起來就只是一塊東西整個變大。
   * ⚠️ `scale` 的**起點要明寫**(`0.94` / `1`),起始值是 `none` 的話補間建不起來。
   * ⚠️ 收合不留戀:165ms、沒有過衝、沒有延遲 —— 那是系統回應。
   */
  actionsRow: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transition: {
      default: 'grid-template-rows var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  actionsRowOpen: {
    gridTemplateRows: '1fr',
    transition: {
      default: 'grid-template-rows 420ms var(--ease-panel)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  actionsClip: {overflow: 'hidden', minHeight: 0},
  /** 兩顆鈕自己再淡入 + 輕微回彈 —— 讓它們看起來是「落定」而不是「被切出來」。 */
  actionsFade: {
    opacity: 0,
    /*
     * ⚠️ reduce 下把 `scale` 直接設成 1(不是留著不動):
     * 縮放是「位移類」的動作,標準要求拿掉 —— 但**淡入要留著**,
     * 它是有助理解的那一半(見下面 `transition` 的分寫)。
     */
    scale: {default: '0.94', '@media (prefers-reduced-motion: reduce)': '1'},
    transition: {
      default:
        'opacity var(--duration-fast) var(--ease-standard), scale var(--duration-fast) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'opacity var(--duration-fast) var(--ease-standard)',
    },
  },
  actionsFadeShown: {
    opacity: 1,
    scale: '1',
    /*
     * ⚠️ 延遲是 **80ms 不是 90ms**:STANDARDS 的 Stagger 明寫 30–80ms、
     * 「longer delays feel slow」。80 與 90 的手感差別是零,沒有理由踩線。
     */
    transition: {
      default:
        'opacity 260ms 80ms var(--ease-standard), scale 320ms 80ms var(--ease-overshoot)',
      '@media (prefers-reduced-motion: reduce)': 'opacity var(--duration-fast) var(--ease-standard)',
    },
  },
  /*
   * 頭像底下那兩顆鈕:**等寬,但只有內容那麼寬**,整組置中。
   *
   * 兩個要求同時成立才對,另外兩種寫法都不行:
   *  1. 各給一個固定 `rem` 寬:字級 200% 時兩顆 544px,凸出 440px 的對話框;
   *  2. 平分整列(`flexGrow: 1`):不會溢出了,但一顆 200px、「Add photo」獨自一顆時
   *     整整 408px,太大了。
   *
   * 現在用 grid 的老招:`grid-auto-columns: 1fr` 讓每一欄一樣寬,而整個 grid
   * `width: fit-content` —— 於是欄寬 = **最寬那顆的內容寬**。頭像靠左,
   * 這組也跟著靠左(不用 `margin-inline: auto` 置中)。字變大時它跟著長,但上限是 `max-width: 100%`,溢不出去。
   * ⚠️ `display: grid` 是**覆寫 HStack 的 flex**,所以 gap 也要自己下
   * (HStack 的 `gap` prop 在 grid 上不生效)。
   */
  photoActions: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: '1fr',
    columnGap: 'var(--spacing-2)',
    width: 'fit-content',
    maxWidth: '100%',
  },
  photoAction: {minWidth: 0},
  /* ── 以下照 0.7.8 settings-dialog 範本(範本的註解:這幾件沒有 Astryx prop) ── */
  /** SideNav 自己沒有 flex-shrink,換區時左欄會被右邊擠窄 */
  sideNav: {flexShrink: 0},
  /** 兩組之間的距離(SideNav / SideNavSection 都沒有 gap) */
  sideNavSection: {paddingBlock: 'var(--spacing-2)'},
  /** 右上角的關閉鈕:釘著、不佔一列,捲動時一直在角落 */
  closeAnchor: {position: 'sticky', insetBlockStart: 0, zIndex: 1, height: 0},
  /** 關閉鈕底下墊一塊不透明的,捲過去的內容不會從鈕底下透出來 */
  closeBacking: {
    display: 'flex',
    backgroundColor: 'var(--color-background-surface)',
    borderRadius: 'var(--radius-element)',
  },
  /** 沒選到的那幾區(一直掛著,只是不畫;為什麼不用 `hidden` 屬性見 `body`) */
  sectionHidden: {display: 'none'},
  /**
   * 「Settings」標題:打開時程式把焦點放在它上面(見 `titleId` 那支 effect),但它不是能操作的東西,不畫焦點框。
   * 照 Astryx `DialogHeader` 的 `titleFocusable`(它的標題也是 tabIndex=-1 + 打開時聚焦 + outline none)。
   * 不加的話滑鼠點開也會在標題外畫一圈框:Chrome 把程式聚焦到 tabIndex=-1 的元素算成 :focus-visible。
   */
  titleFocusable: {outline: 'none'},
});

/** 深淺色預覽小卡裡那張迷你畫面(範本的 ThemePreviewCanvas) */
const preview = stylex.create({
  /** 一條「字」。Astryx 沒有這個尺度的佔位元件(Skeleton 會動) */
  bar: {height: 4, width: '50%', borderRadius: 'var(--radius-full)', backgroundColor: 'var(--color-border-emphasized)'},
  barWide: {width: '66%'},
  clip: {overflow: 'hidden', borderRadius: 'var(--radius-element)'},
  mutedSurface: {backgroundColor: 'var(--color-background-muted)'},
  contentSurface: {backgroundColor: 'var(--color-background-surface)'},
  inert: {pointerEvents: 'none'},
});

/** `Theme` 在這一小塊重新宣告 token,所以淺色那張在深色模式裡仍是淺的(範本) */
function ThemePreview({mode}: {mode: 'light' | 'dark'}) {
  return (
    <AspectRatio ratio={3 / 2} xstyle={preview.inert}>
      <VStack aria-hidden="true" height="100%" xstyle={preview.clip}>
        <Theme theme={neutralTheme} mode={mode}>
          <VStack padding={2} gap={1.5} height="100%" xstyle={preview.mutedSurface}>
            <VStack gap={1} align="center">
              <VStack xstyle={[preview.bar, preview.barWide]} />
              <VStack xstyle={preview.bar} />
            </VStack>
            <StackItem size="fill">
              <VStack padding={2} gap={1} justify="center" height="100%" xstyle={preview.contentSurface}>
                {[0, 1, 2].map((i) => (
                  <VStack key={i} xstyle={preview.bar} />
                ))}
              </VStack>
            </StackItem>
          </VStack>
        </Theme>
      </VStack>
    </AspectRatio>
  );
}

const THEME_CHOICES = [
  {value: 'light', label: 'Light', icon: Sun},
  {value: 'dark', label: 'Dark', icon: Moon},
] as const;

/**
 * 深淺色:兩張預覽小卡(範本的 ThemeChoiceCards;我們沒有「跟系統」)。
 * ⚠️ `SelectableCard` 底下是 checkbox,所以只選不取消(再點已選的那張什麼都不做)。
 */
function ThemeChoiceCards({value, onChange}: {value: string; onChange: (v: 'light' | 'dark') => void}) {
  return (
    <Grid role="radiogroup" aria-label="Theme" columns={{minWidth: 96, max: 3}}
      /* ⚠️ max 3 不是寫錯:只有兩張卡,但照範本切三欄才是範本的卡片大小(改 2 會各自撐成 236px) */ gap={2} maxWidth={480}>
      {THEME_CHOICES.map((c) => {
        const isSelected = c.value === value;
        return (
          <SelectableCard
            key={c.value}
            label={c.label}
            isSelected={isSelected}
            padding={2}
            onChange={() => {
              if (!isSelected) onChange(c.value);
            }}
          >
            <VStack gap={1.5}>
              <ThemePreview mode={c.value} />
              <HStack gap={1} align="center" justify="center">
                <Icon icon={c.icon} size="sm" color="secondary" />
                <Text type="supporting" weight={isSelected ? 'semibold' : undefined}>
                  {c.label}
                </Text>
              </HStack>
            </VStack>
          </SelectableCard>
        );
      })}
    </Grid>
  );
}

/**
 * 左上角(手機寬是頂上)的搜尋框:打字之後左欄換成找到的設定(範本的 useSettingsSearch)。
 * 鍵盤:上下鍵選、Enter 跳過去;**Esc 先清空搜尋字**,第二下才關對話框 ——
 * 不攔的話 Esc 直接走到 Dialog,打到一半的搜尋跟整個 Settings 一起不見。
 */
function useSettingsSearch(onSelect: (id: SectionId) => void) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const q = query.trim().toLowerCase();
  const isActive = q.length > 0;
  const results = useMemo(() => (q ? SEARCHABLE.filter((x) => x.title.toLowerCase().includes(q)) : []), [q]);
  useEffect(() => setActiveIndex(0), [q]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      // ⚠️ 也要擋冒泡:<dialog> 的 cancel 是 keydown 之後才發,但設計系統的 Dialog 也聽 keydown
      e.stopPropagation();
      setQuery('');
      return;
    }
    if (!isActive || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[activeIndex];
      if (hit) onSelect(hit.section);
    }
  };
  return {
    query,
    setQuery,
    isActive,
    results,
    activeIndex,
    setActiveIndex,
    onKeyDown,
    activeResultId: isActive && results.length > 0 ? `settings-search-result-${activeIndex}` : undefined,
  };
}
type SettingsSearch = ReturnType<typeof useSettingsSearch>;

function SettingsSearchInput({search}: {search: SettingsSearch}) {
  return (
    <TextInput
      label="Search settings"
      isLabelHidden
      placeholder="Search settings"
      size="sm"
      width="100%"
      hasClear
      startIcon={Search}
      role="combobox"
      aria-autocomplete="list"
      aria-controls="settings-search-results"
      aria-expanded={search.isActive ? search.results.length > 0 : false}
      aria-activedescendant={search.activeResultId}
      value={search.query}
      onChange={search.setQuery}
      onKeyDown={search.onKeyDown}
    />
  );
}

/**
 * 找到的設定。`ListItem` 不是 `SideNavItem`:這些是 listbox 的選項不是導覽,而且要講它在哪一區。
 * ⚠️ 外層是 `VStack as="ul"` 不是 `List` —— `List` 不轉傳 id / role / aria-label(範本的註解),
 * 搜尋框的 `aria-controls` 會指到不存在的東西。
 */
function SettingsSearchResults({search, onSelect}: {search: SettingsSearch; onSelect: (id: SectionId) => void}) {
  if (search.results.length === 0) {
    return (
      <VStack id="settings-search-results" padding={2}>
        <Text type="label">No settings found</Text>
      </VStack>
    );
  }
  return (
    <VStack as="ul" gap={0} id="settings-search-results" role="listbox" aria-label="Search results">
      {search.results.map((x, i) => (
        <ListItem
          key={x.title}
          id={`settings-search-result-${i}`}
          role="option"
          // aria-selected 由 isSelected 給(設計系統的 Item 只在選到時掛 true,沒選到不掛 —— 單選清單裡等同 false)
          isSelected={i === search.activeIndex}
          label={x.title}
          description={sectionLabelOf(x.section)}
          startContent={<Icon icon={x.icon} size="sm" color="secondary" />}
          endContent={<Icon icon={ChevronRight} size="sm" color="secondary" />}
          onMouseEnter={() => search.setActiveIndex(i)}
          onClick={() => onSelect(x.section)}
        />
      ))}
    </VStack>
  );
}

/**
 * 字級與對比那條拉桿(放在 `SettingsRow` 右邊;名稱是那一列畫的)。兩條長得一模一樣,所以只寫一次。
 *
 * ⚠️ **`formatValue` 不能省。** 它是 Astryx 拿去填 `aria-valuetext` 的唯一來源
 * (`Slider.js`:`"aria-valuetext": formatValue ? formatValue(val) : undefined`),
 * 少了它報讀軟體只能退回 `aria-valuenow` —— 而那是**拉桿位置**不是百分比,
 * 使用者設 100% 會被念成「50」。畫面上看不出任何異狀,所以很容易在改版時弄丟。
 *
 * ⚠️ **只有一個回呼,而且它只改 state。** 不分成兩個
 * (`onChange` 即時套本機、`onChangeEnd` 送伺服器),兩件事都在
 * 「關掉的那一刻」一次做完 —— 理由見檔案開頭。這樣也不會
 * 「拖一次連發幾十個 PUT」:一次設定只送一次。
 */
function PercentSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  /** 實際的字級/對比值(不是拉桿位置)。**只在「外面把它換掉」時才會變**(Reset)。 */
  value: number;
  onChange: (value: number) => void;
}) {
  const drag = useSliderDrag();
  /**
   * 拇指位置**住在這一層**(效能)。
   *
   * 設計系統的 `Slider` 只有受控模式(沒有 `defaultValue`),所以拖曳中一定要有
   * 一份會變的 state —— 差別在**它住在哪裡**。住在對話框上的話,每一個
   * `pointermove` 都重繪整個對話框(頭像、模型那排、兩條拉桿、footer);
   * 實測 41 個 move 造成 19 個 long task、總共 3.1 秒的主執行緒阻塞。
   * 收進這一層之後,一個 move 只重繪這一條拉桿:3 個 long task、169ms。
   *
   * ⚠️ 外面那個值仍然要**即時**送出去(`onChange`)—— 畫面要跟著拉桿變,
   * 那是刻意的行為;只是呼叫端不再拿它 `setState`(見 `applyLive`)。
   *
   * ⚠️ **`value` 只是初值。** 拖曳中它不會變(呼叫端刻意不 `setState`),
   * 所以外面要把拉桿拉回某個位置**只有換 `key` 這一條路** —— Reset 那顆鈕
   * 就是這樣做的(`resetNonce`)。中間寫過一版「相依 `value` 的同步 effect」,
   * 那是壞的:Reset 按下去時 `fontScale` 這個 state 本來就已經是 100
   * (拖曳沒動過它),effect 因此不會跑 —— 實測按了 Reset 字級回到 100% 了,
   * 拇指卻還停在 131% 的位置上。
   */
  const [pos, setPos] = useState(() => valueToSliderPosition(value));
  return (
    /* `data-settings-slider` 給 global.css 認的(非拖曳時拇指滑過去的過場)。 */
    <VStack
      data-settings-slider
      {...(drag.isDragging ? {'data-dragging': ''} : {})}
      {...drag.handlers}
    >
      {/*
        ⚠️ **不畫百分比**(沒什麼好顯示的)。名稱是 `SettingsRow` 畫的。

        ⚠️ 不是「藏掉 label 就一定要自己畫值」——
        要的是「看得到目前是多少」,而拉桿本身就畫得出位置;真正沒用的是
        那個數字的**絕對值**:下限是 50 不是 0(字級 0 的畫面連把它調回來的拉桿
        都看不見,見 `lib/displayPrefs.ts`),所以「最左邊 = 50%」怎麼看都怪。
        拿掉數字之後這個怪點就不存在了,而「回到預設」有 Reset 那顆鈕。

        ⚠️ **`aria-valuetext` 仍然留著**(見下面的 `formatValue`)——
        用報讀軟體的人本來就沒有「看拇指在哪」這條路,數字是他唯一的資訊。
        視覺上拿掉、無障礙樹上留著,不是同一件事。
      */}
      <Slider
        label={label}
        isLabelHidden
        valueDisplay="none"
        width={CONTROL_WIDTH}
        /*
         * ⚠️ **`formatValue` 不能省,而且現在它是百分比的唯一出口。**
         * 它是 Astryx 拿去填 `aria-valuetext` 的唯一來源
         * (`Slider.js`:`"aria-valuetext": formatValue ? formatValue(val) : undefined`),
         * 少了它報讀軟體只能退回 `aria-valuenow` —— 而那是**拉桿位置**不是百分比,
         * 使用者設 100% 會被念成「50」。畫面上看不出任何異狀,所以很容易在改版時弄丟。
         * ⚠️ 要 `Math.round`:刻度切細之後值不再是整數。
         */
        formatValue={(p: number) => `${Math.round(sliderPositionToValue(p))}%`}
        value={pos}
        min={SLIDER_POSITION_MIN}
        max={SLIDER_POSITION_MAX}
        step={SLIDER_POSITION_STEP}
        onChange={(p: number) => {
          setPos(p);
          onChange(sliderPositionToValue(p));
        }}
      />
    </VStack>
  );
}

export function AccountSettingsDialog({
  isOpen,
  onOpenChange,
  username,
  displayName,
  avatar,
  onIdentityChanged,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  username: string;
  displayName?: string;
  /** 目前的頭像(data URI)。null = 沒設過 */
  avatar: string | null | undefined;
  /**
   * 存好之後叫呼叫端重抓身分。
   *
   * ⚠️ **不只是為了側邊欄那顆頭像。** 這個對話框每次打開都重新掛載(呼叫端的
   * `key`),初值一律從 `me` 讀 —— 存完不重抓的話,`me` 還是舊的,
   * **關掉再打開會看到改之前的值**,而使用者會以為根本沒存進去。
   */
  onIdentityChanged: () => void;
}) {
  const initial = getDisplayPrefs();
  const [fontScale, setFontScale] = useState(initial.fontScale);
  const [contrast, setContrast] = useState(initial.contrast);
  /**
   * 正在裁切的那張原圖。null = 不在裁切模式(畫的是一般的設定列)。
   *
   * ⚠️ **原圖與裁切框要分成兩個 state。** 併成一個物件的話,拖曳每動一格都會
   * 產生一個新物件,底下那支「原圖換掉就收掉舊的」的 effect 會**每一幀都跑一次**
   * —— 也就是在使用者還在拖的時候把 `ImageBitmap` 關掉,畫面當場變空白。
   */
  const [cropSource, setCropSource] = useState<AvatarSource | null>(null);
  const [crop, setCrop] = useState<AvatarCrop | null>(null);
  /**
   * 剛按 OK 存好的那一張。null = 這次打開還沒換過(顯示 `avatar` 那張)。
   *
   * 它不是「草稿」:OK 就存了。留著它是因為
   * `onIdentityChanged()` 重抓身分要一趟來回,這段時間頭像要先換成新的。
   */
  const [draftAvatar, setDraftAvatar] = useState<string | null>(null);
  /** 滑鼠在頭像上、或焦點在那組控制項裡 —— 兩者都要讓浮層現身。 */
  const [isPhotoHot, setIsPhotoHot] = useState(false);
  /** 目前的常用模型。走 store 的 hook —— 這一顆按下去要馬上反白,
      而同一個值也要讓問答頁那顆鈕跟著換(見 `lib/modelPref.ts`)。 */
  const model = usePreferredModel();
  /**
   * 這台伺服器可以選哪些模型。`null` = 還沒問到(那一列先不畫)。
   *
   * ⚠️ 初值要走 `peekAllowedModels()`(同步),不能只靠底下那支 effect ——
   * 側邊欄掛載時已經預熱過,清單通常早就在手上,拿它當初值那一列才會跟
   * 其他列**同一幀**出現。只等 effect 的話會斷裂:
   * 先看到 Text size / Contrast,Default model 再補上去。
   */
  const [models, setModels] = useState<string[] | null>(() => peekAllowedModels());
  /** 頭像存 / 刪那一趟。只鎖頭像那幾顆鈕 —— 別區不必跟著等 */
  const [isSavingPhoto, setIsSavingPhoto] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * 釘住的上緣。還沒量到時是 undefined,先讓它照原本的方式置中。
   *
   * ⚠️ 為什麼要釘(長出 OK / Cancel 的時候,要往下長,
   * 不要往上長):`<dialog>` 是 `inset: 0` + `margin: auto` **垂直置中**的,
   * 所以高度一變,上下兩邊會**同時**往外長 —— 看起來就是整個視窗在上下呼吸。
   * 把 `margin-block-start` 換成固定值、`margin-block-end` 留 `auto`,
   * 多出來的空間就全部落在下面,於是只往下長。
   * ⚠️ `margin-inline` 不要動,水平還是要置中。
   *
   * 做法在全站共用的 `usePinnedDialogTop`(量 `offsetHeight`、視窗大小變了重算)—— 它還有一層「往下長到碰到
   * 視窗底才讓上緣往上」的保護(不然矮視窗裡長出確認列會把按鈕推出畫面外)。
   * 量法與理由(為什麼是 `offsetHeight` 不是 rect、為什麼要聽 resize)寫在那支 hook 裡。
   */
  const pin = usePinnedDialogTop(isOpen);

  const shownAvatar = draftAvatar ?? avatar ?? undefined;
  /**
   * 這台裝置有沒有真正的滑鼠。**沒有就一律顯示那組控制項** ——
   * 觸控裝置沒有 hover,只靠 hover 的話那兩顆鈕永遠碰不到。
   */
  const canHover = useMediaQuery(HOVER_QUERY);
  const showPhotoControls = !canHover || isPhotoHot;
  const name = personName(displayName || username);

  /**
   * 這個對話框自己那一份「字級」。**打開當下釘住,之後不再動。**
   *
   * 設計系統裡會跟著根字級變的那些 `rem` token(`lib/displayPrefs.ts` 的
   * `REM_TOKEN_NAMES`,字級的原始階與語意階加上圓角,共 30 個)—— 把它們在這個
   * `<dialog>` 上覆寫成**固定的 px**,這塊面板就完全免疫,而外面的 app 照樣
   * 即時跟著拉桿變。
   *
   * ⚠️ 量 `getComputedStyle` 而不是假設 16px:`font-size: 150%` 是相對於
   * **瀏覽器的預設字級**算的,而那是使用者可以改的。
   *
   * ⚠️ 這是全專案唯一一處覆寫設計系統的 token,而它**不是在改外觀** ——
   * 填進去的就是那些 token 在「打開當下」本來就會算出來的值。
   * 要改外觀仍然是先問(見 `frontend/.claude/CLAUDE.md`)。
   */
  /**
   * 關掉這個對話框。**三條路(X / Esc / 點背景)全部走 `exit.requestClose`。**
   *
   * 退場本身收在 `useDialogExit` 裡(全站共用)—— 為什麼不能直接
   * `onOpenChange(false)`、為什麼 `prefers-reduced-motion` 不在 JS 這一側分支,
   * 都寫在那支 hook 與 `global.css` 的 `[data-leaving]` 那一段。
   */
  const exit = useDialogExit(onOpenChange);

  const [pinnedTokens] = useState(() => {
    const root = getComputedStyle(document.documentElement);
    return pinnedRemTokens(parseFloat(root.fontSize) || 16, (name) =>
      root.getPropertyValue(name),
    );
  });

  /**
   * 拉桿現在的值,給關掉時那一次伺服器寫入用。
   *
   * 用 ref 帶給卸載時的 cleanup:`[]`/`[isOpen]` 相依的 cleanup 抓得到的是它註冊
   * 當下那一輪的變數,直接讀 `fontScale` 會送出使用者打開時的舊值。
   *
   * ⚠️ **寫它的地方只有 `applyLive` 一支**。
   * 不要另外加一支「相依 `fontScale` / `contrast` 的 effect」:拖曳
   * **不動那兩個 state** —— 那支 effect 不會錯,但它會讓人以為值是從
   * state 流過來的,下次有人把 `applyLive` 裡那一行刪掉就會靜靜地送出舊值。
   */
  const liveRef = useRef({fontScale: initial.fontScale, contrast: initial.contrast});

  /*
   * ⚠️ **套用的時機是「開著的那個實例被卸載」。**
   *
   * 關掉的路有三條(右上角的 X / Esc / 點背景),每一條都會讓
   * `isSettingsOpen` 轉成 false,而那邊掛著 `key={isSettingsOpen ? 'open' : 'closed'}`
   * —— 也就是每一條都一定會走到卸載。只掛在其中一條路上的話,另外幾條就會靜靜地
   * 把使用者剛拉好的字級丟掉。
   *
   * ⚠️ **`if (!isOpen) return;` 那一行不能拿掉**(實測追出來的):
   * `key` 一換,React 會在**同一個 commit 裡**卸載舊的、掛上新的那個 closed 實例,
   * 而新實例的 `initial = getDisplayPrefs()` 是在 **render 階段**讀的 ——
   * 那時候舊實例的 cleanup(也就是這裡)還沒跑,它讀到的是**還沒被套用的舊值**。
   * 不擋的話,那個 closed 實例下次被卸載(= 使用者再打開設定)時,
   * 會把那份舊值再寫回去 —— 症狀是「拉好字級、關掉、看起來生效了,
   * 結果一打開 Settings 就跳回原本的大小」。
   */
  useEffect(() => {
    if (!isOpen) return;
    /*
     * ⚠️ **伺服器那一份在關掉時送一次,不是放開拉桿就送。**
     * 拖一次會觸發幾十個事件,每個都送等於對伺服器連打;而本機那份在拖的當下
     * 就已經生效了(`setLocal` → `setDisplayPrefs`),所以晚一點送沒有任何損失。
     * 失敗靜默:這是偏好同步。
     */
    return () => {
      /*
       * ⚠️ **本機那一份也在這裡寫。** 不要在拖曳的每一個 pointermove 都寫一次
       * localStorage —— 而 `setItem` 是同步 I/O,等於把磁碟寫入掛在拖曳的每一幀上
       * (實測:41 次 move → 42 次 `setItem`)。
       * 畫面在拖的當下就已經跟著變了(`setDisplayPrefs` 只是把「套用」收斂成一幀一次)。
       */
      persistDisplayPrefs();
      void saveDisplayPrefs(liveRef.current.fontScale, liveRef.current.contrast);
    };
  }, [isOpen]);

  /*
   * 模型清單跟問答頁走同一支 `/api/config`。
   * 失敗就讓那一列不要出現 —— 這是個偏好設定,為了它跳一句錯誤訊息
   * 反而蓋掉使用者本來要做的事(靜默失敗只用在加值功能)。
   */
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    void getAllowedModels()
      .then((allowed) => {
        if (alive) setModels(allowed);
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  /*
   * ⚠️ 裁切用的那張原圖要**自己收**(`ImageBitmap` 不收就一直佔著記憶體)。
   * 三條路徑(換一張、取消、對話框關掉)全部收在這一支 effect 的 cleanup 裡:
   * 只要 `cropSource` 被換掉或元件卸載,上一張就一定會被關 ——
   * 散在各個處理函式裡的話,總有一條會漏。
   */
  useEffect(() => () => cropSource?.close(), [cropSource]);

  /*
   * ⚠️ **這一段是在擋「按 Change photo 之後按取消,整個 Settings 就不見了」**。
   *
   * 在原生選檔視窗按取消時,瀏覽器會對這個 `<input type="file">` 發一個
   * `cancel` 事件,而**它是會冒泡的**(HTML 規格明寫 `bubbles: true`)。
   * 外面那層是 `<dialog>`,而設計系統的 `Dialog` 把 `onCancel` 當成
   * 「使用者按了 Esc」在接(`@astryxdesign/core` 的 `Dialog.handleCancel`)——
   * 於是「取消選檔」被當成「取消這個對話框」,設定視窗當場關掉。
   *
   * ⚠️ **用原生監聽器,不要寫成 `onCancel` prop**:React 的型別裡
   * `<input>` 根本沒有 `onCancel`(只有 `<dialog>` 有),而它會不會真的替
   * input 掛上那個非委派事件是 React 的內部細節。直接掛在元素上最短、最確定。
   */
  useEffect(() => {
    const el = fileRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener('cancel', stop);
    return () => el.removeEventListener('cancel', stop);
  }, []);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const source = await loadAvatarSource(file);
      // 前一張(連按兩次 Change photo)由上面那支 effect 的 cleanup 收掉
      setCropSource(source);
      setCrop(defaultCrop(source));
    } catch (err) {
      toastError(err instanceof AvatarImageError ? err.message : 'That image could not be read.');
    } finally {
      // ⚠️ 一定要清掉 input 的值:不清的話「挑同一個檔案第二次」不會觸發
      // change 事件(值沒變),使用者會覺得按了沒反應。
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /**
   * 按了 OK:算出裁切結果、**當場存**,存好才回到一般的頭像顯示。
   *
   * OK 就是存檔。
   */
  const applyCrop = async () => {
    if (!cropSource || !crop || isSavingPhoto) return;
    let dataUri: string;
    try {
      dataUri = avatarCropToDataUri(cropSource, crop);
    } catch (err) {
      toastError(err instanceof AvatarImageError ? err.message : 'That image could not be read.');
      // ⚠️ 失敗要**留在裁切模式**(`return` 之後不要碰 cropSource)——
      // 踢出去的話他既不知道發生什麼事,也沒有東西可以重試。
      return;
    }
    setIsSavingPhoto(true);
    try {
      await saveAvatar(dataUri);
      setDraftAvatar(dataUri);
      setCropSource(null);
      setCrop(null);
      onIdentityChanged();
    } catch {
      /*
       * ⚠️ **不要用 `errorMessage(err, …)` 把後端的 detail 透出來**:
       * `backend/app/routers/auth.py` 的訊息整組是中文(登入頁那些也是),
       * 透出來就會在這個英文對話框裡冒出一句中文。這裡固定講英文。
       * 存不進去同樣**留在裁切模式**,他可以換個構圖或按 Cancel。
       */
      toastError('The photo could not be saved. Try a smaller photo.');
    } finally {
      setIsSavingPhoto(false);
    }
  };

  /** 挑好的那張先不要了 —— 回到目前的頭像。原圖由 effect 的 cleanup 收。 */
  const cancelCrop = () => {
    setCropSource(null);
    setCrop(null);
  };

  /*
   * 改密碼(在 Account 裡就地展開)。
   * 三格、檢查規則、錯誤的樣子都在 `PasswordChangeFields`(跟強制改密碼頁共用)。
   */
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const passwordForm = usePasswordChangeForm();
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  /**
   * 收起來之後焦點回到「Change」:Save / Cancel 那兩顆跟著卸載,不接住的話焦點掉到 body,
   * 鍵盤使用者得從頭 Tab 回來。只在收合時接 —— 打開對話框那一下不要搶焦點。
   */
  const changePasswordRef = useRef<HTMLButtonElement>(null);
  const shouldRefocusChange = useRef(false);
  useEffect(() => {
    if (isChangingPassword || !shouldRefocusChange.current) return;
    shouldRefocusChange.current = false;
    changePasswordRef.current?.focus();
  }, [isChangingPassword]);
  /** 收起來就清乾淨:密碼留在 state 裡沒有任何好處,而且下次展開會看到上次打到一半的東西 */
  const closePasswordRow = () => {
    passwordForm.reset();
    setIsChangingPassword(false);
    shouldRefocusChange.current = true;
  };
  const canSubmitPassword = passwordForm.isComplete && !isSavingPassword;

  const submitPassword = async () => {
    if (!canSubmitPassword) return;
    setIsSavingPassword(true);
    passwordForm.setError(null);
    try {
      await changePassword(passwordForm.current, passwordForm.next);
      // 後端會把這個人其他地方的登入一起撤掉 —— 一定要講,
      // 不然他手機上突然被登出會以為帳號出事了
      toastInfo('Password changed. You have been signed out on your other devices.');
      closePasswordRow();
      // 身分沒變,但重問一次最省事(密碼狀態、password_is_default 都在那支上)。
      // ⚠️ **不要改成廣播 `IDENTITY_CHANGED`**:`useIdentity` 收到廣播會
      // 先把 `loading` 設成 true,App 因此整個卸載 Chrome —— 這個對話框會跟著消失、整頁重來。
      // 這裡要「收回成一列、對話框不關」。`onIdentityChanged` 只重抓,不碰 loading。
      onIdentityChanged();
    } catch (err) {
      // 這裡的 401/400 是「目前的密碼不正確」,不是「帳號或密碼錯誤」
      passwordForm.setError(describePasswordError(err));
    } finally {
      setIsSavingPassword(false);
    }
  };

  /** 深淺色:現在畫面上是哪一個。按下去走 `chooseTheme`(會寫回伺服器) */
  const themeMode = useThemeMode();

  const [section, setSection] = useState<SectionId>('account');
  /** 手機寬度放不下左邊那欄,改成頂上一排分頁(斷點同全站的 `MOBILE_QUERY`) */
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const removeAvatar = async () => {
    setIsSavingPhoto(true);
    try {
      await saveAvatar(null);
      setDraftAvatar(null);
      onIdentityChanged();
    } catch {
      // 同上:固定英文,不透後端的中文 detail
      toastError('The photo could not be removed.');
    } finally {
      setIsSavingPhoto(false);
    }
  };

  /**
   * 拉桿共用:**即時套到畫面上**(`<html>` 的字級 / `--user-contrast`)。
   *
   * 外面那個 app 會當場跟著變 —— 而這塊面板不會,因為它把那些 `rem` token
   * 釘成固定 px 了(見 `pinnedTokens`)。兩件事要同時成立。
   *
   * ⚠️ **送伺服器不在這裡** —— 拖一次會觸發幾十個事件。改在對話框關掉時送一次,
   * 見上面那支 effect。`PercentSlider` 已經沒有 `onCommit`/`onChangeEnd` 了。
   */
  /**
   * 拖曳路徑用這一支:**套到畫面上,但不重繪這個對話框**(效能)。
   *
   * 拇指位置現在住在 `PercentSlider` 自己身上,對話框不需要知道拖到哪裡 ——
   * 它只要在關掉的時候存得到最後的值,而那份走 `liveRef`。
   * 不要在這裡 `setFontScale` / `setContrast`:那樣每一個 `pointermove` 都重繪
   * 整個對話框(實測 41 個 move → 19 個 long task、3.1 秒的阻塞)。
   *
   * ⚠️ `liveRef` 要在這裡寫,不能再靠「相依 state 的 effect」—— 沒有 state 變動
   * 就沒有那次 effect,關掉時會送出使用者打開時的舊值。
   */
  const applyLive = (next: {fontScale?: number; contrast?: number}) => {
    setDisplayPrefs(next);
    liveRef.current = {...liveRef.current, ...next};
  };

  /**
   * Reset 那顆鈕走這一支:**要重繪**,因為兩條拉桿得跳回預設的位置
   * (它們的 `value` prop 就是這兩個 state;拇指真正跳回去靠的是 `resetNonce` 換 key,見 Reset 那顆鈕)。
   */
  const setLocal = (next: {fontScale?: number; contrast?: number}) => {
    applyLive(next);
    if (next.fontScale !== undefined) setFontScale(next.fontScale);
    if (next.contrast !== undefined) setContrast(next.contrast);
  };

  /** 常用模型:按下去就生效(本機),同一時間靜默送伺服器。 */
  const chooseModel = (next: string) => {
    setPreferredModel(next);
    void savePreferredModel(next);
  };

  /*
   * 吉祥物。跟模型同一種待遇:按下去右下角那隻當場換掉,
   * 存伺服器失敗靜默 —— 只影響換一台電腦時的預設。
   */
  const companion = useCompanion();
  const chooseCompanion = (next: string) => {
    // SegmentedControl 給的是字串;只收認得的值(不要硬轉型別)
    if (!isCompanion(next)) return;
    setCompanion(next);
    void saveCompanion(next);
  };
  /*
   * Show companion。同吉祥物的待遇:當場收起 / 放出右下角那隻,存伺服器失敗靜默。
   * 關掉時它要講的話改走 toast(`PetSpeechToast`,App 那一層接)。
   */
  const companionVisible = useCompanionVisible();
  const toggleCompanionVisible = (next: boolean) => {
    setCompanionVisible(next);
    void saveCompanionVisible(next);
  };

  /**
   * 按過幾次 Reset。**只拿來當那兩條拉桿的 `key`** ——
   * 拇指位置住在 `PercentSlider` 自己身上(見那邊的說明),把它拉回預設的唯一
   * 辦法就是換 `key` 讓它重新掛載、從 `value` 重新起算。
   */
  const [resetNonce, setResetNonce] = useState(0);

  const isCropping = cropSource !== null && crop !== null;
  /** 模型那一列要不要出現。清單還沒到、或只有一個可選,都是不出現。 */
  const hasModelRow = (models?.length ?? 0) > 1;

  const accountSection = (
    <VStack gap={5}>
      <SettingsCard title="Profile">
        {/*
          頭像 + 名字,包在範本的卡片裡。⚠️ 尺寸仍是 `PREVIEW_PX`(128):挑完照片時頭像原本的位置
          就地變成裁切圈,兩邊同一個尺寸才不會跳(見 `styles.avatarSlot`;刻意維持 128,不用範本的小頭像)。
          ⚠️ 名字那塊離頭像 `gap={10}`:裁切時縮放軌道絕對定位掛在圓圈右邊
          (`AvatarCropper` 的 `zoomRail`,圓圈外 12px + 拉桿),太近會壓在名字上。
        */}
        <VStack padding={ROW_PADDING} gap={2}>
          <HStack gap={10} vAlign="center">
            {isCropping ? (
              <AvatarCropper
                source={cropSource}
                crop={crop}
                onCropChange={setCrop}
                xstyle={styles.photoStage}
              />
            ) : (
              /*
                ⚠️ **控制項長在頭像上,不是底下一排按鈕**
                (滑鼠一到頭像才出現)。沒照片時是一顆「+」,
                有照片時是「改」與「刪」(刪是紅的)。

                ⚠️ 兩條無障礙的線一定要顧:
                 1. 焦點進來也要現身(不只 hover)—— 不然用鍵盤的人會 Tab 到
                    一顆看不見的按鈕上;`onFocus`/`onBlur` 判 `relatedTarget`,
                    跟側邊欄那一列的做法同一套。
                 2. 沒有精準指標的裝置**一律顯示** —— 觸控沒有 hover,
                    只靠 hover 的話這兩顆永遠碰不到(見 `canHover`)。
              */
              <Stack
                xstyle={[styles.avatarSlot, styles.photoStage]}
                /* 尺寸跟裁切圈共用同一個常數,見 `styles.avatarSlot` 的說明 */
                style={{width: `${PREVIEW_PX}px`, height: `${PREVIEW_PX}px`}}
                onMouseEnter={() => setIsPhotoHot(true)}
                onMouseLeave={() => setIsPhotoHot(false)}
                onFocus={() => setIsPhotoHot(true)}
                onBlur={(e: React.FocusEvent) => {
                  // ⚠️ 要判 relatedTarget:從「改」Tab 到「刪」時 blur 比 focus
                  // 先發生,不判的話浮層會在焦點抵達前就收起來。
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setIsPhotoHot(false);
                  }
                }}
              >
                <Avatar name={name} src={shownAvatar} size="xl" tooltip={false} />
                <Stack
                  xstyle={[
                    styles.avatarOverlay,
                    showPhotoControls && styles.avatarOverlayShown,
                  ]}
                >
                  {shownAvatar ? (
                    <HStack gap={2} vAlign="center">
                      <IconButton
                        label="Change photo"
                        icon={<Icon icon={Pencil} size="sm" />}
                        /* ⚠️ **實心的 `primary`,不要用 `secondary`。**
                           secondary 是 `rgba(0,0,0,0.06)` 底 + 近黑圖示,
                           疊在這層深色遮罩上等於黑底黑字,完全看不見(實測)。
                           實心鈕在深淺兩套佈景下都跟遮罩分得開。 */
                        variant="primary"
                        size="sm"
                        isDisabled={isSavingPhoto}
                        onClick={() => fileRef.current?.click()}
                      />
                      <IconButton
                        label="Remove photo"
                        icon={<Icon icon={Trash2} size="sm" />}
                        variant="destructive"
                        size="sm"
                        isDisabled={isSavingPhoto}
                        onClick={() => void removeAvatar()}
                      />
                    </HStack>
                  ) : (
                    <IconButton
                      label="Add photo"
                      icon={<Icon icon={Plus} size="sm" />}
                      /* 同上:遮罩是深色的,要實心鈕才看得見 */
                      variant="primary"
                      size="sm"
                      isDisabled={isSavingPhoto}
                      onClick={() => fileRef.current?.click()}
                    />
                  )}
                </Stack>
              </Stack>
            )}
            <VStack gap={0}>
              <Text type="label" display="block">
                {name}
              </Text>
              <Text type="supporting" color="secondary" display="block">
                {username}
              </Text>
            </VStack>
          </HStack>
          {/*
            裁切時的 OK / Cancel —— **從頭貼底下長出來**,做法見
            `styles.actionsRow`。⚠️ 不要改回「平常也把高度留著」:
            那會讓頭貼離 Default model 距離很寬。
            ⚠️ 收起來的時候那兩顆還在 DOM 裡(要讓它演完收合),所以要 `inert`
            —— 不然鍵盤會 Tab 進一個看不見的按鈕裡。
          */}
          <Stack xstyle={[styles.actionsRow, isCropping && styles.actionsRowOpen]}>
            <Stack xstyle={styles.actionsClip} inert={!isCropping}>
              <HStack
                xstyle={[
                  styles.photoActions,
                  styles.actionsFade,
                  isCropping && styles.actionsFadeShown,
                ]}
              >
                <Button
                  label="Cancel"
                  variant="secondary"
                  size="sm"
                  xstyle={styles.photoAction}
                  isDisabled={isSavingPhoto}
                  onClick={cancelCrop}
                />
                {/* OK = 存檔(沒有 Done 了),存的時候轉圈 */}
                <Button
                  label="OK"
                  variant="primary"
                  size="sm"
                  xstyle={styles.photoAction}
                  isLoading={isSavingPhoto}
                  onClick={() => void applyCrop()}
                />
              </HStack>
            </Stack>
          </Stack>
        </VStack>
      </SettingsCard>
      <SettingsCard title="Sign-in">
        {/*
          改密碼:平常是「Password / Change」一列,點 Change 就地展開三格 + Save / Cancel
          (範本 Sign-in 那一列的 Change 是 secondary 小鈕)。第一格展開就聚焦(`variant="dialog"`)。
          ⚠️ 帳號的「多因子驗證」刻意不在這裡:手機驗證碼是管理員發放的,見 backend/app/mfa.py。
        */}
        <SettingsRow
          title="Password"
          icon={KeyRound}
          control={
            isChangingPassword ? undefined : (
              <Button
                ref={changePasswordRef}
                label="Change"
                variant="secondary"
                size="sm"
                onClick={() => setIsChangingPassword(true)}
              />
            )
          }
          detail={
            isChangingPassword ? (
              <VStack gap={4}>
                <PasswordChangeFields form={passwordForm} variant="dialog" />
                <HStack gap={2}>
                  <Button
                    label="Save"
                    variant="primary"
                    size="sm"
                    isDisabled={!canSubmitPassword}
                    isLoading={isSavingPassword}
                    onClick={() => void submitPassword()}
                  />
                  <Button label="Cancel" variant="ghost" size="sm" onClick={closePasswordRow} />
                </HStack>
              </VStack>
            ) : undefined
          }
        />
      </SettingsCard>
    </VStack>
  );

  const appearanceSection = (
    <VStack gap={5}>
      {/* 深淺色。切換會順手寫回伺服器,換一台電腦才是同一個樣子 */}
      <SettingsCard>
        <SettingsRow
          title="Theme"
          icon={Paintbrush}
          detail={<ThemeChoiceCards value={themeMode} onChange={chooseTheme} />}
        />
      </SettingsCard>
      {/*
        ⚠️ 兩條拉桿的 `key` 帶 `resetNonce`:那是 Reset 把拇指拉回預設的唯一路徑,
        見 `PercentSlider` 裡 `pos` 的說明。
      */}
      <SettingsCard title="Text">
        <SettingsRow
          title="Text size"
          icon={ALargeSmall}
          control={
            <PercentSlider
              key={`text-${resetNonce}`}
              label="Text size"
              value={fontScale}
              /* ⚠️ 走 `applyLive` 不是 `setLocal` —— 拖曳路徑不重繪對話框 */
              onChange={(v) => applyLive({fontScale: v})}
            />
          }
        />
        <SettingsRow
          title="Contrast"
          icon={Contrast}
          control={
            <PercentSlider
              key={`contrast-${resetNonce}`}
              label="Contrast"
              value={contrast}
              onChange={(v) => applyLive({contrast: v})}
            />
          }
        />
        {/*
          Reset 只管字級與對比。⚠️ 不要做「都是預設時變灰」:拖曳時刻意不動
          `fontScale` / `contrast` 這兩個 state(見 `applyLive`),拿它們判斷會一直以為還在預設。
        */}
        <SettingsRow
          title="Reset text size and contrast"
          icon={RotateCcw}
          control={
            <Button
              label="Reset"
              variant="secondary"
              size="sm"
              onClick={() => {
                setLocal({fontScale: FONT_SCALE_DEFAULT, contrast: CONTRAST_DEFAULT});
                // ⚠️ 換 key 讓兩條拉桿重新從預設值起算 —— 少了這一行,字級真的
                // 回到 100% 了,拇指卻還停在剛剛拖到的位置(實測過)。
                setResetNonce((n) => n + 1);
              }}
            />
          }
        />
      </SettingsCard>
    </VStack>
  );

  const chatSection = (
    <VStack gap={5}>
      <SettingsCard>
        {/*
          常用模型。沒設過的預設是 Sonnet ——
          那是前端指定的,跟後端的 `default_model` 是兩件事(見 `lib/modelPref.ts`)。
          ⚠️ 只有一個模型可選的時候整列不畫,跟輸入框上那顆鈕同一條規則:
          一個選項的選擇器只是在佔位置。
        */}
        {hasModelRow ? (
          <SettingsRow
            title="Default model"
            icon={Bot}
            control={
              <SegmentedControl label="Default model" size="sm" value={model} onChange={chooseModel}>
                {(models ?? []).map((m) => (
                  <SegmentedControlItem key={m} value={m} label={modelLabel(m)} />
                ))}
              </SegmentedControl>
            }
          />
        ) : null}
      </SettingsCard>
    </VStack>
  );

  /** Companion 那一列右邊的 Classic / Bloub。CompanionLook 載入前也要畫得出來(Suspense 的 fallback) */
  const companionPicker = (
    <SegmentedControl label="Companion" size="sm" value={companion} onChange={chooseCompanion}>
      {COMPANIONS.map((c) => (
        <SegmentedControlItem key={c} value={c} label={COMPANION_LABELS[c]} />
      ))}
    </SegmentedControl>
  );

  const companionSection = (
    <VStack gap={5}>
      {/*
        右下角的吉祥物:Companion 一列 + 預覽台,Bloub 再多 Shape / Color 兩列(都在 `CompanionLook` 裡)。
        卡片在這裡包:CompanionLook 的 Shape / Color 收合時連上面那條淡線一起收,用 `SettingsCard`
        的自動分隔線會在 Classic 時多一條。引擎通常已經被右下角那隻載過了,fallback 只是保險。
      */}
      <Card padding={0} width="100%" variant="muted">
        <VStack gap={0}>
          {/*
            Show companion(卡片最上面一列)。關掉時底下整塊(Companion、預覽台、
            Shape / Color)連同上面那條淡線一起收起來 —— 殼與淡入是裁切 OK / Cancel 那一套(styles.actionsRow),
            同 CompanionLook 收 Shape / Color 的做法;收起來 `inert`,Tab 不會進到看不見的地方。
          */}
          <SettingsRow
            title="Show companion"
            icon={Eye}
            control={
              <Switch
                label="Show companion"
                isLabelHidden
                value={companionVisible}
                onChange={toggleCompanionVisible}
              />
            }
          />
          <Stack xstyle={[styles.actionsRow, companionVisible && styles.actionsRowOpen]}>
            <Stack xstyle={styles.actionsClip} inert={!companionVisible}>
              <VStack gap={0} xstyle={[styles.actionsFade, companionVisible && styles.actionsFadeShown]}>
                <Divider variant="subtle" />
                <Suspense fallback={<SettingsRow title="Companion" icon={Smile} control={companionPicker} />}>
                  <CompanionLook companion={companion} picker={companionPicker} />
                </Suspense>
              </VStack>
            </Stack>
          </Stack>
        </VStack>
      </Card>
    </VStack>
  );

  /*
   * 每一區一直掛著,換區只藏起來 —— 理由見檔頭(拇指位置、打到一半的密碼)。
   * ⚠️ 藏法是 `display: none`(`styles.sectionHidden`),**不能只給 `hidden` 屬性**:
   * VStack 自己的 `display: flex` 會蓋過瀏覽器給 `[hidden]` 的 `display: none`,
   * 實測四區會全部疊在一起畫出來。
   */
  const body = (
    <VStack gap={0}>
      {(
        [
          ['account', accountSection],
          ['appearance', appearanceSection],
          ['chat', chatSection],
          ['companion', companionSection],
          ['shortcuts', <ShortcutSettings key="shortcuts" />],
        ] as const
      ).map(([id, content]) => (
        <VStack key={id} xstyle={section !== id && styles.sectionHidden}>
          {content}
        </VStack>
      ))}
    </VStack>
  );
  const heading = <Heading level={2}>{sectionLabelOf(section)}</Heading>;
  const titleId = useId();
  const selectSection = (id: SectionId) => {
    setSection(id);
    search.setQuery('');
  };
  const search = useSettingsSearch(selectSection);
  /*
   * 打開時焦點落在「Settings」標題上(照範本不用 `DialogHeader`,所以這裡自己做)。
   * 不做的話原生 `showModal()` 會挑第一個能 Tab 的:桌面是搜尋框(平板會跳出鍵盤)、手機是 Close。
   * 標題 `tabIndex={-1}`:程式聚焦得到,Tab 不會停在上面。
   */
  useEffect(() => {
    if (!isOpen) return;
    document.getElementById(titleId)?.focus({preventScroll: true});
  }, [isOpen, titleId]);
  /** 右上角的 X。跟 Esc、點背景同一條退場路(見 `exit`) */
  const close = () => exit.dialogProps.onOpenChange(false);
  const closeButton = (
    <IconButton label="Close" variant="ghost" size="sm" icon={<Icon icon="close" size="sm" />} onClick={close} />
  );

  return (
    <Dialog
      isOpen={isOpen}
      {...exit.dialogProps}
      purpose="info"
      width={DIALOG_WIDTH}
      maxHeight={DIALOG_HEIGHT}
      padding={0}
      aria-labelledby={titleId}
      ref={pin.ref}
      style={
        {
          ...pinnedTokens,
          ...pin.style,
          height: DIALOG_HEIGHT,
        } as React.CSSProperties
      }
    >
      {/*
        真正的檔案輸入藏起來:原生的樣子跟設計系統對不上,但它仍然要在
        DOM 裡才點得開。
        ⚠️ **放在最外層**(一直掛著,不跟著分區或裁切模式卸載)—— 見那支擋 `cancel`
        的 effect,它只在掛載時綁一次。
        鍵盤與報讀都**跳過它**(`tabIndex=-1` + `aria-hidden`):能操作的是頭像上那顆
        Add / Change photo 鈕(它用 `fileRef.current.click()` 開選檔),這格再被 Tab 到
        只會讓焦點停在看不見的地方。
      */}
      <VisuallyHidden>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
      </VisuallyHidden>
      {isMobile ? (
        /* 手機:範本的窄版 —— 標題列、搜尋、一排只有圖示的分頁,再來是那一區(一欄) */
        <VStack gap={0} height="100%">
          <HStack gap={2} align="center" paddingInline={3} paddingBlock={3}>
            <StackItem size="fill">
              <Text type="label" id={titleId} tabIndex={-1} xstyle={styles.titleFocusable}>
                Settings
              </Text>
            </StackItem>
            {closeButton}
          </HStack>
          <Divider />
          <VStack paddingInline={3} paddingBlock={2}>
            <SettingsSearchInput search={search} />
          </VStack>
          {search.isActive ? (
            <VStack paddingInline={3} isScrollable>
              <SettingsSearchResults search={search} onSelect={selectSection} />
            </VStack>
          ) : null}
          {/* ⚠️ 搜尋中只藏起來不卸載:每一區一直掛著(見 `body`) */}
          <VStack gap={0} height="100%" xstyle={search.isActive && styles.sectionHidden}>
            {/* 分頁只有圖示(名稱給報讀):手機寬放不下四個名字,會被截成「Ac…」 */}
            <HStack
              as="nav"
              aria-label="Settings sections"
              gap={1}
              wrap="nowrap"
              isScrollable
              paddingInline={3}
              paddingBlock={2}
            >
              {SECTIONS.map((s) => (
                <IconButton
                  key={s.id}
                  label={s.label}
                  aria-current={s.id === section ? 'page' : undefined}
                  icon={<Icon icon={s.icon} size="sm" />}
                  variant={s.id === section ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => selectSection(s.id)}
                />
              ))}
            </HStack>
            <Divider />
            <StackItem size="fill">
              <VStack gap={4} padding={4} isScrollable height="100%" xstyle={settingsPanelStyle}>
                {heading}
                {body}
              </VStack>
            </StackItem>
          </VStack>
        </VStack>
      ) : (
        <Layout
          height="fill"
          start={
            <SideNav
              aria-label="Settings sections"
              xstyle={styles.sideNav}
              header={
                <HStack gap={2} align="center" paddingInline={2} minHeight={32}>
                  <Heading level={4} id={titleId} tabIndex={-1} xstyle={styles.titleFocusable}>
                    Settings
                  </Heading>
                </HStack>
              }
              topContent={<SettingsSearchInput search={search} />}
            >
              {search.isActive ? (
                <SettingsSearchResults search={search} onSelect={selectSection} />
              ) : (
                SECTION_GROUPS.map((g) => (
                  <SideNavSection key={g.label} title={g.label} xstyle={styles.sideNavSection}>
                    {g.sections.map((s) => (
                      <SideNavItem
                        key={s.id}
                        label={s.label}
                        /* 先畫好再給:讓 SideNavItem 自己畫的話沒選到的圖示會比字淡一階(範本的註解) */
                        icon={<Icon icon={s.icon} size="sm" color="primary" />}
                        isSelected={s.id === section}
                        onClick={() => selectSection(s.id)}
                      />
                    ))}
                  </SideNavSection>
                ))
              )}
            </SideNav>
          }
          content={
            <LayoutContent isScrollable padding={4}>
              {/* 關閉鈕釘在右上角;`width="100%"` 不能拿掉,不然 justify="end" 推不到角落(範本) */}
              <HStack width="100%" justify="end" xstyle={styles.closeAnchor}>
                <HStack xstyle={styles.closeBacking}>{closeButton}</HStack>
              </HStack>
              <VStack gap={4} xstyle={settingsPanelStyle}>
                <HStack gap={2} align="start">
                  <StackItem size="fill">{heading}</StackItem>
                  {/* 留給上面那顆浮著的關閉鈕的位置 */}
                  <VStack aria-hidden="true" width={32} />
                </HStack>
                {body}
              </VStack>
            </LayoutContent>
          }
        />
      )}
    </Dialog>
  );
}
