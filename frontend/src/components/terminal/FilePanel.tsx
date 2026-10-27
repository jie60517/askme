/**
 * 檔案欄:跟終端機在同一個外框裡的左欄,走同一條 SSH 連線上的 SFTP。
 *
 * 會做的事:列目錄、**點一下選取**(Ctrl / ⌘ 加選、Shift 選一段)、雙擊 / Enter 進資料夾、
 * 路徑列每一段可點、上一層、重新整理、拖檔案進來上傳(**一檔一個請求**、一檔一列進度;
 * 超過上限的在送出前就擋;同名先問要不要覆蓋)、上傳鈕,以及**工具列上的下載與刪除**
 * —— 兩支都吃「目前選取的那幾個」,可以一次選好幾個再下載 / 刪除。
 *
 * **跟著終端機的目前目錄走**(`followPath`):在終端機裡 `cd`,這一欄自己換到那個目錄。
 * 沒有反向的「在終端機 cd 到這裡」—— 有了自動跟隨就是多餘的。
 *
 * 刻意不做的:遞迴刪除(沒有回收桶)、重新命名、新資料夾。
 *
 * 每一個**使用者發動**的操作都會叫 `onActivity` —— 後端的閒置計時要重設。
 * 跟隨終端機的那一次換目錄**不算**:那是終端機那頭的事,它自己已經重設過了。
 * 這一欄掛在**深色的外框**裡(`pages/Terminal.tsx` 的 `styles.window`,它自己是一個佈景根),
 * 顏色全走 token,自然是深色。
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
} from 'react';
import * as stylex from '@stylexjs/stylex';

import {BreadcrumbItem, Breadcrumbs} from '@astryxdesign/core/Breadcrumbs';
import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {layerAnimations} from '@astryxdesign/core/Layer';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Toolbar} from '@astryxdesign/core/Toolbar';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {ChevronDown, CornerLeftUp, Download, RefreshCw, Trash2, Upload} from 'lucide-react';

import {LoadingScreen} from '../LoadingScreen';
import {errorMessage} from '../../lib/errors';
import {NO_AUTOFIX} from '../../lib/nativeInputHints';
import {createPointerOwner} from '../../lib/pointerOwner';
import {clampElastic, durationTokenMs, prefersReducedMotion, tweenOut} from '../../lib/rubberband';
import {
  clampColumn,
  COLUMN_MAX_PX,
  COLUMN_MIN_PX,
  COLUMNS,
  headColumnPx,
  readColumnWidths,
  rowMinPx,
  splitNameTail,
  writeColumnWidths,
  type ColumnWidths,
} from './fileColumns';
import {fileLook} from './fileIcon';
import {DEFAULT_SORT, nextSort, sortEntries, type Sort, type SortKey} from './fileSort';
import {EMPTY_SELECTION, moveSelection, pruneSelection, selectRow, type Selection} from './selection';
import {useRowWindow} from './useRowWindow';
import {
  createFilesApi,
  crumbsOf,
  joinPath,
  parentPath,
  shortPath,
  UploadConflictError,
  type DirListing,
  type FileEntry,
  type TerminalDirChange,
} from '../../lib/terminalApi';

/** 鍵盤調欄寬一次幾 px(`--spacing-2`)。用鍵盤的人拖不動滑鼠,得有一個固定的步進。 */
const COLUMN_STEP_PX = 8;
/** 路徑的下拉記幾筆。夠翻、又不會長到要捲。 */
const PATH_HISTORY_MAX = 12;
/**
 * 刪除鈕要按住多久才真的刪(ms)。填滿的動畫吃同一個數(inline 的 `--hold-ms`)。
 * 1.5 秒:長到手滑碰一下不會發生,短到不會讓人以為壞了。
 */
const HOLD_TO_DELETE_MS = 1500;

