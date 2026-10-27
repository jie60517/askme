/**
 * 個人設定。
 *
 * 版面照設計系統的 **settings-sidebar** 範本:每一列是
 * 「左邊標籤、右邊控制項」+ 一條 `Divider`,沒有說明文字。
 *
 * ⚠️ **這個對話框的字是英文**,跟全站慣例一致(`frontend/.claude/CLAUDE.md`)。
 * 那條「內容用繁中」的例外只涵蓋管理頁(/stats、/security、/users),不含這裡。
 *
 * ⚠️ **拉桿即時套到背後的畫面上,但這塊面板自己不跟著變**。做法見 `pinnedTokens`。
 *
 * ⚠️ **不要用 `zoom` / `transform` 把面板縮回去**,那樣不成立:
 * 設計系統的 `--spacing-*` 是寫死的 **px**,只有字級與圓角是 `rem` ——
 * 這個對話框 508px 高裡只有 60px 會跟著字級走(100% → 200% 是 508 → 568)。
 * 它不是等比例放大,照字級比例縮的結果是被壓成 284px。
 */
import {Suspense, useEffect, useRef, useState} from 'react';

import * as stylex from '@stylexjs/stylex';

import {Avatar} from '@astryxdesign/core/Avatar';
import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Stack} from '@astryxdesign/core/Stack';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, Layout, LayoutContent, LayoutFooter, VStack} from '@astryxdesign/core/Layout';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {Slider} from '@astryxdesign/core/Slider';
import {Text} from '@astryxdesign/core/Text';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';

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
  useCompanion,
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
import {Pencil, Plus, Trash2} from 'lucide-react';

import {lazyChunk} from '../lib/lazyChunk';
import {HOVER_QUERY, useMediaQuery} from '../lib/media';
import {
  saveAvatar,
  saveCompanion,
  saveDisplayPrefs,
  savePreferredModel,
} from '../lib/loginApi';
import {modelLabel, setPreferredModel, usePreferredModel} from '../lib/modelPref';
import {personName} from '../lib/people';
import {toastError} from '../lib/toast';
import {AvatarCropper, PREVIEW_PX} from './AvatarCropper';
import {useDialogExit} from './useDialogExit';
import {usePinnedDialogTop} from './usePinnedDialogTop';
import {useSliderDrag} from './useSliderDrag';

/** 對話框的寬度。 */
const DIALOG_WIDTH = 440;

/*
 * 這個檔案裡「殼變高」的兩塊(裁切的 OK / Cancel `actionsRow`、模型那一列 `modelRow`)
 * 走同一條 iOS 面板曲線 `var(--ease-panel)` —— 同一個對話框裡兩塊東西用兩條不同的
 * 曲線長出來,看起來會像兩個不同的元件。
 *
 * 曲線本身(與「為什麼殼不能過衝、內容才過衝」的完整理由)住在 `global.css` 的
 * `:root`:`--ease-panel` / `--ease-overshoot`(落地頁的分類籤也用)。
 * **時長是這個檔案的字面值**(420 / 320 / 260 / 80ms),是刻意的。
 */

