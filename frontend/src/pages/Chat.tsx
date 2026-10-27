/**
 * 問答頁 —— 整個 app 的主體。
 *
 * 設定 → 歷史 → 送出 → 串流 → 渲染 → 接回進行中的題目,
 * 加上附件、@ 便條、模型下拉、檔案區。
 */
import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent} from 'react';
import * as stylex from '@stylexjs/stylex';
import {useLocation, useNavigate, useParams} from 'react-router-dom';

import {Banner} from '@astryxdesign/core/Banner';
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSendButton,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatComposerInputHandle,
} from '@astryxdesign/core/Chat';
import {Card} from '@astryxdesign/core/Card';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {Grid} from '@astryxdesign/core/Grid';
import {useEntryAnimation} from '@astryxdesign/core/hooks';
import {Icon, type IconSize} from '@astryxdesign/core/Icon';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import {Popover} from '@astryxdesign/core/Popover';
import {Button} from '@astryxdesign/core/Button';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {ResizeHandle, useResizable} from '@astryxdesign/core/Resizable';
import {Markdown} from '@astryxdesign/core/Markdown';
import {Skeleton} from '@astryxdesign/core/Skeleton';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Thumbnail} from '@astryxdesign/core/Thumbnail';
import {ToggleButton, ToggleButtonGroup} from '@astryxdesign/core/ToggleButton';
import {Timestamp} from '@astryxdesign/core/Timestamp';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';

import {Token} from '@astryxdesign/core/Token';
import {
  AtSign,
  Bot,
  Building2,
  Check,
  Code2,
  Copy,
  ChevronRight,
  Download,
  FileImage,
  Files,
  FileSpreadsheet,
  FileText,
  Lightbulb,
  Paperclip,
  PenLine,
  Pencil,
  RefreshCw,
  Search,
} from 'lucide-react';

import {growStyles} from '../components/growShell';
import {NoticeCard} from '../components/NoticeCard';
import {ComposerDictationButton} from '../components/ComposerDictationButton';
import {FileLightbox} from '../components/FileLightbox';
import {
  FilePreviewPanel,
  PANEL_BREAKPOINT,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  useFilePreviewPanel,
} from '../components/FilePreviewPanel';
import {FilesDialog} from '../components/FilesDialog';
/*
 * ⚠️ **畫面上的同事名字一律出自 `components/PersonDisplay.tsx`**,
 * 這個檔案不要自己組。
 *
 * 那三個出口(@ 膠囊、頭像、滑過去那張卡)對同一個帳號必須給出同一個名字;
 * 分在兩個檔案就會出現「兩個地方,其中一個沒對齊」。收在一起並有測試
 * (`components/__tests__/PersonDisplay.test.tsx`)。
 *
 * 留在這個檔案的只有**版面**:`TurnPersonAvatar` 那層 `avatarBox` 幾何。
 */
import {
  MentionedText,
  PersonAvatar,
  mentionToken,
} from '../components/PersonDisplay';
import {Logo} from '../components/Logo';
import {AnswerMarkdown} from '../components/AnswerMarkdown';
import {
  ANSWER_SHOT_ATTR,
  SaveAnswerMenu,
  SelectionSaveButton,
  useSaveToNotes,
  type SaveKind,
} from '../components/SaveToNotes';
import {
  createNote,
  getConfig,
  getConversationTurns,
  forgetConversation,
  listConversationFiles,
  peekConfig,
  peekConversationFiles,
  peekConversationTurns,
  listNotes,
  isMine,
  FINISHED_STEP_LIMIT,
  MAX_NOTE_CHARS,
  parseOutputFiles,
  parseSources,
  type AppConfig,
  type ConversationFileGroup,
  type ParsedSource,
  type HistoryItem,
  type NoteItem,
} from '../lib/chatApi';
import {splitAnswer, splitStreamingAnswer} from '../lib/answerSections';
import {copyText} from '../lib/clipboard';
import {buildFileView, countFiles, stripIndexOf} from '../lib/conversationFiles';
import {isImageFilename, isOfficeFilename, isPdfFilename} from '../lib/filekind';
import {fileDownloadUrl, uploadUrl} from '../lib/files';
import type {LightboxItem} from '../lib/lightboxItem';
import {looksLikeMention, mentionedUsernames} from '../lib/mentions';
import {
  CONVERSATIONS_UPDATED,
  markConversationRead,
  notifyConversationsUpdated,
  type ShareablePerson,
} from '../lib/conversationsApi';
import {toolLabel} from '../lib/tools';
import {HOVER_QUERY, MOBILE_QUERY, useMediaQuery} from '../lib/media';
import {
  conversationModelOf,
  modelLabel,
  pickModel,
  rememberConversationModel,
  usePreferredModel,
} from '../lib/modelPref';
import {CONSULTANT_ROLE, FULL_ACCESS_ROLE} from '../lib/adminApi';
import {Landing as SharedLanding} from '../components/Landing';
import {personName} from '../lib/people';
import {MentionList} from '../components/MentionList';
import {
  mentionablePeople,
  peopleDirectoryFailed,
  usePeopleDirectory,
} from '../lib/peopleDirectory';
import {toastError, toastInfo} from '../lib/toast';
import {newConversationId} from '../lib/ids';
import {jumpAndUnlock} from '../lib/chatJump';
import {spotlightAnchor} from '../lib/jumpSpotlight';
import {
  clearPending,
  getPending,
  runningStepStatus,
  startStream,
  stopStream,
  subscribeAll,
  syncActiveRuns,
  type Pending,
  type RunSource,
} from '../lib/runs';
import {formatDayLabel, formatDuration, formatStepDuration, parseServerTime, stepDurationMs} from '../lib/time';
import {registerBusySource} from '../lib/unsavedWork';
import {useComposerAttachments, type AttachmentNotice} from '../lib/useComposerAttachments';
import {useFlip} from '../lib/useFlip';
import {currentChatMorph, morphChat, notifyChatCommitted} from '../lib/chatTransition';
import {isPageSwapping} from '../lib/pageSwap';
import {useMe} from '../lib/useIdentity';

/**
 * 訊息串與輸入框的寬度。設計系統 `ai-chat-landing` 範本用 720,
 * 這裡放寬到 820 —— 還沒寬到讓眼睛從行首找不到行尾。
 */
const CONTENT_WIDTH = 820;

/** 產出檔案那張卡的寬度。範本的 `ArtifactCard` 是 360。 */
const OUTPUT_CARD_WIDTH = 360;

/**
 * 空白頁**自己的寬度**,比輸入框窄(招呼語那一塊窄一點,
 * 輸入框維持原寬)。720 是範本的原值,一排仍然放得下兩張
 * `SUGGESTION_MIN_WIDTH` 的卡片。
 */
const LANDING_WIDTH = 720;


/**
 * 訊息旁邊那顆頭像的直徑 —— **AI 與同事共用同一個數字**
 *(介於 Avatar sm 的 28 與 md 的 36 之間)。
 *
 * ⚠️ **同事的頭像也要吃這個常數**(`size={AVATAR_PX}`,Avatar 收數字)。
 * 兩邊各寫各的尺寸,一邊改了另一邊不會跟,同一串對話裡兩種頭像會不一樣大。
 *
 * ⚠️ `styles.avatarBox` 的邊距是**用這個常數算出來的**(見那一段的說明)。
 * 改這個數字它們會自己重新平衡,不要另外去動那些數字。
 */
const AVATAR_PX = 32;
/**
 * 設計系統 ChatLayout(spacious)的訊息區與輸入框那排:最寬 800、訊息區左右各 16 的內距(設計系統 dist 的樣式)。
 * 只用來算 messageWidth 的左側補白(頭像跟輸入框的相對位置),升級設計系統時對一下
 */
const CHAT_AREA_MAX_PX = 800;
const CHAT_AREA_PAD_PX = 16;

/**
 * 「檔案區跳到這一則」的落點記號(提問 / 答案 / 便條三種都掛)。
 *
 * 存在的理由是**上面要留一點空**。`scrollIntoView`
 * 的 `block: 'start'` 會把那一則**貼齊**捲動容器的上緣 —— 那一則上面
 * 一點前文都看不到,而「這是接在哪裡的」正是跳過去之後第一個想知道的事。
 *
 * 留白走 CSS 的 `scroll-margin-block-start`(規則在 global.css),不是在
 * JS 裡多捲一段:多捲一段要自己找出那個捲動容器,而訊息區的容器是
 * `ChatLayout` 內部的,沒有公開的把手;而且它同時被串流的黏底補間
 * (`useChatStreamScroll`)寫著 scrollTop,兩邊搶同一個值。
 * `scroll-margin` 是瀏覽器在算落點時就一起算進去的,搶不到。
 */
const JUMP_ANCHOR = {'data-jump-anchor': ''} as const;

/**
 * 輸入框那一排選項鈕(@ / 附件 / Files / 模型)共用的記號。
 *
 * 兩件事:
 * - `data-hover-lift`:滑過去浮起一塊(見 global.css)。
 * - `data-composer-action`:**顏色跟側邊欄的列一致**。
 *   側邊欄平常是「文字 primary + 圖示 secondary」,滑過去兩者都變 primary;
 *   而 `Button` 的 ghost 是整顆 primary,所以那排圖示比側邊欄深一階。
 *   規則寫在 global.css —— 跟側邊欄那條放在一起,兩邊才不會各漂各的。
 *
 * ⚠️ **七顆全部用同一份**(含 `sendActions` 的錄音鈕)。各自寫
 * `{...{'data-hover-lift': 'pill'}}` 的話,新加的那顆就會有人忘了掛;
 * 錄音鈕也要有漂浮框,不要只掛顏色。
 */
const COMPOSER_ACTION = {
  'data-hover-lift': 'pill',
  'data-composer-action': '',
} as const;

/**
 * 那**一整排**的容器記號(不是單顆鈕)。
 *
 * global.css 靠 `:has()` 從這個記號往上兩層找到 `ChatComposer` 的 footer,
 * 手機版讓它換行(理由寫在那條規則上)。
 *
 * ⚠️ 名字**刻意跟 `COMPOSER_ACTION` 的 `data-composer-action` 分得開**:
 * 兩個用途完全不同(一個是顏色與漂浮框,一個是版面),名字太像就會
 * 把規則下錯目標。`footer` 講的是位置,對得上它在 CSS 裡的角色。
 */
const COMPOSER_FOOTER = {'data-composer-footer': ''} as const;

/**
 * 輸入框**底下**那四顆分類籤(Research / Writing / Coding / Creative)共用的記號。
 *
 * 跟 `COMPOSER_ACTION` 分開一個名字、但顏色規則是同一條(見 global.css:
 * 兩個選擇器寫在一起)——「那排鈕」跟「那些提示詞」
 * 都要跟側邊欄的字同色,所以顏色必須是同一個 token;
 * 但它們的**浮起**要比那排小圖示鈕更重一階(籤的面積大得多),
 * 那一段只掛在這個記號上。
 */
const LANDING_CHIP = {
  'data-hover-lift': 'pill',
  'data-landing-chip': '',
} as const;

/*
 * 附件通知(對話框右邊、從視窗下面浮上來的卡片)的進場與退場
 * 住在 global.css 的 `[data-notice]` / `[data-leaving]`:transition + `@starting-style`,
 * 不是 keyframes(keyframes 不能中斷,連掛好幾個檔時卡是連續插進來的,
 * 送出時整疊又是一次被清空)。退場的時機由 hook 掛 `isLeaving`(`useComposerAttachments.ts`)。
 */