const styles = stylex.create({
  panel: {
    position: 'relative',
    height: '100%',
    minHeight: 0,
    borderInlineEndWidth: 'var(--border-width)',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: 'var(--color-border)',
    color: 'var(--color-text-primary)',
  },
  panelOff: {opacity: 0.5, pointerEvents: 'none'},
  crumbs: {
    // 下拉的歷史清單就掛在這一條上(絕對定位),所以要 relative
    position: 'relative',
    paddingBlock: 'var(--spacing-1-5)',
    paddingInline: 'var(--spacing-2)',
    borderBottomWidth: 'var(--border-width)',
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--color-border)',
    fontFamily: 'var(--font-family-code)',
  },
  /**
   * 去過的路徑的下拉清單。
   *
   * ⚠️ **不是原生的 `datalist`**。datalist 是拿輸入框的**現值**去過濾的,
   * 而這個框一點開就填著現在的路徑、可以直接改 —— 兩件事放在
   * datalist 上是互斥的:框裡有路徑,下拉就只剩符合它的那幾筆(多半是零筆,
   * 於是看起來像「根本沒有下拉」)。自己畫一份就沒有這個牽扯:框裡填滿路徑,
   * 清單照樣是完整的歷史,打字才開始過濾。
   */
  pathMenu: {
    position: 'absolute',
    insetInlineStart: 'var(--spacing-2)',
    insetInlineEnd: 'var(--spacing-2)',
    insetBlockStart: '100%',
    zIndex: 6,
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-background-popover)',
    boxShadow: 'var(--shadow-high)',
    /**
     * 支點在**上緣**,因為這塊是從路徑列的下緣長出來的(`insetBlockStart: 100%`)——
     * 下拉要從觸發處縮放,不是從自己的中心。
     * 進場本身走設計系統的 `layerAnimations.below`(它預設是 center,所以支點要自己下);
     * 同一個處方在 global.css 的 `[data-picker-more]` 也用過一次。
     */
    transformOrigin: 'top',
    /**
     * 過濾到 0 筆時的淡出(見 `pathMenuEmpty`)。**不是進場** ——
     * 進場是 `layerAnimations.below` 那支 keyframes,只有選項不是 0 筆的時候才掛
     * (所以 0 筆 → 有選項時,跑的是那支 keyframes;理由見 render 那邊)。
     */
    transitionProperty: {
      default: 'opacity, scale, translate',
      '@media (prefers-reduced-motion: reduce)': 'opacity',
    },
    transitionDuration: 'var(--duration-fast-max)',
    transitionTimingFunction: 'var(--ease-standard)',
  },
  /**
   * 打字打到一筆都不剩的那一格。**不 unmount** —— unmount 的話整塊浮層連同
   * `--shadow-high` 的陰影會在打字中途整個閃掉,多打一個退格又整塊閃回來。
   * 藏起來就只是一段 165ms 的淡出。
   * `pointerEvents: 'none'` 是必要的:它還在版面上(雖然是絕對定位),
   * 藏著的時候不能吃到滑鼠。
   */
  pathMenuEmpty: {
    opacity: 0,
    scale: {default: 0.96, '@media (prefers-reduced-motion: reduce)': 1},
    translate: {
      default: '0 calc(var(--spacing-1) * -1)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    pointerEvents: 'none',
  },
  /**
   * 清單本身(`role="listbox"`)。**浮起來的那一層一定要是它外面那顆** ——
   * `global.css` 給每一個 `[role=menu]` / `[role=listbox]` 下了 `position: relative`
   * (會滑的高亮要定位在面板裡),那條是沒有分層的規則,**贏過 StyleX**:
   * 直接把 `position: absolute` 下在有 role 的那顆上會被吃掉,清單就變成
   * 路徑列裡的一個 flex 項目,擠在輸入框旁邊。
   */
  pathList: {
    // 間距 token 最大只到 48px(--spacing-12),240 = 五格,大約看得到八筆
    maxHeight: 'calc(var(--spacing-12) * 5)',
    overflowY: 'auto',
    scrollbarWidth: 'thin',
    paddingBlock: 'var(--spacing-1)',
  },
  /**
   * 一筆歷史。**滑鼠滑過去的回饋不在這裡** —— `MenuHighlightLayer` 本來就會對
   * 每一個 `[role=listbox] [role=option]` 畫那塊會滑的高亮(全站同一份),
   * 這裡再下一個 `:hover` 底色就是同一件事畫兩遍。
   */
  pathOption: {
    width: '100%',
    borderWidth: 0,
    cursor: 'default',
    textAlign: 'start',
    paddingBlock: 'var(--spacing-1)',
    paddingInline: 'var(--spacing-2)',
    backgroundColor: 'transparent',
  },
  /** 鍵盤(上下鍵)停在哪一筆 —— 滑鼠那邊由會滑的高亮負責,兩者不重疊 */
  pathOptionOn: {backgroundColor: 'var(--color-overlay-pressed)'},
  /**
   * 麵包屑右邊那塊空白:點下去就能打路徑。看不見框、游標給 `text` ——
   * 它在暗示「這裡可以打字」,不另外畫一顆編輯圖示。
   */
  pathEditHit: {
    alignSelf: 'stretch',
    width: '100%',
    borderWidth: 0,
    cursor: 'text',
    borderRadius: 'var(--radius-inner)',
    minHeight: 'var(--spacing-5)',
    paddingInline: 0,
    // 淡底只在真的有滑鼠的裝置上(同 `lib/media.ts` 的 HOVER_QUERY):
    // 觸控點一下會觸發假的 :hover 而且黏住,這一塊會一直灰著到下一次點別的地方
    backgroundColor: {default: 'transparent', ':hover': {default: 'transparent', '@media (hover: hover) and (pointer: fine)': 'var(--color-overlay-hover)'}},
  },
  // ⚠️ **表頭跟資料列在同一個捲動容器裡**(表頭 sticky 釘在上緣)。表頭放在容器外面的話,
  // 垂直捲軸一出現,列的可用寬度少掉捲軸寬而表頭沒有;左右捲時列跟著捲、表頭不動 ——
  // 兩種情況欄位都會錯開(沒有捲軸時看不出來,要在有捲軸的狀態下驗)。
  // 表頭、清單、每一列的最小寬度都吃這一個變數(算法見 rowMinPx)
  rowMin: {minWidth: 'var(--row-min)'},
  scroller: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    /**
     * 捲軸的位子**一直留著**(跟側邊欄同一招,見 `global.css` 的 `scrollbar-gutter`)。
     *
     * 理由是**清單長短變化時內容不會左右跳一條捲軸的寬**(細捲軸量到 10px)。
     *
     * ⚠️ 它**不會**幫你把欄位裁在捲軸左邊(溢出的內容裁在
     * padding box,保留帶照樣畫得進去)—— 所以 `PANEL_DEFAULT_PX` **沒有**把那 10px 加進去,
     * 理由寫在 `fileColumns.ts` 的那個常數上。代價是拖出捲軸時它會壓在 Size 欄框的最後 6px 上。
     */
    scrollbarGutter: 'stable',
    // 六欄放不進面板時整個容器左右捲(表頭跟列一起走),不把欄位擠成一團
    overflowX: 'auto',
    scrollbarWidth: 'thin',
  },
  list: {
    // ⚠️ **只有上下內距**:左右也給的話,每一列會比表頭多縮那麼多,六欄就對不齊。
    // 列自己的左右留白在 `row` 上,跟表頭同一個值。
    paddingBlock: 'var(--spacing-1)',
  },
  columnHead: {
    position: 'sticky',
    insetBlockStart: 0,
    /**
     * ⚠️ **要比列高**。每一列是 `position: relative; z-index: 1`(選取的底色要蓋過列與列之間的分隔),
     * 表頭也是 1 的話 —— **同層而且列在 DOM 後面,所以列畫在表頭上面**,捲起來就是兩排字疊著。
     * 底色是不透明的,問題不在底色,在畫的順序。
     */
    zIndex: 2,
    paddingBlock: 'var(--spacing-1)',
    paddingInline: 'var(--spacing-2)',
    // 釘在上面的時候底下有列在捲,要有底色蓋住
    backgroundColor: 'var(--color-background-body)',
    borderBottomWidth: 'var(--border-width)',
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--color-border)',
  },
  /** 表頭的一格。把手是絕對定位貼在右緣的,所以要 relative。 */
  headCell: {position: 'relative'},
  /**
   * 名稱欄以外的欄名**左邊也要留白**。
   *
   * 名稱欄佔了圖示那一格,欄名離面板左緣有一整個 `--spacing-2`;
   * 其他五欄的欄名若貼著左邊那條分隔線起排(中間只隔著半個 gap)就會看起來擠。
   * 給同樣的 `--spacing-2`,六欄的呼吸空間就一致了。
   *
   * ⚠️ 代價:欄名比底下那一欄的內容**往右 8px**,不是嚴格對齊 —— 這是刻意的取捨。
   * ⚠️ 內距下在**格子**上不是把手上:把手是絕對定位、貼著格子的 padding box 右緣,
   * 所以分隔線的位置一個 px 都不會動。
   */
  headCellPad: {paddingInlineStart: 'var(--spacing-2)'},
  /**
   * 欄與欄之間那條線,**同時也是拖寬窄的把手**。
   *
   * 線畫在右緣、命中區是整個 `--spacing-2` 寬(8px):只畫 1px 的話滑鼠根本抓不到。
   * 位置塞進兩格之間那個 gap 裡(`--spacing-1` 的一半往右),所以它**不佔欄寬** ——
   * 佔的話表頭就會比資料列寬,六欄一路錯開。
   * ⚠️ 最後一欄那條也留著:它是「這一欄到這裡為止」的記號,少了它最右邊會看起來沒收尾。
   */
  colResizer: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineEnd: 'calc(var(--spacing-1) * -1)',
    width: 'var(--spacing-2)',
    padding: 0,
    borderWidth: 0,
    borderInlineEndWidth: 'var(--border-width)',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: {
      default: 'var(--color-border)',
      // hover 只在真的有滑鼠的裝置上:觸控拖完欄寬,線會一直亮著
      ':hover': {default: 'var(--color-border)', '@media (hover: hover) and (pointer: fine)': 'var(--color-accent)'},
      ':focus-visible': 'var(--color-accent)',
    },
    backgroundColor: 'transparent',
    cursor: 'col-resize',
    outline: 'none',
    // 拖的時候不要順手把表頭的字反白選起來
    userSelect: 'none',
    touchAction: 'none',
  },
  /**
   * 「..」那一列:**清單的第一列固定是回上一層**。
   *
   * ⚠️ 它**不在 `role="listbox"` 裡面** —— 它是一個動作(回上一層),不是一個可以選取、
   * 可以下載、可以刪除的項目。放進清單裡的話 Shift 連選、全選、方向鍵都要為它開例外,
   * 而那些例外每一個都是之後的 bug。排版吃跟列一樣的那幾條,所以看起來就是第一列。
   */
  upRow: {
    width: '100%',
    borderWidth: 0,
    cursor: 'default',
    textAlign: 'start',
    fontFamily: 'var(--font-family-code)',
    paddingBlock: 'var(--spacing-1)',
    paddingInline: 'var(--spacing-2)',
    borderRadius: 'var(--radius-inner)',
    // 淡底只在真的有滑鼠的裝置上(同 `lib/media.ts` 的 HOVER_QUERY):
    // 觸控點一下會觸發假的 :hover 而且黏住,這一塊會一直灰著到下一次點別的地方
    backgroundColor: {default: 'transparent', ':hover': {default: 'transparent', '@media (hover: hover) and (pointer: fine)': 'var(--color-overlay-hover)'}},
  },
  // 表頭那幾顆鈕要看起來像欄名:不吃 Button 的左右內距,文字自己靠左
  // (每一欄都靠左,見下面 `cell`)
  /**
   * 表頭那顆排序鈕。
   *
   * ⚠️ `paddingInlineEnd` 是**刻意的**:每一欄的右緣就是分隔線兼把手,欄名貼上去會像
   * 黏在線上。留一格 `--spacing-1`,截斷的省略號也跟著早一點出現。
   * 左邊維持 0 —— 欄名要跟底下那一欄的內容對齊(名稱欄除外,見表頭那段說明)。
   */
  sortButton: {
    width: '100%',
    paddingInlineStart: 0,
    paddingInlineEnd: 'var(--spacing-1)',
    justifyContent: 'flex-start',
  },
  // ⚠️ 數值欄**靠左**。表格慣例是數字靠右,但那會讓每一欄的內容各自貼著右邊,
  // 欄與欄中間全是空的。
  cell: {
    fontFamily: 'var(--font-family-code)',
    whiteSpace: 'nowrap',
    textAlign: 'start',
  },
  row: {
    paddingBlock: 'var(--spacing-1)',
    paddingInline: 'var(--spacing-2)',
    borderRadius: 'var(--radius-inner)',
    cursor: 'default',
    // 按住 Shift 選一段時不要把字反白選起來
    userSelect: 'none',
    /*
     * ⚠️ **這裡沒有 `:hover`**(同上面 `pathOption` 的理由):
     *  - 底色:`MenuHighlightLayer` 本來就對每一個 `[role=listbox] [role=option]` 畫那塊會滑的高亮,
     *    列自己再下一層的話底色瞬間到位、高亮 165ms 後才滑過來,看起來像殘影;
     *  - 加粗:`global.css` 那條「滑過去就加粗」已經涵蓋這一列(`role="option"`),而且包在
     *    `(hover: hover) and (pointer: fine)` 裡 —— 這裡沒包的那一份會讓手機上點過的列一直粗體。
     *    字跟著粗靠的是每一格 Text 的 `fontWeight: inherit`(見 `cellText`)。
     */
    backgroundColor: 'transparent',
    outline: 'none',
  },
  rowSelected: {
    backgroundColor: 'var(--color-overlay-pressed)',
    fontWeight: 'var(--font-weight-medium)',
  },
  /**
   * 一格裡那顆 `Text`。
   *
   * `fontWeight: inherit` —— 滑過去 / 選到時整列變粗,字要跟著粗
   * (Astryx 的 `Text` 自己會下 font-weight,不指名的話只有列本身變粗、字沒變)。
   *
   * ⚠️ **`pointerEvents: 'none'`:滑鼠事件不要落在這顆字上**。`Text maxLines={1}` 會下
   * `overflow: hidden`,而**內容溢出的裁切盒會把滾輪吃掉**:滑鼠停在被截斷的檔名上時,
   * 瀏覽器挑中的捲動對象是那顆 span,它自己捲不動,而且**不會**把滾動交給外面的清單,
   * 於是整個清單不動。名字越長越容易中。
   * 讓字不吃滑鼠事件之後,滾輪打在外面那層格子上,照常捲。
   *
   * ⚠️ **`overflow: clip` 不是解**:clip 不建立捲動容器,
   * 但 Chrome 的滾輪一樣停在那個裁切盒上。
   * ⚠️ 所以名稱欄沒有 `hasTruncateTooltip` —— 那顆浮層要 hover 到「字」本身才會出現,
   * 而字不吃滑鼠事件。**也不另外補一個 title 頂替**:畫面上不放 tooltip,
   * 名字看不完的解法是**把那一欄拖寬**(六欄都拖得動)。
   * 列的點選 / 雙擊 / 拖放都在外面那層,不受影響。
   */
  cellText: {fontWeight: 'inherit', pointerEvents: 'none'},
  /**
   * 單行、太長就刪節號 —— 跟 Astryx `Text maxLines={1}` 的 `truncationStyles.singleLine` **一字不差**。
   *
   * 🚨 **檔案列裡不要用 `maxLines`**:`maxLines > 0` 的 `Text` 一掛上去就在 ref 裡
   * **同步**讀 `scrollWidth` / `offsetWidth` 判斷要不要 tooltip(`useTruncation`),每一顆都逼瀏覽器
   * 當場重排整份清單 —— 一列 7 顆,幾百個檔的資料夾就會讓整頁凍住好幾十秒。
   * 這一份純 CSS 畫出來一樣,只是不量。
   * 少掉的只有「截掉時滑過去跳 tooltip」—— 而這裡的字本來就 `pointerEvents: 'none'`(見 `cellText`),
   * 那個 tooltip 不會出現。
   */
  oneLine: {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block'},
  /**
   * 名稱欄**從中間截**(頭尾怎麼切在 `fileColumns.splitNameTail`):
   * 一排兩顆字,頭可以縮到只剩刪節號,尾巴(副檔名與最後一段)固定。
   *
   * ⚠️ 整排一樣 `pointerEvents: 'none'`,理由同 `cellText`:這一排是 `overflow: hidden` 的裁切盒,
   * 滑鼠停在上面的話滾輪會被它吃掉。
   * ⚠️ 兩顆都 `whiteSpace: 'pre'`:切點剛好落在空白上時,`nowrap` 會把頭尾那格空白吃掉,
   * 名字看起來就少了一個空格。
   */
  nameSplit: {overflow: 'hidden', minWidth: 0, pointerEvents: 'none'},
  nameHead: {flex: '0 1 auto', minWidth: 0, whiteSpace: 'pre'},
  /* 尾巴不縮;欄窄到連尾巴都放不下(下限 48px)才讓它自己從尾巴截,不要畫進隔壁欄 */
  nameTail: {
    flex: 'none',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'pre',
    fontWeight: 'inherit',
  },
  // 兩個要人回答的紅底(刪除確認、上傳撞名)共用這一份,差別只在它們各自疊上去的那幾行
  ask: {
    paddingBlock: 'var(--spacing-1-5)',
    paddingInline: 'var(--spacing-2)',
    backgroundColor: 'var(--color-error-muted)',
  },
  askBar: {
    borderBottomWidth: 'var(--border-width)',
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--color-border)',
  },
  askRow: {borderRadius: 'var(--radius-inner)'},
  /**
   * 按住刪除的外框:觸控上長按不能變成「捲動 / 選字 / 跳選單」,不然手指永遠按不滿 1.5 秒
   * (contextmenu 另外在鈕上擋,見 startHold 的說明)。
   */
  holdWrap: {
    touchAction: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  uploading: {
    paddingBlock: 'var(--spacing-1)',
    paddingInline: 'var(--spacing-2)',
  },
  foot: {
    paddingBlock: 'var(--spacing-1-5)',
    paddingInline: 'var(--spacing-3)',
    borderTopWidth: 'var(--border-width)',
    borderTopStyle: 'solid',
    borderTopColor: 'var(--color-border)',
  },
  /**
   * 拖檔案進來時蓋住整個面板的遮罩。
   *
   * ⚠️ **永遠掛在 DOM 上**,用 opacity 開關:`onDragEnter` /
   * `onDragLeave` 是靠 `dragDepth` 計數的,游標在面板邊緣進出時 `dragging` 會在
   * 幾十毫秒內來回翻 —— 條件渲染的話那就是整片畫面在閃。transition 遇到中途翻回去
   * 會從當下的值接著走,這正是手勢驅動的東西該有的行為。
   * `pointerEvents: 'none'` 本來就有,所以藏著的時候不會擋到任何操作。
   * 時間用 `--duration-fast`(125ms):它是回應「你把檔案拖到這裡了」的即時回饋,
   * 不是一段要人看的動畫。reduced-motion **不另外分支** —— 這裡本來就只有 opacity,
   * 沒有位移可以拿掉。
   */
  drop: {
    position: 'absolute',
    inset: 'var(--spacing-1-5)',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'var(--color-text-primary)',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-background-body)',
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-standard)',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    zIndex: 3,
    pointerEvents: 'none',
  },
  dropOn: {opacity: 0.94},
  center: {flex: '1 1 0', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-4)'},
  hiddenInput: {display: 'none'},
});

