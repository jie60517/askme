/**
 * 側邊欄。
 *
 * 版面照 Astryx 的 `shell-side-nav` 範本:
 *   - 上面一塊 isHeaderHidden 的「Menu」區,New chat / Search / New folder 都是帶圖示的 SideNavItem
 *   - Divider
 *   - 資料夾用 SideNavItem 的巢狀(collapsible + children)—— 範本裡的 Workspace 就是這個結構
 *   - 對話列的 endContent 一律靠右,順序固定:脈動點 → 共用圖示 → 未讀數字,
 *     hover/focus 時最後面再多一顆「⋯」選單(不取代前面那些)
 *   - 底部是 isHeaderHidden 的「Account」區
 *
 * 寬度拖曳、拖過頭收合、收合時的把手是**自己的 `SidebarResizer`**,刻意不用 SideNav 內建的 `resizable`
 *(命中區定位錯、收合時把 0 寫進 autoSaveId、收合後自己也藏起來 —— 三個理由見那個檔案開頭)。
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {createPortal} from 'react-dom';
import * as stylex from '@stylexjs/stylex';

import {Avatar} from '@astryxdesign/core/Avatar';
import {Badge} from '@astryxdesign/core/Badge';
import {Token} from '@astryxdesign/core/Token';
import {ContextMenu, ContextMenuItem} from '@astryxdesign/core/ContextMenu';
import {Divider} from '@astryxdesign/core/Divider';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {
  SideNav,
  SideNavCollapseButton,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {
  BarChart3,
  Building2,
  Crown,
  FolderPlus,
  KeyRound,
  LogOut,
  Moon,
  NotebookPen,
  Plus,
  Search,
  ShieldCheck,
  SquareTerminal,
  Sun,
  User,
  UserCircle,
  Users as UsersIcon,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import {
  applyOrder,
  moveWithin,
  readSidebarOrder,
  swapWithin,
  writeSidebarOrder,
  type OrderMap,
  type Reorder,
} from './sidebar-order';
import {ColorTag, fixedOrigin, HoverRegion, MoveMenuItem, sideNavStyles, TITLE_INPUT_LIMIT} from './sideNavParts';
import {formatUnreadCount, isUnreadCapped} from './unread-count';
import {easeStep, frameDelta} from '../lib/frameEase';
import {getToken, IDENTITY_CHANGED} from '../lib/auth';
import {BRAND_LOGO_SIZE, BRAND_NAME} from '../lib/brand';
import {
  buildFolderTree,
  CONVERSATIONS_UPDATED,
  createFolder,
  deleteConversation,
  deleteFolder,
  splitConversations,
  listConversations,
  listFolders,
  notifyConversationsUpdated,
  renameConversation,
  renameFolder,
  setConversationFolder,
  setFolderParent,
  withPendingConversations,
  wouldCycle,
  type ConversationSummary,
  type Folder,
  type FolderTree,
} from '../lib/conversationsApi';
import {exportConversation} from '../lib/exportConversation';
import {prefetchAllowedModels} from '../lib/chatApi';
import {signOut} from '../lib/loginApi';
import {getActiveStreams, getPending, subscribeAll} from '../lib/runs';
import {
  readFlag,
  readJson,
  readString,
  writeFlag,
  writeJson,
  writeString,
} from '../lib/safeStorage';
import {personName} from '../lib/people';
import {avatarOf, usePeopleDirectory} from '../lib/peopleDirectory';
import {transitionMs} from '../lib/transitionMs';
import {MOBILE_QUERY, useMediaQuery} from '../lib/media';
import {PAGE_SWAP_CANCEL_EVENT, PAGE_SWAP_EVENT} from '../lib/pageSwap';
import {toggleTheme, useThemeMode} from '../lib/theme';
import {toastError} from '../lib/toast';
import type {Me} from '../lib/useIdentity';
import {avatarTint} from './avatar-colors';
import {ColorPicker} from './ColorPicker';
import {
  colorValue,
  hasColor,
  readConversationColors,
  readFolderColors,
  writeConversationColors,
  writeFolderColors,
} from './sidebar-colors';
import {folderIcon, readFolderIcons, writeFolderIcons} from './folder-icons';
import {
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  SidebarResizer,
} from './SidebarResizer';
import {ShareDialog} from './ShareDialog';
import {useLongPressDrag} from './useLongPressDrag';
import {FolderIconPicker} from './FolderIconPicker';
import {Logo} from './Logo';
import {BrandHold} from './BrandHold';
import {MobileBrandBar} from './MobileBrandBar';

const FOLDERS_OPEN_KEY = 't100_folders_open';

/**
 * Personal / Shared 也能挑圖示與顏色 —— 它們在畫面上就是
 * 兩個資料夾的樣子,只有它們不能改會顯得像是壞的。
 * 存在跟資料夾同一張表裡:資料夾的 key 是 id 轉的字串(全是數字),撞不到這兩個。
 */
/**
 * 「收合已經按下去了,React 還沒跟上」的那兩幀(見 `collapsible.onCollapsedChange`)。
 *
 * ⚠️ **這個屬性只有我們管,React 碰都不碰** —— 那正是它存在的理由:
 * 手寫一個 React 也管的東西(`style.width`、`data-animating`)會在它從頭到尾
 * 沒進過那個狀態時爛掉(使用者在兩幀內改變主意),而 React 不會重寫一個
 * 「props 跟上次一樣」的值,手寫的痕跡就留在 DOM 上。
 * 樣式見 `global.css` 的 `[data-collapse-pending]`。
 */
const COLLAPSE_PENDING = 'data-collapse-pending';

/*
 * 🚨 **收合「沒有」進場動畫,只有寬度在動,內容在最後一幀換成 rail。不要再加進場動畫。**
 *
 * 整塊淡入/位移會讓收完的畫面閃一下、抖一下;逐列淡入則讓 rail 中段留一個洞
 *(上下兩區已經是實心的,中間的圖示還在慢慢補上),看起來就是中間那塊在閃。
 * 「依序出現」在定義上就是「一開始看不到」,那個洞是它的本質,調參數消不掉。
 */

/**
 * rail 浮層裡那份清單的記號 —— **漂浮框的樣態靠它認**(`global.css`)。
 *
 * 只在收合時掛。認我們自己的 `data-*`、不認設計系統的 `.astryx-popover-surface`,
 * 理由跟這個檔案其他幾條一樣:那是它的內部結構,升版會靜靜失效。
 */
const RAIL_FLYOUT = 'data-rail-flyout';

/** 對話清單的兩個區:共用進來的、自己的 */
type ChatSectionKey = 'shared' | 'personal';

const PERSONAL_KEY = 'personal';
const SHARED_KEY = 'shared';
/**
 * 「這是一份會長的清單」的記號,只掛在**資料夾**與**對話**那兩個區塊上。
 *
 * global.css 靠它把區塊之間的間距收到跟列距一樣(否則資料夾與 Shared 之間的距離
 * 會跟資料夾彼此之間不同)。**不能直接打所有 `.astryx-side-nav-section`**:
 * 側邊欄裡還有別的區塊 —— 最上面的工具區、貼齊底部的帳號區(它住在 sticky 裡,
 * 高度動到會牽動整塊),不縮範圍的話那幾個區塊會一起被改到。
 */
const LIST_SECTION = {'data-list-section': ''} as const;

const COLLAPSED_KEY = 't100_sidebar_collapsed';
const WIDTH_KEY = 't100_sidebar_width';

/**
 * ⚠️ 寬度不能交給 SideNav 的 autoSaveId。
 *
 * 收合的時候它會把當下量到的寬度(0)寫進去,下次載入就還原成 0px ——
 * 側邊欄還在 DOM 裡但寬度是零,看起來就是整個不見了,而且很難查:
 * 元素、display、opacity 全部正常,只有 inline width 是 0。
 *
 * 所以自己存,而且**只收合理範圍內的值**。
 */
function readSidebarWidth(): number {
  const raw = Number(readString(WIDTH_KEY));
  if (!Number.isFinite(raw) || raw < MIN_WIDTH || raw > MAX_WIDTH) return DEFAULT_WIDTH;
  return raw;
}

function saveSidebarWidth(width: number) {
  // 收合過程會回報極小的寬度,那不是使用者的選擇,不要存
  if (width < MIN_WIDTH || width > MAX_WIDTH) return;
  writeString(WIDTH_KEY, String(Math.round(width)));
}

const ADMIN_LINKS = [
  /*
   * ⚠️ **側邊欄這幾條是英文,頁面裡面才是中文。**
   * 側邊欄照「介面一律英文」,繁體中文的例外只到那幾頁的內容為止。
   * 不要把它翻成中文。
   */
  {href: '/stats', label: 'Usage', icon: BarChart3},
  {href: '/security', label: 'Security', icon: ShieldCheck},
  {href: '/users', label: 'Users', icon: UsersIcon},
] as const;

const styles = stylex.create({
  /**
   * 帳號區的**選取底色**(見 `SelectionPill`)。長相照 Astryx 導覽列自己的選取態
   *(`navItemStyles.selected`:`--color-neutral` + `--radius-element`),所以滑完停下來跟導覽列內建的選取態一模一樣。
   * 位移 220ms、前後都收的曲線(在畫面上移動的東西,起步太猛會像被甩過去);淡入淡出 150ms。
   * 時間是固定值,不走 token。
   * 減少動態:不滑,只淡。強制色彩模式:不畫,交還給導覽列自己的 Highlight 底色(global.css 那條也讓開)。
   */
  selectionPill: {
    position: 'absolute',
    insetBlockStart: 0,
    insetInlineStart: 0,
    zIndex: 0,
    pointerEvents: 'none',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-neutral)',
    transitionProperty: {
      default: 'transform, opacity',
      '@media (prefers-reduced-motion: reduce)': 'opacity',
    },
    // 兩份清單照 transitionProperty 的位置對:位移 220ms 前後都收、淡入淡出 150ms;減少動態時只剩淡入淡出那一格
    transitionDuration: {default: '220ms, 150ms', '@media (prefers-reduced-motion: reduce)': '150ms'},
    transitionTimingFunction: {
      default: 'cubic-bezier(0.65, 0, 0.35, 1), var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'var(--ease-standard)',
    },
    display: {default: null, '@media (forced-colors: active)': 'none'},
  },
  /**
   * 品牌 logo 外面那個框:**寬度就是列上一顆圖示的寬度**(`--spacing-4` = 16),logo 在裡面置中。
   *
   * ⚠️ 這個框存在的唯一理由是「收合的時候 logo 不能往左跳 2px」。
   * 沒有這個框時,展開時 logo 的中心在 **26**、收成 rail 之後是 **24**,而**列上每一顆圖示都是 24**。
   * 原因不是內距 —— 是**尺寸**:logo 是 20.25px、列上的圖示是 16px,兩者都從 x=16 開始靠左排,
   * 中心自然差 (20.25−16)/2 ≈ 2;rail 那頭是置中排的,所以剛好落在 24。
   * 包一個跟圖示同寬的框再置中,logo 就對稱地各往外凸 2px,**兩種狀態的中心都是 24**。
   */
  brandIcon: {
    width: 'var(--spacing-4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * 帳號區上面那條線與底下第一列之間的空白。
   * 見那條 `<Divider>` 旁邊的說明:不留的話整塊會黏在線上。
   */
  accountDivider: {
    /*
     * 這條線與底下帳號那幾列的位置是逐項對齊過的,**不要再動**。
     *
     * ⚠️ 這塊 sticky 是**貼底錨定**的:改上緣只會把上緣往下退、讓捲動區變長,
     * 線本身與底下那幾列從底往上量的距離都不變。所以上緣歸零是安全的 ——
     * 清單捲到底時,最後一列跟這條線只留捲動區自己的 4px
     * (跟 Search 到上面那條線一樣)。
     * ⚠️ 連動:`global.css` 的 `.astryx-side-nav > :last-child` 的
     * padding-block-start 也要是 0,兩邊一起看才是實際間距。
     */
    marginBlockStart: 0,
    marginBlockEnd: 'var(--spacing-1)',
  },
  dropTarget: {
    display: 'block',
    borderRadius: 'var(--radius-element)',
    /*
     * 粗細借焦點環那一組 token 的**一半**(整粗太搶眼)。
     * 借 token 而不是寫死:佈景把焦點環調粗時這裡會跟著,比例不會跑掉。
     */
    outline: 'calc(var(--focus-outline-width) / 2) var(--focus-outline-style) transparent',
    // 往內畫,不然外框會被旁邊那一列蓋掉
    outlineOffset: 'calc(var(--focus-outline-width) / -2)',
    backgroundColor: 'transparent',
  },
  /*
   * ⚠️ 「亮起來」那一組**不在這裡** —— 它在 `global.css` 的 `[data-drop-over]`。
   * 拖曳中那個屬性是 `paintDropOver` 直接掛上去的(不走 React,見那邊的說明),
   * 而 StyleX 的 class 是 render 時決定的,兩者搭不起來。
   */
  /**
   * 資料夾的識別:**圖示底下**一條自己挑顏色的短線。
   *
   * 不用整塊上底色(資料夾一多,側邊欄變成一疊色塊),也不用整列的底線
   *(看起來像分隔線,不像那個資料夾的記號)。
   * 貼著圖示的一條短線最像「這個資料夾的顏色」。
   *
   * 顏色走自訂屬性 `--marker-color`(不叫 folder:Personal / Shared 也用同一條),
   * 由外層的 Stack 設定 ——
   * 直接把 inline style 下在 SideNavItem 上沒有用(它不保證把 `style`
   * 轉到掛 `xstyle` 的那個元素上)。自訂屬性會繼承,設在外面一定到得了。
   */
  folderIconWrap: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
  },
  folderIconBar: {
    position: 'absolute',
    /*
     * **只在圖示底下**,不延伸到名稱底下。
     * 一條貼著圖示的短線最像「這個資料夾的顏色」;拉到名字底下就變成一條底線,
     * 看起來像超連結,而且名字長的資料夾整列都是色的。
     */
    insetInline: 0,
    // 貼在圖示正下方一點點
    insetBlockEnd: 'calc(var(--spacing-1) * -1)',
    // 兩倍邊線粗,一倍太細看不出是顏色標記
    height: 'calc(var(--border-width) * 2)',
    borderRadius: 'var(--radius-full)',
    backgroundColor: 'var(--marker-color, transparent)',
  },
  /** 按住拖的時候不要順便選到文字 */
  row: {
    userSelect: 'none',
    // iOS 長按連結會跳預覽 / 拷貝選單,跟長按拖曳搶同一個手勢(同 FilePanel 的 holdWrap)
    WebkitTouchCallout: 'none',
    // 高亮塊畫在底下,列本身要在上面才看得到字
    position: 'relative',
    zIndex: 1,
  },

  /**
   * 高亮塊畫在底下,列本身要在上面才看得到字(見 hoverPill)。
   * 對話列在 `row` 裡已經有,資料夾那一層要另外給 —— 少了它,
   * 滑到資料夾上時那塊高亮會直接蓋住資料夾的名字。
   */
  aboveHoverPill: {
    position: 'relative',
    zIndex: 1,
  },
  /**
   * rail 浮層還沒掛清單時的佔位(見 `RailFlyoutGate`)。
   * 要有高度:清單掛上去之前那一瞬間,浮層不該是一條 0 高的線。
   */
  railFlyoutPlaceholder: {
    minHeight: 'var(--spacing-4)',
  },
});

/**
 * 往上找第一個會捲的祖先;找不到就是 null。
 * 判斷條件跟果凍捲動那支 effect 一樣是 `overflowY === 'auto'`(見 `scrollerRef`)——
 * 兩條路認捲動層的標準不能分岔,不然哪天設計系統改了,只會有一邊壞掉。
 */
function scrollParent(from: HTMLElement): HTMLElement | null {
  for (let node = from.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === 'auto') return node;
  }
  return null;
}


/**
 * 拖曳的複本要自己帶著走的自訂屬性:資料夾底下那條線、對話列右邊那顆點。
 * 兩個都是從**外層**的 Stack 繼承下來的,複本離開那層就查不到了。
 */
const DRAG_INHERITED_PROPS = ['--marker-color', '--item-color'] as const;


/**
 * 帳號區(SSH Server、Work Flow、Usage…)的**選取底色**,換頁時滑到新的那一列。
 *
 * 換功能頁時「我剛點了哪裡」交給這塊:它一直都在、從舊的那一列滑到新的那一列;內容區只快速淡換
 *(global.css「換功能頁的過場」)。導覽列內建的選取底色是畫在每一列自己身上的,換頁時是原地一格換掉,
 * 所以這塊在的時候要把那一列自己的底色讓掉(根節點掛 `data-selection-pill`,global.css 那條認它)——
 * 不讓的話滑動的半路上會看到兩塊。
 *
 * - 放在 `HoverRegion` 裡當第一個子元素,定位基準就是那一區的根節點(本來就是 relative)。
 * - 沒有選取的頁(對話頁)就淡掉;從「沒有」到「有」直接出現在那一列再淡入,不從半空中滑過來。
 * - 側邊欄寬度變了(拖寬、rail)就重量一次,不滑。
 * - 滑鼠剛好停在選取的那一列時它浮著 2px(global.css 的 `--row-float`),量的時候扣回來。
 */
function SelectionPill({pathname}: {pathname: string}) {
  const ref = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<{top: number; left: number; width: number; height: number} | null>(null);
  const [isShown, setIsShown] = useState(false);
  /** 這一次直接到位、不滑(剛出現,或只是寬度變了) */
  const [isSnap, setIsSnap] = useState(true);
  const shownRef = useRef(false);

  /** 移到 `item` 那一列(null = 淡掉) */
  const place = useCallback((item: HTMLElement | null, snap: boolean) => {
    const root = ref.current?.parentElement;
    if (!root) return;
    if (!item) {
      shownRef.current = false;
      setIsShown(false);
      root.removeAttribute('data-selection-pill');
      return;
    }
    const a = item.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    const lift = Number.parseFloat(getComputedStyle(item).translate.split(' ')[1] ?? '0') || 0;
    setIsSnap(snap || !shownRef.current);
    shownRef.current = true;
    setIsShown(true);
    setBox({left: a.left - b.left, top: a.top - b.top - lift, width: a.width, height: a.height});
    root.setAttribute('data-selection-pill', '');
  }, []);

  /** 量現在選取的那一列(導覽列自己標的 `aria-current="page"`) */
  const measure = useCallback(
    (snap: boolean) => {
      const root = ref.current?.parentElement;
      place(root?.querySelector<HTMLElement>(".astryx-side-nav-item[aria-current='page']") ?? null, snap);
    },
    [place],
  );

  useLayoutEffect(() => measure(false), [pathname, measure]);
  useEffect(() => {
    const root = ref.current?.parentElement;
    if (!root) return;
    const observer = new ResizeObserver(() => measure(true));
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure]);
  /*
   * **點下去那一刻就滑**(`lib/pageSwap.ts` 的 `startPageSwap` 發的事件),不等新頁掛上 ——
   * lazy 的頁面第一次進去要先下載那一頁的程式,等 commit 才滑的話,底色會晚半拍才動。
   * 掛上之後上面那個 layout effect 再量一次,量到的是同一列,不會再動。
   * ⚠️ 點的不是這一區的連結(對話列、頁面裡的連結)就**不動**,交給網址真的換了之後那次量:
   * 這時候就淡掉的話,舊的那一列還標著選取、自己的底色會冒回來,一路留到新頁掛上。
   * 換頁放棄了(`PAGE_SWAP_CANCEL_EVENT`)→ 回到目前真正選取的那一列。
   */
  useEffect(() => {
    const onSwap = (e: Event) => {
      const href = (e as CustomEvent<string>).detail;
      const root = ref.current?.parentElement;
      if (!root) return;
      const link = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].find((a) => a.getAttribute('href') === href);
      if (link) place(link.closest<HTMLElement>('.astryx-side-nav-item') ?? link, false);
    };
    const onCancel = () => measure(false);
    window.addEventListener(PAGE_SWAP_EVENT, onSwap);
    window.addEventListener(PAGE_SWAP_CANCEL_EVENT, onCancel);
    return () => {
      window.removeEventListener(PAGE_SWAP_EVENT, onSwap);
      window.removeEventListener(PAGE_SWAP_CANCEL_EVENT, onCancel);
    };
  }, [place, measure]);

  return (
    <Stack
      ref={ref}
      aria-hidden
      xstyle={styles.selectionPill}
      style={{
        transform: box ? `translate3d(${box.left}px, ${box.top}px, 0)` : undefined,
        width: box?.width,
        height: box?.height,
        opacity: isShown && box ? 1 : 0,
        // 只淡不滑的那一次:時間與曲線也要換成淡入那一組(清單是照位置對的,只留 opacity 會吃到 220ms 那一格)
        ...(isSnap ? SNAP_TRANSITION : null),
      }}
    />
  );
}

