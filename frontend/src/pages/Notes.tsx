/**
 * 個人筆記(側邊欄 Notes,`/notes`、`/notes/:id`),Notion 式的頁面。
 *
 *   - 左側是**頁面樹**(`components/notes/NoteTree.tsx`):圖示 + 標題、順序固定、拖曳排序 / 拖進別頁變子頁、
 *     滑過出現 ⋯;整欄可以收起來(記在這台瀏覽器;收起 / 打開是寬度 340ms 的過場,跟主側欄同一條)。
 *     圖示只用線條圖示(`components/notes/pageIcons.tsx`,不用 emoji),圖示與顏色在清單的右鍵選單改。
 *     **左側這一欄的字是英文**(跟主側欄一致);右邊內文那一頁是中文。
 *   - 右邊一頁:圖示(只顯示,不在這裡改)、大標題、內文(`NoteEditor`);一律全寬。
 *   - 右上:麵包屑、「編輯於 …」、「↗ 回到上次對話」(從對話存的才有)、⋯(複製一份、存成模板、刪除)。
 *   - 刪除不問:toast 給「復原」(後端是軟刪除,畫面上沒有垃圾桶)。
 *   - 空白頁下面「從模板開始」。
 * 停手一秒自動存(`lib/noteDraft.ts`)。
 *
 * 後端另有留言、分享、垃圾桶、封面的 API 與資料表,前端沒有用到。
 *
 * 手機寬度:先只有清單,點進去才是內容,左上返回。
 * 頁面內容是中文(同 SSH,見 frontend/.claude/CLAUDE.md 的例外清單);側邊欄那一列 `Notes` 是英文。
 */
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent} from 'react';
import {useLocation, useNavigate, useParams} from 'react-router-dom';
import * as stylex from '@stylexjs/stylex';

import {BreadcrumbItem, Breadcrumbs} from '@astryxdesign/core/Breadcrumbs';
import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Layout, LayoutContent, LayoutPanel, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {
  ArrowUpRight,
  ChevronLeft,
  Copy,
  LayoutTemplate,
  NotebookPen,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';

import {LoadingScreen} from '../components/LoadingScreen';
import {NoteEditor, type NoteEditorHandle} from '../components/notes/NoteEditor';
import {canEditVisually} from '../components/notes/noteExtensions';
import type {NoteHost, PageInfo} from '../components/notes/noteHost';
import {childrenMap, NoteSearchList, NoteTree, type TreeActions} from '../components/notes/NoteTree';
import {iconOf, PageIcon} from '../components/notes/pageIcons';
import {BUILTIN_TEMPLATES, renderTemplate} from '../components/notes/templates';
import {errorMessage, httpStatus} from '../lib/errors';
import {MOBILE_QUERY, useMediaQuery} from '../lib/media';
import {
  adoptNote,
  editDraft,
  flushDraft,
  forgetDraft,
  hasUnsavedDrafts,
  onDraftSaved,
  useDraft,
  type DraftPatch,
  type DraftSave,
} from '../lib/noteDraft';
import {
  createNote,
  deleteNote,
  duplicateNote,
  getNote,
  insertBlock,
  listNotes,
  listTemplates,
  listTitle,
  moveNote,
  NOTE_IMAGE_TYPE,
  noteTitle,
  restoreNote,
  saveAsTemplate,
  uploadNoteImage,
  type Note,
  type NoteSummary,
} from '../lib/notebookApi';
import {loadPeopleDirectory} from '../lib/peopleDirectory';
import {formatEditedAgo, formatNoteStamp} from '../lib/time';
import {toastError, toastInfo, toastNotice, toastWithAction} from '../lib/toast';
import {registerBusySource} from '../lib/unsavedWork';
import {useLatest} from '../lib/useLatest';

/** 打字停多久才查 */
const SEARCH_DEBOUNCE_MS = 300;
/** 這台瀏覽器記住的:清單收起來了沒、哪幾頁展開著 */
const SIDEBAR_KEY = 'notes.sidebarCollapsed';
/**
 * 窄的時候清單自動收起:
 * 開著清單時內文欄會不到 MIN_CONTENT_WIDTH 就收起來。自動收起不記住(視窗變寬就打開回來)。
 */
const LIST_WIDTH = 280;
/**
 * 內文欄左右留白,跟 `styles.sheet` 的 padding 同一組(自動收起的判斷要跟畫面用同一個數):
 * 左邊一律 72(要放 ＋ ⋮⋮);右邊在不寬的時候(≤ 1440,見 COMPACT_SHEET_QUERY)縮成 24,寬的時候也是 72。
 */
const SHEET_SIDE_PADDING = {wide: 144, compact: 96};
const COMPACT_SHEET_QUERY = '(max-width: 1440px)';
const MIN_CONTENT_WIDTH = 560;
const EXPANDED_KEY = 'notes.expanded';

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 私密視窗、封鎖網站資料:記不住就算了
  }
}