const styles = stylex.create({
  /**
   * 產出檔卡片的檔名:底線連起來的長檔名(`monthly_report_export_final_v2.py`)沒有斷點,
   * 不給斷的話會撐破卡片、把右邊的箭頭擠出去。
   */
  outputCardName: {overflowWrap: 'anywhere'},
  /** 置中版面的捲動殼:內容比視窗高(小螢幕)時要捲得動 */
  landingScroll: {
    overflowY: 'auto',
    // 跟對話頁的 `.astryx-chat-layout` 留同一條捲軸槽(global.css),兩種版面的中線才對得齊
    scrollbarGutter: 'stable',
  },
  /**
   * 置中版面本體。
   * ⚠️ **不用 vAlign center**:垂直置中的話,點分類籤展開四張範例卡會讓
   * 整組內容重新置中 —— 招呼語跟輸入框整頁往上抬。
   * 固定的上緣留白(值挑成跟置中時招呼語的落點一樣),分類展開只會**往下**長,上面的東西一動不動。
   */
  landingPage: {
    minHeight: '100%',
    width: '100%',
    paddingInline: 'var(--spacing-6)',
    paddingBlock: 'var(--spacing-8)',
    /*
     * 上緣留白**手機要小很多**。
     *
     * 桌機那個 `min(26vh, 220px)` 是對著寬螢幕調的:那裡內容矮、視窗扁,
     * 這段留白剛好把招呼語推到視覺中央。手機是窄而高的畫面,同樣的比例會吃掉
     * 三分之一屏(812 高的手機上,頂列到招呼語之間約 310px),
     * 而招呼語底下的東西(輸入框 + 兩排分類籤)本來就快把剩下的空間填滿。
     * 手機收成一格 spacing-8 再加最多 32px,內容就從畫面上半部開始。
     *
     * ⚠️ 還是**固定值,不要改成垂直置中**(見上面那段):
     * 置中的話點分類籤展開範例卡會讓整組內容往上抬。
     * 斷點同 `lib/media.ts` 的 `MOBILE_QUERY`。
     */
    paddingBlockStart: {
      default: 'calc(var(--spacing-8) + min(26vh, 220px))',
      '@media (max-width: 768px)': 'calc(var(--spacing-8) + min(6vh, 32px))',
    },
  },
  /*
   * New chat ↔ 對話的過場(`lib/chatTransition.ts`,節奏在 global.css 的「New chat ↔ 對話的過場」)。
   * ⚠️ 名字一頁只能有一個看得到的元素,重複的話瀏覽器整個跳過過場(畫面照換,只是沒有動畫)。
   * 只有輸入框自成一組;招呼語 / 訊息串**不另外取名**:
   * 它們跟著整頁原地淡入淡出。自成一組時瀏覽器會把舊的訊息串(很高、捲到底)縮放著搬到新位置,
   * 時間曲線又跟輸入框不同,看起來很亂。
   */
  vtComposer: {viewTransitionName: 'composer'},
  /** 招呼語的骨架:看不見的真招呼語撐高度,灰條疊在上面(見 `landing`) */
  greetingSkeleton: {position: 'relative'},
  greetingGhost: {visibility: 'hidden'},
  greetingBars: {position: 'absolute', insetBlockStart: 0, insetInline: 0, maxWidth: '100%'},
  /** 招呼語 / 分類那兩塊的寬度(跟範本同一個 720) */
  landingBlock: {
    width: '100%',
    maxWidth: LANDING_WIDTH,
  },
  /** 分類籤那一塊的內距 —— ai-chat-landing 範本原樣(`paddingInline: spacing-3`) */
  landingCategories: {
    paddingInline: 'var(--spacing-3)',
  },
  /** 分類籤那一排放不下就折行(手機);桌機放得下,這條不會動到它 */
  categoryChips: {
    flexWrap: 'wrap',
  },
  /** 檔案預覽面板退場時的分隔把手(見畫 `ResizeHandle` 的地方);時間 = 面板退場 */
  panelHandleLeaving: {
    opacity: 0,
    pointerEvents: 'none',
    transition: 'opacity var(--duration-fast-max) var(--ease-standard)',
  },
  /**
   * 卡片自己再淡入 + 輕微回彈 —— 讓它們看起來是「落定」而不是「被切出來」。
   *
   * ⚠️ **範本的 `gap={6}` 變成這一層的上內距**,兩個位置都不能放:
   *  - 留在外層 `VStack` 的 `gap` 上:gap 不管子項是不是零高,收起來時那 24px 還在;
   *  - 放在 `growStyles.clip` 上:**`min-height: 0` 夾不掉 padding**
   *    (padding 不受高度限制),收起來仍有 24px。
   * 放在被夾的**內容**上才會跟著一起收掉(收起來 0px)。
   * 展開後的長相與範本一模一樣。
   */
  suggestionsFade: {
    paddingBlockStart: 'var(--spacing-6)',
    opacity: 0,
    /* ⚠️ reduce 下把 `scale` 設成 1(不是不管它):縮放是位移類,標準要求拿掉,
       但**淡入要留著** —— 它是有助理解的那一半。起點也要明寫,`none` 補間建不起來。 */
    scale: {default: '0.94', '@media (prefers-reduced-motion: reduce)': '1'},
    /* 縮放的原點對齊殼長的方向:殼是從上往下長、分類籤靠左,
       預設的中心原點會讓卡片往正中間收,跟殼的方向打架。 */
    transformOrigin: 'top left',
    transition: {
      default:
        'opacity var(--duration-fast) var(--ease-standard), scale var(--duration-fast) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)':
        'opacity var(--duration-fast) var(--ease-standard)',
    },
  },
  suggestionsFadeShown: {
    opacity: 1,
    scale: '1',
    /* 延遲 **40ms**:動態島的關鍵順序是「殼先開、東西才落定」,一起跑看起來
       就只是一塊東西整個變大。40 落在一般 stagger 區間(30–80ms)裡。
       ⚠️ **延遲不能大於殼的一成多**,不然殼都開完了卡片才起跑,
       看起來就是「空了一塊再補上」。殼的時間改了,這裡要跟著改。 */
    transition: {
      default: 'opacity 180ms 40ms var(--ease-standard), scale 220ms 40ms var(--ease-overshoot)',
      '@media (prefers-reduced-motion: reduce)':
        'opacity var(--duration-fast) var(--ease-standard)',
    },
  },
  /**
   * 頭像的**幾何**(真的那顆與隱形佔位共用一份)。
   *
   * 頭像整顆掛到內容欄**外面**:自己的提問沒有頭像,AI 的內容若被頭像
   * 往右推一格,兩邊的左緣對不上。
   * 做法是用負的 start 邊距把頭像整顆拉出內容欄,內容欄回到跟提問同一條左緣,
   * 頭像懸在左邊的留白裡;end 只留 8px 給泡泡(值是量出來的,見下)。
   * ⚠️ 兩個邊距都從 `AVATAR_PX` 推,改尺寸不要另外動這裡。
   * ⚠️ **兩顆共用這一份**:各寫一份、靠註解提醒「spacer 也要同步」遲早會漏,
   * 漏了兩則訊息就會歪掉。
   */
  avatarBox: {
    width: AVATAR_PX,
    height: AVATAR_PX,
    flexShrink: 0,
    marginInlineStart: -(AVATAR_PX - 4),
    /*
     * ⚠️ **+8,不是負值**。
     *
     * 這一格的實際行為是:頭像那一欄的寬度 = `AVATAR_PX + start + end`(夾在 0
     * 以上),泡泡就接在欄的右緣。給負值讓欄寬變成 0 的話,**AI 的泡泡會落在
     * 它自己頭像的右緣再往左 4px** —— ghost 沒底色所以看不出來,但同事那則是
     * filled 泡泡,同樣的幾何就變成「大頭貼跟對話框擠在一起」。
     *
     * +8 讓欄寬變成 12,泡泡退到頭像右緣外 8px;兩種訊息的頭像與泡泡落在同一位置。
     *
     * ⚠️ **不要靠「把頭像往左移」來讓出空間**:`astryx-chat-layout` 是
     * `overflow-x: hidden`,頭像再往左就會被裁掉一塊。
     */
    marginInlineEnd: 'var(--spacing-2)', // = 8px(見上面)
  },
  /** 看得見的那顆:黑底白圖(走 accent 那組 token,深色佈景自己翻面) */
  assistantAvatar: {
    borderRadius: 'var(--radius-full)',
    backgroundColor: 'var(--color-accent)',
    color: 'var(--color-on-accent)',
  },
  /** 工具時間軸那一則的佔位頭像:同一份幾何,只是看不見 */
  assistantAvatarSpacer: {
    visibility: 'hidden',
  },
  /**
   * 進行中那塊工具時間軸放大一級(見它的使用點)。
   *
   * ⚠️ 用相對單位不是寫死 px:字級是使用者可能會調的東西(字級拉桿),
   * 寫死的話那一塊會在別人放大字體時變成唯一沒跟著長的區域。
   */
  runningToolCalls: {
    fontSize: '1.15em',
  },
  /**
   * 執行過程那一塊跟答案的第一行對齊;往下 10px 是對著畫面調的值,
   * 不是 token 湊出來的設計值。
   */
  toolIndent: {
    /*
     * 左緣**貼齊答案的第一個字**。
     * ghost 泡泡的內距是 16px,所以這裡也是 16px —— 不要再加額外的右移。
     */
    paddingInlineStart: 'var(--spacing-4)',
    paddingInlineEnd: 'var(--spacing-4)',
    marginBlockStart: '10px',
    /*
     * 垂直位移是對著畫面調的值(往下貼近答案)。
     * 用 translate 不用 margin:margin 會把下面的答案一起推走。
     */
    translate: '0 4px',
    width: '100%',
  },
  /** 答案底下那排動作(複製 / 存筆記)與答案第一行對齊 —— 泡泡有 16px 內距,這排沒有 */
  actionIndent: {
    paddingInlineStart: 'var(--spacing-4)',
  },
  /*
   * 提問底下那排(時間/複製/修改)**貼齊泡泡的右緣**。
   * ChatMessageBubble 的 metadata 插槽自己還有 16px 的側邊內距(metadataPadding),
   * 要用負邊距抵掉,右緣才真的落在泡泡邊上。
   */
  metaFlushEnd: {
    marginInlineEnd: 'calc(var(--spacing-4) * -1)',
  },
  /** 提問泡泡照輸入時的換行顯示(見 QuestionText) */
  questionLines: {
    whiteSpace: 'pre-wrap',
  },
  /**
   * 附件通知:貼在輸入框的**右外側**、靠底對齊。
   * 錨在 composer 那層 Stack 上(它是 relative),跟著輸入框走。
   * 疊法:欄位由上往下排、整欄錨在底部 —— 新的一張出現在最下面,
   * 舊的被往上推(依序疊上去)。pointerEvents none:通知不擋滑鼠。
   * ⚠️ 視窗不夠寬放不下右側那條時會被 ChatLayout 裁掉 —— 接受:
   * 通知是輔助回饋,抽屜裡的縮圖才是事實。
   */
  noticeStack: {
    position: 'absolute',
    insetInlineStart: '100%',
    marginInlineStart: 'var(--spacing-3)',
    insetBlockEnd: 0,
    width: 236,
    pointerEvents: 'none',
    zIndex: 1,
  },
  /**
   * 「Thinking…」那一行要跟頭像**水平對齊**:頭像與文字都貼訊息頂端,
   * 文字行高比頭像矮,給等高的最小高度再垂直置中,中線才疊在一起。
   */
  thinkingRow: {
    minHeight: AVATAR_PX,
  },
  /** 聊天欄:側欄打開時要縮得動(flex 子項的 min-width 預設是 auto) */
  chatColumn: {
    minWidth: 0,
  },
  /**
   * 續問頁的輸入框陰影升一階,不然跟背景融在一起。
   *
   * ⚠️ 走 `ChatComposer` 的 **`xstyle`**,不要用 `> :first-child` 之類的
   * 結構選擇器:子層順序是
   * `[status-top?] [drawer?] [body]`,drawer 一出現(附件、或
   * 「會通知誰」提示)第一個子層就換人 —— 陰影會落在那塊透明的殼上,
   * 而 @ 一個同事正好會開 drawer,等於這條在最常見的流程裡自己失效。
   * `xstyle` 是設計系統開放給 body 的插槽(它跟 elevation
   * 疊在同一個 stylex.props 裡,而且排最後所以贏),沒有任何位置假設。
   * ⚠️ 公開的 `elevation` prop 只收 `'none' | 'low'`,拿不到 high,
   * 所以這一階只能自己給。
   */
  composerRaised: {
    boxShadow: 'var(--shadow-high)',
  },
  /**
   * 「會通知誰」的常駐提示 —— field status 形。
   * 短暫的 info 卡(notify,跟附件通知同一疊)是另一件事,兩個並存:
   * 卡講「剛剛發生」(@ 到了誰),這條講「送出時會發生什麼」。
   *
   * 幾何照抄 ChatComposer 的 statusTop(貼著輸入框上緣、只圓上面兩角、
   * 負邊距塞進去),顏色是藍色那組成對 token(跟 @ token 同組)。
   * ⚠️ 半徑用公開的 `--radius-chat`:這條畫在 ChatComposer 外面,
   * 它的私有變數在這裡讀不到(讀不到會退回 0,弧就沒了)。
   */
  notifyHint: {
    position: 'relative',
    zIndex: 0,
    backgroundColor: 'var(--color-background-blue)',
    color: 'var(--color-text-blue)',
    paddingInline: 'var(--spacing-4)',
    paddingBlockStart: 'var(--spacing-3)',
    paddingBlockEnd: 'calc(var(--spacing-3) + var(--radius-chat))',
    // ⚠️ 塞進輸入框上緣的負邊距在外殼上(見 `tuckShell`)
    borderStartStartRadius: 'var(--radius-chat)',
    borderStartEndRadius: 'var(--radius-chat)',
  },
  /** 提示文字繼承橫幅的藍(Text 自己會下 primary,要指回來) */
  notifyHintText: {
    color: 'inherit',
  },
  /**
   * 「塞進輸入框上緣底下」的那種殼:「會通知誰」的藍條與附件抽屜共用。
   *
   * 藍條的出現 / 收起:跟附件抽屜同一組 `growStyles`(`components/growShell.ts`),
   * 不然放進第一個 @ 時約 44px 的藍條一格冒出來、輸入框被推;刪掉又一格縮回。
   *
   * ⚠️ **負邊距要在這一層,不能留在藍條上**:藍條在 `growStyles.clip`(`overflow: hidden`)
   * 裡面,它自己的負下邊距會讓 clip 的高度少算 `--radius-chat`,底下那段圓角
   * 被切掉 —— 而那段正是要塞進輸入框上緣底下的部分。
   * ⚠️ 負邊距**也要跟著殼一起過場**:收起來時殼高 0,邊距還是負的話輸入框會被
   * 往上拉一個半徑 —— 等於沒有 @ 的時候也在吃版面。所以收起 0、展開才負,
   * `transition` 把 `margin-block-end` 跟 `grid-template-rows` 綁同一組時間與曲線
   * (蓋掉 `growStyles.shell` / `.open` 的同名屬性,數值照抄那兩條)。
   *
   * **附件抽屜也用這兩條**。
   * `ChatComposerDrawer` 自己也是靠負下邊距塞進輸入框底下,包進 clip 之後同樣被切掉:
   * 灰塊底部變一條直線,輸入框兩個上圓角後面露白。抽屜自己的負邊距用 `drawerNoTuck` 歸零,改由殼來塞。
   */
  tuckShell: {
    marginBlockEnd: 0,
    transition: {
      default:
        'grid-template-rows var(--duration-fast-max) var(--ease-standard), margin-block-end var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  tuckShellOpen: {
    marginBlockEnd: 'calc(-1 * var(--radius-chat))',
    transition: {
      default:
        'grid-template-rows var(--duration-medium-min) var(--ease-panel), margin-block-end var(--duration-medium-min) var(--ease-panel)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  /** 附件抽屜自己的負下邊距歸零 —— 改由外殼塞(見上面 `tuckShell` 的說明) */
  drawerNoTuck: {
    marginBlockEnd: 0,
  },
  /**
   * 輸入框底下那排選項鈕(@ / 附件 / Files / 模型)的**容器**。
   *
   * ⚠️ 這一條是手機版的修正:不加的話那排鈕(專案、模型等)會被擠出框外面。
   *
   * 根因在設計系統:`ChatComposer` 的 footer 是
   * `[footerLeft] ... [footerRight(送出鈕)]`,而 `footerLeft` 是一個
   * **不換行、也沒有 min-width:0** 的 flex 容器(src/Chat/ChatComposer.tsx)。
   * 於是那排鈕的自然寬度一超過畫面,它既不折也不縮 —— 「Files (3)」、
   * 專案名稱、「Opus」就一路溢出到框線外面。
   * 桌機看不出來(820 的內容欄放得下),375 寬的手機必定溢出。
   *
   * 修法是在**我們自己這一層**補上那兩件事:`flexWrap` 讓它折行、
   * `minWidth: 0` + `flexShrink` 讓 `footerLeft` 可以縮到「最寬那一顆」為止
   *(換行容器的 min-content 寬就是最寬的那一顆)。
   * ⚠️ 不要改成把長標籤截字或在窄螢幕隱藏專案/模型 —— 那兩顆在手機上
   * 也要看得到,折到第二行才是要的結果。
   */
  composerActions: {
    /*
     * ⚠️ 排列方向與換行**交給 `HStack` 的 prop**(`wrap="wrap"`),這裡只補
     * 設計系統沒有開放的兩條。不要改用 `Stack` 再自己下 display/flexWrap:
     * `Stack` 預設是**直排**、direction 的樣式比 xstyle 晚套 —— 那排鈕
     * 會整個變成一直行,整個輸入框跑版。
     */
    minWidth: 0,
    flexShrink: 1,
  },
  /**
   * 從筆記「回到對話」還沒跳到那一題之前,訊息先不畫出來(見 jumpToQa 那段):
   * 不藏的話使用者先看到最底下那幾題、然後整片往上跳。
   * 用 visibility 不用 display:版面照樣排,才捲得過去。
   */
  jumpPending: {visibility: 'hidden'},
  /** 訊息串跟空白頁、輸入框同寬 */
  messageWidth: {
    width: '100%',
    maxWidth: CONTENT_WIDTH,
    marginInline: 'auto',
    /*
     * 頭像掛在內容欄外面(見 avatarBox)。寬的時候(側邊欄收起)訊息區比輸入框多一層 16 的內距,
     * 頭像落在輸入框左緣往內 4px —— 那是對的比例。窄的時候(側邊欄展開,ChatLayout 不到 CHAT_AREA_MAX_PX)
     * 那 16 沒了,頭像凸到輸入框外面、離側邊欄只剩 4px。所以少掉多少就往右補多少,頭像永遠在輸入框左緣往內 4px。
     * 100cqi 是 ChatLayout 的寬(設計系統把它設成 inline-size 容器);兩邊的差 = (寬 − 最寬) / 2,夾在 0~16
     */
    paddingInlineStart: `clamp(0px, calc(${CHAT_AREA_PAD_PX}px - (100cqi - ${CHAT_AREA_MAX_PX}px) / 2), ${CHAT_AREA_PAD_PX}px)`,
  },
  composerWidth: {
    width: '100%',
    maxWidth: CONTENT_WIDTH,
    marginInline: 'auto',
    marginBlockEnd: 'var(--spacing-3)',
    // 附件通知的定位錨(noticeStack 是 absolute,疊在這層的正上方)
    position: 'relative',
  },
  /*
   * 提問底下那排(時間 + 複製 + 修改重問)的顯示/隱藏在 global.css 的
   * `[data-hover-reveal]`:開關是**整則訊息**的 :hover / :focus-within,
   * StyleX 寫不出「父層 hover 時改子孫」的規則。用 opacity 藏而不是條件渲染:
   * 條件渲染的話鍵盤使用者永遠 Tab 不到那幾顆鈕。
   */
});

/** 範例卡的最小寬 —— Grid 靠它決定一排幾張(範本用 280)。 */
const SUGGESTION_MIN_WIDTH = 280;

/**
 * 「這則會通知誰」那一行(`describeNote`)。
 * 附件也要講 —— 便條的附件是給**被 @ 的人**看的(截圖、要對方確認的檔案),
 * claude 讀不到,所以不能讓人以為附件是給 AI 的。
 */
/**
 * 還沒問過任何一題就想 @ 人。
 * 後端也會擋(`notes.py` 的 400),但它的 detail 會被 catch 吞掉,
 * 而且那句話只有在**送出之後**才看得到。
 */
const NOTE_NEEDS_CHAT =
  'This chat has no messages yet — ask a question first, then @ a colleague.';

function describeNote(names: string[], fileCount: number): string {
  const who = names.map(personName).join(', ');
  const attached = fileCount > 0 ? ` with ${fileCount} file${fileCount === 1 ? '' : 's'}` : '';
  return `This will notify ${who}${attached} — it is not sent to the assistant.`;
}




/** 進行中最多列幾步。 */
const RUNNING_STEP_LIMIT = 15;

/** 答案超過這麼久沒長新字、又沒有工具在跑,就在下面補一行 Thinking…(見 PendingTurn 的 showThinking) */
const THINKING_QUIET_MS = 1500;

/** 不斷行空白。寫成跳脫是因為字面上的 NBSP 在原始碼裡看起來跟一般空白一模一樣 */
const NBSP = ' ';

/**
 * 觸控裝置上 **Enter 是換行**,送出只走送出鈕。
 *
 * 設計系統的輸入框 Enter 一律送出、Shift+Enter 換行 —— 手機的虛擬鍵盤沒有 Shift,
 * 等於整串只能打一行。這裡走它開放的 `onKeyDown` 那一格:先 `preventDefault()`
 * 把內建的送出攔掉,再自己插一個換行(`insertLineBreak` = Shift+Enter 插的那個 `<br>`,
 * 會觸發 input,序列化後就是 `\n`)。
 *
 * 判準是 `HOVER_QUERY`(有沒有真正的滑鼠),不是寬度:窄的桌機視窗照樣有實體鍵盤,
 * Enter 送出是它的習慣;接了觸控板的平板會被判成有滑鼠,也是照桌機。
 * ⚠️ 選字中的 Enter 不碰(`isComposing` / 229)—— 那是輸入法在確認候選字。
 */
function newlineOnTouchEnter(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
  if (window.matchMedia(HOVER_QUERY).matches) return;
  e.preventDefault();
  document.execCommand('insertLineBreak');
}

/**
 * 一則回答的內容 —— 結論直接顯示,「追查依據」摺起來。
 *
 * 為什麼要摺:多數讀者只要結論,但那些檔案與行號對接手要改的工程師
 * 恰恰是最有用的。所以不砍,收進來(切法見 lib/answerSections)。
 *
 * ⚠️ **串流中就切,標題一出現就收**:不然整段依據先攤開、答完才被收走。
 * 串流中用 `splitStreamingAnswer`:送到一半的 `#` 行先不顯示
 * (可能是半個標題),標題完整了之後的內容直接進摺疊區,上半段從頭到尾都不會露出依據。
 *
 * ⚠️ **memo 過的,不要拿掉**(效能):`<Markdown>` 每次 render 都要
 * 重新解析整段文字,而答完的那些答案在串流期間**一個字都沒有變**。
 * 沒有 memo 的話,正在跑的那一題每送來一個 delta,上面所有答完的答案
 * 都會跟著重新解析一次 Markdown。
 * `text` / `isStreaming` 是原始型別,預設的淺比較就夠用,不必自己寫 `areEqual`。
 */
const AnswerContent = memo(function AnswerContent({
  text,
  isStreaming = false,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  /*
   * ⚠️ **不要包 `useMemo`**:這個元件已經 memo 過了,
   * props 沒變根本不會重跑到這裡;變了就一定要重算。那層 `useMemo`
   * 永遠命不中,只是多一次相依比較。
   */
  // 串流中:依據邊收邊長。答完:照完整的規則切。
  const {body, evidence} = isStreaming ? splitStreamingAnswer(text) : splitAnswer(text);

  // 串流中一律走下面那條(就算還沒出現依據):上半段要用切過的 body,
  // 不然送到一半的 `## 追查…` 會先閃出來。
  // 上半段走 AnswerMarkdown;追查依據是給工程師的原文(SQL、底層資料),照原樣放在下面的摺疊區。
  if (!isStreaming && !evidence) return <AnswerMarkdown text={text} />;

  return (
    <VStack gap={2} width="100%">
      <AnswerMarkdown text={body} isStreaming={isStreaming} />
      {/*
       * 預設摺起來:多數讀者要的答案在上面那段已經講完了。
       * trigger 的字要讓人一眼知道「這不是給我看的」——「追查依據」就是這個作用。
       * 串流中標題一出現就放摺疊區(內容可能還是空的,邊收邊長)。
       * 外面包一層 Card:不包的話展開之後依據跟答案同字級、同底色,看不出答案在哪裡結束。
       * Card + Collapsible 是 Astryx 文件建議的組合;用預設的白底細框(淺灰底會讓程式碼標籤糊掉)。
       */}
      {evidence !== null && (isStreaming || evidence) ? (
        <Card padding={3} width="100%">
          <Collapsible trigger="追查依據" defaultIsOpen={false}>
            <Markdown>{evidence}</Markdown>
          </Collapsible>
        </Card>
      ) : null}
    </VStack>
  );
});

/** 這幾種工具的 target **不是路徑**,不要照斜線切最後一段(會把查詢字串切爛)。 */
const WHOLE_TARGET_TOOLS = new Set(['Bash', 'WebSearch', 'Task']);

/** Bash 只取第一個指令名,路徑只留檔名。 */
function shorten(source: {tool: string; target: string}): string {
  if (source.tool === 'Bash') return source.target.split(/\s+/)[0];
  if (WHOLE_TARGET_TOOLS.has(source.tool)) return source.target;
  const parts = source.target.split(/[\\/]/);
  return parts[parts.length - 1] || source.target;
}

type ToolCall = {
  name: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  target?: string;
  duration?: string;
  errorMessage?: string;
};

/**
 * 已經跑完的那一題的執行過程。
 *
 * ⚠️ **耗時要算得出來**:設計系統的 `ChatToolCalls` 每一步都有 duration。
 * 後端的 `sources` 每一步存**工具真正的耗時** `duration_ms`(模型寫完這通呼叫 → 結果回來),有就用它。
 * 沒有這個欄位的紀錄才退回推算:中間幾步 = 相鄰兩筆 `at_ms` 相減,
 * 最後一步 = 整題的 `duration_ms` 減掉它(規則在 time.ts 的 `stepDurationMs`)。
 *
 * ⚠️ 退回推算時,往後看下一筆要看**完整的陣列**,不是切過的 —— 切在第 6 筆時,
 * 第 6 步的結束點是第 7 步的開始,不是整題的結束。
 * ⚠️ 連 `at_ms` 都沒有的紀錄就不畫耗時。**不要用 0 頂替**:
 * 那會把每一步都算成「從頭到現在」,畫出一排假的秒數。
 */
function toToolCalls(
  sources: ParsedSource[],
  limit: number,
  totalMs?: number | null,
): ToolCall[] {
  return sources.slice(0, limit).map((source, i) => {
    // 有工具真正的耗時就用它;沒有才退回相鄰兩步相減(理由見 time.ts 的 stepDurationMs)
    const ms = stepDurationMs(source.duration_ms, source.at_ms, sources[i + 1]?.at_ms ?? totalMs);
    return {
      name: toolLabel(source.tool),
      status: 'complete' as const,
      target: shorten(source),
      duration: ms === undefined ? undefined : formatStepDuration(ms),
    };
  });
}

/**
 * 進行中那一題的執行過程。
 *
 * 耗時:工具結果回來了(`source_duration`)就是**工具真正的耗時**;還沒回來的那一步
 * 算到現在(`now`)。沒有 `source_duration` 時,中間幾步退回「下一步的 `at` − 這一步的 `at`」。
 * 算不出來就留空,不要用 0 頂替。
 *
 * 狀態與耗時都是 `ChatToolCalls` 自己的 prop,不要另外畫一套 ——
 * 那顆轉圈的 spinner、error 的紅圈、耗時靠右,都是它內建的。
 */
function runningToolCalls(
  sources: RunSource[],
  now: number,
  failure?: string | null,
): ToolCall[] {
  /*
   * ⚠️ 取**最後** 15 步,不是最前 15 步。一題 3~15 分鐘很容易超過 15 步 ——
   * 取頭的話第 16 步起使用者就再也看不到新動作,而且第 15 步會被永遠標成
   * running、耗時無限增長。進行中的人要看的是「它現在在做什麼」。
   */
  const shown = sources.slice(-RUNNING_STEP_LIMIT);
  return shown.map((source, i) => {
    const isLast = i === shown.length - 1;
    // 工具結果還沒回來的一步,耗時算到現在(還在跑);沒有真正的耗時的話,中間幾步算到下一步開始
    const waitsForResult = !failure && !!source.toolUseId && source.durationMs === undefined;
    const endedAt = isLast || waitsForResult ? now : shown[i + 1].at;
    const ms = stepDurationMs(source.durationMs, source.at, endedAt);
    return {
      name: toolLabel(source.tool),
      status: runningStepStatus(source, isLast, failure),
      target: shorten(source),
      duration: ms === undefined ? undefined : formatStepDuration(ms),
      errorMessage: isLast && failure ? failure : undefined,
    };
  });
}

export default function Chat() {
  const {id: routeId} = useParams();
  const navigate = useNavigate();
  const me = useMe();

  /*
   * 設定、歷史、檔案清單的**初值從快取拿**(`lib/chatApi.ts` 的 peek*)。
   * 這一頁每換一組對話都重掛;從空的開始等 API 的話,專案 / 模型按鈕、這組對話的專案名、
   * Files (N) 都要等一趟來回才對,而 New chat ↔ 對話的過場拍終點畫面用的正是掛上的第一格:
   * 過場演完它們才陸續換上,輸入框底下那排按鈕會整排位移。
   * 有快取就先畫快取,底下的 effect 照樣重抓,拿到新的就換。
   */
  const [config, setConfig] = useState<AppConfig | null>(peekConfig);
  const [turns, setTurns] = useState<HistoryItem[]>(() => (routeId ? peekConversationTurns(routeId) : null) ?? []);
  /**
   * 這一頁是在哪一次 New chat ↔ 對話過場裡掛上的(沒有就是 null)。**只放行那一次**
   *(見 `lib/chatTransition.ts` 的 `currentChatMorph`:舊頁的資料晚到時不能把下一次過場放掉),
   * 也用來決定要不要再演自己的進場淡入(過場自己就在淡入,見 `landingEntry`)。
   */
  const [morphIn] = useState(currentChatMorph);
  /** 掛上那一刻設定就在快取裡 → 真的招呼語是跟著這一頁一起掛上的(見 `greetingEntry`) */
  const [hadConfigAtMount] = useState(() => peekConfig() !== null);
  /** 這一頁是換功能頁換過來的(`lib/pageSwap.ts`):內容區那一層已經在淡入,自己的進場淡入不再疊一層 */
  const [swappingIn] = useState(isPageSwapping);
  /**
   * 這組對話的歷史**抓回來了沒**。
   *
   * ⚠️ 不能用 `turns.length === 0` 代替,不然點歷史對話時會先閃一下新對話的畫面。
   * 換對話時 `App` 會用 `key` 重新掛載這一頁,`turns` 從空陣列開始 —— 而「空的」在畫面上就是**新對話
   * 的置中版面**(招呼語 + 大輸入框)。歷史要等一支請求回來才有,那幾十毫秒裡
   * 使用者看到的就是一閃而過的新對話。
   *
   * 新對話(沒有 routeId)一開始就是 true:它本來就沒有歷史要等。快取裡已經有這組的歷史也是 true
   *(上面 `turns` 的初值就是那一份)。
   */
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(() => !routeId || peekConversationTurns(routeId) !== null);
  /**
   * 這組對話**向伺服器**讀完一次了沒(成功失敗都算)。跟 isHistoryLoaded 不同:快取先畫出來的那份不算 ——
   * 「回到對話」要靠它判斷「真的沒有那一題」(快取是舊的、還沒有那一題時,要等重抓回來)。
   */
  const [fetchedHistoryOf, setFetchedHistoryOf] = useState<string | null>(null);
  /** 這組對話的檔案清單抓回來了沒(快取裡有也算)。只拿來決定過場什麼時候拍終點,見 `isReadyForMorph` */
  const [isFilesLoaded, setIsFilesLoaded] = useState(() => !routeId || peekConversationFiles(routeId) !== null);
  const [draft, setDraft] = useState('');
  /**
   * 這組對話裡**主動選**的模型。`null` = 沒選過,依序退回:這個環境的預設模型
   * (`knowledge_bases.json` 的 `default_model`,例如某個環境固定用 Sonnet)→ 個人設定的「常用模型」
   * → 後端的 `default_model`。優先序只有一份,在 `lib/modelPref.ts` 的 `pickModel`。
   *
   * ⚠️ **選過就記住,而且是記在「這組對話」上** —— 重新整理回到這組對話仍然是他選的那個,
   * 但**開新對話會回到個人常用**。初始值直接從那張表讀,不必等 effect:
   * 晚一輪的話輸入框上那顆鈕會先閃一下個人常用的名字。
   *
   * ⚠️ 記的地方**不是**個人常用模型那個 key(`lib/modelPref.ts` 的 `KEY`)。寫進去的話
   * 「這一組臨時換一下」會變成「以後每一組都用這個」。
   */
  const [modelChoice, setModelChoice] = useState<string | null>(() =>
    conversationModelOf(routeId),
  );
  /**
   * 這組對話裡**主動選**的專案。換對話時不必自己清:`App.tsx` 的 ChatRoute 用對話 id 當 key,
   * 換一組對話整個元件就重新掛載了。
   */
  const [kbChoice, setKbChoice] = useState<string | null>(null);

  /** 換模型:已經有 id 的就當場記住;新對話沒有 id,留到送出那一刻補記。 */
  const chooseModel = (model: string) => {
    setModelChoice(model);
    if (conversationId) rememberConversationModel(conversationId, model);
  };
  /**
   * 個人常用的模型(`effectiveModel` 的其中一階)。
   * ⚠️ 常用模型走 `usePreferredModel()` 而不是直接讀 `lib/modelPref.ts` 的 `current` —— 它是
   * 模組層的變數,在個人設定裡換掉之後這一頁不會重繪(理由寫在 `lib/modelPref.ts`)。
   */
  const preferredModel = usePreferredModel();
  // ⚠️ effectiveModel 本身在下面才算:它要看「這個環境的預設模型」

  /**
   * 可以 @ 的同事。**走共用的 `peopleDirectory`**,這一頁不
   * 自己抓一份(那會是第二份名冊、第二支請求,而且跟側邊欄解析出來的名字會不一樣)。
   *
   * `usePeopleDirectory()` 兼兩件事:第一次掛載時觸發抓取,以及名冊變動
   * (載完、或自己換了頭像)時讓這一頁重畫。
   */
  // ⚠️ 回傳值**要接起來傳進 `Turn` / `NoteBubble`**,理由見 `TurnProps.peopleVersion`
  const peopleVersion = usePeopleDirectory();
  const mentionable = mentionablePeople();
  /**
   * 同事名單**抓失敗**了。
   *
   * ⚠️ 不能只看 `mentionable.length === 0` —— 抓失敗跟「公司只有你一個」
   * 長得一模一樣。分不出來的話,「@ming 你看一下」會整句送進 AI,
   * 而使用者以為喊了人。
   */
  const mentionableFailed = peopleDirectoryFailed();
  /** 這組對話裡的便條。跟問答混在同一條訊息串裡,依時間排。 */
  const [notes, setNotes] = useState<NoteItem[]>([]);

  /**
   * 輸入框的附件。三種來源、縮圖、上限、拖曳遮罩全在 hook 裡。
   */
  const upload = useComposerAttachments(config?.max_upload_mb ?? 0);
  /*
   * 附件抽屜畫的那一份(見輸入框的 `drawer`)。最後一個檔案被拿掉時抽屜要**收回去**,
   * 收的那 165ms 裡 `upload.files` 已經是空的 —— 留著最後一份非空的清單給它演完。
   * `drawerEpoch`:每次從「沒有附件」變成「有附件」加一,當抽屜的 key。
   * 兩個都用「render 期間依前一次的值更新 state」的寫法(React 文件的
   * storing information from previous renders),不用 effect —— effect 會晚一格,
   * 第一個檔案進來的那一格抽屜是空的。
   */
  const [drawerFiles, setDrawerFiles] = useState<{files: File[]; previews: (string | null)[]}>({
    files: [],
    previews: [],
  });
  /** 附件通知堆疊的 FLIP(見畫通知的地方) */
  const flipNotice = useFlip<AttachmentNotice['id']>([upload.notices]);
  const [drawerEpoch, setDrawerEpoch] = useState(0);
  const [lastFileCount, setLastFileCount] = useState(0);
  if (upload.files.length !== lastFileCount) {
    if (lastFileCount === 0) setDrawerEpoch((n) => n + 1);
    setLastFileCount(upload.files.length);
  }
  if (upload.files.length > 0 && (upload.files !== drawerFiles.files || upload.previews !== drawerFiles.previews)) {
    setDrawerFiles({files: upload.files, previews: upload.previews});
  }

  /*
   * 挑好、還沒送出的附件也算「做到一半的東西」。
   *
   * ⚠️ 它只活在上面那個 hook 的 state 裡 —— `lib/unsavedWork.ts` 掃 DOM 看不到,
   * 因為 `<input type="file">` 的 `value` 在這種情況下仍然是空字串。不登記的話,
   * 上版後的自動重整(`lib/appVersion.ts` 的第②段)會在他切去別的分頁時
   * 把挑好的檔案清掉,而他回來只會看到附件不見了。
   *
   * 用 ref 讀最新的清單,登記本身只做一次:查詢函式的身分要穩定,
   * 每次 render 都重新登記會讓 Set 一直換內容。
   */
  const uploadFilesRef = useRef(upload.files);
  uploadFilesRef.current = upload.files;
  useEffect(() => registerBusySource(() => uploadFilesRef.current.length > 0), []);

  /**
   * 「修改重問」與「點一則範例問題」都要把文字放回輸入框**並聚焦**。
   *
   * ⚠️ 輸入框**不是 `<textarea>`** —— `ChatComposerInput` 是一顆
   * `contenteditable` 的 div(token 化的輸入靠它)。所以不能用
   * `querySelector('textarea')` 去找它(那樣會找到別的元件的欄位,
   * 而且永遠聚焦不到),要走它自己開放的 `handleRef.focus()`。
   */
  const composerInputRef = useRef<ChatComposerInputHandle>(null);
  /** 輸入框那一塊的外框 —— 只拿來找裡面那顆 contenteditable(見 normaliseTokenSpacing) */
  const composerBoxRef = useRef<HTMLElement>(null);
  /**
   * Pending 是就地修改的同一個物件,參照永遠不變 —— 串流每來一個事件就靠
   * 這個計數器強制重繪,少了它整題只看得到「思考中」。計數器的**值**
   * 沒有人讀(小夥伴自己訂閱 runs.ts,不靠這裡)。
   */
  const [, bumpStream] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeAll(bumpStream), []);

  /*
   * 檔案拖到**輸入框以外**的地方放開,瀏覽器預設會直接導覽過去開那個檔 ——
   * 整頁被換掉,連同正在跑的那一題。所以 `window` 層另外
   * `preventDefault` dragover/drop。
   *
   * ⚠️ 只擋**帶檔案**的那種:一般的文字拖曳(選字拖到別處、拖連結)
   * 照常運作,擋掉會把瀏覽器本來的行為弄壞。
   * 輸入框那一塊自己還有一組 handler(遮罩與 addFiles),它會先收到,
   * 這裡是最後一道。
   */
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const block = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  /*
   * Shift+點擊訊息區不要拉出範圍選取。
   *
   * 清單層是 `user-select: none`、泡泡開回 text ——
   * 但 Shift+點擊是瀏覽器的「從上一個插入點延伸選取」,起點若落在泡泡裡,
   * 終點那一下仍會把中間整塊反白框起來。在 mousedown 就擋掉(只擋帶著
   * Shift 的那一種):一般點擊、拖曳選字、雙擊選詞全部照舊。
   */
  useEffect(() => {
    const blockShiftSelect = (e: MouseEvent) => {
      if (!e.shiftKey || e.button !== 0) return;
      const target = e.target;
      if (target instanceof Element && target.closest('.astryx-chat-message-list')) {
        e.preventDefault();
      }
    };
    document.addEventListener('mousedown', blockShiftSelect);
    return () => document.removeEventListener('mousedown', blockShiftSelect);
  }, []);

  const conversationId = routeId;
  /*
   * 存到筆記(`components/SaveToNotes.tsx`):這組對話存過哪幾題(書籤實心)+ 存的動作。
   * `notesSave.save` 參照穩定 —— 它是傳給 memo 過的 `Turn` 的 props(見下面 handleEdit 那段的警告)。
   */
  // 功能關著(後端 NOTEBOOK_ENABLED,預設開、.env 可以關):不查存過哪幾題(那支 API 也是 404),三個入口都不畫
  const notesSave = useSaveToNotes(me.can_notebook ? conversationId : undefined);
  /** 反白偵測只認這一塊裡面的提問 / 答案(對話區最外層那個 HStack) */
  const chatRootRef = useRef<HTMLDivElement>(null);
  /*
   * 不需要「送出新對話到網址更新之間」的備援 id:這一頁掛了 `key={conversationId}`,
   * 導頁的同一次 commit 就把這個元件換掉了。空窗的代價只剩
   * 「重掛前的那一個 frame 沒有 pending」,肉眼看不到。
   */
  const pending = getPending(conversationId);

  /*
   * 這一頁掛上了、**而且內容到位了** → 掛上時正在等的那一次 New chat ↔ 對話過場可以拍新畫面
   *(`lib/chatTransition.ts` 開頭講為什麼要等:換頁被 react-router 包在 startTransition 裡,
   * 不等的話拍到的還是舊畫面)。
   *
   * 「內容到位」= 設定、這組對話的歷史、檔案清單都有了:只等掛上的話,終點畫面是空殼 ——
   * 沒有專案 / 模型按鈕、專案名還是預設專案、Files (0),過場演完才換上,輸入框底下那排按鈕整排位移。
   * 通常一掛上就到位(初值都從快取拿,滑鼠移到側邊欄那一列時就先抓了);沒快取時最多等 `COMMIT_WAIT_MS`。
   *
   * ⚠️ **從空白頁送出第一句**(`pending` 已經有了)不等歷史:那組對話剛建,後端還沒有東西可抓,
   * 而那支 GET 跟送出的 POST 在賽跑 —— 等它的話每次送出畫面都凍住到逾時。
   * 畫面上要的(使用者剛打的那句、輸入框)`pending` 裡都有了。
   */
  const isReadyForMorph = config !== null && ((isHistoryLoaded && isFilesLoaded) || pending != null);
  useLayoutEffect(() => {
    if (morphIn !== null && isReadyForMorph) notifyChatCommitted(morphIn);
  }, [morphIn, isReadyForMorph]);

  // ── 設定 ───────────────────────────────────────────────────────────────
  useEffect(() => {
    void getConfig().then(setConfig, () => setConfig(null));
  }, []);

  // ── 進行中的題目:一載入就接回來 ───────────────────────────────────────
  // 只在已登入那一層跑(Chat 掛在 Chrome 底下,me 一定有值)—— 未登入時打這支必定 401,而 401 攔截器會清 token。
  useEffect(() => {
    void syncActiveRuns();
  }, [me.username]);

  // ── 歷史 ───────────────────────────────────────────────────────────────
  const pendingDone = pending?.done;
  const pendingFinalId = pending?.finalId;

  useEffect(() => {
    if (!conversationId) {
      setTurns([]);
      return;
    }
    let alive = true;
    void getConversationTurns(conversationId).then(
      (data) => {
        if (alive) setTurns(data);
      },
      (err: unknown) => {
        // 重抓失敗維持現狀,絕不清空 —— 清掉的話一次網路抖動就把整串對話洗白。
        // ⚠️ 例外是 404 / 403:這組對話已經不在、或已經沒權限看(被刪、被取消分享)。
        // 快取先畫出來的那份要清掉,不然已刪的內容一直留在畫面上。
        const status = (err as {response?: {status?: number}} | null)?.response?.status;
        if (alive && (status === 404 || status === 403)) {
          forgetConversation(conversationId);
          setTurns([]);
        }
      },
    ).finally(() => {
      // ⚠️ **成功失敗都要放行**(見 isHistoryLoaded):只在成功時放的話,一次抓失敗
      // 就會把畫面永遠停在空白,連新問題都沒地方打。抓失敗時該退回的是新對話的版面。
      if (alive) {
        setIsHistoryLoaded(true);
        setFetchedHistoryOf(conversationId);
      }
    });
    return () => {
      alive = false;
    };
    // 相依拆到欄位,不能放整個 pending(它的參照永遠不變)。
  }, [conversationId, pendingDone, pendingFinalId]);

  // ── 便條 ───────────────────────────────────────────────────────────────
  const reloadNotes = useCallback(async () => {
    if (!conversationId) {
      setNotes([]);
      return;
    }
    try {
      setNotes(await listNotes(conversationId));
    } catch {
      // 抓不到就維持現狀,不要把已經畫出來的便條洗掉
    }
  }, [conversationId]);

  /**
   * 重抓的時機。
   *
   * 兩個計數器都是「有事發生了」的訊號,不帶資料:
   * - `notesNonce` —— 側邊欄那邊有動靜(`CONVERSATIONS_UPDATED`),
   *   通常就是別人剛 @ 了我。少了它,**停在同一組對話時新進來的便條不會出現**,
   *   而那正是最需要看到它的時候。
   * - `focusNonce` —— 視窗重新拿到焦點。人回到電腦前的那一刻要看到最新的,
   *   同時也是 `markConversationRead` 的觸發點(離開電腦時不標已讀,見下)。
   */
  const [notesNonce, bumpNotes] = useReducer((n: number) => n + 1, 0);
  const [focusNonce, bumpFocus] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const onUpdated = () => bumpNotes();
    const onFocus = () => bumpFocus();
    window.addEventListener(CONVERSATIONS_UPDATED, onUpdated);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(CONVERSATIONS_UPDATED, onUpdated);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  /**
   * 便條重抓依賴**答完的題數**(`turns.length`)而不是 `displayTurns` ——
   * 後者串流時每個字都是新陣列,那會變成每個字重抓一次便條。
   * (`getConversationTurns` 回的本來就只有已完成的,長度就是題數。)
   */
  const finishedTurnCount = turns.length;
  useEffect(() => {
    void reloadNotes();
  }, [reloadNotes, finishedTurnCount, notesNonce]);

  // ── 檔案區 ─────────────────────────────────────────────────────────────
  const [fileGroups, setFileGroups] = useState<ConversationFileGroup[]>(
    () => (routeId ? peekConversationFiles(routeId) : null) ?? [],
  );
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  /** 燈箱現在攤開的那一條與位置;index 是 null 就是關著 */
  const [preview, setPreview] = useState<{items: LightboxItem[]; index: number | null}>({
    items: [],
    index: null,
  });

  /**
   * 重抓檔案清單的時機:
   * **答完一題**或**便條數變了**。兩種都會多出檔案 —— 產出的檔案跟便條的附件。
   *
   * ⚠️ 跟便條同一條理由:依賴 `finishedTurnCount` 而不是 `displayTurns`,
   * 後者串流時每個字都是新陣列,那會變成一題打幾千次這支 API。
   * ⚠️ 抓不到就維持現狀,不要清空 —— 清掉的話那顆按鈕會憑空消失,
   * 而使用者剛剛才看過那些檔案。
   */
  const noteCount = notes.length;
  useEffect(() => {
    if (!conversationId) {
      setFileGroups([]);
      return;
    }
    let alive = true;
    void listConversationFiles(conversationId)
      .then(
        (groups) => {
          if (alive) setFileGroups(groups);
        },
        () => {},
      )
      // 成功失敗都放行(同 isHistoryLoaded 的理由):只是過場等不等它而已
      .finally(() => {
        if (alive) setIsFilesLoaded(true);
      });
    return () => {
      alive = false;
    };
    /*
     * `pendingFinalId` 也是觸發條件(AI 還在答題時,使用者也要點得開自己上傳的檔案):後端在送出當下就把紀錄與上傳檔寫好了,start 事件一到
     * (拿到 finalId)就重抓,泡泡上那排附件在答題中就點得開,不必等答完。
     */
  }, [conversationId, finishedTurnCount, noteCount, pendingFinalId]);

  /**
   * 翻成畫面順序的那一份。**`Chat` 這一層算**,不是 `FilesDialog` 裡面算 ——
   * 訊息串裡的附件要開的是同一條 `strip`(左右切換走得遍整組對話)。
   */
  const fileView = useMemo(() => buildFileView(fileGroups), [fileGroups]);
  const fileCount = useMemo(() => countFiles(fileGroups), [fileGroups]);

  /**
   * 訊息串裡的附件要用的兩件事:**這個檔案在燈箱那條的第幾個**、以及**開它**。
   *
   * ⚠️ 兩個都要,不能只給一個 onClick:按鈕的圖示得**在按下去之前**就知道
   * 等一下會發生什麼事(開燈箱還是直接下載)—— 圖示對不上行為的話,
   * 點一顆下載箭頭卻跳出燈箱,看起來就是壞掉。
   * `indexOf` 回 -1 是正常狀態(清單還沒回來、壓縮檔、檔案已經不在了)。
   */
  /**
   * 桌機把檔案開在**右邊的側欄**(設計系統 `ai-chat` 範本的 artifact 面板),
   * 手機才退回全螢幕燈箱 —— 範本自己也是這樣分的(它量 root 寬度決定)。
   *
   * 側欄的意義在於「聊天欄留著」:對照著產出的文件問下一題是這類問題的常態,
   * 全螢幕的燈箱會把上下文整個蓋掉。
   */
  /*
   * ⚠️ 斷點不是「手機」而是**視窗夠不夠寬切兩欄**:側邊欄本身就吃掉 305,
   * 1014 寬的視窗切下去聊天欄只剩 188px —— 那比全螢幕的燈箱更難用。
   * 窄的時候退回燈箱,跟範本的分法一樣(它量 root 寬度決定開側欄還是 Dialog)。
   */
  const isNarrow = useMediaQuery(PANEL_BREAKPOINT);
  /** 手機版面:輸入框底下那排收成一行(模型只剩圖示) */
  const isMobile = useMediaQuery(MOBILE_QUERY);
  /*
   * 關掉要先演退場再卸載 —— 開 / 關 / 換頁都走這支 hook,
   * 不要直接 `setPanel(null)`(那會變成「進場有、關掉硬切」)。
   */
  const filePanel = useFilePreviewPanel();
  const {panel, open: openPanel} = filePanel;
  const panelResize = useResizable({
    // ⚠️ 用**百分比**不是固定 px:固定 520 在窄一點的視窗上會把聊天欄壓扁,
    // 而這個面板的重點正是「聊天欄還看得到」。
    defaultSize: PANEL_DEFAULT_WIDTH,
    minSizePx: PANEL_MIN_WIDTH,
    maxSizePx: PANEL_MAX_WIDTH,
    // 拉過的寬度記在 localStorage,不然每次打開都要重拉一次。
    autoSaveId: 't100_file_panel',
  });

  const attachments: Attachments = useMemo(
    () => ({
      indexOf: (kind, sessionId, name) => stripIndexOf(fileView.strip, kind, sessionId, name),
      open: (index) =>
        isNarrow
          ? setPreview({items: fileView.strip, index})
          : openPanel(fileView.strip, index),
    }),
    [fileView, isNarrow, openPanel],
  );

  /**
   * 串流中那一題的上傳附件(答題中也要點得開)。
   * pending 手上只有檔名沒有 session_id,但檔案清單重抓回來之後(見上面的
   * effect),那一題的列就在 `fileView` 裡 —— 用 finalId 對到那一組,
   * 拿它的 stripIndex / downloadUrl。清單還沒回來時回 null,Token 維持純標籤。
   */
  const resolvePendingUpload = useCallback(
    (name: string) => {
      if (!pendingFinalId) return null;
      const group = fileView.list.find((g) => g.anchorId === `turn-${pendingFinalId}`);
      const row = group?.rows.find((r) => r.name === name && r.file.kind === 'upload');
      if (!row) return null;
      return {index: row.stripIndex, downloadUrl: row.item.downloadUrl};
    },
    [fileView, pendingFinalId],
  );

  /**
   * 從檔案區跳到那一則。
   *
   * ⚠️ **先關彈窗再捲**:彈窗開著的時候背景是鎖住捲動的,先捲的話捲不動;
   * 而且設計系統的 Dialog 在關閉的同一刻會把焦點還給開啟它的那顆按鈕
   *(那個動作本身也會捲畫面),所以要等它做完 —— `requestAnimationFrame`
   * 排在那之後。
   */
  const jumpToTurn = useCallback((anchorId: string) => {
    setIsFilesOpen(false);
    /*
     * ⚠️ 用 `setTimeout(0)` 而**不是 `requestAnimationFrame`**:rAF 只有在
     * 頁面真的在合成畫面時才會跑 —— 分頁在背景、視窗被蓋住的時候一次都不會發,
     * 那時候「跳到這則」就完全沒有反應。一個 macrotask 就夠了:
     * 這裡等的只是「彈窗真的關掉、焦點也還回去了」。
     */
    setTimeout(() => {
      /*
       * 瞬移,**不要 `behavior: 'smooth'`**:訊息區是 `ChatLayout` 自己的捲動
       * 容器,它有一組 rAF 的黏底補間(`useChatStreamScroll`)——平滑捲動是
       * 非同步的,整段期間都在跟那組邏輯搶同一個 scrollTop。而且「跳到這則」
       * 本來就是跳,不是帶著使用者滑過中間那幾題。
       */
      /*
       * 找不到就退回那一題的提問(保險):`answer-{id}` 只在
       * 那一則真的畫出來時才存在,而清單是非同步載入的 —— 退路讓「跳不動」
       * 不會變成一個沒有回饋的死點擊。
       */
      const target =
        document.getElementById(anchorId) ??
        document.getElementById(anchorId.replace(/^answer-/, 'turn-'));
      target?.scrollIntoView({block: 'start'});
      /*
       * 捲完**才**亮那一圈(讓人認得出是哪一則)。
       * ⚠️ 順序不能顛倒:那一圈是照當下的 getBoundingClientRect() 定位的,
       * 捲之前發的話會先畫在舊位置再跳過去。
       */
      if (target) spotlightAnchor(target.id);
    });
  }, []);

  /*
   * 從筆記頁按「回到上次對話」進來:帶著 `state.jumpToQa`。
   * 游標停在輸入框(跳回來就能續問)—— 輸入框釘在底部、不在捲動區裡,聚焦不會捲畫面。
   *
   * 怎麼跳、為什麼要那樣跳(設計系統的黏底捲動)寫在 `lib/chatJump.ts`。跳之前訊息區是藏著的(`styles.jumpPending`):
   * 使用者看到的第一個畫面就是那一題;跳好當場直接顯示(inline 蓋過那個 class,不等清 state 那一輪 render),再清 state。
   * 跳好之後「把那一題釘在原位」那一段活得比這一次跳轉久(清 state 會先跑這裡的取消),放手的函式收在 ref 裡,換對話 / 離開才放。
   */
  const location = useLocation();
  const jumpToQa = (location.state as {jumpToQa?: number} | null)?.jumpToQa;
  const messageListRef = useRef<HTMLDivElement>(null);
  const releaseJumpKeep = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      releaseJumpKeep.current?.();
      releaseJumpKeep.current = null;
    },
    [conversationId],
  );
  useEffect(() => {
    // state 清掉了:跳好時當場加的那個「顯示」拿掉,下次藏才藏得住
    if (jumpToQa == null) messageListRef.current?.style.removeProperty('visibility');
  }, [jumpToQa]);
  useEffect(() => {
    if (jumpToQa == null) return;
    const clear = () => navigate(location.pathname, {replace: true, state: null});
    const target = turns.some((t) => t.id === jumpToQa) ? document.getElementById(`turn-${jumpToQa}`) : null;
    if (!target) {
      // 向伺服器讀完了還是沒有那一題(被刪掉了):不跳,把 state 清掉 —— 不然訊息區一直藏著。
      // 快取先畫的那份沒有不算(快取舊、還沒有那一題),等重抓回來
      if (fetchedHistoryOf === conversationId) clear();
      return;
    }
    composerInputRef.current?.focus();
    return jumpAndUnlock(
      target,
      messageListRef.current,
      (release) => {
        releaseJumpKeep.current?.();
        releaseJumpKeep.current = release;
      },
      () => {
        messageListRef.current?.style.setProperty('visibility', 'visible');
        spotlightAnchor(target.id);
        clear();
      },
    );
  }, [jumpToQa, turns, fetchedHistoryOf, conversationId, navigate, location.pathname]);

  /**
   * 把這組對話裡 @ 我的便條標成已讀。
   *
   * ⚠️ **一定要判 `document.hasFocus()`** —— 人不在電腦前的時候被標成已讀,
   * 他回來就永遠不知道有人找過他。所以 `focusNonce` 才要存在:
   * 背景分頁那一次不標,等他真的切回來再標。
   * ⚠️ 只有 `marked > 0` 才發 `CONVERSATIONS_UPDATED` —— 每次都發會繞成迴圈
   * (那個事件自己會 `notesNonce++`)。
   */
  useEffect(() => {
    if (!conversationId || !document.hasFocus()) return;
    void markConversationRead(conversationId).then(
      (marked) => {
        if (marked > 0) notifyConversationsUpdated();
      },
      () => {
        // 標不起來就算了:下一次進這組對話、或視窗重新聚焦時會再試一次
      },
    );
  }, [conversationId, notesNonce, focusNonce]);

  /*
   * 歷史裡已經有**跑完的**那一筆了,就把 pending 收掉,避免同一題出現兩次。
   *
   * ⚠️ **一定要看 `status`,不能只比 id。** 後端在**送出的當下**就把紀錄寫進
   * 資料庫了(`ask.py`:「紀錄在這裡就先寫進去,不等 claude 跑完」——
   * 那是「關掉分頁也不會弄丟這一題」的關鍵),`status` 是 `running`、`answer` 是空的。
   * 只比 id 的話:`start` 事件一到就重抓歷史 → 歷史裡查得到那個 id → 把還在
   * 串流的 pending 收掉 → 畫面剩下一顆**空的答案泡泡**,而且從此不再更新,
   * 使用者只能重新整理才看得到答案。
   */
  useEffect(() => {
    if (!conversationId || !pendingFinalId) return;
    if (turns.some((t) => t.id === pendingFinalId && t.status !== 'running')) {
      clearPending(conversationId);
    }
  }, [conversationId, pendingFinalId, turns]);

  // ── 送出 ───────────────────────────────────────────────────────────────
  const sending = !!pending && !pending.done;

  /**
   * 這一則是「便條」還是「問題」。
   *
   * 判斷完全看有沒有 @ 到**對得上帳號**的人 —— 沒有額外的開關。
   * 打錯字的 `@xxx` 對不上,那就還是一個普通問題(規則見 lib/mentions.ts)。
   */
  const notifying = useMemo(
    () => mentionedUsernames(draft, mentionable.map((p) => p.username), me.username),
    [draft, mentionable, me.username],
  );
  const isNote = notifying.length > 0;

  /*
   * @ 到新的人時彈一張 info 卡 —— 跟「Attached x.png」同一疊、
   * 同一個壽命,只是圖示換 Info、藍色。
   * 只在**名單變長**時講(prev 記在 ref):打字過程 notifying 每個字都重算,
   * 相等的名單不重複彈;刪掉 token 也不彈(移除自己看得到,不用再講)。
   */
  const notifiedRef = useRef<string>('');
  useEffect(() => {
    const key = notifying.join(',');
    if (key && key !== notifiedRef.current && notifying.length > (notifiedRef.current ? notifiedRef.current.split(',').length : 0)) {
      upload.notify(describeNote(notifying, upload.files.length));
    }
    notifiedRef.current = key;
    // upload 物件每次 render 都是新的,依賴收斂到真正會變的兩個值
  }, [notifying.join(','), upload.files.length]);

  /**
   * 這則便條**送不出去**的原因(兩道前端檢查),沒有就是 undefined。
   *
   * 兩條都是後端也會擋的,但擋在這裡才講得清楚:後端回的 400 會被
   * `handleNote` 的 catch 吞成通用的「Could not send this note.」,
   * 使用者看不出來是字太多還是這組對話還不能放便條。
   *
   * 它同時畫在輸入框上方(送出**之前**就看得到),送出時再擋一次。
   */
  const noteBlock = useMemo(() => {
    if (!isNote) return undefined;
    // 便條掛在對話上,而對話要有內容才存在(後端的 owner 是從問答推出來的)
    if (!conversationId) return NOTE_NEEDS_CHAT;
    const length = draft.trim().length;
    if (length > MAX_NOTE_CHARS) {
      return `A note can be at most ${MAX_NOTE_CHARS} characters (now ${length}).`;
    }
    return undefined;
  }, [isNote, conversationId, draft]);

  /*
   * 「會通知誰」那條藍條的字(見 styles.tuckShell)。沒有要畫就是 null。
   * 收起來的那 165ms 裡 `isNote` 已經是 false —— 跟附件抽屜的 `drawerFiles` 同一招,
   * 留著最後一份非空的字給它演完,不然收合演的是一條空的藍條。
   */
  const notifyHintText = isNote && !noteBlock ? describeNote(notifying, upload.files.length) : null;
  const [lastNotifyHintText, setLastNotifyHintText] = useState('');
  if (notifyHintText !== null && notifyHintText !== lastNotifyHintText) {
    setLastNotifyHintText(notifyHintText);
  }

  /*
   * 送出那一下,附件抽屜與藍條**直接收起、不演過場**(見 growStyles.snap)。
   * 送出成功時打開;下一次有東西要長出來(放進檔案 / @ 到人)就關掉 ——
   * 它只管收起,長出來那一半照常演。用「render 期間依前一次的值更新 state」
   * 的寫法(同 `drawerFiles`),不用 effect:晚一格的話第一個檔案進來那一格
   * 抽屜會是一格跳開的。
   */
  const [collapseSnap, setCollapseSnap] = useState(false);
  if (collapseSnap && (upload.files.length > 0 || notifyHintText !== null)) {
    setCollapseSnap(false);
  }

  // 有 conversationId 才進得來(`noteBlock` 擋在前面)—— 便條沒有「先導頁再說」
  // 那條路:它掛在對話上,而對話要先有一題問答才存在。
  /**
   * 這一次**送不出去**(送出鈕要 disabled,見 `sendBlocked`)。
   *
   * 兩種:便條自己的兩道檢查(`noteBlock`),以及「同事名單抓失敗、
   * 而這句話看起來在 @ 人」。後者不能放行(整句會進 AI,見 `handleSubmit`)。
   *
   * ⚠️ 這顆鈕擋得住滑鼠,**擋不住鍵盤 Enter**(那條走 `ChatComposer` 自己的
   * `handleSubmit`)—— 所以 `refuseSubmit` 那條路一樣要留著,兩個是互補的。
   */

  async function handleNote(conversation: string, text: string) {
    let created: NoteItem;
    try {
      created = await createNote(conversation, text, upload.files);
    } catch {
      // 便條送不出去一定要講:它不像問題會在畫面上留一則「進行中」,
      // 默默失敗的話使用者會以為對方收到了
      toastError('Could not send this note.');
      return;
    }
    // 直接插進畫面,不等重抓 —— 送出去的東西要馬上看得到
    setNotes((list) => [...list, created]);
    // 送出清空:抽屜與藍條直接收起(growStyles.snap)
    setCollapseSnap(true);
    setDraft('');
    upload.clear();
    // 送出後重新聚焦:喊完人常常要接著補一句
    composerInputRef.current?.focus();
    toastInfo(`Notified ${notifying.map(personName).join(', ')}.`);
    /*
     * 沒存成的附件要**逐一**講。靜靜略過的話,
     * 使用者以為同事收得到那張截圖,而它根本沒進去。
     */
    for (const name of created.rejected_files ?? []) {
      toastError(`${name} was not attached.`);
    }
    // 被 @ 的人會被拉進共用 —— 側邊欄的「Shared」要跟著更新
    notifyConversationsUpdated();
  }

  /**
   * 擋下這一次送出,講原因,並且**把使用者打的字放回去**。
   *
   * ⚠️ `ChatComposer` 的送出是「呼叫 `onSubmit`,然後**無條件清空**」
   * (dist 的 `handleSubmit`:`onSubmit(trimmed); updateValue('')`)——
   * 我們在 `onSubmit` 裡 `return` 阻止不了後面那一行。同一批 render 裡
   * 直接 `setDraft(text)` 也沒用,它會被後寫的 `''` 蓋掉,
   * 所以要排到**下一個 microtask** 才寫回去(那時清空已經進了佇列)。
   *
   * 不這樣做的話,被擋下來的那則便條(可能打了幾百個字)**整段消失**。
   */
  function refuseSubmit(text: string, message: string) {
    toastError(message);
    queueMicrotask(() => setDraft(text));
  }

  function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;

    /*
     * 便條**不受「正在跑一題」的限制**:它不進 AI、不佔 session,
     * 而問題正在跑的時候本來就最需要喊人來看。
     */
    if (isNote) {
      // 擋下來的兩種情況(字數、還沒有對話)輸入框上方已經寫著原因了,
      // 但按了完全沒反應一樣是壞掉 —— 再講一次,而且字要留著。
      // `|| !conversationId` 是給型別看的:`noteBlock` 已經涵蓋這個情況
      if (noteBlock || !conversationId) {
        refuseSubmit(text, noteBlock ?? NOTE_NEEDS_CHAT);
        return;
      }
      void handleNote(conversationId, text);
      return;
    }

    /*
     * ⚠️ 同事名單沒抓到、但這句話**看起來**在 @ 人 —— 擋下來。
     *
     * 這時候 `mentionedUsernames()` 回空陣列,跟「真的沒有 @ 人」分不出來。
     * 放行的話「@ming 這個你看一下」會整句送進 AI,使用者以為喊了人其實沒有,
     * 而且畫面上完全看不出差別 —— 那比送出失敗糟得多。
     */
    if (mentionableFailed && looksLikeMention(text)) {
      refuseSubmit(text, 'Cannot reach the colleague list right now — try again in a moment.');
      return;
    }

    const question = text;
    /*
     * 同一組對話同時只跑一題。送出鈕這時候是停止鈕(`isStopShown`),
     * 但**鍵盤的 Enter 還是走得到這裡** —— 靜靜吃掉的話,
     * 他剛打的那一題連同輸入框一起消失。
     */
    if (sending) {
      refuseSubmit(text, 'Wait for the current answer to finish.');
      return;
    }

    // 對話 id 在送出當下就決定,不等後端:網址、側邊欄、暫存狀態從第一秒就對得起來。
    const targetId = conversationId ?? newConversationId();
    /*
     * ⚠️ **新對話的模型選擇要在這裡補記一次。** 使用者可以在還沒送出的新對話上
     * 先換模型,而那時候根本還沒有 id —— `chooseModel` 那條路記不了。
     * 少了這一行,「開新對話 → 換模型 → 送出 → 重新整理」會掉回個人常用。
     */
    if (modelChoice) rememberConversationModel(targetId, modelChoice);
    startStream({
      conversationId: targetId,
      question,
      kb: effectiveKb,
      model: effectiveModel ?? undefined,
      files: upload.files,
    });
    // 送出清空:抽屜直接收起,不演 165ms 的收合(growStyles.snap)
    setCollapseSnap(true);
    setDraft('');
    upload.clear();
    /*
     * 送出後**重新聚焦**。
     * ⚠️ 只有留在原地那條路有意義:新對話會導頁,整個元件跟著 key 重掛,
     * 那時候這個 ref 指的已經是舊的那一份(新掛上來的輸入框本來就是空的)。
     */
    if (conversationId) composerInputRef.current?.focus();

    // 導頁之後這個元件會整個換掉(key={conversationId}),
    // 新掛上來的那一份會自己從模組層撈到剛送出的那一題。
    // 從空白頁送出第一句:輸入框從畫面中間滑到底部(`lib/chatTransition.ts`)
    if (!conversationId) void morphChat(() => navigate(`/c/${targetId}`, {replace: true}));
  }

  /*
   * ⚠️ 底下這三個 handler 的**參照必須每次 render 都一樣**(效能)。
   *
   * 它們是傳給 `React.memo` 過的 `Turn` 的 props —— 換了參照 memo 就等於沒有,
   * 串流每一幀仍然會把整串對話重畫一次。改這幾行之前先確定新的寫法
   * 不會把參照變回每次都新的。
   */

  /** 修改重問:只把原文放回輸入框,**不動已送出的那一則**。 */
  const handleEdit = useCallback((question: string) => {
    // setDraft 與 ref 都是 React 保證穩定的東西,所以依賴表是空的
    setDraft(question);
    composerInputRef.current?.focus();
  }, []);

  /**
   * 一直指著**最新那一份** `handleSubmit`。
   *
   * ⚠️ `handleSubmit` 讀了十幾個會變的值(`sending`、`noteBlock`、`isNote`、
   * `effectiveKb`、`effectiveModel`、`modelChoice`、`upload`…),包成 `useCallback`
   * 就得把那張依賴表抄一遍 —— 漏一個就是「重試時用到上一輪的狀態」這種
   * 不會報錯、只會偶爾送錯東西的 bug。存進 ref 則沒有依賴表:
   * 按下去的當下才去拿,拿到的一定是這一輪的那一份。
   *
   * ⚠️ 在 render 期間寫 ref 是刻意的(跟 `Sidebar` 的 `listKeysRef` 同一條):
   * 它是一份快取、不是狀態,寫它不需要也不該觸發重繪。
   */
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  /** 失敗那一則的「重試」= 拿同一個問題再問一次。 */
  const handleRetry = useCallback((question: string) => {
    handleSubmitRef.current(question);
  }, []);

  /**
   * 提問與答案共用,`what` 只決定 toast 講哪一個。同一個 uniqueID:連按幾次是換掉那一則,不會疊一排。
   */
  const handleCopy = useCallback(async (text: string, what: 'question' | 'answer') => {
    // 內網是 http,navigator.clipboard 在那裡不存在 —— copyText 裡有備援
    const ok = await copyText(text);
    if (ok) toastInfo(what === 'question' ? 'Question copied.' : 'Answer copied.', 'copy');
    else toastError(`Could not copy the ${what}.`, 'copy');
    return ok;
  }, []);

  const knowledgeBases = useMemo(() => config?.knowledge_bases ?? [], [config]);

  /**
   * 這組對話最後一則用的專案。
   * ⚠️ **一定要驗證那個 id 還在清單裡**:專案從設定檔拿掉之後,畫面會顯示一個選單裡沒有的值,
   * 而後端收到不認識的 kb 會默默退回預設 —— 答案是對的,但畫面在騙人。
   */
  const conversationKb = useMemo(() => {
    const last = [...turns].reverse().find((t) => t.knowledge_base);
    const id = last?.knowledge_base ?? null;
    return id && knowledgeBases.some((kb) => kb.id === id) ? id : null;
  }, [turns, knowledgeBases]);

  /**
   * 這一題用哪個專案:這組對話主動選的 → 這組對話上一題用的 → 後端的預設。
   * ⚠️ 新對話一律從後端的預設出發,不用 localStorage 記住上次選的 ——
   * 那會讓新對話停在上一次挑的環境。續問不受影響:一組對話會留在它自己的專案。
   */
  const effectiveKb = kbChoice ?? conversationKb ?? config?.default_knowledge_base;

  /** 這一題的專案顯示名(就是 workspace 底下的資料夾名,或 json 那筆的 label)。 */
  const effectiveKbLabel = knowledgeBases.find((b) => b.id === effectiveKb)?.label ?? effectiveKb ?? '';

  /**
   * 專案下拉:一層,每一項是一個專案(workspace 底下的資料夾),順序照 `/api/config`。
   *
   * 寫成 JSX(compound 模式)不是資料陣列:資料模式沒有地方掛 `data-menu-flush`,
   * 第一項與最後一項會離面板上下緣 4px,跟其他選單長得不一樣。
   */
  const projectMenu = useMemo(
    () => (
      <VStack gap={0.5} {...{'data-menu-flush': ''}}>
        {knowledgeBases.map((kb) => (
          <DropdownMenuItem
            key={kb.id}
            label={kb.label}
            // 選中的那一項除了打勾,還有一塊底色(global.css 的 .menu-item-current)
            className={kb.id === effectiveKb ? 'menu-item-current' : undefined}
            endContent={kb.id === effectiveKb ? <Icon icon={Check} size="sm" /> : undefined}
            onClick={() => setKbChoice(kb.id)}
          />
        ))}
      </VStack>
    ),
    [knowledgeBases, effectiveKb],
  );

  /**
   * 這一題實際要送出去的模型:這組對話選過的 → **這個環境的預設**(`knowledge_bases.json` 的
   * `default_model`)→ 常用 → 後端預設,每一階都要在白名單裡(`pickModel`)。
   */
  const effectiveModel = pickModel({
    chosen: modelChoice,
    kbDefault: config?.knowledge_bases.find((b) => b.id === effectiveKb)?.default_model,
    preferred: preferredModel,
    serverDefault: config?.default_model,
    allowed: config?.allowed_models,
  });
  const sendBlocked = isNote ? !!noteBlock : mentionableFailed && looksLikeMention(draft);

  /**
   * 輸入框裡打 `@` → 打開**跟 @ 按鈕同一顆**選人浮層。
   *
   * 所以 `@` **不註冊成 ChatComposerInput 的 trigger**:設計系統的觸發選單
   * 塞不進搜尋框,兩條路長得注定不一樣 —— 讓打字那條也走 `MentionPicker`。
   * 挑中之後把剛打的那個 `@` 刪掉再插 token(不刪會變成「@」+ token 兩份)。
   * 連帶效果:不會有 `@@` 卡住空面板的情況,因為根本沒有 @ 選單會開。
   */
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  /**
   * 這次浮層是「打了 @」開的:記下那個 @ 的**確切位置**(文字節點 + offset)。
   * null = 按鈕開的。
   *
   * ⚠️ 不能只記一個 boolean、挑人時賭「焦點回來選取範圍還在」——
   * 真實瀏覽器上點浮層那一下焦點搬走後,contenteditable 的選取範圍
   * **不保證**還原(症狀:挑完人那個 @ 還留著)。位置要自己記,不能用猜的。
   */
  const typedAtRef = useRef<{node: Node; offset: number} | null>(null);

  /**
   * 剛剛是不是打出了一個**新的** @:游標前一個字是 @,而它前面是開頭/空白/換行
   * (跟設計系統 `findActiveTrigger` 同一條邊界規則 —— email 裡的 @ 不算)。
   * 是的話回傳那個 @ 的位置(文字節點 + offset),不是就 null。
   */
  const justTypedAt = (): {node: Node; offset: number} | null => {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    if (!selection || !node || node.nodeType !== Node.TEXT_NODE) return null;
    const offset = selection.anchorOffset;
    const text = (node.textContent ?? '').slice(0, offset);
    if (!text.endsWith('@')) return null;
    const before = text[text.length - 2];
    const boundary =
      before === undefined || before === ' ' || before === '\n' || before === ' ';
    return boundary ? {node, offset} : null;
  };

  /**
   * 「@@」收斂成一個 @。
   *
   * 會發生的路徑:打第一個 @ 開了浮層,焦點被浮層搶走(或使用者點回輸入框
   * 讓浮層 light-dismiss 收掉),那個 @ 就留在字裡;再打一個 @ 時游標前面
   * 是 '@' 不是邊界 —— `justTypedAt` 永遠不成立,浮層叫不出來,畫面上就是
   * 兩個 @ 疊著。這裡把**前一個**刪掉、留下剛打的,再補發 input 讓
   * draft 與觸發流程照常跑一次(那一次會看到單一個 @、前面是邊界,浮層照開)。
   * 順帶把 email 打成 `a@@b` 的手誤也修正,無害。
   */
  const collapseDoubleAt = (editable: HTMLElement): boolean => {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    if (!selection || !node || node.nodeType !== Node.TEXT_NODE) return false;
    const offset = selection.anchorOffset;
    const text = node.textContent ?? '';
    // 剛打的那個字元不是 @ 就跟這件事無關
    if (text[offset - 1] !== '@') return false;

    const drop = (target: Node, at: number) => {
      const range = document.createRange();
      range.setStart(target, at);
      range.setEnd(target, at + 1);
      range.deleteContents();
      // 游標留在剛打的那個 @ 後面(同節點時刪的字在它前面,offset 要退一格)
      selection.setPosition(node, target === node ? offset - 1 : offset);
      editable.dispatchEvent(new InputEvent('input', {bubbles: true}));
      return true;
    };

    // 同一個文字節點裡的 `@@`
    if (text.slice(0, offset).endsWith('@@')) return drop(node, offset - 2);

    /*
     * ⚠️ 前一個 @ **可能在別的文字節點**:插 token、刪字這些 DOM 手術會把
     * 文字節點切開,瀏覽器不保證「連續打的字在同一個節點」。只看 anchorNode
     * 的話這種 @@ 收不掉。剛打的 @ 是這個節點的第一個字元時,
     * 往前找**緊鄰的**文字節點(中間夾 token 之類的元素就不算,那是兩個
     * 不同的詞),它的最後一個字是 @ 才收。
     */
    if (offset === 1) {
      const previous = node.previousSibling;
      if (previous?.nodeType === Node.TEXT_NODE) {
        const before = previous.textContent ?? '';
        if (before.endsWith('@')) return drop(previous, before.length - 1);
      }
    }
    return false;
  };

  /**
   * 把「打出來的那個 @」刪掉,游標留在原位。回傳有沒有刪成。
   * 位置優先用記下來的那一份;節點已經不在(理論上不會)就退回
   * 「掃整個輸入框找最後一個成立的 @」—— 寧可多一道保險,
   * 也不要讓畫面出現「@」+ token 兩份。
   */
  const deleteTypedAt = (
    editable: HTMLElement,
    saved: {node: Node; offset: number} | null,
  ): boolean => {
    const cut = (node: Node, offset: number) => {
      const range = document.createRange();
      range.setStart(node, offset - 1);
      range.setEnd(node, offset);
      range.deleteContents();
      window.getSelection()?.setPosition(node, offset - 1);
      return true;
    };
    if (
      saved &&
      saved.node.isConnected &&
      (saved.node.textContent ?? '')[saved.offset - 1] === '@'
    ) {
      return cut(saved.node, saved.offset);
    }
    // 備援:從後往前找最後一個「前面是邊界」的 @
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes.reverse()) {
      const text = node.textContent ?? '';
      for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] !== '@') continue;
        const before = i > 0 ? text[i - 1] : undefined;
        if (before === undefined || before === ' ' || before === '\n' || before === ' ') {
          return cut(node, i + 1);
        }
      }
    }
    return false;
  };

  /**
   * 把游標移到輸入框的最後面。
   *
   * ⚠️ 從**選單**挑人的時候一定要先做這件事:`insertToken()` 插在「目前的
   * 選取範圍」,而點選單的時候焦點跑去了按鈕上 —— 輸入框裡留著的是**上一次**
   * 插完 token 之後的位置。所以挑第二個人時,token 會插在第一個人後面,
   * 游標也留在那裡。
   * 打字觸發的那條路徑沒這問題,它本來就在游標處。
   */
  const moveCaretToEnd = () => {
    const editable = composerBoxRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    const selection = window.getSelection();
    if (!editable || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  /**
   * 挑一個人插進輸入框(那顆 @ 鈕的選單用的)。
   *
   * ⚠️ **`insertToken()` 不會發 `input` 事件**(`insertText()` 也一樣)——
   * 它只動 DOM,所以輸入框的 `value` 不會更新,`isNote` 也就不會成立。
   * 插完自己補一個 input 事件,讓它走跟使用者打字**完全一樣**的那條路
   *(emitChange → onChange → 我們的 normaliseTokenSpacing)。
   */
  /**
   * 真正把 token 插進輸入框(浮層**已經關掉、焦點也還完**之後才跑)。
   * `typedAt` 是呼叫端在關浮層**之前**先搶下來的位置 —— onOpenChange(false)
   * 會把 typedAtRef 清掉,不先搶的話排程跑到時已經是 null。
   */
  const insertMentions = (
    usernames: string[],
    typedAt: {node: Node; offset: number} | null,
  ) => {
    composerInputRef.current?.focus();
    const editable = composerBoxRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (typedAt) {
      // 手打 @ 開的:把那個 @ 刪掉再插(不刪會是「@」+ token 兩份)
      if (editable) deleteTypedAt(editable, typedAt);
    } else {
      moveCaretToEnd();
    }
    for (const username of usernames) {
      const person = mentionable.find((p) => p.username === username);
      // 膠囊造型的藍色 Token,輸入框與便條泡泡同一份(見 mentionToken)
      composerInputRef.current?.insertToken(
        mentionToken(username, person?.display_name ?? ''),
      );
    }
    editable?.dispatchEvent(new InputEvent('input', {bubbles: true}));
  };

  /**
   * 挑人(單挑與群組同一條路)。
   *
   * ⚠️ **先關浮層,下一個 macrotask 才動手**:
   * Popover 關閉時會把焦點還給觸發鈕,跟「focus 輸入框 → 插 token」是一場賽跑
   * —— 合成事件的測試環境沒有真的焦點制度,測不出來;真瀏覽器上手打 @ 挑第二個人
   * 就會輸(焦點被搶走,token 插錯地方或 @ 沒刪到)。排到浮層還完焦點之後,
   * 這一類競態整組消失(jumpToTurn 同一招)。
   */
  const pickMention = (usernames: string[]) => {
    if (usernames.length === 0) return;
    const typedAt = typedAtRef.current;
    typedAtRef.current = null;
    setIsMentionOpen(false);
    setTimeout(() => insertMentions(usernames, typedAt), 0);
  };

  /**
   * 常駐的三個群組:All Consultant / All Software Engineer / ALL。
   * 「標記一群人」= 逐一插入那群人的 token —— 後端的提及解析(notes.py)
   * 認的是一顆一顆的 @帳號,沒有「群組」這種東西,展開在前端做。
   */
  const mentionGroups = useMemo(
    () => [
      {
        key: 'consultant',
        // ⚠️ label 是**畫面上的字**,故意不從常數組出來:職稱字串是
        // `Software engineer`(小寫 e),而這兩顆按鈕上寫的是標題式大小寫。
        // 用來**篩選**的才是常數。
        label: 'All Consultant',
        /*
         * ⚠️ 用**字串相等**比,不要用 `!roleGrantsFull(p.role)`:管理員的職稱是
         * `Admin`,兩個群組本來就都不該圈到他,而「非工程師」會把他掃進 Consultant 那組。
         * 字串本身走 `adminApi` 的常數,不要在這裡再寫一次字面值。
         */
        usernames: mentionable
          .filter((p) => p.role === CONSULTANT_ROLE)
          .map((p) => p.username),
      },
      {
        key: 'engineer',
        label: 'All Software Engineer',
        usernames: mentionable
          .filter((p) => p.role === FULL_ACCESS_ROLE)
          .map((p) => p.username),
      },
      {key: 'all', label: 'ALL', usernames: mentionable.map((p) => p.username)},
    ],
    [mentionable],
  );

  /**
   * ⚠️ 不處理的話,挑完一個人之後**第二個 @ 叫不出選單**。
   *
   * 原因在設計系統裡:插 token 的時候會在後面補一個 **不斷行空格(U+00A0)**,
   * 而 `useTriggerMenu` 的 `findActiveTrigger` 只認 `' '`(U+0020)與換行 ——
   * 它看到 `@` 前面是 160 就判定「這不是一個新的觸發」,選單永遠不開。
   *
   * 我們動不到它的程式碼,所以在**輸入框的內容變動時**把那個字元換回一般空格。
   * 只換「緊接在 token 後面、而且是該文字節點第一個字」的那一個 ——
   * 全部換掉會動到使用者自己貼進來的內容。
   * 一個字元換一個字元,所以游標的 offset 不會跑掉,只要把選取範圍放回去就好。
   */
  const normaliseTokenSpacing = () => {
    const editable = composerBoxRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!editable) return;
    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode ?? null;
    const anchorOffset = selection?.anchorOffset ?? 0;
    let changed = false;
    /*
     * ⚠️ 開頭多出來的 `<br>` 要拿掉。刪掉 token **前面**的文字時,瀏覽器會在
     * 開頭補一個 `<br>`(contenteditable 對「行首是不可編輯元素」的補償),
     * 輸入框就變成兩行高、整塊往上長。只拿**第一個子節點是 <br> 而且後面
     * 還有內容**的那一個 —— 空輸入框裡那顆佔位的 <br> 不能動(游標高度靠它)。
     */
    const first = editable.firstChild;
    if (first instanceof HTMLBRElement && editable.childNodes.length > 1) {
      first.remove();
      changed = true;
    }
    for (const node of Array.from(editable.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const previous = node.previousSibling;
      if (!(previous instanceof HTMLElement) || !previous.hasAttribute('data-astryx-token')) {
        continue;
      }
      const text = node.nodeValue ?? '';
      if (!text.startsWith(' ')) continue;
      node.nodeValue = ` ${text.slice(1)}`;
      changed = true;
    }
    // 改動文字節點會讓選取範圍塌掉,放回原位(長度沒變,offset 還有效)
    if (changed && anchorNode && selection) {
      try {
        selection.setPosition(anchorNode, anchorOffset);
      } catch {
        // 節點已經不在了就算了,下一次輸入自然會重新定位
      }
    }
  };

  // ── 畫面 ───────────────────────────────────────────────────────────────
  const liveStatus = sending
    ? 'Generating a response'
    : pending?.done && pending.success === false
      ? 'The query failed'
      : pending?.done
        ? 'Response complete'
        : '';

  // 攤成一個陣列再交出去。ChatMessageList 判定「空」的條件是
  // children 為 null/false 或**長度 0 的陣列** —— 給它 {turns.map()}{cond}
  // 這種兩元素結構的話,空對話會被當成有內容,空白狀態永遠不會出現。
  /**
   * 訊息串 = 問答 + 便條,**依時間排**。
   *
   * ⚠️ 進行中那一則的排序時間用 `Number.MAX_SAFE_INTEGER`,不是它的 `createdAt`
   * —— 那個當下還是 undefined,照 0 排會被丟到整串的最前面,
   * 而它明明是最新的一則。
   */
  /**
   * 這一筆歷史紀錄是不是「就是現在正在串流的那一題」。
   *
   * 後端在送出當下就先寫了一筆 `status: 'running'`、`answer: ''` 的紀錄,
   * 所以重抓歷史時它會跟 `pending` **同時存在**。要畫的是 pending 那一份
   * (它有串流的文字、工具時間軸、耗時),不是這顆空殼。
   *
   * ⚠️ 不看 `pending.done`:`done` 事件到了但歷史還沒重抓回來的那一小段,
   * 兩邊都還在 —— 那時候要繼續藏歷史那一份,不然畫面上會同時出現
   * 「答完的 pending」與「空的歷史」兩則。
   *
   * ⚠️ 也**不比對 `finalId`**:`start` 事件與歷史重抓是兩條非同步的路,
   * 誰先到不一定 —— 歷史先到的那一格會同時畫出「空的歷史」與「Thinking…」
   * 兩則。同一組對話同時只可能有一題在跑(後端用 409 擋),
   * 所以「有 pending 就把還在跑的那一筆藏起來」是安全的,而且沒有競態。
   */
  const isLiveTurn = (turn: HistoryItem) => turn.status === 'running' && pending !== undefined;

  const shownTurns = turns.filter((turn) => !isLiveTurn(turn) && !turn.is_workflow_result);

  const items = [
    // Work Flow 的結果那一題不畫(見 HistoryItem.is_workflow_result):畫面上只留那則 @ 便條
    ...shownTurns.map((turn) => ({
      at: parseServerTime(turn.created_at).getTime(),
      node: (
      <Turn
        key={turn.id}
        turn={turn}
        username={me.username}
        peopleVersion={peopleVersion}
        isSending={sending}
        onEdit={handleEdit}
        onRetry={handleRetry}
        onCopy={handleCopy}
        attachments={attachments}
        isSavedToNotes={notesSave.saved.has(turn.id)}
        onSaveToNotes={me.can_notebook ? notesSave.save : undefined}
      />
      ),
    })),
    ...notes.map((note) => ({
      at: parseServerTime(note.created_at).getTime(),
      node: (
        <NoteBubble
          key={`note-${note.id}`}
          note={note}
          attachments={attachments}
          username={me.username}
          peopleVersion={peopleVersion}
        />
      ),
    })),
    /*
     * ⚠️ 同上:歷史裡那一筆要**已經跑完**才算「這題已經有了」。
     * 只比 id 的話,`start` 一到就把還在串流的這一則從畫面上拿掉。
     */
    ...(pending && !turns.some((t) => t.id === pending.finalId && t.status !== 'running')
      ? [
          {
            at: Number.MAX_SAFE_INTEGER,
            node: (
              <PendingTurn
                key="pending"
                pending={pending}
                resolveUpload={resolvePendingUpload}
                onOpenAttachment={attachments.open}
              />
            ),
          },
        ]
      : []),
  ]
    .sort((a, b) => a.at - b.at)
    /*
     * 日期分隔線(設計系統 `ai-chat` 範本的 `ChatSystemMessage variant="divider"`)。
     *
     * 一組對話會跨好幾天,而每一則自己的時間平常是藏起來的(自己的那幾則要 hover
     * 才看得到)—— 沒有這條線的話,昨天問的與今天問的長得一模一樣。
     *
     * ⚠️ 進行中那一則的排序時間是 `MAX_SAFE_INTEGER`(它還沒有 `created_at`),
     * 拿去算日期會變成 1970 之後的某個天文數字 —— 那一則一律算「現在」。
     */
    .flatMap((entry, i, all) => {
      const at = entry.at === Number.MAX_SAFE_INTEGER ? Date.now() : entry.at;
      const prev = all[i - 1];
      const prevAt =
        prev === undefined
          ? undefined
          : prev.at === Number.MAX_SAFE_INTEGER
            ? Date.now()
            : prev.at;
      const label = formatDayLabel(at);
      const isNewDay = prevAt === undefined || formatDayLabel(prevAt) !== label;
      if (!isNewDay) return [entry.node];
      return [
        <ChatSystemMessage key={`day-${label}-${i}`} variant="divider">
          {label}
        </ChatSystemMessage>,
        entry.node,
      ];
    });

  /**
   * 要不要畫**新對話的置中版面**(招呼語 + 大輸入框 + 分類卡)。
   *
   * ⚠️ 「沒有訊息」還不夠 —— 打開一組舊對話時歷史還在路上,那一刻也是沒有訊息。
   * 只看訊息數的話會先閃一下新對話的版面(見 `isHistoryLoaded`)。
   * 歷史還沒回來時走的是續問版面(訊息串 + 釘底的輸入框):它跟填好之後的版面
   * 同一個形狀,填進去的時候不會整頁換掉。
   */
  // `turns.length === 0` 也要成立:有題目卻一則都沒畫出來(Work Flow 的通知對話裡問答一題都不畫、
  // 便條又比歷史晚到;或只剩還在跑的那一題被藏起來)時,
  // 只看畫出來的東西的話,那一瞬間會被當成新對話、閃一下置中版面
  const isLanding = items.length === 0 && isHistoryLoaded && turns.length === 0;
  /**
   * 置中版面(招呼語 + 大輸入框 + 分類卡)整組憑空插進 DOM 的那一下要淡入。
   *
   * ⚠️ **只有「真的重新掛載」那幾條路會演**(`useEntryAnimation` 的語意就是這樣):
   *    從一組對話按 New chat(`App.tsx` 的 `key={id ?? '__new__'}` 會換 key)、
   *    或從別的路由切回來。**已經在空白頁上再按一次 New chat 不會演** ——
   *    那時候這個元素根本沒有重掛。
   *
   * ⚠️ 用 `fadeIn` 不用 `slideUp` —— 這一塊佔了半個畫面,大面積的位移看起來很重。
   * ⚠️ **底下那顆 `ChatLayout` 不要加任何進場**:
   *    那顆輸入框是**重新掛載**的,淡入會讓使用者剛打完字的輸入框在游標底下閃一下。
   */
  const landingEntryAnimation = useEntryAnimation('fadeIn');
  /*
   * ⚠️ 從對話頁**用過場**換過來時不演:過場自己就在淡入這一塊,再疊一層
   * 165ms 的 fadeIn 是兩條不同的曲線疊在一起,看起來很亂。
   * 只看掛載那一刻(`morphIn`):這一頁是在過場裡掛上的。
   */
  const landingEntry = morphIn !== null || swappingIn ? null : landingEntryAnimation;
  /**
   * 骨架 → 真的招呼語那一下。骨架已經跟招呼語一樣高(見 `landing`),
   * 版面不會動;剩下的只是「灰條換成字」,淡入把它接起來。
   */
  const greetingEntryAnimation = useEntryAnimation('fadeIn');
  // 過場進來、**而且掛上時設定就在快取裡**:真的招呼語是跟著這一頁一起掛上的,過場已經在淡它,不必再淡一次。
  // 設定還沒到的話,骨架 → 招呼語是過場演完之後才換的,那一下照舊淡入(不然變成硬切)。
  const greetingEntry = (morphIn !== null || swappingIn) && hadConfigAtMount ? null : greetingEntryAnimation;

  /**
   * 空白頁。
   *
   * ⚠️ **不走 `ChatMessageList` 的 `emptyState`。**
   * 那個插槽前面有一塊 `flex:1` 的 spacer(內容很短時把訊息推到底部貼著輸入框,
   * 那是聊天介面的慣例)—— 空白頁跟著被對半推下去,招呼語會落在畫面 40% 的地方,
   * 而要的是「中間偏上」。
   * 沒有訊息的時候整個 `ChatMessageList` 就不必掛,直接把空白頁交給訊息區。
   */
  const landing =
    config === null ? (
      /*
       * 設定還沒回來時顯示骨架,/api/config 一到才換真的招呼語。
       *
       * ⚠️ **骨架要跟招呼語一樣高**:不然 config 回來那一格,輸入框跟整排分類卡
       * 會一起往下掉,每按一次 New chat 都會。
       *
       * 高度**不是算的,是墊的**:底下放一份看不見的真招呼語(`visibility: hidden`),
       * 灰條疊在它上面。這樣字級(個人設定的 Text size)、窄視窗把 `display-2` 折成兩行、
       * 第一行被 20px logo 撐高 —— 全部跟真的一樣,不用一項一項追
       *(用 `1lh` 去算的話,窄視窗折行時還是會掉)。
       * 灰條的寬(140 / 360)只是樣子,不影響高度;窄的時候被 `maxWidth: 100%` 夾住。
       */
      <Stack width="100%" maxWidth={LANDING_WIDTH} xstyle={styles.greetingSkeleton} aria-hidden>
        <Stack xstyle={styles.greetingGhost}>
          <Landing name={me.display_name || me.username} />
        </Stack>
        <VStack gap={1} xstyle={styles.greetingBars}>
          <Text type="large" as="div">
            <Skeleton width="min(140px, 100%)" height="1lh" />
          </Text>
          <Text type="display-2" as="div">
            <Skeleton width="min(360px, 100%)" height="1lh" />
          </Text>
        </VStack>
      </Stack>
    ) : (
      // ⚠️ 這一層要跟骨架同一組 `width="100%"` + `maxWidth={LANDING_WIDTH}`:外面是置中的欄,
      // 少了 width 它縮成內容寬(招呼語跑到正中間),少了 maxWidth 它撐滿整欄、
      // 裡面 720 寬的招呼語就靠左貼著,跟輸入框對不齊
      <VStack width="100%" maxWidth={LANDING_WIDTH} xstyle={greetingEntry}>
        <Landing name={me.display_name || me.username} />
      </VStack>
    );

  /*
   * 輸入框那一整塊(拖放層 + 附件通知 + 「會通知誰」+ ChatComposer)。
   * 抽成變數是因為**兩種版面都要它**:空白對話的置中版與有訊息的 ChatLayout 版
   * —— 各寫一份的話,附件、@、狀態列遲早分岔。
   * 拖放與貼上掛在外面這一層:ChatComposer 沒有開放這兩種事件,
   * 而拖曳的落點是整個輸入框,不只是那顆迴紋針。
   */
  const composerNode = (
    <Stack
      ref={composerBoxRef}
      // `vtComposer`:New chat ↔ 對話的過場裡「同一個輸入框」的名字(見 `lib/chatTransition.ts`)
      xstyle={[styles.composerWidth, styles.vtComposer]}
      /*
       * 輸入框的高度與陰影開關(global.css 讀這個屬性):
       * 空白頁預設三行高;續問頁兩行高 + 較重的陰影(跟背景拉開)。
       * StyleX 寫不出「包裝層的屬性改設計系統子孫」,規則放 global.css。
       */
      {...{'data-composer-mode': isLanding ? 'landing' : 'chat'}}
      {...upload.dropZoneProps}>
          {/*
            附件掛上/移除的通知:輸入框**右外側**、
            卡片造型、從視窗下面浮上來、一則一張依序往上疊。
            掛上 success、移除 error。
          */}
          {upload.notices.length > 0 ? (
            <VStack gap={2} xstyle={styles.noticeStack} role="status">
              {upload.notices.map((notice) => (
                /*
                 * 外層這一層是 FLIP(`lib/useFlip.ts`):新的一張進來時,上面幾張從原位滑上去,
                 * 不是一格瞬移。
                 * 掛在外層:裡面那層的 `translate` 是進退場自己的,不要混在同一個元素上。
                 */
                <Stack key={notice.id} ref={flipNotice(notice.id)}>
                <Stack
                  // 進場/退場在 global.css 的 `[data-notice]`(見檔頭那段);`data-leaving` 由 hook 決定
                  {...{'data-notice': '', 'data-leaving': notice.isLeaving ? '' : undefined}}
                >
                  {/* 跟全站提示同一張卡(components/NoticeCard.tsx);「這則會通知誰」是藍 i */}
                  <NoticeCard
                    kind={notice.kind === 'attached' ? 'success' : notice.kind === 'removed' ? 'error' : 'info'}
                    text={notice.text}
                  />
                </Stack>
                </Stack>
              ))}
            </VStack>
          ) : null}
          {/*
            「會通知誰」的常駐藍條(見 styles.notifyHint)。
            一直掛著,用跟附件抽屜同一組 0fr → 1fr 的殼長出來 / 收回去(styles.tuckShell);
            收起來時畫的是最後一份字、`inert`。
          */}
          <Stack
            xstyle={[
              growStyles.shell,
              styles.tuckShell,
              notifyHintText !== null && growStyles.open,
              notifyHintText !== null && styles.tuckShellOpen,
              collapseSnap && growStyles.snap,
            ]}
          >
            <Stack xstyle={growStyles.clip} inert={notifyHintText === null}>
              {lastNotifyHintText ? (
                <HStack gap={2} vAlign="center" xstyle={styles.notifyHint}>
                  <Icon icon={AtSign} size="sm" />
                  <Text type="supporting" xstyle={styles.notifyHintText}>
                    {notifyHintText ?? lastNotifyHintText}
                  </Text>
                </HStack>
              ) : null}
            </Stack>
          </Stack>
          <ChatComposer
            // 高一點。density 是設計系統自己的尺度,
            // 不要自己加 padding —— spacious 連帶把內距與 dock 的留白一起放大。
            density="spacious"
            // 續問頁的輸入框浮起來一階;空白頁維持範本的預設陰影
            xstyle={isLanding ? undefined : styles.composerRaised}
            /*
             * ⚠️ 沒有 elevation="none"、沒有自訂框線:
             * 照 ai-chat-landing 範本用**預設的陰影浮起**,
             * 不是一圈邊線。以範本為準,不要加「更明顯的框線」。
             */
            value={draft}
            onChange={(value: string) => {
              setDraft(value);
              // 見 normaliseTokenSpacing:插 token 後的 U+00A0 換回一般空格 +
              // 拔掉刪字留下的開頭 <br>
              normaliseTokenSpacing();
              /*
               * 「@@」先收斂成一個 @。收斂會補發一次 input,
               * 修正後的內容會再走一遍這個 handler(那一輪 @ 前面就是邊界,
               * 浮層照常開),這一輪就到此為止。
               */
              const editable = composerBoxRef.current?.querySelector<HTMLElement>(
                '[contenteditable="true"]',
              );
              if (editable && collapseDoubleAt(editable)) return;
              // 打了一個新的 @(邊界規則同設計系統)→ 記下位置、開跟 @ 按鈕同一顆浮層
              if (!isMentionOpen) {
                const at = justTypedAt();
                if (at) {
                  typedAtRef.current = at;
                  setIsMentionOpen(true);
                }
              }
            }}
            onSubmit={handleSubmit}
            // 停的是「畫面上正在跑的那一題」,不是網址列的 id ——
            // 新對話送出的那一瞬間 useParams 還沒更新,拿 conversationId 會是 undefined
            onStop={() => pending && void stopStream(pending.conversationId)}
            /*
             * ⚠️ 便條的時候**即使正在跑一題也不能變成停止鈕**。
             * 那顆鈕當下的意思是「通知同事」—— 讓它變成停止鈕的話,
             * 想喊人的人會把正在跑的那一題按掉。
             */
            isStopShown={sending && !isNote}
            /*
             * 送出鈕是**同一顆在變形**,不是兩顆輪流出現。
             * 便條的時候它**不會**變成停止鈕(見上面 isStopShown),圖示也不換。
             * 其餘狀態(送出 / 停止)交回設計系統的預設。
             */
            // 錄音鈕擺 `sendActions`(設計系統說它就該在送出鈕旁邊)。
            // 顏色與漂浮框都跟左邊那排同一套 —— props 透傳到根節點,
            // 兩個記號都掛得上去。不要因為怕跟送出鈕對不齊而只掛顏色。
            sendActions={
              <ComposerDictationButton inputRef={composerInputRef} {...COMPOSER_ACTION} />
            }
            /*
             * ⚠️ `isDisabled` 只在**擋下來的時候**傳 `true`,其餘傳 `undefined`
             * —— `ChatSendButton` 的預設值是 `!(context.canSend)`(空字串時自己
             * 會 disabled),傳 `false` 會把那個預設蓋掉,變成沒打字也能按。
             */
            sendButton={sendBlocked ? <ChatSendButton isDisabled /> : undefined}
            placeholder={
              upload.isDropping ? 'Drop the files here' : 'Ask about a process or how to operate something…'
            }
            // 自己掛 input 才拿得到 handleRef(聚焦要用它,見 composerInputRef)。
            // 其餘行為跟預設那顆一樣 —— 值與送出都是 ChatComposer 在管。
            input={
              <ChatComposerInput
                handleRef={composerInputRef}
                onKeyDown={newlineOnTouchEnter}
              />
            }
            footerActions={
              /*
                ⚠️ 這一排一定要包在會換行的 `HStack wrap="wrap"` 裡(手機版會被擠出
                框外,完整的根因寫在 `styles.composerActions` 上)。設計系統的
                `footerLeft` 不換行也不縮,只有在**我們這一層**補換行 + minWidth:0 才有用。
                ⚠️ 要用 `HStack`,不能用 `Stack`:後者預設直排,整排鈕會變成一直行。
              */
              <HStack
                gap={1}
                wrap="wrap"
                vAlign="center"
                xstyle={styles.composerActions}
                // global.css 靠這個記號往上找到 ChatComposer 的 footer,
                // 手機版讓右邊的錄音 + 送出鈕折到下一行(見 COMPOSER_FOOTER)
                {...COMPOSER_FOOTER}
              >
                {/*
                  順序:@ → 附件 → 模型。
                  ⚠️ 全部擺在 `footerActions`,**不要用 `headerActions`** ——
                  那個插槽只要有東西(就算是視覺上隱藏的 input)就會多畫一整列,
                  看起來像輸入框上面卡了一條空白。
                */}
                {/* 設計系統的 FileInput 是**表單欄位**(自帶標籤與落點框),
                    輸入框裡要的是一顆圖示鈕 —— 範本 ai-chat 也是這樣擺。
                    所以真正的 input 藏起來,由那顆鈕去按它。 */}
                <VisuallyHidden>
                  <input
                    ref={upload.inputRef}
                    type="file"
                    multiple
                    onChange={(e) => {
                      void upload.addFiles([...(e.target.files ?? [])]);
                      // 清掉才選得了同一個檔案第二次
                      e.target.value = '';
                    }}
                  />
                </VisuallyHidden>
                {/*
                  ⚠️ 這顆鈕**不是**往輸入框打一個 `@`,而是直接開清單。
                  打 `@` 那條路徑留給真的用鍵盤打字的人 —— 兩條都到得了同一個結果。
                */}
                <MentionPicker
                  people={mentionable}
                  groups={mentionGroups}
                  onPick={pickMention}
                  isOpen={isMentionOpen}
                  onOpenChange={(open) => {
                    setIsMentionOpen(open);
                    /*
                     * 關掉而沒挑人:清掉「這次是打 @ 開的」記號,
                     * 免得下一次按鈕開的浮層把不該刪的字刪掉。
                     * ⚠️ 清除要**排到下一個 macrotask**:真瀏覽器上點浮層裡的
                     * 項目時,浮層的關閉(pointerdown 的 light-dismiss)可能搶在
                     * click 前面 —— 同步清掉的話 pickMention 拿到的是 null,
                     * 剛打的 @ 就不會被刪,畫面變成「@」+ token 兩份。
                     * 真的放棄不挑時,這 0ms 的延遲沒有任何影響。
                     */
                    if (!open) setTimeout(() => {
                      typedAtRef.current = null;
                    }, 0);
                  }}
                />
                <Button
                  label="Attach files"
                  // 滑過要看得到名稱 —— isIconOnly 只有 aria-label,
                  // 不會自己長 tooltip
                  tooltip="Attach files"
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<Icon icon={Paperclip} size="sm" />}
                  onClick={() => upload.inputRef.current?.click()}
                  {...COMPOSER_ACTION}
                />
                {/* 檔案區**常駐**,位置在附件右邊、模型左邊。
                    只寫「(0)」不寫 Files 字樣:圖示 + 滑過的 tooltip 已經講了它是什麼;
                    報讀程式念完整的「Files (0)」 */}
                <Button
                  label={`(${fileCount})`}
                  aria-label={`Files (${fileCount})`}
                  tooltip="Files"
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon={Files} size="sm" />}
                  onClick={() => setIsFilesOpen(true)}
                  {...COMPOSER_ACTION}
                />
                {/*
                  專案。只有**兩個以上**才出現 —— 只有一個的時候那顆下拉點開只會看到自己。
                */}
                {knowledgeBases.length > 1 ? (
                  <DropdownMenu
                    // 選單**照內容寬**,不跟按鈕一樣寬:專案名稱長短不一,短的按鈕不該把選單壓窄
                    menuWidth="max-content"
                    button={{
                      label: effectiveKbLabel,
                      'aria-label': `Project: ${effectiveKbLabel}`,
                      // Building2 = 公司 / 專案;避開資料夾類圖示,不然跟旁邊 Files 那顆分不出來
                      icon: <Icon icon={Building2} size="sm" />,
                      variant: 'ghost',
                      size: 'sm',
                      ...COMPOSER_ACTION,
                    }}
                  >
                    {projectMenu}
                  </DropdownMenu>
                ) : null}
                {/* 模型。對話中途換得了 —— 後端每一題都重讀這個欄位。 */}
                {(config?.allowed_models.length ?? 0) > 1 ? (
                  <DropdownMenu
                    // 手機只剩圖示,連箭頭也不要
                    hasChevron={!isMobile}
                    button={{
                      // 顯示用首字大寫;送給後端的值仍是原字(白名單比對是小寫)。
                      // 手機是純圖示鈕,這個字變成它的 aria-label
                      label: modelLabel(effectiveModel ?? 'Model'),
                      isIconOnly: isMobile,
                      icon: <Icon icon={Bot} size="sm" />,
                      variant: 'ghost',
                      size: 'sm',
                      ...COMPOSER_ACTION,
                    }}
                  >
                    {/* 單選群組:選中的那個有圓點,看得出現在用的是哪個 */}
                    <DropdownMenuRadioGroup label="Model" value={effectiveModel ?? undefined} onChange={chooseModel}>
                      {(config?.allowed_models ?? []).map((m) => (
                        <DropdownMenuRadioItem key={m} value={m} label={modelLabel(m)} />
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenu>
                ) : null}
              </HStack>
            }
            /*
             * 擋下來的兩句走設計系統自己的 `status` + 往上開。
             * 它畫出來的是:錯誤色的 muted 底、紅字、
             * 錯誤圖示,只圓上面兩個角,靠負邊距塞進輸入框上緣底下 ——
             * 跟登入頁密碼打錯時欄位底下那一條是同一套(FieldStatus 的 attached)。
             * ⚠️ **不要改用 Banner**:要的是貼著輸入框的這一條。「會通知誰」那一條沒有對應的 type,
             * 畫在 ChatComposer 外面但抄同一組幾何(見 styles.notifyHint)。
             * 優先序不變:附件錯誤 > 便條擋下的原因。
             */
            status={
              upload.error
                ? {type: 'error' as const, message: upload.error}
                : noteBlock
                  ? {type: 'error' as const, message: noteBlock}
                  : undefined
            }
            statusPosition="top"
            drawer={
              /*
               * ⚠️ **抽屜一直掛著,用 0fr → 1fr 的殼長出來 / 收回去**:「有檔案才掛」的話,
               * 放進第一個檔案時輸入框一格長 68px、拿掉最後一個一格縮回。
               * 殼與時間跟分類卡那一組共用(`growStyles`,225ms 的理由見那邊)。
               * ⚠️ 收回去的那 165ms 裡 `upload.files` 已經是空的 —— 畫的是 `drawerFiles`
               * (最後一份非空的清單),不然收合演的是一個空抽屜。收起來時 `inert`。
               * ⚠️ `key={drawerEpoch}`:每次從空變成有檔案都重新掛,維持「每一批附件
               * 抽屜都是展開的」(使用者收合過,下一批也會回到展開)。
               */
              <Stack
                xstyle={[
                  growStyles.shell,
                  // 塞進輸入框底下的負邊距在殼上(見 styles.tuckShell 的說明)
                  styles.tuckShell,
                  upload.files.length > 0 && growStyles.open,
                  upload.files.length > 0 && styles.tuckShellOpen,
                  // 送出清空那一下直接收起(見 growStyles.snap);拿掉最後一個仍然演收合
                  collapseSnap && growStyles.snap,
                ]}
              >
                <Stack xstyle={growStyles.clip} inert={upload.files.length === 0}>
                {drawerFiles.files.length > 0 ? (
                <ChatComposerDrawer
                  key={drawerEpoch}
                  count={drawerFiles.files.length}
                  xstyle={styles.drawerNoTuck}
                >
                  {drawerFiles.files.map((file, i) =>
                    // 圖片畫縮圖(只有檔名認不出是哪張);
                    // 其他檔案維持 Token —— Thumbnail 的文件自己說非圖片別用它
                    drawerFiles.previews[i] ? (
                      /*
                       * 檔名的提示要**馬上**出現。
                       * Thumbnail 的 `label` 會自己包一層 200ms 的 Tooltip,
                       * 而 delay 沒開放 —— 所以 label 不給(可及名稱由 alt 扛),
                       * 自己包一層 delay 0 的。
                       */
                      <Tooltip key={`${file.name}-${i}`} content={file.name} delay={0}>
                        <Thumbnail
                          src={drawerFiles.previews[i] as string}
                          alt={file.name}
                          onRemove={() => upload.remove(i)}
                        />
                      </Tooltip>
                    ) : (
                      <Token
                        key={`${file.name}-${i}`}
                        label={file.name}
                        onRemove={() => upload.remove(i)}
                      />
                    ),
                  )}
                </ChatComposerDrawer>
                ) : null}
                </Stack>
              </Stack>
            }

      />
    </Stack>
  );

  return (
    <>
      {/* 串流內容不要丟進 aria-live,報讀軟體會被一直打斷 —— 只播報狀態。 */}
      <VisuallyHidden as="div" aria-live="polite">
        {liveStatus}
      </VisuallyHidden>

      <FilesDialog
        isOpen={isFilesOpen}
        onOpenChange={setIsFilesOpen}
        view={fileView}
        onJump={jumpToTurn}
        onPreview={(items, index) => setPreview({items, index})}
      />
      {/*
        ⚠️ 燈箱**畫在 `FilesDialog` 外面**(是它的兄弟,不是子孫)。
        設計系統的 Dialog 把 keydown 掛在自己那顆 `<dialog>` 上,燈箱如果長在
        它裡面,在燈箱按 Esc 會**沿著 DOM 冒泡**把底下那層一起關掉
        擺成兄弟,事件根本到不了。
      */}
      <FileLightbox
        items={preview.items}
        index={preview.index}
        onIndexChange={(index) => setPreview((state) => ({...state, index}))}
        onClose={() => setPreview((state) => ({...state, index: null}))}
      />

      {/*
        聊天欄 + 右邊的檔案側欄(設計系統 `ai-chat` 範本的形狀:
        `<HStack>` 裡面「會伸縮的聊天欄」與「可拉寬的面板」並排,中間夾一根
        `ResizeHandle`)。沒有開檔案的時候只有聊天欄。
      */}
      {me.can_notebook ? <SelectionSaveButton root={chatRootRef} onSave={notesSave.save} /> : null}
      {/* 截圖存筆記的框選那一層(按了 Screenshot、允許之後才有) */}
      {notesSave.overlay}
      <HStack ref={chatRootRef} width="100%" height="100%" gap={0}>
      {isLanding ? (
        /*
         * 空白對話 = **置中版面**(照 ai-chat-landing 範本):
         * 招呼語、輸入框、分類與範例卡整組在畫面正中間;有訊息之後才切回
         * ChatLayout(輸入框釘底、訊息串會捲)。composerNode 是同一份 JSX,
         * 兩種版面共用 —— 拖放、附件、@、狀態列在兩邊行為一模一樣。
         */
        <Stack width="100%" height="100%" xstyle={styles.landingScroll}>
          <VStack gap={8} hAlign="center" xstyle={[styles.landingPage, landingEntry]}>
            {landing}
            {/*
              輸入框在空白頁收窄到跟招呼語同寬,
              左緣跟招呼語、分類籤全部對齊。composerNode 自己的 maxWidth 是 820
              (續問頁的寬度),包一層 720 的殼把它夾下來,不動共用的那份 JSX。
            */}
            <Stack width="100%" maxWidth={LANDING_WIDTH}>
              {composerNode}
            </Stack>
            {config !== null ? <LandingCategories onPick={handleEdit} /> : null}
          </VStack>
        </Stack>
      ) : (
        /*
          `density="spacious"` 與 minWidth:0 都是照 `ai-chat` 範本:
          前者是它訊息串的間距;後者讓聊天欄在側欄打開時縮得動 ——
          flex 子項的 min-width 預設是 auto,內容一寬(程式碼區塊)就擠不回去。
        */
        <ChatLayout density="spacious" xstyle={styles.chatColumn} composer={composerNode}>
          <ChatMessageList ref={messageListRef} isStreaming={sending} xstyle={[styles.messageWidth, jumpToQa != null && styles.jumpPending]}>
            {items}
          </ChatMessageList>
        </ChatLayout>
      )}
      {panel ? (
        <>
          {/* `isReversed`:把手在面板的**左**緣,拉的是右邊那一欄 */}
          {/*
            ⚠️ `resizable={...}` 是**具名 prop**,不能用展開(範本也是這樣寫)。
            寫成 `{...panelResize.props}` 的話 resizable 會是 undefined ——
            把手畫得出來但**拖了完全沒反應**。
          */}
          <ResizeHandle
            direction="horizontal"
            resizable={panelResize.props}
            isReversed
            pillPlacement="start"
            hasDivider
            label="Resize the file preview"
            /*
             * 面板退場的那 165ms 裡把手跟著淡掉、不能拖:
             * 不擋的話正在收的那一欄還拖得動,鍵盤也 Tab 得到。
             * 留在版面裡(只有 1px 分隔線)而不是拿掉 —— 拿掉那一格會跳 1px。
             */
            isDisabled={filePanel.isLeaving}
            aria-hidden={filePanel.isLeaving || undefined}
            xstyle={filePanel.isLeaving && styles.panelHandleLeaving}
          />
          <FilePreviewPanel
            items={panel.items}
            index={panel.index}
            width={panelResize.size}
            onIndexChange={filePanel.setIndex}
            onClose={filePanel.close}
            isLeaving={filePanel.isLeaving}
          />
        </>
      ) : null}
      </HStack>
    </>
  );
}

/**
 * 置中版面底下的分類與範例(照 ai-chat-landing 範本:
 * `ToggleButtonGroup` 選分類 → `Grid` 的 `ClickableCard` 範例)。
 * 四個分類(Research / Writing / Coding / Creative)的
 * 內容是這個工具使用者的日常:標題講用途(介面語言英文),
 * `prompt` 是點下去填進輸入框的**中文問句** —— 問 AI 本來就是用中文問的。
 */
const LANDING_CATEGORIES = [
  {key: 'research', label: 'Research', icon: Search},
  {key: 'writing', label: 'Writing', icon: PenLine},
  {key: 'coding', label: 'Coding', icon: Code2},
  {key: 'creative', label: 'Creative', icon: Lightbulb},
] as const;

const CATEGORY_SUGGESTIONS: Record<
  string,
  Array<{heading: string; body: string; prompt: string}>
> = {
  research: [
    {
      heading: 'Trace a request flow',
      body: '一個功能從畫面到資料庫怎麼走',
      prompt: '這個功能從畫面送出到寫進資料庫,中間經過哪些檔案?(請給功能或檔名)',
    },
    {
      heading: "Find a value's source",
      body: '畫面上的值是從哪裡算出來的',
      prompt: '畫面上這個欄位的值是從哪裡算出來的?(請給畫面或欄位名稱)',
    },
    {
      heading: 'Debug a failing job',
      body: '背景工作失敗要從哪裡查',
      prompt: '背景工作跑失敗的時候,要從哪裡查是卡在哪一步?',
    },
    {
      heading: 'Compare two versions',
      body: '兩個版本差在哪',
      prompt: '這兩個版本的差異在哪裡?(請給分支或 commit)',
    },
  ],
  writing: [
    {
      heading: 'Draft a spec document',
      body: '產出一份功能規格書',
      prompt: '幫我寫一份這個功能的規格書:(請描述功能)',
    },
    {
      heading: 'Write an SOP',
      body: '把操作流程整理成 SOP',
      prompt: '幫我把這個操作流程整理成一份 SOP:',
    },
    {
      heading: 'Prepare handover notes',
      body: '把修改內容整理成交接文件',
      prompt: '幫我把這次的修改內容整理成交接文件:',
    },
    {
      heading: 'Summarize a document',
      body: '長文件濃縮成重點',
      prompt: '幫我摘要這份文件的重點:',
    },
  ],
  coding: [
    {
      heading: 'Trace the code',
      body: '追一段程式的邏輯',
      prompt: '幫我 trace 這段程式的邏輯:(請給檔名或函式名稱)',
    },
    {
      heading: 'Explain this snippet',
      body: '這段程式在做什麼',
      prompt: '解釋下面這段程式在做什麼:',
    },
    {
      heading: 'Locate an error message',
      body: '找出錯誤訊息的來源',
      prompt: '幫我找出這個錯誤訊息是從哪裡發出來的:',
    },
    {
      heading: 'Find where to change',
      body: '要改的地方在哪些檔案',
      prompt: '我想改這個行為,要動哪些地方?(請描述要改什麼)',
    },
  ],
  creative: [
    {
      heading: 'Design a training exercise',
      body: '出一題新人教育訓練的練習',
      prompt: '幫我設計一題新人教育訓練的練習題,主題是:',
    },
    {
      heading: 'Brainstorm test cases',
      body: '想幾個要測的情境',
      prompt: '幫我列出這個功能上線前要測的情境:',
    },
    {
      heading: 'Draw a text flowchart',
      body: '流程畫成文字版流程圖',
      prompt: '幫我把這個流程畫成文字版的流程圖:',
    },
    {
      heading: 'Write a release note',
      body: '功能上線的公告怎麼寫',
      prompt: '幫我寫一段功能上線的公告:',
    },
  ],
};

/**
 * 換分類時,舊卡片先收掉再換 —— 這個數要跟 `styles.suggestionsFade` 的淡出
 * 同一階(`--duration-fast` = 125ms)。短了會在還看得見的時候抽換內容,
 * 長了會空一拍。⚠️ **改 CSS 那半就要改這裡**(同 `NOTICE_EXIT_MS` 的寫法)。
 */
const SUGGESTION_SWAP_MS = 125;

function LandingCategories({onPick}: {onPick: (prompt: string) => void}) {
  const [category, setCategory] = useState<string | null>(null);
  /*
   * `drawn` 是**現在畫在格子裡的那一組**,它落後 `category` 一個淡出的時間。
   *
   * 換分類不能直接抽換內容:`1fr` 追的是內容高度,而 `grid-template-rows` 的
   * 計算值從頭到尾都是 `1fr`(沒有變),所以新舊高度差**不會補間、會在同一幀跳完**。
   * 作法是先把內容收掉(這時高度還是舊的,但已經看不見),再換、再放進來 ——
   * 那一下高度跳動發生在 opacity 0 的時候。
   *
   * 關掉的時候 `drawn` **故意留著**:卡片留在被夾住的殼裡,再打開同一組是立刻的,
   * 也不必重掛一次 DOM(跟 `AccountSettingsDialog` 那兩顆鈕同一個作法)。
   */
  const [drawn, setDrawn] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const swapTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(swapTimer.current), []);

  const suggestions = drawn ? CATEGORY_SUGGESTIONS[drawn] : null;

  /*
   * ⚠️ 三條路要分開:**開**與**換**的節奏不一樣,混成一條就會有一邊是錯的。
   * 再按同一顆是 `null`(`ToggleButtonGroup` 的單選會給 null),走「收」。
   */
  const pickCategory = useCallback(
    (next: string | null) => {
      window.clearTimeout(swapTimer.current);
      /*
       * ⚠️ 判斷「開」還是「換」要看**殼現在是不是開著**(更新前的 `category`),
       * 不能看 `drawn` —— 收起來的時候 `drawn` 是刻意留著的上一組,
       * 拿它判斷會讓「收起來之後改按另一顆」誤走「換」那條路:
       * 卡片白等 125ms 才起跑(規格是 40ms),而殼同一幀就開始長 ——
       * `1fr` 追的是內容高度、又不會補間,於是 225ms 的開場演到一半高度換人,
       * 底下的版面跳一下。正是那條路想避免的事。
       */
      const wasOpen = category !== null;
      setCategory(next);
      if (next === null) {
        // 收:殼 165ms、內容 125ms,兩個一起跑,沒有延遲
        setShown(false);
        return;
      }
      if (!wasOpen || drawn === next) {
        // 開(含「關到一半又打開同一組」):殼與內容同一幀起跑,transition 自己從當下的值接。
        // 從收起來的狀態換一組也走這裡 —— 那一下抽換發生在 opacity 0、殼高度 0 的時候。
        setDrawn(next);
        setShown(true);
        return;
      }
      // 換(殼開著):先收,`SUGGESTION_SWAP_MS` 之後才換內容
      setShown(false);
      swapTimer.current = window.setTimeout(() => {
        setDrawn(next);
        setShown(true);
      }, SUGGESTION_SWAP_MS);
    },
    [category, drawn],
  );

  /*
   * ⚠️ 版面**逐項照 ai-chat-landing 範本**:
   * 範本是 `VStack gap={6}` + `paddingInline: spacing-3`,分類籤**靠左**、
   * 卡片是預設長相的 `ClickableCard`(標題用 `Heading level={4}`)。
   * 不要把籤包進 `Center` 置中、不要給卡片 muted + padding —— 都跟範本不一樣。
   * 圖示照範本包 `Icon`(不裸畫 lucide,這樣它才吃設計系統的尺寸與顏色類)。
   */
  return (
    <VStack gap={0} xstyle={[styles.landingBlock, styles.landingCategories]}>
      <ToggleButtonGroup
        label="Category"
        value={category}
        onChange={pickCategory}
        size="lg"
        // 手機版折成兩排:
        // 設計系統的群組是不換行的 inline-flex,375 寬放不下四顆 lg 籤,
        // 第四顆 Creative 會被切在畫面外。仍然靠左,跟範本一樣。
        xstyle={styles.categoryChips}
      >
        {LANDING_CATEGORIES.map((cat) => (
          <ToggleButton
            key={cat.key}
            value={cat.key}
            label={cat.label}
            icon={<Icon icon={cat.icon} size="sm" />}
            // 顏色 + 漂浮框(見 LANDING_CHIP)
            {...LANDING_CHIP}
          />
        ))}
      </ToggleButtonGroup>

      {/*
        殼(往下長)→ clip(夾住)→ 內容(範本的那 24px 間距 + 淡入 + 輕微回彈)。
        ⚠️ `inert` 要跟著關 —— 收起來的卡片還在 DOM 裡,不擋掉的話 Tab 會跑進
        看不見的四顆按鈕(同 `AccountSettingsDialog` 的 `actionsClip`)。
      */}
      <Stack xstyle={[growStyles.shell, category !== null && growStyles.open]}>
        {/* `inert` 看 `shown` 不看 `category`:換分類的那 125ms 內容是透明的,
            但仍然在 DOM 裡 —— 看 `category` 的話那段時間 Tab 得進看不見的卡片。 */}
        <Stack xstyle={growStyles.clip} inert={!shown}>
          <Stack xstyle={[styles.suggestionsFade, shown && styles.suggestionsFadeShown]}>
            {suggestions ? (
              <Grid columns={{minWidth: SUGGESTION_MIN_WIDTH}} gap={3}>
                {suggestions.map((suggestion) => (
                  <ClickableCard
                    key={suggestion.heading}
                    label={suggestion.heading}
                    onClick={() => onPick(suggestion.prompt)}
                    /*
                     * 範例卡也要浮起來。**不給 `pill`** ——
                     * 卡片本身就有底色與自己的圓角,再蓋一層等於變成另一張卡;
                     * 這裡只要浮起與影子(見 global.css 的 data-hover-lift)。
                     */
                    {...{'data-hover-lift': ''}}
                  >
                    <VStack gap={0.5}>
                      <Heading level={4}>{suggestion.heading}</Heading>
                      <Text type="supporting" color="secondary">
                        {suggestion.body}
                      </Text>
                    </VStack>
                  </ClickableCard>
                ))}
              </Grid>
            ) : null}
          </Stack>
        </Stack>
      </Stack>
    </VStack>
  );
}

/**
 * 空白狀態的招呼(小字 + display-2 大標)。**本體在 `components/Landing.tsx`** ——
 * AskME 那一欄用的是同一份,兩邊顯示要一樣,各寫一份就會慢慢分岔。
 * `knowledge_bases[].suggestions` 後端照回、前端不畫。
 */
function Landing({name}: {name?: string}) {
  return <SharedLanding name={name} maxWidth={LANDING_WIDTH} />;
}

/**
 * 便條(`NoteBubble`)。
 *
 * **長相跟一般提問一樣**,不另外做滿寬的品牌色淡底:
 * 便條就是使用者在同一個輸入框打出來的一句話,長得跟他打的其他句子不一樣
 * 反而奇怪。分辨靠內文裡的藍色 @ token(輸入框看到什麼,送出後就是什麼)
 * 加上 hover 時 metadata 那個「@ Note」記號。
 * DOM id = `note-{id}`(jumpToTurn 會用)。
 */
/**
 * 訊息串裡的附件要用的兩件事(見 `Chat` 裡那個 `attachments` 的註解)。
 */
type Attachments = {
  /** 這個檔案在燈箱那條的第幾個;**-1 = 開不了**,照舊給下載連結 */
  indexOf: (kind: 'upload' | 'output', sessionId: string, name: string) => number;
  open: (index: number) => void;
};

/**
 * 送出時附上去的檔案,畫成一顆 `Token`(設計系統 `ai-chat` 範本的形狀)。
 *
 * 範本裡的 Token 是純標籤;這裡讓它**點得開** —— 燈箱與檔案區都做好了,
 * 一個看得到檔名卻打不開的標籤只會讓人再去翻檔案區。
 * 開不了的(壓縮檔、檔案已經不在)退回下載連結,圖示也跟著換成下載箭頭
 * —— 圖示要對得上按下去會發生的事。
 */
function AttachmentToken({
  kind,
  sessionId,
  name,
  attachments,
}: {
  kind: 'upload' | 'output';
  sessionId: string;
  name: string;
  attachments: Attachments;
}) {
  const index = attachments.indexOf(kind, sessionId, name);
  if (index >= 0) {
    return (
      <Token
        label={name}
        icon={<AttachmentIcon name={name} />}
        onClick={() => attachments.open(index)}
      />
    );
  }
  return (
    <Token
      label={name}
      icon={<Icon icon={Download} size="sm" />}
      href={kind === 'upload' ? uploadUrl(sessionId, name) : fileDownloadUrl(sessionId, name)}
    />
  );
}

/**
 * 這一題**產出**的檔案,畫成一張卡(設計系統 `ai-chat` 範本的 `ArtifactCard`:
 * `ClickableCard` + 圖示 + 檔名 + 一行類別 + 右邊的箭頭)。
 *
 * ⚠️ 不要縮成一排 `size="sm"` 的小按鈕。範本把**產出物**做成卡是有道理的:
 * 那是這一題的**成果**,不是附註 —— 一份跑了十分鐘才生出來的文件,
 * 跟旁邊的「複製」長得一樣大,人是看不到它的。
 * 送出去的附件維持 Token(它是輸入,不是成果),兩者的份量本來就不一樣。
 */
function OutputFileCard({
  sessionId,
  name,
  attachments,
}: {
  sessionId: string;
  name: string;
  attachments: Attachments;
}) {
  const index = attachments.indexOf('output', sessionId, name);
  const kind = describeFileKind(name);

  if (index < 0) {
    // 看不了的(壓縮檔)或已經不在的:一樣是卡,但點下去是下載
    return (
      <ClickableCard
        label={`Download ${name}`}
        href={fileDownloadUrl(sessionId, name)}
        variant="muted"
        padding={3}
        maxWidth={OUTPUT_CARD_WIDTH}
      >
        <HStack gap={3} vAlign="center" width="100%">
          <Icon icon={Download} size="md" />
          <StackItem size="fill">
            <VStack gap={0}>
              <Text type="label" xstyle={styles.outputCardName}>{name}</Text>
              <Text type="supporting" color="secondary">
                {kind} · Download
              </Text>
            </VStack>
          </StackItem>
          <Icon icon={ChevronRight} size="sm" />
        </HStack>
      </ClickableCard>
    );
  }

  return (
    <ClickableCard
      label={`Open ${name}`}
      onClick={() => attachments.open(index)}
      variant="muted"
      padding={3}
      maxWidth={OUTPUT_CARD_WIDTH}
    >
      <HStack gap={3} vAlign="center" width="100%">
        <AttachmentIcon name={name} size="md" />
        <StackItem size="fill">
          <VStack gap={0}>
            <Text type="label" xstyle={styles.outputCardName}>{name}</Text>
            <Text type="supporting" color="secondary">
              {kind}
            </Text>
          </VStack>
        </StackItem>
        <Icon icon={ChevronRight} size="sm" />
      </HStack>
    </ClickableCard>
  );
}

/** 卡片那行副標寫的類別。靠 `lib/filekind.ts` 那份單一事實來源,不要各處各判一次。 */
function describeFileKind(name: string): string {
  if (isImageFilename(name)) return 'Image';
  if (isOfficeFilename(name)) return 'Document';
  if (isPdfFilename(name)) return 'PDF';
  return 'File';
}

/** 檔案類型的圖示。跟 `FilesDialog` 同一組對應,靠 `lib/filekind.ts` 那份單一事實來源。 */
function AttachmentIcon({name, size = 'sm'}: {name: string; size?: IconSize}) {
  if (isImageFilename(name)) return <Icon icon={FileImage} size={size} />;
  if (isOfficeFilename(name)) return <Icon icon={FileSpreadsheet} size={size} />;
  return <Icon icon={FileText} size={size} />;
}

/**
 * 一則便條(@ 同事的那種)。
 *
 * ⚠️ **memo 過的,不要拿掉**(效能)—— 跟 `Turn` 同一條理由:
 * 便條不受串流影響,但沒有 memo 的話串流每一幀都會把它們全部重畫一次。
 * 三個 prop 之中 `attachments` 是 `Chat` 裡的 `useMemo`,不要改成每次新建。
 */
const NoteBubble = memo(function NoteBubble({
  note,
  attachments,
  username,
  // ⚠️ `peopleVersion` 刻意不解構,理由同 `Turn`(便條裡的 @ 膠囊也是自己查名冊的)
}: {
  note: NoteItem;
  attachments: Attachments;
  username: string | undefined;
  /** 只為了讓名冊更新時 memo 失效,見 `TurnProps.peopleVersion` */
  peopleVersion: number;
}) {
  /**
   * `mentioned_names` **現在的**後端一定給(沒 @ 到人就是空物件)——
   * 但 `?.` 不能拿掉:前後端不一定同一秒上線,
   * 舊版後端沒有這個欄位,少了它整頁會被 ErrorBoundary 接走。
   *
   * 查不到顯示名稱就用帳號 —— 被 @ 的人自己打開時,`/api/shareable-users`
   * 會把他排除掉,所以那份名單裡查不到他自己(後端才會另外給這個對照表)。
   */
  const tokens = note.mentioned.map((u) => mentionToken(u, note.mentioned_names?.[u] ?? ''));
  const mine = isMine(note.author, username);

  /*
   * 長相**跟一般提問一樣**:右側、有底的泡泡、別人的掛頭像、
   * 時間滑過才出現 —— 每一個插槽都對齊 Turn 那邊的提問泡泡,改那邊記得
   * 一起改這邊。分辨這是便條靠內文裡的藍色 @ token(輸入框裡看到什麼,送出後就是什麼)。
   */
  return (
    <ChatMessage
      /*
       * ⚠️ **別人的靠左、自己的靠右**。
       * `sender` 是設計系統唯一控制左右的旋鈕,所以別人的走 'assistant'
       * —— 那只決定**邊**,泡泡的長相由底下 `variant="filled"` 決定,
       * 所以看起來仍然是提問泡泡(保持提問泡泡的樣子,只換邊)。
       */
      sender={mine ? 'user' : 'assistant'}
      // 跳轉的落點(note-{id})
      id={`note-${note.id}`}
      {...JUMP_ANCHOR}
      avatar={
        mine ? undefined : (
          <TurnPersonAvatar
            username={note.author ?? ''}
            displayName={note.author_name}
          />
        )
      }
    >
      {/* 便條的附件跟提問的附件同一個位置:泡泡上面一排 Token。
          走 uploads 不是 files —— 那是給**被 @ 的人**看的東西 */}
      {note.attachments && note.attachments.length > 0 && note.attachment_sid ? (
        <HStack gap={1} wrap="wrap">
          {note.attachments.map((name) => (
            <AttachmentToken
              key={name}
              kind="upload"
              sessionId={note.attachment_sid as string}
              name={name}
              attachments={attachments}
            />
          ))}
        </HStack>
      ) : null}
      <ChatMessageBubble
        /*
         * ⚠️ **泡泡上面不掛名字**,滑到頭像上才顯示。
         * 「這句是誰說的」由**頭像 + 它的浮層**回答;頭像已經是靠左那一側
         * 唯一的視覺標記,名字再寫一次是重複。
         * ⚠️ 報讀軟體不受影響:`Avatar` 的 name/tooltip 會進可及性名稱。
         */
        // 時間跟提問一樣滑過才出現;多一個 @ 記號講「這是便條」——
        // 平常不佔畫面,想確認的時候滑過去就有
        metadata={
          <Stack data-hover-reveal="" xstyle={styles.metaFlushEnd}>
            <ChatMessageMetadata
              timestamp={
                <Timestamp value={parseServerTime(note.created_at).toISOString()} format="time" />
              }
              footer={
                <HStack gap={1} vAlign="center">
                  <Icon icon={AtSign} size="sm" />
                  <Text type="supporting" color="secondary">
                    Note
                  </Text>
                </HStack>
              }
            />
          </Stack>
        }
      >
        {/* @ 膠囊滑過去看得到名字與職稱 —— 見 MentionedText 的說明 */}
        <MentionedText text={note.body} tokens={tokens} />
      </ChatMessageBubble>
    </ChatMessage>
  );
});

/**
 * 提問的文字。
 */
function QuestionText({text}: {text: string}) {
  /*
   * 換行照打的時候那樣分(手機的 Enter 是換行,多行提問很常見):
   * 不然泡泡會把 `\n` 當空白、整段擠成一行。只改顯示,送出去的字本來就有換行。
   */
  return <Stack xstyle={styles.questionLines}>{text}</Stack>;
}

/** 複製結果:成功與否決定按鈕要不要打勾(toast 由呼叫端那一份發)。 */
type CopyFn = (text: string, what: 'question' | 'answer') => Promise<boolean>;

/** 打勾停留多久。跟著一則 toast 一起出現,不需要比它久。 */
const COPIED_MS = 1500;

/**
 * 複製鈕:成功後圖示換成打勾 1.5 秒,toast 照舊(手機上只有 toast 的話,
 * 它疊在輸入框上、離手指很遠,像是沒反應)。失敗就不打勾,只有呼叫端那則要手動關的錯誤 toast。
 * label 跟著換,報讀程式也聽得到「Copied」。
 */
function CopyButton({text, what, onCopy}: {text: string; what: 'question' | 'answer'; onCopy: CopyFn}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      label={copied ? 'Copied' : what === 'question' ? 'Copy question' : 'Copy answer'}
      icon={<Icon icon={copied ? Check : Copy} size="sm" />}
      size="sm"
      variant="ghost"
      onClick={() => {
        // 連按:先收掉上一次的打勾,讓計時從這一次重新算
        setCopied(false);
        void onCopy(text, what).then((ok) => ok && setCopied(true));
      }}
    />
  );
}