/** `SelectionPill` 直接到位、只淡入淡出時的過場(跟 `styles.selectionPill` 的淡入淡出那一格同一組) */
const SNAP_TRANSITION = {
  transitionProperty: 'opacity',
  transitionDuration: '150ms',
  transitionTimingFunction: 'var(--ease-standard)',
} as const;


/**
 * 現在被拖著的是什麼。
 *
 * 對話與資料夾共用同一套長按拖曳(同一個放置目標、同一個幽靈),
 * 但放開之後要做的事不一樣,所以帶一個 kind —— 用 id 的型別去猜
 *(string 是對話、number 是資料夾)遲早會有人猜錯。
 */
type DragPayload =
  | {
      kind: 'chat';
      id: string;
      title: string;
      /**
       * 這一列住在哪一層(`layer()` 的 listKey)。
       *
       * 換位置**只在同一層之內**做:拖到別層的對話上要做的是「搬過去」,
       * 那是資料夾放置目標的事,不是排序。少了這個欄位就分不出來 ——
       * 兩層的 key 都只是 conversation_id。
       */
      listKey: string;
    }
  | {kind: 'folder'; id: number; title: string};

/**
 * 「New chat here」按下之後,最多等多久讓那組新對話真的被送出。
 * 10 分鐘:夠打一題很長的問題,但不會長到隔天還記得。
 */
const NEW_CHAT_IN_FOLDER_MAX_MS = 10 * 60 * 1000;

/**
 * 每一層對話清單的 key(`layer()` 的 listKey)。**拼與拆只在這三支**:
 * Personal / Shared 各一個常數,資料夾用 `folderChatsKey(id)`,反查用
 * `folderOfChatList()`。三處共用同一份組裝與拆解,不要各自手拼字串再用 regex 拆回。
 */
const PERSONAL_CHATS_KEY = 'personal:chats';
const SHARED_CHATS_KEY = 'shared:chats';
const FOLDER_CHATS_PREFIX = 'folder:';
const FOLDER_CHATS_SUFFIX = ':chats';
function folderChatsKey(folderId: number): string {
  return `${FOLDER_CHATS_PREFIX}${folderId}${FOLDER_CHATS_SUFFIX}`;
}

/** 對話列當放置目標時的 id 前綴(資料夾用 `data-drop-folder`,數字或 `none`)。 */
const CHAT_TARGET_PREFIX = 'chat:';

/** 對話列的放置目標 id。**拼與拆(`parseChatTarget`)只在這兩支**,不要在別處手拼。 */
function chatTarget(listKey: string, id: string): string {
  return `${CHAT_TARGET_PREFIX}${listKey}:${id}`;
}

/**
 * `chat:<listKey>:<conversation_id>` 拆回兩半。
 *
 * ⚠️ 從**右邊**切:`listKey` 自己就含冒號(`folder:12:chats`),而
 * conversation_id 是 UUID v4(見 `lib/ids.ts`),一定沒有冒號 —— 所以最後一個
 * 冒號後面必定是 id。從左邊 split 會把 listKey 剁碎。
 */