const styles = stylex.create({
  page: {height: '100%', minHeight: 0},
  colHead: {
    flex: 'none',
    paddingInline: 'var(--spacing-4)',
    paddingBlock: 'var(--spacing-3)',
    minHeight: 56,
    boxSizing: 'border-box',
  },
  search: {flex: 'none', paddingInline: 'var(--spacing-3)', paddingBottom: 'var(--spacing-2)'},
  // 清單本身(SideNav)自己有左右內距,跟主側欄一樣
  listScroll: {flex: '1 1 0', minHeight: 0, overflowY: 'auto'},
  /**
   * 清單那一欄收起 / 打開:寬度 340ms、--ease-panel(跟主側欄同一條;global.css 的
   * `transition: width 340ms var(--ease-panel)`)。收起來時寬度 0、裡面那一層固定 280 寬不跟著擠(不然字會一路換行)。
   */
  listPanel: {overflow: 'hidden', flexShrink: 0},
  // 分隔線跟著寬度一起淡出 / 淡入(只切 hasDivider 的話,線會在動畫一開始就消失或出現)
  listPanelAnimated: {
    transitionProperty: 'width, border-inline-end-color',
    transitionDuration: {default: '340ms', '@media (prefers-reduced-motion: reduce)': '0s'},
    transitionTimingFunction: 'var(--ease-panel)',
  },
  listPanelHidden: {borderInlineEndColor: 'transparent'},
  listInner: {width: LIST_WIDTH, height: '100%', flexShrink: 0},
  // 搜尋結果(List)的左右內距;清單(SideNav)自己有
  searchList: {paddingInline: 'var(--spacing-2)'},
  detail: {height: '100%', minHeight: 0},
  headTitle: {minWidth: 0},
  status: {whiteSpace: 'nowrap'},
  bodyScroll: {flex: '1 1 0', minHeight: 0, overflowY: 'auto'},
  // 一頁:一律全寬。
  // 左邊留 72:區塊把手 ＋ ⋮⋮(兩顆 sm 鈕)要擺在內文左邊的留白裡,48 會壓到清單欄的分隔線
  sheet: {
    paddingInlineStart: {default: 'calc(var(--spacing-12) + var(--spacing-6))', '@media (max-width: 768px)': 'var(--spacing-4)'},
    // 右邊不用放把手:不寬的時候縮成 24,內文多一點位置
    // 斷點跟 COMPACT_SHEET_QUERY 同一個(StyleX 的 media 只吃字面值)
    paddingInlineEnd: {
      default: 'calc(var(--spacing-12) + var(--spacing-6))',
      '@media (min-width: 769px) and (max-width: 1440px)': 'var(--spacing-6)',
      '@media (max-width: 768px)': 'var(--spacing-4)',
    },
    paddingTop: {default: 'var(--spacing-10)', '@media (max-width: 768px)': 'var(--spacing-6)'},
    paddingBottom: 'var(--spacing-12)',
    width: '100%',
    boxSizing: 'border-box',
    // 內文下面那一大片空白也算「這一頁」:點下去游標到最後(見 onMouseDown)
    flexGrow: 1,
    cursor: 'text',
  },
  bigIcon: {
    fontSize: 'var(--text-display-1-size)',
    lineHeight: 1,
    marginBottom: 'var(--spacing-3)',
    alignSelf: 'flex-start',
  },
  // 模板清單每一列有左內距(8):整份往左拉回來,圖示跟「從模板開始」與標題對齊
  templateList: {marginInlineStart: 'calc(var(--spacing-2) * -1)'},
  /**
   * 大標題:沒有框,點了直接改。Astryx 的輸入框都有框,沒有這種「長得像標題的輸入框」,
   * 所以是原生 <textarea> 套 Astryx 的字級 token;用 textarea 是為了長標題能換行(高度跟著字長)。
   */
  titleInput: {
    display: 'block',
    width: '100%',
    resize: 'none',
    overflow: 'hidden',
    borderWidth: 0,
    padding: 0,
    margin: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-family-heading)',
    // display-1:跟 Notion 的頁面標題大小接近
    fontSize: 'var(--text-display-1-size)',
    fontWeight: 'var(--font-weight-semibold)',
    lineHeight: 'var(--text-display-1-leading)',
    '::placeholder': {color: 'var(--color-text-disabled)'},
  },
  meta: {marginTop: 'var(--spacing-2)'},
  content: {marginTop: 'var(--spacing-6)'},
  templates: {marginTop: 'var(--spacing-8)', cursor: 'default'},
  center: {height: '100%', justifyContent: 'center'},
});