/**
 * Companion 底下的預覽台 + Bloub 的型態 / 顏色。
 * ⚠️ **分包**:它拉進了 bloub 引擎,靜態 import 的話引擎會被打進主程式(見那個檔案開頭)。
 * ⚠️ 走 `lazyChunk` 不是原生 `lazy`:上版後舊分頁去抓舊檔名會 404,原生 lazy 直接白畫面
 *    (理由見 `lib/lazyChunk.ts`)。
 * ⚠️ **閒下來就先載**:不預載的話第一次打開設定時這塊(144px 預覽台 + 兩列)會在對話框
 *    開好之後才一格撐出來,版面跳一下。這支檔案是 App 靜態 import 的,
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
   * (128px,見 `AvatarCropper` 的 `PREVIEW_PX`),再加位移只會讓它看起來在震動。
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
   */
  avatarSlot: {
    position: 'relative',
    borderRadius: '50%',
  },
  /*
   * 滑到頭像上才出現的那組控制項(沒頭貼時是 +,有頭貼時是修改 / 刪除)。
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
   * 裁切時的 OK / Cancel:**從頭貼底下長出來**,而且對話框跟著慢慢變高,
   * 手感像 iPhone 的動態島。不預留空間。
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
   * ⚠️ **內容比殼晚 80ms 起跑**。動態島的關鍵順序是「殼先開、東西才落定」——
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
     * ⚠️ 延遲是 **80ms**:錯開(stagger)的延遲一般在 30–80ms,再長就會覺得慢。
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
   * 兩個要求要同時成立 ——
   *  1. 各給一個固定 `rem` 寬不行:字級 200% 時兩顆 544px,凸出 440px 的對話框;
   *  2. 平分整列(`flexGrow: 1`)也不行:不會溢出了,但只有一顆時整整 408px,太大。
   *
   * 所以用 grid 的老招:`grid-auto-columns: 1fr` 讓每一欄一樣寬,而整個 grid
   * `width: fit-content` —— 於是欄寬 = **最寬那顆的內容寬**,整組再靠 `margin-inline: auto`
   * 置中。字變大時它跟著長,但上限是 `max-width: 100%`,溢不出去。
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
    marginInline: 'auto',
  },
  photoAction: {minWidth: 0},
  /*
   * 「Default model」那一列的殼。**平常不會演** —— 清單在打開之前就備好了
   * (`peekAllowedModels()`),那一列跟其他列同一幀存在,transition 的起點與終點
   * 一樣就不會有動畫。
   *
   * 它是**慢網路時的保底**:清單晚到的話,那一列會從 0 高度長出來、把底下兩條
   * 拉桿推下去,而不是憑空插進畫面中間(那看起來很斷裂)。
   * 對話框的上緣已經被 `usePinnedDialogTop` 釘住,所以只會往下長。
   *
   * ⚠️ 這裡跟 `actionsRow` 一樣是刻意 animate 版面屬性(`grid-template-rows`)——
   * 理由同那邊:要的就是「容器真的變高」,transform 假裝不了。
   * ⚠️ `overflow: hidden` 掛在裡面那一層,grid 自己要量得到內容的完整高度。
   * ⚠️ 曲線用跟 `actionsRowOpen` 同一條 iOS 面板曲線,時間收到 225ms
   * (`--duration-medium-min`):它不是使用者按出來的,是網路慢才看得到的補救,
   * 快一點比較不擾人。
   */
  modelRow: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transition: {
      default: 'grid-template-rows var(--duration-medium-min) var(--ease-panel)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  modelRowOpen: {gridTemplateRows: '1fr'},
  modelClip: {overflow: 'hidden', minHeight: 0},
  /*
   * 這一列跟底下拉桿之間的間距。
   *
   * ⚠️ **它在 clip 的裡面,不是外層 `VStack` 的 `gap`** —— gap 是容器給的,
   * 那一列高度收成 0 的時候 gap 還在,會留下一段對不上任何東西的空白
   * (只有一個模型可選時整列不畫,那段空白就會很明顯)。收進內容裡,
   * 它就跟著內容一起被夾掉。數值與外層的 `gap={8}` 是同一個 token。
   */
  modelInner: {paddingBlockEnd: 'var(--spacing-8)'},
});