function parseChatTarget(target: string): {listKey: string; id: string} {
  const rest = target.slice(CHAT_TARGET_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  return {listKey: rest.slice(0, cut), id: rest.slice(cut + 1)};
}

/**
 * 一層對話清單住在哪個資料夾裡。
 *
 * ⚠️ 「把對話拖到資料夾 B 裡面某一列上」要算「搬進 B」,但對話列本身也是放置目標,
 * `closest` 會先撞到那一列。所以跨層放下時要能從那一列的 listKey 反推出它的資料夾,當成搬家。
 *
 * `undefined` = 那一層不是任何人的目的地(Shared —— 共用不是資料夾,
 * 見 chatSections 上面那段)。
 */
function folderOfChatList(listKey: string): number | null | undefined {
  if (listKey === PERSONAL_CHATS_KEY) return null;
  if (!listKey.startsWith(FOLDER_CHATS_PREFIX) || !listKey.endsWith(FOLDER_CHATS_SUFFIX)) {
    return undefined;
  }
  const id = Number(listKey.slice(FOLDER_CHATS_PREFIX.length, -FOLDER_CHATS_SUFFIX.length));
  return Number.isInteger(id) ? id : undefined;
}

/**
 * 「一張 id → key 的表,改一格」。
 *
 * 圖示、資料夾顏色、對話顏色三張表的寫法一模一樣(展開 → setState → 寫本機),
 * 分開寫三份的話,哪天多一個「忘記寫回本機」的版本不會有人發現。
 */
function assignKey(
  map: Record<string, string>,
  setMap: (next: Record<string, string>) => void,
  persist: (next: Record<string, string>) => void,
) {
  return (id: string | number, key: string) => {
    const next = {...map, [id]: key};
    setMap(next);
    persist(next);
  };
}

function readOpenFolders(): number[] {
  return (
    readJson(FOLDERS_OPEN_KEY, (value) =>
      Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : null,
    ) ?? []
  );
}

export function Sidebar({
  me,
  onOpenSearch,
  onOpenChangePassword,
  onOpenSettings,
}: {
  me: Me;
  /**
   * 打開找舊對話的那個面板(⌘K 那一個)。
   *
   * 側邊欄不就地長出搜尋框,這裡只負責把 ⌘K 面板叫出來;
   * 「打字立刻篩標題」在面板裡(見 `CommandPalette` 的檔頭)。
   */
  onOpenSearch: () => void;
  /**
   * 打開「改密碼」/「個人設定」對話框。**對話框本身不在側邊欄裡**,由外層(`App.tsx` 的 Chrome)掛。
   *
   * ⚠️ 手機版的側邊欄整個放在抽屜裡,點選單項目抽屜就關起來、裡面的東西跟著卸掉 ——
   * 對話框若寫在這裡,從手機抽屜點「Change password」對話框根本不會出現(設定也一樣)。
   * 跟 `onOpenSearch` 同一個做法:狀態放在不會被卸掉的那一層,這裡只負責叫它。
   */
  onOpenChangePassword: () => void;
  onOpenSettings: () => void;
}) {
  const navigate = useNavigate();
  const {pathname} = useLocation();
  const mode = useThemeMode();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  /**
   * 清單**抓到過了沒**。初值是空陣列,不分開記的話,第一次抓回來之前那一下會顯示「No chats yet.」——
   * 有對話的人每次開站都先看到「沒有對話」再跳出清單。抓失敗也維持 false:不能確定就不講。
   */
  const [isListLoaded, setIsListLoaded] = useState(false);
  /** 最近一次抓清單失敗了。還沒抓到過又失敗時,要講出來,不能永遠留白(抓到過就照舊顯示手上那份) */
  const [listFailed, setListFailed] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderItems, setFolderItems] = useState<Record<string, number>>({});

  const [renamingId, setRenamingId] = useState<string>();
  const [renamingFolderId, setRenamingFolderId] = useState<number>();
  const [draft, setDraft] = useState('');
  // 展開狀態是「我看側邊欄的方式」,只留在本機,不進伺服器
  const [openFolders, setOpenFolders] = useState<number[]>(readOpenFolders);
  // 圖示與顏色只存本機(後端沒有這兩個欄位),見 folder-icons.ts / sidebar-colors.ts
  const [icons, setIcons] = useState<Record<string, string>>(readFolderIcons);
  const [colors, setColors] = useState<Record<string, string>>(readFolderColors);
  const [conversationColors, setConversationColors] =
    useState<Record<string, string>>(readConversationColors);
  /**
   * 使用者自己排的順序(見 sidebar-order.ts)。只存本機。
   * ⚠️ 每一次移動都要 `bumpPinned()` —— 右鍵選單開著時高亮塊是**釘**在那一列上的,
   * 那一列換了位置,不重量的話高亮會留在原地(選單不關,所以看得一清二楚)。
   */
  const [order, setOrder] = useState<OrderMap>(readSidebarOrder);
  /**
   * DOM 現在是照哪一份順序排的。
   *
   * ⚠️ **右鍵選單開著的時候不能動 DOM。** 選單是開在 top layer 的 popover,
   * 而那個 popover 就長在被移動的那一列底下 —— DOM 節點一被搬走
   *(React 的重排就是 removeChild + insertBefore),瀏覽器立刻把 popover 收掉。
   * 純 DOM 的 `insertBefore` 就足以讓開著的選單消失,跟 React 無關。
   * 而選單的用途正是「連按好幾下上下」,選單不能關。
   *
   * 所以分成兩份順序:看到的那份走 CSS `order`(不動 DOM),
   * 選單關掉之後才把 DOM 排回去(見下面那個 effect)。
   * 兩份一致的時候 CSS order 就等於 DOM 的位置,畫面不會有任何變化。
   */
  const [renderOrder, setRenderOrder] = useState<OrderMap>(order);
  const [pinnedNonce, bumpPinned] = useReducer((n: number) => n + 1, 0);
  // 選單關掉就 +1,讓圖示挑選器整個重新掛載(展開狀態歸零)。
  // 用 key 而不是往下傳 isExpanded:狀態留在挑選器自己身上,外面不必知道它展開了沒。
  const [pickerNonce, setPickerNonce] = useState(0);
  const navRef = useRef<HTMLElement>(null);
  /**
   * 真正在捲的那一層。滾輪那段 effect 已經找過一次,存下來給拖曳的邊緣自動
   * 捲動共用 —— 兩邊各找一次的話,哪天那個「用計算樣式找」的做法要改,
   * 會有一處被忘記。
   * ⚠️ **手機抽屜由另一支寫入**(`bindDrawerList`):抽屜模式沒有 `<nav>`,
   * 那支只在掛載時跑一次的 effect 找不到它。兩邊認捲動層的條件一樣(`overflowY === 'auto'`),
   * 改一邊就要改另一邊。
   */
  const scrollerRef = useRef<HTMLElement | null>(null);
  /**
   * 果凍捲動那支 effect 把「**捲回最上面**」publish 到這裡(見 `resetScroll`)。
   *
   * 為什麼要繞這一手:`pos` / `target` / `raf` 是那支 effect 的區域變數,外面碰不到 ——
   * 而歸零如果不連它們一起改,下一幀就會被那個迴圈寫回去。
   *
   * ⚠️ **只有「硬歸零」一種,沒有動畫版。** 收合時讓清單一路滑上去會讓畫面震動
   *(理由見 `onCollapsedChange`)。歸零只發生在換成 rail 的那一幀 —— 那一幀內容整批被換掉,所以看不到。
   */
  const scrollToTopRef = useRef<(() => void) | null>(null);
  /**
   * 收合時把清單捲回最上面:「收起來 = 這一趟結束了」,下次打開從頭看。
   *
   * 為什麼要自己做:rail 的內容比展開時矮得多,瀏覽器**只會把 `scrollTop` 夾到新的
   * 上限,不會歸零**;再展開時內容長回來,那個被夾住的值又被還原回去 ——
   * 結果就是「收起來再打開,還停在剛才捲到的地方」。
   *
   * ⚠️ **只有 rail 自己也捲得動的時候才看得出差別**:視窗夠高、rail 一頁放得下
   *(上限 = 0)時,瀏覽器的夾值剛好也等於 0,兩種寫法看起來一樣。
   * 要驗這條就在矮視窗(或資料夾多到 rail 捲得動)的情況下驗。
   *
   * 🚨 **只在換成 rail 的那一幀歸零一次,收合期間不准讓它自己捲。**
   * 「按下去就開始滑上去」會讓畫面震動 —— 完整的因果寫在 `onCollapsedChange` 裡那段紅字。
   * ⚠️ 也不要 `scrollTo({behavior: 'smooth'})`:平滑捲動沒有辦法在指定的時間點收尾,
   * 會跟下一次展開撞在一起。
   *
   * 🚨 **不能只寫 `scrollTop = 0`,一定要走果凍捲動 publish 出來的那支。**
   *
   * 果凍捲動的 `step()` **在 rAF 的每一幀都覆寫** `scroller.scrollTop = pos`,而它的
   * `onScroll` **只有 `raf === undefined`(迴圈沒在跑)時才對表** —— 所以趁迴圈還活著
   * 從外面寫 `scrollTop`,下一幀就被寫回逼近中的舊位置,而且不會有任何錯誤。
   *
   * 重疊帶算得出來:`SCROLL_EASE` 是每 60Hz 一幀走掉剩餘距離的 0.18,gap 每幀乘 0.82 ——
   * 100px 的 gap 要約 **27 幀 ≈ 450ms** 才收斂到 0.5px 以內,而收尾那次硬歸零排在
   * 寬度跑完的 **340ms**。所以「滾輪捲到底 → 馬上按收合」很可能落在迴圈還活著的時候 ——
   * 這條不是邊角情況。
   * ⚠️ 驗這條**一定要派真的 `wheel` 事件**:直接寫 `scroller.scrollTop = 99999`
   * 不會啟動那個迴圈(`raf` 是 `undefined`),測起來永遠是過的。
   */
  const resetScroll = useCallback(() => {
    scrollToTopRef.current?.();
  }, []);
  /**
   * 每一層現在**看得到的順序**(`layer()` 算的 keys)。
   *
   * 放開手指那一刻要拿它去換位置,而那時候只有 payload 與 target 兩個 id ——
   * 沒有這份表就不知道「這一層現在長什麼樣」。在 render 期間寫進 ref 是刻意的:
   * 它是一份快取,不是狀態(寫它不需要、也不該觸發重繪)。
   */
  const listKeysRef = useRef<Record<string, string[]>>({});

  /*
   * 滾輪捲動的順滑感(果凍捲動)。原生滾輪是一格一格跳的;這裡把 wheel
   * 攔下來,scrollTop **指數逼近**目標 —— 越接近越慢,但**不會過衝**
   * (過衝看起來就是「滾一下抖一下」,見 step() 的說明)。
   * - 只攔滾輪;拖捲軸、鍵盤、觸控照原生(scroll 事件裡發現位置被外力改了
   *   就重新對表,不然拖完捲軸滾輪會跳回舊位置)。
   * - reduced-motion 不攔,維持原生。
   * - ⚠️ 會捲的那一層是 SideNav 的直接子層裡 overflowY=auto 的那個
   *   (跟 global.css 的 scrollbar-gutter 同一個結論),用計算樣式找,不鉤類名。
   */
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const scroller = [...nav.children].find(
      (c): c is HTMLElement =>
        c instanceof HTMLElement && getComputedStyle(c).overflowY === 'auto',
    );
    if (!scroller) return;
    // 拖曳的邊緣自動捲動要用同一層(見 scrollerRef)
    scrollerRef.current = scroller;

    let target = scroller.scrollTop;
    let pos = target;
    let raf: number | undefined;
    /** 上一幀的時間戳 —— 逼近的比例要照實際過了多久換算(見 step) */
    let lastTs: number | undefined;
    /** 觸控板正在滑(見 onWheel):這個時間點之前都交還原生 */
    let trackpadUntil = 0;
    /** 每 60Hz 一幀走掉剩餘距離的比例(換算成實際 dt 的事在 lib/frameEase.ts) */
    const SCROLL_EASE = 0.18;
    /**
     * 一步小於這個(px)就當成觸控板。Chrome/Windows 的滾輪一格是 100,頁面縮放 110%
     * 時是 90.9 —— 都還在線上;觸控板一步通常是個位數到二三十。
     * ⚠️ macOS 的滑鼠滾輪一格常常也小於 50(Chrome 會照速度縮放),整台 Mac 的滑鼠會被
     * 當成觸控板、走原生 —— 接受:原生在 Mac 上本來就是平滑的,這條果凍是為 Windows
     * 一格一格跳的滾輪做的。
     */
    const TRACKPAD_STEP_PX = 50;
    /** 看到觸控板的一步之後,接下來多久都交給原生(一次手勢裡的大小步不要在兩種模式間跳) */
    const TRACKPAD_HOLD_MS = 250;

    const stop = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      lastTs = undefined;
    };

    /*
     * 收合時「捲回最上面」由這裡提供 —— 理由見 `resetScroll` 的檔頭:
     * 從外面寫 `scrollTop` 會被下面 `step()` 的下一幀覆寫。
     *
     * 三件事要一起做:**停掉迴圈、把 `pos`/`target` 一起歸零、再寫 DOM**。
     * ⚠️ 少了中間那一步的話,`onScroll` 一對表確實會把 `target` 設回 0,
     * 但迴圈若還活著它根本不會進那條分支(它只在 `raf === undefined` 時對表)。
     */
    scrollToTopRef.current = () => {
      stop();
      pos = 0;
      target = 0;
      scroller.scrollTop = 0;
    };

    const step = (ts: number) => {
      const gap = target - pos;
      /*
       * **指數逼近,不是彈簧**:要順滑感,但不要抖動。
       *
       * ⚠️ 不要換成帶速度的彈簧(`velocity = velocity*k + gap*c` 那種):
       * 速度會累積動量 —— 那正是抖動的來源:收尾那一下衝過目標再被拉回來。
       * 在兩端夾 pos 只治到頂/到底那一下,**中段每次滾完一樣會過衝**,
       * 看到的就是「滾一下抖一下」。
       *
       * 每一格只走剩餘距離的固定比例,`pos` 單調逼近 `target`,
       * 數學上**不可能超過**它 —— 所以兩端也不必夾。順滑感來自
       * 「越接近越慢」,跟彈簧一樣;少掉的只有回彈。
       *
       * ⚠️ 「固定比例」是**每 60Hz 一幀**的比例,不是每一次 rAF(高更新率螢幕上才不會變快):
       * 換算成實際 dt 的事在 `lib/frameEase.ts`(拖曳幽靈用同一份)。
       */
      const dt = frameDelta(lastTs, ts);
      lastTs = ts;
      pos += gap * easeStep(SCROLL_EASE, dt);
      scroller.scrollTop = pos;
      if (Math.abs(gap) > 0.5) {
        raf = requestAnimationFrame(step);
      } else {
        scroller.scrollTop = target;
        pos = target;
        stop();
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // 捏合縮放
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      /*
       * ⚠️ 滾輪落在**開著的選單/浮層裡**就不關這裡的事。
       *
       * 右鍵選單畫在 top layer,但 DOM 還在這個捲動區裡 —— 事件會冒泡到這裡,
       * 而這個 handler 是 preventDefault + 自己推 scrollTop 的果凍捲動:
       * 使用者在圖示挑選器裡滾滾輪,**側邊欄跟著捲**就是這樣來的
       * (CSS 的 overscroll-behavior 管不到它:那是 CSS 的鏈,這是 JS)。
       * 交還瀏覽器之後,MenuHighlightLayer 的滾輪守門員會把「面板裡沒人
       * 接得住」的那一格吃掉,底下這一頁一格都不會動。
       */
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="listbox"]')) {
        return;
      }
      /*
       * 觸控板**不接手**。
       *
       * 觸控板的事件流自己已經帶慣性(一連串小步、越滑越小),再疊一層指數逼近
       * 等於多加約 100ms 的延遲,滑起來會黏。這條果凍捲動是為了**滾輪一格一格跳**
       * 才做的,觸控板沒有那個問題。
       *
       * 認法:**只看步長**。滾輪一格是大步(Chrome/Windows 一格 100;Firefox 走 deltaMode=1
       * 的行數,不在這條裡),觸控板是一連串小步。看到一步像觸控板就把接下來 250ms 都交給
       * 原生 —— 不然一次手勢裡的大步小步會在兩種模式之間跳。交還的時候要把自己的迴圈
       * 停掉並對表,不然它還在寫 scrollTop、跟原生打架。
       * ⚠️ **不要拿「帶不帶小數」當線索**:Chrome 在頁面縮放
       * ≠ 100% 時 deltaY 會除以縮放(110% → 90.9…),整台機器的滾輪都會被判成觸控板,
       * 果凍捲動就無聲地關掉了。
       */
      const now = performance.now();
      const looksLikeTrackpad = e.deltaMode === 0 && Math.abs(e.deltaY) < TRACKPAD_STEP_PX;
      if (looksLikeTrackpad) trackpadUntil = now + TRACKPAD_HOLD_MS;
      if (now < trackpadUntil) {
        stop();
        pos = target = scroller.scrollTop;
        return;
      }
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      target = Math.max(
        0,
        Math.min(scroller.scrollHeight - scroller.clientHeight, target + delta),
      );
      if (raf === undefined) raf = requestAnimationFrame(step);
    };

    const onScroll = () => {
      // 不是我們動的(拖捲軸、鍵盤、瀏覽器自己捲)→ 重新對表
      if (raf === undefined && Math.abs(scroller.scrollTop - pos) > 1) {
        pos = scroller.scrollTop;
        target = pos;
      }
    };

    scroller.addEventListener('wheel', onWheel, {passive: false});
    scroller.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      stop();
      scrollToTopRef.current = null;
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('scroll', onScroll);
    };
  }, []);

  /** 正在分享哪一組對話 */
  const [sharing, setSharing] = useState<ConversationSummary | null>(null);
  // 「Shared」那一區的收合狀態。不進 localStorage —— 資料夾的展開是使用者
  // 一個一個挑的,這個只有一格,每次打開都展開反而符合預期(有人找你就看得到)。
  const [isSharedCollapsed, setIsSharedCollapsed] = useState(false);
  /*
   * 名冊載完要重畫(共用名單的頭像從縮寫換成照片)。
   * ⚠️ 光靠這一行**做不到** —— 回傳值要接起來傳進 `ConversationRow`,
   * 理由見 `RowProps.peopleVersion`(正本在 `pages/Chat.tsx` 的 `TurnProps`)。
   */
  const peopleVersion = usePeopleDirectory();
  const [width, setWidth] = useState(readSidebarWidth);
  /**
   * 手機版(AppShell 把側邊欄收進抽屜)**不套自己存的寬度**。
   *
   * 下面那個 `style={{width}}` 若不分桌機手機一律套上,桌機把側邊欄拖到 420 之後,
   * 393 寬的手機上抽屜也變成 420,關閉鈕與整排箭頭都在螢幕外面。
   * 抽屜的寬度交給設計系統(它自己有手機版的尺寸),存的那個值只給桌機用。
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);
  /**
   * 右鍵選單開著的時候,高亮塊要**釘在哪一列**上。
   *
   * 不釘的話:選單一打開,指標就往選單移動,那一列的 mouseleave 一發生
   * 高亮塊就收掉了 —— 正好是最需要知道「我按的是哪一列」的那一刻。
   * 存的是**元素**不是座標:座標會過期(捲一下就不對了),元素不會。
   */
  const [pinnedRow, setPinnedRow] = useState<HTMLElement | null>(null);

  /*
   * 選單關掉之後才把 DOM 排回使用者的順序(見 `renderOrder` 的說明)。
   * `pinnedRow` 就是「現在有沒有一個選單開在某一列上」—— 右鍵與「⋯」
   * 兩個入口都會設它,所以這一條同時管到兩邊。
   */
  useEffect(() => {
    if (!pinnedRow) setRenderOrder(order);
  }, [pinnedRow, order]);

  const changeWidth = useCallback((next: number) => {
    setWidth(next);
    saveSidebarWidth(next);
  }, []);
  // 收合狀態自己管:收合鈕要放到標題列右邊(不是內建的底部那一顆),
  // 而外面的按鈕需要同一份受控設定。存在 localStorage 的 COLLAPSED_KEY。
  const [isCollapsed, setIsCollapsed] = useState(() => readFlag(COLLAPSED_KEY));

  /**
   * 收合到一半的那段(`isCollapsing`)—— 讓**文字被收窄的側邊欄一路夾掉**,
   * 而不是第一幀就整排消失。
   *
   * 展開那一頭本來就是這樣:狀態第一幀就翻,但側邊欄那時候只有 48px,
   * 標籤是**被長出來的寬度一路讓出來的**,所以看起來順。收合要對稱,
   * 就得讓標籤在寬度縮的過程中還在 —— 也就是 `SideNav` 的 `isCollapsed`
   * 必須**等寬度跑完才翻**。
   *
   * ⚠️ 這招成立的前提是**圖示的位置在兩種狀態裡一樣**(展開與 rail 兩邊
   * 圖示左緣都是 18),否則切換的那一下會跳。切換那一下沒有東西會動:
   *   - 標籤**不淡出**,就讓收窄的側邊欄一路夾掉(`SideNavItem` 的標籤自己有
   *     `flex:1 / min-width:0 / ellipsis`,動畫期間的配套寫在 global.css 的 `[data-animating]` 那幾條;
   *     `data-collapsing` 本身沒有任何樣式)。不要加 opacity 淡出:看起來像文字先被藏起來才縮。
   *   - 圖示從頭到尾實心待在原位。
   *   - rail 專用的那顆展開鈕、品牌膠囊的樣態,都吃 `railMode`(= 收合中也算),
   *     第一幀就到位 —— 不要改成吃 `isCollapsed`,那會把排版的跳動搬到動畫尾巴。
   *
   * ⚠️ 用 `setTimeout` 不用 `transitionend`:`prefers-reduced-motion` 時根本沒有
   * 過場,那個事件永遠不會來(而且分頁在背景時 rAF 也不跑,見下面的清理)。
   * 減少動態與手機抽屜兩種情況直接跳過這一段,當場切。
   */
  const [isCollapsing, setIsCollapsing] = useState(false);
  /**
   * 寬度正在跑 —— **收合與展開都算**。
   *
   * 展開那一頭一樣會經過 48px:狀態第一幀就翻成展開,整份 DOM 立刻長出來,
   * 而那時候 `<nav>` 還是 rail 的寬度 —— 會斷行的字(空資料夾那句「No chats yet.」、
   * 資料夾名字)就在那裡斷成三行,再隨著變寬收回去。看起來跟收合是同一個病,
   * 所以「收合中」這個記號不夠用,要的是「**寬度正在跑**」。
   */
  const [isAnimating, setIsAnimating] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 收合時那兩幀的 id(見 `onCollapsedChange`)—— 再按一次要取消得掉 */
  const collapseRaf = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(collapseTimer.current);
      if (collapseRaf.current !== undefined) cancelAnimationFrame(collapseRaf.current);
    },
    [],
  );
  /** 收合中也算 rail:我們自己那幾個「rail 才有」的東西第一幀就要到位 */
  const railMode = isCollapsed || isCollapsing;

  /**
   * rail 上那兩顆圖示(Shared / Personal)的浮層 —— **滑上去才把清單掛上去**。
   *
   * 設計系統對「收起來 + 有 children」的做法是換一棵樹:展開時清單是內嵌的,
   * rail 時整份被搬進一個 popover(查過 `SideNavItem.tsx` 的 `if (isCollapsed)`
   * 那一段)。**兩棵樹的位置不一樣,React 會把整份清單拆掉重掛** —— `memo` 完全
   * 幫不上忙,因為那些列是新掛載的,比較函式一次都不會被問到。
   *
   * 代價跟對話數成正比:對話一多,每按一次收合或展開,側邊欄大半的元素都被拆掉重建,
   * 收合動畫就會卡。
   *
   * 這裡治的是**其中一半**:rail 平常根本沒人在看那份浮層,先不要掛
   *(rail 的 DOM 與展開時要拆掉的元素都少掉一大半)。
   * 滑上去(或用鍵盤移過去)才掛,所以浮層的功能一個都沒少。
   *
   * ⚠️ **不能直接把 children 給 null。** `SideNavItem` 是用 `hasChildren` 決定要不要
   * 走 popover 那條路的,給 null 會連浮層都不存在,變成一顆只有 tooltip 的圖示。
   * 所以永遠給一個 `RailFlyoutGate`,由它決定裡面掛不掛真的清單。
   *
   * ⚠️ 閘門認的是 **`isCollapsed`,不是 `railMode`**(後者收合中也算)。認 `railMode`
   * 的話,清單會在**收合動畫的第一幀**就被拆掉 —— 收合要的是「文字被收窄的側邊欄
   * 一路夾掉」(見 `isCollapsing`),不是整份清單當場不見。認 `isCollapsed` 的話拆除排在動畫**結束後**,
   * 跟這支函式裡其他收尾動作同一批,一樣不擋動畫。
   */
  const [railFlyout, setRailFlyout] = useState<Record<ChatSectionKey, boolean>>({
    shared: false,
    personal: false,
  });
  const armRailFlyout = useCallback((key: ChatSectionKey) => {
    setRailFlyout((armed) => (armed[key] ? armed : {...armed, [key]: true}));
  }, []);
  /**
   * 「滑上去了」要怎麼知道 —— **`onPointerEnter`,不是 `onMouseEnter`**。
   *
   * `SideNavItem` 在 rail 的那條路上會把自己的 `hoverTriggerProps`(裡面就有
   * `onMouseEnter`)撒在 `{...rest}` **後面**,我們傳的同名回呼會被它整個蓋掉
   * (查過原始碼)。`onPointerEnter` 不在它那份裡,穩穩到得了 button 上。
   * 觸控沒有 pointerenter,所以再補一個 capture 階段的 `onPointerDownCapture`
   * (capture 跑在元件自己的 handler 之前,同樣蓋不掉);鍵盤走 `onFocusCapture`。
   *
   * ⚠️ 型別上 `SideNavItemProps` 沒有宣告這幾個,用展開的寫法繞過去 ——
   * 跟 `MobileNav` 的 `side` 同一個理由,是刻意的。
   */
  const railFlyoutTriggers = (key: ChatSectionKey) =>
    railMode
      ? {
          onPointerEnter: () => armRailFlyout(key),
          onPointerDownCapture: () => armRailFlyout(key),
          onFocusCapture: () => armRailFlyout(key),
          /*
           * 兜底:輔助科技可以**直接發 click**,不先給焦點也不先給指標。
           * 沒有這一條的話那條路會開出一個空浮層。
           */
          onClickCapture: () => armRailFlyout(key),
        }
      : {};

  /**
   * 收合**收尾**要做的事。兩條收合路徑(有過場 / 沒過場)共用同一份。
   *
   * ⚠️ **不要各寫一份。** 兩處各寫的話,哪天加一件事**會有一處被忘記**。
   *
   * 內容:
   *  - `railFlyout` —— 進 rail 了,浮層的清單先不要掛,等使用者真的滑上去(見 `railFlyout`);
   *  - 兩個 `renaming` —— 某一列正在改名時收合,那個輸入框會留在 48px 的 rail 裡
   *    撐出側邊欄外(input 左緣在 -32px);
   *  - `resetScroll()` —— 捲回最上面。**這是唯一一次動捲動位置的地方**,
   *    而且**看不到**:它跟內容整批被換掉落在同一幀。
   *    ⚠️ 不要改成「按下去就開始滑上去」,會震動 —— 理由寫在 `onCollapsedChange` 裡那段紅字。
   */
  const afterCollapse = useCallback(() => {
    setRailFlyout({shared: false, personal: false});
    setRenamingId(undefined);
    setRenamingFolderId(undefined);
    resetScroll();
  }, [resetScroll]);

  const collapsible = {
    isCollapsed,
    onCollapsedChange: (next: boolean) => {
      writeFlag(COLLAPSED_KEY, next);
      clearTimeout(collapseTimer.current);
      /*
       * ⚠️ **上一次的搶跑要先收乾淨**,不管這次是要收還是要展。
       * 那兩幀還沒跑到就再按一次的話,`isCollapsing` 一次都沒變成 true,
       * React 這次 commit 的 props 跟上次一樣 —— 它不會重寫,
       * 搶跑掛上去的那個屬性就會留著,側邊欄卡在收合的樣子。
       */
      if (collapseRaf.current !== undefined) cancelAnimationFrame(collapseRaf.current);
      collapseRaf.current = undefined;
      navRef.current?.removeAttribute(COLLAPSE_PENDING);
      // 收合的過場還要跑多久:去問那條 CSS 規則本人(global.css 的 `transition: width 340ms var(--ease-panel)`),
      // 不在 JS 抄數字 —— 抄大了寬度收完還要空等才切成 icon-only,抄小了字還在就被切掉。手機抽屜沒有 <nav>,回 0 當場切
      const ms = isMobile ? 0 : transitionMs(navRef.current);
      if (!next) {
        // 展開不必等:DOM 第一幀就長出來,寬度自己跑。只要在跑的那段掛上記號,
        // 讓 global.css 把會斷行的字夾住(理由見 isAnimating)。
        setIsCollapsing(false);
        setIsCollapsed(false);
        setIsAnimating(ms > 0);
        if (ms > 0) {
          collapseTimer.current = setTimeout(() => setIsAnimating(false), ms);
        }
        return;
      }
      /*
       * 🚨 **收合期間「不准」讓清單自己捲,也不准演任何進場。**
       * 捲動位置只在換成 rail 的那一刻歸零一次(`afterCollapse` 的 `resetScroll()`),
       * 那一幀內容整批被換掉,所以看不到。進場動畫的部分見檔案上方 `COLLAPSE_PENDING`
       * 底下那段紅字。
       *
       * 「按下去就開始往上滑」會震動:清單在最上面時 `scrollTop` 本來就是 0、那段滑動不存在;
       * 捲在最下面時要在 340ms 內滑完幾百 px,清單一邊被夾窄一邊急速往下跑。
       */
      /*
       * 有過場就先進「收合中」:寬度開始縮、標籤一路被夾掉,DOM 還是展開的樣子。
       * 沒有過場可等的話(減少動態、手機抽屜)跳過這一段,當場切。
       */
      if (ms > 0) {
        /*
         * ⚠️ **收合先自己畫下去,`setState` 等兩幀**,否則按下去會先停一下才動。
         *
         * 那個停頓是**這一次 React 重繪的時間**:按鈕的 click 是 discrete 事件,
         * React 會同步把整個側邊欄重算完才交還給瀏覽器(dev 下可達一兩百 ms),
         * 而寬度是 React 寫的,所以動畫也一起晚了那麼久。
         * 先掛一個屬性把 rail 寬度套上去,這一個 task 就很短,瀏覽器馬上畫得出
         * 第一幀 —— 過場當場開始跑。
         *
         * ⚠️ **掛的是 `data-collapse-pending`,不是直接寫 `style.width` 或
         * `data-collapsing`。** 那兩個都是 **React 自己管的**,而「手寫一個 React 也管的
         * 東西」會在它從頭到尾沒進過那個狀態時爛掉:使用者在這兩幀之內改變主意
         * (再按一次展開)的話,`isCollapsing` 一次都沒有變成 `true`,React 這次 commit 的
         * props 跟上次**完全一樣** —— 它不會重寫,手寫的 48px 與屬性就留在 `<nav>` 上,
         * 側邊欄卡在收合的樣子。
         * 這個屬性**只有我們管**,加與拿掉都在這支函式裡,React 碰都不碰。
         * 寬度由 `global.css` 的 `[data-collapse-pending]` 用 `!important` 壓過 React 的
         * inline width(那是唯一壓得過 inline 的辦法),屬性一拿掉就自動交還。
         *
         * ⚠️ 只有**收合**能這樣做。展開的時候 DOM 還是 rail 的樣子,得先讓 React
         * 把內容長出來才變寬 —— 先寫寬度只會看到一塊空的側邊欄。
         */
        navRef.current?.setAttribute(COLLAPSE_PENDING, '');
        /*
         * ⚠️ **兩層 `requestAnimationFrame`,不是一層。** rAF 的回呼跑在「這一幀
         * 真正畫出來**之前**」—— 只包一層的話 React 那次重繪仍然卡在第一次繪製前面,
         * 等於什麼都沒改。第二層才保證中間確實畫過一幀(寬度已經開始縮的那一幀)。
         *
         * ⚠️ 計時器也排在裡面:過場是從**這一刻**才開始跑的,在外面起算的話
         * 尾巴會被切掉那兩幀。
         */
        collapseRaf.current = requestAnimationFrame(() => {
          collapseRaf.current = requestAnimationFrame(() => {
            collapseRaf.current = undefined;
            setIsCollapsing(true);
            setIsAnimating(true);
            collapseTimer.current = setTimeout(() => {
              // 收完了:React 已經是 rail(`railMode`),那個搶跑的屬性交還回去
              navRef.current?.removeAttribute(COLLAPSE_PENDING);
              setIsCollapsing(false);
              setIsAnimating(false);
              setIsCollapsed(true);
              afterCollapse();
            }, ms);
          });
        });
        return;
      }
      /*
       * 沒有過場的那條路:當場切,`afterCollapse` 也一起做完。
       *
       * ⚠️ 有過場的那條路把它**排到動畫結束**才做(見上面的計時器)——
       * 那幾個 setState 會讓整棵側邊欄重畫(幾十列),跟「寬度開始跑」擠在同一幀
       * 就會掉幀。
       */
      setIsAnimating(false);
      setIsCollapsed(true);
      afterCollapse();
    },
    // 內建的收合鈕在左下角,關掉 —— 我們自己放到標題列右邊
    hasButton: false,
  };

  /**
   * rail 模式下的工具(New folder / 點資料夾)**先把側邊欄展開**再做事。
   * 那些動作會就地長出一個輸入框(改名),48px 的 rail 放不下,
   * 輸入框直接撐出側邊欄外面(input 左緣在 -32px)。展開再做,它就有地方站。
   *
   * ⚠️ **Search 不走這條**:它打開的是命令面板(modal),48px 的 rail 擋不到它 ——
   * 收著的時候點 Search 直接開面板,側邊欄維持原樣。
   */
  const expandRail = () => {
    if (railMode) collapsible.onCollapsedChange(false);
  };

  /**
   * `<nav>` 的寬度自己下不下:
   * - 手機交給抽屜(`MobileNav` 自己有尺寸),自己存的寬度**不能**套進去
   *   (見 `isMobile`)。
   * - 桌機**兩種狀態都自己下**:展開是使用者拖出來的寬度,收合是 rail 的寬度。
   *
   * 兩邊都自己下明確的寬度,是為了讓收合與展開**對稱**:一邊靠 inline、一邊靠元件的
   * class,兩條路的優先權不同,之後誰改了其中一邊都很難看出另一邊會怎樣。
   *
   * rail 的寬度跟著設計系統走(`SideNav` 的 collapsed 樣態用的就是 `--spacing-12`),
   * 不要寫死 48。
   */
  const navWidthStyle: React.CSSProperties | undefined = isMobile
    ? undefined
    : {width: railMode ? 'var(--spacing-12)' : width};

  const [, forceUpdate] = useState(0);

  const currentId = pathname.startsWith('/c/') ? pathname.slice(3) : undefined;

  useEffect(() => subscribeAll(() => forceUpdate((n) => n + 1)), []);

  /*
   * 個人設定那排「Default model」要用的清單先問好。
   *
   * ⚠️ **不是為了省一次請求,是為了讓那一列跟其他列同一幀出現。** 打開
   * 對話框才問的話,Text size / Contrast 先畫出來、Default model 晚一步補上去。
   * 側邊欄每一頁都在,在這裡問等於使用者按到自己的名字之前它就備好了。
   * 快取與失敗處理都在 `getAllowedModels()` 那邊,這裡只是叫它一聲。
   */
  useEffect(() => {
    prefetchAllowedModels();
  }, []);

  const refresh = useCallback(async () => {
    // 登出時 clearToken() 會先廣播、元件還沒卸載,照抓等於每次登出都留一條 401 紅字
    if (!getToken()) {
      setConversations([]);
      setFolders([]);
      setFolderItems({});
      return;
    }
    try {
      const [list, tree] = await Promise.all([listConversations(), listFolders()]);
      setConversations(list);
      setFolders(tree.folders);
      setFolderItems(tree.items);
      setIsListLoaded(true);
      setListFailed(false);
    } catch {
      setListFailed(true);
      // 抓不到就維持現狀,不要把畫面洗白
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUpdated = () => void refresh();
    // 換身分一定要整份重抓 —— 清單是按身分過濾的
    window.addEventListener(CONVERSATIONS_UPDATED, onUpdated);
    window.addEventListener(IDENTITY_CHANGED, onUpdated);
    return () => {
      window.removeEventListener(CONVERSATIONS_UPDATED, onUpdated);
      window.removeEventListener(IDENTITY_CHANGED, onUpdated);
    };
  }, [refresh, me.username]);

  useEffect(() => {
    writeJson(FOLDERS_OPEN_KEY, openFolders);
  }, [openFolders]);

  // ── 清單 ──────────────────────────────────────────────────────────────
  const active = getActiveStreams();
  const activeKey = active.map((p) => p.conversationId).join(',');
  const merged = useMemo(
    () =>
      withPendingConversations(
        conversations,
        active.map((p) => ({
          conversationId: p.conversationId,
          question: p.question,
          startedAt: p.startedAt,
        })),
      ),
    // active 每次都是新陣列,真正的相依是裡面的 id
    [conversations, activeKey],
  );

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  /**
   * 「這組對話歸在某個**畫得出來的**資料夾裡」。
   *
   * 判斷的依據是 `tree`(真的會被渲染的那些節點),不是 `folders` 那張平表 ——
   * 兩者不一樣的時候對話就會人間蒸發:
   *   - 資料夾被刪掉了,`folderItems` 還指著它(輪詢時序)
   *   - 資料夾在環裡、或父節點不存在 → `buildFolderTree` 會把它拉回頂層,
   *     所以它仍然畫得出來;真正畫不出來的只有「已經被刪掉」那種。
   *
   * 畫不出來就退回「未歸類」—— 寧可跑到 Personal,也不要不見。
   */
  const renderedFolderIds = useMemo(() => {
    const ids = new Set<number>();
    const walk = (nodes: FolderTree[]) => {
      for (const node of nodes) {
        ids.add(node.id);
        walk(node.children);
      }
    };
    walk(tree);
    return ids;
  }, [tree]);
  const isInLiveFolder = useCallback(
    (id: string) => {
      const folderId = folderItems[id];
      return folderId !== undefined && renderedFolderIds.has(folderId);
    },
    [folderItems, renderedFolderIds],
  );

  const {shared, personal} = useMemo(
    () => splitConversations(merged, isInLiveFolder),
    [merged, isInLiveFolder],
  );
  const byId = useMemo(
    () => new Map(merged.map((c) => [c.conversation_id, c])),
    [merged],
  );

  // ── 動作 ──────────────────────────────────────────────────────────────
  /**
   * 改名輸入框現在的字。**給那兩支 `commitRename` 讀的。**
   *
   * ⚠️ 直接讀 `draft` 的話它們的相依裡就有 `draft` —— 每打一個字就重建一次,
   * 而它們是傳給每一列的回呼:`ConversationRow` 包在 `memo` 裡(見那邊),
   * 只要有一個回呼每次都是新的,那道門就永遠判定「不一樣」,memo 等於白加。
   * 走 ref 之後它們可以是 `[]`,而讀到的仍然是最新的字。
   */
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const commitRename = useCallback(
    async (id: string, previous: string) => {
      const next = draftRef.current.trim();
      setRenamingId(undefined);
      if (!next || next === previous) return;
      setConversations((list) =>
        list.map((c) => (c.conversation_id === id ? {...c, title: next} : c)),
      );
      try {
        await renameConversation(id, next);
        notifyConversationsUpdated();
      } catch {
        // 還原標題,而且一定要講 —— 不講的話畫面會先變成新名字再自己彈回去,
        // 看起來像是自己手滑打錯
        setConversations((list) =>
          list.map((c) => (c.conversation_id === id ? {...c, title: previous} : c)),
        );
        toastError('Could not rename this chat.');
      }
    },
    [],
  );

  const commitFolderRename = useCallback(
    async (id: number, previous: string) => {
      // 同上:走 ref 才能是 `[]`(見 draftRef)
      const next = draftRef.current.trim();
      setRenamingFolderId(undefined);
      if (!next || next === previous) return;
      setFolders((list) => list.map((f) => (f.id === id ? {...f, name: next} : f)));
      try {
        await renameFolder(id, next);
      } catch {
        setFolders((list) => list.map((f) => (f.id === id ? {...f, name: previous} : f)));
        toastError('Could not rename this folder.');
      }
    },
    [],
  );

  const removeConversation = useCallback(
    async (c: ConversationSummary) => {
      try {
        await deleteConversation(c.conversation_id);
      } catch {
        // 對方剛取消共用時,那一列其實已經不屬於你了 —— 失敗也要重抓,
        // 但不能默默吞掉:他以為刪掉了,下一次重整又冒出來
        toastError(
          c.shared_with_me
            ? 'Could not leave this shared chat.'
            : 'Could not delete this chat.',
        );
      }
      setConversations((list) => list.filter((x) => x.conversation_id !== c.conversation_id));
      if (currentId === c.conversation_id) navigate('/');
      void refresh();
    },
    [currentId, navigate, refresh],
  );

  const moveToFolder = useCallback(
    async (id: string, folderId: number | null) => {
      setFolderItems((items) => {
        const next = {...items};
        if (folderId === null) delete next[id];
        else next[id] = folderId;
        return next;
      });
      if (folderId !== null) setOpenFolders((open) => (open.includes(folderId) ? open : [...open, folderId]));
      try {
        await setConversationFolder(id, folderId);
      } catch {
        // 畫面上它已經跳進資料夾了,重抓會把它彈回原位 —— 要說為什麼
        toastError('Could not move this chat.');
        void refresh();
      }
    },
    [refresh],
  );

  /**
   * 「在這個資料夾裡開一組新對話」:省掉開完新對話再手動搬進資料夾那一步。
   *
   * ⚠️ **這時候還沒有對話可以搬。** 新對話是使用者按下送出、後端寫完第一筆
   * 之後才存在的(問答頁那時才 `navigate('/c/<id>')`)—— 這裡能做的只有
   * 「先記著待會要放哪」,然後把畫面帶到新對話。
   *
   * 記的是資料夾 id **加上當下已知的對話清單**:等到網址真的變成某一組對話時,
   * 只有「不在那份清單裡」才是剛剛建出來的那一組。少了這道判斷,使用者按完
   * 右鍵卻改去點側邊欄上一組舊對話,那組舊的就會被莫名其妙搬進資料夾。
   */
  const pendingFolderRef = useRef<{
    folderId: number;
    knownIds: Set<string>;
    at: number;
  } | null>(null);

  const newChatIn = useCallback(
    (folderId: number) => {
      pendingFolderRef.current = {
        folderId,
        knownIds: new Set(conversations.map((c) => c.conversation_id)),
        at: Date.now(),
      };
      // 收合著的話待會東西會「出現在看不到的地方」,先展開
      setOpenFolders((open) => (open.includes(folderId) ? open : [...open, folderId]));
      navigate('/');
    },
    [conversations, navigate],
  );

  /*
   * 新對話送出之後,後端要**先寫完第一筆**,`PUT /conversations/{id}/folder` 才找得到它。
   * 問答頁是送出當下就 `navigate('/c/<id>')`,而後端帶附件時要等上傳存完才 commit
   * —— 只看網址就搬的話,PUT 幾乎一定先到,404、toast「Could not move」、彈回 Personal。
   * `start` 事件到了才有 `finalId`,而後端是 commit 之後才發它,
   * 所以等這個。Sidebar 本來就靠 `subscribeAll` 在串流有動靜時重繪,這個值會跟著更新。
   */
  const currentFinalId = getPending(currentId)?.finalId;

  useEffect(() => {
    const pending = pendingFolderRef.current;
    if (!pending) return;
    // 右鍵之後改去做別的事了 —— 過了這段時間、或人已經在別的頁面,就作廢,
    // 不然幾小時後隨便開一組新對話都會被搬進那個資料夾
    const onChatPages = pathname === '/' || pathname.startsWith('/c/');
    if (Date.now() - pending.at > NEW_CHAT_IN_FOLDER_MAX_MS || !onChatPages) {
      pendingFolderRef.current = null;
      return;
    }
    // 還停在 `/`(新對話還沒送出)就繼續等
    if (!currentId) return;
    // 他改去點別的舊對話了 —— 放棄,不要搬錯人
    if (pending.knownIds.has(currentId)) {
      pendingFolderRef.current = null;
      return;
    }
    // 新對話,但後端還沒寫完第一筆(見上面)—— 等 start 事件
    if (currentFinalId === undefined) return;
    pendingFolderRef.current = null;
    void moveToFolder(currentId, pending.folderId);
  }, [currentId, currentFinalId, pathname, moveToFolder]);

  const addFolder = useCallback(async () => {
    // 建立後直接進入改名 —— 「新資料夾」不是任何人要的名字
    try {
      const folder = await createFolder('New folder');
      setFolders((list) => [...list, folder]);
      setRenamingFolderId(folder.id);
      setDraft(folder.name);
    } catch {
      // 不要留一個假的節點在畫面上,但要講 —— 按了「新增資料夾」什麼都沒發生
      // 是最容易被當成「這個鈕壞了」的情況
      toastError('Could not create the folder.');
    }
  }, []);

  /** 把資料夾搬到別的資料夾底下(拖曳)。 */
  const moveFolder = useCallback(
    async (folderId: number, parentId: number | null) => {
      setFolders((list) =>
        list.map((f) => (f.id === folderId ? {...f, parent_id: parentId} : f)),
      );
      // 搬進去就順手展開目的地,不然會像「東西不見了」
      if (parentId !== null) {
        setOpenFolders((open) => (open.includes(parentId) ? open : [...open, parentId]));
      }
      try {
        await setFolderParent(folderId, parentId);
      } catch {
        toastError('Could not move this folder.');
        void refresh();
      }
    },
    [refresh],
  );

  const removeFolder = useCallback(
    async (id: number) => {
      setFolders((list) => list.filter((f) => f.id !== id));
      setFolderItems((items) =>
        Object.fromEntries(Object.entries(items).filter(([, v]) => v !== id)),
      );
      try {
        await deleteFolder(id);
      } catch {
        toastError('Could not delete this folder.');
        void refresh();
      }
    },
    [refresh],
  );

  const handleExport = useCallback(async (c: ConversationSummary) => {
    try {
      await exportConversation(c);
    } catch {
      // 匯出是使用者主動按的,失敗一定要講:瀏覽器不會有任何動靜,
      // 他只會覺得「按了沒反應」
      toastError('Could not export this chat.');
    }
  }, []);

  /*
   * 標記已讀**不在這裡** —— 那是問答頁的事,它要跟著
   * `notesNonce` / `focusNonce` 一起跑。掛在側邊欄的話只有「換一組對話」
   * 那一次會跑,停在同一組對話時新進來的提及永遠標不掉。見 `pages/Chat.tsx`。
   */

  /**
   * 長按對話列 → 拖到資料夾(或 Personal)上放開。
   * Personal 也是放置目標,拖回去就是移出資料夾 —— 選單裡沒有 Move to,
   * 沒有這個就沒有辦法把對話搬出資料夾。
   */
  const {drag, onPointerDown, onClickCapture, bindGhost, armTouchArea} = useLongPressDrag<DragPayload>({
    /*
     * 兩種放置目標,**取最內層的那一個**:
     *   `[data-drop-chat]`   → 同一層的另一組對話(換位置)
     *   `[data-drop-folder]` → 資料夾 / Personal(搬進去或搬出來)
     *
     * ⚠️ 用一次 `closest` 同時找兩種,不要先找資料夾再找對話 —— 對話列**長在**
     * 資料夾的外框裡面,分兩次找的話永遠是資料夾先中,對話換位置一次都成立不了。
     */
    resolveTarget: (el) => {
      const hit = el?.closest('[data-drop-chat], [data-drop-folder]');
      if (!hit) return undefined;
      const chat = hit.getAttribute('data-drop-chat');
      if (chat) return CHAT_TARGET_PREFIX + chat;
      return hit.getAttribute('data-drop-folder') ?? undefined;
    },
    /*
     * 拖到清單上下緣時讓它自己捲。
     * 捲的是側邊欄真正在捲的那一層 —— 用同一個 ref,不要再找一次
     *(找法與理由見上面滾輪那段 effect)。
     */
    resolveScroller: () => scrollerRef.current,
    /*
     * 拿起來的東西**就是那一列本身**(不縮小、不換樣式,圖示也要在)。
     * `.astryx-side-nav-item` 就是看得到的那一列
     *(設計系統公開的 class)—— 複製它,圖示、顏色記號、未讀數全部跟著走。
     */
    resolveVisual: (el) => el?.closest('.astryx-side-nav-item') ?? null,
    // 這兩個顏色是從外層的 Stack 繼承下來的(資料夾的線、對話的點),
    // 複本掛在側邊欄外面,要自己帶著走
    inheritedProps: DRAG_INHERITED_PROPS,
    /*
     * 放置目標的高亮**自己畫**,不走 state(見 `paintDropOver`)。
     * ⚠️ 包一層箭頭函式是必要的:`paintDropOver` 宣告在這行下面,
     * 直接寫名字會踩到 TDZ —— 包起來之後它是「拖曳時才執行」,那時早就定義好了。
     */
    onOverChange: (over, payload) => paintDropOver(over, payload),
    onDrop: (payload, target) => {
      if (!dropChanges(payload, target)) return;
      if (target.startsWith(CHAT_TARGET_PREFIX)) {
        if (payload.kind !== 'chat') return;
        const hit = parseChatTarget(target);
        if (hit.listKey !== payload.listKey) {
          // 跨層 = 搬進那一列所在的資料夾。
          // ⚠️ `undefined`(Shared,不是目的地)要**明確擋掉**,不能 `?? null` 折成
          // Personal —— 上面的 dropChanges 現在會先擋,但這一行不該靠別人。
          const parent = folderOfChatList(hit.listKey);
          if (parent === undefined) return;
          void moveToFolder(payload.id, parent);
          return;
        }
        // 同一層的兩組對話對調(跟右鍵的 ^ / v 同一個語意,見 swapWithin)
        const keys = listKeysRef.current[payload.listKey];
        if (!keys) return;
        const next = swapWithin(order, payload.listKey, keys, payload.id, hit.id);
        if (next === order) return;
        setOrder(next);
        writeSidebarOrder(next);
        bumpPinned();
        return;
      }
      const parent = target === 'none' ? null : Number(target);
      if (payload.kind === 'chat') void moveToFolder(payload.id, parent);
      else void moveFolder(payload.id, parent);
    },
  });

  /**
   * 手機抽屜裡**真正在捲的那一層**。
   *
   * 抽屜模式下設計系統的 `SideNav` 不把 `ref` 往下傳(`src/SideNav/SideNav.tsx` 的 drawer 分支),
   * 所以 `navRef` 永遠是 null,上面果凍捲動那支 effect 找不到捲動層 —— `scrollerRef` 一直是空的:
   *  - 長按拖曳擋不住觸控捲動(`useLongPressDrag` 的 touchmove 攔截沒地方掛),
   *    手指一移動瀏覽器就接手去捲、送出 `pointercancel`,**手機上根本拖不進資料夾**;
   *  - 拖到抽屜上下緣也不會自己捲。
   * 桌機那條路不受影響(有 `<nav>`,effect 找得到),jsdom 的測試是自己給捲動層,所以測不出這條。
   *
   * 手機版的 Sidebar 是設計系統 `AppShell` 用 `<Activity>` **一直掛著、關著時藏起來**的那一份:
   * 抽屜每次打開,ref 與 effect 才重新接上(關掉時拆掉)—— 所以不能在掛載時找一次就算了,
   * 要掛在「會捲的那一區」(下面那個 `HoverRegion`)的 ref 上:接上的當下往上找最近的捲動層,
   * 並請 hook **立刻**把攔截掛上去 —— 要在手指按下之前(理由見 `useLongPressDrag` 的 `blockTouchScroll`)。
   * 抽屜那個 `<dialog>` 也在這裡一起記下來,給拖曳幽靈當家(見 `ghostHost`)——
   * 不從捲動層反推:捲動層沒找到的話,幽靈至少還看得到。
   * ⚠️ 只在手機版做:桌機的捲動層歸果凍捲動那支 effect 管,兩邊都寫的話誰後寫誰算。
   */
  const drawerDialogRef = useRef<HTMLDialogElement | null>(null);
  const bindDrawerList = useCallback(
    (node: HTMLElement | null) => {
      if (!isMobile) return;
      scrollerRef.current = node ? scrollParent(node) : null;
      drawerDialogRef.current = node?.closest('dialog') ?? null;
      armTouchArea();
    },
    [isMobile, armTouchArea],
  );

  /**
   * 「放在這裡真的會有事發生嗎」。
   *
   * 拖到自己現在就待著的地方是沒有意義的:亮起來等於騙人說「放這裡會怎樣」,
   * 放開之後畫面卻沒有任何變化,而且還會白打一次 API。
   * 資料夾還要多擋一種:放進自己或自己的子孫會繞成環,樹就畫不出來了。
   */
  function dropChanges(payload: DragPayload, target: string): boolean {
    if (target.startsWith(CHAT_TARGET_PREFIX)) {
      // 資料夾拖到對話上沒有意義
      if (payload.kind !== 'chat') return false;
      const hit = parseChatTarget(target);
      // 同一層 → 換位置。拖回自己身上不算(亮起來卻什麼都不會發生)
      if (hit.listKey === payload.listKey) return hit.id !== payload.id;
      /*
       * 跨層 → 這其實是「搬進那一列所在的資料夾」(見 folderOfChatList):
       * 使用者拖到資料夾 B 裡面某一列上,他要的是搬進 B。
       */
      const parent = folderOfChatList(hit.listKey);
      if (parent === undefined) return false;
      const current = isInLiveFolder(payload.id) ? folderItems[payload.id] : null;
      return current !== parent;
    }
    const parent = target === 'none' ? null : Number(target);
    if (payload.kind === 'chat') {
      const current = isInLiveFolder(payload.id) ? folderItems[payload.id] : null;
      return current !== parent;
    }
    const folder = folders.find((f) => f.id === payload.id);
    if (!folder) return false;
    if (folder.parent_id === parent) return false;
    return !wouldCycle(folders, payload.id, parent);
  }

  /**
   * 指標停在 `over` 上的時候,**該亮的是哪一格**。
   *
   * ⚠️ **亮起來的必須是「真的會發生什麼事」的那一塊。** 對話列成為放置目標之後
   * 多了一種情形:指標停在**別層**的某一列上,而那件事其實是「搬進那一列所在的
   * 資料夾」(見 dropChanges)。這時候該亮的是資料夾外框,不是那一列 ——
   * 亮那一列等於告訴使用者「會跟這一列換位置」,而放開之後發生的是別的事。
   *
   * ⚠️ 回傳的是**選擇器**,不是布林值。不要改成「問每一格要不要亮」、
   * 由 render 一格一格去問 —— 那條路每換一個目標就是一次整棵側邊欄重繪
   *(見 `paintDropOver`)。這裡反過來算「該亮誰」,然後直接把屬性掛上去。
   */
  const dropOverSelector = (over: string, payload: DragPayload): string | null => {
    const chatHit = over.startsWith(CHAT_TARGET_PREFIX) ? parseChatTarget(over) : null;
    const crossLayer = !!chatHit && payload.kind === 'chat' && chatHit.listKey !== payload.listKey;
    // 指標就停在這一格上:同層換位置與資料夾本身都走這條
    if (!crossLayer) {
      if (!dropChanges(payload, over)) return null;
      return chatHit
        ? `[data-drop-chat="${CSS.escape(over.slice(CHAT_TARGET_PREFIX.length))}"]`
        : `[data-drop-folder="${CSS.escape(over)}"]`;
    }
    // 跨層的那一列 → 亮它所屬的資料夾(Personal 是 'none')
    const parent = folderOfChatList(chatHit.listKey);
    if (parent === undefined || !dropChanges(payload, over)) return null;
    return `[data-drop-folder="${CSS.escape(parent === null ? 'none' : String(parent))}"]`;
  };

  /**
   * 把放置目標的高亮**直接畫在 DOM 上**,不走 React(效能)。
   *
   * 拖過清單時每經過一列 `over` 就換一次,若那個 state 住在這個元件上 ——
   * 一次就是整棵樹重繪,拖曳會嚴重掉幀。高亮只是「哪一格上色」,
   * 那是一個屬性的事。樣式在 `global.css` 的 `[data-drop-over]`。
   *
   * ⚠️ 每次都先把舊的清乾淨(`querySelectorAll`),不要只清「上一個」——
   * 資料夾收合、清單重排都可能讓上一個元素已經不在了。
   */
  const paintDropOver = useCallback(
    (over: string | undefined, payload: DragPayload) => {
      for (const el of document.querySelectorAll('[data-drop-over]')) {
        el.removeAttribute('data-drop-over');
      }
      if (over === undefined) return;
      const selector = dropOverSelector(over, payload);
      if (selector) document.querySelector(selector)?.setAttribute('data-drop-over', '');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folderItems, folders],
  );

  /**
   * 手機抽屜裡拖的時候,幽靈要**畫進抽屜那個 `<dialog>` 裡**。
   *
   * 抽屜是設計系統 `MobileNav` 用 `showModal()` 開的,在瀏覽器的 top layer —— 外面的東西
   * z-index 再高都在它底下。幽靈平常掛在側邊欄旁邊(`z-index: 60`),在抽屜裡拖的時候
   * 整顆被抽屜蓋住:原位變成半透明、資料夾也亮了,手指底下卻什麼都沒有。
   * 用 portal 掛進同一個 `<dialog>`,它就跟抽屜在同一層、而且排在後面(畫在上面)。
   * 定位原點從那個 `<dialog>` 自己開始找、而且只找到它為止(`fixedOrigin` 遇到 top layer 就停):
   * 抽屜面板有 `translateX`,但幽靈不在面板裡,所以只要 `<dialog>` 本身沒有 transform,原點就是視窗。
   * 拖曳中才讀 ref(`drag` 是 state,開始 / 結束 / 換目標都會重繪),跟 `ghostOrigin` 同一個時機。
   */
  const ghostHost = drag && isMobile ? drawerDialogRef.current : null;
  /** 拖曳幽靈每一格都在動,原點跟高亮塊同一個(桌機的幽靈是 `<nav>` 的兄弟,從它們共同的父層找) */
  const ghostOrigin = drag
    ? fixedOrigin(ghostHost ?? navRef.current?.parentElement ?? null)
    : {x: 0, y: 0};
  const inGhostHost = (ghost: React.ReactNode) =>
    ghostHost ? createPortal(ghost, ghostHost) : ghost;

  /**
   * 三張表都是同一件事:改一格 → 更新畫面 → 寫回本機。
   *
   * key 一律是 string —— 資料夾用它的 id,Personal / Shared 用
   * `personal` / `shared`(資料夾 id 轉成字串都是數字,撞不到);
   * 對話用 conversation_id。
   */
  /**
   * 把資料夾與 Personal / Shared 接上「往上/往下」(見 sidebar-order.ts)。
   * 對話列沒有箭頭(靠拖曳換位置),只有這兩種用它。
   *
   * `keys` 是**畫面上現在**那一層由上到下的 key —— 邊界(第一個 / 最後一個)
   * 就是從它算出來的,所以只有一個成員的清單兩顆都不會出現。
   */
  const reorderIn = useCallback(
    (listKey: string, keys: string[]) =>
      (key: string): Reorder => {
        const at = keys.indexOf(key);
        return {
          canUp: at > 0,
          canDown: at >= 0 && at < keys.length - 1,
          move: (delta: number) => {
            const next = moveWithin(order, listKey, keys, key, delta);
            // 參照沒變 = 移不動(已經在頭或尾),什麼都不要做
            if (next === order) return;
            setOrder(next);
            writeSidebarOrder(next);
            bumpPinned();
          },
        };
      },
    [order],
  );

  /**
   * 一層清單的兩種順序。`rows` 是**要畫進 DOM 的順序**(可能是舊的,
   * 因為選單開著時不動 DOM),`cssOrder` 是**看到的位置**。
   * `reorder` 的頭尾判斷一律看**看到的**那份 —— 使用者是照畫面在按的。
   */
  const layer = useCallback(
    <T,>(listKey: string, items: T[], keyOf: (item: T) => string) => {
      const keys = applyOrder(order, listKey, items, keyOf).map(keyOf);
      // 放下時要用(見 listKeysRef)
      listKeysRef.current[listKey] = keys;
      const at = reorderIn(listKey, keys);
      return {
        rows: applyOrder(renderOrder, listKey, items, keyOf),
        cssOrder: (key: string) => keys.indexOf(key),
        reorder: at,
      };
    },
    [order, renderOrder, reorderIn],
  );

  const setSidebarIcon = assignKey(icons, setIcons, writeFolderIcons);
  const setSidebarColor = assignKey(colors, setColors, writeFolderColors);
  /** 對話列的顏色標記(設計系統的 side nav 就是那顆點) */
  /* 見 `rowHandlers` 的 `pickColor`:那組回呼要穩定,而這一支每次 render 都是新的 */
  const setConversationColorRef = useRef<(id: string | number, key: string) => void>(() => {});
  const setConversationColor = assignKey(
    conversationColors,
    setConversationColors,
    writeConversationColors,
  );
  setConversationColorRef.current = setConversationColor;

  /** Personal / Shared / 每個資料夾都是同一種節點,只是內容與圖示不同 */
  const unreadTotal = shared.reduce((n, c) => n + c.unread_mentions, 0);

  /** 在某個資料夾底下再開一個。開完直接進入改名 —— 「New folder」不是任何人要的名字。 */
  const addSubFolder = useCallback(
    async (parentId: number) => {
      try {
        const folder = await createFolder('New folder', parentId);
        setFolders((list) => [...list, folder]);
        // 建在收合的節點底下時要先展開,不然看起來像什麼都沒發生
        setOpenFolders((open) => (open.includes(parentId) ? open : [...open, parentId]));
        setRenamingFolderId(folder.id);
        setDraft(folder.name);
      } catch {
        toastError('Could not create the folder.');
      }
    },
    [folders],
  );

  /*
   * 使用者排過的順序(見 sidebar-order.ts)。每一層各算一次 ——
   * 「同一層的兄弟之間換位置」就是這個功能的全部,跨層是拖曳的事。
   */
  const folderLayer = layer('folders', tree, (f) => String(f.id));
  const sharedLayer = layer(SHARED_CHATS_KEY, shared, (c) => c.conversation_id);
  const personalLayer = layer(PERSONAL_CHATS_KEY, personal, (c) => c.conversation_id);
  /**
   * Shared 與 Personal 這兩個節點自己也能換上下。
   * Shared 沒有東西的時候整個節點不畫,那一層就只剩一個成員 —— 兩顆箭頭都不會出現。
   */
  const sectionLayer = layer(
    'sections',
    shared.length > 0 ? ['shared', 'personal'] : ['personal'],
    (k) => k,
  );

  /*
   * 外面那層 `Stack` 是給 CSS `order` 用的 flex item —— `ConversationRow`
   * 的根是 `ContextMenu`(共用的還多包一層 `HoverCard`),那兩個都沒有開放
   * inline style。多這一層不影響量測:高亮與拖曳認的是裡面的
   * `.astryx-side-nav-item` 與 `[data-lift]`。
   */
  /**
   * 每一列共用的那一組回呼。**整組都必須是穩定的。**
   *
   * `ConversationRow` 包在 `memo` 裡(見那邊的說明),而 memo 比的是 props ——
   * 不要在每一列當場新做箭頭函式(`onShare={() => setSharing(c)}` 那種):
   * 對 React 來說每一次都是「新的函式」,於是那道門永遠判定「不一樣」,
   * 每一列每次都要整個重算一遍。
   *
   * 所以用「**通用的回呼 + 呼叫時把那一列帶進去**」:函式不綁定某一列,
   * 就可以整個 session 只建一次。
   * ⚠️ 相依裡不能出現「每打一個字就變」的東西(`draft`)—— 那兩支 rename
   * 因此讀 `draftRef`(見上面)。
   */
  const rowHandlers = useMemo<RowHandlers>(
    () => ({
      setDraft,
      startRename: (c) => {
        setRenamingId(c.conversation_id);
        setDraft(c.title);
      },
      commitRename: (c) => void commitRename(c.conversation_id, c.title),
      cancelRename: () => setRenamingId(undefined),
      remove: removeConversation,
      share: (c) => setSharing(c),
      exportMd: (c) => void handleExport(c),
      moveOut: (c) => void moveToFolder(c.conversation_id, null),
      // ⚠️ 包一層讀 ref:`setConversationColor` 是 `assignKey` 每次 render 現做的
      // (它閉包著當下那張顏色表),直接放進來會凍在第一次那一份上。
      pickColor: (id, key) => setConversationColorRef.current(id, key),
      pin: setPinnedRow,
      pointerDown: onPointerDown,
      clickCapture: onClickCapture,
    }),
    [
      commitRename,
      handleExport,
      moveToFolder,
      onClickCapture,
      onPointerDown,
      removeConversation,
    ],
  );

  const renderRow = (
    c: ConversationSummary,
    orderIndex?: number,
    listKey?: string,
  ) => (
    <Stack
      key={c.conversation_id}
      style={{order: orderIndex}}
      /*
       * 這一列也是**放置目標**:同一層的另一組對話拖到它身上就換位置
       * (見 swapWithin)。掛在外面這層而不是
       * `ConversationRow` 裡面 —— 裡面的根是 `ContextMenu`,沒有開放
       * data-* 與 xstyle,而外框本來就是為了 CSS order 才存在的。
       *
       * `listKey` 是可選的:不屬於側邊欄某一層的列沒有順序可以換,也不該是放置目標。
       * 沒有 listKey 就不掛屬性,不掛就是不能放。
       */
      {...(listKey
        ? {'data-drop-chat': chatTarget(listKey, c.conversation_id).slice(CHAT_TARGET_PREFIX.length)}
        : {})}
      /* 亮起來那一下不在這裡:拖曳中由 `paintDropOver` 直接掛 `data-drop-over`,
         樣式在 global.css。走 React 的話拖過每一列都是一次整棵樹重繪。 */
      xstyle={styles.dropTarget}
    >
    <ConversationRow
      conversation={c}
      // 只為了讓名冊更新時 memo 失效,見 RowProps.peopleVersion
      peopleVersion={peopleVersion}
      // 歸類/移出平常靠長按拖曳,但拖曳用鍵盤做不到 ——
      // 在資料夾裡的對話一定要在選單裡也有一條路出來(「移出資料夾」)
      canMoveOut={isInLiveFolder(c.conversation_id)}
      isCurrent={c.conversation_id === currentId}
      isRenaming={renamingId === c.conversation_id}
      /* ⚠️ **只有正在改名的那一列拿得到 `draft`。** 給每一列的話,打字時
         每一個按鍵都會讓二十幾列的 props 變動一次 —— memo 就白加了。 */
      draft={renamingId === c.conversation_id ? draft : ''}
      listKey={listKey}
      isDragging={drag?.payload.kind === 'chat' && drag.payload.id === c.conversation_id}
      color={conversationColors[c.conversation_id]}
      pickerNonce={pickerNonce}
      handlers={rowHandlers}
    />
    </Stack>
  );

  /** 畫一個資料夾要知道的所有事。遞迴的 FolderNode 靠它。 */
  const folderCtx: FolderNodeContext = {
    folderItems,
    byId,
    icons,
    colors,
    openFolders,
    isRailCollapsed: isCollapsed,
    openInRail: (id) => {
      expandRail();
      setOpenFolders((open) => (open.includes(id) ? open : [...open, id]));
    },
    toggleOpen: (id, collapsed) =>
      setOpenFolders((open) => (collapsed ? open.filter((x) => x !== id) : [...open, id])),
    renamingFolderId,
    draft,
    setDraft,
    startRename: (folder) => {
      setRenamingFolderId(folder.id);
      setDraft(folder.name);
    },
    commitRename: (id, previous) => void commitFolderRename(id, previous),
    cancelRename: () => setRenamingFolderId(undefined),
    setIcon: setSidebarIcon,
    setColor: setSidebarColor,
    addSubFolder: (parentId) => void addSubFolder(parentId),
    newChatIn,
    removeFolder: (id) => void removeFolder(id),
    pickerNonce,
    onMenuClosed: () => setPickerNonce((n) => n + 1),
    renderRow,
    layer,
    onPin: setPinnedRow,
    dragProps: (folder) => ({
      onPointerDown: onPointerDown({kind: 'folder', id: folder.id, title: folder.name}),
      onClickCapture,
      isDragging: drag?.payload.kind === 'folder' && drag.payload.id === folder.id,
    }),
  };

  /**
   * Shared 與 Personal 這兩個節點。抽出來是因為它們的**上下順序是使用者排的**
   * (`sectionKeys`)—— 寫死在 JSX 裡就換不了位置。
   */
  const chatSections: Record<string, React.ReactNode> = {
    shared: (
      // ⚠️ Shared **不是**放置目標。「共用」不是一個資料夾,是一份成員名單 ——
      // 要共用得在分享對話框裡挑人。跟 Personal 一樣掛 data-drop-folder="none"
      // 的話,拖到 Shared 上面時兩塊會一起亮,而放開之後只是把對話移出資料夾
      //(根本不是使用者以為的那件事)。
      <AppearanceMenu
        name="Shared"
        storageKey={SHARED_KEY}
        icons={icons}
        colors={colors}
        nonce={pickerNonce}
        reorder={sectionLayer.reorder('shared')}
        orderIndex={sectionLayer.cssOrder('shared')}
        onMenuClosed={() => setPickerNonce((n) => n + 1)}
        onPin={setPinnedRow}
        onPickIcon={setSidebarIcon}
        onPickColor={setSidebarColor}
      >
        <SideNavItem
          label="Shared"
          icon={<FolderIcon iconKey={icons[SHARED_KEY]} fallback={Building2} />}
          {...railFlyoutTriggers('shared')}
          // 收合狀態要受控,才知道現在該不該把未讀加總掛出來
          collapsible={{
            isCollapsed: isSharedCollapsed,
            onCollapsedChange: setIsSharedCollapsed,
          }}
          endContent={
            // 跟資料夾同一條規則:收合才顯示總數,展開就交給每一列自己標
            isSharedCollapsed && unreadTotal > 0 ? (
              <UnreadBadge count={unreadTotal} />
            ) : undefined
          }
        >
          <RailFlyoutGate isOpen={!isCollapsed || railFlyout.shared}>
          <VStack
            gap={0.5}
            xstyle={sideNavStyles.nestGuide}
            /* 漂浮框的樣態由 global.css 認這個記號(見那邊的說明) */
            {...(isCollapsed ? {[RAIL_FLYOUT]: ''} : {})}
            // 對話列的右鍵不要冒泡上來變成 Shared 的選單(見 FolderNode 的同一段)
            onContextMenu={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {sharedLayer.rows.map((c) =>
              renderRow(
                c,
                sharedLayer.cssOrder(c.conversation_id),
                SHARED_CHATS_KEY,
              ),
            )}
          </VStack>
          </RailFlyoutGate>
        </SideNavItem>
      </AppearanceMenu>
    ),
    personal: (
      /* Personal 是「未歸類」那一堆,所以它是把對話拖出資料夾的落點 */
      <Stack
        data-drop-folder="none"
        xstyle={styles.dropTarget}
        style={{order: sectionLayer.cssOrder('personal')}}
      >
        <AppearanceMenu
          name="Personal"
          storageKey={PERSONAL_KEY}
          icons={icons}
          colors={colors}
          nonce={pickerNonce}
            reorder={sectionLayer.reorder('personal')}
          onMenuClosed={() => setPickerNonce((n) => n + 1)}
          onPin={setPinnedRow}
          onPickIcon={setSidebarIcon}
          onPickColor={setSidebarColor}
        >
          <SideNavItem
            label="Personal"
            icon={<FolderIcon iconKey={icons[PERSONAL_KEY]} fallback={User} />}
            {...railFlyoutTriggers('personal')}
            collapsible={{defaultIsCollapsed: false}}
            endContent={undefined}
          >
            <RailFlyoutGate isOpen={!isCollapsed || railFlyout.personal}>
            <VStack
              gap={0.5}
              xstyle={sideNavStyles.nestGuide}
              {...(isCollapsed ? {[RAIL_FLYOUT]: ''} : {})}
              onContextMenu={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {personalLayer.rows.length > 0 ? (
                personalLayer.rows.map((c) =>
                  renderRow(
                    c,
                    personalLayer.cssOrder(c.conversation_id),
                    PERSONAL_CHATS_KEY,
                  ),
                )
              ) : isListLoaded ? (
                <Text type="supporting">No chats yet.</Text>
              ) : listFailed ? (
                <Text type="supporting" color="secondary">Could not load chats.</Text>
              ) : null}
            </VStack>
            </RailFlyoutGate>
          </SideNavItem>
        </AppearanceMenu>
      </Stack>
    ),
  };

  return (
    <>
      {sharing ? (
        <ShareDialog
          conversationId={sharing.conversation_id}
          conversationTitle={sharing.title}
          alreadyShared={sharing.share_members}
          isOpen
          onOpenChange={(open) => {
            if (!open) setSharing(null);
          }}
          onShared={() => {
            notifyConversationsUpdated();
            void refresh();
          }}
        />
      ) : null}

      {/*
        拖曳中跟著指標走的那一塊 = **那一列的複本**(見 useLongPressDrag 的
        `resolveVisual`)。⚠️ 不要改它的樣子:不放大、不縮小、不傾斜、不換色 ——
        拿起來的要還是同一個東西,自己畫一顆 Token 的話
        資料夾的圖示與顏色記號都會不見。框與底色下在**外面這一層**。
        複本是原生節點,用 ref 掛進去(不是 React 畫的,所以要自己認一次)。
        沒放到目標就放開(或被取消)時,`drag` 會多留 `GHOST_RETURN_MS` —— 這顆幽靈飛回原本那一列
        才卸載(飛行用的 inline style 由 hook 寫、也由 hook 收,見 `returnGhost`)。
      */}
      {drag ? inGhostHost(
        <Stack
          aria-hidden
          xstyle={sideNavStyles.dragGhost}
          width={drag.width || undefined}
          data-drag-ghost=""
          ref={(node: HTMLElement | null) => {
            /*
             * 位置**不走 React 的 inline style**(走 state 會「移動很卡」):
             * bindGhost 之後座標由 hook 的 rAF 迴圈直接寫在這顆元素上,
             * 拖曳中整棵側邊欄不必每一格重繪。grabX/grabY 與 fixed 定位基準的
             * 扣法在 hook 裡(applyGhost)。
             */
            bindGhost(node, ghostOrigin);
            if (!node || !drag.visual) return;
            if (node.firstChild === drag.visual) return;
            /*
             * `data-pinned` 就是「這一列現在看起來像被滑到」的那個開關
             *(global.css:字變粗、圖示變深)。複本不會有 `:hover`,
             * 所以借它 —— 以後 hover 的樣子改了,拿起來的樣子自己跟著改。
             * 位移那 2px 在這裡要取消掉,見 global.css 的 `[data-drag-ghost]`。
             */
            drag.visual.setAttribute('data-pinned', '');
            node.replaceChildren(drag.visual);
          }}
        >
          {/* 複本掛不上去(理論上不會發生)時的備援,至少看得出在搬哪一個 */}
          {drag.visual ? null : <Token label={drag.payload.title} />}
        </Stack>
      ) : null}

      <SidebarResizer
        navRef={navRef}
        width={width}
        isCollapsed={isCollapsed}
        onWidthChange={changeWidth}
        onCollapsedChange={collapsible.onCollapsedChange}
      />
    <SideNav
      ref={navRef}
      aria-label="Conversations"
      // 收起來的 rail 不要留捲軸的預留位(global.css 靠這個屬性判斷)
      data-collapsed={isCollapsed ? 'true' : undefined}
      // 收合到一半:寬度在縮,但還是展開的 DOM(見 collapsible 的說明)
      data-collapsing={isCollapsing ? 'true' : undefined}
      // 寬度正在跑(收合與展開都算)—— global.css 靠這個把會斷行的字夾住
      data-animating={isAnimating ? 'true' : undefined}
      collapsible={collapsible}
      // 寬度自己控:SideNav 內建的 resizable 命中區定位是錯的,而且收合時
      // 會把 0 存進去(見 SidebarResizer 開頭的說明)。收合時寬度交還給它自己。
      style={navWidthStyle}
      /*
       * 手機抽屜**固定從左邊滑出來**。設計系統 `MobileNav` 的 `side` 預設是 `auto`:開的當下
       * 看 `document.activeElement` 在螢幕左半還是右半 —— 漢堡鈕在右上角,
       * 所以多半從右邊出來;但焦點落在別處時就變左邊,方向會跟著上一個動作跳。
       * 側邊欄在桌機就在左邊,抽屜也該從左邊來,釘死。
       *
       * ⚠️ 只在手機版傳:`SideNav` 在抽屜模式會把多出來的 props 原封不動
       * 轉給 `MobileNav`(`{...props}`,查過 src/SideNav/SideNav.tsx),但桌機
       * 模式會把它們撒在 <nav> 上,`side` 會變成一個 React 不認得的 DOM 屬性警告。
       * `SideNavProps` 沒有宣告 `side`,所以用展開的寫法繞過型別檢查 ——
       * 這是刻意的,不要改成 `side="start"`(編不過)。
       */
      {...(isMobile ? {side: 'start' as const} : {})}
      header={
        isMobile ? (
          /*
           * 抽屜標頭:`[X] [logo + AskME 置中]`。
           * X 是跟頂列同一顆 `MenuToggle`(兩條槓轉成 X),內建的關閉鈕由
           * global.css 藏掉(理由寫在那條規則上)。收合鈕在抽屜裡沒有意義,不放。
           */
          <MobileBrandBar isDrawer />
        ) : (
          /*
           * 長按 logo 那一塊會有彩蛋(BrandHold);logo 本身是一般的樣子,不包黑圈。
           *
           * ⚠️ 收合成 rail 時要換樣態,不然長按的動畫會走樣。膠囊平常會在右邊讓出收合鈕的位置
           * (--spacing-6 + --spacing-4 = 40px),而 rail 只有 48px 寬 ——
           * 讓完之後剩下 8px,那條彩虹進度就擠在一條細縫裡跑,彩帶也從那條縫噴出來。
           * rail 裡標題列右邊本來就沒有收合鈕(它被移到底下那排),所以包到底才對。
           */
          <BrandHold variant={railMode ? 'rail' : 'nav'}>
            <SideNavHeading
              heading={BRAND_NAME}
              icon={
                <Stack xstyle={styles.brandIcon}>
                  <Logo size={BRAND_LOGO_SIZE} />
                </Stack>
              }
              headingHref="/"
              /*
               * ⚠️ 收合鈕**在標題那條連結裡面**(`headingHref="/"`),所以它的 click 會冒泡上去
               * 變成「點了品牌字」—— 不擋的話,在任何頁面(例如 /ssh)按收合,網址就變成 /。
               * 這一層把那一下吞掉(先 preventDefault 擋掉連結的預設導覽,再 stopPropagation
               * 讓它到不了 <a>)。⚠️ **兩個都要**:只 stopPropagation 擋不住瀏覽器的預設行為。
               * 收合本身在更內層的 button 上,這時候已經執行完了。
               */
              headerEndContent={
                <Stack
                  onClick={(e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <SideNavCollapseButton collapsible={collapsible} />
                </Stack>
              }
            />
          </BrandHold>
        )
      }
      /*
       * New chat / New folder / Search **釘在上面** ——
       * `topContent` 是設計系統的那個插槽,它跟 header 一起 sticky,
       * 只有 `children` 會捲。這一區是「工具」,跟底下的帳號區對稱:
       * 兩頭固定,中間那份會長的清單才捲。
       *
       * ⚠️ 自己一塊高亮:sticky 的區塊是獨立的 z 序(而且有不透明底),
       * 會捲那一區的高亮畫不進來 —— 帳號區就是為了這個才各自一塊
       *(見 sideNavParts 的 styles.hoverRegion)。
       */
      topContent={
        <HoverRegion isSuppressed={!!drag}>
          <SideNavSection title="Menu" isHeaderHidden>
            {/* ⚠️ rail 的展開鈕**不在這裡**,在最底下(見 footer 的說明)。
              放在這裡的話,收合的第一幀整排圖示會被它擠下去 34px。 */}
            {/* 走連結(href)不是 onClick:經過 LinkProvider,中鍵 / 開新分頁才有用 */}
            <SideNavItem label="New chat" icon={Plus} href="/" />
            <SideNavItem
              label="New folder"
              icon={FolderPlus}
              onClick={() => {
                expandRail();
                void addFolder();
              }}
            />
            {/*
              點下去**開面板**(⌘K 那一個),不就地長出輸入框。
              ⚠️ **不要 `expandRail()`**:面板是 modal,48px 的 rail 擋不到它 ——
              收著的時候點 Search 直接開面板,側邊欄維持原樣。
            */}
            <SideNavItem label="Search" icon={Search} onClick={onOpenSearch} />
          </SideNavSection>
          {/* 釘住的那一區跟底下會捲的清單之間要有一條 ——
              跟帳號區上面那條對稱,不然固定區與內容會黏成一片 */}
          <Divider />
        </HoverRegion>
      }
      footer={
        // 管理員的功能放在這裡而不是清單裡:它們是「工具」不是「內容」,
        // 而且對話多的時候會被推到很下面。順序刻意是 管理 → 身分 → 登出,
        // 登出永遠在最後一個。
        // ⚠️ 帳號區自己一塊高亮:它住在 SideNav 貼齊底部那條 sticky 裡,
        // 而 sticky 是 positioned + 不透明底色 —— 外面的高亮會被它整條蓋掉
        //(Dark mode / Sign out 那幾列因此完全看不到,見 sideNavParts 的 styles.hoverRegion)
        <HoverRegion>
        {/* 選取底色:換頁時從舊的那一列滑到新的那一列(見 SelectionPill)。第一個子元素 = 畫在每一列底下 */}
        <SelectionPill pathname={pathname} />
        {/*
          rail 的展開鈕(收合時標題列右邊那顆會被藏起來,不留一顆看得見的,
          就只剩一條透明的邊緣感應帶,不知道的人會以為側邊欄不見了)。
          ⚠️ **在這裡,不在清單頂端**(否則收合的第一幀整排圖示會往下跳)。
          原因是列數:展開時收合鈕住在標題那一列裡,rail 放不下所以要自己佔一列 ——
          多出來的那一列不管放哪裡都會把同一塊裡的東西推開 34px。放在最底下,
          被推的是貼底的帳號區(它本來就從下往上長,而且沒有人盯著它),
          **會捲的那份清單與工具列一個 px 都不會動** —— 那才是使用者在看的地方。
          ⚠️ 另外兩條路都更差:塞進標題那一列的話 48px 放不下 logo + 箭頭兩個 16px 的圖示;
          在展開時也留一列空位的話,展開的樣子會多一塊純空白。
          ⚠️ 這一顆**固定當自己是「收合狀態」的鈕**(`isCollapsed: true`),不能直接吃
          `collapsible` —— 收合到一半的那 340ms 裡 `isCollapsed` 還是 false,那會讓它
          畫成「收合」的箭頭(指左邊),而且按下去是再收一次。查過
          `useSideNavCollapseState`:箭頭方向與 `toggle()` 要切去的值都只看傳進來的
          `isCollapsed`,釘成 true 就同時修好方向與行為。
        */}
        {railMode ? (
          <SideNavCollapseButton collapsible={{...collapsible, isCollapsed: true}} />
        ) : null}
        <SideNavSection title="Account" isHeaderHidden>
          {/*
            上面 Menu 區底下有一條,這裡也要有,兩塊「工具」才對稱。
            ⚠️ 底下要留一段空白:不留的話整塊帳號區會黏在這條線上
            (分隔線與第一列只差 **3px**,而最後一列離視窗底有 20px ——
            整塊看起來是往上貼的)。補 8px 之後上下是 11 / 12,視覺上就在中間了。
          */}
          <Divider xstyle={styles.accountDivider} />
          {/* 點自己的名字 = 打開個人設定。
              不是 `href="/"` 回首頁 —— 那跟上面的「New chat」重複,
              而「點自己」最自然的預期是「我的設定」。 */}
          <SideNavItem
            label={personName(me.display_name || me.username)}
            icon={UserCircle}
            onClick={onOpenSettings}
          />
          {/* 個人筆記:所有人都有,位置是「自己名字正下方、SSH Server 上面」。
              筆記是私人的,跟「我」同一類,所以緊貼著名字。
              功能開了才有(`can_notebook`,後端 NOTEBOOK_ENABLED 預設開;關掉的話 .env 一行)。 */}
          {me.can_notebook ? (
            <SideNavItem
              href="/notes"
              label="Notes"
              icon={NotebookPen}
              isSelected={pathname.startsWith('/notes')}
            />
          ) : null}
          {/* SSH 終端機。位置在帳號底下、深色模式上面。
              只有工程師 / 管理員(而且功能有開)看得到 —— `ssh_mode` 由後端算("full" 才畫),
              前端只拿它決定顯不顯示;直接打 /ssh 或直接連 WebSocket 都會被後端擋。
              英文標籤照側邊欄慣例(內容頁才是中文)。 */}
          {me.ssh_mode === 'full' ? (
            <SideNavItem
              href="/ssh"
              label="SSH Server"
              icon={SquareTerminal}
              isSelected={pathname.startsWith('/ssh')}
            />
          ) : null}
          {/* Work Flow:SSH Server 底下,跟它同一群人。部署的人沒放 workflow_actions.json 就沒有這一列
              (`workflow_enabled`);不是工程師 / 管理員也沒有(`can_terminal`)。 */}
          {me.workflow_enabled && me.can_terminal ? (
            <SideNavItem
              href="/workflow"
              label="Work Flow"
              icon={Workflow}
              isSelected={pathname.startsWith('/workflow')}
            />
          ) : null}
          {me.is_admin
            ? ADMIN_LINKS.map((link) => (
                <SideNavItem
                  key={link.href}
                  href={link.href}
                  label={link.label}
                  icon={link.icon}
                  isSelected={pathname.startsWith(link.href)}
                />
              ))
            : null}
          {/*
            ⚠️ **這裡刻意沒有小夥伴的顯示/隱藏開關。** 全站沒有任何地方呼叫
            `setPetHidden(true)`,小夥伴藏不起來,所以也不需要「叫回來」的入口。
            要加「藏起來」的入口之前先讀 `pet/pet-sprites.ts` 的 `setPetHidden`:
            **藏起來跟叫回來是一組的,要加就兩個一起加**,不要只加一半。
            也不需要「移回原位」的入口:釘住的小夥伴永遠看得到、也永遠拖得動
            (`usePetDrag` 的 `readPinned()` 與拖曳當下都會把座標夾進視窗內)。
          */}
          {/* 佈景切換。放這裡是因為它跟身分同一類:「這台機器上的我怎麼看這個網站」。
              切換會順手寫回伺服器,換一台電腦才是同一個樣子。 */}
          <SideNavItem
            label={mode === 'dark' ? 'Light mode' : 'Dark mode'}
            icon={mode === 'dark' ? Sun : Moon}
            onClick={toggleTheme}
          />
          {/* 改密碼緊貼在登出上面:兩個都是「這個帳號」的事,
              而登出永遠是最後一個。 */}
          <SideNavItem
            label="Change password"
            icon={KeyRound}
            onClick={onOpenChangePassword}
          />
          {/*
            ⚠️ **這裡刻意沒有「多因子驗證」。** 手機驗證碼是**管理員發放**的
            (帳號管理頁 → 產生 QR code),使用者這一側沒有任何自助入口。
            要加自助綁定的話,那是換一個模型,見 backend/app/mfa.py 的說明。
          */}
          <SideNavItem label="Sign out" icon={LogOut} onClick={() => void signOut()} />
        </SideNavSection>
        </HoverRegion>
      }
    >
      {/* 會捲的那一區一塊高亮。`absolute` 定在這一層,所以它跟著內容捲 ——
          不必再算 fixed 的定位基準,也不必捲動時把它藏起來。
          拖曳中不畫:那時候該看的是拖曳幽靈。 */}
      <HoverRegion
        isSuppressed={!!drag}
        pinnedRow={pinnedRow}
        pinnedNonce={pinnedNonce}
        onRoot={bindDrawerList}
      >
        {folderLayer.rows.length > 0 ? (
          <SideNavSection title="Folders" isHeaderHidden {...LIST_SECTION}>
            {folderLayer.rows.map((folder) => (
              <FolderNode
                key={folder.id}
                folder={folder}
                depth={0}
                ctx={folderCtx}
                reorder={folderLayer.reorder(String(folder.id))}
                orderIndex={folderLayer.cssOrder(String(folder.id))}
              />
            ))}
          </SideNavSection>
        ) : null}

        <SideNavSection title="Chats" isHeaderHidden {...LIST_SECTION}>
          {/* 順序是使用者排的(右鍵的 ^ / v)—— 預設 Shared 在 Personal 上面 */}
          {sectionLayer.rows.map((key) => (
            <Fragment key={key}>{chatSections[key]}</Fragment>
          ))}
        </SideNavSection>
      </HoverRegion>
    </SideNav>
    </>
  );
}

/**
 * rail 那兩顆圖示的浮層,**裡面的清單滑上去才掛**(效能)。
 *
 * 為什麼需要它,寫在 `Sidebar` 的 `railFlyout` 那一段。這裡只講一件事:
 * **關著的時候也要回傳一個東西,不能回傳 `null`。** `SideNavItem` 是用
 * `hasChildren`(就是 `!!children`)決定 rail 要不要走 popover 那條路的 ——
 * 回 `null` 的話那顆圖示會變成「沒有子項目」,浮層整個不存在。
 *
 * 展開的側邊欄一律直接把 children 放出來(`isOpen` 恆真),這一層在那邊是透明的。
 */
function RailFlyoutGate({
  isOpen,
  children,
}: {
  isOpen: boolean;
  children: React.ReactNode;
}) {
  if (isOpen) return <>{children}</>;
  return <Stack aria-hidden xstyle={styles.railFlyoutPlaceholder} />;
}

/**
 * 選單最上面那顆 `^` / 最下面那顆 `v`。
 *
 * 兩件事一定要照做:
 * - **到頂就不畫 `^`、到底就不畫 `v`**(只有一個成員時兩顆都不畫)——
 *   按了不會動的按鈕比沒有按鈕更難懂。
 * - `hasCloseOnSelect={false}` —— **只有這兩顆不關選單**。移動通常要按好幾下,
 *   每按一次就關掉等於要重開好幾次右鍵。其餘每一項照舊按完就關。
 */
function MoveItem({reorder, direction}: {reorder?: Reorder; direction: 'up' | 'down'}) {
  if (!reorder) return null;
  const isUp = direction === 'up';
  if (isUp ? !reorder.canUp : !reorder.canDown) return null;
  // 只有符號、置中、名字給報讀程式(長相見 sideNavParts 的 MoveMenuItem)
  return <MoveMenuItem direction={direction} name={isUp ? 'Move up' : 'Move down'} onMove={() => reorder.move(isUp ? -1 : 1)} />;
}

/**
 * 資料夾節點(遞迴)。
 *
 * 巢狀就是設計系統 shell-side-nav 範本裡「Workspace」那個結構:
 * `SideNavItem` 的 `collapsible` + children,children 裡再放 `SideNavItem`。
 * 所以子資料夾跟對話列長在同一個地方 —— 子資料夾排前面(它是容器,
 * 容器要先看到),對話列排後面。
 *
 * 這一坨 props 是一團 —— 但它們全部是「畫一個資料夾要知道的事」,
 * 拆成幾個小物件只會讓呼叫端更難讀。放進一個具名的 `FolderNodeContext`,
 * 至少那團東西有名字。
 */
type FolderNodeContext = {
  folderItems: Record<string, number>;
  byId: Map<string, ConversationSummary>;
  icons: Record<string, string>;
  colors: Record<string, string>;
  openFolders: number[];
  toggleOpen: (id: number, collapsed: boolean) => void;
  renamingFolderId: number | undefined;
  draft: string;
  setDraft: (v: string) => void;
  startRename: (folder: Folder) => void;
  commitRename: (id: number, previous: string) => void;
  /** Esc:丟掉打到一半的字,什麼都不送 */
  cancelRename: () => void;
  setIcon: (id: number, key: string) => void;
  setColor: (id: number, key: string) => void;
  addSubFolder: (parentId: number) => void;
  /** 直接在這個資料夾底下開一組新對話(見 Sidebar 的 newChatIn) */
  newChatIn: (folderId: number) => void;
  removeFolder: (id: number) => void;
  pickerNonce: number;
  onMenuClosed: () => void;
  renderRow: (
    c: ConversationSummary,
    orderIndex?: number,
    /** 這一列住在哪一層 —— 拖曳換位置要靠它分辨同層/跨層(見 DragPayload) */
    listKey?: string,
  ) => React.ReactNode;
  /** 一層清單的順序(子資料夾與資料夾裡的對話各是一層,見 Sidebar 的 `layer`) */
  layer: <T>(
    listKey: string,
    items: T[],
    keyOf: (item: T) => string,
  ) => {
    rows: T[];
    cssOrder: (key: string) => number;
    reorder: (key: string) => Reorder;
  };
  /** 右鍵選單開著的時候把高亮塊釘在這一列(傳那一列的元素,不是座標) */
  onPin: (row: HTMLElement | null) => void;
  /** 側邊欄收成 rail 了:資料夾只畫成一顆圖示,點了先展開(見 FolderNode 開頭) */
  isRailCollapsed: boolean;
  /** rail 模式點資料夾:把側邊欄展開,並把這個資料夾打開 */
  openInRail: (folderId: number) => void;
  /** 長按資料夾標頭就能把整個資料夾拖到別的資料夾底下 */
  dragProps: (folder: Folder) => {
    onPointerDown: (e: React.PointerEvent) => void;
    onClickCapture: (e: React.MouseEvent) => void;
    isDragging: boolean;
  };
};

function FolderNode({
  folder,
  depth,
  ctx,
  reorder,
  orderIndex,
}: {
  folder: FolderTree;
  depth: number;
  ctx: FolderNodeContext;
  /** 這個資料夾在同一層裡能不能往上/往下 */
  reorder?: Reorder;
  /** 看到的位置(CSS order,見 Sidebar 的 `renderOrder`) */
  orderIndex?: number;
}) {
  /** 這個資料夾**自己那一列**(不含底下的子項目)—— 釘高亮塊要量的就是它 */
  const rowRef = useRef<HTMLElement>(null);
  /**
   * 右鍵選單碰過才長出來 —— 跟 `ConversationRow` 的 `menuReady` 同一件事,
   * 那邊的註解是正本。資料夾這份更大(`AppearancePickers` 有顏色 20 格 + 圖示格,
   * 一個資料夾的選單有一兩百個節點)。
   */
  const [menuReady, setMenuReady] = useState(false);
  const armMenu = useCallback(() => setMenuReady(true), []);
  const inside = Object.entries(ctx.folderItems)
    .filter(([, fid]) => fid === folder.id)
    .map(([cid]) => ctx.byId.get(cid))
    .filter((c): c is ConversationSummary => !!c);
  /*
   * 子資料夾與資料夾裡的對話是**兩層**,各自排序 ——
   * 併成一層的話對話可以排到子資料夾上面,而「容器排前面」是這份側邊欄
   * 的規則(見下面 children 的註解)。
   */
  const childLayer = ctx.layer(`folder:${folder.id}:folders`, folder.children, (f) =>
    String(f.id),
  );
  const contentLayer = ctx.layer(folderChatsKey(folder.id), inside, (c) => c.conversation_id);

  if (ctx.renamingFolderId === folder.id) {
    return (
      <TextInput
        label="Folder name"
        isLabelHidden
        value={ctx.draft}
        onChange={ctx.setDraft}
        {...TITLE_INPUT_LIMIT}
        hasAutoFocus
        onBlur={() => ctx.commitRename(folder.id, folder.name)}
        // Esc 是取消,理由跟對話列那邊一模一樣(見 ConversationRow 的說明)
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter') ctx.commitRename(folder.id, folder.name);
          if (e.key === 'Escape') ctx.cancelRename();
        }}
      />
    );
  }

  /*
   * rail 模式(側邊欄收成 48px):資料夾只畫成一顆圖示,**點了先把側邊欄展開、
   * 再把這個資料夾打開**。
   *
   * 設計系統對「收合 + 有子項目」的做法是滑過 / 點下去開一張浮層,把整個資料夾
   * 的內容(子資料夾、對話列、拖曳、右鍵、顏色線)塞進去 —— 對話一多那張浮層
   * 就是一整片。rail 是「快速入口」,要看內容就該回到完整的清單,跟上面的
   * New folder 同一個原則(見 expandRail;Search 開的是面板,不走展開那條)。
   * 右鍵、拖曳、改名這些整理動作都在展開之後才有;rail 上不掛。
   * 顏色線與 `order` 跟完整模式一樣要給:圖示底下那條線讀的是 `--marker-color`,
   * 位置是使用者排的。
   */
  if (ctx.isRailCollapsed) {
    return (
      <Stack
        style={
          {
            '--marker-color': colorValue(ctx.colors[folder.id]),
            order: orderIndex,
          } as React.CSSProperties
        }
      >
        <SideNavItem
          label={folder.name}
          icon={<FolderIcon iconKey={ctx.icons[folder.id]} />}
          onClick={() => ctx.openInRail(folder.id)}
        />
      </Stack>
    );
  }

  const isOpen = ctx.openFolders.includes(folder.id);
  /** 收合時要顯示的未讀:自己的 + 所有子資料夾的(收起來就看不到底下了) */
  const unreadInside =
    inside.reduce((n, c) => n + c.unread_mentions, 0) +
    countUnreadDeep(folder.children, ctx);

  const dragging = ctx.dragProps(folder);

  return (
    <Stack
      data-drop-folder={String(folder.id)}
      /* 亮起來那一下由 `paintDropOver` 掛 `data-drop-over`,樣式在 global.css */
      xstyle={[
        styles.dropTarget,
        styles.aboveHoverPill,
        dragging.isDragging && sideNavStyles.rowDragging,
      ]}
      // ⚠️ 三個入口都要把選單備好(滑鼠、觸控長按、鍵盤焦點),理由見 `menuReady`
      onMouseEnter={armMenu}
      onFocus={armMenu}
      onPointerDown={(e: React.PointerEvent) => {
        armMenu();
        dragging.onPointerDown(e);
      }}
      onClickCapture={dragging.onClickCapture}
      // 這個資料夾的顏色。自訂屬性會往下繼承,圖示底下那條線讀的就是它。
      // `order` 是使用者排的位置 —— 走 CSS 不動 DOM,右鍵選單才不會被收掉。
      style={
        {
          '--marker-color': colorValue(ctx.colors[folder.id]),
          order: orderIndex,
        } as React.CSSProperties
      }
    >
      <ContextMenu
        label={`Actions for ${folder.name}`}
        onOpenChange={(open) => {
          // 右鍵的時候把高亮塊釘在這一列 —— 巢狀資料夾一多,
          // 光看選單彈出來的位置根本認不出是對哪一個按的
          ctx.onPin(open ? rowRef.current : null);
          if (!open) ctx.onMenuClosed();
        }}
        menuContent={
          !menuReady ? null : (
          <VStack gap={0.5} {...{'data-menu-flush': ''}}>
            <MoveItem reorder={reorder} direction="up" />
            {/*
              **排在 Rename 上面**:它是這個選單裡唯一會「做出新東西」的動作,
              其餘都是在整理既有的這一個資料夾。
            */}
            <ContextMenuItem
              label="New chat here"
              onClick={() => ctx.newChatIn(folder.id)}
            />
            <ContextMenuItem label="Rename" onClick={() => ctx.startRename(folder)} />
            <ContextMenuItem
              label="Add subfolder"
              onClick={() => ctx.addSubFolder(folder.id)}
            />
            <AppearancePickers
              nonce={ctx.pickerNonce}
              icon={ctx.icons[folder.id]}
              color={ctx.colors[folder.id]}
              onPickIcon={(key) => ctx.setIcon(folder.id, key)}
              onPickColor={(key) => ctx.setColor(folder.id, key)}
            />
            <Divider />
            <ContextMenuItem
              label="Delete folder"
              variant="destructive"
              onClick={() => ctx.removeFolder(folder.id)}
            />
            <MoveItem reorder={reorder} direction="down" />
          </VStack>
          )
        }
      >
        <SideNavItem
          // ref 會落在真正那一列(SideNavItem 內部的 <button>)上,
          // 不是外面包著子項目的那層 —— 釘高亮塊要量的就是它
          ref={rowRef}
          label={folder.name}
          // 圖示底下掛一條顏色線(見 styles.folderIconBar)
          icon={<FolderIcon iconKey={ctx.icons[folder.id]} />}
          collapsible={{
            isCollapsed: !isOpen,
            onCollapsedChange: (collapsed) => ctx.toggleOpen(folder.id, collapsed),
          }}
          // 「有幾組對話」不顯示。
          // 未讀只在**收合時**掛上來:展開的時候每一列自己會標。
          endContent={
            !isOpen && unreadInside > 0 ? <UnreadBadge count={unreadInside} /> : undefined
          }
        >
          <VStack
            gap={0.5}
            xstyle={sideNavStyles.nestGuide}
            /*
             * ⚠️ 右鍵不要往上冒泡。
             *
             * 每一個資料夾都是一個 ContextMenu,而巢狀的資料夾是**互相包住的** ——
             * 對子資料夾按右鍵,事件會一路冒到每一個祖先資料夾,於是它們的選單
             * 全部打開疊在同一個位置,最外層那個因為最後開所以疊在最上面。
             * 看到的就是「按 C 卻跳出 A 的選單」。在子項目這一層擋掉,
             * 底下的資料夾與對話列一起解決。
             */
            onContextMenu={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {/* 子資料夾排前面:它是容器,先看到容器才知道底下還有東西 */}
            {childLayer.rows.map((child) => (
              <FolderNode
                key={child.id}
                folder={child}
                depth={depth + 1}
                ctx={ctx}
                reorder={childLayer.reorder(String(child.id))}
                orderIndex={childLayer.cssOrder(String(child.id))}
              />
            ))}
            {contentLayer.rows.map((c) =>
              ctx.renderRow(
                c,
                /* 子資料夾排在對話前面,所以對話的 CSS order 要接在它們後面
                   —— 兩層共用同一個 flex 容器,order 是整個容器一起排的 */
                childLayer.rows.length + contentLayer.cssOrder(c.conversation_id),
                folderChatsKey(folder.id),
              ),
            )}
          </VStack>
        </SideNavItem>
      </ContextMenu>
    </Stack>
  );
}

/**
 * 資料夾的圖示 + 底下那條顏色線。
 *
 * 線畫在圖示這一格裡,不是整列的底邊 —— 它是「這個資料夾的記號」,
 * 不是一條分隔線。顏色從外層繼承下來的 `--marker-color` 讀。
 *
 * `fallback` 給 Personal / Shared:沒挑過圖示的時候要是它們原本那顆
 *(人 / 公司),不是一個資料夾。
 */
function FolderIcon({
  iconKey,
  fallback,
}: {
  iconKey: string | undefined;
  fallback?: LucideIcon;
}) {
  const Glyph = folderIcon(iconKey, fallback);
  return (
    <Stack xstyle={styles.folderIconWrap}>
      {/*
       * ⚠️ 一定要包設計系統的 `Icon`,不能直接畫 `<Glyph size={16} />`
       * (否則資料夾圖示的顏色會跟 New chat 不一樣)。
       *
       * 原因在 `SideNavItem`:它的 icon 插槽走 `renderIconSlot`,
       * 傳**元件**(New chat 的 `Plus`)會被包成 `<Icon color="secondary">`,
       * 傳**已經畫好的節點**(這個 FolderIcon)則原樣輸出 —— 那條上色就跳過了,
       * 圖示改為繼承整列的文字色,比旁邊那幾顆深一階。
       * 自己補上同一組 size/color,兩種路徑就一致了(sm = 1rem = 16px)。
       */}
      <Icon icon={Glyph} size="sm" color="secondary" />
      <Stack aria-hidden xstyle={styles.folderIconBar} />
    </Stack>
  );
}

/**
 * 圖示 + 顏色兩個挑選器。資料夾、Personal / Shared 的右鍵選單共用這一段。
 *
 * ⚠️ 兩個都要掛 `key`(而且**要有各自的前綴**):
 *   - 掛 key 是為了選單關掉再打開時展開狀態歸零 —— 不然下次右鍵會直接看到
 *     攤開的 20 格,看起來像「收不起來」。
 *   - 前綴是因為它們是兄弟,只用 nonce 的話兩個人的 key 一模一樣,
 *     React 會抱怨重複而且可能丟掉其中一個。
 */
function AppearancePickers({
  nonce,
  icon,
  color,
  onPickIcon,
  onPickColor,
}: {
  nonce: number;
  icon: string | undefined;
  color: string | undefined;
  onPickIcon: (key: string) => void;
  onPickColor: (key: string) => void;
}) {
  return (
    <>
      <FolderIconPicker key={`icon-${nonce}`} value={icon} onPick={onPickIcon} />
      <ColorPicker key={`color-${nonce}`} value={color} onPick={onPickColor} />
    </>
  );
}

/**
 * 關掉目前開著的右鍵選單。**在「⋯」選單要開之前呼叫。**
 *
 * ⚠️ 為什麼需要這一支:同一列上掛了兩個**互相不知道對方存在**的選單元件 ——
 * 右鍵那個是 `ContextMenu`,「⋯」那個是 `DropdownMenu`。它們底層都是原生
 * Popover,但模式不同:
 *
 *   ContextMenu   → `popover="manual"`(design system 寫死 `lightDismiss: false`)
 *   DropdownMenu  → `popover="auto"`
 *
 * 原生的規矩是「`auto` 開啟時會擠掉其他 `auto`」,而 **`manual` 完全不在那個
 * 堆疊裡** —— 沒有東西會自動關掉它。所以右鍵叫出選單之後再去點另一列的
 * 「⋯」,畫面上就會**同時開著兩個功能選單**。
 *
 * ContextMenu 自己有一支 document 的 mousedown 補救 handler,但它跟「⋯」的
 * 開啟是在搶時序 —— 搶贏就正常、搶輸就變兩個,所以症狀時有時無。
 *
 * `ContextMenu` 沒有開放外部控制開關(只有 `onOpenChange` 通知,開關全內部管),
 * 所以這裡直接對 DOM 呼叫 `hidePopover()`。**這是支援的做法**:`useLayer` 有
 * 一段專門 reconcile「瀏覽器主動關閉」的 `toggle` 監聽器,會把 React state
 * 同步回去並觸發 `onHide`,不會留下狀態不一致。
 *
 * 只挑 `manual` 是刻意的:`auto` 的那些(別列的「⋯」)原生就會自己互相擠掉,
 * 不需要也不該由我們插手。
 */
function closeOpenContextMenus(): void {
  document.querySelectorAll<HTMLElement>('[popover="manual"]').forEach((el) => {
    // :popover-open 在還沒開的元素上是 false,所以這裡等於「只關真的開著的」
    if (el.matches(':popover-open')) el.hidePopover();
  });
}

/**
 * Personal / Shared 的右鍵選單:只有外觀(改名、刪除、子資料夾都不適用 ——
 * 它們不是資料夾,是「未歸類」與「有人找你」兩個固定的區塊)。
 *
 * 顏色要下在**外面這層** Stack:自訂屬性會往下繼承,而
 * `SideNavItem` 不保證把 `style` 轉到掛 `xstyle` 的那個元素上
 *(線的寬度有效、顏色沒有)。ContextMenu 自己的 `style` 也不行 ——
 * 它會被套到彈出來的選單面板上,不是觸發區。
 */
function AppearanceMenu({
  name,
  storageKey,
  icons,
  colors,
  nonce,
  reorder,
  orderIndex,
  onMenuClosed,
  onPin,
  onPickIcon,
  onPickColor,
  children,
}: {
  name: string;
  storageKey: string;
  icons: Record<string, string>;
  colors: Record<string, string>;
  nonce: number;
  /** Personal / Shared 這兩個節點自己的上下順序 */
  reorder?: Reorder;
  /** 看到的位置(CSS order;Personal 的那層 Stack 自己下,這裡是 Shared 用的) */
  orderIndex?: number;
  onMenuClosed: () => void;
  onPin: (row: HTMLElement | null) => void;
  onPickIcon: (id: string, key: string) => void;
  onPickColor: (id: string, key: string) => void;
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLDivElement>(null);

  return (
    <Stack
      style={
        {
          '--marker-color': colorValue(colors[storageKey]),
          order: orderIndex,
        } as React.CSSProperties
      }
    >
      <ContextMenu
        ref={triggerRef}
        label={`Appearance for ${name}`}
        onOpenChange={(open) => {
          // 跟資料夾同一條:右鍵的時候把高亮塊釘在那一列,
          // 不然指標一移到選單上就看不出剛才按的是哪一個
          const row = triggerRef.current?.querySelector('.astryx-side-nav-item');
          onPin(open && row instanceof HTMLElement ? row : null);
          if (!open) onMenuClosed();
        }}
        menuContent={
          <VStack gap={0.5} {...{'data-menu-flush': ''}}>
            <MoveItem reorder={reorder} direction="up" />
            <AppearancePickers
              nonce={nonce}
              icon={icons[storageKey]}
              color={colors[storageKey]}
              onPickIcon={(key) => onPickIcon(storageKey, key)}
              onPickColor={(key) => onPickColor(storageKey, key)}
            />
            <MoveItem reorder={reorder} direction="down" />
          </VStack>
        }
      >
        {children}
      </ContextMenu>
    </Stack>
  );
}

/**
 * 未讀數的 Badge(三處共用:對話列、收合的資料夾、收合的 Shared)。
 *
 * 看得到的字封頂 `99+`(理由見 `unread-count.ts`)。
 * ⚠️ 封頂之後**確切數字只留給報讀軟體**:`99+` 那顆 Badge 掛 `aria-hidden`、
 * 旁邊放一份 `VisuallyHidden` 念確切數字(對話列的成員名單也是這樣跟 Badge 並排的)。
 * 不能用 Badge 的 `aria-label` 頂替 —— 它畫的是沒有 role 的 `<span>`,
 * 報讀軟體不念那種元素上的 `aria-label`。沒封頂時就是一顆純數字。
 */
function UnreadBadge({count}: {count: number}) {
  if (!isUnreadCapped(count)) return <Badge label={String(count)} />;
  return (
    <>
      <Badge label={formatUnreadCount(count)} aria-hidden />
      <VisuallyHidden>{String(count)}</VisuallyHidden>
    </>
  );
}

/** 子樹裡所有對話的未讀總和 */
function countUnreadDeep(children: FolderTree[], ctx: FolderNodeContext): number {
  let total = 0;
  for (const child of children) {
    for (const [cid, fid] of Object.entries(ctx.folderItems)) {
      if (fid !== child.id) continue;
      total += ctx.byId.get(cid)?.unread_mentions ?? 0;
    }
    total += countUnreadDeep(child.children, ctx);
  }
  return total;
}

/**
 * 每一列共用的那一組回呼(見 `Sidebar` 的 `rowHandlers`)。
 *
 * ⚠️ **整組是一個穩定的物件**,而且每一支都不綁定任何一列 —— 要知道是哪一列
 * 就把它當參數帶進去。每一列各自一組現做的箭頭函式會讓 `memo` 失效
 * (每次 render 都是「新的函式」)。
 */
type RowHandlers = {
  setDraft: (v: string) => void;
  startRename: (c: ConversationSummary) => void;
  commitRename: (c: ConversationSummary) => void;
  /** Esc:丟掉打到一半的字,什麼都不送 */
  cancelRename: () => void;
  remove: (c: ConversationSummary) => void;
  share: (c: ConversationSummary) => void;
  exportMd: (c: ConversationSummary) => void;
  /** 在資料夾裡才有意義:把這組移回未歸類(要不要畫看 `canMoveOut`) */
  moveOut: (c: ConversationSummary) => void;
  pickColor: (id: string, key: string) => void;
  /** 右鍵選單開著的時候把高亮塊釘在這一列(傳那一列的元素,不是座標) */
  pin: (row: HTMLElement | null) => void;
  /** 長按開始拖曳。這一支是**工廠** —— 列自己把 payload 組好再叫它。 */
  pointerDown: (payload: DragPayload) => (e: React.PointerEvent) => void;
  /** 吞掉拖曳結束後的那一發 click */
  clickCapture: (e: React.MouseEvent) => void;
};

type RowProps = {
  conversation: ConversationSummary;
  /**
   * `peopleDirectory` 的版本號。**畫面上沒有任何地方用得到它** ——
   * 它存在的唯一理由是讓名冊更新時 `memo` 失效(見 `usePeopleDirectory()` 那段)。
   * 看起來沒用就刪掉的話,共用成員的頭像會永遠停在縮寫、顏色停在名字雜湊色。
   * 跟 `pages/Chat.tsx` 的 `TurnProps.peopleVersion` 同一條。
   */
  peopleVersion: number;
  isCurrent: boolean;
  isRenaming: boolean;
  /** ⚠️ **只有正在改名的那一列會拿到真的字**,其他列一律空字串(見 `renderRow`) */
  draft: string;
  /** 在資料夾裡:選單要多一條「移出資料夾」 */
  canMoveOut: boolean;
  /** 這一列的顏色標記(使用者自己挑的,存本機) */
  color: string | undefined;
  /** 選單關掉就 +1,讓顏色挑選器整個重新掛載(展開狀態歸零) */
  pickerNonce: number;
  /** 這一列住在哪一層 —— 拖曳的 payload 要它(不屬於任何一層的列沒有,所以是可選的) */
  listKey?: string;
  isDragging: boolean;
  /*
   * ⚠️ **這裡沒有 `isRail`,而且不要加。**
   *
   * rail(收成 48px)的樣態全部由 CSS 認 `[data-rail-flyout]`(收合時才掛的記號)處理:浮層的寬度、
   * 標題的省略號、漂浮框都在 global.css 那一段。若做成 prop,
   * 它就得跟著 `isCollapsed` 翻 —— 收合或展開**每按一次**,
   * 這一道 `memo` 就對每一列失效一次,整份清單重算。
   *
   * 重算時間跟列數成正比:對話越多收合越卡,「用得越兇越慢」。
   * 加任何一個「會跟著收合狀態翻」的 prop 進來都會這樣。
   */
  handlers: RowHandlers;
};

/**
 * 展開的側邊欄裡,**被截斷的**對話標題滑上去看得到全文。
 *
 * 為什麼需要:`SideNavItem` 的標籤是 `nowrap` + 省略號,自訂標題可到 200 字、一列只放得下
 * 約 16 個中文字,而設計系統的 `Tooltip` **只在收合的 rail 才掛**(`SideNavItem.tsx` 的
 * collapsed 那條路),展開時完全沒有看全文的方法。
 *
 * 做法是**指標滑到標籤上才補一個原生 `title`**,而且只在真的被截斷時
 * (`scrollWidth > clientWidth`)。不用設計系統的 `Tooltip`,理由:
 *  - 它要**每一列各掛一份**(hook + 監聽器);這份清單的 `memo` / 選單延後掛載
 *    都是為了每列省一點成本(見 `ConversationRow` 與 `menuReady`),不要再加回去;
 *  - 它會在列上掛 `aria-describedby`,報讀軟體會把標題念兩次 —— 可及名稱本來就是完整標題
 *    (截斷只是 CSS),這件事只缺「看得到」,不缺「念得到」;
 *  - 要不要開得看「現在有沒有被截斷」,它的 `isEnabled` 是 render 時決定的,
 *    在 `pointerover` 裡翻再等重繪,會趕不上它自己的 `mouseenter`。
 *  代價:出現的延遲是瀏覽器的(比全站 120ms 慢),也沒有「第二次以後立刻出現」。
 *
 * ⚠️ 掛在**標籤那顆 `<span>`** 上,不是整列的 `<a>`:掛在 `<a>` 的話滑到右邊的「⋯」
 * 會同時冒出原生 title 與它自己的 tooltip;而子層 span 的 `title` 不進 `<a>` 的
 * 可及名稱 / 描述,報讀軟體那邊完全不變。
 * ⚠️ 只認 `pointerType === 'mouse'`:觸控沒有 hover(點一下的假 hover 會黏住,見 global.css
 * 開頭的 hover 媒體查詢那條),筆也不算。其餘指標一律把屬性拿掉。
 * ⚠️ 不 `stopPropagation`、不 setState:側邊欄的 `HoverRegion` 是在外層委派 `pointerover`
 * 的,這裡只讀兩個寬度、寫一個屬性,不碰浮起 / 高亮 / 長按拖曳 / 右鍵那幾條。
 * ⚠️ 標籤 span 沒有穩定的 class(StyleX 產的),所以用「沒有子元素、字等於標題」認它;
 * 改名之後 React 只換文字節點、不會清這個屬性,但下一次滑過會照新標題重算。
 * 資料夾名稱**不套**:資料夾名稱是換行顯示,不截斷。
 */
function syncTruncatedTitle(e: React.PointerEvent, title: string): void {
  const el = e.target;
  if (!(el instanceof HTMLSpanElement)) return;
  if (el.childElementCount !== 0 || el.textContent !== title) return;
  if (e.pointerType === 'mouse' && el.scrollWidth > el.clientWidth) {
    if (el.title !== title) el.title = title;
  } else if (el.hasAttribute('title')) {
    el.removeAttribute('title');
  }
}

/**
 * 側邊欄的一列對話。
 *
 * ⚠️ **包在 `memo` 裡**(效能)。側邊欄只要有任何 state 變動
 * (滑過一列、右鍵釘選、改名打字、開始/結束拖曳),React 預設會把**每一列**
 * 都重算一遍 —— 二十幾列,而其中通常只有一兩列真的長得不一樣。
 *
 * ⚠️ 這道門只有在 **props 真的穩定**時才有用。所以:
 *  - 回呼整組收在 `handlers` 裡,而那是一個 `useMemo` 的穩定物件
 *    (見 `Sidebar` 的 `rowHandlers`);
 *  - `draft` 只發給正在改名的那一列(其他列恆為 `''`);
 *  - 其餘的 props 全是字串 / 布林 / 數字。
 * 加回任何一個「當場新做的函式」都會讓它失效,而且**不會有任何錯誤訊息** ——
 * 只是又變回每次全部重算。
 */
const ConversationRow = memo(function ConversationRow({
  conversation: c,
  // ⚠️ `peopleVersion` **刻意不解構** —— 它只是拿來讓 memo 失效的(見 `RowProps`),
  // 列裡沒有人要讀它。解構了反而會是 TS6133(宣告了沒用到)。
  isCurrent,
  isRenaming,
  draft,
  canMoveOut,
  color,
  pickerNonce,
  listKey,
  isDragging,
  handlers,
}: RowProps) {
  const {
    setDraft,
    startRename,
    commitRename,
    cancelRename,
    remove: onDelete,
    share,
    exportMd,
    moveOut,
    pickColor,
    pin: onPin,
    pointerDown,
    clickCapture: onClickCapture,
  } = handlers;
  const onShare = () => share(c);
  const onExport = () => exportMd(c);
  const onStartRename = () => startRename(c);
  const onCommitRename = () => commitRename(c);
  const onCancelRename = cancelRename;
  const onMoveOut = canMoveOut ? () => moveOut(c) : undefined;
  const onPickColor = (key: string) => pickColor(c.conversation_id, key);
  const onPointerDown = pointerDown({
    kind: 'chat',
    id: c.conversation_id,
    title: c.title,
    listKey: listKey ?? '',
  });
  const [isHovered, setIsHovered] = useState(false);
  /** 這一列本身,右鍵/選單開著時要量它把高亮塊釘上去 */
  const rowRef = useRef<HTMLElement>(null);

  /**
   * 選單開著就把高亮塊釘在這一列(跟右鍵同一條)。
   * 它同時是「有選單開著」的訊號 —— 側邊欄靠它決定現在能不能動 DOM
   * (排序,見 `renderOrder`)。
   */
  const pinThisRow = useCallback(
    (open: boolean) => {
      const visual = rowRef.current?.querySelector('a');
      onPin(open && visual ? visual : null);
    },
    [onPin],
  );

  /*
   * 「⋯」是**按一下才開**的。⚠️ 不要做「滑上去就展開」。
   */
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // ⚠️ 開跟關**都要**設:只設 true 的話按過一次選單,那顆「⋯」就永遠掛在那裡
  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        closeOpenContextMenus();
      }
      setIsMenuOpen(open);
      pinThisRow(open);
    },
    [pinThisRow],
  );
  /**
   * 鍵盤焦點在這一列裡(focus-within)。少了它鍵盤使用者永遠叫不出「⋯」。
   *
   * ⚠️ 只認**鍵盤**帶進來的焦點(`:focus-visible`)。用滑鼠點「⋯」也會給它焦點,
   * 那時候如果算數的話:選單關掉、指標也移開了,那顆「⋯」還會留在原地不走
   *(因為焦點還在它身上)—— 看起來就是一顆卡住的按鈕。
   */
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const showMenu = isHovered || isMenuOpen || isFocusWithin;

  /**
   * 這一列的右鍵選單**碰過才長出來**(效能)。
   *
   * 設計系統的 `ContextMenu` 不管開沒開都會把 `menuContent` 渲染進 DOM
   * (`ContextMenu.tsx` 的 `layer.render(...)` 是無條件的)。這份選單裡有
   * `ColorPicker` 的 20 格顏色,一列就是上百個節點 —— 對話一多,
   * 整個 `<nav>` 的節點大半會是這些**從來沒被打開過**的選單。
   * 而改根字級(Text size 拉桿)或側邊欄寬度會讓整份文件重算樣式 + 重排,
   * 節點越多越慢,拖曳、收合、調拉桿都會掉幀。
   *
   * ⚠️ **不能用 `showMenu` 當條件**:那個值會在指標移開時翻回 false,
   * 於是每掃過一列就是一次掛載 + 一次卸載 —— 反而更貴。這裡是**單向**的,
   * 碰過就留著。
   * ⚠️ 三個入口都要 arm,少一個就會有人按出空選單:滑鼠(`mouseenter`,
   * 一定發生在右鍵之前)、觸控長按(`pointerdown` 在 `contextmenu` 之前)、
   * 鍵盤(`focus`,Tab 到「⋯」)。
   */
  const [menuReady, setMenuReady] = useState(false);
  const armMenu = useCallback(() => setMenuReady(true), []);

  const streaming =
    c.running || getActiveStreams().some((p) => p.conversationId === c.conversation_id);

  /**
   * 右鍵與「⋯」共用同一份 —— 觸控裝置沒有右鍵,兩個入口都要留,
   * 而兩邊的內容如果各寫一份,遲早會有一邊少一項。
   *
   * **沒有上移 / 下移那兩顆箭頭** —— 對話的順序靠長按拖曳對調(見 swapWithin)。資料夾與 Personal / Shared 的選單還留著箭頭:
   * 拖曳只排得動對話,那兩種拿掉箭頭就沒辦法排了。
   *
   * 歸類靠長按拖曳(選單裡沒有 Move to),但「移出資料夾」留在選單裡:
   * 拖曳是滑鼠/觸控限定的,鍵盤使用者不能只有進得去出不來。
   * 分隔線只有一條,而且意思固定:上面是一般動作,下面是會弄不見東西的動作。
   * 對話與資料夾的選單都照這條規則,不要一個一條、一個兩條。
   */
  const menuContent = !menuReady ? null : (
    <VStack gap={0.5} {...{'data-menu-flush': ''}}>
      <ContextMenuItem label="Rename" onClick={onStartRename} />
      {onMoveOut ? (
        <ContextMenuItem label="Move out of folder" onClick={onMoveOut} />
      ) : null}
      <ContextMenuItem label="Share with colleagues…" onClick={onShare} />
      <ContextMenuItem label="Export as Markdown" onClick={onExport} />
      {/* 顏色標記。掛 nonce 的理由跟資料夾那邊一樣:
          選單關掉再打開時,展開的 20 格要歸零。 */}
      <ColorPicker key={`color-${pickerNonce}`} value={color} onPick={onPickColor} />
      <Divider />
      <ContextMenuItem
        label={c.shared_with_me ? 'Leave shared chat' : 'Delete'}
        variant="destructive"
        onClick={() => onDelete(c)}
      />
    </VStack>
  );

  if (isRenaming) {
    return (
      <TextInput
        label="Conversation title"
        isLabelHidden
        value={draft}
        onChange={setDraft}
        {...TITLE_INPUT_LIMIT}
        hasAutoFocus
        onBlur={onCommitRename}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter') onCommitRename();
          /*
           * ⚠️ Esc 是**取消**,不能靠 `blur()` 收尾。
           *
           * `blur()` 會同步觸發 `onBlur → commitRename`,而 `commitRename`
           * 讀的是**這一輪 render 的 `draft`** —— 前一行的 `setDraft` 只是排進
           * 佇列,那時候還沒生效。結果是「打了 aaa 再按 Esc」把 aaa 存了進去:
           * 使用者用來反悔的那一顆鍵,變成唯一會把誤打內容寫進伺服器的路徑。
           * 直接收掉改名狀態就好 —— 元素被卸載不會再發 blur。
           */
          if (e.key === 'Escape') onCancelRename();
        }}
      />
    );
  }

  const isShared = c.shared_with_me || c.shared_out;
  /**
   * 給報讀軟體的那一份成員名單(見下面的 `membersLabel`)。
   * 浮層是滑鼠限定的,只有它的話用鍵盤的人完全不知道這組對話有誰在裡面。
   */
  /**
   * 共用成員,**「誰是擁有者」只在這裡判一次**。
   *
   * 後端保證擁有者排第一(`routers/conversations.share_members()`)。浮層上的皇冠
   * 與底下 sr-only 那句話講的是同一件事,兩邊必須同步 —— 規則各寫一次的話
   * 遲早會有一邊被改到。
   *
   * ⚠️ `raw` 要留著:頭像與配色是拿它去名冊查的(`avatarOf` / `avatarTint`),
   * 而 `name` 已經被 `personName()` 動過大小寫。
   */
  const members = (c.share_members ?? []).map((raw, i) => ({
    raw,
    name: personName(raw),
    isOwner: i === 0,
  }));

  const membersLabel = [
    c.shared_with_me && c.shared_by
      ? `Shared by ${personName(c.shared_by)}.`
      : 'Shared chat.',
    /*
     * ⚠️ **擁有者要在這句話裡標出來。** 浮層上那件事是一顆皇冠圖示畫的,
     * 而圖示是 `aria-hidden` 的 —— 不補一次的話,用報讀軟體的人就完全不知道
     * 這組對話是誰的(只靠 hover 顯示的資訊要另外給一份)。
     */
    members.length > 0
      ? `People: ${members.map((m) => (m.isOwner ? `${m.name} (owner)` : m.name)).join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  const row = (
    <ContextMenu
      menuContent={menuContent}
      label={`Actions for ${c.title}`}
      onOpenChange={(open: boolean) => {
        // 釘住高亮塊 —— 指標一移到選單上,這一列的 mouseleave 就會發生,
        // 不釘的話「我按的是哪一列」正好在那一刻消失。
        // 釘的是**看得到的**那塊(SideNavItem 的連結),不是外面那層包裝 ——
        // 包裝含 ContextMenu 的觸發區與拖放外框,量它的話高亮會比字寬一圈。
        const visual = rowRef.current?.querySelector('a');
        onPin(open && visual ? visual : null);
      }}
    >
      <Stack
        ref={rowRef}
        // 這一列浮不浮、要不要露出「⋯」看它;高亮塊是側邊欄那邊委派處理的
        // ⚠️ `armMenu` 跟著三個入口走,理由見 `menuReady`
        onMouseEnter={() => {
          setIsHovered(true);
          armMenu();
        }}
        onMouseLeave={() => setIsHovered(false)}
        // 被截斷的標題滑上去補原生 title(理由見 `syncTruncatedTitle`)
        onPointerOver={(e: React.PointerEvent) => syncTruncatedTitle(e, c.title)}
        // focus-within 的等價寫法。
        // ⚠️ onBlur 一定要判 relatedTarget:從連結 Tab 到「⋯」時,
        // blur 比 focus 先發生 —— 不判的話選單會在焦點抵達前就被卸載,
        // 鍵盤使用者永遠按不到它(整個 focus-within 等於白做)。
        onFocus={(e: React.FocusEvent) => {
          // 焦點一進來就把選單備好(即使是滑鼠帶進來的)—— 那是右鍵的前一步
          armMenu();
          // 滑鼠點出來的焦點不算,見上面 isFocusWithin 的說明
          const el = e.target as HTMLElement;
          if (!el.matches(':focus-visible')) return;
          setIsFocusWithin(true);
        }}
        onBlur={(e: React.FocusEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsFocusWithin(false);
          }
        }}
        onPointerDown={(e: React.PointerEvent) => {
          // 觸控的長按選單走這條:`pointerdown` 一定在 `contextmenu` 之前
          armMenu();
          onPointerDown(e);
        }}
        onClickCapture={onClickCapture}
        // 瀏覽器預設把 <a> 當成可拖曳物件:按住移動會變成原生「拖圖」,
        // dragstart 一發生 pointermove 就再也收不到,長按拖曳整個失效。
        // 這兩個屬性要掛在會被按住的那一層。
        draggable={false}
        onDragStart={(e: React.DragEvent) => e.preventDefault()}
        // 拖曳中把自己調淡,才知道正在搬的是哪一列
        xstyle={[styles.row, isDragging && sideNavStyles.rowDragging]}
        /*
         * 浮起來那 2px **不在這裡** —— 它是 global.css 的一條規則,
         * 側邊欄裡每一個可以按的東西都適用,而且右鍵選單
         * 開著的時候靠 `[data-pinned]` 撐住不掉下來。
         */

      >
        <SideNavItem
          href={`/c/${c.conversation_id}`}
          /*
           * ⚠️ **永遠是完整的標題。** rail 的浮層裡要截短(不然會太寬),但那件事由 CSS 做
           * —— 浮層有 `max-width`,標籤自己 `text-overflow: ellipsis`
           * (`SideNavItem` 本來就有),見 global.css 的 `[data-rail-flyout]` 那段。
           *
           * 不要在這裡依收合狀態截字串:那需要一個跟著收合狀態翻的 prop,
           * 代價是整份清單每次收合/展開都重算一遍(見 `RowProps` 上面那段)。
           * 漂浮框(`data-hover-lift="pill"`)同理,也在 CSS。
           */
          label={c.title}
          isSelected={isCurrent}
          endContent={
            /* 這一區在 <a> 裡面,不擋的話按 ⋯ 會連帶把整列的連結一起觸發,
               畫面就跳去那組對話了。mousedown 也要擋 —— 連結是在
               mousedown 就開始處理的。 */
            <HStack
              gap={1}
              vAlign="center"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* 版面順序:標題 →(回答中脈動點)→(共用圖示)→(未讀數字)。
                  「⋯」排在最後,而且**不取代**脈動點 —— 取代的話滑鼠一移過去,
                  「這組還在跑」當場消失,而那正是最需要看到它的時候。 */}
              {/* 顏色標記(對照設計系統 side nav 右邊那顆點)。
                  排在這一組的**最前面**:它是這一列自己的記號、會一直在,
                  而脈動點 / 未讀數 / 「⋯」是來來去去的 —— 讓會變的東西
                  在它右邊長出來,這顆點的位置才不會跟著跳。
                  沒挑顏色就不畫,跟資料夾那條線同一條規則。 */}
              {hasColor(color) ? (
                <ColorTag color={colorValue(color)} />
              ) : null}
              {streaming ? <StatusDot variant="accent" isPulsing label="Answering" /> : null}
              {/* 共用**不畫圖示** ——「這一區是共用」左邊的 Shared 節點已經講過一次了。
                  但名單一定要留一份給報讀軟體:浮層是滑鼠限定的。 */}
              {isShared ? <VisuallyHidden>{membersLabel}</VisuallyHidden> : null}
              {c.unread_mentions > 0 ? <UnreadBadge count={c.unread_mentions} /> : null}
              {showMenu ? (
                /*
                 * 用 `DropdownMenu` 不用 `MoreMenu`:MoreMenu
                 * 只收資料陣列(`items`),沒有開放自訂內容 —— 而右鍵那份選單
                 * 是 JSX。MoreMenu 自己也就是一顆
                 * icon-only 的按鈕 + DropdownMenu,下面這幾個 prop 是照它
                 * 那組設定寫的,外觀一樣。
                 */
                <DropdownMenu
                  button={{
                    label: 'Conversation options',
                    /*
                     * 圖示縮到 `xsm`(預設尺寸在窄列上顯得太大)。
                     * ⚠️ **縮的是圖示不是按鈕** —— `size: 'sm'` 已經是 IconButton
                     * 最小的一階,再往下就得自己覆蓋尺寸。而且按鈕本體縮小等於連
                     * 點擊範圍一起縮,那一列本來就窄,會變得很難點中。
                     * 所以外框(命中區)不動,只有那三個點變小。
                     */
                    icon: <Icon icon="moreHorizontal" size="xsm" />,
                    variant: 'ghost',
                    size: 'sm',
                    isIconOnly: true,
                    tooltip: 'Conversation options',
                  }}
                  hasChevron={false}
                  onOpenChange={handleMenuOpenChange}
                >
                  {menuContent}
                </DropdownMenu>
              ) : null}
            </HStack>
          }
        />
      </Stack>
    </ContextMenu>
  );

  if (!isShared) return row;

  return (
    <HoverCard
      delay={120}
      placement="end"
      alignment="start"
      label={`People in ${c.title}`}
      hasHoverIndication={false}
      /*
       * 「⋯」開著的時候把成員名單收起來(不然同時顯示太多資訊)。
       *
       * 名單浮層是往右開的,選單也是 —— 兩塊面板同時掛在同一列旁邊,
       * 疊在一起就分不出哪一塊在講什麼。選單是使用者主動叫出來的,
       * 名單是滑過去附送的,所以讓後者讓位。
       * ⚠️ 只在開著時傳 `false`(強制收),其餘傳 `undefined` 交回它自己的
       * hover/focus 判斷 —— 傳 `true`/`false` 以外的受控值會把整組觸發器綁死。
       */
      isOpen={isMenuOpen ? false : undefined}
      content={
        /*
         * ⚠️ **這裡只有頭像跟名字,沒有任何一行說明字**(不寫 Shared with / Shared by)——
         * 跟「畫面上不要放說明文字」同一條規則。這塊浮層是滑過去附送的,
         * 它要回答的只有「這組對話裡有誰」。
         * 「是誰分享給我的」那句話還在,但只留給報讀軟體(見 `membersLabel`)。
         */
        <VStack gap={0.5}>
          {members.length > 0 ? (
            members.map((m) => (
              <HStack key={m.raw} gap={1} vAlign="center">
                {/* 有上傳照片就用照片;沒有才退回名字縮寫,
                    顏色照名冊位置分(見 avatar-colors.ts) */}
                <Avatar
                  name={m.name}
                  src={avatarOf(m.raw)}
                  size="xsm"
                  tooltip={false}
                  style={avatarTint(m.raw)}
                />
                <Text type="supporting">{m.name}</Text>
                {/* 皇冠標出擁有者(不寫「(owner)」字樣)——
                    圖示不念,那句話由 `membersLabel` 補給報讀軟體。 */}
                {m.isOwner ? (
                  /* ⚠️ **實心**。lucide 預設只描邊,
                     要填色就得同時給 `fill` 與 `color` —— 只給 `color` 的話
                     裡面是空的,小到 12px 幾乎看不出是皇冠。

                     ⚠️ 用 `--color-border-yellow`(#e4c279)**不是** `--color-icon-yellow` ——
                     後者在淺色佈景下是 `#584400`,那是為了「白底上的小圖示要讀得到」
                     調的深橄欖黃,填滿之後看起來像髒掉的咖啡色。
                     border 那一階是真正的金黃,而且深色佈景下是 `#c0990e`,兩邊都成立。
                     ⚠️ 仍然是 token,不要改成寫死的色碼。 */
                  <Icon
                    icon={Crown}
                    size="xsm"
                    fill="var(--color-border-yellow)"
                    // Icon 的 color 只收語意色,沒有 border-yellow 這一階 —— 用 style 帶同一個 token
                    style={{color: 'var(--color-border-yellow)'}}
                  />
                ) : null}
              </HStack>
            ))
          ) : (
            <Text type="supporting">No members listed.</Text>
          )}
        </VStack>
      }
    >
      {row}
    </HoverCard>
  );
});