/**
 * 回答旁邊那顆頭像。
 *
 * 不把**提問泡泡**改成品牌色淡底來拉開對比:設計系統的
 * `ChatMessageBubble` 只有 `filled` / `ghost` 兩種,要品牌色就得覆寫佈景,
 * 這個專案不覆寫佈景。**用結構分辨**:提問是有底的泡泡、回答是 ghost +
 * 一顆頭像,這正是設計系統 `ai-chat` 範本自己的做法(它用 `<Avatar name="Agent">`)。
 *
 * 頭像是**自己畫一顆跟 Avatar 同尺寸的圓,中間放 Logo**,因為三個條件:
 * 要是 logo 不是字母(所以不用 `<Avatar name>`)、要跟內容對齊(所以要有 Avatar
 * 的圓形尺寸,裸 `Logo` 對不齊)、不能是 `NavIcon` 那種全黑底。
 * ⚠️ 尺寸的唯一來源是檔頭的 `AVATAR_PX`,spacer(見下)也用同一個常數 ——
 * 兩邊不同就會歪。
 */
function AssistantAvatar() {
  return (
    <Stack
      hAlign="center"
      vAlign="center"
      xstyle={[styles.avatarBox, styles.assistantAvatar]}
      aria-hidden
      /*
       * 「跳到這一則」的彩虹框要**把這顆頭像圈進去**。
       *
       * 它靠 `avatarBox` 的負邊距懸在內容欄左邊的留白裡,整顆都在
       * `<article>` 的 border box **外面** —— 而 `getBoundingClientRect()`
       * 回的就是 border box。所以自己標一個記號,由 `JumpSpotlight.measure()`
       * 把它聯集進去(那邊有完整說明)。
       */
      {...{'data-spotlight-include': ''}}
    >
      <Logo size={20} />
    </Stack>
  );
}