/**
 * 一格要怎麼畫。名稱欄跟其他五欄的差別**全部在這兩個常數裡** —— 外層那層 `Stack` 的樣式
 * 與裡面 `Text` 的屬性收在同一個物件(誰是名稱欄由 `fileColumns.ts` 的 `isPrimary` 說了算)。
 *
 * ⚠️ 寫成兩份具名 preset,**不是在 JSX 裡一項一項用 `isPrimary ? … : …` 問**:
 * 分散著寫的話「名稱欄怎麼畫」要好幾個地方一起改,漏一個就只有一半變。
 *
 * - 名稱欄:正文字級、名字太長**從中間**截(副檔名與最後一段固定看得到;沒有 tooltip,看不完就拖寬),外層**不**套等寬字。
 * - 其他五欄:`supporting` 的次要字、數字等寬,外層 `styles.cell`(等寬字、不換行、靠左)。
 */
type CellLook = {
  /** 外層 `Stack` 的樣式;名稱欄是 `false`(沒有額外樣式),跟 `xstyle` 陣列的慣例一致。 */
  stack: typeof styles.cell | false;
  text: Pick<ComponentProps<typeof Text>, 'type' | 'color' | 'hasTabularNumbers'>;
  /**
   * 太長時**從中間截**(保住副檔名與最後一段,見 `NameCellText`)還是從尾巴截。
   * 只有名稱欄需要 —— 其他五欄的值本來就短,而且截尾巴才是對的
   * (日期、權限從尾巴少幾個字還認得出來,檔名少了 `v11` / `v12` 就分不出來)。
   */
  middle: boolean;
};
/** 名稱欄:`Text` 的預設就是正文字級,所以這裡沒有要覆寫的屬性。 */
const PRIMARY_CELL: CellLook = {stack: false, text: {}, middle: true};
const SECONDARY_CELL: CellLook = {
  stack: styles.cell,
  text: {type: 'supporting', color: 'secondary', hasTabularNumbers: true},
  middle: false,
};

/**
 * 從中間截的那一格字。名字短到整個放得進尾巴就照一般的一顆字畫。
 *
 * ⚠️ 畫面上的兩顆字 `aria-hidden`,另外放一份完整的名字給報讀軟體:兩顆字是兩個 flex 項目,
 * 報讀軟體算列名的時候會在中間插一個空格,`report_v11.docx` 會念成「report_v 11.docx」。
 */
function NameCellText({text, look}: {text: string; look: CellLook}) {
  // 字素切分(`Intl.Segmenter`)不便宜,而這一格每一列都有一顆:名字沒變就不要重切
  const {head, tail} = useMemo(() => splitNameTail(text), [text]);
  if (!tail) {
    return (
      <Text {...look.text} xstyle={[styles.cellText, styles.oneLine]}>
        {text}
      </Text>
    );
  }
  return (
    <>
      <HStack aria-hidden gap={0} xstyle={styles.nameSplit}>
        <Text {...look.text} xstyle={[styles.cellText, styles.oneLine, styles.nameHead]}>
          {head}
        </Text>
        <Text {...look.text} xstyle={[styles.cellText, styles.nameTail]}>
          {tail}
        </Text>
      </HStack>
      <VisuallyHidden>{text}</VisuallyHidden>
    </>
  );
}

type Props = {
  sessionId: string;
  home: string;
  /** 一次上傳的上限(MB),來自 status 訊息;超過的在送出前就擋 */
  maxUploadMb: number;
  /** 已中斷:整欄變淡、不能操作 */
  isDisabled: boolean;
  onActivity: () => void;
  /**
   * 終端機目前在哪個目錄(後端推的)。**變了**才跟過去 ——
   * 使用者自己在這一欄逛到別的地方時不會被拉回來,除非終端機又 `cd` 了一次。
   * 認不出 shell 的機器上永遠是 null,這一欄就純手動。
   */
  followPath: string | null;
  /**
   * 後端說「這個目錄裡的東西變了」的最後一則(終端機裡 mkdir / rm 之類)。開著的正好是它就安靜地重列;
   * 每則都是新物件,同一個目錄連變兩次也會重列兩次。
   */
  dirChange?: TerminalDirChange | null;
};

/**
 * 圖示的色調 → token(資料夾一種色、檔案依副檔名)。
 * 形狀與色調由 `fileIcon.ts` 決定,**色碼在哪個 token 只有這裡知道** ——
 * 那支是純函式,不該認得 CSS。
 */
const toneStyles = stylex.create({
  folder: {color: 'var(--color-icon-yellow)'},
  code: {color: 'var(--color-icon-blue)'},
  sql: {color: 'var(--color-icon-purple)'},
  script: {color: 'var(--color-icon-green)'},
  data: {color: 'var(--color-icon-orange)'},
  doc: {color: 'var(--color-icon-secondary)'},
  archive: {color: 'var(--color-icon-red)'},
  image: {color: 'var(--color-icon-cyan)'},
  plain: {color: 'var(--color-icon-secondary)'},
});

/** 欄寬只能在執行時給(StyleX 的靜態樣式不吃變數),所以用 dynamic style。 */
const columnWidth = stylex.create({
  width: (px: number | string) => ({width: px, flex: 'none'}),
}).width;

/**
 * 每一欄的寬度**走 CSS 變數**,不是把數字直接餵給 dynamic style。
 *
 * 🚨 這是 `FileRow` 那個 `memo` 的另一半。
 * 數字直接餵進去的話,拖欄寬 = `widths` 換一個新物件 = 每一列都收到新的 prop
 * = 每一列全部重畫,拖起來會明顯卡頓。
 * 每一列都讀同一組變數,拖曳就只是改根節點上的六個字串 ——
 * **一列都不必重畫**,React 完全不參與。
 *
 * ⚠️ 傳給 `columnWidth()` 的是**常數字串**,所以那個 dynamic style 每次算出來都一樣,
 * `memo` 才擋得住。**不要改回 `columnWidth(widths[column.key])`。**
 */
const COLUMN_VAR: Record<SortKey, string> = {
  name: 'var(--col-name)',
  size: 'var(--col-size)',
  mtime: 'var(--col-mtime)',
  owner: 'var(--col-owner)',
  group: 'var(--col-group)',
  access: 'var(--col-access)',
};

