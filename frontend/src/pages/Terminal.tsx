/**
 * SSH 終端機 `/ssh`。
 *
 * 這一層是**頁籤管理者**:一個外框、上面一排頁籤,每一個頁籤是一條獨立的連線
 * (`components/terminal/TerminalSession.tsx` 才是連線本體)。
 *
 * ⚠️ **進來不自動連**:要使用者點選主機才連線。
 * 一個頁籤有兩種狀態:還沒選主機(畫 `HostStage` 的主機卡片)、選好了(掛 `TerminalSession`)。
 * 「＋」開的也是一個沒選主機的頁籤,不是直接連。
 *
 * - **可以同時開好幾條**,上限由後端說了算(`SSH_TERMINAL_MAX_SESSIONS`,預設 4);
 *   滿了後端回 4429,那一個頁籤自己會顯示「最多同時開 N 條」。
 * - **切頁籤不斷線**:不在畫面上的頁籤用 `hidden` 藏起來,**不是** unmount ——
 *   unmount 等於斷線,那樣切回來就要重連,分頁就沒有意義了。
 * - 離開這一頁(換到對話、後台)才全部斷線:所有 `TerminalSession` 一起 unmount。
 * - 畫面上**沒有任何操作說明**:圖示鈕一律只給 `label`(報讀用),**不給 `tooltip`**。
 * - 畫面上**沒有**狀態標籤、倒數、中斷鈕:工具列只有字級 A−/A+、檔案欄開關、
 *   **AskME、全螢幕**(依這個順序),它們作用在**目前這個頁籤**上。
 * - **分割畫面是把頁籤拖到邊上**,工具列上沒有分割鈕。拖到左 / 右 = 左右分割,
 *   拖到上 / 下 = 上下分割,拖回中間 = 回到單頁。
 * - 頁籤上只寫主機名(`deploy@app-server`),不寫 `— bash`。
 * - 沒權限的人看到的是「只開放給工程師」,不是 404;真正的擋在後端的 WebSocket。
 *
 * ⚠️ 這一頁的**內容是中文**,跟四個管理頁同一個例外;
 * 側邊欄那一列 `SSH Server` 照慣例是英文。
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import * as stylex from '@stylexjs/stylex';

import {AlertDialog} from '@astryxdesign/core/AlertDialog';

import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Toolbar} from '@astryxdesign/core/Toolbar';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {Lock, Maximize2, PanelLeft, Plus, Server, X} from 'lucide-react';

import {Logo} from '../components/Logo';
import {useDialogExit} from '../components/useDialogExit';
import {HostLogin} from '../components/terminal/HostLogin';
import {HostStage} from '../components/terminal/HostStage';
import {morph} from '../components/terminal/morph';
import {showsPicker, watchesIdle} from '../components/terminal/pickerState';
import {TerminalSession} from '../components/terminal/TerminalSession';
import {listTerminalHosts, type TerminalHost, type TerminalStatus} from '../lib/terminalApi';
import {registerBusySource} from '../lib/unsavedWork';
import {MOBILE_QUERY, useMediaQuery} from '../lib/media';
import {useThemeMode} from '../lib/theme';
import {personName} from '../lib/people';
import {readString, writeString} from '../lib/safeStorage';
import {useMe} from '../lib/useIdentity';

/**
 * 工具列那顆 AskME 的 logo 大小(px)。**跟 `Icon size="sm"` 同高**,
 * 不然它會比旁邊那幾顆圖示鈕大一圈(跟 `TerminalView` 的 `QUOTE_LOGO_PX` 同一個值)。
 */
const ASKME_LOGO_PX = 16;

/**
 * 幾毫秒沒有任何動作就蓋上**螢幕保護**(3 分鐘)。
 *
 * ⚠️ 這**不是斷線**:連線還在,點回那台主機就繼續(不重連)。後端的閒置斷線
 * `SSH_TERMINAL_IDLE_TIMEOUT_SEC` 預設 0(不斷);在 .env 填了秒數的話,
 * 那一刻不問直接斷 —— 兩個數字要一起看,填的值要大於這裡的 3 分鐘。
 */
const SCREENSAVER_IDLE_MS = 3 * 60 * 1000;

/**
 * 左右分割要的最小視窗寬。**只管左右那一種** ——
 * 上下分割是把高度切兩半,跟視窗寬沒有關係。
 *
 * 低於這條線,兩邊各只剩約 40px,終端機的字變成一行一個 —— 那不是
 * 「擠一點」,是完全不能用。1024 的算法:每一半約 500px,
 * 扣掉 220 的檔案欄(`SPLIT_FILES_PX`)還有 280 給終端機,大約 40 個字寬,
 * 是還讀得下去的下限。
 *
 * ⚠️ **跟 `MOBILE_QUERY` 的 768 無關**,不要去對齊它 —— 那條線問的是「是不是手機版
 * (側邊欄收進抽屜)」,這條問的是「放不放得下兩個終端機」,兩個不同的問題。
 */
const SPLIT_MIN_WIDTH = '(min-width: 1024px)';

/**
 * 左右兩塊落點各佔多寬(上下與中間那三塊就從這裡讓開)。
 * 28% 是**三塊排得下、每一塊又都戳得到**的比例:兩邊各 28%,中間剩 44% 給上 / 下 / 中。
 * ⚠️ 視窗不夠寬**不畫**左右那兩塊(見 `zoneRows`),那時候上 / 下 / 中會自己拉滿整排 ——
 * 亮起來卻放不下去的落點比沒有落點更糟。
 */
const ZONE_SIDE = '28%';

const FONT_KEY = 't100_terminal_font';
/**
 * 最後連過的那一台。**只記 id,不自動連** —— 要的是「少一步」,不是「一進來就連上去」。
 * 進選主機的畫面時焦點就落在它那張卡片上,所以鍵盤直接按 Enter 就是連它。
 */
const LAST_HOST_KEY = 't100_terminal_last_host';
/**
 * 分頁上「已斷線」那三個字。**位置永遠留著,字平常是透明的。**
 *
 * ⚠️ 跟「× 永遠畫」同一個處方(見分頁 JSX 裡那段註解):字出現時整排頁籤會跳一下,
 * 而這一則的觸發源更糟 —— `isLive` 是後端推的,隨時可能發生,而且滑鼠可能正停在某顆 × 上。
 * 代價是每個分頁永遠寬三個字。
 *
 * ⚠️ 為什麼要有這個常數:要留位置就得**在還沒斷線的時候**就知道最寬的那個字串長什麼樣,
 * 而 `tabStatus()` 那時候回的是空字串,拿不到。
 * ⚠️ `tabStatus()` 的 error 那一支**直接用這個常數**,不要各寫一份 ——
 * 兩份字串沒有任何測試或型別在守。
 */
const TAB_OFFLINE_TEXT = '已斷線';
const FONT_MIN = 12;
const FONT_MAX = 20;
const FONT_DEFAULT = 14;
function readFont(): number {
  const n = Number(readString(FONT_KEY));
  return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT;
}