/**
 * 同事的頭像 + 「這個人是誰」的浮層。
 *
 * **幾何跟 `AssistantAvatar` 完全一樣**:AI 那顆用 `styles.avatarBox` 的負邊距
 * **懸在內容欄左邊的留白裡**,所以 AI 的文字左緣跟提問泡泡對齊;同事那顆若是
 * 一顆裸的 `Avatar`,它**真的佔一格**,整塊會被往右推 —— 兩則訊息一前一後。
 * 套同一份 `avatarBox` 兩邊的內容欄才落在同一條線上。
 *
 * ⚠️ 頭像與職稱都**自己從 `peopleDirectory` 查**,不由呼叫端傳進來:
 * 從 `Chat` 穿過 `TurnProps` / `NoteBubble` 一路傳下來,就得在 `Chat`
 * 抓第二份名冊 —— 兩份名冊、兩支請求,而且膠囊那一路與這一路解析出來的
 * 名字會不一樣。名冊只有一份。
 */
function TurnPersonAvatar({
  username,
  displayName,
}: {
  username: string;
  displayName?: string | null;
}) {
  return (
    <Stack
      xstyle={styles.avatarBox}
      // 跟 AI 那顆同一個理由:它懸在 article 的 border box 外面,
      // 「跳到這一則」的框要自己把它聯集進去
      {...{'data-spotlight-include': ''}}
    >
      {/*
        ⚠️ 這裡只剩**版面**。頭像本身(誰、什麼名字、什麼底色、滑上去看到什麼)
        在 `components/PersonDisplay.tsx`,跟 @ 膠囊、那張卡片放在一起 ——
        它們三個對同一個帳號必須給出同一個名字,分在兩個檔案就很容易對不齊。

        `avatarBox` 留在這邊是刻意的:那是聊天串的幾何(要跟 AI 頭像對齊的
        負邊距),AI 那顆也吃同一份,搬走只會讓它跨兩個檔案。
      */}
      <PersonAvatar username={username} fallbackName={displayName} size={AVATAR_PX} />
    </Stack>
  );
}