/**
 * 「Text size / 100%」那一列 + 底下的滑軌。字級與對比長得一模一樣,所以只寫一次。
 *
 * ⚠️ **`formatValue` 不能省。** 它是 Astryx 拿去填 `aria-valuetext` 的唯一來源
 * (`Slider.js`:`"aria-valuetext": formatValue ? formatValue(val) : undefined`),
 * 少了它報讀軟體只能退回 `aria-valuenow` —— 而那是**拉桿位置**不是百分比,
 * 使用者設 100% 會被念成「50」。畫面上看不出任何異狀,所以很容易在改版時弄丟。
 *
 * ⚠️ **只有一個回呼,而且它不送伺服器。** 存檔(本機與伺服器)在「關掉的那一刻」
 * 一次做完 —— 拖一次不會連發幾十個 PUT,一次設定只送一次。
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
   * `pointermove` 都重繪整個對話框(頭像、模型那排、兩條拉桿、footer),
   * 主執行緒會被卡住好幾秒。住在這一層,一個 move 只重繪這一條拉桿。
   *
   * ⚠️ 外面那個值仍然要**即時**送出去(`onChange`)—— 畫面要跟著拉桿變;
   * 只是呼叫端不拿它 `setState`(見 `applyLive`)。
   *
   * ⚠️ **`value` 只是初值。** 拖曳中它不會變(呼叫端刻意不 `setState`),
   * 所以外面要把拉桿拉回某個位置**只有換 `key` 這一條路** —— Reset 那顆鈕
   * 就是這樣做的(`resetNonce`)。不要改成「相依 `value` 的同步 effect」:
   * Reset 按下去時 `fontScale` 這個 state 本來就已經是 100(拖曳沒動過它),
   * effect 因此不會跑 —— 字級回到 100% 了,拇指卻還停在原本的位置上。
   */
  const [pos, setPos] = useState(() => valueToSliderPosition(value));
  return (
    /* `data-settings-slider` 給 global.css 認的(非拖曳時拇指滑過去的過場)。 */
    <VStack
      gap={1}
      data-settings-slider
      {...(drag.isDragging ? {'data-dragging': ''} : {})}
      {...drag.handlers}
    >
      {/*
        ⚠️ **只畫標籤,不畫百分比**。拉桿本身就畫得出位置;數字的**絕對值**沒有用:
        下限是 50 不是 0(字級 0 的畫面連把它調回來的拉桿都看不見,見
        `lib/displayPrefs.ts`),所以「最左邊 = 50%」怎麼看都怪。
        「回到預設」有 Reset 那顆鈕。

        ⚠️ **`aria-valuetext` 仍然留著**(見下面的 `formatValue`)——
        用報讀軟體的人本來就沒有「看拇指在哪」這條路,數字是他唯一的資訊。
        視覺上拿掉、無障礙樹上留著,不是同一件事。
      */}
      <Text type="label" aria-hidden>
        {label}
      </Text>
      <Slider
        label={label}
        isLabelHidden
        valueDisplay="none"
        /*
         * ⚠️ **`formatValue` 不能省,而且它是百分比的唯一出口。**
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
   * 裁好、按過 OK、但還沒按 Done 的那一張。null = 沒挑過(顯示目前那張)。
   * 裁切的 OK 只收進草稿,真正存檔是 Done。
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
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * 釘住的上緣。還沒量到時是 undefined,先讓它照原本的方式置中。
   *
   * ⚠️ 為什麼要釘(長出 OK / Cancel 時只往下長):`<dialog>` 是 `inset: 0` + `margin: auto` **垂直置中**的,
   * 所以高度一變,上下兩邊會**同時**往外長 —— 看起來就是整個視窗在上下呼吸。
   * 把 `margin-block-start` 換成固定值、`margin-block-end` 留 `auto`,
   * 多出來的空間就全部落在下面,於是只往下長。
   * ⚠️ `margin-inline` 不要動,水平還是要置中。
   *
   * 實作在全站共用的 `usePinnedDialogTop`(含「往下長到碰到視窗底才讓上緣往上」的保護,
   * 矮視窗裡長出確認列才不會把 Done 推出畫面外)。量法與理由寫在那支 hook 裡。
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
   * 關掉這個對話框。**四條路(Done / X / Esc / 點背景)全部走 `exit.requestClose`。**
   *
   * 退場本身收在 `useDialogExit` 裡(全站共用)—— 為什麼不能直接
   * `onOpenChange(false)`、為什麼 `prefers-reduced-motion` 不在 JS 這一側分支,
   * 都寫在那支 hook 與 `global.css` 的 `[data-leaving]` 那一段。
   */
  const exit = useDialogExit(onOpenChange);

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
   * ⚠️ **寫它的地方只有 `applyLive` 一支**。拖曳**不動** `fontScale` / `contrast`
   * 這兩個 state,所以不能靠「相依那兩個 state 的 effect」來同步它 ——
   * 把 `applyLive` 裡那一行刪掉就會靜靜地送出舊值。
   */
  const liveRef = useRef({fontScale: initial.fontScale, contrast: initial.contrast});

  /*
   * ⚠️ **套用的時機是「開著的那個實例被卸載」,不是按 Done。**
   *
   * 關掉的路有四條(Done / 右上角的 X / Esc / 點背景),四條都會讓側邊欄把
   * `isSettingsOpen` 轉成 false,而那邊掛著 `key={isSettingsOpen ? 'open' : 'closed'}`
   * —— 也就是四條都一定會走到卸載。掛在 `save()` 裡的話,另外三條就會靜靜地
   * 把使用者剛拉好的字級丟掉。
   *
   * ⚠️ **`if (!isOpen) return;` 那一行不能拿掉**:
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
       * ⚠️ **本機那一份也在這裡寫。** 拖曳的每一個 pointermove 都寫 localStorage 的話,
       * `setItem` 是同步 I/O,等於把磁碟寫入掛在拖曳的每一幀上。
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
   * 按了 OK:把裁切結果收進草稿,回到一般的頭像顯示。**還沒送出去** ——
   * 真正存檔仍然是 footer 那顆 Done。
   */
  const applyCrop = () => {
    if (!cropSource || !crop) return;
    let dataUri: string;
    try {
      dataUri = avatarCropToDataUri(cropSource, crop);
    } catch (err) {
      toastError(err instanceof AvatarImageError ? err.message : 'That image could not be read.');
      // ⚠️ 失敗要**留在裁切模式**(`return` 之後不要碰 cropSource)——
      // 踢出去的話他既不知道發生什麼事,也沒有東西可以重試。
      return;
    }
    setDraftAvatar(dataUri);
    setCropSource(null);
    setCrop(null);
  };

  /** 挑好的那張先不要了 —— 回到目前的頭像。原圖由 effect 的 cleanup 收。 */
  const cancelCrop = () => {
    setCropSource(null);
    setCrop(null);
  };

  const save = async () => {
    if (busy) return;
    // 還在裁切時 Done 是關掉的(見下面那顆鈕),這裡只是最後一道保險
    if (cropSource) return;
    const nextAvatar = draftAvatar;

    setBusy(true);
    try {
      // ⚠️ 字級/對比**不在這裡送** —— 四條關閉路徑共用同一支(見上面那支 effect)。
      // 這裡只處理頭像:它是唯一「失敗一定要讓使用者知道」的一項。
      if (nextAvatar !== null) {
        await saveAvatar(nextAvatar);
        onIdentityChanged();
      }
      exit.requestClose();
    } catch {
      /*
       * ⚠️ **不要用 `errorMessage(err, …)` 把後端的 detail 透出來**:
       * `backend/app/routers/auth.py` 的訊息整組是中文(登入頁那些也是),
       * 透出來就會在這個英文對話框裡冒出一句中文。這裡固定講英文,
       * 代價是看不到後端的細節 —— 那本來也不是給使用者看的。
       */
      /*
       * ⚠️ 「換小張一點」只在**真的有換照片**時才講得通。不分情況都講的話,
       * 只調了字級或對比、根本沒碰照片的人存檔失敗時,看到的是一句
       * 要他換張小照片的建議 —— 對他來說那句話毫無意義,還會讓他以為
       * 是自己哪裡弄錯了。
       */
      toastError(
        nextAvatar !== null
          ? 'Settings could not be saved. Try a smaller photo.'
          : 'Settings could not be saved. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const removeAvatar = async () => {
    setBusy(true);
    try {
      await saveAvatar(null);
      setDraftAvatar(null);
      onIdentityChanged();
    } catch {
      // 同上:固定英文,不透後端的中文 detail
      toastError('The photo could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 拖曳路徑用這一支:**即時套到畫面上**(`<html>` 的字級 / `--user-contrast`),
   * **但不重繪這個對話框**(效能)。
   *
   * 外面那個 app 會當場跟著變 —— 而這塊面板不會,因為它把那些 `rem` token
   * 釘成固定 px 了(見 `pinnedTokens`)。
   *
   * 拇指位置住在 `PercentSlider` 自己身上,對話框不需要知道拖到哪裡 ——
   * 它只要在關掉的時候存得到最後的值,而那份走 `liveRef`。
   * 在這裡 `setFontScale` / `setContrast` 的話,每一個 `pointermove` 都會重繪整個對話框。
   *
   * ⚠️ **送伺服器不在這裡** —— 拖一次會觸發幾十個事件。改在對話框關掉時送一次,
   * 見上面那支 effect。
   * ⚠️ `liveRef` 要在這裡寫,不能靠「相依 state 的 effect」—— 沒有 state 變動
   * 就沒有那次 effect,關掉時會送出使用者打開時的舊值。
   */
  const applyLive = (next: {fontScale?: number; contrast?: number}) => {
    setDisplayPrefs(next);
    liveRef.current = {...liveRef.current, ...next};
  };

  /**
   * Reset 那顆鈕走這一支:**要重繪**,因為兩條拉桿得跳回預設的位置
   * (它們的 `value` prop 就是這兩個 state;拉桿靠換 `key` 從 `value` 重新起算,見 `resetNonce`)。
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
   * 吉祥物。跟模型同一種待遇:按下去右下角那隻當場換掉(不用等 Done),
   * 存伺服器失敗靜默 —— 只影響換一台電腦時的預設。
   */
  const companion = useCompanion();
  const chooseCompanion = (next: string) => {
    // SegmentedControl 給的是字串;只收認得的值(不要硬轉型別)
    if (!isCompanion(next)) return;
    setCompanion(next);
    void saveCompanion(next);
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

  return (
    <Dialog
      isOpen={isOpen}
      {...exit.dialogProps}
      purpose="info"
      width={DIALOG_WIDTH}
      ref={pin.ref}
      style={
        {
          ...pinnedTokens,
          ...pin.style,
        } as React.CSSProperties
      }
    >
      <Layout
        header={
          <DialogHeader
            title="Settings"
            onOpenChange={exit.dialogProps.onOpenChange}
          />
        }
        content={
          <LayoutContent>
            {/*
              真正的檔案輸入藏起來:原生的樣子跟設計系統對不上,但它仍然要在
              DOM 裡才點得開。
              ⚠️ **放在裁切模式的外面**(一直掛著)—— 見底下那支擋 `cancel`
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
            {/* 範本的節奏:區塊之間 gap 8、區塊**內部** gap 0(行距由每列自己的
                paddingBlock 撐開,不是靠 VStack 的 gap) */}
            <VStack gap={8}>
              {/*
                頭像**置中**。跟按鈕並排靠左的話,頭像變成一列裡的一個元素;
                它是這個對話框的主角,置中才像「這是我」。
              */}
              <VStack gap={2}>
                  {/*
                    ⚠️ **挑了照片之後就地變成可以調的圓形預覽,不換頁**:
                    圓形預覽長在頭像原本的位置,底下多一條 Zoom 拉桿,
                    其餘幾列(模型、字級、對比)原封不動,按 Done 一起存。
                  */}
                  {isCropping ? (
                    <AvatarCropper
                      source={cropSource}
                      crop={crop}
                      onCropChange={setCrop}
                      xstyle={styles.photoStage}
                    />
                  ) : (
                    <Center axis="horizontal" xstyle={styles.photoStage}>
                      {/*
                        ⚠️ **控制項長在頭像上,不是底下一排按鈕**。沒照片時是一顆「+」,
                        有照片時是「改」與「刪」(刪是紅的)。

                        ⚠️ 兩條無障礙的線一定要顧:
                         1. 焦點進來也要現身(不只 hover)—— 不然用鍵盤的人會 Tab 到
                            一顆看不見的按鈕上;`onFocus`/`onBlur` 判 `relatedTarget`,
                            跟側邊欄那一列的做法同一套。
                         2. 沒有精準指標的裝置**一律顯示** —— 觸控沒有 hover,
                            只靠 hover 的話這兩顆永遠碰不到(見 `canHover`)。
                      */}
                      <Stack
                        xstyle={styles.avatarSlot}
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
                                   疊在這層深色遮罩上等於黑底黑字,完全看不見。
                                   實心鈕在深淺兩套佈景下都跟遮罩分得開。 */
                                variant="primary"
                                size="sm"
                                isDisabled={busy}
                                onClick={() => fileRef.current?.click()}
                              />
                              <IconButton
                                label="Remove photo"
                                icon={<Icon icon={Trash2} size="sm" />}
                                variant="destructive"
                                size="sm"
                                isDisabled={busy}
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
                              isDisabled={busy}
                              onClick={() => fileRef.current?.click()}
                            />
                          )}
                        </Stack>
                      </Stack>
                    </Center>
                  )}
                  {/*
                    裁切時的 OK / Cancel —— **從頭貼底下長出來**,做法見
                    `styles.actionsRow`。⚠️ 不要改成「平常也把高度留著」:
                    那會讓頭貼離 Default model 太遠。
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
                          onClick={cancelCrop}
                        />
                        <Button
                          label="OK"
                          variant="primary"
                          size="sm"
                          xstyle={styles.photoAction}
                          onClick={applyCrop}
                        />
                      </HStack>
                    </Stack>
                  </Stack>
                </VStack>

                {/*
                  ⚠️ **模型那一列與兩條拉桿要包在同一層裡**,而且這一層**沒有 gap**
                  —— 它們之間的間距由模型那一列自己帶(`modelInner` 的
                  `paddingBlockEnd`),這樣清單還沒到、那一列高度是 0 的時候,
                  間距會跟著一起不見。用外層 `VStack` 的 gap 的話,那段空白會留著。
                */}
                <Stack>
                  {/*
                    常用模型。沒設過的預設是 Sonnet ——
                    跟後端的 `default_model` 是兩件事(見 `lib/modelPref.ts`)。
                    ⚠️ 只有一個模型可選的時候整列不畫,跟輸入框上那顆鈕同一條規則:
                    一個選項的選擇器只是在佔位置。
                    ⚠️ 清單晚到時是**長出來**而不是插進去,見 `styles.modelRow`。
                    ⚠️ **裡面那塊仍然是條件渲染**:沒有選項的 `SegmentedControl`
                    不該存在(它要有 `value` 對得上的子項才成立)。殼一直在,
                    內容掛上去的同一幀殼也翻成 `1fr` —— 長出來的是殼,
                    露出來的是剛掛上的內容。
                  */}
                  <Stack xstyle={[styles.modelRow, hasModelRow && styles.modelRowOpen]}>
                    <Stack xstyle={styles.modelClip}>
                      {hasModelRow ? (
                        <VStack gap={1} xstyle={styles.modelInner}>
                          {/* 跟拉桿同一個理由對報讀軟體隱藏:SegmentedControl 自己
                              帶著 `label`,不藏會被念兩次 */}
                          <Text type="label" aria-hidden>
                            Default model
                          </Text>
                          <SegmentedControl
                            label="Default model"
                            layout="fill"
                            value={model}
                            onChange={chooseModel}
                            isDisabled={busy}
                          >
                            {(models ?? []).map((m) => (
                              <SegmentedControlItem key={m} value={m} label={modelLabel(m)} />
                            ))}
                          </SegmentedControl>
                        </VStack>
                      ) : null}
                    </Stack>
                  </Stack>

                  {/*
                    ⚠️ 這兩條**刻意不用** Astryx 的「Formatted Value」版型
                    (label + `valueDisplay="text"`):那個版型把數值貼在滑軌右邊,
                    滑軌因此比對話框窄一截、兩側留白不對稱,100% 看起來還是沒置中。
                    自己畫標籤那一列、滑軌只留軌道,左右留白才相等。

                    版型與 `formatValue` 的細節都收在 `PercentSlider` 裡(見它的說明)——
                    兩條拉桿一模一樣,共用一份才不會其中一條漏掉 `formatValue`。
                  */}
                  <VStack gap={6}>
                    {/* 右下角的吉祥物。版型照上面 Default model 那一列(label 對報讀軟體隱藏,
                        SegmentedControl 自己帶著 `label`)。底下接預覽台 + Bloub 的型態 / 顏色
                        (`CompanionLook`)。Suspense 的 fallback 是空的:
                        引擎通常已經被右下角那隻載過了,等不到一格。 */}
                    <VStack gap={0}>
                      <VStack gap={1}>
                        <Text type="label" aria-hidden>
                          Companion
                        </Text>
                        <SegmentedControl
                          label="Companion"
                          layout="fill"
                          value={companion}
                          onChange={chooseCompanion}
                          isDisabled={busy}
                        >
                          {COMPANIONS.map((c) => (
                            <SegmentedControlItem key={c} value={c} label={COMPANION_LABELS[c]} />
                          ))}
                        </SegmentedControl>
                      </VStack>
                      <Suspense fallback={null}>
                        <CompanionLook companion={companion} isDisabled={busy} />
                      </Suspense>
                    </VStack>
                    {/* ⚠️ `key` 帶 `resetNonce`:那是 Reset 把拇指拉回預設的唯一路徑,
                        見 `PercentSlider` 裡 `pos` 的說明。 */}
                    <PercentSlider
                      key={`text-${resetNonce}`}
                      label="Text size"
                      value={fontScale}
                      /* ⚠️ 走 `applyLive` 不是 `setLocal` —— 拖曳路徑不重繪對話框 */
                      onChange={(v) => applyLive({fontScale: v})}
                    />
                    <PercentSlider
                      key={`contrast-${resetNonce}`}
                      label="Contrast"
                      value={contrast}
                      onChange={(v) => applyLive({contrast: v})}
                    />
                  </VStack>
                </Stack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            {/* ⚠️ `LayoutFooter` 不會幫子層加間隔 —— 裸放兩顆鈕就是貼在一起。
                靠右:跟全站其他對話框一致(Astryx 對話框慣例) */}
            <HStack gap={2} hAlign="end">
              {/* ⚠️ 這兩顆**不隨裁切模式換掉** —— 裁切的取消長在頭像底下那一排,不在這裡。 */}
              <Button
                label="Reset"
                variant="secondary"
                isDisabled={busy}
                onClick={() => {
                  setLocal({fontScale: FONT_SCALE_DEFAULT, contrast: CONTRAST_DEFAULT});
                  // ⚠️ 換 key 讓兩條拉桿重新從預設值起算 —— 少了這一行,字級真的
                  // 回到 100% 了,拇指卻還停在剛剛拖到的位置。
                  setResetNonce((n) => n + 1);
                }}
              />
              {/* ⚠️ **裁切中要把 Done 關掉。** 他正在調位置,按 Done 的意思不明確 ——
                  而且「什麼都沒發生」比「按不下去」更難懂。要收工就先按圓圈底下
                  那兩顆 OK / Cancel。 */}
              <Button
                label="Done"
                variant="primary"
                isLoading={busy}
                isDisabled={isCropping}
                onClick={() => void save()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