const styles = stylex.create({
  page: {
    height: '100%',
    minHeight: 0,
    paddingBlock: 'var(--spacing-5)',
    paddingInline: 'var(--spacing-6)',
    boxSizing: 'border-box',
  },
  /**
   * 一個外框:頁籤列 + 工具列 + (目前那個頁籤)。**有終端機的時候整塊都是深色的**;
   * 選主機的時候跟著網站的淺 / 深色走,底下三隻腳一起拿掉(見 `windowIsDark` 與 `styles.windowFollowsPage`)。
   *
   * ⚠️ **怎麼變深色的,在 dev 與正式 build 上是兩條不同的路,兩條都要鋪**
   * (少一條的話,正式 build 在淺色模式下整頁白底白字)。
   *
   * 1. `color-scheme: dark` —— dev 的 CSS 裡 `light-dark()` 是原封不動的,這一行就夠了:
   *    底下每一個 token 都在這一層解成深色的那一半。
   * 2. `--lightningcss-light` / `--lightningcss-dark`(掛在元素上,見 JSX)—— **正式 build**
   *    會被 Lightning CSS 降級,`light-dark(#f1f1f1, #1b1b1b)` 變成
   *    `var(--lightningcss-light,#f1f1f1) var(--lightningcss-dark,#1b1b1b)`,而那兩個開關
   *    **只設在 `<html>` 上**(`:where(html[data-theme=dark])` 那幾條)。也就是說正式 build 上
   *    `color-scheme` 對底色**完全沒有作用** —— 要換成深色只能把開關翻過來。
   * 3. `data-astryx-theme="neutral"`(見 JSX)—— 光翻開關還不夠:token 是在 `<html>` 那一層
   *    **算完才繼承下來的**(`var()` 在宣告的那個元素上就被取代掉了,這一層讀到的已經是
   *    `#f1f1f1` 這種算好的值)。把佈景根的記號掛在這一層,整組 token 會在這裡**重新宣告一次**,
   *    那一次才會看到我們翻好的開關。
   *
   * ⚠️ **不要掛 `data-astryx-media="dark"`**。它只改
   * `--color-text-primary` / `--color-icon-primary` / `--color-accent` 三個,**不改底色** ——
   * 上面第 2 點成立的時候,它做的事情剛好是「把字塗白、底色留著」,那就是白底白字。
   * 深色是整組一起翻的,壞掉的時候也是整組一起壞(深字淺底,難看但看得見)。
   */
  window: {
    flex: '1 1 0',
    minHeight: 0,
    colorScheme: 'dark',
    backgroundColor: 'var(--color-background-body)',
    color: 'var(--color-text-primary)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border-emphasized)',
    borderRadius: 'var(--radius-element)',
    overflow: 'hidden',
  },
  /**
   * 選連線的時候(看得到的全是主機卡片、或螢幕保護)**跟著網站的淺 / 深色走**,不強制深色。
   * 只有終端機本身是深色的。
   */
  // 只在網站是淺色時才套(深色時 windowIsDark 本來就是 true),所以直接寫 light
  windowFollowsPage: {colorScheme: 'light'},
  // ⚠️ **不要加 paddingInline**:Astryx `Section` 會把它算進自己的邊框盒,
  // `dividers` 那條線就會比底下的內容短一截(檔案欄那條同一個坑)。
  head: {
    flex: 'none',
    backgroundColor: 'var(--color-background-surface)',
    fontFamily: 'var(--font-family-code)',
  },
  // 頁籤列吃剩下的寬度,而且會讓位 —— 開四個頁籤也不能把右邊那幾顆鈕擠出畫面
  tabs: {minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none'},
  tab: {
    flex: 'none',
    paddingBlock: 'var(--spacing-1)',
    paddingInlineStart: 'var(--spacing-2)',
    paddingInlineEnd: 'var(--spacing-1)',
    borderRadius: 'var(--radius-inner)',
    cursor: 'default',
    color: 'var(--color-text-secondary)',
    // 淡底只在真的有滑鼠的裝置上(同 `lib/media.ts` 的 HOVER_QUERY):
    // 手機上點過的頁籤會卡在假的 :hover,一直亮著,看起來像兩個頁籤都被選到
    backgroundColor: {
      default: 'transparent',
      ':hover': {default: 'transparent', '@media (hover: hover) and (pointer: fine)': 'var(--color-overlay-hover)'},
    },
    /*
     * 鍵盤焦點用 Astryx 的焦點 token(跟 FilesDialog 同寫法);滑鼠點不出現。
     * ⚠️ 框**畫在內側**(offset 為負的框線寬):外層 `tabs` 是橫向捲動容器、高度剛好等於頁籤,
     * 照 token 的 offset 往外畫會被切到只剩右邊一條。
     */
    outline: {
      default: 'none',
      ':focus-visible': 'var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)',
    },
    outlineOffset: 'calc(-1 * var(--focus-outline-width))',
    /*
     * ⚠️ 這裡的時間是**放開**那一趟(95ms):放開滑鼠是系統在回應,要快。
     * 按下去那一趟由 `tabDragging` 覆寫成 165ms —— 那是使用者的刻意動作,要慢
     *(asymmetric timing;`global.css` 的按住才刪除是同一個道理:
     * 「慢的那一趟是使用者在做決定,快的那一趟是系統在回應」)。
     */
    transitionProperty: 'opacity, background-color',
    transitionDuration: 'var(--duration-fast-min)',
    transitionTimingFunction: 'var(--ease-standard)',
  },
  tabActive: {
    color: 'var(--color-text-primary)',
    backgroundColor: 'var(--color-overlay-pressed)',
    fontWeight: 'var(--font-weight-medium)',
  },
  // 手機:分頁名稱最多這麼寬(太長就截斷,hasTruncateTooltip 看得到全名)—— 工具列整排才放得下
  tabLabel: {fontWeight: 'inherit', maxWidth: {default: null, '@media (max-width: 768px)': 'var(--spacing-12)'}},
  /*
   * 分頁上「已斷線」那三個字。**位置永遠留著,字平常是透明的**(見 `TAB_OFFLINE_TEXT`)。
   *
   * ⚠️ `visibility` 也要列進 `transitionProperty`:只給 opacity 的話,字雖然透明
   * 但仍在無障礙樹與 hit test 裡。列進去之後瀏覽器會在正確的那一端切換
   *(要顯示時立刻可見、要隱藏時等淡出跑完才隱藏)。
   */
  tabStatusText: {
    opacity: 1,
    visibility: 'visible',
    transitionProperty: 'opacity, visibility',
    transitionDuration: 'var(--duration-medium-min)',
    transitionTimingFunction: 'var(--ease-standard)',
  },
  // 手機不留「已斷線」的空位(斷線看分頁上的紅點):375 寬放不下 —— 寬螢幕永遠留著,不跳版
  tabStatusTextIdle: {opacity: 0, visibility: 'hidden', display: {default: null, '@media (max-width: 768px)': 'none'}},
  /**
   * 拖著走的那個頁籤:原地留一個淡影子,手上那份由瀏覽器畫。
   * `transitionDuration` 蓋掉 base 那個 —— 見 `tab` 上那段 asymmetric timing 的說明。
   */
  tabDragging: {opacity: 0.4, transitionDuration: 'var(--duration-fast-max)'},
  vsep: {height: 'var(--spacing-4)', marginInline: 'var(--spacing-1)'},
  // 拖放的落點蓋在這一層上,所以要 relative
  sessions: {flex: '1 1 0', minHeight: 0, position: 'relative'},
  /** 分割:兩塊排開,中間一條分隔線。左右 / 上下只差一個方向 */
  sessionsSplitRow: {flexDirection: 'row', gap: 0},
  sessionsSplitColumn: {flexDirection: 'column', gap: 0},
  sessionSplit: {flex: '1 1 0', minWidth: 0, minHeight: 0},
  /**
   * 兩塊中間那條線。**畫在後面那一塊的前緣**,不是每一塊都畫 ——
   * 而「誰是後面那一塊」由 `splitIds` 的順序說了算,不是 DOM 的順序:
   * 看不見的分頁只是 `hidden`、沒有 unmount,所以 `:first-child` 認不得
   * (順序由 `order` 表達,理由同一個)。
   */
  sessionSplitAfterRow: {
    borderInlineStartWidth: 'var(--border-width)',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: 'var(--term-border, var(--color-border))',
  },
  sessionSplitAfterColumn: {
    borderBlockStartWidth: 'var(--border-width)',
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: 'var(--term-border, var(--color-border))',
  },
  /**
   * 拖放的落點。**只在拖著頁籤的時候才畫**,平常這一層根本不存在 ——
   * 它蓋在終端機上面,留著會把滑鼠吃掉。五塊鋪滿整個區域、互不重疊:
   * 左右兩條、上下兩條(夾在左右之間)、剩下的中間是「不要分割」。
   */
  zones: {position: 'absolute', inset: 0, zIndex: 5},
  /**
   * 一塊落點的**幾何 + 一直畫著但透明的框**。亮起來的長相留給 `zoneOn`,
   * 兩份**不共用任何一個屬性**。
   *
   * ⚠️ 這是**這一對**的個案,不是整個檔案的規矩:
   * 一般的 base / 覆寫配對在這個檔案裡是好的 —— `tabActive` 覆寫 `tab` 的
   * `backgroundColor`、`tabDragging` 覆寫 `transitionDuration`,都沒問題。
   * 這一對特別之處是它的 `xstyle` 陣列中間還夾著**來自別的 `create()`** 的動態樣式
   *(`z.style`、`zoneInline(...)`),兩份碰同一個屬性時會變成「亮起來那份輸了」
   *(class 在、顏色沒變),所以這一對就別讓它們碰同一個屬性。
   *
   * ⚠️ **`outline-style` 是離散屬性,補間不了**:`outlineStyle: 'dashed'` 只寫在
   * `zoneOn` 裡的話,虛線框是啪一下出現的,而 `outline-color` 的 transition
   * 永遠跑不出可見效果。所以 style / width / offset 一直都在,動的只有顏色。
   * outline 畫在邊框盒**外面**,不佔版面;透明的時候看不見,也量不到。
   *
   * ⚠️ 顏色**不能**在這裡寫 `transparent`、在 `zoneOn` 寫 accent —— 那就變成兩份共用
   * `outlineColor`,正是上面那條規矩禁止的。改成讀一個自訂屬性 + fallback:
   * 這裡宣告的是 `outlineColor`,`zoneOn` 宣告的是 `--zone-outline`,**兩個不同的屬性**。
   */
  zone: {
    position: 'absolute',
    borderRadius: 'var(--radius-element)',
    // 用 outline 不用 border:border 會佔掉版面寬度,而這幾塊是貼著邊排的
    outlineWidth: 'var(--border-width)',
    outlineStyle: 'dashed',
    outlineOffset: 'calc(var(--border-width) * -2)',
    outlineColor: 'var(--zone-outline, transparent)',
    transitionProperty: 'background-color, outline-color',
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-standard)',
  },
  /** 滑到哪一塊就把那一塊畫出來 —— 放開之後畫面會變成這個樣子 */
  zoneOn: {
    '--zone-outline': 'var(--color-accent)',
    backgroundColor: 'var(--color-overlay-hover)',
  },
  zoneStart: {insetBlock: 0, insetInlineStart: 0, width: ZONE_SIDE},
  zoneEnd: {insetBlock: 0, insetInlineEnd: 0, width: ZONE_SIDE},
  zoneTop: {insetBlockStart: 0, height: '34%'},
  zoneBottom: {insetBlockEnd: 0, height: '34%'},
  zoneCenter: {insetBlock: '34%'},
  /**
   * 並排時每一塊自己的抬頭:一顆燈 + 主機名。
   * 並排的時候分頁列上「哪一個是作用中」失去意義(兩個都看得到),
   * 所以「這塊是誰」要寫在塊上,不然兩個終端機長得一模一樣。
   */
  paneHead: {
    flex: 'none',
    height: 'var(--spacing-8)',
    alignItems: 'center',
    gap: 'var(--spacing-2)',
    paddingInline: 'var(--spacing-3)',
    borderBlockEndWidth: 'var(--border-width)',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: 'var(--term-border, var(--color-border))',
  },
  session: {height: '100%', minHeight: 0},
  // ⚠️ 光靠 `hidden` 藏不住:Astryx 的 Stack 自己下 `display: flex`,贏過 `[hidden]` 的
  // `display: none`(兩個頁籤會上下疊在一起)。`hidden` 照樣留著 —— 那是給
  // 讀螢幕與搜尋用的語意,這一條只是把它畫掉。
  sessionHidden: {display: 'none'},
  denied: {flex: '1 1 0', alignItems: 'center', justifyContent: 'center'},
});