/** 表頭的一格:按下去換排序。目前排的那一欄後面帶一個箭頭。 */
function SortButton({
  column,
  sort,
  onSort,
}: {
  column: {key: SortKey; label: string};
  sort: Sort;
  onSort: (next: Sort) => void;
}) {
  const active = sort.key === column.key;
  return (
    <Button
      variant="ghost"
      size="sm"
      width="full"
      label={`照 ${column.label} 排序`}
      xstyle={styles.sortButton}
      onClick={() => onSort(nextSort(sort, column.key))}
    >
      <Text type="supporting" color="secondary" weight={active ? 'semibold' : 'normal'}>
        {column.label}
        {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </Text>
    </Button>
  );
}

/**
 * 欄與欄之間那條線 —— **也是拖寬窄的把手**。
 *
 * 自己寫而不用設計系統的 `ResizeHandle`:那一顆綁的是 `useResizable`(一個 hook 一塊面板),
 * 六欄就要六個 hook,而 hook 不能寫在 `map` 裡。這裡要的其實只有「按住往旁邊拖」,
 * 用 pointer capture 十幾行就完整(滑出元件外面照樣跟手,放開自動結束)。
 *
 * ⚠️ 鍵盤也要能調(左右鍵一次 `--spacing-2`):把手要可聚焦,
 * 不然只用鍵盤的人調不了欄寬。
 *
 * ⚠️ **拖過上下限有橡皮筋**:跟側邊欄邊線一樣,拖過頭會再走一小段、越拉越沉 ——
 * 硬停看起來像拖曳斷了。曲線與 32px 跟側邊欄同一份
 * (`lib/rubberband.ts`),放手用一段短的 ease-out 收回 `clampColumn` 的範圍。
 * 方向鍵維持硬夾(一格一格的離散步進,沒有「放手」那一刻)。`prefers-reduced-motion` 不超界。
 * 已知差異:設計系統的 `useResizable`(檔案欄 / AskME 欄的面板寬度)是硬停,那是它的行為,這裡管不到。
 */
function ColumnResizer({
  label,
  width,
  onResize,
  onStep,
}: {
  label: string;
  width: number;
  /**
   * 拖到某一個寬度(滑鼠)。起點是按下去那一刻抓的,所以這裡直接給絕對值。
   * ⚠️ 拖曳中**可能超出上下限**(橡皮筋,見上);放手後的回彈最後一定落回 `clampColumn` 的範圍。
   */
  onResize: (next: number) => void;
  /**
   * 往左 / 右一格(鍵盤)。**不能自己算 `width + step`** —— 連按好幾下會在同一幀裡
   * 讀到同一個舊的 `width`,五下只會動一格。交給上面用 setState 的函式版本。
   */
  onStep: (delta: number) => void;
}) {
  /**
   * 拖曳的起點。
   *
   * ⚠️ 多指保護(見底下的 owner):不能每一次 pointerdown 都覆寫起點、也都抓 capture ——
   * 那樣手機上第二根手指一按,欄寬就跳到另一根手指的位置,兩根手指的 move 都在改同一欄。
   */
  const start = useRef({x: 0, width: 0, reduce: false});
  /** 這一次拖曳歸哪一根指標管(規則見 `lib/pointerOwner.ts`) */
  const owner = useState(createPointerOwner)[0];
  /** 拖曳中最後畫出來的寬度(可能超界);放手時從這裡回彈。 */
  const shown = useRef<number | null>(null);
  /** 正在跑的回彈;再按下去 / 卸載要先停掉,不然兩邊搶著寫寬度。 */
  const cancelSpring = useRef<() => void>(() => {});
  useEffect(() => () => cancelSpring.current(), []);
  /** 停掉正在跑的回彈(再按下去、方向鍵):不停的話下一幀回彈會把剛寫進去的寬度蓋掉 */
  const stopSpring = () => {
    cancelSpring.current();
    cancelSpring.current = () => {};
  };
  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!owner.release(e)) return;
    /*
     * 沒動就放手時 `shown` 是 null,改看現在的寬度:回彈跑到一半被按住(`stopSpring` 把它停在半路)
     * 又原地放開的話,寬度會停在上下限外面 —— 不收的話就永遠停在那裡。
     */
    const from = shown.current ?? width;
    shown.current = null;
    const settled = clampColumn(from);
    if (settled === from) return;
    stopSpring();
    if (start.current.reduce) {
      onResize(settled);
      return;
    }
    cancelSpring.current = tweenOut(durationTokenMs('--duration-fast-max', 165), (k) =>
      onResize(k === 0 ? settled : Math.round(settled + (from - settled) * k)),
    );
  };
  return (
    <Stack
      as="button"
      aria-label={label}
      xstyle={styles.colResizer}
      onPointerDown={(e: React.PointerEvent<HTMLElement>) => {
        // 不要讓這一下變成「點了欄名 = 排序」
        e.preventDefault();
        e.stopPropagation();
        // 已經有別的指標在拖(第二根手指、別種指標):不理。收尾漏了的話這一下接手重來
        if (owner.claim(e) === 'ignored') return;
        // 上一次的回彈還沒跑完就又抓住:停在當下那一格,從那裡接著拖
        stopSpring();
        // 減少動態在按下去那一刻讀一次就好,不要每一個 pointermove 都去問 matchMedia
        start.current = {x: e.clientX, width, reduce: prefersReducedMotion()};
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e: React.PointerEvent<HTMLElement>) => {
        if (!owner.owns(e) || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const raw = start.current.width + (e.clientX - start.current.x);
        const next = start.current.reduce
          ? clampColumn(raw)
          : Math.round(clampElastic(raw, COLUMN_MIN_PX, COLUMN_MAX_PX));
        shown.current = next;
        onResize(next);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // 抓住的指標不管怎麼結束都會發這一下:up / cancel 被攔掉了也收得到
      onLostPointerCapture={endDrag}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        // 回彈還在跑的話先停:不然下一幀它會把這一格蓋回去
        stopSpring();
        onStep(e.key === 'ArrowRight' ? COLUMN_STEP_PX : -COLUMN_STEP_PX);
      }}
    />
  );
}

/**
 * 檔案清單的**一列**。
 *
 * 🚨 **`memo` 不是裝飾,它是這一列存在的理由。**
 *
 * 這一列有 14 個設計系統元件(1 個 `HStack` + 1 個 `Icon` + 6 × (`Stack` + `Text`))。
 * 寫成 `entries.map()` 裡的行內 JSX 的話,`FilePanel` **任何**一次狀態變更
 * 都會把每一列重畫一次 —— 240 列就是 3,360 個元件實例重來,
 * 點一下選取、拖一下欄寬都要等上一兩秒,時間幾乎全花在 React 的 reconcile。
 *
 * ⚠️ 所以**每一個 props 都必須穩定**,不然 `memo` 等於沒加:
 *  - `entry` —— 來自 `useMemo` 的 `entries`,換目錄 / 換排序才變;
 *  - `position` / `total` / `isSelected` —— 純數字與布林,值沒變就不算變;
 *  - 三個 callback —— 呼叫端用 ref 轉一手包成 `useCallback([])`,
 *    形狀照抄 `TerminalSession` 的 `onConnectedRef.current = onConnected`。
 *    **不要改回行內箭頭函式**,那會讓每一列每次都收到新的 prop。
 * (清單只畫看得到的幾十列(`useRowWindow`),memo 管的是「捲動 / 選取時這幾十列不要重畫」。)
 */