/**
 * 佔位用的隱形頭像。
 *
 * 執行過程(工具時間軸)跟答案拆成兩則 `ChatMessage`(頭像跟回答平行,
 * 不是跟工具平行)—— 時間軸那一則掛這顆隱形的,內容欄才會跟
 * 答案那一則對齊(沒有 avatar 的 ChatMessage 不縮排)。
 * `visibility: hidden` 而不是不渲染:要佔位;`aria-hidden` 由樣板保證(整顆隱形)。
 */
function AssistantAvatarSpacer() {
  return <Stack xstyle={[styles.avatarBox, styles.assistantAvatarSpacer]} aria-hidden />;
}

type TurnProps = {
  turn: HistoryItem;
  username?: string;
  /**
   * `peopleDirectory` 的版本號。**畫面上沒有任何地方用得到它** ——
   * 它存在的唯一理由是讓名冊更新時 `memo` 失效(見 `Chat` 裡 `usePeopleDirectory()`
   * 那段)。看起來沒用就刪掉的話,頭像與名字會停在帳號不動。
   */
  peopleVersion: number;
  /** 有題目正在跑 —— 這時候「重試」要 disabled,不然會排隊排到自己後面 */
  isSending: boolean;
  onEdit: (question: string) => void;
  onRetry: (question: string) => void;
  onCopy: CopyFn;
  /** 產出的檔案要開燈箱還是直接下載,由它決定(見 `AttachmentButton`) */
  attachments: Attachments;
  /** 這一題存過筆記(書籤實心) */
  isSavedToNotes: boolean;
  /** 存到筆記。⚠️ 傳 `notesSave.save` 本身(參照穩定),不要包箭頭函式 —— 會打穿 memo。沒給 = 筆記功能關著,不畫書籤鈕 */
  onSaveToNotes?: (qaId: number, kind: SaveKind) => void;
};

