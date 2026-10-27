/**
 * 搜尋面板。Ctrl / ⌘ + K,**側邊欄的 Search 也是開它**。
 *
 * 找舊對話的入口只有這一個;也是純鍵盤使用者的入口。
 *
 * ## ⚠️ 這裡**不用**設計系統的 `CommandPalette` 那顆殼,搜尋狀態自己持有
 *
 * 一次查詢的結果(本地標題命中 + 伺服器內文命中)要一起出現,不能先出一批再補一批。
 *
 * 那件事在那顆殼上**做不到**:它的 `runSearch` 在呼叫我們的 `search()` **之前**,
 * 會先拿關鍵字把上一批結果篩一遍當成即時回饋(`setOptimisticResults`,寫死在元件裡、
 * 沒有 prop 可以關)。所以畫面必然先變一次、伺服器的內文命中再補一次。
 * 唯一能讓它不發生的條件是「上一批是空的」,而那等於打開面板時什麼都不顯示。
 *
 * 所以**搜尋狀態改成自己持有**:本地標題命中與伺服器內文命中算完之後
 * **一次 `setRows`**,一次查詢只換一次畫面。
 *
 * ⚠️ 但**畫面上的東西仍然全是設計系統的**(`CommandPaletteInput` / `CommandPaletteList` /
 * `CommandPaletteItem` / `CommandPaletteEmpty`,外加 `Dialog` + `Layout`)——
 * 這幾個子元件都支援「沒有 context 的獨立用法」(它們讀的是 `ctx?.`),所以樣式、
 * `role`、hover 那一套全是它們的,少掉的只有「搜尋」那一段邏輯。
 *
 * ⚠️ **只有 `id` 要自己補**(`assignId`):沒有 context 時它們會把 `id` 寫成 `undefined`,
 * 而且那一行排在 `{...props}` **後面** —— 從 props 傳是傳不進去的。清單與每一列的 id 是
 * `aria-controls` / `aria-activedescendant` 的錨,少了它純鍵盤使用者就聽不到目前選到哪一列,
 * 所以改用 ref 直接寫到元素上。`CommandPaletteInput` 不必:它的 `{...props}` 在最後,
 * 我們傳的 aria 屬性會贏。
 *
 * ⚠️ 不給 context 也讓**滾輪不會被搶走**:`CommandPaletteItem` 的 hover 只有在**有 context**
 * 時才會去改選取,而被選取的那一列會 `scrollIntoView` —— 於是滾輪一轉,指標下面換成另一列
 * 就把清單拉回去。沒有 context 就沒有這條路,hover 的底色仍然是它自己的 CSS `:hover` 給的。
 * 不需要另外攔 `mouseover`。
 *
 * ## 這個面板必須守住的幾件事
 *
 *  - **一次查詢只動一次畫面**(上面那段)。這條**也管頁碼那一列** ——
 *    畫面上任何「有沒有在搜尋」的分支都看 `appliedKeyword`(現在這批結果的關鍵字),
 *    不看 `search`(輸入框當下的字),理由見 `appliedKeyword` 的宣告處。
 *    換結果一律走 `showRows()`,不要自己 `setRows`。
 *  - **上緣釘死在畫面中上**,只有下緣伸縮,而且高度要補間(`TOP_RATIO` / 高度那支 effect)。
 *  - **捲軸的位置永遠留著**(`global.css` 的 `scrollbar-gutter: stable`),
 *    不然清單從 20 列篩到 7 列、捲軸一消失,畫面會橫向抖一下。
 *  - **滑鼠 hover 不會把清單捲走**:hover 只有 CSS 的 `:hover` 換底色,
 *    **不動 `highlightedIndex`**(上面那段)。
 *  - **標題只秀 20 個字、日期釘在最右邊**,日期用 `YY/MM/DD HH:MM`(等寬,對得齊)。
 *  - **關閉要跟設定對話框一樣**(`useDialogExit` + `purpose="required"`)。
 */
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {useNavigate} from 'react-router-dom';

import {MessageSquare} from 'lucide-react';

import {Dialog} from '@astryxdesign/core/Dialog';
import {
  CommandPaletteEmpty,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
} from '@astryxdesign/core/CommandPalette';
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  VStack,
} from '@astryxdesign/core/Layout';
import {Pagination} from '@astryxdesign/core/Pagination';
import {Text} from '@astryxdesign/core/Text';
import {useAnnounce, useHotkeys} from '@astryxdesign/core/hooks';
import {useTranslator} from '@astryxdesign/core/i18n';
import {Icon} from '@astryxdesign/core/Icon';