/**
 * 分割時哪一塊排在前面。**用 `order` 不用 DOM 順序** —— 看不見的分頁只是 `hidden`、
 * 沒有 unmount,DOM 的先後跟畫面上的左右沒有關係;而使用者把頁籤拖到哪一邊,
 * 那一邊就得是他看到的那一邊。
 */
const paneOrder = stylex.create({order: (n: number) => ({order: n})}).order;

/**
 * 上 / 下 / 中那三塊要不要讓開左右兩塊。視窗不夠寬時左右那兩塊根本不畫,
 * 這三塊就拉滿整排 —— 中間留一條戳不到的空隙沒有意義。
 */
const zoneInline = stylex.create({inline: (value: string) => ({insetInline: value})}).inline;

/** 拖到哪一塊。`center` 是「不要分割」。 */
type Zone = 'start' | 'end' | 'top' | 'bottom' | 'center';

/**
 * 兩塊分割:誰在前、誰在後、切的方向。
 * `ids` 的順序**就是畫面上的順序**(左→右 / 上→下)。
 */
type Split = {dir: 'row' | 'column'; ids: [string, string]};

/**
 * 五塊落點**一張表講完**:長什麼樣、放開之後是哪一種分割、被拖的那個排前面還是後面、
 * 鍵盤用哪一顆方向鍵到得了(Alt + 方向鍵)。
 *
 * ⚠️ `row` / `column` 與五個 zone 的分歧都讀這張表(兩組樣式、`isSplit` 的條件、
 * `isSplitPane`、`dropOnZone`),不要在各處各寫一次 switch —— 加第三種分割方式時
 * 才不會漏補。只有「每一塊自己的樣式」是各一份(CSS 沒有辦法用參數表達)。
 */
const ZONES: ReadonlyArray<{
  zone: Zone;
  /** `null` = 中間那塊,意思是「不要分割」 */
  dir: Split['dir'] | null;
  /** 被拖的那個分頁放在前面(左 / 上)還是後面(右 / 下) */
  dragFirst: boolean;
  style: stylex.StyleXStyles;
  /** Alt + 這顆方向鍵 = 拖到這一塊(鍵盤走得到,見分頁的 onKeyDown) */
  key: string;
  /** 只給報讀軟體:畫面上不寫操作說明(檔頭那條規則) */
  label: string;
}> = [
  {zone: 'start', dir: 'row', dragFirst: true, style: styles.zoneStart, key: 'ArrowLeft', label: '拖到左邊:左右分割'},
  {zone: 'end', dir: 'row', dragFirst: false, style: styles.zoneEnd, key: 'ArrowRight', label: '拖到右邊:左右分割'},
  {zone: 'top', dir: 'column', dragFirst: true, style: styles.zoneTop, key: 'ArrowUp', label: '拖到上面:上下分割'},
  {zone: 'bottom', dir: 'column', dragFirst: false, style: styles.zoneBottom, key: 'ArrowDown', label: '拖到下面:上下分割'},
  {zone: 'center', dir: null, dragFirst: true, style: styles.zoneCenter, key: 'Enter', label: '放在中間:不分割'},
];

/**
 * 一個頁籤。`hostId` 是 null 就是**還沒選主機**(那個頁籤畫的是主機卡片)。
 * 選好之後不會再變回 null —— 換主機是開另一個頁籤,不是把這一條接到別台去。
 *
 * `isLive` 是**連線現在活著沒**(連上 → true,斷了 → false)。
 * ⚠️ 跟「選過主機沒」是兩件事:螢幕保護要亮的是**還連著的**那幾台,
 * 不然後端閒置斷線之後,那台主機的卡片還在呼吸發亮。
 *
 * `hasStatus` 是**收過後端第一則狀態沒**:還沒收過 = 那一塊還是主機卡片在「連線中」(見 `pickerState.showsPicker`)。
 */
type Tab = {
  id: string;
  hostId: string | null;
  isLive: boolean;
  hasStatus: boolean;
  /** 連過之後斷掉了(連線失敗也算)—— 離開提醒不算它「開著」。重新選主機時清掉 */
  hasEnded: boolean;
  label: string;
  /** 「長成方框」的那一張(卡片與方框共用 View Transition 的名字,見 `morph`) */
  morphId: string | null;
};