/**
 * 已經答完的一則問答。
 *
 * ⚠️ **memo 過的,不要拿掉**(效能)。正在跑的那一題每送來一個 delta
 * 都會讓 `Chat` 整棵樹重繪(`subscribeAll(bumpStream)`);沒有 memo 的話,
 * 上面**每一則**答完的問答都要跟著重跑一次 `parseSources` + 兩次
 * `parseOutputFiles` + 整段 Markdown 重新解析 —— 而它們的內容一個字都沒變。
 *
 * memo 有**兩個方向**都會安靜地出錯,改 props 之前兩邊都要想過:
 *
 * ⚠️ **關不起來**:props 的參照一旦每次 render 都新建,這層 memo 就整個失效,
 * 而且不會有任何錯誤訊息,只會慢慢變回原來那樣。目前是這樣穩住的 ——
 * `onEdit` / `onRetry` / `onCopy` 是空相依的 `useCallback`;
 * `attachments` 是 `useMemo`。
 *
 * ⚠️ **該開的時候沒開**:元件裡如果讀了「不是從 props 進來」的東西,那東西變了
 * memo 不會知道,畫面就停在舊值。例如頭像與名字是
 * `PersonDisplay` 自己去 `peopleDirectory` 查的,所以要靠 `peopleVersion`
 * 這個 prop 把名冊的變動帶進來(見 `TurnProps.peopleVersion`)。
 */