import {
  listConversations,
  peekConversations,
  searchConversations,
  type ConversationSummary,
  type SearchHit,
} from '../lib/conversationsApi';
import {useDialogExit} from './useDialogExit';
import {formatShortDate} from '../lib/time';
import {transitionMs} from '../lib/transitionMs';

/**
 * 打完字之後隔多久去問伺服器。
 *
 * ⚠️ **這同時是「打字到畫面更新」的延遲** —— 清單是一次換上的(見檔頭),
 * 在這之前畫面完全不動。150ms 是「感覺得到立即」與「不要每個字都打一次伺服器」的折衷。
 * ⚠️ 加長到三四百毫秒,打字就會明顯感覺遲鈍 —— **不要用加長延遲的方式解任何問題**。
 */
const DEBOUNCE_MS = 150;

/** 拆「補間中」記號時,在高度補間的時長之外多等多久(補間結束那一幀跟計時器不會剛好同一刻) */
const RESIZE_MARGIN_MS = 25;

/**
 * 一頁幾組對話(底下的頁碼切換第幾頁)。
 *
 * ⚠️ **這只限「還沒打字」那一頁。** 打字之後本地過濾篩的是**全部**的對話 ——
 * 不然二十組以外的就再也找不到了。
 */
const PAGE_SIZE = 20;

/**
 * 面板上一列最多顯示幾個字。
 *
 * ⚠️ 跟後端那個 24(`app/conv_title.py` 的 `TITLE_LIMIT`)是**兩件事**:那邊管的是
 * 「標題本身是什麼」(側邊欄也吃同一份),這裡只管這個面板要秀多長。
 */
const TITLE_CHARS = 20;

/**
 * 面板的上緣要離視窗頂端多遠(佔視窗高度的比例)。
 *
 * **中上,不是置中**:小螢幕上置中的面板會落在偏下的位置。
 *
 * ⚠️ **不要改成算「置中的位置」**。量 `(innerHeight - offsetHeight) / 2` 再釘住的話,
 * 那一刻清單還沒渲染出來(面板只有輸入框那一截),算出來的是「一個很矮的面板要置中的
 * 位置」(約佔視窗高度的 40%),清單長出來之後整個面板就掉到畫面下半部去了。
 * 位置不該跟著「量的時機」跑。
 */
const TOP_RATIO = 0.12;

/** 再小的視窗也要離頂端這麼遠,不然面板會貼在邊上。 */
const MIN_TOP_PX = 24;

/** 高度正在補間 —— `global.css` 靠它把清單的捲軸暫時收起來。 */
const RESIZING = 'data-resizing';

const styles = stylex.create({
  /**
   * 左邊那顆圖示**不准被擠扁**。
   *
   * flex 子項的預設是 `flex-shrink: 1` —— 一句沒有斷點的長問句會把同一列的圖示
   * 一路壓到剩幾 px,而且每一列壓的程度不一樣,看起來就是「忽大忽小」。
   */
  icon: {
    flexShrink: 0,
  },
  /**
   * 文字那一欄要能被夾。
   *
   * ⚠️ `min-width: 0` 不能省:flex 子項的預設是 `min-width: auto`,內容多長它就多寬 ——
   * `maxLines` 的省略號永遠不會出現,而是整列被撐出去(連帶把圖示擠扁)。
   */
  lines: {
    flexGrow: 1,
    minWidth: 0,
  },
  /**
   * **整組要撐滿那一列**,日期才貼得到最右邊。
   *
   * ⚠️ `CommandPaletteItem` 的根是 `display: flex; width: 100%`,而我們放進去的東西是
   * 它的 **flex 子項** —— 子項預設 `flex-grow: 0`,所以整組 `[圖示 標題 日期]` 只有內容
   * 那麼寬,裡面再怎麼下 `width: 100%` 都只是「內容寬度的 100%」。
   */
  row: {
    flexGrow: 1,
    minWidth: 0,
  },
  /** 標題與日期那一列要撐滿,日期才貼得到最右邊 */
  headline: {
    width: '100%',
  },
  /**
   * 日期**釘在最右邊,不要跟著標題長短左右跑**。
   * 標題把剩下的空間吃完(`flexGrow`),日期自己不縮(`flexShrink: 0`)。
   */
  title: {
    flexGrow: 1,
    minWidth: 0,
  },
  when: {
    flexShrink: 0,
    /**
     * **等寬數字**,一整排日期才對得齊。
     *
     * 佈景的字體是比例字體:`1` 比 `2` 窄,所以每一列的日期實際長度都不同 ——
     * 右緣勉強對齊,但冒號與斜線的位置彼此錯開,一整排看下來就是參差的。
     * ⚠️ 只給日期,不要下在整個面板上:套上去會讓標題裡的數字(編號、版本號)變鬆散。
     */
    fontVariantNumeric: 'tabular-nums',
  },
});