/**
 * 一個分頁的指示燈長什麼樣。**兩個地方共用**:分頁列與並排時每一塊的抬頭。
 *
 * 三態不是兩態:還沒選主機的分頁畫紅點會讓人以為連線失敗,但它根本還沒連過。
 * ⚠️ `text` 是**看得見**的那行字,不是給報讀軟體的 —— `StatusDot` 不能只靠顏色
 * (設計系統自己的 Do/Don't,`pages/Users.tsx` 也照這條做)。
 * 只有「斷線」需要那個字:活著的時候旁邊就是會動的終端機,還沒選主機的時候
 * 分頁上寫的是「New connection」,兩種狀態畫面上本來就講得出來。
 */
function tabStatus(tab: Tab): {variant: 'neutral' | 'success' | 'error'; label: string; text: string} {
  if (!tab.hostId) return {variant: 'neutral', label: '還沒選主機', text: ''};
  if (tab.isLive) return {variant: 'success', label: '連線中', text: ''};
  // 還在連(方框轉圈 / 打勾):還沒連上過,不是斷線
  if (!tab.hasStatus) return {variant: 'neutral', label: '連線中', text: ''};
  // `text` 走 `TAB_OFFLINE_TEXT`:分頁上那格要**在還沒斷線的時候**就用同一個字串留位置
  return {variant: 'error', label: '已斷線', text: TAB_OFFLINE_TEXT};
}

/**
 * 這個分頁的連線**開著或正在連**沒:離開這一頁、按分頁上的 × 之前要不要先問。
 * 斷掉的(`hasEnded`)不算:連線失敗 / 斷線之後 `hasStatus` 可能還沒到,不能被當成「正在連」。
 */
function isTabOpen(tab: Tab): boolean {
  return tab.isLive || (tab.hostId !== null && !tab.hasStatus && !tab.hasEnded);
}

let nextTabId = 1;
// ⚠️ 頁籤上的字是**英文**,連上之後會換成後端給的主機標籤(deploy@app-server)。
const makeTab = (): Tab => ({
  id: `tab-${nextTabId++}`,
  hostId: null,
  isLive: false,
  hasStatus: false,
  hasEnded: false,
  morphId: null,
  label: 'New connection',
});

/**
 * `isActive`:這一頁現在看得到沒。換頁不斷線(`App.tsx` 的 `keepSsh`):去別頁時這一頁還掛著、只是藏起來 ——
 * 藏著的時候不計螢幕保護(不然問一題回來看到的是螢幕保護,不是原本的畫面)。
 */