export default function Notes() {
  const {id: routeId} = useParams();
  const selectedId = routeId && /^\d+$/.test(routeId) ? Number(routeId) : null;
  const navigate = useNavigate();
  const location = useLocation();
  const isNarrow = useMediaQuery(MOBILE_QUERY);

  // 窄的時候自動收起清單(見 MIN_CONTENT_WIDTH):量這一頁有多寬。
  // 第一次在這裡同步量(layout effect 裡 setState 會在畫出來之前重畫):等 ResizeObserver 的話第一格寬度是 0、tight 是 false,
  // 1024 寬的視窗每次進來清單都會先出現再滑掉
  const rootRef = useRef<HTMLDivElement>(null);
  const [pageWidth, setPageWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setPageWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setPageWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isNarrow]);
  /** 量到寬度之後的下一格才開收合的過場(第一次決定收不收不要動畫) */
  const [animateList, setAnimateList] = useState(false);
  useEffect(() => {
    if (pageWidth > 0 && !animateList) {
      const raf = requestAnimationFrame(() => setAnimateList(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [pageWidth, animateList]);
  // 右邊留白跟畫面用同一個斷點(一律當 24 算的話,超過 1440 寬時會少算 48)
  const isCompactSheet = useMediaQuery(COMPACT_SHEET_QUERY);
  const sidePadding = isCompactSheet ? SHEET_SIDE_PADDING.compact : SHEET_SIDE_PADDING.wide;
  const tight = !isNarrow && pageWidth > 0 && pageWidth - LIST_WIDTH - sidePadding < MIN_CONTENT_WIDTH;
  /** 擠的時候使用者自己按了「打開清單」 */
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!tight) setPeek(false);
  }, [tight]);

  const [query, setQuery] = useState('');
  const [tree, setTree] = useState<NoteSummary[] | null>(null);
  const [results, setResults] = useState<NoteSummary[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readStored<boolean>(SIDEBAR_KEY, false));
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set(readStored<number[]>(EXPANDED_KEY, [])));
  const seq = useRef(0);

  useEffect(() => writeStored(SIDEBAR_KEY, collapsed), [collapsed]);
  /** 清單現在藏著嗎:自己收起來的(記住),或擠的時候自動收的 */
  const listHidden = collapsed || (tight && !peek);
  const openList = () => {
    setCollapsed(false);
    setPeek(true);
  };
  // 擠的時候只是暫時打開,收回去不記住;不擠才記成「收起來」
  const closeList = () => (tight ? setPeek(false) : setCollapsed(true));
  useEffect(() => writeStored(EXPANDED_KEY, [...expanded]), [expanded]);

  const reloadTree = useCallback(() => {
    const mine = ++seq.current;
    listNotes().then(
      (rows) => {
        if (mine !== seq.current) return;
        setTree(rows);
        setListFailed(false);
      },
      () => {
        if (mine === seq.current) setListFailed(true);
      },
    );
  }, []);

  // 第一次、切回這個分頁:重讀(別台電腦可能新增過)
  useEffect(() => {
    reloadTree();
    window.addEventListener('focus', reloadTree);
    return () => window.removeEventListener('focus', reloadTree);
  }, [reloadTree]);

  // 搜尋:停手才查;清掉字就回到樹
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      listNotes(q).then(
        (rows) => alive && setResults(rows),
        () => alive && setResults([]),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query]);

  // 還沒存完:舊版網頁不要趁這時候自己換新(lib/unsavedWork)
  useEffect(() => registerBusySource(hasUnsavedDrafts), []);

  // 存好一則:樹上那一列換標題、圖示 —— **不換位置**(改內容不會跳到最上面)
  useEffect(
    () =>
      onDraftSaved((note) =>
        setTree((t) => t?.map((r) => (r.id === note.id ? {...r, title: note.title, icon: note.icon, updated_at: note.updated_at} : r)) ?? t),
      ),
    [],
  );

  const allRows = useMemo(() => tree ?? [], [tree]);
  const allPages = useCallback((): PageInfo[] => allRows.map((r) => ({id: r.id, title: r.title, icon: r.icon})), [allRows]);
  // 「@」選單要列同事:名冊平常是對話頁在載,直接開筆記頁時這裡補載(已載過不會重抓)
  useEffect(() => {
    void loadPeopleDirectory();
  }, []);
  const pageOf = useCallback(
    (id: number): PageInfo | undefined => {
      const r = allRows.find((x) => x.id === id);
      return r ? {id: r.id, title: r.title, icon: r.icon} : undefined;
    },
    [allRows],
  );

  // 寬螢幕、網址沒指定哪一頁:選最上面那一頁
  useEffect(() => {
    if (isNarrow || selectedId != null || !tree) return;
    const first = childrenMap(tree).get(null)?.[0];
    if (first) navigate(`/notes/${first.id}`, {replace: true});
  }, [isNarrow, selectedId, tree, navigate]);

  const open = useCallback(
    (id: number, opts?: {edit?: boolean}) => {
      if (selectedId != null && selectedId !== id) flushDraft(selectedId);
      navigate(`/notes/${id}`, opts?.edit ? {state: {edit: true}} : undefined);
    },
    [navigate, selectedId],
  );

  const expand = useCallback((ids: number[]) => {
    setExpanded((cur) => (ids.every((i) => cur.has(i)) ? cur : new Set([...cur, ...ids])));
  }, []);
  const toggle = useCallback((id: number) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 新增一頁(parentId = 在那一頁底下);新的放最上面,游標停在標題 */
  const create = useCallback(
    async (parentId: number | null = null, title = '', go = true): Promise<Note | null> => {
      if (creating) return null;
      setCreating(true);
      try {
        const note = await createNote({parent_id: parentId, title});
        adoptNote(note);
        setTree((t) =>
          t
            ? [
                {
                  id: note.id,
                  title: note.title,
                  summary: '',
                  source_kind: null,
                  has_image: false,
                  updated_at: note.updated_at,
                  parent_id: note.parent_id,
                  position: Math.min(0, ...t.filter((r) => r.parent_id === parentId).map((r) => r.position ?? 0)) - 1,
                  icon: note.icon,
                },
                ...t,
              ]
            : t,
        );
        if (parentId != null) expand([parentId]);
        if (go) {
          if (selectedId != null) flushDraft(selectedId);
          navigate(`/notes/${note.id}`, {state: {edit: true}});
        }
        return note;
      } catch (err) {
        toastError(errorMessage(err, "Couldn't add a note. Try again."));
        return null;
      } finally {
        setCreating(false);
      }
    },
    [creating, expand, navigate, selectedId],
  );

  /** 刪除:不問,toast 給「復原」 */
  const remove = useCallback(
    async (id: number) => {
      const row = tree?.find((r) => r.id === id);
      try {
        flushDraft(id);
        await deleteNote(id);
      } catch (err) {
        toastError(errorMessage(err, "Couldn't delete the note. Try again."));
        return;
      }
      const children = childrenMap(tree ?? []);
      const gone = new Set<number>();
      const walk = (x: number) => {
        gone.add(x);
        for (const c of children.get(x) ?? []) walk(c.id);
      };
      walk(id);
      gone.forEach((g) => forgetDraft(g));
      const rest = tree?.filter((r) => !gone.has(r.id)) ?? [];
      setTree((t) => t?.filter((r) => !gone.has(r.id)) ?? t);
      // 正在看的那頁被刪了:寬螢幕跳到上一層 / 最上面那頁,手機回清單
      if (selectedId != null && gone.has(selectedId)) {
        const next = row?.parent_id ?? childrenMap(rest).get(null)?.[0]?.id;
        if (!isNarrow && next != null) navigate(`/notes/${next}`, {replace: true});
        else navigate('/notes', {replace: true});
      }
      const title = listTitle(row?.title ?? '');
      toastWithAction(
        `Deleted "${title}".`,
        {
          label: 'Undo',
          onClick: async () => {
            try {
              const note = await restoreNote(id);
              toastInfo(`Restored "${title}".`, `note-deleted-${id}`);
              reloadTree();
              navigate(`/notes/${note.id}`);
            } catch (err) {
              toastError(errorMessage(err, "Couldn't restore the note. Try again."));
            }
          },
        },
        `note-deleted-${id}`,
      );
    },
    [isNarrow, navigate, reloadTree, selectedId, tree],
  );

  /** 正在改的標題 / 圖示:清單跟著變,不等存檔(照 Notion) */
  const liveRow = useCallback((id: number, patch: RowPatch) => {
    const apply = (rows: NoteSummary[] | null) =>
      rows?.some((r) => r.id === id && Object.entries(patch).some(([k, v]) => (r as Record<string, unknown>)[k] !== v))
        ? rows.map((r) => (r.id === id ? {...r, ...patch} : r))
        : rows;
    setTree(apply);
    setResults(apply);
  }, []);
  const liveTitle = useCallback((id: number, title: string) => liveRow(id, {title}), [liveRow]);

  /**
   * 清單上改名(選單的 Rename)、改圖示與顏色(右鍵那兩排)。開著的那一頁交給它自己改(標題框、大圖示跟著變);
   * 沒開著的先讀進草稿再改、馬上存 —— 走同一條存檔的路,版本對得上。
   */
  const editOpenPage = useRef<((id: number, patch: RowPatch) => boolean) | null>(null);
  const editRow = useCallback(
    async (id: number, patch: RowPatch) => {
      liveRow(id, patch);
      if (editOpenPage.current?.(id, patch)) return;
      try {
        adoptNote(await getNote(id));
        editDraft(id, patch);
        flushDraft(id);
      } catch (err) {
        toastError(errorMessage(err, "Couldn't update the note. Try again."));
        reloadTree();
      }
    },
    [liveRow, reloadTree],
  );

  const duplicate = useCallback(
    async (id: number) => {
      try {
        flushDraft(id);
        const copy = await duplicateNote(id);
        reloadTree();
        navigate(`/notes/${copy.id}`);
      } catch (err) {
        toastError(errorMessage(err, "Couldn't duplicate the note. Try again."));
      }
    },
    [navigate, reloadTree],
  );

  /** 拖曳:先在畫面上搬好,再送;失敗就重讀 */
  const move = useCallback(
    (id: number, parentId: number | null, index: number) => {
      setTree((t) => {
        if (!t) return t;
        const siblings = (childrenMap(t).get(parentId) ?? []).filter((r) => r.id !== id);
        const before = siblings[index - 1]?.position;
        const after = siblings[index]?.position;
        const position =
          before == null && after == null ? 0 : before == null ? (after ?? 0) - 1 : after == null ? before + 1 : (before + after) / 2;
        return t.map((r) => (r.id === id ? {...r, parent_id: parentId, position} : r));
      });
      if (parentId != null) expand([parentId]);
      moveNote(id, parentId, index).then(reloadTree, (err) => {
        toastError(errorMessage(err, "Couldn't move the note. Try again."));
        reloadTree();
      });
    },
    [expand, reloadTree],
  );

  // 先把它從清單拿掉再回 /notes:不然寬螢幕的「自動選第一頁」會又選回這頁不見的,來回繞
  const onMissing = useCallback(
    (id: number) => {
      setTree((t) => t?.filter((r) => r.id !== id) ?? t);
      reloadTree();
      navigate('/notes', {replace: true});
    },
    [navigate, reloadTree],
  );

  const newSubpage = useCallback(
    async (parentId: number, title?: string): Promise<PageInfo | null> => {
      const note = await create(parentId, title ?? '', false);
      return note ? {id: note.id, title: note.title, icon: note.icon} : null;
    },
    [create],
  );

  const treeActions: TreeActions = {
    onToggle: toggle,
    onMove: move,
    onAddChild: (pid) => void create(pid),
    onDuplicate: (id) => void duplicate(id),
    onDelete: (id) => void remove(id),
    onRename: (id, title) => void editRow(id, {title}),
    onSetIcon: (id, icon) => void editRow(id, {icon}),
  };

  const listColumn = (
    <VStack gap={0} xstyle={styles.page}>
      <HStack gap={1} vAlign="center" xstyle={styles.colHead}>
        <StackItem size="fill">
          <Heading level={5}>Notes</Heading>
        </StackItem>
        <IconButton
          label="New note"
          icon={<Icon icon={SquarePen} size="sm" />}
          variant="ghost"
          size="sm"
          isDisabled={creating}
          onClick={() => void create()}
        />
        {/* 收合 / 打開清單用主側欄同一個單箭頭(設計系統 SideNavCollapseButton 的 chevronLeft),兩邊長得一樣 */}
        {!isNarrow ? (
          <IconButton label="Collapse list" icon={<Icon icon="chevronLeft" size="sm" />} variant="ghost" size="sm" onClick={closeList} />
        ) : null}
      </HStack>
      <Stack xstyle={styles.search}>
        <TextInput label="Search notes" isLabelHidden size="sm" placeholder="Search" startIcon={Search} value={query} onChange={setQuery} />
      </Stack>
      <Stack xstyle={styles.listScroll} data-notes-scroll="">
        {results ? (
          results.length ? (
            <Stack xstyle={styles.searchList}>
              <NoteSearchList rows={results} selectedId={selectedId} onOpen={(id) => open(id)} actions={treeActions} />
            </Stack>
          ) : (
            <EmptyState isCompact title="No matching notes" />
          )
        ) : tree === null ? (
          listFailed ? (
            <EmptyState isCompact title="Couldn't load notes" actions={<Button label="Try again" size="sm" variant="secondary" onClick={reloadTree} />} />
          ) : (
            <LoadingScreen isCompact label="Loading" />
          )
        ) : (
          <NoteTree rows={tree} selectedId={selectedId} expanded={expanded} actions={treeActions} />
        )}
      </Stack>
    </VStack>
  );

  /** 一頁都沒有(不是搜不到):內容區畫「還沒有筆記」,手機寬度也直接畫它 */
  const isEmpty = tree !== null && !tree.length;
  const startEditing = (location.state as {edit?: boolean} | null)?.edit === true;
  const detail =
    selectedId != null ? (
      <NoteDetail
        key={selectedId}
        id={selectedId}
        startEditing={startEditing}
        pageOf={pageOf}
        allPages={allPages}
        onOpenPage={open}
        onNewSubpage={newSubpage}
        onBack={isNarrow ? () => navigate('/notes') : undefined}
        onOpenSidebar={!isNarrow && listHidden ? openList : undefined}
        onDelete={remove}
        onDuplicate={duplicate}
        onMissing={onMissing}
        onLoaded={(n) => expand(n.crumbs.map((c) => c.id))}
        onTitleLive={liveTitle}
        editOpenPage={editOpenPage}
      />
    ) : isEmpty ? (
      <VStack xstyle={styles.center}>
        <EmptyState
          title="No notes yet"
          icon={<Icon icon={NotebookPen} size="lg" />}
          actions={
            <Button label="New note" icon={<Icon icon={SquarePen} size="sm" />} variant="secondary" isDisabled={creating} onClick={() => void create()} />
          }
        />
      </VStack>
    ) : null;

  if (isNarrow) {
    return (
      <VStack gap={0} xstyle={styles.page}>
        <VisuallyHidden>
          <Heading level={1}>Notes</Heading>
        </VisuallyHidden>
        {selectedId != null || isEmpty ? detail : listColumn}
      </VStack>
    );
  }

  return (
    <VStack ref={rootRef} gap={0} xstyle={styles.page}>
      <VisuallyHidden>
        <Heading level={1}>Notes</Heading>
      </VisuallyHidden>
      <Layout
        height="fill"
        start={
          <LayoutPanel
            width={listHidden ? 0 : LIST_WIDTH}
            hasDivider
            padding={0}
            isScrollable={false}
            xstyle={[styles.listPanel, animateList && styles.listPanelAnimated, listHidden && styles.listPanelHidden]}
          >
            {/* 收起來時裡面點不到、Tab 也跳過(inert) */}
            <Stack xstyle={styles.listInner} inert={listHidden}>
              {listColumn}
            </Stack>
          </LayoutPanel>
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
            {/* 收起來時:有選一頁的話那一頁自己的標題列有「打開清單」;沒有(一頁都沒有、還沒選)就在這裡畫一顆 */}
            {listHidden && selectedId == null ? (
              <HStack xstyle={styles.colHead}>
                <IconButton label="Expand list" icon={<Icon icon="chevronRight" size="sm" />} variant="ghost" size="sm" onClick={openList} />
              </HStack>
            ) : null}
            {detail}
          </LayoutContent>
        }
      />
    </VStack>
  );
}