const FileRow = memo(function FileRow({
  entry,
  position,
  total,
  isSelected,
  onSelect,
  onEnter,
  onMoveFocus,
}: {
  entry: FileEntry;
  /** 第幾列(從 1 起)與總共幾列:清單只畫看得到的那一段,報讀軟體要靠這兩個知道「第 3 / 2000 項」 */
  position: number;
  total: number;
  isSelected: boolean;
  onSelect: (name: string, modifiers?: {toggle?: boolean; extend?: boolean}) => void;
  onEnter: (entry: FileEntry) => void;
  onMoveFocus: (delta: 1 | -1) => void;
}) {
  const look = fileLook(entry);
  return (
    // ⚠️ 這一列是**手排的**,不用 `Item`:它的內部版面(startContent / label / endContent)
    // 跟表頭對不齊,而六欄必須跟表頭對齊。`role="option"` 讓它照樣吃
    // global.css 那條「滑過去就加粗」的規則。
    <HStack
      as="li"
      role="option"
      tabIndex={0}
      vAlign="center"
      gap={1}
      aria-selected={isSelected}
      aria-posinset={position}
      aria-setsize={total}
      xstyle={[styles.row, styles.rowMin, isSelected && styles.rowSelected]}
      data-row={entry.name}
      onClick={(e: MouseEvent) => onSelect(entry.name, {toggle: e.ctrlKey || e.metaKey, extend: e.shiftKey})}
      onDoubleClick={() => onEnter(entry)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          if (entry.is_dir) onEnter(entry);
          else onSelect(entry.name);
        } else if (e.key === ' ') {
          e.preventDefault();
          onSelect(entry.name, {toggle: true});
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          // 清單自己吃掉上下鍵,不然整頁跟著捲
          e.preventDefault();
          onMoveFocus(e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      {/* 形狀與色調在 `fileIcon.ts`(有測試);色碼對到哪個 token 在 `toneStyles` */}
      <Icon icon={look.icon} size="sm" xstyle={toneStyles[look.tone]} />
      {COLUMNS.map((column) => {
        const cell = column.isPrimary ? PRIMARY_CELL : SECONDARY_CELL;
        return (
          <Stack key={column.key} xstyle={[cell.stack, columnWidth(COLUMN_VAR[column.key])]}>
            {/* fontWeight: inherit —— 滑過去 / 選到時整列變粗,字要跟著粗
                (Text 自己會下 font-weight,不指名的話那條規則到不了它) */}
            {cell.middle ? (
              <NameCellText text={column.value(entry)} look={cell} />
            ) : (
              <Text {...cell.text} xstyle={[styles.cellText, styles.oneLine]}>
                {column.value(entry)}
              </Text>
            )}
          </Stack>
        );
      })}
    </HStack>
  );
});

/**
 * 撐高度的空白:代表 `rows` 列沒畫出來的檔案(`useRowWindow` 的 `drawPlan`)。
 * 高度是「列數 × 量到的列高」,只能算出來,所以走行內 style(動態值走 inline style)。
 * `role="presentation"` + `aria-hidden`:它在 `role="listbox"` 裡,報讀軟體不能把它當成一個選項。
 */
function RowSpacer({rows, rowPx, ref}: {rows: number; rowPx: number; ref?: Ref<HTMLElement>}) {
  return <Stack ref={ref} as="li" role="presentation" aria-hidden style={{height: rows * rowPx}} />;
}

type UploadState = 'waiting' | 'uploading' | 'conflict' | 'error' | 'skipped' | 'done';
type UploadRow = {id: string; name: string; fraction: number; state: UploadState; error?: string};

export function FilePanel({sessionId, home, maxUploadMb, isDisabled, onActivity, followPath, dirChange}: Props) {
  const filesApi = useMemo(() => createFilesApi(sessionId), [sessionId]);
  const [path, setPath] = useState(home);
  /**
   * 「現在在哪個目錄」的最新值。給那些**開始時抓一份、結束時要比對**的非同步流程用
   * (上傳:傳完才決定要不要重列)—— 那些閉包裡的 `path` 是它們開始那一刻的值,
   * 拿它跟自己比永遠相等。
   */
  const pathRef = useRef(path);
  pathRef.current = path;
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 選到哪幾個 + Shift / 方向鍵的起點(規則在 `selection.ts`);換目錄就清空。 */
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  /** 清單容器:方向鍵要把焦點搬到隔壁那一列。 */
  const listRef = useRef<HTMLElement>(null);
  /** 列目錄的流水號,用來丟掉「回得比較慢的舊請求」(見 `load`)。 */
  const requestSeq = useRef(0);
  /** `refreshListing` 自己的流水號(只認最後一趟,見那支的說明) */
  const refreshSeq = useRef(0);
  /** 照哪一欄排。換目錄**不重設** —— 挑好的排序方式是使用者的偏好,不是這一個目錄的狀態。 */
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * 六欄各自的寬度(使用者拖出來的,記在 localStorage)。
   * ⚠️ **一份就好**:六欄(含名稱欄)的寬度都在這裡,不要另外給某一欄自己的寬度來源。
   */
  const [widths, setWidths] = useState<ColumnWidths>(readColumnWidths);
  useEffect(() => writeColumnWidths(widths), [widths]);
  /** 路徑列在「手打路徑」的樣態,以及那一格的內容。 */
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const pathInputRef = useRef<HTMLInputElement>(null);
  /**
   * 下拉的歷史清單上,鍵盤**停在哪一筆**(`null` = 沒停在任何一筆,Enter 就是走輸入框裡那串)。
   * ⚠️ 存**那一筆的路徑**,不是索引:清單會跟著打字重新過濾,索引指到的東西
   * 會在使用者眼皮底下換掉。
   */
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  /**
   * 這一條連線裡**去過**的目錄,最新的在前面(路徑列的下拉歷史)。
   *
   * ⚠️ 每一次成功換到的目錄都記(點的、打的、跟著終端機 cd 過去的),不是只記手打的 ——
   * 多數人是**點**進去的,只記手打的話清單幾乎永遠是空的。
   * ⚠️ 只活在記憶體裡:換一條連線就是新的一份,也不寫 localStorage —— 主機上有什麼路徑
   * 是那台機器的事,留在瀏覽器裡只會在換主機之後變成一串對不上的東西。
   */
  const [history, setHistory] = useState<string[]>([]);
  const pathListId = useId();
  // 撞名時整條佇列停在那一檔,等使用者按「覆蓋」或「略過」
  const conflictResolver = useRef<((choice: 'overwrite' | 'skip') => void) | null>(null);

  const load = useCallback(
    async (target: string, options: {countsAsActivity?: boolean} = {}) => {
      const {countsAsActivity = true} = options;
      // 只認**最後一次**發出去的請求:掛載當下常常同時有兩趟在飛(家目錄 + 終端機的目前目錄),
      // 先發的後回就會把後發的蓋掉,畫面停在錯的目錄上。
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      setConfirming(null);
      setConfirmError(null);
      setSelection(EMPTY_SELECTION);
      try {
        const data = await filesApi.list(target);
        if (requestSeq.current !== seq) return;
        setListing(data);
        setPath(data.path);
        // 去過的目錄記一筆(下拉的歷史)。**用後端回來的 path**,不是使用者打的那串 ——
        // `~/src` 與 `/home/user/src` 是同一個地方,記兩份下拉就會有兩行一樣的東西。
        setHistory((rows) => [data.path, ...rows.filter((r) => r !== data.path)].slice(0, PATH_HISTORY_MAX));
      } catch (err) {
        if (requestSeq.current !== seq) return;
        setError(errorMessage(err, '讀不到這個目錄'));
      } finally {
        if (requestSeq.current === seq) setLoading(false);
      }
      // 後端的列目錄**不算活動**(跟隨終端機的那一趟不能拖著閒置計時,見 terminal.py 的 list_dir)
      // —— 使用者自己點的,由這裡另外送一則 activity
      if (countsAsActivity) onActivity();
    },
    [filesApi, onActivity],
  );

  useEffect(() => {
    void load(home);
  }, [load, home]);

  // 終端機 `cd` 了就跟過去。deps 只有 followPath 是刻意的:使用者自己逛到別的目錄之後,
  // 要等終端機**再換一次**才會被帶走(同一個值不會重跑)。
  useEffect(() => {
    if (!followPath) return;
    void load(followPath, {countsAsActivity: false});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followPath]);

  const patchUpload = (id: string, patch: Partial<UploadRow>) =>
    setUploads((rows) => rows.map((r) => (r.id === id ? {...r, ...patch} : r)));

  /**
   * 一檔一個請求、一檔一列進度。超過上限的當場標錯不送;撞名的停下來問;
   * 全部跑完才重新列目錄,成功的列收掉、失敗與略過的留著給人看。
   */
  const uploadMany = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const dir = path;
      const limit = maxUploadMb > 0 ? maxUploadMb * 1024 * 1024 : Infinity;
      const stamp = Date.now();
      const items = files.map((file, i) => {
        const tooBig = file.size > limit;
        return {
          file,
          row: {
            id: `${stamp}-${i}`,
            name: file.name,
            fraction: 0,
            state: (tooBig ? 'error' : 'waiting') as UploadState,
            error: tooBig ? `超過 ${maxUploadMb} MB 的上傳上限,大檔請用 scp` : undefined,
          },
        };
      });
      setUploads((rows) => [...items.map((it) => it.row), ...rows]);
      for (const {file, row} of items) {
        if (row.state === 'error') continue;
        let overwrite = false;
        // 最多兩趟:第一趟撞名 → 問 → 第二趟帶 overwrite
        for (;;) {
          patchUpload(row.id, {state: 'uploading', fraction: 0});
          try {
            await filesApi.upload(dir, [file], {
              overwrite,
              onProgress: (fraction) => patchUpload(row.id, {fraction}),
            });
            patchUpload(row.id, {state: 'done', fraction: 1});
            break;
          } catch (err) {
            if (err instanceof UploadConflictError && !overwrite) {
              patchUpload(row.id, {state: 'conflict'});
              const choice = await new Promise<'overwrite' | 'skip'>((resolve) => {
                conflictResolver.current = resolve;
              });
              conflictResolver.current = null;
              if (choice === 'skip') {
                patchUpload(row.id, {state: 'skipped'});
                break;
              }
              overwrite = true;
              continue;
            }
            patchUpload(row.id, {state: 'error', error: errorMessage(err, '上傳失敗')});
            break;
          }
        }
        onActivity();
      }
      /*
       * ⚠️ 要比的是「**現在**在哪個目錄」,所以讀 ref 不是讀 `path`。
       * `dir` 就是這個閉包裡的 `path`,寫成 `if (dir === path)` 是同一個變數比自己,
       * 條件**永遠成立**:傳大檔時逛到別的目錄,傳完畫面會自己跳回上傳的那個目錄,
       * `load()` 還順手把選取清空。
       */
      if (dir === pathRef.current) await load(dir);
      setUploads((rows) => rows.filter((r) => r.state === 'error' || r.state === 'skipped'));
    },
    [filesApi, path, maxUploadMb, load, onActivity],
  );

  /**
   * 拖進來的是**檔案**才算上傳。
   *
   * ⚠️ 頁籤拖到旁邊做畫面分割(見 `pages/Terminal.tsx`)也會經過這一欄 ——
   * 不認一下的話,拖頁籤的時候檔案欄會蓋出一張「放開以上傳到…」,而它根本
   * 接不住那個東西。`types` 裡有 `Files` 才是從桌面拖檔案進來。
   */
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = () => {
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void uploadMany(Array.from(e.dataTransfer.files));
  };

  /** 一列有多寬(六欄 + 圖示 + 間距)。表頭、清單、每一列都吃它,對齊靠的就是這一份。 */
  const rowMin = rowMinPx(widths);

  const entries = useMemo(() => sortEntries(listing?.entries ?? [], sort), [listing, sort]);
  const names = useMemo(() => entries.map((e) => e.name), [entries]);
  // Set 而不是 `selected.includes`:Shift 一拉就是幾千個,每一列再各查一次清單就是幾千 × 幾千
  const selectedSet = useMemo(() => new Set(selection.selected), [selection.selected]);
  const selectedEntries = entries.filter((e) => selectedSet.has(e.name));
  const downloadable = selectedEntries.filter((e) => !e.is_dir);
  const indexOfName = useMemo(() => new Map(names.map((n, i) => [n, i])), [names]);
  /** 焦點在哪一列(清單上的 focus 事件記下來的)。換目錄之後名字對不到就自然不算 */
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  /**
   * 只畫看得到的那一段(理由在 `useRowWindow.ts` 開頭),**再加上焦點那一列與 anchor 那一列**。
   *
   * ⚠️ 這兩列捲走了也要留著:
   *  - 焦點那一列被拿掉,焦點就掉回 body,方向鍵 / Enter / 空白鍵全部沒反應 ——
   *    Shift 點選時 anchor 不動、焦點卻在被點的那一列,所以只留 anchor 不夠;
   *  - anchor 是方向鍵與 Shift 的起點(`selection.ts`)。
   * 它們跟看得到的那段之間用空白撐開,位置不會跑掉(`drawPlan`)。
   */
  const keepRows = [focusedRow, selection.anchor].flatMap((name) => {
    const index = name === null ? undefined : indexOfName.get(name);
    return index === undefined ? [] : [index];
  });
  const rowWindow = useRowWindow(entries, keepRows);
  /** 方向鍵要去的那一列還沒畫出來時,畫出來那一刻再把焦點給它 */
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const name = pendingFocus.current;
    if (!name) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(name)}"]`);
    if (!row) return;
    pendingFocus.current = null;
    row.focus();
  });

  /** 規則全在 `selection.ts`:點一下只選它、Ctrl / ⌘ 加減一個、Shift 從起點選一段。 */
  const select = (name: string, modifiers: {toggle?: boolean; extend?: boolean} = {}) =>
    setSelection((s) => selectRow(names, s, name, modifiers));

  /** 方向鍵上下:選隔壁那一列,焦點也跟著搬過去(不然下一次方向鍵還在原地)。 */
  const moveFocus = (delta: 1 | -1) => {
    const next = moveSelection(names, selection, delta);
    if (!next) return;
    setSelection(next.selection);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next.focus)}"]`);
    if (row) {
      row.focus();
      return;
    }
    // 那一列不在畫出來的範圍裡(使用者先捲走了才按方向鍵):捲過去、畫出來,再給焦點
    pendingFocus.current = next.focus;
    rowWindow.revealIndex(indexOfName.get(next.focus) ?? -1);
  };

  /** 下載選取的檔案。多檔時一個一個開,間隔一下 —— 瀏覽器對「同時好幾個下載」會擋。 */
  const downloadSelected = async () => {
    for (const [i, entry] of downloadable.entries()) {
      // <a download>:帶下載用的 cookie,大檔不經過記憶體
      const a = document.createElement('a');
      a.href = filesApi.downloadUrl(joinPath(path, entry.name));
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (i < downloadable.length - 1) await new Promise((r) => setTimeout(r, 300));
    }
    onActivity();
  };

  /** 一個一個刪,遇到刪不掉的就停在那裡把原因寫出來(非空資料夾後端會拒絕)。 */
  const removeSelected = async () => {
    setBusy(true);
    let failed: string | null = null;
    for (const entry of selectedEntries) {
      try {
        await filesApi.remove(joinPath(path, entry.name));
      } catch (err) {
        failed = `${entry.name}:${errorMessage(err, '刪不掉')}`;
        break;
      }
    }
    setBusy(false);
    onActivity();
    if (failed) {
      setConfirmError(failed);
      await refreshListing();
      return;
    }
    await load(path);
  };

  /**
   * 「刪除」要**按住**才會真的送出:這是遠端主機上
   * 不可復原的刪除、沒有回收桶,一次點擊太容易手滑。按住的時候一條底色從左往右填滿
   * (global.css 的 `[data-hold-fill]`),填滿那一刻才呼叫 `removeSelected`;
   * 中途放開就取消、底色彈回。鍵盤按住 Enter / Space 同樣算(keydown 的 repeat 不重複起算)。
   *
   * ⚠️ 確認列收掉(取消、或刪完)時計時器一定要跟著清:那時候鈕已經不在畫面上,
   * pointerup 送不到它,計時器到點會在使用者以為已經取消之後把東西刪掉。
   * ⚠️ 觸控上要擋掉長按的預設行為(見 `styles.holdWrap` 與鈕上的 onContextMenu):
   * Android 長按約 500ms 會發 contextmenu(常伴 pointercancel),iOS 會跳選取 ——
   * 不擋的話手指永遠按不到 1.5 秒。
   */
  const [isHolding, setIsHolding] = useState(false);
  /**
   * 按**滿**了(不是放開)。成功與取消必須是兩段不同的動畫:
   * 取消是底色從當下位置回捲(`--duration-fast-max` + `--ease-standard`,
   * 語意是「你放手了」);成功是底色**停在滿的位置淡出**(`--duration-fast`,
   * 語意是「收到,正在做」)。共用同一段的話,辛苦按滿 1.5 秒得到的回饋
   * 跟手滑放開一模一樣。
   */
  const [isHoldDone, setIsHoldDone] = useState(false);
  const holdTimer = useRef<number | undefined>(undefined);
  const cancelHold = useCallback(() => {
    if (holdTimer.current !== undefined) window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    setIsHolding(false);
    setIsHoldDone(false);
  }, []);
  /**
   * 手指抬起 / 移開 / 被系統取消時走這裡,**不是** `cancelHold`。
   *
   * ⚠️ 按**滿**之後手指一定也會抬起,而那時候淡出正在演 —— 直接 `cancelHold` 會把
   * `isHoldDone` 清掉,底色就從淡出半途翻回「取消」那段回捲,正好是這個 state 要治的病。
   * 刪除成功時整列會跟著收掉所以看不見,
   * 但刪除**失敗**(留著 `confirmError` 那條紅底)就看得到。
   * `cancelHold` 保持完整清理,給底下那兩支 effect 用。
   */
  const endHold = useCallback(() => {
    if (isHoldDone) return;
    cancelHold();
  }, [isHoldDone, cancelHold]);
  const startHold = () => {
    if (busy || holdTimer.current !== undefined) return;
    setIsHoldDone(false);
    setIsHolding(true);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = undefined;
      // ⚠️ 這裡**不能** setIsHolding(false) —— 那會讓底色走「取消」那一段回捲。
      // `data-holding` 留著(底色停在滿的位置),再疊一個 `data-hold-done` 讓它淡出。
      setIsHoldDone(true);
      void removeSelected();
    }, HOLD_TO_DELETE_MS);
  };
  useEffect(() => {
    if (!confirming) cancelHold();
  }, [confirming, cancelHold]);
  useEffect(() => cancelHold, [cancelHold]);

  /**
   * 重讀清單但不碰其他狀態 —— 刪到一半失敗時要留著那條紅色說明,所以不能走 `load`。
   * 終端機裡 mkdir / rm 之後(`dirChange`)也走這裡:不閃 loading、不清選取,只拿掉已經不在的那幾個名字。
   * ⚠️ 回來的時候使用者可能已經點到別的目錄了(`load` 發出去了、或已經換好)—— 那這份是舊目錄的,丟掉。
   * ⚠️ 自己也有流水號:後端一次變動會推兩則(當下一則、`DIR_SETTLE_SEC` 之後補一則),兩趟回來的順序
   * 顛倒的話,舊的那份會蓋掉新的。
   *
   * `pruneConfirm`:刪除確認列上的名單也一起修剪,都被刪光了就收掉。**只有 `dirChange` 那條路**給 true ——
   * 刪到一半失敗那條路的確認列上掛著錯誤說明,收掉它使用者就看不到為什麼沒刪成。
   */
  const refreshListing = async ({pruneConfirm = false}: {pruneConfirm?: boolean} = {}) => {
    const seq = requestSeq.current;
    const mine = ++refreshSeq.current;
    const target = pathRef.current;
    try {
      const data = await filesApi.list(target);
      if (requestSeq.current !== seq || refreshSeq.current !== mine || pathRef.current !== target) return;
      setListing(data);
      const present = new Set(data.entries.map((e) => e.name));
      setSelection((s) => pruneSelection(s, present));
      if (pruneConfirm) {
        // 確認列上的數字是按下「刪除」那一刻拍下來的,不修剪的話終端機刪掉一個之後還寫著舊的 N
        setConfirming((names) => {
          if (!names || names.every((n) => present.has(n))) return names;
          const left = names.filter((n) => present.has(n));
          return left.length > 0 ? left : null;
        });
      }
    } catch {
      // 連目錄都讀不到的話,下一次重新整理再說
    }
  };

  // 終端機裡 mkdir / rm 之後,後端說「這個目錄變了」:開著的正好是它才重列。只看 dirChange 是刻意的
  useEffect(() => {
    if (dirChange && dirChange.path === pathRef.current) void refreshListing({pruneConfirm: confirmError === null});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirChange]);

  const enter = (entry: FileEntry) => {
    if (entry.is_dir) void load(joinPath(path, entry.name));
  };

  /*
   * 給 `FileRow` 的三個 callback,**識別性必須每次 render 都一樣**,
   * 不然那個 `memo` 等於沒加(理由寫在 `FileRow` 上面)。
   *
   * 上面那三支(`select` / `enter` / `moveFocus`)每次 render 都是新的一顆 ——
   * 它們閉包到 `names` / `selection` / `path`,改成 `useCallback` 要把那些全列進相依,
   * 結果還是每次都換。所以用**這個 repo 已有的形狀**:最新的實作放 ref,
   * 對外只給一顆空相依的包裝(`TerminalSession` 的 `onConnectedRef.current = onConnected`
   * 就是同一招)。
   */
  const rowApi = useRef({select, enter, moveFocus});
  rowApi.current = {select, enter, moveFocus};
  const onRowSelect = useCallback(
    (name: string, modifiers?: {toggle?: boolean; extend?: boolean}) =>
      rowApi.current.select(name, modifiers),
    [],
  );
  const onRowEnter = useCallback((entry: FileEntry) => rowApi.current.enter(entry), []);
  const onRowMoveFocus = useCallback((delta: 1 | -1) => rowApi.current.moveFocus(delta), []);

  /**
   * 切到「手打路徑」。
   *
   * ⚠️ **輸入框裡就是目前的路徑**,可以直接改。歷史清單是自己畫的(見 `styles.pathMenu`),
   * 框裡有字也照樣看得到整份歷史。
   * 進來就把整串選起來:想從頭打的人直接打,想改一段的人按一下方向鍵就有游標。
   */
  const startEditingPath = () => {
    setPathDraft(path);
    setPickedPath(null);
    setIsEditingPath(true);
  };

  const closePathEditor = () => {
    setIsEditingPath(false);
    setPickedPath(null);
  };

  /**
   * 手打的路徑要去哪裡。
   *
   * 三種寫法都收:絕對路徑(`/opt/app`)、`~` 開頭(家目錄)、
   * 以及相對於現在這一層的(`src/lib`)—— 終端機裡怎麼打,這裡就怎麼打。
   * 讀不到的路徑由 `load` 那邊統一顯示「讀不到這個目錄」,不在這裡先攔
   * (攔了只是把同一句話寫兩遍,而且前端不知道主機上有什麼)。
   */
  const goToTypedPath = (raw: string) => {
    closePathEditor();
    const text = raw.trim();
    if (!text) return;
    let target = text;
    if (text === '~') target = home;
    else if (text.startsWith('~/')) target = joinPath(home, text.slice(2));
    else if (!text.startsWith('/')) target = joinPath(path, text);
    // 結尾的斜線去掉(根目錄那一條除外),不然麵包屑會多出一段空的
    if (target.length > 1 && target.endsWith('/')) target = target.replace(/\/+$/, '') || '/';
    if (target === path) return;
    void load(target);
  };

  /**
   * 下拉要列哪幾筆:去過的目錄,扣掉現在這一個(它就在框裡,再列一次是佔位子)。
   * **還沒動過框裡那串之前不過濾** —— 一點開就是完整的歷史,那正是「下拉檢視」。
   */
  const pathOptions = history.filter(
    (row) =>
      row !== path &&
      (pathDraft === path || !pathDraft.trim() || row.toLowerCase().includes(pathDraft.trim().toLowerCase())),
  );

  /**
   * 每一筆歷史的 DOM id —— `aria-activedescendant` 要指得到它。
   * 路徑裡什麼字元都可能出現,所以編碼過再用(`%` 換成 `_`,id 不吃百分號比較保險)。
   */
  const pathOptionId = (row: string) => `${pathListId}-${encodeURIComponent(row).replace(/%/g, '_')}`;

  const crumbs = crumbsOf(path, home);
  const canDelete = selectedEntries.length > 0 && !busy;

  return (
    <VStack
      xstyle={[styles.panel, isDisabled && styles.panelOff]}
      aria-label="檔案"
      // 名稱欄的寬度:表頭與每一列都吃這一個變數,對齊靠的就是「只有一份」
      style={
        {
          '--row-min': `${rowMin}px`,
          // 六欄的寬度也在這裡(理由見 `COLUMN_VAR`):拖欄寬只改這幾個字串,
          // 每一列讀變數,所以一列都不必重畫。
          '--col-name': `${widths.name}px`,
          '--col-size': `${widths.size}px`,
          '--col-mtime': `${widths.mtime}px`,
          '--col-owner': `${widths.owner}px`,
          '--col-group': `${widths.group}px`,
          '--col-access': `${widths.access}px`,
        } as React.CSSProperties
      }
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* ⚠️ 這條工具列**不要給 paddingInline**:Astryx 的 Section 會把它算進自己的邊框盒,
          下緣那條分隔線就會比路徑列那條短一截。
          圖示的左右留白由 Toolbar 自己的 edge compensation 處理。 */}
      <Toolbar
        label="檔案操作"
        size="sm"
        dividers={['bottom']}
        startContent={
          <>
            <IconButton
              label="上一層"
              variant="ghost"
              icon={<Icon icon={CornerLeftUp} size="sm" />}
              isDisabled={path === '/'}
              onClick={() => void load(parentPath(path))}
            />
            <IconButton
              label="重新整理"
              variant="ghost"
              icon={<Icon icon={RefreshCw} size="sm" />}
              onClick={() => void load(path)}
            />
            <IconButton
              label="上傳檔案"
              variant="ghost"
              icon={<Icon icon={Upload} size="sm" />}
              onClick={() => inputRef.current?.click()}
            />
            <IconButton
              label="下載選取的檔案"
              variant="ghost"
              icon={<Icon icon={Download} size="sm" />}
              isDisabled={downloadable.length === 0}
              onClick={() => void downloadSelected()}
            />
            <IconButton
              label="刪除選取的項目"
              variant="ghost"
              icon={<Icon icon={Trash2} size="sm" />}
              isDisabled={!canDelete}
              onClick={() => {
                setConfirmError(null);
                setConfirming(selectedEntries.map((e) => e.name));
              }}
            />
          </>
        }
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        {...stylex.props(styles.hiddenInput)}
        onChange={(e) => {
          void uploadMany(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {/*
        路徑列有兩個樣態:平常是可點的麵包屑,點最後一段(或麵包屑右邊的空白)
        就變成一格輸入框,可以**直接把路徑打進去**。
      */}
      <HStack xstyle={styles.crumbs} vAlign="center" gap={1}>
        {isEditingPath ? (
          <StackItem size="fill">
            <TextInput
              ref={pathInputRef}
              label="路徑"
              isLabelHidden
              size="sm"
              // ⚠️ 聚焦走設計系統的 `hasAutoFocus`,不要自己在 effect 裡 focus():
              // 輸入框是這一次 render 才長出來的,自己排 rAF 去 focus 會在「分頁沒在畫」
              // 的時候整個不跑(rAF 被節流),於是點了框卻打不了字。
              hasAutoFocus
              value={pathDraft}
              onChange={(value: string) => {
                setPathDraft(value);
                // 打字就回到「走框裡那串」,不然上下鍵選過一筆之後,Enter 會送出舊的那筆
                setPickedPath(null);
              }}
              // 聚焦時整串選起來(見 startEditingPath):直接打就是換一條路徑
              onFocus={(e: FocusEvent) => (e.target as HTMLInputElement).select?.()}
              {...{
                // 自己畫的下拉(見 styles.pathMenu)要的 ARIA:這是一顆 combobox
                role: 'combobox',
                'aria-expanded': pathOptions.length > 0,
                'aria-controls': pathListId,
                'aria-autocomplete': 'list',
                // 鍵盤停在哪一筆:焦點一直在輸入框上,所以要靠這個把「現在是哪一筆」報出去
                'aria-activedescendant': pickedPath ? pathOptionId(pickedPath) : undefined,
                /*
                 * 路徑是「打什麼就是什麼」:關掉手機鍵盤的自動大寫、自動校正、拼字檢查
                 * (iOS 會把 `/srv/app-b` 校正成別的字、第一個字母自動大寫,而 Linux 路徑分大小寫)。
                 * 跟上面的 ARIA 一樣塞在這個展開裡,理由見 `lib/nativeInputHints.ts`。
                 */
                ...NO_AUTOFIX,
              }}
              onBlur={closePathEditor}
              // Enter 用設計系統自己的 `onEnter`(它在 onKeyDown 之前就處理掉了)
              onEnter={() => goToTypedPath(pickedPath ?? pathDraft)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closePathEditor();
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  if (!pathOptions.length) return;
                  // 上下鍵在歷史清單裡走。不擋掉的話游標會在字串裡跑。
                  // 走一圈會回到「沒停在任何一筆」(也就是框裡自己打的那串),不是跳頭跳尾
                  e.preventDefault();
                  const at = pickedPath ? pathOptions.indexOf(pickedPath) : -1;
                  const next = at + (e.key === 'ArrowDown' ? 1 : -1);
                  setPickedPath(next < 0 || next >= pathOptions.length ? null : pathOptions[next]);
                }
              }}
            />
          </StackItem>
        ) : (
          <>
            {/* 分隔符不用預設的「/」:chroot 之下家目錄就是 /,根那一段的字也是 /,會變成「//」 */}
            <Breadcrumbs variant="supporting" label="路徑" separator="›">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <BreadcrumbItem
                    key={c.path}
                    /*
                      ⚠️ **不要傳 `isCurrent`**:Astryx 看到它就把那一段畫成 <span>(`onClick` 直接無效),
                      而我們要最後一段點得動。不傳的話它會自己判斷誰是最後一個並補上
                      `aria-current="page"`(元件裡的 auto-candidate 那條路),語意不會掉。
                    */
                    /*
                      ⚠️ **最後一段點下去是「改路徑」**,不是「再載入一次自己」:
                      它是目前這個目錄 —— 導覽過去毫無意義,而那一段正好是使用者想改的東西。
                      前面那幾段照舊是導覽。
                    */
                    onClick={() => (last ? startEditingPath() : void load(c.path))}
                  >
                    {c.label}
                  </BreadcrumbItem>
                );
              })}
            </Breadcrumbs>
            {/*
              麵包屑右邊剩下的空白就是「改路徑」的觸發區。
              ⚠️ **沒有鉛筆鈕**:那顆鈕唯一的作用是解釋這裡可以打字,點下去自然就知道。
              鍵盤走得到:它是一顆真的按鈕,只是看不見框(游標是 text,滑鼠也看得出來)。
            */}
            <StackItem size="fill">
              {/* 一顆**看不見字**的按鈕(Astryx 的 Button 沒有隱藏文字的選項,所以用
                  Stack as="button" —— 跟 HostStage 的主機節點同一招) */}
              <Stack
                as="button"
                aria-label="輸入路徑"
                // 看不見框的按鈕最需要按壓回饋:沒有鉛筆圖示,線索只剩游標與 hover 的淡底。
                {...{'data-pressable': ''}}
                xstyle={styles.pathEditHit}
                onClick={startEditingPath}
              />
            </StackItem>
            {/*
              ⚠️ **這顆箭頭是「去過的路徑」,不是「編輯路徑」**。不放鉛筆鈕是因為「這裡可以打字」
              點了就知道;歷史清單卻**沒有任何線索**,不給一個入口就等於沒有這個功能。不要把兩件事混在一起。
            */}
            <IconButton
              label="去過的路徑"
              variant="ghost"
              size="sm"
              icon={<Icon icon={ChevronDown} size="sm" />}
              onClick={startEditingPath}
            />
          </>
        )}
        {/*
          去過的路徑。**只在改路徑的時候才出現**,而且一點開就是完整的歷史
          (過濾要等使用者開始打字,見 `pathOptions`)。
          ⚠️ 走 `onMouseDown` 不走 `onClick`:滑鼠按下去的當下輸入框會先 blur,
          那一下就把這份清單收掉了,`onClick` 永遠等不到。
          ⚠️ 清單被過濾到 0 筆時**不 unmount**、只是藏起來,理由見 `pathMenuEmpty`。
        */}
        {isEditingPath ? (
          <Stack
            xstyle={[
              styles.pathMenu,
              /*
               * ⚠️ 進場與「藏起來」**二選一**,不能同時掛:`layerAnimations.below`
               * 是 opacity 0 → 1 的 keyframes(`fill-mode: backwards`),動畫跑的那 165ms 會蓋過
               * `pathMenuEmpty` 的 `opacity: 0` —— 點開時一筆歷史都沒有(只去過目前這條路徑),
               * 就先閃一個空的、帶影子的框再消失。0 筆時不掛進場;之後有了選項才掛上去,
               * 那一刻進場照常跑一次(跟 `pathMenuEmpty` 淡回的長相本來就是同一個)。
               */
              pathOptions.length > 0 ? layerAnimations.below : styles.pathMenuEmpty,
            ]}
            // 藏起來的時候(過濾到 0 筆)也要對報讀藏起來 —— 它還在 DOM 上,
            // 只是 opacity 0 + `pointerEvents: none`。跟拖放遮罩同一個處理。
            aria-hidden={pathOptions.length === 0}
          >
          <VStack
            id={pathListId}
            role="listbox"
            aria-label="去過的路徑"
            xstyle={styles.pathList}
            gap={0}
          >
            {pathOptions.map((row) => (
              <Stack
                key={row}
                id={pathOptionId(row)}
                as="button"
                role="option"
                aria-selected={row === pickedPath}
                xstyle={[styles.pathOption, row === pickedPath && styles.pathOptionOn]}
                onMouseDown={(e: MouseEvent) => {
                  e.preventDefault();
                  goToTypedPath(row);
                }}
              >
                {/* 跟列上那顆字同一個處方:這份清單也會捲,被截斷的路徑會把滾輪吃掉
                    (理由見 `styles.cellText`);也沒有浮層,看不完就把面板拖寬 */}
                <Text type="supporting" maxLines={1} xstyle={styles.cellText}>
                  {shortPath(row, home)}
                </Text>
              </Stack>
            ))}
          </VStack>
          </Stack>
        ) : null}
      </HStack>

      {confirming ? (
        // 窄面板上「說明 + 兩顆鈕」擠不進同一行,所以說明一行、鈕自己一行靠右
        // 進場在 global.css 的 `[data-ask-row]` —— 跟上傳撞名那塊(`data-upload-row`)
        // 同一條規則。兩塊紅底本來就共用 `styles.ask`,長相與進場也要是同一份。
        <VStack
          xstyle={[styles.ask, styles.askBar]}
          gap={1}
          role="alert"
          {...{'data-ask-row': ''}}
        >
          <Text type="supporting" maxLines={3}>
            {confirmError
              ? confirmError
              : confirming.length === 1
                ? `刪除 ${confirming[0]}?沒有回收桶。`
                : `刪除這 ${confirming.length} 個項目?沒有回收桶。`}
          </Text>
          <HStack gap={2} hAlign="end">
            {confirmError ? (
              <Button
                label="知道了"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirming(null);
                  setConfirmError(null);
                }}
              />
            ) : (
              <>
                <Button label="取消" size="sm" variant="ghost" onClick={() => setConfirming(null)} />
                {/*
                  按住才刪(見 startHold):外層掛 `data-hold-fill`,底下那條 `data-hold-fill-bar`
                  是填滿的底色(global.css)。`--hold-ms` 跟 JS 的計時器同一個數。
                  ⚠️ 不接 onClick:滑鼠與鍵盤的 click 都在**放開**時發,接了就變成「放開也刪」。
                */}
                <Stack
                  xstyle={styles.holdWrap}
                  {...{
                    'data-hold-fill': '',
                    'data-holding': isHolding ? '' : undefined,
                    'data-hold-done': isHoldDone ? '' : undefined,
                  }}
                  style={{'--hold-ms': `${HOLD_TO_DELETE_MS}ms`} as CSSProperties}
                >
                  <Button
                    label="按住刪除"
                    size="sm"
                    variant="destructive"
                    isLoading={busy}
                    // 觸控長按會發 contextmenu(常伴 pointercancel),擋掉才按得滿
                    onContextMenu={(e: MouseEvent) => e.preventDefault()}
                    onPointerDown={(e: PointerEvent) => {
                      if (e.button === 0) startHold();
                    }}
                    onPointerUp={endHold}
                    onPointerLeave={endHold}
                    onPointerCancel={endHold}
                    onKeyDown={(e: KeyboardEvent) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                        e.preventDefault();
                        startHold();
                      }
                    }}
                    onKeyUp={(e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') endHold();
                    }}
                  />
                  <Stack aria-hidden {...{'data-hold-fill-bar': ''}} />
                </Stack>
              </>
            )}
          </HStack>
        </VStack>
      ) : null}

      {/*
        表頭。**結構要跟資料列一模一樣**(同樣的 gap、同樣的圖示寬度、同一份 COLUMNS 寬度),
        對齊靠的就是這個 —— 兩邊各排一套的話怎麼調都會差幾 px。點欄名可以排序。
      */}
      <VStack ref={rowWindow.scrollerRef} xstyle={styles.scroller} gap={0}>
      <HStack xstyle={[styles.columnHead, styles.rowMin]} vAlign="center" gap={1}>
        {/*
          六欄都一樣:一顆排序鈕 + 右緣一條**既是分隔線也是把手**的東西。
          ⚠️ 名稱欄不是特例,跟其他五欄走同一條路 —— 不要給它自己一份寬度或自己一根把手。
        */}
        {COLUMNS.map((column) => (
          <Stack
            key={column.key}
            // 寬度算法在 `fileColumns.headColumnPx`(名稱欄連圖示那一格一起佔,理由寫在那裡)。
            // 代價:`Name` 這個字不再跟底下的檔名對齊,而是跟圖示對齊 —— 檔案總管就是這樣畫的。
            xstyle={[
              styles.headCell,
              !column.isPrimary && styles.headCellPad,
              columnWidth(headColumnPx(column, widths)),
            ]}
          >
            <SortButton column={column} sort={sort} onSort={setSort} />
            <ColumnResizer
              label={`調整 ${column.label} 欄寬度`}
              width={widths[column.key]}
              onResize={(next) => setWidths((rows) => ({...rows, [column.key]: next}))}
              onStep={(delta) =>
                setWidths((rows) => ({...rows, [column.key]: clampColumn(rows[column.key] + delta)}))
              }
            />
          </Stack>
        ))}
      </HStack>

      {/*
        回上一層那一列。根目錄沒有上一層,就不畫。
        ⚠️ 在 `<ul role="listbox">` **外面**,理由寫在 `styles.upRow` 上。
        點一下就走 —— 它不是「選取」,不必雙擊(雙擊是進資料夾那條路)。
      */}
      {path !== '/' ? (
        <HStack
          as="button"
          vAlign="center"
          gap={1}
          xstyle={[styles.upRow, styles.rowMin]}
          aria-label="回上一層"
          onClick={() => void load(parentPath(path))}
        >
          <Icon icon={CornerLeftUp} size="sm" color="secondary" />
          <Stack xstyle={columnWidth(widths.name)}>
            <Text maxLines={1}>..</Text>
          </Stack>
        </HStack>
      ) : null}

      <VStack
        ref={listRef}
        as="ul"
        role="listbox"
        aria-label="這個目錄裡的項目"
        aria-multiselectable
        xstyle={[styles.list, styles.rowMin]}
        gap={0}
        // 記下焦點在哪一列:捲走之後那一列也要留著畫(見 `keepRows`)
        onFocus={(e: FocusEvent) => {
          const name = (e.target as HTMLElement).dataset?.row;
          if (name !== undefined) setFocusedRow(name);
        }}
      >
        {uploads.map((u) => (
          <VStack
            key={u.id}
            as="li"
            xstyle={u.state === 'conflict' ? [styles.ask, styles.askRow] : styles.uploading}
            gap={1}
            // 進場在 global.css 的 `[data-upload-row]`(多檔連續插進來,transition 才接得住)
            {...{'data-upload-row': ''}}
          >
            {u.state === 'conflict' ? (
              <HStack vAlign="center" gap={2} wrap="wrap">
                <StackItem size="fill">
                  <Text type="supporting">{u.name} 已存在,要覆蓋嗎?</Text>
                </StackItem>
                <Button
                  label="覆蓋"
                  size="sm"
                  variant="destructive"
                  onClick={() => conflictResolver.current?.('overwrite')}
                />
                <Button label="略過" size="sm" variant="ghost" onClick={() => conflictResolver.current?.('skip')} />
              </HStack>
            ) : u.state === 'error' || u.state === 'skipped' ? (
              <HStack vAlign="center" gap={2}>
                <StackItem size="fill">
                  <Text type="supporting" color="secondary" maxLines={2}>
                    {u.name}:{u.state === 'skipped' ? '已略過' : u.error}
                  </Text>
                </StackItem>
                <Button
                  label="知道了"
                  size="sm"
                  variant="ghost"
                  onClick={() => setUploads((rows) => rows.filter((r) => r.id !== u.id))}
                />
              </HStack>
            ) : (
              <>
                <Text type="supporting" maxLines={1}>
                  {u.state === 'waiting' ? '等待上傳 ' : '上傳 '}
                  {u.name}
                </Text>
                <ProgressBar
                  label={`上傳 ${u.name}`}
                  value={Math.round(u.fraction * 100)}
                  isLabelHidden
                  hasValueLabel
                  isIndeterminate={u.state === 'waiting'}
                />
              </>
            )}
          </VStack>
        ))}
        {loading && !listing ? (
          <Stack xstyle={styles.center}>
            <LoadingScreen isCompact label="讀取中" />
          </Stack>
        ) : null}
        {error ? (
          <Stack xstyle={styles.center}>
            <Text type="supporting" color="secondary">
              {error}
            </Text>
          </Stack>
        ) : null}
        {!error && listing && entries.length === 0 && !loading ? (
          <Stack xstyle={styles.center}>
            <Text type="supporting" color="secondary">
              這個資料夾是空的
            </Text>
          </Stack>
        ) : null}
        {/* 沒畫的列用空白撐出高度,捲軸長度跟全部畫出來一樣(`drawPlan`)。最上面那塊 0 列也要畫 */}
        <RowSpacer ref={rowWindow.topSpacerRef} rows={rowWindow.plan.top} rowPx={rowWindow.rowPx} />
        {rowWindow.plan.rows.map(({index, gapBefore}) => {
          const entry = entries[index];
          return (
            // 空白放進同一個 Fragment 的固定位置(沒有就是 null):列本身才不會因為前面多一塊空白而重掛、丟掉焦點
            <Fragment key={entry.name}>
              {gapBefore > 0 ? <RowSpacer rows={gapBefore} rowPx={rowWindow.rowPx} /> : null}
              <FileRow
                entry={entry}
                position={index + 1}
                total={entries.length}
                isSelected={selectedSet.has(entry.name)}
                onSelect={onRowSelect}
                onEnter={onRowEnter}
                onMoveFocus={onRowMoveFocus}
              />
            </Fragment>
          );
        })}
        <RowSpacer rows={rowWindow.plan.bottom} rowPx={rowWindow.rowPx} />
      </VStack>
      </VStack>

      <HStack xstyle={styles.foot} vAlign="center" gap={2}>
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {listing ? `${entries.length} 個項目` : ''}
          {selectedEntries.length > 0 ? ` · 已選 ${selectedEntries.length} 個` : ''}
        </Text>
      </HStack>

      <Stack xstyle={[styles.drop, dragging && styles.dropOn]} aria-hidden={!dragging}>
        <Text>放開以上傳到</Text>
        <Text type="supporting" color="secondary">
          {shortPath(path, home)}
        </Text>
      </Stack>
    </VStack>
  );
}