export default function Terminal({isActive = true}: {isActive?: boolean}) {
  const me = useMe();
  // 後端照樣擋(WebSocket 握手時再驗一次)
  const canUse = me.ssh_mode === 'full';
  const isMobile = useMediaQuery(MOBILE_QUERY);
  /**
   * 視窗夠不夠寬**左右**分割。
   *
   * 視窗窄的時候兩邊各剩 40px,終端機的字變成一行一個 —— 那不是「擠一點」,
   * 是完全不能用;同理不支援三塊以上的分割。
   * 1024:每一半約 500px,扣掉 220 的檔案欄還有 280 給終端機(約 40 字),
   * 剛好是還讀得下去的下限。
   * ⚠️ **上下分割不受這條管**:那一種切的是高度,窄視窗一樣讀得下去。
   */
  const isWideEnoughToSplit = useMediaQuery(SPLIT_MIN_WIDTH);
  const themeMode = useThemeMode();
  const [fontSize, setFontSize] = useState(readFont);
  const [tabs, setTabs] = useState<Tab[]>(() => (canUse ? [makeTab()] : []));
  const [activeId, setActiveId] = useState<string | null>(null);

  /*
   * ── 離開前先問 ──────────────────────────────────────────────
   * 關分頁 / 關瀏覽器 / 重新整理 = 所有連線斷掉,跑到一半的程式跟著結束。只在**有連線開著或正在連**時問,
   * 跳瀏覽器內建的「確定要離開嗎」(`beforeunload`,字是瀏覽器的,改不了)。
   * 硬關瀏覽器、當掉、斷電時它來不及問。
   * ⚠️ **站內換頁不問、也不斷**(這一頁由 `App.tsx` 的 `keepSsh` 一直掛著,換頁只是藏起來)。
   *   不要攔連結點擊:這一頁藏著也還在,攔的話會攔到全站的每一個連結。
   */
  const openCount = tabs.filter(isTabOpen).length;
  const openCountRef = useRef(openCount);
  openCountRef.current = openCount;
  // 網站上新版時不要自動重新整理(`lib/unsavedWork`):有連線開著就算「在忙」—— 人可能在別頁、這一頁藏在背景
  // (換頁不斷線),那邊的「人在 /ssh 頁」判斷看不到它
  useEffect(() => registerBusySource(() => openCountRef.current > 0), []);
  /**
   * 分頁上的 × 按下去、那條連線還開著:先問。
   * 記 `label` 不只記 id:確認框淡出時那個分頁可能已經關掉了,內文的主機名還要在。
   */
  const [closeAsk, setCloseAsk] = useState<{id: string; label: string} | null>(null);
  const closeExit = useDialogExit((open: boolean) => {
    if (!open) setCloseAsk(null);
  });
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (openCountRef.current > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  /** 有哪幾台可以連。抓不到就是空的 —— 那時候畫面上會寫「沒有可以連的主機」。 */
  const [hosts, setHosts] = useState<TerminalHost[]>([]);
  /** 閒置的螢幕保護開著沒(見 SCREENSAVER_IDLE_MS)。**連線不受影響**。 */
  const [isLocked, setIsLocked] = useState(false);
  /**
   * 分割:**使用者把頁籤拖到哪一邊**,那兩塊就照那個方向擺。
   * `null` = 不分割,就是單一個頁籤。
   *
   * ⚠️ 存的是**明確的兩個 id 與順序**,不要改成「開關 + 自動挑兩個」。
   * 拖放這個動作本身就把「哪兩個、誰在哪一邊」講完了,再讓程式去猜一次
   * 只會跟使用者剛剛那一下打架。
   */
  const [split, setSplit] = useState<Split | null>(null);
  /** 正在拖的那個頁籤(沒在拖就是 null)—— 落點那五塊只在拖的時候才畫。 */
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  /** 滑到哪一塊落點上(拖曳中),用來把那一塊亮起來。 */
  const [hoverZone, setHoverZone] = useState<Zone | null>(null);
  /**
   * 分頁的**最近使用順序**(最新的在前)。拖一個頁籤去分割時,另一半就是這裡面
   * 最近用過、而且不是被拖的那一個 —— 使用者心裡的「另一邊」就是他剛剛在看的那個。
   * 只在切分頁 / 開分頁時動,關掉的分頁自己會從清單裡消失。
   */
  const [recentIds, setRecentIds] = useState<string[]>([]);
  /** 上次連的那一台:選主機的畫面一開始焦點在它那張卡片上。 */
  const [lastHostId] = useState(() => readString(LAST_HOST_KEY) || '');
  /**
   * 「使用者回來了」:**哪一個頁籤**、什麼時候。
   *
   * ⚠️ 不能只放時間戳廣播給所有人:後端的閒置是**一條連線
   * 一份計時**,點回 A 順手把已經閒置九分鐘的 B 也續命十分鐘的話,閒置的頁籤永遠斷不掉。
   */
  const [wake, setWake] = useState<{tabId: string; at: number}>({tabId: '', at: 0});
  /**
   * 檔案欄 / AI 欄的開關是**每個頁籤自己的**,所以用頁籤 id 當鍵。
   *
   * 兩欄共用 `usePaneToggles`(就在這個檔案下面):兩欄是同一台狀態機,
   * 差別只有「沒設定過的時候預設開不開」。
   */
  const files = usePaneToggles(!isMobile);
  const ai = usePaneToggles(false);
  /**
   * 同時能開幾條、AI 助手在不在 —— 都是**後端在 status 裡說的**(只有那一份,前端不寫死)。
   * 第一條連上之前不知道,那時候 + 照樣能按;真的超過後端會回 4429,那個頁籤自己會顯示原因。
   */
  const [limits, setLimits] = useState<{maxSessions: number; aiEnabled: boolean} | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const canAddTab = !limits || tabs.length < limits.maxSessions;
  const aiAvailable = limits?.aiEnabled ?? true;
  /** 目前這個頁籤**連上主機了沒**。還在選主機的話,檔案欄 / AskME 那幾顆沒有對象可以作用。 */
  const activeHasSession = tabs.some((t) => t.id === activeId && !!t.hostId);

  /*
   * **永遠至少有一個頁籤**(關掉最後一條連線要回到選主機的畫面,不是黑畫面)。
   * `tabs` 的初始值是在還不知道有沒有權限的時候算的 —— 權限晚一步回來的話,
   * 這裡補上那個頁籤,不然畫面會是空的。`closeTab` 那頭也保證不會關到零個。
   */
  useEffect(() => {
    if (canUse && !tabs.length) setTabs([makeTab()]);
  }, [canUse, tabs.length]);

  // 第一個頁籤(或關掉目前那個之後)沒有人是 active 的話,補上
  useEffect(() => {
    if (!activeId && tabs.length) setActiveId(tabs[0].id);
  }, [activeId, tabs]);

  // 有哪幾台可以連。清單本身是部署設定,不會在使用中變,進來抓一次就好
  useEffect(() => {
    if (!canUse) return;
    let alive = true;
    void listTerminalHosts().then(
      (rows) => {
        if (alive) setHosts(rows);
      },
      () => {
        // 抓不到就維持現有的清單(第一次就抓不到 = 空清單:畫面上會寫「沒有可以連的主機」)
      },
    );
    return () => {
      alive = false;
    };
  }, [canUse]);

  /**
   * 閒置計時。任何一條連線有動作就重算;什麼時候才計時見底下 `watchIdle`。
   */
  const idleTimer = useRef(0);
  /** 最新的「要不要計閒置」(見底下 `watchIdle`)。bumpIdle 是固定的函式,從這裡讀才不會拿到舊值 */
  const watchIdleRef = useRef(false);
  const bumpIdle = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    setIsLocked(false);
    // ⚠️ 不該計的時候(選主機、撥接中、分割的另一塊還在選主機)**按鍵也不重新開始算** ——
    // 只擋「開始計時」那一步的話,打過一個字照樣三分鐘後蓋上來
    if (watchIdleRef.current) {
      idleTimer.current = window.setTimeout(() => setIsLocked(true), SCREENSAVER_IDLE_MS);
    }
  }, []);

  useEffect(() => {
    writeString(FONT_KEY, String(fontSize));
  }, [fontSize]);

  // 檔案欄跟著斷點走:手機上預設收起(抽屜會蓋住終端機),桌機預設展開。
  // 只在**跨過**斷點時把手動開關清掉,平常不搶使用者按的。
  const wasMobile = useRef(isMobile);
  useEffect(() => {
    if (wasMobile.current === isMobile) return;
    wasMobile.current = isMobile;
    files.reset();
  }, [isMobile]);


  const addTab = () => {
    if (!canAddTab) return;
    const tab = makeTab();
    setTabs((rows) => [...rows, tab]);
    setActiveId(tab.id);
  };

  /**
   * 在選主機的畫面上點了一台主機。
   *
   * - 平常(那個頁籤還沒選主機):把主機填進去,`TerminalSession` 這時才掛上去、才連。
   * - 螢幕保護時:意思是「回到那條連線」—— 切到那個頁籤、把畫面還給它,**不重連**。
   */
  const pickHost = (hostId: string) => {
    if (isLocked) {
      const tab = tabs.find((t) => t.hostId === hostId && t.isLive);
      if (tab) setActiveId(tab.id);
      bumpIdle();
      // 「我回來了」也要讓**後端**重算閒置計時 —— 這一下沒有鍵盤輸入也沒有檔案操作,
      // 不送的話它會接著原本的計時走完。**只叫醒回去的那一條**。
      if (tab) setWake({tabId: tab.id, at: Date.now()});
      return;
    }
    const host = hosts.find((h) => h.id === hostId);
    if (!host || !activeId) return;
    // 記下來給**下一次**用(這一次的畫面不重排「上次」那張的焦點,
    // 不然按下去的那一瞬間標記會跳到剛按的那顆上,看起來像點錯了)。
    writeString(LAST_HOST_KEY, host.id);
    // 卡片「長成」方框。先讓這張卡片帶上 View Transition 的名字、拍完舊畫面,再換成方框 ——
    // 瀏覽器自己補中間(見 `morph`)。方框只轉圈、直接連
    const id = activeId;
    flushSync(() => setTabs((rows) => rows.map((t) => (t.id === id ? {...t, morphId: host.id} : t))));
    morph(() =>
      setTabs((rows) =>
        rows.map((t) => (t.id !== id ? t : {...t, hostId: host.id, hasEnded: false, label: 'Connecting…'})),
      ),
    );
  };

  /**
   * 點了某個分頁。
   *
   * ⚠️ 點的是**不在分割裡**的那一個就順手把分割收掉 —— 不收的話畫面完全不動
   * (分割時看得見的只有那兩塊),而工具列的檔案欄 / AskME 會去切一條看不見的連線。
   * 分割裡的那兩個照舊:點它只是把工具列的對象換過去。
   */
  const activateTab = (id: string) => {
    setActiveId(id);
    if (split && !split.ids.includes(id)) setSplit(null);
  };

  /**
   * 關掉一個頁籤。
   *
   * ⚠️ **關到最後一個就換一張新的選主機畫面回來**,不是留一顆「開一條連線」在黑畫面上。
   * 關掉連線之後想做的事幾乎只有一件 —— 連下一台,那就直接給選主機的畫面。
   */
  const closeTab = (id: string) => {
    const at = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    // 這個頁籤的開關狀態一起清,不然開關幾十次會留幾十個死鍵
    files.forget(id);
    ai.forget(id);
    if (!rest.length) {
      const fresh = makeTab();
      setTabs([fresh]);
      setActiveId(fresh.id);
      return;
    }
    setTabs(rest);
    // 關掉的是目前這個就**跳到前一個**;
    // 關的是第一個就只好往後找
    if (activeId === id) setActiveId(rest[at - 1]?.id ?? rest[at]?.id ?? null);
  };

  /** 切到哪個分頁就把它排到最近使用的最前面(分割時「另一半」挑的就是它)。 */
  useEffect(() => {
    if (!activeId) return;
    setRecentIds((ids) => (ids[0] === activeId ? ids : [activeId, ...ids.filter((i) => i !== activeId)]));
  }, [activeId]);

  /**
   * 分割的**兩塊都還在**沒。收掉分割的 effect 與「現在生不生效」(`isSplit`)讀的是
   * 同一份答案,不要各寫一遍。
   */
  const isSplitAlive = !!split && split.ids.every((id) => tabs.some((t) => t.id === id));

  /**
   * 分割的兩塊有一塊被關掉了就整個收掉 —— 剩一塊的「分割」只是一條沒有意義的線。
   * ⚠️ 拿掉的是**狀態**不只是「不生效」:留著的話使用者再開一個新分頁,
   * 畫面會自己跳回一個他早就關掉的組合。
   */
  useEffect(() => {
    if (split && !isSplitAlive) setSplit(null);
  }, [split, isSplitAlive]);

  /**
   * 視窗縮到左右擺不下時**把分割關掉**,不是只讓它不生效。
   *
   * ⚠️ 只讓它不生效的話會卡住:畫面回到單頁,狀態還在,
   * 使用者關不掉,而且視窗一拉寬又自己跳回分割。縮視窗是使用者自己做的動作,
   * 關掉它不會突兀。上下分割不管這條(切的是高度)。
   */
  useEffect(() => {
    if (!isWideEnoughToSplit) setSplit((s) => (s?.dir === 'row' ? null : s));
  }, [isWideEnoughToSplit]);

  const onConnected = useCallback((id: string, status: TerminalStatus) => {
    setTabs((rows) =>
      rows.map((t) => (t.id === id ? {...t, label: status.label, hasStatus: true} : t)),
    );
    setLimits({maxSessions: status.max_sessions, aiEnabled: status.ai_enabled});
  }, []);

  /**
   * 螢幕保護時哪幾台是亮的。
   * ⚠️ **看 `isLive`,不是看 `hostId`**:斷掉的那條不能畫成亮的,
   * 不然畫面暗示「連線沒有斷」而它其實早就斷了。
   */
  const liveHostIds = tabs
    .filter((t) => t.isLive && t.hostId)
    .map((t) => t.hostId as string);

  /**
   * 分割**現在**生不生效。兩塊都還在、左右那一種還要視窗夠寬。
   * (只剩一個分頁的時候 `split` 已經被上面那個 effect 清掉了。)
   */
  const isSplit = isSplitAlive && (split?.dir === 'column' || isWideEnoughToSplit);
  const splitIds: readonly string[] = isSplit && split ? split.ids : [];
  const splitDir = isSplit && split ? split.dir : null;

  /**
   * 要不要計閒置:**畫面上看得到的每一塊都是連著的終端機**才算。
   *
   * ⚠️ 不是「任何一個頁籤連著就計時」—— 那樣另一個頁籤連著某一台、這一頁停在選主機的畫面不動,
   * 三分鐘後照樣蓋上螢幕保護:沒連著的主機全部變暗、不能點,只剩那一台亮著,看起來像壞掉。
   * 選主機的畫面沒有什麼好保護的。
   */
  const shownTabs = tabs.filter((t) => (isSplit ? splitIds.includes(t.id) : t.id === activeId));
  /**
   * 視窗要不要強制深色:看得到的全是主機卡片(還沒選主機、或選了還在連線中)、或螢幕保護蓋著的時候,
   * 跟著網站的淺 / 深色走(見 `styles.windowFollowsPage`);有終端機就是深色。
   * ⚠️ 「連線中」也算卡片:不算的話淺色模式下一點卡片整片就先翻黑,Spinner 才在深色卡片上出現。
   */
  const isPicking = isLocked || (shownTabs.length > 0 && shownTabs.every(showsPicker));
  const windowIsDark = !isPicking || themeMode === 'dark';
  // 藏在背景(人在別頁)時不計:回來要看到原本的畫面,不是螢幕保護
  const watchIdle = isActive && watchesIdle(shownTabs);
  watchIdleRef.current = watchIdle;
  useEffect(() => {
    if (!isActive) setIsLocked(false);
  }, [isActive]);
  useEffect(() => {
    if (!watchIdle) {
      window.clearTimeout(idleTimer.current);
      // 螢幕保護蓋著時不收:那時看得到的是螢幕保護,不是這幾塊;要等人點亮的那台回去
      return;
    }
    bumpIdle();
    return () => window.clearTimeout(idleTimer.current);
  }, [watchIdle, bumpIdle]);
  // 連著的全斷了:螢幕保護上沒有任何一台能點,收掉
  const hasLiveSession = tabs.some((t) => t.hostId && t.isLive);
  useEffect(() => {
    if (!hasLiveSession) setIsLocked(false);
  }, [hasLiveSession]);

  /**
   * 把某一個分頁放到某一塊落點上(拖放與鍵盤走同一支)。
   * **另一半是「最近用過的、不是它的那一個」** —— 使用者挪的是他要換位置的那一個,
   * 留在原地的當然是他剛剛在看的那個。中間那一塊是「不要分割」:回到單一分頁。
   */
  const moveTabToZone = (id: string, zone: Zone) => {
    const plan = ZONES.find((z) => z.zone === zone);
    if (!plan || !tabs.some((t) => t.id === id)) return;
    setActiveId(id);
    if (!plan.dir) {
      setSplit(null);
      return;
    }
    // 視窗放不下左右兩塊時那兩塊根本不會畫出來,但鍵盤那條路還是會走到這裡
    if (plan.dir === 'row' && !isWideEnoughToSplit) return;
    const other =
      recentIds.find((x) => x !== id && tabs.some((t) => t.id === x)) ??
      tabs.find((t) => t.id !== id)?.id;
    // 只有一個分頁:沒有東西可以跟它分割,當作點了那個分頁
    if (!other) return;
    setSplit({dir: plan.dir, ids: plan.dragFirst ? [id, other] : [other, id]});
  };

  /** 放開滑鼠:收掉拖曳的記號,再走上面那支。 */
  const dropOnZone = (zone: Zone) => {
    const id = dragTabId;
    setDragTabId(null);
    setHoverZone(null);
    if (id) moveTabToZone(id, zone);
  };

  /**
   * 落點現在畫哪幾塊。視窗不夠寬就**不畫左右那兩塊**(而不是畫了卻不收)——
   * 亮起來、放開卻什麼都沒發生,比沒有那塊更難理解。
   * ⚠️ 手機上這一整層根本不會出現:原生拖放在觸控上不會啟動(`dragstart` 不來,
   * `dragTabId` 就一直是 null)。那是刻意的 —— 手機的寬度擺不下兩個終端機,
   * 而分割在那裡本來就沒有意義(同 `SPLIT_MIN_WIDTH` 的理由)。
   */
  const zoneRows = ZONES.filter((z) => z.dir !== 'row' || isWideEnoughToSplit);
  const hasSideZones = zoneRows.some((z) => z.dir === 'row');

  /** 連線活不活著的回報(連上 / 斷線)。 */
  const onLiveChange = useCallback((id: string, isLive: boolean) => {
    setTabs((rows) => rows.map((t) => (t.id === id ? {...t, isLive, hasEnded: !isLive} : t)));
  }, []);

  const fullscreen = () => {
    const el = windowRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  if (!canUse) {
    return (
      <VStack gap={3} xstyle={styles.page}>
        <VisuallyHidden>
          <Heading level={1}>SSH 終端機</Heading>
        </VisuallyHidden>
        <Stack xstyle={styles.denied}>
          <EmptyState
            icon={<Icon icon={Lock} size="lg" />}
            title="這個功能只開放給工程師"
            description="職稱是 Software engineer 的帳號才會在側邊欄看到 SSH Server。需要的話請管理員在帳號管理頁調整職稱。"
          />
        </Stack>
      </VStack>
    );
  }

  return (
    <VStack gap={3} xstyle={styles.page}>
      <VisuallyHidden>
        <Heading level={1}>SSH 終端機</Heading>
      </VisuallyHidden>

      {/*
        外框:全螢幕的目標與「深色到哪裡為止」的邊界都在這一層。
        ⚠️ 這裡**不是** render host 的例外(那條的判準是「別人會往這個節點塞 DOM」),
        所以用 Stack 不用 div —— 版面一律走 Astryx 元件。

        底下這兩樣跟 `styles.window` 的 `color-scheme: dark` 是**同一件事的三隻腳**(三隻都只在 `windowIsDark` 時掛;
        選主機時三隻一起拿掉,token 直接沿用 `<html>` 那一層的淺 / 深色),
        理由整段寫在 `styles.window` 上,改之前先讀:
          - `data-astryx-theme` 讓佈景的 token 在這一層**重新宣告一次**;
          - 兩個 `--lightningcss-*` 是正式 build 裡 `light-dark()` 降級後的開關,
            **空字串 = 這一半不要,`initial` = 用這一半**(Lightning CSS 的慣例,
            照抄它自己產生的 `:where(html[data-theme=dark])` 那一條)。
          - `--focus-outline-color` **原樣再宣告一次**(值就是設計系統自己的 `var(--color-accent)`,
            不是新顏色):它是核心在 `:root` 宣告的、不在佈景裡,`data-astryx-theme` 重宣告不到它,
            於是淺色頁面上視窗裡的焦點框拿的是**淺色那組**的藍,對深色底只有 2.05:1。
            在這一層再宣告一次,它就讀到這裡已經翻成深色的 accent。
      */}
      <Stack
        ref={windowRef}
        xstyle={[styles.window, !windowIsDark && styles.windowFollowsPage]}
        {...(windowIsDark ? {'data-astryx-theme': 'neutral'} : {})}
        style={
          windowIsDark
            ? ({
                '--lightningcss-light': ' ',
                '--lightningcss-dark': 'initial',
                '--focus-outline-color': 'var(--color-accent)',
              } as React.CSSProperties)
            : undefined
        }
      >
        <VStack gap={0} height="100%">
          <Toolbar
            label="終端機"
            size="sm"
            dividers={['bottom']}
            xstyle={styles.head}
            startContent={
              <HStack vAlign="center" gap={1} xstyle={styles.tabs} role="tablist">
                {tabs.map((tab) => {
                  const isActive = tab.id === activeId;
                  const dot = tabStatus(tab);
                  return (
                    <HStack
                      key={tab.id}
                      vAlign="center"
                      gap={1}
                      role="tab"
                      aria-selected={isActive}
                      tabIndex={0}
                      /* 鍵盤那條路只報給讀螢幕的人聽(畫面上不寫操作說明),見底下的 onKeyDown */
                      aria-label={`${tab.label}(Alt 加方向鍵分割畫面)`}
                      xstyle={[
                        styles.tab,
                        isActive && styles.tabActive,
                        dragTabId === tab.id && styles.tabDragging,
                      ]}
                      /*
                        分割畫面的入口:把頁籤拖到終端機的
                        左 / 右 / 上 / 下,就照那個方向切成兩塊。用原生的拖放 ——
                        它自己會畫拖曳中的那一份、自己處理游標,而我們要的落點判斷
                        只有五塊,不值得為它裝一套指標事件的拖曳。
                        ⚠️ 拖之前先切過去:放開的時候「另一半」挑的是最近用過的那個,
                        沒切的話使用者會拿到一個他沒在看的組合。
                      */
                      draggable
                      onDragStart={(e: React.DragEvent) => {
                        e.dataTransfer.effectAllowed = 'move';
                        // 有些瀏覽器沒有資料就不開始拖;內容用不到,放 id 當記號
                        e.dataTransfer.setData('text/plain', tab.id);
                        setActiveId(tab.id);
                        setDragTabId(tab.id);
                      }}
                      onDragEnd={() => {
                        setDragTabId(null);
                        setHoverZone(null);
                      }}
                      onClick={() => activateTab(tab.id)}
                      onKeyDown={(e: React.KeyboardEvent) => {
                        /*
                          ⚠️ **鍵盤也要能分割**:原生拖放是滑鼠專用的,
                          分割的入口只剩拖曳的話,用鍵盤的人完全到不了。
                          `Alt + 方向鍵` 就是把這個分頁丟到那一邊,
                          `Alt + Enter` 是回到單一分頁(哪顆鍵對哪一塊寫在 `ZONES` 裡)。
                          畫面上**不寫**這件事(檔頭:沒有操作說明),它在分頁的 aria-label 上。
                        */
                        const zone = e.altKey && ZONES.find((z) => z.key === e.key);
                        if (zone) {
                          e.preventDefault();
                          moveTabToZone(tab.id, zone.zone);
                          return;
                        }
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          activateTab(tab.id);
                        }
                      }}
                    >
                      {/*
                        指示燈:連著 = 綠、斷了 = 紅、還沒選主機 = 灰。
                        ⚠️ 三態不是兩態:還沒選主機的那個分頁畫紅點會讓人以為連線失敗,
                        但它根本還沒連過(`hostId` 是 null)。
                      */}
                      <StatusDot variant={dot.variant} label={dot.label} />
                      <Text type="supporting" maxLines={1} hasTruncateTooltip xstyle={styles.tabLabel}>
                        {tab.label}
                      </Text>
                      {/*
                        位置**永遠留著**(理由見 `TAB_OFFLINE_TEXT`),斷線時只是淡進來。
                        `visibility: hidden` 的那半讓它不吃滑鼠、也不進無障礙樹。
                        ⚠️ 報讀那一路**本來就不靠這段字** —— 這一列的 `aria-label`
                        蓋掉整個子樹,狀態是由 `StatusDot` 的 `label` 講的。
                      */}
                      <Text
                        type="supporting"
                        color="secondary"
                        xstyle={[styles.tabStatusText, !dot.text && styles.tabStatusTextIdle]}
                      >
                        {TAB_OFFLINE_TEXT}
                      </Text>
                      {/*
                        ⚠️ ×**永遠畫**:只在開兩個以上才畫的話,第一個頁籤窄一截、
                        開第二個的時候整排跳一下。關掉最後一個會補一個新的選主機頁籤。
                        ⚠️ 點 × 要**擋住冒泡**:它在那一列的 onClick(切到這個頁籤)裡面,不擋的話
                        會先關掉這個頁籤、再把 activeId 設成**剛被刪掉的那個** —— 畫面就全黑了。
                      */}
                      <IconButton
                        label={`關閉 ${tab.label}`}
                        variant="ghost"
                        icon={<Icon icon={X} size="sm" />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          if (isTabOpen(tab)) setCloseAsk({id: tab.id, label: tab.label});
                          else closeTab(tab.id);
                        }}
                      />
                    </HStack>
                  );
                })}
                <IconButton
                  label={canAddTab ? '開一條新連線' : `最多同時開 ${limits?.maxSessions} 條`}
                  variant="ghost"
                  isDisabled={!canAddTab}
                  icon={<Icon icon={Plus} size="sm" />}
                  onClick={addTab}
                />
              </HStack>
            }
            endContent={
              <>
                <Button
                  variant="ghost"
                  label="字級縮小"
                  onClick={() => setFontSize((f) => Math.max(FONT_MIN, f - 1))}
                >
                  A−
                </Button>
                <Button
                  variant="ghost"
                  label="字級放大"
                  onClick={() => setFontSize((f) => Math.min(FONT_MAX, f + 1))}
                >
                  A+
                </Button>
                {/* 手機不畫分隔線:375 寬要擠下整排,不然檔案欄、AskME 會被擠出畫面。
                    A−/A+ 留著,讓位的是分頁(見 styles.tabLabel / tabStatusText) */}
                {isMobile ? null : (
                  <Stack xstyle={styles.vsep}>
                    <Divider orientation="vertical" />
                  </Stack>
                )}
                {/*
                  ⚠️ 這裡**沒有分割畫面的鈕** —— 分割的入口是把頁籤拖到終端機的某一邊,
                  見分頁的 draggable 與底下那五塊落點。
                */}
                <IconButton
                  label="顯示或隱藏檔案欄"
                  variant="ghost"
                  isDisabled={!activeHasSession}
                  icon={<Icon icon={PanelLeft} size="sm" />}
                  onClick={() => activeId && files.toggle(activeId)}
                />
                {/*
                  ⚠️ AskME 在**全螢幕鈕的左邊**,
                  圖示是**品牌 logo**,不是 Sparkles —— 跟終端機裡選字後浮出來的那顆同一個標記。
                  主機沒有 claude CLI 就不畫(status.ai_enabled),不要讓人按了才看到 503。
                */}
                {aiAvailable ? (
                  <IconButton
                    label="AskME"
                    variant={activeId && ai.isOpen(activeId) ? 'primary' : 'ghost'}
                    isDisabled={!activeHasSession}
                    icon={<Logo size={ASKME_LOGO_PX} />}
                    onClick={() => activeId && ai.toggle(activeId)}
                  />
                ) : null}
                {/* 手機不畫全螢幕:iPhone 的 Safari 不支援把網頁裡的元素全螢幕,手機瀏覽器本來也幾乎佔滿;
                    而 375 寬擠不下整排。按鈕已經是最小的 sm,沒得再縮 */}
                {isMobile ? null : (
                  <IconButton
                    label="全螢幕"
                    variant="ghost"
                    icon={<Icon icon={Maximize2} size="sm" />}
                    onClick={fullscreen}
                  />
                )}
              </>
            }
          />

          <Stack
            xstyle={[
              styles.sessions,
              splitDir === 'row' && styles.sessionsSplitRow,
              splitDir === 'column' && styles.sessionsSplitColumn,
            ]}
          >
            {/*
              閒置的螢幕保護。**蓋在上面,不是取代** —— 底下那幾條連線
              照樣掛著、照樣活著(unmount 就等於斷線了)。點亮著的主機就把畫面還給它。
            */}
            {isLocked ? (
              <Stack xstyle={styles.session}>
                <HostStage
                  mode="lock"
                  hosts={hosts}
                  liveIds={liveHostIds}
                  onPick={pickHost}
                />
              </Stack>
            ) : null}
            {tabs.map((tab) => {
              // 「看得見」= 螢幕保護沒蓋著,而且(分割時)在那兩塊裡、
              // 或(單頁時)就是目前這個頁籤。
              const isShown =
                !isLocked && (isSplit ? splitIds.includes(tab.id) : tab.id === activeId);
              const host = tab.hostId ? hosts.find((h) => h.id === tab.hostId) : undefined;
              const dot = tabStatus(tab);
              // 分割時排第幾塊(0 / 1)。-1 = 沒在分割裡
              const at = splitIds.indexOf(tab.id);
              return (
                // ⚠️ 不在畫面上的頁籤**只是 hidden**,不能 unmount —— unmount 就斷線了
                <VStack
                  key={tab.id}
                  hidden={!isShown}
                  xstyle={[
                    styles.session,
                    isShown && isSplit && styles.sessionSplit,
                    isShown && at >= 0 && paneOrder(at),
                    isShown && at === 1 && splitDir === 'row' && styles.sessionSplitAfterRow,
                    isShown && at === 1 && splitDir === 'column' && styles.sessionSplitAfterColumn,
                    !isShown && styles.sessionHidden,
                  ]}
                  gap={0}
                >
                  {/*
                    並排時每一塊要自己說自己是誰 ——
                    兩個終端機並排的時候,分頁列上的「作用中」標示分辨不了它們。
                  */}
                  {isSplit ? (
                    <HStack xstyle={styles.paneHead} vAlign="center">
                      <StatusDot variant={dot.variant} label={dot.label} />
                      <Text type="supporting" maxLines={1} hasTruncateTooltip>
                        {tab.label}
                      </Text>
                      {dot.text ? (
                        <Text type="supporting" color="secondary">
                          {dot.text}
                        </Text>
                      ) : null}
                    </HStack>
                  ) : null}
                  {host ? (
                    <TerminalSession
                      host={host}
                      hosts={hosts}
                      userName={personName(me.display_name || me.username)}
                      fontSize={fontSize}
                      // 只有**左右**分割才把檔案欄壓窄:上下分割時寬度沒有變
                      isSplitPane={splitDir === 'row'}
                      isFilesOpen={files.isOpen(tab.id)}
                      isAiOpen={aiAvailable && ai.isOpen(tab.id)}
                      onCloseAi={() => ai.set(tab.id, false)}
                      onOpenAi={() => ai.set(tab.id, true)}
                      onConnected={(status) => onConnected(tab.id, status)}
                      onLiveChange={(isLive) => onLiveChange(tab.id, isLive)}
                      onActivity={bumpIdle}
                      pingAt={wake.tabId === tab.id ? wake.at : 0}
                      renderConnecting={(isConnected) => (
                        <HostLogin
                          host={host}
                          isConnected={isConnected}
                          isMorphTarget={tab.id === activeId}
                        />
                      )}
                    />
                  ) : hosts.length ? (
                    // 還沒選主機:這個頁籤就是主機卡片(進來不自動連)
                    <HostStage
                      mode="map"
                      hosts={hosts}
                      // 進來時焦點就在上次連的那張卡片上 ——
                      // 「鍵盤 Enter 就是它」靠的是焦點,不是攔截 Enter 鍵:
                      // 攔截的話使用者 Tab 到別台再按 Enter 會連到錯的主機。
                      lastHostId={lastHostId}
                      // 只有作用中那一塊帶過場名字(並排時兩塊都停在同一張卡片的話會同名,過場整個失效)
                      morphId={tab.id === activeId ? (tab.morphId ?? undefined) : undefined}
                      onPick={pickHost}
                    />
                  ) : (
                    <Stack xstyle={styles.denied}>
                      <EmptyState
                        icon={<Icon icon={Server} size="lg" />}
                        title="沒有可以連的主機"
                        description="請管理員檢查 backend/terminal_hosts.json 與 .env 的 SSH_TERMINAL_* 設定。"
                      />
                    </Stack>
                  )}
                </VStack>
              );
            })}
            {/*
              分割的落點:**只在拖著頁籤的時候才存在**(平常這一層會把終端機的滑鼠吃掉)。
              五塊鋪滿整個區域,滑到哪一塊哪一塊亮起來 —— 放開之後畫面就是那個樣子,
              所以這裡不寫任何說明文字(畫面上不放操作說明)。
              只有一個頁籤時不畫:沒有另一半可以跟它分割。
              ⚠️ **進場的那條規則在 `global.css` 的 `[data-drop-zones]`**(StyleX 寫不出
              `@starting-style`)—— 退場刻意不做,理由寫在那裡。
            */}
            {dragTabId && tabs.length >= 2 ? (
              <Stack xstyle={styles.zones} {...{'data-drop-zones': ''}}>
                {zoneRows.map((z) => (
                  <Stack
                    key={z.zone}
                    aria-label={z.label}
                    xstyle={[
                      styles.zone,
                      z.style,
                      // 左右那兩塊沒畫的時候,剩下三塊自己拉滿整排
                      z.dir !== 'row' && zoneInline(hasSideZones ? ZONE_SIDE : '0'),
                      hoverZone === z.zone && styles.zoneOn,
                    ]}
                    onDragOver={(e: React.DragEvent) => {
                      // preventDefault 才收得到 drop(原生拖放的規矩)
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (hoverZone !== z.zone) setHoverZone(z.zone);
                    }}
                    onDrop={(e: React.DragEvent) => {
                      e.preventDefault();
                      dropOnZone(z.zone);
                    }}
                  />
                ))}
              </Stack>
            ) : null}
          </Stack>
        </VStack>
      </Stack>

      {/* 關有連線的分頁先問。⚠️ `onOpenChange` 要從 dialogProps 帶:它排在 AlertDialog 的 `{...rest}` 後面(見 Users.tsx 刪除框) */}
      <AlertDialog
        isOpen={closeAsk != null}
        {...closeExit.dialogProps}
        title="關閉這條連線?"
        description={`${closeAsk?.label ?? ''} 會中斷,從這條連線開的程式會一起關閉。`}
        actionLabel="關閉"
        // 不用 destructive:這個佈景的 destructive 是紅底紅字(見 Users.tsx 刪除框的說明)
        actionVariant="primary"
        cancelLabel="取消"
        onAction={() => {
          const ask = closeAsk;
          setCloseAsk(null);
          if (ask) closeTab(ask.id);
        }}
      />
    </VStack>
  );
}


/**
 * 「每個頁籤各自一個開關」的那台小狀態機(檔案欄與 AI 欄共用)。
 *
 * `defaultOpen` 是**沒被動過**的頁籤算開還是關 —— 檔案欄在桌機預設開、手機預設關,
 * AI 欄一律預設關。用 `??` 而不是先填好整張表,是因為頁籤會一直新增:
 * 填表的話每開一個頁籤都要記得補一筆,漏了就是「新頁籤的檔案欄沒出來」。
 *
 * `reset()` 給「桌機↔手機換邊」用:那時候預設值本身變了,留著舊的覆寫反而不對。
 */
function usePaneToggles(defaultOpen: boolean) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => overrides[id] ?? defaultOpen;
  return {
    isOpen,
    set: (id: string, open: boolean) => setOverrides((m) => ({...m, [id]: open})),
    toggle: (id: string) => setOverrides((m) => ({...m, [id]: !(m[id] ?? defaultOpen)})),
    // 頁籤關掉時把那一鍵丟掉,不然開關幾十次會留幾十個死鍵
    forget: (id: string) => setOverrides(({[id]: _dropped, ...keep}) => keep),
    reset: () => setOverrides({}),
  };
}