const Turn = memo(function Turn({
  turn,
  username,
  // ⚠️ `peopleVersion` **刻意不解構** —— 它只是拿來讓 memo 失效的(見 `TurnProps`),
  // 元件裡沒有人要讀它。解構了反而會是 TS6133(宣告了沒用到)。
  isSending,
  onEdit,
  onRetry,
  onCopy,
  attachments,
  isSavedToNotes,
  onSaveToNotes,
}: TurnProps) {
  const mine = isMine(turn.asked_by, username);
  /*
   * 三個都是解字串(JSON.parse / 切欄位)。memo 已經擋掉絕大多數的重繪了,
   * 這裡再包一層是為了 `isSending` 翻面那兩次 —— 那是整串對話**唯一**會
   * 一起重繪的時機(送出、答完各一次),不必順便把所有欄位重解一遍。
   */
  const sources = useMemo(() => parseSources(turn.sources), [turn.sources]);
  const outputFiles = useMemo(() => parseOutputFiles(turn.output_files), [turn.output_files]);
  const uploadedFiles = useMemo(
    () => parseOutputFiles(turn.uploaded_filename),
    [turn.uploaded_filename],
  );

  return (
    <>
      <ChatMessage
        /*
         * ⚠️ **別人的靠左、自己的靠右**。
         * `sender` 是設計系統唯一控制左右的旋鈕;泡泡的長相由底下的
         * `variant="filled"`(預設值)決定,所以換邊之後仍然是提問泡泡的樣子。
         * 跟 `NoteBubble` 同一條 —— 那兩種訊息的每個插槽都要對齊,改一邊記得改另一邊。
         */
        sender={mine ? 'user' : 'assistant'}
        /*
         * 跳轉的落點(`turn-{qaId}`,便條那邊是 `note-{id}`)。
         * 掛在**提問**這一則上,不是答案:跳過去要從問題開始讀。
         */
        id={`turn-${turn.id}`}
        {...JUMP_ANCHOR}
        avatar={
          mine ? undefined : (
            <TurnPersonAvatar
              username={turn.asked_by ?? ''}
              displayName={turn.asked_by_name}
            />
          )
        }
      >
        {/*
          送出時附上去的檔案,畫在泡泡**上面**一排 —— 這是設計系統 `ai-chat`
          範本自己的形狀(`<ChatMessage><HStack><Token/></HStack><ChatMessageBubble>`)。
          ⚠️ 靠 `HistoryItem.uploaded_filename` —— 型別少了它,附件送出去之後
          在訊息串上就消失,只有檔案區找得到。
          點得開:走跟產出檔案同一條燈箱(附件是 uploads/,不是 files/)。
        */}
        {uploadedFiles.length > 0 ? (
          <HStack gap={1} wrap="wrap">
            {uploadedFiles.map((name) => (
              <AttachmentToken
                key={name}
                kind="upload"
                sessionId={turn.session_id}
                name={name}
                attachments={attachments}
              />
            ))}
          </HStack>
        ) : null}
        <ChatMessageBubble
          /*
           * ⚠️ **泡泡上面不掛名字**,滑到頭像上才顯示。
           * 「這句是誰說的」由靠左那顆頭像 + 它的浮層回答(名字 · 職稱);
           * 別人的訊息已經在另一側,左右本身就是最強的訊號,名字再寫一次是重複。
           * 帳號(`ming` 與 `ming2` 只有帳號分得出來)也在那個浮層裡問得到。
           */
          /*
           * 自己的:時間與「修改重問」平常收起來,滑過或 Tab 進來才出現。
           * 「修改重問」**只給自己的** —— 那是改自己問題用的動作,
           * 改別人的問題再送出去只會變成你自己問了一題一樣的。
           *
           * 這一排走設計系統的 `ChatMessageMetadata`(它自己會依 sender 反向排列),
           * 不要自己拿 HStack 排一個 —— 對齊與間距是它的事。
           */
          metadata={
            /*
             * 時間 + 複製 + 修改重問:**整排滑到泡泡上才出現**(時間不常駐)。
             * 開關在 global.css 的 `[data-hover-reveal]`:滑到**整則訊息**
             * (article:hover)或焦點進來(:focus-within)才亮 —— 只掛在這一排
             * 自己身上的話,指標要先找到一排看不見的東西才能讓它出現。
             * 「修改重問」仍然只給自己的;複製問題兩種都給。
             */
            <Stack data-hover-reveal="" xstyle={styles.metaFlushEnd}>
              <ChatMessageMetadata
                timestamp={
                  // 只講時間(範本的 format="time"):日期由分隔線講,這裡再講一次是雜訊
                  <Timestamp value={parseServerTime(turn.created_at).toISOString()} format="time" />
                }
                footer={
                  <HStack gap={1} vAlign="center">
                    <CopyButton text={turn.question} what="question" onCopy={onCopy} />
                    {mine ? (
                      <IconButton
                        label="Edit and ask again"
                        icon={<Icon icon={Pencil} size="sm" />}
                        size="sm"
                        variant="ghost"
                        onClick={() => onEdit(turn.question)}
                      />
                    ) : null}
                  </HStack>
                }
              />
            </Stack>
          }
        >
          <QuestionText text={turn.question} />
        </ChatMessageBubble>
      </ChatMessage>

      {/*
        結構照 `ai-chat` 範本:`ChatToolCalls` 與 `ChatMessageMetadata` 是
        `ChatMessage` 的**直接子層**,不塞進泡泡裡 —— 範本的泡泡只裝文字,
        工具時間軸、產出卡、動作列各自成段。
      */}
      {/*
        執行過程自己一則(掛**隱形**頭像佔位),答案另一則掛真頭像 ——
        頭像要跟回答平行,不是跟工具平行。ChatMessage 的頭像
        對齊的是這一則的第一個子層,時間軸在同一則裡就一定貼著它。
      */}
      {/* 沒讀任何檔案就整段不畫,也不寫「This answer did not read any files.」:
          沒發生的事不用特別講 */}
      {sources.length > 0 ? (
        <ChatMessage sender="assistant" avatar={<AssistantAvatarSpacer />}>
          {/* 執行過程排在答案上面;左緣對齊答案的第一行(styles.toolIndent) */}
          <Stack xstyle={styles.toolIndent}>
            <ChatToolCalls
              calls={toToolCalls(sources, FINISHED_STEP_LIMIT, turn.duration_ms)}
              label={
                turn.duration_ms
                  ? `Referenced ${sources.length} source${sources.length === 1 ? '' : 's'} · ${formatDuration(turn.duration_ms)}`
                  : `Referenced ${sources.length} source${sources.length === 1 ? '' : 's'}`
              }
            />
          </Stack>
        </ChatMessage>
      ) : null}

      <ChatMessage
        sender="assistant"
        avatar={<AssistantAvatar />}
        /*
         * 答案自己的落點。
         *
         * 檔案區跳過來時要看的是**那個檔案在哪裡出現**:AI 產出的檔案掛在
         * 答案這一則,跳到提問等於還要自己往下找。所以提問是 `turn-{id}`、
         * 答案是 `answer-{id}`,由檔案的 kind 決定跳哪一個
         * (見 lib/conversationFiles.ts 的 anchorId)。
         */
        id={`answer-${turn.id}`}
        {...JUMP_ANCHOR}
      >
        <ChatMessageBubble variant="ghost" width="100%">
          {turn.success ? (
            /*
             * 包一層是為了「存成截圖」:截的就是這一塊 —— 回答本身,
             * 不含頭像、產出檔案卡、底下那排按鈕(`components/SaveToNotes.tsx` 用 ANSWER_SHOT_ATTR 找它)。
             */
            <Stack width="100%" {...{[ANSWER_SHOT_ATTR]: turn.id}}>
              <AnswerContent text={turn.answer} />
            </Stack>
          ) : (
            <VStack gap={2}>
              <Banner status="error" title={turn.error ?? 'The query failed.'} />
              {/* 正在跑別題的時候不能按:按下去只會排在自己後面 */}
              <Button
                label="Retry"
                variant="secondary"
                size="sm"
                icon={<Icon icon={RefreshCw} size="sm" />}
                isDisabled={isSending}
                onClick={() => onRetry(turn.question)}
              />
            </VStack>
          )}
        </ChatMessageBubble>

        {/* 這一題產出的檔案:自己一個 ghost 泡泡(範本把 artifact 卡也這樣擺)。
            網址不經 axios(見 lib/files.ts) */}
        {outputFiles.length > 0 ? (
          <ChatMessageBubble variant="ghost" width="100%">
            <VStack gap={2}>
              {outputFiles.map((name) => (
                <OutputFileCard
                  key={name}
                  sessionId={turn.session_id}
                  name={name}
                  attachments={attachments}
                />
              ))}
            </VStack>
          </ChatMessageBubble>
        ) : null}

        {/*
          結束後的動作列:複製、存筆記、Answered、總耗時。
          失敗的那一則不掛 —— 沒有答案可以複製,它自己有一顆「重試」。
          只有一個專案,所以不寫「from <專案>」。
        */}
        {turn.success ? (
          <ChatMessageMetadata
            footer={
              // 跟答案第一行對齊
              <HStack gap={1} vAlign="center" xstyle={styles.actionIndent}>
                <CopyButton text={turn.answer} what="answer" onCopy={onCopy} />
                {/* 存到筆記:整題 / 截圖,存過就是實心 */}
                {onSaveToNotes ? <SaveAnswerMenu qaId={turn.id} isSaved={isSavedToNotes} onSave={onSaveToNotes} /> : null}
                {/*
                  動詞與整題耗時(每一則都有 duration_ms)寫在**同一段字**裡,
                  耗時那段用不斷行空白(NBSP):分成兩段的話手機寬度放不下時,耗時會被擠成獨立的
                  一欄、「3m」「0s」各一行。
                */}
                <Text type="supporting">
                  Answered
                  {turn.duration_ms
                    ? ` ·${NBSP}${formatDuration(turn.duration_ms).replace(/ /g, NBSP)}`
                    : ''}
                </Text>
              </HStack>
            }
          />
        ) : null}
      </ChatMessage>
    </>
  );
});