/** 面板上的一列。`snippet` 有值代表這一筆是伺服器的內文命中。 */
type Row = {
  id: string;
  title: string;
  when: string;
  snippet?: string;
};

/** 超過就截斷加刪節號。`Array.from` 走碼點,不會把代理對切成半個字元。 */
function clipTitle(text: string): string {
  const chars = Array.from(text);
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('')}…` : text;
}

function toRow(c: ConversationSummary | SearchHit, snippet?: string): Row {
  return {
    id: c.conversation_id,
    title: c.title,
    when: formatShortDate(c.updated_at),
    snippet,
  };
}

export function CommandPalette({
  isOpen,
  onOpenChange: setIsOpen,
}: {
  /** 受控:⌘K 與側邊欄的 Search 共用同一個開關(`App` 持有) */
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  /*
   * 進退場跟全站其他對話框同一套:跟設定對話框一樣是 225ms 進、165ms 退
   * (不用設計系統預設的 400ms 與硬切關閉)。
   */
  const exit = useDialogExit(setIsOpen);

  /**
   * `<dialog>` 元素本身。
   *
   * ⚠️ **用 state 不用 ref**:底下的 effect 要在「元素真的掛好了」才跑,而 `ref` 的變動
   * **不會**觸發 render —— 相依只有 `[isOpen]` 的 effect 會在它還是 `null` 的時候跑一次
   * 然後再也不跑(高度那支就會整個沒作用,inline `height` 從頭到尾是空的)。
   */
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);

  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  /** 鍵盤選到第幾列。**滑鼠不會動它**(檔頭第三段)。 */
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  /** 伺服器那一半問不到 —— 要講出來,不能當成「沒有結果」 */
  const [failed, setFailed] = useState(false);

  /**
   * **現在畫面上這批 `rows` 是哪個關鍵字的結果**(空字串 = 「最近的對話」那一頁)。
   *
   * ⚠️ 畫面上任何「有沒有在搜尋」的分支都要看它,**不要看 `search`**
   * (那是輸入框當下的字)。
   *
   * 理由是兩件事的時間差:`search` 在**按鍵當下**就變了,而 `rows` 要等 `DEBOUNCE_MS`
   * (150ms)之後才換。頁碼吃 `search` 的話就會:
   *   1. 打第一個字 → 頁碼立刻消失,面板少了一列的高度;
   *      而高度是鎖著的(`el.style.height`),那支 settle effect 的相依是 `rows`、
   *      這一刻**沒有重量**,所以清單自己往下長 24px 把空位吃掉;
   *   2. 150ms 後結果回來 → `rows` 換、settle 重量 → 面板才開始縮。
   * 兩段互不相干的動作,中間還隔著 150ms,看起來就是抽動一下。
   * 看 `appliedKeyword` 的話,頁碼的消失與清單的更換**在同一次 commit**,只動一次。
   */
  const [appliedKeyword, setAppliedKeyword] = useState('');

  const listId = useId();
  const isSearching = appliedKeyword !== '';

  /*
   * 搜尋結果出來要念筆數。設計系統完整版的 `CommandPalette`
   * 會自己念,但我們是用零件拼的,那段沒接到 —— 這裡照它的做法補:同一支 `useAnnounce`、
   * 同一組字串(`@astryx.commandPalette.resultCount` / `noResultsFor`),一次查詢念一次;
   * 打開面板、清掉關鍵字、關掉面板只清空,不念。兩支都是穩定的(useCallback),放進相依不會重搜。
   */
  const announce = useAnnounce();
  const t = useTranslator();

  /**
   * **換上一批結果。四個呼叫端一律走這支,不要自己 `setRows`。**
   *
   * 「清單」與「這批是哪個關鍵字的」是同一件事的兩面(見 `appliedKeyword`)——
   * 拆開設就等於留一個「記得也要設另一個」的口頭約定,而那種約定遲早會漏一個,
   * 漏掉的那條路症狀是**頁碼跟結果對不起來**,而且不會有任何錯誤。
   * 選取位置一起歸零也是同一批:換了一批結果,上一批選到第幾列就沒有意義了。
   */
  const showRows = useCallback((keyword: string, next: Row[]) => {
    setRows(next);
    setAppliedKeyword(keyword);
    setHighlightedIndex(0);
  }, []);

  /** 熱鍵的回呼只註冊一次,`isOpen` 要用 ref 讀當下那一份 */
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  useHotkeys([
    {
      keys: 'mod+k',
      // 在輸入框裡也要能叫得出來:使用者常常打到一半才想起要找舊對話
      allowInInputs: true,
      /*
       * ⚠️ 關那一半要走 `requestClose`,不然退場來不及演(見 `useDialogExit`)。
       * ⚠️ **退場那 165ms 裡 `isOpen` 還是 `true`** —— 不先問 `cancelClose()` 的話
       * 這一按會走到「關」那一半而被吃掉,使用者要再按一次才叫得回來。
       * 取消之後面板從當下那一幀反向回來。
       */
      onPress: () => {
        if (exit.cancelClose()) return;
        if (isOpenRef.current) exit.requestClose();
        else setIsOpen(true);
      },
    },
  ]);

  /** 關掉就整個歸零 —— 下一次打開是乾淨的(不用設計系統的殼,所以它的 `handleClose` 不會幫忙做) */
  useEffect(() => {
    if (isOpen) return;
    setSearch('');
    setAppliedKeyword('');
    setPage(0);
    setHighlightedIndex(0);
    setFailed(false);
    // 上一次的「N results」不要留在無障礙樹裡
    announce('');
  }, [isOpen, announce]);

  /**
   * **一次查詢只換一次畫面。**
   *
   * 沒打字就是「最近的對話」那一頁;打了字就是「本地標題命中 + 伺服器內文命中」,
   * **兩邊都算完才 `setRows`** —— 在那之前畫面維持原樣,不會先閃一批再補一批。
   *
   * ⚠️ 只認最後一次輸入:舊的那幾次回來時直接放掉(`mine !== seq.current`),
   * 不然慢的那一次會蓋掉快的。
   * ⚠️ 中間那 150ms 畫面停在上一批結果上,這是刻意的 —— 比「先清空再填」穩得多。
   */
  const seq = useRef(0);
  useEffect(() => {
    if (!isOpen) return;
    const mine = ++seq.current;
    const keyword = search.trim();

    if (!keyword) {
      const cached = peekConversations();
      setFailed(false);
      announce('');
      if (cached.length === 0) {
        /*
         * 側邊欄還沒問到(重整後第一眼、或它掛掉了)—— 自己問一次。
         * 問不到就是空的一片:**這裡不放失敗訊息**,使用者還沒開始搜。
         */
        void listConversations()
          .then((list) => {
            if (mine !== seq.current) return;
            setTotal(list.length);
            showRows('', list.slice(0, PAGE_SIZE).map((c) => toRow(c)));
          })
          .catch(() => {});
        return;
      }
      /*
       * 有現成的就先畫,順手在背景更新一次。
       * ⚠️ 這次更新**不是餵給這一幀**(這一幀已經用手上這份畫完了)—— 它更新的是
       * `conversationsApi` 的快取,而下面的本地過濾每次都重新去 `peekConversations()` 拿。
       * 看起來像沒人用的回傳值,不是。
       */
      void listConversations().catch(() => {});
      setTotal(cached.length);
      const from = page * PAGE_SIZE;
      showRows('', cached.slice(from, from + PAGE_SIZE).map((c) => toRow(c)));
      return;
    }

    const timer = window.setTimeout(() => {
      const lower = keyword.toLowerCase();
      // 本地這一半是現成的,但**不先畫** —— 要跟伺服器那一半一起上
      const byTitle = peekConversations().filter((c) => c.title.toLowerCase().includes(lower));
      void searchConversations(keyword).then(
        (found) => {
          if (mine !== seq.current) return;
          /*
           * ⚠️ **要去重**:同一組對話會因為「問題命中」與「答案命中」回來兩次
           * (後端是逐則比對的),清單上就會出現兩條一模一樣的。標題已經命中的那幾組
           * 也不要再出現一次。
           */
          const seen = new Set(byTitle.map((c) => c.conversation_id));
          const hits: Row[] = [];
          for (const hit of found) {
            if (seen.has(hit.conversation_id)) continue;
            seen.add(hit.conversation_id);
            hits.push(toRow(hit, hit.snippet));
          }
          setFailed(false);
          const next = [...byTitle.map((c) => toRow(c)), ...hits];
          showRows(keyword, next);
          announce(
            next.length === 0
              ? t('@astryx.commandPalette.noResultsFor', {query: keyword})
              : t('@astryx.commandPalette.resultCount', {count: next.length}),
          );
        },
        () => {
          if (mine !== seq.current) return;
          /*
           * ⚠️ 抓不到**不能靜靜地當成「沒有結果」** —— 標題那一半是本地
           * 算的、照樣給,但底下要頂一句「內文沒查成」上來。
           * 這條不另外念筆數:那句「內文沒查成」本身是 role="alert",會自己念。
           */
          setFailed(true);
          showRows(keyword, byTitle.map((c) => toRow(c)));
        },
      );
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, search, page, announce, t]);

  const openConversation = useCallback(
    (id: string) => {
      navigate(`/c/${id}`);
      exit.requestClose();
    },
    [navigate, exit],
  );

  /**
   * 高度補間那段時間把清單的捲軸收起來(`global.css` 認 `data-resizing`)。
   *
   * ⚠️ **計時器放在 ref 裡,不要放在 effect 的區域變數。** 放在高度那支 effect 裡的話,
   * effect 的 cleanup 會 `clearTimeout` 它:清單在補間期間再變一次,舊的那顆就被
   * **清掉但記號沒拆**,而新的那一輪如果算出同樣的高度會提早 return、不會再排一顆 ——
   * 記號就永遠留在 `<dialog>` 上,`overflow-y: hidden` 跟著永遠有效,**滾輪從此完全沒反應**
   * (要關掉面板才會好)。記號的壽命是「最後一次寫入高度之後 N 毫秒」,
   * 跟 effect 跑幾次無關,所以它不該由 effect 的生命週期管。
   *
   * ⚠️ **只有變大才收。** 變小的時候內容本來就塞得下,不會閃捲軸 —— 而「打完字馬上想捲
   * 結果」正好是變小那一路,收了只會讓滾輪在那 150ms 裡沒反應,換來零好處。
   */
  const resizeTimer = useRef(0);
  const armResizing = useCallback((el: HTMLElement) => {
    el.setAttribute(RESIZING, '');
    window.clearTimeout(resizeTimer.current);
    // 等高度補間跑完再拆:去量面板本人的 transition(global.css 的 `--duration-fast`,這個佈景 125ms),
    // 再多留一點點(RESIZE_MARGIN_MS)就夠,不要再放大 —— 記號留越久滾輪越久沒反應
    resizeTimer.current = window.setTimeout(() => el.removeAttribute(RESIZING), transitionMs(el) + RESIZE_MARGIN_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(resizeTimer.current), []);

  /** 清單與每一列的 DOM id —— `aria-controls` / `aria-activedescendant` 的錨(見檔頭) */
  const rowId = useCallback((index: number) => `${listId}-row-${index}`, [listId]);

  /**
   * 把 `id` 寫到元素上。
   *
   * ⚠️ **不能從 props 傳** —— 見檔頭:那幾個子元件在 `{...props}` **之後**才寫
   * `id={ctx?.listId}`,沒有 context 時等於把我們傳的那個蓋成 `undefined`。
   */
  const assignId = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) el.id = id;
    },
    [],
  );

  /**
   * 鍵盤:上下移動、Enter 開啟。
   *
   * 掛在輸入框上(焦點永遠在那裡),`CommandPaletteInput` 會先叫我們這一支。
   * 被選到的那一列由 `CommandPaletteItem` 自己 `scrollIntoView({block: 'nearest'})`,
   * 所以往下按到看不見的地方會自己捲。
   * ⚠️ Escape **不在這裡**:底下那支 capture 的 effect 接,見它的註解。
   */
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const last = Math.max(rows.length - 1, 0);
      const move = (delta: number) =>
        setHighlightedIndex((at) => Math.min(Math.max(at + delta, 0), last));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setHighlightedIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setHighlightedIndex(last);
      } else if (e.key === 'Enter') {
        const row = rows[highlightedIndex];
        if (!row) return;
        e.preventDefault();
        openConversation(row.id);
      }
    },
    [rows, highlightedIndex, openConversation],
  );

  /**
   * **上緣釘死,只有下緣會伸縮**。
   *
   * `<dialog>` 是 `inset: 0` + `margin: auto` **垂直置中**的,所以打字把清單從 20 列篩成
   * 5 列時,面板是「上下同時往中間收」—— 使用者的眼睛盯著輸入框,那一下就是抽動。
   * ⚠️ 關掉要歸零,不然下一次打開會先用上一次的位置閃一下。
   */
  const [pinnedTop, setPinnedTop] = useState<number | null>(null);
  useEffect(() => {
    if (!isOpen) {
      setPinnedTop(null);
      return;
    }
    const pin = () =>
      setPinnedTop(Math.max(MIN_TOP_PX, Math.round(window.innerHeight * TOP_RATIO)));
    pin();
    window.addEventListener('resize', pin);
    return () => window.removeEventListener('resize', pin);
  }, [isOpen]);

  /**
   * **高度用補間的,不要直接跳**:結果變少時下緣要順順地往上收。
   *
   * `height` 是內容撐出來的(`auto`),而 `auto` **補不了間** —— CSS 的
   * `interpolate-size: allow-keywords` 也沒用,仍然是一步到位:
   * 它解的是「關鍵字 ↔ 長度」那種明確轉換,不是「內容變了」。所以只能自己算出明確的 px
   * 寫進去,`global.css` 那條 `transition: height` 才有東西可補。
   *
   * 怎麼算:**把 inline 的 `height` 放掉、量一次自然高度、立刻放回去**,全部在同一個
   * task 裡做完(中間不會有一幀畫出來),然後才把量到的值當成新目標寫進去。
   * `<dialog>` 本來就是 `height: fit-content` + `max-height`,所以放掉之後量到的就是
   * 「這批內容應該多高」,連上限都已經夾好了。
   *
   * ⚠️ **不要改成算「chrome + 清單的 `scrollHeight`」**:
   * 那是拿「面板現在的高」減「清單現在的高」當作固定的框架高度,而面板的高**正是我們
   * 自己鎖上去的** —— 清單縮短之後多出來的空白會被算進 chrome 裡,於是永遠算回同一個值,
   * 面板再也不會縮。
   * ⚠️ 量的時候要連 `transition` 一起暫時關掉,而且放回去之後要**先讀一次版面**
   * 再把 `transition` 開回來,不然補間會從「量到的那個值」演起。
   * ⚠️ **用 `setTimeout` 不是 `requestAnimationFrame`。** rAF 只有在頁面真的在合成畫面時
   * 才會跑 —— 在背景或內嵌的瀏覽器面板裡可能一次都不發(`visibilityState` 是 `visible`
   * 也一樣),那時候整支調整等於不存在。`Chat.jumpToTurn` 為了同一件事也是走計時器。
   * ⚠️ 補間那段時間把清單的捲軸收起來(`RESIZING`)—— **變大**時內容已經換新、面板還在長,
   * 中間那幾幀清單塞不下就會閃一條捲軸出來。
   * ⚠️ 第一次就位**不要演**,不然打開的那一下會看到面板自己往下長。
   *
   * 🚨 **量高度一律用 `offsetHeight`,絕對不要用 `getBoundingClientRect().height`。**
   *
   * `rect` **含 transform**,而這支 effect 是開啟後 16ms 跑的 ——
   * 那時候 `global.css` 的進場動畫(`dialog[data-app-dialog]`,225ms 的 scale-in)
   * 正演到大約 0.95 倍。於是「自然高度」量到的是 **480 × 0.95 = 456**,
   * 一個比真正的自然高度矮 24px 的值,還被當成目標鎖了上去。連鎖反應:
   *   1. 面板先以 480 畫出來,接著被鎖成 456 → **自己縮一段**(看起來在震動);
   *   2. 裡面的 `Layout` 還是 480,比外殼高 24px → 那 150ms 裡最後一列與頁碼
   *      **被切在面板外**(跑版)。
   * 對話越多越明顯 —— 內容超過 `maxHeight` 的帳號才會每次都撞到那個 480 上限。
   *
   * `offsetHeight` 量的是**版面高度**,transform 動不到它,所以量的時機再也不重要。
   * 代價只有「整數,沒有小數」—— 而這裡本來就 `Math.round` 過。
   */
  const didSettle = useRef(false);
  useEffect(() => {
    const el = dialogEl;
    if (!el || !isOpen) return;

    const settle = window.setTimeout(() => {
      const current = el.offsetHeight;

      // 放掉 → 量 → 放回去,同一個 task 裡做完(見上面那段)
      const locked = el.style.height;
      const wasAnimating = el.style.transition;
      el.style.transition = 'none';
      el.style.height = '';
      const next = el.offsetHeight;
      el.style.height = locked;
      el.getBoundingClientRect();
      el.style.transition = wasAnimating;

      if (next <= 0) return;

      /*
       * 第一次**一定要鎖上去**,而且不演。
       * ⚠️ 這一步不能被「高度沒變就跳過」擋掉:還沒鎖的時候面板是 `fit-content`,
       * 量到的自然高度當然等於現在的高度 —— 條件放在前面的話會**每次都跳過**,
       * 於是 inline `height` 從頭到尾是空的、`transition: height` 沒有東西可補,
       * 面板變成一步到位、完全沒有過場。
       */
      if (!didSettle.current) {
        didSettle.current = true;
        el.style.transition = 'none';
        el.style.height = `${next}px`;
        window.setTimeout(() => {
          el.style.transition = '';
        }, 0);
        return;
      }

      if (next === current) return;
      // ⚠️ 只有**變大**才收捲軸,理由見 `armResizing`
      if (next > current) armResizing(el);
      el.style.height = `${next}px`;
    }, 16);

    return () => window.clearTimeout(settle);
    /*
     * `isSearching` 也列進相依,因為頁碼那一列的存在與否吃它,而那是**高度的一部分**。
     *
     * ⚠️ 目前這一項是多餘的:`appliedKeyword` 只會在 `showRows()` 裡變,
     * 而那一支同時 `setRows(新陣列)` —— 參考每次都不同,所以 `rows` 那一項本來就一定
     * 會讓 effect 重跑,不存在「只有 `isSearching` 變」的路徑。
     * 留著是因為它便宜(高度沒變會提早 return)而且**擋得住一類改動**:
     * 哪天有人把結果做成穩定參考(例如換成 memo 過的陣列),少了這一項就會安靜地漏量。
     */
  }, [dialogEl, isOpen, rows, failed, isSearching, armResizing]);

  /** 關掉的時候把量出來的高度還回去,下一次打開才會重新量 */
  useEffect(() => {
    const el = dialogEl;
    if (!el || !isOpen) return;
    return () => {
      didSettle.current = false;
      window.clearTimeout(resizeTimer.current);
      el.style.height = '';
      el.style.transition = '';
      el.removeAttribute(RESIZING);
    };
  }, [dialogEl, isOpen]);

  /**
   * **一碰滾輪就把捲軸還回去。**
   *
   * 上面那個記號最多只該擋到補間結束,但「擋住滾輪」這件事代價太大,
   * 所以再加一道:只要使用者開始捲,不管補間演到哪裡都立刻解除。
   * ⚠️ `passive` —— 我們不擋預設行為,只是拆記號。
   */
  useEffect(() => {
    const el = dialogEl;
    if (!el || !isOpen) return;
    const release = () => {
      if (!el.hasAttribute(RESIZING)) return;
      window.clearTimeout(resizeTimer.current);
      el.removeAttribute(RESIZING);
    };
    el.addEventListener('wheel', release, {passive: true});
    return () => el.removeEventListener('wheel', release);
  }, [dialogEl, isOpen]);

  /**
   * **關閉這一條自己接**,退場才會跟 Settings 對話框一樣,不是硬切。
   *
   *  - `purpose="required"` 讓 `Dialog` 內建的 Esc 與點背景**不再自己關**
   *    (`allowEscape = purpose !== 'required'`,backdrop 同理);
   *  - Esc 與點背景改由這支 effect 在 **capture 階段**接住,`stopPropagation()` 之後
   *    元件自己的 `handleKeyDown` 就收不到了。
   *
   * ⚠️ Esc 接在 `<dialog>` 上而不是輸入框的 `onKeyDown` 裡:焦點不見得在輸入框上
   * (點過某一列之後就在那一列),而 `<dialog>` 收得到裡面所有的鍵。
   */
  useEffect(() => {
    const el = dialogEl;
    if (!el || !isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      exit.requestClose();
    };
    const onClick = (e: MouseEvent) => {
      // 只認點在背景(`<dialog>` 元素本身);點在面板內容上不算
      if (e.target !== el) return;
      e.preventDefault();
      e.stopPropagation();
      exit.requestClose();
    };
    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('click', onClick, true);
    return () => {
      el.removeEventListener('keydown', onKeyDown, true);
      el.removeEventListener('click', onClick, true);
    };
  }, [dialogEl, isOpen, exit]);

  const pageCount = Math.ceil(total / PAGE_SIZE);

  return (
    <Dialog
      /*
       * ⚠️ **關掉之後重掛一次**,把輸入框的 DOM 狀態洗乾淨(自動聚焦也靠重掛才會再跑)。
       * 跟 `AccountSettingsDialog` 用 `key` 的理由同一條。
       */
      key={isOpen ? 'open' : 'closed'}
      ref={setDialogEl}
      isOpen={isOpen}
      width={640}
      maxHeight={480}
      /* 內建的 Esc 與點背景不要自己關 —— 關閉時機由上面那支 effect 決定 */
      purpose="required"
      aria-label="Search your chats"
      {...exit.dialogProps}
      /* global.css 靠這個記號給高度補間(只有這個面板要,其他對話框高度不會變) */
      {...{'data-search-dialog': ''}}
      style={
        pinnedTop !== null
          ? ({marginBlockStart: `${pinnedTop}px`, marginBlockEnd: 'auto'} as React.CSSProperties)
          : undefined
      }
    >
      <Layout
        defaultHasDividers
        header={
          <LayoutHeader hasDivider padding={0}>
            {/* ⚠️ 只講「搜尋對話」—— 這個面板沒有命令可以跳 */}
            <CommandPaletteInput
              placeholder="Search your chats"
              value={search}
              onValueChange={(next) => {
                setSearch(next);
                setHighlightedIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              /*
               * 沒有 context,所以報讀軟體那條線要自己接。
               * ⚠️ 這裡傳得進去(跟清單與每一列不一樣):`CommandPaletteInput` 的
               * `{...props}` 排在它自己那幾個 aria 屬性**後面**,我們傳的會贏。
               */
              aria-controls={listId}
              aria-activedescendant={rows[highlightedIndex] ? rowId(highlightedIndex) : undefined}
            />
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0}>
            <CommandPaletteList label="Your chats" ref={assignId(listId)}>
                {rows.length > 0
                  ? rows.map((row, i) => (
                      <CommandPaletteItem
                        key={row.id}
                        ref={assignId(rowId(i))}
                        value={row.id}
                        isHighlighted={i === highlightedIndex}
                        onSelect={openConversation}
                      >
                        <HStack gap={2} vAlign="start" xstyle={styles.row}>
                          <Icon icon={MessageSquare} size="sm" xstyle={styles.icon} />
                          <VStack gap={0} xstyle={styles.lines}>
                            {/* ⚠️ 標題**只給一行**:標題是問題的重點摘要,但長度仍然會變。
                                不夾的話這一列會往下長好幾行,日期被推到看不見的地方。 */}
                            <HStack gap={2} vAlign="center" xstyle={styles.headline}>
                              <Text maxLines={1} xstyle={styles.title}>
                                {clipTitle(row.title)}
                              </Text>
                              {/* 日期不是裝飾:同一句話問過好幾次是常態,只有標題選不出來 */}
                              <Text
                                type="supporting"
                                color="secondary"
                                maxLines={1}
                                xstyle={styles.when}
                              >
                                {row.when}
                              </Text>
                            </HStack>
                            {row.snippet ? (
                              <Text type="supporting" color="secondary" maxLines={1}>
                                {row.snippet}
                              </Text>
                            ) : null}
                          </VStack>
                        </HStack>
                      </CommandPaletteItem>
                    ))
                  : /*
                     * ⚠️ **只有搜過才說「找不到」。** 還沒打字卻是空的(第一次開、清單還在
                     * 路上)說「Nothing matches that.」是在騙人 —— 那時候什麼都還沒搜。
                     */
                    isSearching && !failed && (
                      <CommandPaletteEmpty>Nothing matches that.</CommandPaletteEmpty>
                    )}
                {failed ? (
                  /* 抓不到要講出來,不能當成「沒有結果」 */
                  <CommandPaletteEmpty role="alert">
                    Could not search inside messages right now.
                  </CommandPaletteEmpty>
                ) : null}
              </CommandPaletteList>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider padding={0}>
              {/*
               * 底下那一排是**頁碼**。
               * ⚠️ 設計系統預設的那排鍵盤提示(「↑↓ Navigate / ↵ Select / Esc Close」)
               * 是說明文字,而這個站的規矩是畫面上不放說明文字 —— 沒有用它的
               * `CommandPaletteFooter`,所以不會自己冒出來。
               * ⚠️ **只在沒有搜尋字串時出現**:搜尋結果是一份查詢的答案,不是「第幾頁」。
               */}
              {!isSearching && pageCount > 1 ? (
                <HStack hAlign="center" width="100%" padding={1}>
                  <Pagination
                    // 元件的頁碼是 1 起算的
                    page={page + 1}
                    totalItems={total}
                    pageSize={PAGE_SIZE}
                    size="sm"
                    onChange={(next: number) => setPage(next - 1)}
                  />
                </HStack>
              ) : null}
            </LayoutFooter>
          }
        />
    </Dialog>
  );
}