/** 清單上能改的那兩樣(Rename、右鍵的圖示與顏色) */
type RowPatch = {title: string} | {icon: string | null};

type DraftStatus = {text: string; variant: 'success' | 'neutral' | 'warning' | 'error' | null};

const SAVE_TEXT: Record<DraftSave, string> = {
  saved: '',
  dirty: '儲存中',
  saving: '儲存中',
  error: '沒有存到',
  'too-big': '沒有存到:超過上限',
};

/**
 * 標題列右邊那個狀態(照 Notion):平常寫「編輯於 3 分鐘前」不放圓點;存檔中「儲存中」;存不到才有紅點。
 * 字和圓點一起決定,兩邊的優先順序才不會各寫一套。
 */
function draftStatus(save: DraftSave, opts: {uploading: boolean; imageTooBig: boolean; editedAt: string}): DraftStatus {
  if (opts.uploading) return {text: '圖片上傳中', variant: null};
  if (opts.imageTooBig) return {text: SAVE_TEXT['too-big'], variant: 'error'};
  if (save === 'error' || save === 'too-big') return {text: SAVE_TEXT[save], variant: 'error'};
  if (save !== 'saved') return {text: SAVE_TEXT[save], variant: null};
  return {text: `編輯於 ${formatEditedAgo(opts.editedAt)}`, variant: null};
}