/**
 * @ 按鈕的人員選單:**有搜尋框,而且真的打得了字**。
 *
 * ⚠️ 不能用 `DropdownMenu` 裝搜尋框(打不了字):
 * 選單面板自己管焦點與按鍵 —— `hasAutoFocus` 進不去、對 TextInput 呼叫
 * `focus()` 也被拉走、keydown 直接被 preventDefault(那是選單的 typeahead)。
 * 換成設計系統的 `Popover`:它就是給「裡面有互動內容」的浮層用的,
 * 打開自動聚焦第一個可聚焦元素(正好是搜尋框),按鍵不會被攔。
 */
function MentionPicker({
  people,
  groups,
  onPick,
  isOpen,
  onOpenChange,
}: {
  people: ShareablePerson[];
  /** 常駐的群組:不受搜尋影響,永遠釘在清單最底下 */
  groups: Array<{key: string; label: string; usernames: string[]}>;
  /** 一次可以插好幾個人(群組就是一次一串) */
  onPick: (usernames: string[]) => void;
  /** 受控:在輸入框打 `@` 也要開得了同一顆,所以開關在 Chat 手上 */
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');

  return (
    <Popover
      isOpen={isOpen}
      onOpenChange={(open: boolean) => {
        onOpenChange(open);
        // 每次打開都是乾淨的搜尋框(跟 CommandPalette 關閉清 query 同一個理由)
        if (open) setQuery('');
      }}
      // 往上開:輸入框在畫面底部,往下開會掉出視窗外
      placement="above"
      label="Mention a colleague"
      content={
        <MentionList
          people={people}
          groups={groups.map((g) => ({
            key: g.key,
            label: g.label,
            description: `${g.usernames.length} ${g.usernames.length === 1 ? 'person' : 'people'}`,
          }))}
          query={query}
          onQueryChange={setQuery}
          onPickPerson={(username) => onPick([username])}
          onPickGroup={(key) => onPick(groups.find((g) => g.key === key)?.usernames ?? [])}
        />
      }
    >
      <Button
        label="Mention a colleague"
        tooltip="Mention a colleague"
        icon={<Icon icon={AtSign} size="sm" />}
        variant="ghost"
        size="sm"
        isIconOnly
        // 滑過去浮起一塊(見 global.css 的 data-hover-lift)
        {...COMPOSER_ACTION}
      />
    </Popover>
  );
}


/** 進行中才需要每秒重畫一次(最後一步的耗時與總時間都在長)。停了就不要再跳。 */
function useTicker(isActive: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isActive]);
  return now;
}

function PendingTurn({
  pending,
  resolveUpload,
  onOpenAttachment,
}: {
  pending: Pending;
  /** 串流中的上傳附件在燈箱那條的位置(清單還沒回來就是 null,見 Chat) */
  resolveUpload: (name: string) => {index: number | null; downloadUrl: string} | null;
  onOpenAttachment: (index: number) => void;
}) {
  const now = useTicker(!pending.done);
  const elapsed = now - pending.startedAt;
  const failure = pending.done && pending.success === false ? (pending.error ?? 'The query failed.') : null;
  /**
   * 收合起來那一行的字。跑超過一分鐘才報總時間 ——
   * 前幾秒報「已經跑了 3s」只是噪音,而一分鐘之後那個數字才是
   *「它是不是卡住了」的答案。
   */
  const runningLabel =
    elapsed > 60_000 ? `Working… · ${formatDuration(elapsed)}` : 'Working…';

  /**
   * 還要不要畫「Thinking…」那一行。
   *
   *   - **有工具還在跑 → 不畫**。工具時間軸自己就有轉圈,底下再一行 Spinner 是同一件事講兩次。
   *   - **沒有工具在跑,而且答案還沒開始、或超過 THINKING_QUIET_MS 沒長新字 → 畫**。
   *     工具結果一回來那一步就打勾、不再轉圈;「有工具就不畫」的話,工具做完、
   *     模型還在想的那段時間畫面會**完全不動**(可能十幾秒)。
   *
   * 有答案文字時畫在答案**下面**(同一個泡泡),答案一長出新字就收掉。答案本身的位置不動。
   */
  // 答案最後一次長字的時間。記在 effect 裡(render 要保持純函式),用當下的 Date.now()
  // 而不是 `now`:`now` 一秒才跳一次,拿它記會早算最多一秒。判斷時用的是 `now`,
  // 所以實際在停頓 1.5~2.5 秒之間出現(每秒重畫一次才看得到)。
  const [lastGrowthAt, setLastGrowthAt] = useState(pending.startedAt);
  useEffect(() => {
    if (pending.text) setLastGrowthAt(Date.now());
  }, [pending.text]);
  const toolRunning = pending.sources.some(
    (source, i, all) => runningStepStatus(source, i === all.length - 1, null) === 'running',
  );
  const showThinking =
    !pending.done &&
    !toolRunning &&
    (!pending.text || now - lastGrowthAt > THINKING_QUIET_MS);

  return (
    <>
      <ChatMessage sender="user">
        {/* 送出當下附件就要在泡泡上面 —— 歷史那排靠 uploaded_filename,
            串流階段歷史還沒回來,靠 pending 自己記的檔名(runs.ts) */}
        {(pending.uploadedNames?.length ?? 0) > 0 ? (
          <HStack gap={1} wrap="wrap">
            {(pending.uploadedNames ?? []).map((name) => {
              /*
               * 答題中也要點得開。檔案清單回來之後就有位置;
               * 還沒回來(start 事件前的那一兩秒)維持純標籤 —— 那時候
               * 連 session 都還不知道,沒有任何網址可以給。
               */
              const found = resolveUpload(name);
              if (found && found.index !== null) {
                const index = found.index;
                return (
                  <Token
                    key={name}
                    label={name}
                    icon={<AttachmentIcon name={name} />}
                    onClick={() => onOpenAttachment(index)}
                  />
                );
              }
              if (found?.downloadUrl) {
                return (
                  <Token
                    key={name}
                    label={name}
                    icon={<Icon icon={Download} size="sm" />}
                    href={found.downloadUrl}
                  />
                );
              }
              return <Token key={name} label={name} />;
            })}
          </HStack>
        ) : null}
        {/* 換行跟答完之後的 QuestionText 同一套,不然答完那一刻泡泡會突然變高 */}
        <ChatMessageBubble>
          <Stack xstyle={styles.questionLines}>{pending.question}</Stack>
        </ChatMessageBubble>
      </ChatMessage>

      {/*
        伺服器提醒、排隊、時間軸自己一則(隱形頭像佔位),
        串流的文字另一則掛真頭像 —— 頭像要跟回答平行。
      */}
      {pending.notices.length > 0 ||
      pending.queuePosition !== undefined ||
      pending.sources.length > 0 ? (
        <ChatMessage sender="assistant" avatar={<AssistantAvatarSpacer />}>
          {/* 左緣對齊答案的第一行(styles.toolIndent,跟已完成那則同一條理由) */}
          <Stack xstyle={styles.toolIndent} gap={2}>
            {/* 伺服器提醒排在最上面 */}
            {pending.notices.map((notice, i) => (
              <Banner
                key={i}
                status={notice.level === 'warning' ? 'warning' : 'info'}
                title={notice.message}
              />
            ))}

            {pending.queuePosition !== undefined ? (
              <Text type="supporting">
                {`Queued — ${pending.queuePosition} ahead of this one`}
              </Text>
            ) : null}

            {pending.sources.length > 0 ? (
              <ChatToolCalls
                calls={runningToolCalls(pending.sources, now, failure)}
                // 進行中直接攤開:那正是使用者盯著看「它在做什麼」的時候
                defaultIsExpanded
                label={runningLabel}
                /*
                 * 放大一級,進行中的動畫才看得清楚。
                 *
                 * ⚠️ `ChatToolCalls` **沒有 size prop**,裡面那顆轉圈的 spinner
                 * 也不是我們畫的 —— 唯一的旋鈕是 `xstyle`。用 `fontSize` 放大
                 * 而不是 `transform: scale()`:scale 會連邊框、圓角一起糊掉,
                 * 而且不佔實際版面(下面的內容不會讓位)。字級放大則是整塊
                 * 真的變大,裡面用 em 定尺寸的東西(spinner、圖示)跟著長。
                 *
                 * ⚠️ **只放大進行中那一塊**。已完成那則(`Turn` 裡的
                 * `ChatToolCalls`)刻意不動,維持設計系統的預設大小。
                 */
                xstyle={styles.runningToolCalls}
              />
            ) : null}
          </Stack>
        </ChatMessage>
      ) : null}

      <ChatMessage sender="assistant" avatar={<AssistantAvatar />}>
        {pending.text || showThinking ? (
          <ChatMessageBubble variant="ghost" width="100%">
            {pending.text ? (
              <AnswerContent
                text={pending.text}
                isStreaming={!pending.done}
              />
            ) : null}
            {showThinking ? (
              // 要會動,不然看起來像當機。Spinner 是設計系統現成的,
              // 不自己刻三顆點的動畫。
              // minHeight = 頭像的直徑,垂直置中 —— 文字的中線要跟頭像同高
              <HStack gap={2} vAlign="center" xstyle={styles.thinkingRow}>
                <Spinner size="sm" />
                <Text type="supporting">Thinking…</Text>
              </HStack>
            ) : null}
          </ChatMessageBubble>
        ) : null}

        {pending.done && pending.success === false ? (
          <Banner status="error" title={pending.error ?? 'The query failed.'} />
        ) : null}
      </ChatMessage>
    </>
  );
}