/** 這頁是空的嗎(空白頁才出「從模板開始」) */
function isBlank(title: string, body: string): boolean {
  return !title.trim() && !body.trim();
}

function NoteDetail({
  id,
  startEditing,
  pageOf,
  allPages,
  onOpenPage,
  onNewSubpage,
  onBack,
  onOpenSidebar,
  onDelete,
  onDuplicate,
  onMissing,
  onLoaded,
  onTitleLive,
  editOpenPage,
}: {
  id: number;
  startEditing: boolean;
  pageOf: (id: number) => PageInfo | undefined;
  /** 看得到的所有頁(「@」「[[」選單) */
  allPages: () => PageInfo[];
  onOpenPage: (id: number, opts?: {edit?: boolean}) => void;
  onNewSubpage: (parentId: number, title?: string) => Promise<PageInfo | null>;
  onBack?: () => void;
  /** 清單收起來了:左上一顆「打開清單」 */
  onOpenSidebar?: () => void;
  onDelete: (id: number) => void;
  onDuplicate: (id: number) => void;
  /** 這一頁讀回來是 404 */
  onMissing: (id: number) => void;
  onLoaded: (note: Note) => void;
  /** 正在打的標題(清單跟著變) */
  onTitleLive: (id: number, title: string) => void;
  /** 清單上改名 / 改圖示時,改的是這一頁的話由這一頁自己改(這裡登記) */
  editOpenPage: React.MutableRefObject<((id: number, patch: RowPatch) => boolean) | null>;
}) {
  const navigate = useNavigate();
  const isNarrow = useMediaQuery(MOBILE_QUERY);
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);
  const draft = useDraft(id);
  const [uploading, setUploading] = useState(0);
  /** 貼的圖超過上限(單張 / 總量):狀態字跟內文超過時一樣寫「沒有存到:超過上限」,再改字就清掉 */
  const [imageTooBig, setImageTooBig] = useState(false);
  const body = draft?.body;
  useEffect(() => setImageTooBig(false), [body]);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  /** 原文編輯(編輯器不收的那幾則)的文字框 */
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const editorHandle = useRef<NoteEditorHandle | null>(null);
  const [templates, setTemplates] = useState<NoteSummary[] | null>(null);
  // 「編輯於 3 分鐘前」要自己往前走
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  // 讀這一頁;切回這個分頁重讀一次(別台電腦可能改過 —— 手上有還沒存的字時 adoptNote 不會蓋掉)
  useEffect(() => {
    let alive = true;
    const load = () =>
      getNote(id).then(
        (n) => {
          if (!alive) return;
          setNote(n);
          adoptNote(n);
          onLoadedRef.current(n);
        },
        (err) => {
          // 不見了(別的分頁刪掉、網址是舊的):回清單
          if (alive && (httpStatus(err) === 404 || httpStatus(err) === 403)) {
            setMissing(true);
            forgetDraft(id);
            onMissing(id);
          }
        },
      );
    void load();
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
      flushDraft(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const ready = note !== null && draft !== undefined;
  const readOnly = note?.access === 'view';
  const isOwner = note?.access === 'owner';
  /**
   * 用編輯器還是原文:讀到的那一刻決定一次,之後不換。有 doc 的一定用編輯器;
   * 舊筆記看 Markdown 編輯器收不收得下(`canEditVisually`)。
   */
  const [visual, setVisual] = useState<boolean | null>(null);
  if (ready && visual === null) setVisual(!!draft.doc || canEditVisually(draft.body));

  /** 改標題、圖示 */
  const editMeta = (patch: DraftPatch) => editDraft(id, patch);
  // 清單上改這一頁的名字 / 圖示:走這一頁自己的路(標題框、大圖示跟著變)
  const editMetaRef = useLatest(editMeta);
  useEffect(() => {
    const fn = (rid: number, patch: RowPatch) => {
      if (rid !== id || readOnly) return false;
      editMetaRef.current(patch);
      return true;
    };
    editOpenPage.current = fn;
    return () => {
      if (editOpenPage.current === fn) editOpenPage.current = null;
    };
  }, [editMetaRef, id, readOnly, editOpenPage]);

  // 新增的那一頁:游標直接停在標題
  const focusedTitle = useRef(false);
  const shown = ready && visual !== null;
  useLayoutEffect(() => {
    if (!startEditing || !shown || focusedTitle.current) return;
    focusedTitle.current = true;
    titleRef.current?.focus();
  }, [startEditing, shown]);

  // 大標題跟著字長高(長標題換行,不出捲軸);視窗變寬變窄時換行數會變,也要重算
  const title = draft?.title;
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [title, shown]);

  /** 上傳一張圖:成功回後端給的那一段(`![](notebook-image:<id>)`);失敗跳 toast、超過上限寫在狀態上 */
  const uploadImage = useCallback(
    async (file: File) => {
      setUploading((n) => n + 1);
      try {
        return (await uploadNoteImage(id, file)).ref;
      } catch (err) {
        if (httpStatus(err) === 413) setImageTooBig(true);
        toastError(errorMessage(err, '圖片沒有存到,請稍後再試'));
        return null;
      } finally {
        setUploading((n) => n - 1);
      }
    },
    [id],
  );

  /** 原文編輯:貼上 / 拖進的圖插在游標處 */
  const insertSourceImages = useCallback(
    async (files: File[]) => {
      for (const file of files.filter((f) => NOTE_IMAGE_TYPE.test(f.type))) {
        const ref = await uploadImage(file);
        if (!ref) continue;
        const el = sourceRef.current;
        const cur = el?.value ?? '';
        const next = insertBlock(cur, el?.selectionStart ?? cur.length, el?.selectionEnd ?? cur.length, ref);
        editDraft(id, {body: next.text});
        window.setTimeout(() => el?.setSelectionRange(next.caret, next.caret));
      }
    },
    [id, uploadImage],
  );

  const host: Partial<NoteHost> = useMemo(
    () => ({
      readOnly,
      page: pageOf,
      pages: allPages,
      openPage: onOpenPage,
      newSubpage: async (t?: string) => {
        if (!isOwner) {
          toastNotice('只有這頁的主人能在底下新增頁面');
          return null;
        }
        return onNewSubpage(id, t);
      },
      uploadImage,
    }),
    [allPages, id, isOwner, onNewSubpage, onOpenPage, pageOf, readOnly, uploadImage],
  );

  if (!note || !draft || missing || visual === null) {
    // 清單收起來時,讀不到這一頁也要回得去清單(不然只剩轉圈,收起來的清單打不開)
    return onOpenSidebar ? (
      <VStack gap={0} xstyle={styles.detail}>
        <HStack xstyle={styles.colHead}>
          <IconButton label="Expand list" icon={<Icon icon="chevronRight" size="sm" />} variant="ghost" size="sm" onClick={onOpenSidebar} />
        </HStack>
        <LoadingScreen isCompact label="載入中" />
      </VStack>
    ) : (
      <LoadingScreen isCompact label="載入中" />
    );
  }

  const fromChat = note.source_conversation_id != null && note.source_qa_id != null;
  const gone = fromChat && note.source_available === false;
  const status = draftStatus(draft.save, {uploading: uploading > 0, imageTooBig, editedAt: draft.base ?? note.updated_at});
  const canEdit = !readOnly;
  /** 標題按 Enter / ↓、點內文下面的空白:游標到內文(編輯器或原文) */
  const focusBody = (where: 'start' | 'end') => {
    if (visual) editorHandle.current?.focus(where);
    else sourceRef.current?.focus();
  };

  const backToChat = () => {
    flushDraft(id);
    navigate(`/c/${note.source_conversation_id}`, {state: {jumpToQa: note.source_qa_id}});
  };

  const onSourcePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void insertSourceImages(files);
    }
  };
  const onSourceDrop = (e: DragEvent<HTMLElement>) => {
    const files = [...e.dataTransfer.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void insertSourceImages(files);
    }
  };

  /** 套模板:標題、圖示、內容一起換 */
  const fill = (title: string, icon: string | null, doc: string | null, body: string) => editDraft(id, {title, body, doc, icon});
  const applyTemplate = async (key: string, userTemplateId?: number) => {
    if (userTemplateId != null) {
      try {
        const tpl = await getNote(userTemplateId);
        fill(tpl.title, tpl.icon, tpl.doc, tpl.body);
      } catch (err) {
        toastError(errorMessage(err, '沒有讀到模板,請稍後再試'));
      }
      return;
    }
    const t = BUILTIN_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    const {doc, body: md} = renderTemplate(t);
    fill(t.title, t.icon, doc, md);
  };

  const blank = canEdit && !fromChat && isBlank(draft.title, draft.body);
  if (blank && templates === null) {
    setTemplates([]);
    listTemplates().then(setTemplates, () => {});
  }

  const moreItems = [
    ...(isOwner
      ? [
          {label: '複製一份', icon: <Icon icon={Copy} size="sm" />, onClick: () => onDuplicate(id)},
          {
            label: '存成模板',
            icon: <Icon icon={LayoutTemplate} size="sm" />,
            onClick: async () => {
              try {
                flushDraft(id);
                await saveAsTemplate(id);
                setTemplates(null);
                toastInfo(`已把「${noteTitle(draft.title)}」存成模板`);
              } catch (err) {
                toastError(errorMessage(err, '沒有存成模板,請稍後再試'));
              }
            },
          },
          {type: 'divider' as const},
          {label: '刪除', icon: <Icon icon={Trash2} size="sm" />, variant: 'destructive' as const, onClick: () => onDelete(id)},
        ]
      : []),
  ];

  /** 頁面圖示(存成 emoji 的不認,當作沒選) */
  const BigIcon = iconOf(draft.icon);

  return (
    <VStack gap={0} xstyle={styles.detail}>
      <HStack gap={2} vAlign="center" xstyle={styles.colHead}>
        {onBack ? (
          <IconButton
            label="回到筆記清單"
            icon={<Icon icon={ChevronLeft} size="sm" />}
            variant="ghost"
            size="sm"
            onClick={() => {
              flushDraft(id);
              onBack();
            }}
          />
        ) : null}
        {onOpenSidebar ? <IconButton label="Expand list" icon={<Icon icon="chevronRight" size="sm" />} variant="ghost" size="sm" onClick={onOpenSidebar} /> : null}
        <StackItem size="fill" xstyle={styles.headTitle}>
          <Breadcrumbs variant="supporting" label="這一頁的位置">
            {note.crumbs.map((c) => (
              <BreadcrumbItem key={c.id} startIcon={<PageIcon icon={c.icon} />} onClick={() => onOpenPage(c.id)}>
                {noteTitle(c.title)}
              </BreadcrumbItem>
            ))}
            <BreadcrumbItem isCurrent startIcon={<PageIcon icon={draft.icon} />}>
              {noteTitle(draft.title)}
            </BreadcrumbItem>
          </Breadcrumbs>
        </StackItem>
        {!isNarrow ? (
          <HStack gap={2} vAlign="center">
            {status.variant ? <StatusDot variant={status.variant} label={status.text} /> : null}
            <Text type="supporting" color="secondary" xstyle={styles.status} role="status">
              {status.text}
            </Text>
          </HStack>
        ) : null}
        {fromChat ? (
          // 寫字的鈕:只放圖示看不出是「回到那組對話」
          <Button label="回到上次對話" icon={<Icon icon={ArrowUpRight} size="sm" />} variant="ghost" size="sm" isDisabled={gone} onClick={backToChat} />
        ) : null}
        {moreItems.length ? <MoreMenu label="更多" size="sm" alignment="end" items={moreItems} /> : null}
      </HStack>
      <VStack gap={0} xstyle={styles.bodyScroll}>
        <VStack
          gap={0}
          xstyle={styles.sheet}
          // 點在內文下面的空白:游標到內文最後(像 Notion 一樣,整頁都是可以打字的地方)
          onMouseDown={(e: React.MouseEvent) => {
            if (e.target !== e.currentTarget || readOnly) return;
            e.preventDefault();
            focusBody('end');
          }}
        >
          <VStack gap={0}>
            {/* 圖示只顯示;改圖示與顏色只在左側清單的右鍵選單 */}
            {BigIcon ? (
              <Stack xstyle={styles.bigIcon}>
                {/* 一律次要文字色:顏色是左側清單那一列的記號點,不給圖示上色 */}
                <BigIcon size={48} strokeWidth={1.5} color="var(--color-text-secondary)" aria-hidden />
              </Stack>
            ) : null}
            <textarea
              ref={titleRef}
              rows={1}
              aria-label="標題"
              placeholder="未命名"
              value={draft.title}
              readOnly={readOnly}
              // 標題是一行字:貼進來的換行變空白
              onChange={(e) => {
                const next = e.target.value.replace(/\r?\n/g, ' ');
                editMeta({title: next});
                onTitleLive(id, next);
              }}
              onKeyDown={(e) => {
                // Enter 不換行,跳到內文開頭;↓ 在最後一行也跳。注音選字中的 Enter 不算(要看 229)
                const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                if (e.key === 'Enter' && !composing) {
                  e.preventDefault();
                  focusBody('start');
                } else if (e.key === 'ArrowDown' && !composing) {
                  const el = e.currentTarget;
                  if (el.selectionStart === el.value.length) {
                    e.preventDefault();
                    focusBody('start');
                  }
                }
              }}
              {...stylex.props(styles.titleInput)}
            />
          </VStack>
          {fromChat ? (
            <Stack xstyle={styles.meta}>
              <Text type="supporting" color="secondary">
                從對話存的 · {formatNoteStamp(note.created_at)}
                {gone ? ' · 原對話已不存在' : ''}
              </Text>
            </Stack>
          ) : null}
          <Stack xstyle={styles.content}>
            {visual ? (
              <NoteEditor
                body={draft.body}
                doc={draft.doc}
                onChange={(next) => editDraft(id, {body: next.body, doc: next.doc})}
                host={host}
                handle={editorHandle}
                onExitTop={() => {
                  const el = titleRef.current;
                  if (!el || readOnly) return;
                  el.focus();
                  el.setSelectionRange(el.value.length, el.value.length);
                }}
              />
            ) : (
              <TextArea
                ref={sourceRef}
                label="內容"
                isLabelHidden
                value={draft.body}
                onChange={(next: string) => editDraft(id, {body: next})}
                status={status.variant === 'error' ? {type: 'error', message: status.text} : undefined}
                rows={Math.min(40, Math.max(14, draft.body.split('\n').length + 2))}
                width="100%"
                isReadOnly={readOnly}
                onPaste={onSourcePaste}
                onDrop={onSourceDrop}
              />
            )}
          </Stack>
          {blank ? (
            <VStack gap={1} xstyle={styles.templates} onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}>
              <Text type="label" color="secondary">
                從模板開始
              </Text>
              <Stack xstyle={styles.templateList}>
                <List density="compact" header={<VisuallyHidden>模板</VisuallyHidden>}>
                  {BUILTIN_TEMPLATES.map((t) => (
                    <ListItem key={t.key} label={t.label} startContent={<PageIcon icon={t.icon} />} onClick={() => void applyTemplate(t.key)} />
                  ))}
                  {(templates ?? []).map((t) => (
                    <ListItem
                      key={t.id}
                      label={noteTitle(t.title)}
                      startContent={<PageIcon icon={t.icon} />}
                      onClick={() => void applyTemplate('', t.id)}
                      endContent={
                        <IconButton
                          label={`刪除模板「${noteTitle(t.title)}」`}
                          size="sm"
                          variant="ghost"
                          icon={<Icon icon={X} size="sm" color="secondary" />}
                          onClick={async () => {
                            try {
                              await deleteNote(t.id);
                              setTemplates((rows) => rows?.filter((r) => r.id !== t.id) ?? rows);
                            } catch (err) {
                              toastError(errorMessage(err, '沒有刪掉,請稍後再試'));
                            }
                          }}
                        />
                      }
                    />
                  ))}
                </List>
              </Stack>
            </VStack>
          ) : null}
        </VStack>
      </VStack>
    </VStack>
  );
}
