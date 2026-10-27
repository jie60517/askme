/**
 * Work Flow(側邊欄 SSH Server 底下那一列)。可選功能:部署的人沒放 `workflow_actions.json` 的話
 * 側邊欄沒有這一列、`/workflow` 走 NotFound(App.tsx 的 WorkflowOnly)。
 *
 * - `/workflow`:流程清單。
 * - `/workflow/:id`:編輯器。左邊拼圖盒拖到畫布、拉線串起來、設定直接在拼圖上、
 *   存檔、排程、按執行看動畫跑。
 *
 * - 內容中文、側邊欄那一列英文(跟 `/ssh` 同一個例外,見 `frontend/.claude/CLAUDE.md`)。
 * - 沒權限的人看到「只開放給工程師」,真正的擋在後端。
 * - 執行中的進度用輪詢:執行中每 `POLL_MS` 問一次,只拿新的事件。
 * - **還沒存的改動留在模組層的 `drafts`**:換到別的頁面再回來還在,關分頁才會不見
 *   (關分頁時瀏覽器會問,見 `beforeunload`)。
 */
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Navigate, useNavigate, useParams} from 'react-router-dom';
import * as stylex from '@stylexjs/stylex';

import {AlertDialog} from '@astryxdesign/core/AlertDialog';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Layout, LayoutContent, LayoutFooter, LayoutPanel, Stack, VStack} from '@astryxdesign/core/Layout';
import {Popover} from '@astryxdesign/core/Popover';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Token} from '@astryxdesign/core/Token';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {ArrowLeft, CalendarClock, ChevronLeft, Lock, Pencil, Play, Plus, Redo2, Save, Square, Trash2, Undo2} from 'lucide-react';

import {AdminColumn, AdminPage} from '../components/AdminPage';
import {LoadingScreen} from '../components/LoadingScreen';
import {useDialogExit} from '../components/useDialogExit';
import {GHOST_RETURN_MS} from '../components/useLongPressDrag';
import {FlowCanvas, NODE_CENTER_OFFSET, NODE_WIDTH, exceedsSlop, type FlowCanvasHandle, type RunVisual, type Selection, type View as CanvasView} from '../components/workflow/FlowCanvas';
import {FlowList} from '../components/workflow/FlowList';
import {NODE_ICONS} from '../components/workflow/nodeIcons';
import {cardRest, ghostGrab} from '../components/workflow/paletteGhost';
import {HistoryTable, LOG_DOCK_PX, RunLog, RunOutput, SchedulePanel} from '../components/workflow/RunPanels';
import {errorMessage} from '../lib/errors';
import {toastError, toastInfo} from '../lib/toast';
import {MOBILE_QUERY, useMediaQuery} from '../lib/media';
import {registerBusySource} from '../lib/unsavedWork';
import {useMe} from '../lib/useIdentity';
import {
  createWorkflow,
  deleteWorkflow,
  getCatalog,
  getRun,
  getWorkflow,
  listRuns,
  listWorkflows,
  runWorkflow,
  saveWorkflow,
  stopRun,
  switchSchedule,
  type Catalog,
  type FlowGraph,
  type NodeCfg,
  type NodeType,
  type RunRow,
  type RunView,
  type Schedule,
  type WorkflowSummary,
} from '../lib/workflowApi';
import {DEFAULT_SCHEDULE, PALETTE, changedNode, defaultCfg, edgeKey, problemNodes, reachable, runProblems, scheduleShort, withoutEdge, withoutNode} from '../lib/workflowGraph';

const POLL_MS = 800;
/**
 * 上一步 / 下一步:間隔不到這麼久的連續改動算同一步(ms)。拖一塊拼圖會送幾十次改動、
 * 打一串路徑每個字一次 —— 不合併的話按一次上一步只退一個像素、一個字。
 */
const HISTORY_GAP_MS = 500;
/** 最多記幾步 */
const HISTORY_MAX = 100;

/** 流程圖的「結構」:有哪些拼圖、哪些線(位置與設定不算)。變了 = 加或刪,一律自己一步 */
function structureKey(g: FlowGraph): string {
  return g.nodes.map((n) => n.id).join(',') + '|' + g.edges.map((e) => `${e.from}:${e.out}>${e.to}`).join(',');
}
/** 「每一步的輸出」執行中多久重抓一次(整份輸出比較大,不跟著 POLL_MS)。 */
const OUTPUT_POLL_MS = 3000;
/** 拼圖盒(寬螢幕時左邊那一欄)的寬度。改這個數字前先看最長的拼圖名稱放不放得下 */
const PALETTE_WIDTH_PX = 216;

/** 從拼圖盒拖出來的這一次(見 WorkflowEditor 的 ghostDrag) */
type GhostDrag = {pointer: {x: number; y: number}; grab: {x: number; y: number} | null; press: {x: number; y: number}; button: DOMRect};

// 拖出去沒放到畫布上:小卡飛回拼圖盒裡原本那一顆(transform 補間 `--duration-medium`),飛完才拿掉
// —— 哪裡來就回哪裡去。多久拿掉用側邊欄長按拖曳那一個 `GHOST_RETURN_MS`:
// 同一個 app 裡「放手 → 回原位」只該有一種速度。
/** 小卡飛回拼圖盒時,左緣落在按鈕左緣往內這麼多(px):小卡的圖示跟按鈕的圖示對齊,不是貼著按鈕框 */
const GHOST_LAND_INSET_PX = 4;
/** 「複製」出來的那塊往右下錯開多少,才看得出是兩塊。 */
const DUPLICATE_OFFSET = 24;
/** 清單頁有流程正在跑的時候,多久重抓一次清單 */
const LIST_POLL_MS = 3000;
/** 「剛加的」標記留多久(ms):要比進場動畫(`--duration-fast`,最長 230ms)長 */
const FRESH_MS = 300;

type Draft = {
  id: number;
  name: string;
  graph: FlowGraph;
  schedule: Schedule;
  updatedAt: string | null;
  dirty: boolean;
  /** 上次存檔(或讀進來)時的內容。`dirty` = 現在跟它不一樣 —— 改回原樣就不算沒存 */
  savedKey: string;
};

const snapshotKey = (d: {name: string; graph: FlowGraph; schedule: Schedule}) => JSON.stringify([d.name, d.graph, d.schedule]);

/** 伺服器給的那一份 → 畫面上的 Draft(乾淨的,還沒改過)。 */
function draftFromServer(wf: {id: number; name: string; graph: FlowGraph; schedule: Schedule; updated_at: string | null}): Draft {
  const d = {id: wf.id, name: wf.name, graph: wf.graph, schedule: {...DEFAULT_SCHEDULE, ...wf.schedule}, updatedAt: wf.updated_at};
  return {...d, dirty: false, savedKey: snapshotKey(d)};
}

/** 還沒存的改動,依流程 id。模組層:換頁再回來還在(見檔頭)。 */
const drafts = new Map<number, Draft>();

/** 拼圖大約的佔地(找空位用)。高度取最高的那種(同步:客戶、來源、方式三列 + 兩個出口)。 */
const NODE_FOOTPRINT = {w: NODE_WIDTH + 24, h: 190};
/**
 * 從 `at` 開始往右下斜著找,第一個不跟任何一塊重疊的位置。
 * 點一下拼圖盒、或按「複製」時用 —— 不找的話新的那塊會疊在畫面中央那塊上面,看起來像沒反應。
 */
function freeSpot(graph: FlowGraph, at: {x: number; y: number}): {x: number; y: number} {
  const hit = (x: number, y: number) =>
    graph.nodes.some((n) => Math.abs(n.x - x) < NODE_FOOTPRINT.w && Math.abs(n.y - y) < NODE_FOOTPRINT.h);
  for (let i = 0; i < 40; i++) {
    const x = at.x + (i % 8) * 40;
    const y = at.y + Math.floor(i / 8) * NODE_FOOTPRINT.h + (i % 8) * 20;
    if (!hit(x, y)) return {x, y};
  }
  return at;
}

export default function Workflow() {
  const me = useMe();
  const canUse = !!me.can_terminal;

  if (!canUse) {
    return (
      <VStack gap={3} xstyle={styles.page}>
        <VisuallyHidden>
          <Heading level={1}>Work Flow</Heading>
        </VisuallyHidden>
        <Stack xstyle={styles.denied}>
          <EmptyState
            icon={<Icon icon={Lock} size="lg" />}
            title="這個功能只開放給工程師"
            description="職稱是 Software engineer 的帳號才會在側邊欄看到 Work Flow。"
          />
        </Stack>
      </VStack>
    );
  }
  return <WorkflowRoutes />;
}

function WorkflowRoutes() {
  const {id} = useParams();
  if (id == null) return <WorkflowListPage />;
  const flowId = Number(id);
  // 網址打錯(/workflow/abc):回清單,不要在錯的網址上顯示清單
  if (!Number.isInteger(flowId) || flowId <= 0) return <Navigate to="/workflow" replace />;
  // 換一條流程 = 整個編輯器重來(key),不會帶著上一條的選取、執行紀錄
  return <WorkflowEditor key={flowId} id={flowId} />;
}

/** 頁首不換行時的左右內距(px):spacing-5 + spacing-4,跟 styles.head 的 paddingInline 一樣 */
const HEAD_PAD_PX = 20 + 16;

/**
 * 頁首一排放不放得下。看的是頁首自己的寬,不是視窗寬 —— 側邊欄展開與否差兩百多 px:
 * 900 寬的視窗、側邊欄展開時頁首要 782 卻只有 675,整頁冒出橫向捲軸、執行鈕被推到右邊外面。
 * 量的是每一格的寬加間距(撐開的那格空白不算),跟換不換行無關,所以不會在兩種之間來回跳。
 */
/**
 * 頁首一格算多寬:撐開的空白算 0;縮得動的(改名的輸入框)算它的最小寬 —— 用當下的寬的話,
 * 不換行時它被擠窄、換行後又長回 240,兩種狀態量出來不一樣,會在某個寬度來回跳
 */
function cellPx(c: HTMLElement): number {
  const cs = getComputedStyle(c);
  if (parseFloat(cs.flexGrow) > 0) return 0;
  const min = parseFloat(cs.minWidth);
  return parseFloat(cs.flexShrink) > 0 && min > 0 ? min : c.offsetWidth;
}

function useHeadWraps(): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [wraps, setWraps] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const kids = [...el.children] as HTMLElement[];
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const need = kids.reduce((sum, c) => sum + cellPx(c), 0) + gap * Math.max(0, kids.length - 1) + HEAD_PAD_PX;
      setWraps(need > el.clientWidth + 0.5);
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      ro.observe(el);
      for (const c of el.children) ro.observe(c);
    };
    // 頁首裡的格子會換(改名時名字變輸入框、執行變停止),換了要重新盯
    const mo = new MutationObserver(watch);
    mo.observe(el, {childList: true});
    watch();
    measure();
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [el]);
  return [setEl, wraps];
}

// 關分頁前:有沒存的就讓瀏覽器問一次;自動換新版也要知道這裡在忙(lib/unsavedWork)。
// 放在最外層:清單頁跟編輯器都要,而且換頁的時候不能掉。
function useUnsavedGuard() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if ([...drafts.values()].some((d) => d.dirty)) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    const unregister = registerBusySource(() => [...drafts.values()].some((d) => d.dirty));
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      unregister();
    };
  }, []);
}

/** 流程清單。 */
function WorkflowListPage() {
  useUnsavedGuard();
  const navigate = useNavigate();
  const isNarrow = useMediaQuery(MOBILE_QUERY);
  const [flows, setFlows] = useState<WorkflowSummary[] | null>(null);
  const [offsetMin, setOffsetMin] = useState(480);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setFlows(await listWorkflows());
    } catch (err) {
      toastError(errorMessage(err, '讀不到流程清單'));
      setFlows((f) => f ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void getCatalog().then((c) => setOffsetMin(c.utc_offset_min), () => {});
    // 從別的分頁回來(排程在背景跑過)時重抓一次
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // 有流程正在跑:每幾秒重抓一次,跑完的時候「上次執行」會自己變
  const anyRunning = !!flows?.some((f) => f.last_status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => void refresh(), LIST_POLL_MS);
    return () => window.clearInterval(t);
  }, [anyRunning, refresh]);

  const create = async () => {
    setCreating(true);
    try {
      const wf = await createWorkflow({name: '未命名流程'});
      navigate(`/workflow/${wf.id}`);
    } catch (err) {
      toastError(errorMessage(err, '建立不了'));
    } finally {
      setCreating(false);
    }
  };

  const onSwitch = useCallback(
    async (id: number, on: boolean) => {
      try {
        const wf = await switchSchedule(id, on);
        setFlows((list) => list?.map((f) => (f.id === id ? {...f, schedule: wf.schedule, next_run_at: wf.next_run_at} : f)) ?? list);
        // 編輯器裡還留著沒存的那一份的話,版本戳記跟著換,不然存檔會撞 409
        const kept = drafts.get(id);
        if (kept) drafts.set(id, {...kept, updatedAt: wf.updated_at, schedule: {...kept.schedule, on: wf.schedule.on}});
      } catch (err) {
        toastError(errorMessage(err, on ? '排程開不起來' : '排程關不掉'));
        throw err;
      }
    },
    [],
  );
  const onOpen = useCallback((id: number) => navigate(`/workflow/${id}`), [navigate]);

  // ── 清單的右鍵:重新命名、刪除 ──
  const onRename = useCallback(async (id: number, name: string) => {
    const old = flows?.find((f) => f.id === id)?.name;
    setFlows((list) => list?.map((f) => (f.id === id ? {...f, name} : f)) ?? list);
    try {
      // 沒有只改名字的 API:拿最新那一份,只換名字存回去(版本戳記照它的,撞到別人剛存的會 409)
      const cur = await getWorkflow(id);
      const wf = await saveWorkflow(id, {name, graph: cur.graph, schedule: cur.schedule, base_updated_at: cur.updated_at});
      // 編輯器裡還留著沒存的那一份的話,名字與版本戳記跟著換,不然存檔會撞 409
      const kept = drafts.get(id);
      if (kept) drafts.set(id, {...kept, name, updatedAt: wf.updated_at});
    } catch (err) {
      setFlows((list) => list?.map((f) => (f.id === id && old != null ? {...f, name: old} : f)) ?? list);
      toastError(errorMessage(err, '改不了名字'));
    }
  }, [flows]);
  /** 要刪的流程:右鍵刪一個,或勾選之後一次刪好幾個,確認框是同一個 */
  const [toDelete, setToDelete] = useState<WorkflowSummary[] | null>(null);
  /**
   * 刪除確認框的退場(不接的話吃的是設計系統預設的 400ms 進場 + 關掉硬切)。
   * 清掉 `toDelete` 放在**延後的那一側**:標題是讀它組出來的,淡出那 165ms 裡要還讀得到,
   * 不然會變成「刪除「」?」。
   */
  const deleteExit = useDialogExit((open: boolean) => {
    if (!open) setToDelete(null);
  });
  /** 正在刪(刪除鈕轉圈、不能再按:連按兩下會把同一批再刪一次,第二輪全部報「刪不掉」) */
  const [isDeleting, setIsDeleting] = useState(false);
  /** 同一件事的 ref 版:防重入要看當下的值,state 要等下一次 render 才讀得到(連發的兩下會都看到 false) */
  const deletingRef = useRef(false);
  /** 確認框現在問的是哪一批 —— 刪完要關的是**這一批**的框,不是中途取消後又打開的另一個 */
  const toDeleteRef = useRef(toDelete);
  toDeleteRef.current = toDelete;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectedFlows = flows?.filter((f) => selectedIds.has(String(f.id))) ?? [];

  // 跟用量統計、安全、帳號管理同一個頁框(標題大小、寬度、留白都一樣)
  return (
    <AdminPage
      title="Work Flow"
      actions={
        <HStack gap={2} vAlign="center">
          {/* 有勾才出現;字寫勾了幾個,按下去跟右鍵刪除同一個確認框 */}
          {selectedFlows.length > 0 ? (
            <Button
              label={`刪除${selectedFlows.length}個`}
              icon={<Icon icon={Trash2} size="sm" />}
              variant="secondary"
              onClick={() => setToDelete(selectedFlows)}
            />
          ) : null}
          <Button label="新增流程" icon={<Icon icon={Plus} size="sm" />} variant="primary" isDisabled={creating} onClick={() => void create()} />
        </HStack>
      }
    >
      {flows == null ? (
        <LoadingScreen isCompact label="載入中" />
      ) : flows.length === 0 ? (
        <EmptyState title="還沒有流程" />
      ) : (
        <FlowList
          rows={flows}
          offsetMin={offsetMin}
          onOpen={onOpen}
          onSwitch={onSwitch}
          onRename={onRename}
          onDelete={(row) => setToDelete([row])}
          selectedIds={selectedIds}
          onSelectedIdsChange={setSelectedIds}
          isNarrow={isNarrow}
        />
      )}
      {/* ⚠️ `onOpenChange` 要從 dialogProps 帶:它排在 AlertDialog 的 `{...rest}` 後面(見 Users.tsx 刪除框) */}
      <AlertDialog
        isOpen={toDelete != null}
        {...deleteExit.dialogProps}
        title={toDelete && toDelete.length > 1 ? `刪除${toDelete.length}個流程?` : `刪除「${toDelete?.[0]?.name ?? ''}」?`}
        description="排程會一起停掉,執行紀錄會留著。"
        actionLabel="刪除"
        // 跟編輯器那個確認框同一個理由,不用 destructive(見 WorkflowEditor 的 AlertDialog)
        actionVariant="primary"
        cancelLabel="取消"
        isActionLoading={isDeleting}
        onAction={async () => {
          const targets = toDelete;
          if (!targets?.length || deletingRef.current) return;
          deletingRef.current = true;
          setIsDeleting(true);
          // 一個一個刪:其中一個刪不掉(例如正在跑)不影響其他的;刪掉的從清單與勾選拿掉,刪不掉的留著
          const gone = new Set<number>();
          for (const target of targets) {
            try {
              await deleteWorkflow(target.id);
              drafts.delete(target.id);
              gone.add(target.id);
            } catch (err) {
              toastError(errorMessage(err, `「${target.name}」刪不掉`));
            }
          }
          deletingRef.current = false;
          setIsDeleting(false);
          // 刪的途中按了取消、又開了另一批的確認框的話,那個框不是這裡該關的
          if (toDeleteRef.current === targets) deleteExit.requestClose();
          setFlows((list) => list?.filter((f) => !gone.has(f.id)) ?? list);
          setSelectedIds((ids) => new Set([...ids].filter((id) => !gone.has(Number(id)))));
          if (gone.size) toastInfo(gone.size === 1 ? `已刪除「${targets.find((t) => gone.has(t.id))?.name ?? ''}」` : `已刪除${gone.size}個流程`);
        }}
      />
    </AdminPage>
  );
}

function WorkflowEditor({id}: {id: number}) {
  useUnsavedGuard();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  /** 拼圖清單問過了沒(成功或失敗都算)。畫布等它:見下面「畫面」那段的註解 */
  const [isCatalogSettled, setIsCatalogSettled] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [view, setView] = useState<'canvas' | 'history'>('canvas');
  const [run, setRun] = useState<RunView | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logTab, setLogTab] = useState<'events' | 'output'>('events');
  /**
   * 底部紀錄區收起來了沒。紀錄區常駐、不能關,只能收起 / 展開。
   * 還沒有紀錄可看的時候不看這個值:一律收著、不能展開,狀態那格寫「等待啟動」(見 RunLog)。
   * 不記在瀏覽器:記了的話收過一次,之後每次都只剩一條。開始執行、打開一次紀錄時自動展開
   */
  const [isLogCollapsed, setIsLogCollapsed] = useState(false);
  const [detail, setDetail] = useState<RunView | null>(null);
  const [history, setHistory] = useState<RunRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  // ── 上一步 / 下一步(按鈕或 Ctrl+Z,誤刪或改錯可以退回)──
  // 只記流程圖(拼圖、線、拼圖上的設定);名字與排程有自己的輸入框,不在這裡
  const past = useRef<FlowGraph[]>([]);
  const future = useRef<FlowGraph[]>([]);
  const lastEditAt = useRef(0);
  const restoring = useRef(false);
  // 按鈕的可用與否讀的是上面兩個 ref;每次記一步就把這個數字加一,逼頁首重畫
  const [, setHistoryTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 編輯器裡刪除確認框的退場(同清單頁那個) */
  const confirmDeleteExit = useDialogExit(setConfirmDelete);
  /** 正在刪(同清單頁:連按兩下會送兩次,第二次的「刪不掉」會蓋在「已刪除」上面) */
  const [isDeleting, setIsDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /**
   * 拖曳中跟著指標的小卡。`back`:沒放到畫布上、正在飛回拼圖盒 —— 位移量(螢幕 px),
   * 或 'fade'(減少動態:不飛,原地淡掉)。
   * ⚠️ **位置不在 state 裡**:每個 pointermove 都 setGhost 的話,整個編輯器連同畫布每一格重畫。
   * state 只有種類與「在不在畫布上」(有變才 set),位置由 placeGhost 直接寫 DOM
   */
  const [ghost, setGhost] = useState<{type: NodeType; over: boolean; back?: {dx: number; dy: number} | 'fade'} | null>(null);
  const ghostRef = useRef<HTMLElement | null>(null);
  const ghostTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(ghostTimer.current), []);
  /**
   * 這一次拖曳:指標在哪、抓在小卡哪一點(小卡掛上來量得到大小才算,見 ghostGrab)、按下去的點、按鈕的位置。
   * 小卡畫在「指標 − 抓點」,放下時拼圖的左上角也放在那裡 —— 拿起來、放下去都不會跳
   */
  const ghostDrag = useRef<GhostDrag | null>(null);
  /**
   * 小卡擺到指標底下。用獨立的 `translate` 屬性寫(不是 transform):transform 上有傾斜(rotate)和它的補間
   * (進到畫布上轉正、飛回去),位置每一格都要 1:1 跟手,不能被那段補間拖著。
   * 瀏覽器底線:獨立的 translate 屬性要 Chromium 104+ / Safari 14.1+ / Firefox 72+(內部工具,不做退路)
   */
  const placeGhost = useCallback(() => {
    const el = ghostRef.current;
    const d = ghostDrag.current;
    if (!el || !d) return;
    d.grab ??= ghostGrab(d.press, d.button, {w: el.offsetWidth, h: el.offsetHeight}, GHOST_LAND_INSET_PX);
    el.style.translate = `${d.pointer.x - d.grab.x}px ${d.pointer.y - d.grab.y}px`;
  }, []);
  // 小卡一掛上來(拿起來那一下)就擺好,第一幀不會出現在左上角
  const attachGhost = useCallback(
    (el: HTMLElement | null) => {
      ghostRef.current = el;
      placeGhost();
    },
    [placeGhost],
  );
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  /** 「有還沒儲存的改動」的退場。清 `leaveTo` 放延後那側:內文的「{dirtyNames}」淡出時還要在 */
  const leaveExit = useDialogExit((open: boolean) => {
    if (!open) setLeaveTo(null);
  });
  const isNarrow = useMediaQuery(MOBILE_QUERY);
  const navigate = useNavigate();
  const canvasRef = useRef<FlowCanvasHandle>(null);
  /** 畫布上次的縮放與位置。切去「執行紀錄」畫布會卸下,切回來照這個擺,不重新全部顯示 */
  const canvasViewRef = useRef<CanvasView | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const isRunning = run?.status === 'running';
  /**
   * 正在看的那一次執行,跑的是不是另一版的圖(從「執行紀錄」點開舊的那一次,之後流程改過)。
   * 是的話畫布畫**那一版**、而且不能編輯 —— 在舊的圖上改,改的其實是現在這一版,對不起來。
   */
  const snapshot =
    run && logOpen && draft && run.graph && JSON.stringify(run.graph) !== JSON.stringify(draft.graph) ? run.graph : null;
  const isLocked = isRunning || snapshot != null;
  const finishedRunShownRef = useRef(false);
  finishedRunShownRef.current = !!run && run.status !== 'running' && logOpen;
  /** 排程的時區(分鐘):後端給的。catalog 還沒到之前先用 +480,跟後端預設一樣。 */
  const offsetMin = catalog?.utc_offset_min ?? 480;

  // ── 載入 ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    void getCatalog()
      .then((c) => alive && setCatalog(c), (err) => toastError(errorMessage(err, '讀不到拼圖清單')))
      .finally(() => alive && setIsCatalogSettled(true));
    void (async () => {
      const kept = drafts.get(id);
      let wf;
      try {
        wf = await getWorkflow(id);
      } catch (err) {
        // 刪掉了、網址打錯:回清單。已經離開這一頁的話不要把人拉回來
        if (!alive) return;
        toastError(errorMessage(err, '讀不到這個流程'));
        navigate('/workflow', {replace: true});
        return;
      }
      if (!alive) return;
      const next: Draft = kept?.dirty ? kept : draftFromServer(wf);
      // 換了一個流程:上一步 / 下一步從頭記
      past.current = [];
      future.current = [];
      setDraft(next);
      drafts.set(id, next);
      if (wf.running_run_id) {
        // 別人(或排程)正在跑這一條:接上去看。這一步失敗只是看不到進度,流程本身照樣打開
        try {
          const r = await getRun(wf.running_run_id);
          if (!alive) return;
          setRun(r);
          setLogOpen(true);
        } catch (err) {
          if (alive) toastError(errorMessage(err, '讀不到正在跑的那一次'));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, navigate]);

  // 站內換頁前:有沒存的就先問。這個專案用的是 BrowserRouter,沒有 useBlocker,
  // 所以攔的是**連結的點擊**(側邊欄每一列都是 <a href>)。用程式 navigate() 的少數路徑
  // (例如側邊欄的 New chat)攔不到,但改動仍然留在 `drafts`,回來還在。
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank') return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (![...drafts.values()].some((d) => d.dirty)) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // ── 改圖 ──────────────────────────────────────────────────────────────────
  const update = useCallback((patch: Partial<Draft>) => {
    const cur = draftRef.current;
    if (!cur) return;
    if (patch.graph && patch.graph !== cur.graph && !restoring.current && JSON.stringify(patch.graph) !== JSON.stringify(cur.graph)) {
      const now = performance.now();
      // 一連串的「同一種」改動(拖一塊、打一串字)只在開頭記一次;加 / 刪拼圖或線一律自己一步,
      // 不然快速連刪兩塊按一次上一步兩塊一起回來
      const structural = structureKey(patch.graph) !== structureKey(cur.graph);
      if (structural || now - lastEditAt.current > HISTORY_GAP_MS) {
        past.current.push(cur.graph);
        if (past.current.length > HISTORY_MAX) past.current.shift();
      }
      lastEditAt.current = structural ? 0 : now;
      future.current = [];
      setHistoryTick((t) => t + 1);
    }
    const merged = {...cur, ...patch};
    const next = {...merged, dirty: snapshotKey(merged) !== merged.savedKey};
    drafts.set(next.id, next);
    // 執行結果還攤在畫布上的時候一動圖,就收起那次的結果回到編輯(紀錄仍在「執行紀錄」分頁)
    if (finishedRunShownRef.current) {
      setLogOpen(false);
      setRun(null);
      setDetail(null);
    }
    // 同一個事件裡連續改兩次(例如複製 = 新增 + 蓋設定)時,第二次要看得到第一次
    draftRef.current = next;
    setDraft(next);
  }, []);

  const stepHistory = useCallback(
    (from: React.MutableRefObject<FlowGraph[]>, to: React.MutableRefObject<FlowGraph[]>) => {
      const cur = draftRef.current;
      const graph = from.current.pop();
      if (!cur || !graph) return;
      to.current.push(cur.graph);
      restoring.current = true;
      update({graph});
      restoring.current = false;
      // 下一個改動一定另起一步,不要跟剛退回去的那一步合併
      lastEditAt.current = 0;
      // 退回 / 重做的那一塊選起來、平移到看得見的地方;是「回來的」(退回刪除)再播一次進場。
      // 只清掉選取的話,改動在畫面外時按了像沒反應。
      // 平移是直接跳過去(instant)、不補間:上一步 / 下一步是連按的動作(Ctrl+Z 按住、按鈕連點),
      // 補間的話按越快畫面越追在後面。重播進場(上一行)是刻意的,不在這條裡
      const hit = changedNode(cur.graph, graph);
      if (hit) {
        setSelected({kind: 'node', id: hit.id});
        if (hit.isBack) setFreshId(hit.id);
        canvasRef.current?.reveal(hit.id, {instant: true});
      } else {
        setSelected(null);
      }
      setHistoryTick((t) => t + 1);
    },
    [update],
  );
  const undo = useCallback(() => stepHistory(past, future), [stepHistory]);
  const redo = useCallback(() => stepHistory(future, past), [stepHistory]);

  // 剛加的那一塊:畫布播一次進場,播完就收回(不收回的話之後動畫名稱一換,進場會重播)
  const [freshId, setFreshId] = useState<string | null>(null);
  useEffect(() => {
    if (!freshId) return;
    const t = window.setTimeout(() => setFreshId(null), FRESH_MS);
    return () => window.clearTimeout(t);
  }, [freshId]);

  const addNode = useCallback(
    (type: NodeType, at: {x: number; y: number}, cfg?: NodeCfg, findFree = false) => {
      const cur = draftRef.current;
      if (!cur) return;
      if (findFree) at = freeSpot(cur.graph, at);
      // 編號接在最大的後面,不補洞:刪掉的 n2 不會被新的一塊撿走(執行紀錄裡的 n2 指的是舊的那塊)
      const used = cur.graph.nodes.map((m) => Number(/^n(\d+)$/.exec(m.id)?.[1] ?? 0));
      const id = `n${Math.max(0, ...used) + 1}`;
      update({graph: {...cur.graph, nodes: [...cur.graph.nodes, {id, type, x: Math.round(at.x), y: Math.round(at.y), cfg: cfg ? {...cfg} : catalog ? defaultCfg(type, catalog) : {}}]}});
      setSelected({kind: 'node', id});
      setFreshId(id);
    },
    [update, catalog],
  );

  const removeSelected = useCallback(() => {
    const cur = draftRef.current;
    if (!cur || !selected) return;
    if (selected.kind === 'node') {
      if (selected.id === 'start') return;
      update({graph: withoutNode(cur.graph, selected.id)});
    } else {
      update({graph: withoutEdge(cur.graph, selected.id)});
    }
    setSelected(null);
  }, [selected, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // 排程那片(dialog)裡按 Ctrl+Z 是那片自己的事,不是退畫布
      if (t.closest('input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="dialog"]')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !isLocked) {
        e.preventDefault();
        removeSelected();
      } else if (e.key === 'Escape') {
        setSelected(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if ((e.ctrlKey || e.metaKey) && !isLocked && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        // 輸入框裡的 Ctrl+Z 是那一格自己的復原(上面已經放行),這裡只管畫布
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && !isLocked && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── 從拼圖盒拖出來 ────────────────────────────────────────────────────────
  const onPalettePointerDown = (type: NodeType) => (e: React.PointerEvent) => {
    if (e.button !== 0 || isLocked) return;
    // 觸控不擋預設:手機上拼圖盒是橫的一排,橫著滑要讓瀏覽器捲(按鈕是 touch-action: pan-x,
    // 橫向的手勢瀏覽器接走、送 pointercancel;直的才會到這裡變成拖)
    if (e.pointerType !== 'touch') e.preventDefault();
    const source = e.currentTarget as HTMLElement;
    const sx = e.clientX;
    const sy = e.clientY;
    let lifted = false;
    let isOver = false;
    // 上一張還在飛回去的話,直接收掉(手比動畫快)
    window.clearTimeout(ghostTimer.current);
    setGhost(null);
    // pointer:小卡最後一次畫在哪(指標座標)。飛回去的位移從這裡算 —— 放手那一下的座標可能跟最後一次移動差幾 px
    const drag: GhostDrag = {pointer: {x: sx, y: sy}, grab: null, press: {x: sx, y: sy}, button: source.getBoundingClientRect()};
    ghostDrag.current = drag;
    const move = (ev: PointerEvent) => {
      // 門檻跟畫布同一條(滑鼠 4px、手指 10px,螢幕距離)
      if (!lifted && !exceedsSlop(ev.clientX - sx, ev.clientY - sy, ev.pointerType)) return;
      drag.pointer = {x: ev.clientX, y: ev.clientY};
      const over = !!canvasRef.current?.worldAt(ev.clientX, ev.clientY);
      if (!lifted) {
        lifted = true;
        setGhost({type, over});
      } else if (over !== isOver) {
        setGhost((g) => (g ? {...g, over} : g));
      }
      isOver = over;
      placeGhost();
    };
    const unlisten = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    /** 飛回拼圖盒那一顆(小卡跟按鈕左緣對齊、垂直置中),飛完才拿掉 */
    const flyBack = () => {
      const el = ghostRef.current;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // 用小卡沒有旋轉時的位置與大小算(左上角就是 pointer 減掉抓的那一點;offset 尺寸不含 rotate),落點才會準。
      // 落點跟拿起來的出發點是同一個(cardRest)
      const grab = drag.grab ?? {x: 0, y: 0};
      const left = drag.pointer.x - grab.x;
      const top = drag.pointer.y - grab.y;
      const rest = el ? cardRest(source.getBoundingClientRect(), {w: el.offsetWidth, h: el.offsetHeight}, GHOST_LAND_INSET_PX) : null;
      const back = reduce || !rest ? ('fade' as const) : {dx: rest.left - left, dy: rest.top - top};
      setGhost({type, over: false, back});
      ghostTimer.current = window.setTimeout(() => setGhost(null), GHOST_RETURN_MS);
    };
    const cancel = () => {
      unlisten();
      if (lifted) flyBack();
      else setGhost(null);
    };
    const up = (ev: PointerEvent) => {
      unlisten();
      // 一定要拖到畫布上才會加;只點一下不加(拼圖不會自己冒出來)
      if (!lifted) {
        setGhost(null);
        return;
      }
      const at = canvasRef.current?.worldAt(ev.clientX, ev.clientY);
      if (at) {
        setGhost(null);
        // 拼圖的左上角放在小卡的左上角:抓點是螢幕 px,換成世界座標要除以縮放比例
        const grab = drag.grab ?? {x: 0, y: 0};
        const k = canvasRef.current?.scale() ?? 1;
        addNode(type, {x: at.x - grab.x / k, y: at.y - grab.y / k});
      } else {
        flyBack();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  // ── 存檔 ──────────────────────────────────────────────────────────────────
  const save = useCallback(async (): Promise<boolean> => {
    const cur = draftRef.current;
    if (!cur || saving) return false;
    setSaving(true);
    try {
      const wf = await saveWorkflow(cur.id, {name: cur.name, graph: cur.graph, schedule: cur.schedule, base_updated_at: cur.updatedAt});
      const latest = draftRef.current;
      // 存的這段時間裡又改了的話,保留那些改動(只更新版本戳記)
      const next: Draft =
        latest && latest !== cur
          ? {...latest, updatedAt: wf.updated_at}
          : draftFromServer(wf);
      drafts.set(next.id, next);
      setDraft(next);
      return true;
    } catch (err) {
      toastError(errorMessage(err, '存不起來'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [saving]);

  // ── 執行 ──────────────────────────────────────────────────────────────────
  const start = async () => {
    const cur = draftRef.current;
    if (!cur) return;
    setStarting(true);
    try {
      if (cur.dirty && !(await save())) return;
      setSelected(null);
      setLogTab('events');
      setDetail(null);
      const r = await runWorkflow(cur.id);
      setRun(r);
      setLogOpen(true);
      setIsLogCollapsed(false);
      setView('canvas');
    } catch (err) {
      toastError(errorMessage(err, '開始不了'));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!run) return;
    try {
      await stopRun(run.id);
    } catch (err) {
      toastError(errorMessage(err, '停不下來'));
    }
  };

  // 執行中輪詢:只拿新的事件,步驟與線每次整份換
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await getRun(run.id, run.events.length);
        if (!alive) return;
        setRun((prev) => (prev && prev.id === r.id ? {...r, events: [...prev.events, ...r.events]} : prev));
        if (r.status !== 'running') {
          if (draftRef.current) void listRuns(draftRef.current.id).then(setHistory, () => {});
        }
      } catch {
        /* 一次沒問到就等下一次;網路斷太久使用者看得到秒數停住 */
        if (alive) setRun((prev) => (prev ? {...prev} : prev));
      }
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [run]);

  // 執行中的秒數
  useEffect(() => {
    if (!isRunning) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [isRunning]);

  // 「輸出」那一頁要每一步的完整輸出(一般輪詢不帶,太大)。
  // **不跟著 0.8 秒的輪詢一起抓**:整份輸出最多幾百行 × 每一步,執行中每 `OUTPUT_POLL_MS` 抓一次就夠,
  // 結束的那一刻再抓最後一次。
  const runId = run?.id;
  const runStatus = run?.status;
  useEffect(() => {
    if (runId == null || !logOpen || logTab !== 'output') return;
    let alive = true;
    const load = () => void getRun(runId, 0, true).then((r) => alive && setDetail(r), () => {});
    load();
    const t = runStatus === 'running' ? window.setInterval(load, OUTPUT_POLL_MS) : undefined;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [runId, runStatus, logOpen, logTab]);

  const closeLog = () => {
    // 回到「紀錄」那一頁:不然下一次執行或打開紀錄,停在上一次看的「每一步的輸出」
    setLogTab('events');
    setLogOpen(false);
    setRun(null);
    setDetail(null);
  };

  const openRun = async (runId: number) => {
    try {
      const r = await getRun(runId);
      setRun(r);
      setLogOpen(true);
      setIsLogCollapsed(false);
      setLogTab('events');
      setView('canvas');
    } catch (err) {
      toastError(errorMessage(err, '讀不到這次執行'));
    }
  };

  useEffect(() => {
    if (view === 'history' && draft) void listRuns(draft.id).then(setHistory, (err) => toastError(errorMessage(err, '讀不到執行紀錄')));
  }, [view, draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 畫布上的執行狀態 ──────────────────────────────────────────────────────
  const visual: RunVisual | null = useMemo(() => {
    if (!run || !logOpen) return null;
    const nodes: RunVisual['nodes'] = {};
    const progress: RunVisual['progress'] = {};
    const sub: RunVisual['sub'] = {};
    for (const s of run.steps) {
      nodes[s.node] = s.status;
      progress[s.node] = s.progress;
      if (s.status === 'running' && s.detail) sub[s.node] = s.detail;
    }
    const edges: RunVisual['edges'] = {};
    for (const p of run.path) edges[edgeKey(p)] = p.state;
    if (run.status !== 'running') {
      for (const n of (run.graph ?? draft?.graph)?.nodes ?? []) if (!nodes[n.id]) nodes[n.id] = 'skip';
    }
    return {nodes, edges, progress, sub};
  }, [run, logOpen, draft?.graph.nodes]);

  const leave = async (saveFirst: boolean) => {
    const to = leaveTo;
    if (!to) return;
    if (saveFirst && draftRef.current?.dirty && !(await save())) return;
    // 不存直接離開:丟掉這個分頁裡所有沒存的改動,回來看到的是存過的那一版
    if (!saveFirst) drafts.clear();
    // 跳頁跟關閉同時發生就好:對話框在上面淡出,底下已經換頁(useDialogExit 的說明)
    leaveExit.requestClose();
    navigate(to);
  };
  const [headRef, headWraps] = useHeadWraps();
  const dirtyNames = [...drafts.values()].filter((d) => d.dirty).map((d) => d.name).join('」「');

  // ── 畫面 ──────────────────────────────────────────────────────────────────
  // 流程與拼圖清單**都到了**才畫畫布。拼圖上的欄位是照清單畫的:清單晚到的話,拼圖先畫成沒有欄位的矮版,
  // 下一刻長出欄位、變高,「全部顯示」又重算一次 —— 進流程時那一下會閃
  if (!draft || !isCatalogSettled) {
    return (
      <Stack xstyle={styles.loading}>
        <LoadingScreen label="載入中" />
      </Stack>
    );
  }

  const problems = runProblems(draft.graph, catalog);
  const status = isRunning ? '' : problems[0] ?? (draft.dirty ? '尚未儲存' : '');
  // 點狀態字:選到下一塊有問題的拼圖,畫布平移過去(已經選著的那塊也要平移,所以明講 reveal)
  const bad = problems.length ? problemNodes(draft.graph, catalog) : [];
  const goToProblem = () => {
    if (!bad.length) return;
    const at = selected?.kind === 'node' ? bad.indexOf(selected.id) : -1;
    const id = bad[(at + 1) % bad.length];
    setSelected({kind: 'node', id});
    canvasRef.current?.reveal(id);
  };

  const duplicate = (nodeId: string) => {
    const n = draft.graph.nodes.find((m) => m.id === nodeId);
    if (n) addNode(n.type, {x: n.x + DUPLICATE_OFFSET, y: n.y + DUPLICATE_OFFSET}, n.cfg, true);
  };
  // 返回清單:有沒存的先問(跟點側邊欄同一個對話框)
  const back = () => {
    if (draftRef.current?.dirty) setLeaveTo('/workflow');
    else navigate('/workflow');
  };

  // 流程名稱那顆下拉:改名、刪除。選單項目的 destructive 是白底紅字,正常(壞掉的是 Button 的 destructive,見下面 AlertDialog)
  const flowMenuItems = [
    {label: '重新命名', icon: <Icon icon={Pencil} size="sm" />, onClick: () => setRenaming(true)},
    {label: '刪除這個流程', icon: <Icon icon={Trash2} size="sm" />, variant: 'destructive' as const, isDisabled: isRunning, onClick: () => setConfirmDelete(true)},
  ];

  // 拼圖盒:寬的時候是左邊的 LayoutPanel,窄的時候是畫布上方的一條
  const palette = (
    <Stack xstyle={[styles.palette, isNarrow && styles.paletteNarrow]} role="list" aria-label="拼圖">
      {PALETTE.map((g) => (
        <Stack key={g.group} xstyle={isNarrow ? styles.groupNarrow : undefined}>
          {isNarrow ? null : (
            <Text type="supporting" color="secondary" weight="semibold" xstyle={styles.palHead}>
              {g.group}
            </Text>
          )}
          {g.types.map((t) => (
            <Stack key={t} role="listitem" xstyle={styles.palItem}>
              <Button
                label={catalog?.nodes[t]?.label ?? t}
                icon={<Icon icon={NODE_ICONS[t]} size="sm" />}
                variant="ghost"
                isDisabled={isLocked}
                width="100%"
                xstyle={[styles.palButton, isNarrow && styles.palButtonNarrow, ghost?.type === t && styles.palLifted]}
                onPointerDown={onPalettePointerDown(t)}
                onClick={(e: React.MouseEvent) => {
                  // 滑鼠 / 觸控只能拖(見 onPalettePointerDown);這裡只接鍵盤 ——
                  // 拖不了的人唯一的路(Enter / 空白鍵的 click 沒有 detail),放在畫面中央
                  if (e.detail !== 0) return;
                  const c = canvasRef.current?.center();
                  if (c) addNode(t, {x: c.x - NODE_CENTER_OFFSET.x, y: c.y - NODE_CENTER_OFFSET.y}, undefined, true);
                }}
              />
            </Stack>
          ))}
        </Stack>
      ))}
    </Stack>
  );

  return (
    <VStack gap={0} xstyle={styles.page}>
      <VisuallyHidden>
        <Heading level={1}>Work Flow</Heading>
      </VisuallyHidden>

      <HStack ref={headRef} gap={3} vAlign="center" xstyle={[styles.head, (isNarrow || headWraps) && styles.headNarrow]}>
        <IconButton label="回到流程清單" icon={<Icon icon={ChevronLeft} size="sm" />} variant="ghost" onClick={back} xstyle={styles.back} />
        {renaming ? (
          // 頁首橫排裡的一格,可以縮(固定 240 的話頁首被撐爆,執行鈕被推出畫面)
          <Stack xstyle={styles.renameInput}>
          <TextInput
            label="流程名稱"
            isLabelHidden
            value={draft.name}
            hasAutoFocus
            onChange={(name: string) => update({name})}
            onEnter={() => setRenaming(false)}
            onBlur={() => {
              if (!draft.name.trim()) update({name: '未命名流程'});
              setRenaming(false);
            }}
            width="100%"
          />
          </Stack>
        ) : (
          // ⚠️ 包一層:DropdownMenu / Popover 除了按鈕還會多掛一個寬度 0 的元素,在頁首的 flex 裡
          // 各自再吃一格間距 —— 四個加起來 48px,1024 寬的視窗頁首就放不下
          <Stack xstyle={styles.headItem}>
            <DropdownMenu button={{label: draft.name, variant: 'ghost', size: 'md'}} items={flowMenuItems} menuWidth={200} />
          </Stack>
        )}
        {/* 兩格一樣寬 */}
        <SegmentedControl label="檢視" layout="fill" xstyle={styles.viewSwitch} value={view} onChange={(v: string) => setView(v === 'history' ? 'history' : 'canvas')}>
          <SegmentedControlItem value="canvas" label="畫布" />
          <SegmentedControlItem value="history" label="執行紀錄" />
        </SegmentedControl>
        <Stack xstyle={styles.grow} />
        <Stack xstyle={styles.headItem}>
          <Popover
            isOpen={schedOpen}
            onOpenChange={setSchedOpen}
            label="排程"
            placement="below"
            alignment="end"
            content={<SchedulePanel value={draft.schedule} offsetMin={offsetMin} onChange={(schedule) => update({schedule})} />}
          >
            {/* 按鈕上直接寫排程(「每天 02:00」/「未排程」),不另外放標籤:
                1024 寬 + 側邊欄展開時頁首放不下,執行鈕會被擠出去 */}
            <Button
              label={scheduleShort(draft.schedule)}
              icon={<Icon icon={CalendarClock} size="sm" />}
              variant={draft.schedule.on ? 'secondary' : 'ghost'}
              isDisabled={isRunning}
            />
          </Popover>
        </Stack>
        <IconButton label="上一步" icon={<Icon icon={Undo2} size="sm" />} variant="ghost" isDisabled={!past.current.length || isLocked} onClick={undo} />
        <IconButton label="下一步" icon={<Icon icon={Redo2} size="sm" />} variant="ghost" isDisabled={!future.current.length || isLocked} onClick={redo} />
        <Button label={saving ? '儲存中' : '儲存'} icon={<Icon icon={Save} size="sm" />} variant="secondary" isDisabled={!draft.dirty || saving || isRunning} onClick={() => void save()} />
        {isRunning ? (
          <Button label="停止" icon={<Icon icon={Square} size="sm" />} variant="secondary" onClick={() => void stop()} />
        ) : (
          <Button
            label={run && logOpen ? '重新執行' : '執行'}
            icon={<Icon icon={Play} size="sm" />}
            variant="primary"
            isDisabled={problems.length > 0 || starting}
            onClick={() => void start()}
          />
        )}
      </HStack>

      {/*
        拼圖盒是 LayoutPanel、畫布是 LayoutContent。手機寬度拼圖盒是畫布上方的一條,放在 content 裡。
        ⚠️ 頁首**不用** LayoutHeader:它內建一段 16px 的底部間距、沒有開放調整,換上去頁首的按鈕會往上偏。
        頁首維持上面那條自己的 HStack。
      */}
      {/* ⚠️ 這一層不能省:Layout 的 height="fill" 是 100%,在直排裡不會縮到比內容矮 —— 視窗矮到拼圖盒放不下時
         整塊會被頁首往下推、最底下那段拼圖捲不到。給剩下的高度、可以縮到 0 */}
      <Stack xstyle={styles.main}>
        <Layout
          height="fill"
          start={
            view === 'canvas' && !isNarrow ? (
              <LayoutPanel width={PALETTE_WIDTH_PX} hasDivider padding={0}>
                {palette}
              </LayoutPanel>
            ) : undefined
          }
          content={
            <LayoutContent padding={0} isScrollable={false}>
              {view === 'history' ? (
                <Stack xstyle={styles.history}>
                  {/* 跟流程清單同一個頁框(置中、同一個寬度上限與留白):兩張表的寬度與左右邊界對齊 */}
                  <AdminColumn>
                    {history == null ? (
                      <LoadingScreen isCompact label="載入中" />
                    ) : history.length === 0 ? (
                      <EmptyState title="還沒有執行過" />
                    ) : (
                      <HistoryTable rows={history} offsetMin={offsetMin} onOpen={(id) => void openRun(id)} isNarrow={isNarrow} />
                    )}
                  </AdminColumn>
                </Stack>
              ) : (
                <Stack xstyle={[styles.body, isNarrow && styles.bodyNarrow]}>
                  {isNarrow ? palette : null}
                  <Stack xstyle={styles.canvasWrap}>
                    {/* 狀態字(不能執行的原因 / 尚未儲存)放在畫布左上角,跟右上角的縮放列對稱。
                        ⚠️ 不要放到頁首:頁首一擠它就被縮成「尚未…」看不到,
                        而執行鈕變灰的時候,這一行就是唯一的原因說明 */}
                    {snapshot ? (
                      // 正在看舊的那一次(那時候的圖,不能編輯)。紀錄區不能關,從這裡回到現在這一版
                      <Stack xstyle={styles.statusBox}>
                        <Button label="回到目前的流程" icon={<Icon icon={ArrowLeft} size="sm" />} variant="ghost" size="sm" xstyle={styles.statusButton} onClick={closeLog} />
                      </Stack>
                    ) : status ? (
                      <Stack xstyle={styles.statusBox} role="status">
                        {bad.length ? (
                          // 點下去帶到那一塊(再點換下一塊)—— 只寫一行字的話不知道是哪一塊
                          <Button
                            label={status}
                            variant="ghost"
                            size="sm"
                            xstyle={styles.statusButton}
                            onClick={goToProblem}
                          />
                        ) : (
                          <Text type="supporting" xstyle={problems.length ? styles.warnText : styles.mutedText}>
                            {status}
                          </Text>
                        )}
                      </Stack>
                    ) : null}
                    <FlowCanvas
                      ref={canvasRef}
                      graph={snapshot ?? draft.graph}
                      catalog={catalog}
                      selected={selected}
                      onSelect={setSelected}
                      onGraphChange={(graph) => update({graph})}
                      onDuplicate={duplicate}
                      freshId={freshId}
                      run={visual}
                      isLocked={isLocked}
                      initialView={canvasViewRef.current}
                      onViewChange={(v) => {
                        canvasViewRef.current = v;
                      }}
                      bottomInsetPx={LOG_DOCK_PX}
                    />
                    {/* 紀錄區常駐:一進來就在,還沒執行過就是空的 */}
                    <RunLogWithTabs
                      run={run && logOpen ? run : null}
                      detail={detail}
                      tab={logTab}
                      onTab={setLogTab}
                      reach={reachable(snapshot ?? draft.graph).size}
                      now={now}
                      isNarrow={isNarrow}
                      isCollapsed={isLogCollapsed}
                      onToggle={() => setIsLogCollapsed(!isLogCollapsed)}
                    />
                  </Stack>
                </Stack>
              )}
            </LayoutContent>
          }
        />
      </Stack>

      {ghost ? (
        // 拖曳中跟著指標走的那張小卡。位置(`translate`)由 placeGhost 直接寫 DOM,這裡的 style 只放飛回去的位移
        <Stack
          ref={attachGhost}
          xstyle={[styles.ghost, ghost.over && styles.ghostOver, ghost.back === 'fade' ? styles.ghostFade : ghost.back ? styles.ghostBack : null]}
          style={ghost.back && ghost.back !== 'fade' ? {transform: `translate(${ghost.back.dx}px, ${ghost.back.dy}px)`} : undefined}
          aria-hidden="true"
        >
          <Token size="md" label={catalog?.nodes[ghost.type]?.label ?? ghost.type} icon={<Icon icon={NODE_ICONS[ghost.type]} size="sm" />} />
        </Stack>
      ) : null}

      <AlertDialog
        isOpen={confirmDelete}
        {...confirmDeleteExit.dialogProps}
        isActionLoading={isDeleting}
        title={`刪除「${draft.name}」?`}
        description="排程會一起停掉,執行紀錄會留著。"
        actionLabel="刪除"
        // ⚠️ 不用 destructive:這個佈景的 `.astryx-button.destructive` 把字設成紅色,
        // 跟元件本身的紅底疊在一起 → 紅底紅字看不到
        actionVariant="primary"
        cancelLabel="取消"
        onAction={async () => {
          if (deletingRef.current) return;
          deletingRef.current = true;
          setIsDeleting(true);
          try {
            await deleteWorkflow(draft.id);
            drafts.delete(draft.id);
            confirmDeleteExit.requestClose();
            toastInfo(`已刪除「${draft.name}」`);
            navigate('/workflow');
          } catch (err) {
            toastError(errorMessage(err, '刪不掉'));
          } finally {
            deletingRef.current = false;
            setIsDeleting(false);
          }
        }}
      />

      <Dialog isOpen={leaveTo != null} {...leaveExit.dialogProps} width={420} purpose="info">
        <Layout
          header={<DialogHeader title="有還沒儲存的改動" onOpenChange={leaveExit.dialogProps.onOpenChange} />}
          content={
            <LayoutContent>
              <Text type="body">「{dirtyNames}」改過還沒存。</Text>
            </LayoutContent>
          }
          footer={
            // ⚠️ 要包 LayoutFooter:裸放 HStack 沒有內距,三顆鈕貼著對話框右緣、跟上面的字擠在一起
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button label="留在這裡" variant="ghost" onClick={leaveExit.requestClose} />
                <Button label="不存,直接離開" variant="secondary" onClick={() => leave(false)} />
                <Button label={saving ? '儲存中' : '儲存後離開'} variant="primary" isDisabled={saving} onClick={() => void leave(true)} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </VStack>
  );
}

function RunLogWithTabs({
  run,
  detail,
  tab,
  onTab,
  reach,
  now,
  isNarrow,
  isCollapsed,
  onToggle,
}: {
  /** null = 還沒有要看的那一次(紀錄區是空的) */
  run: RunView | null;
  detail: RunView | null;
  tab: 'events' | 'output';
  onTab: (t: 'events' | 'output') => void;
  reach: number;
  now: number;
  isNarrow: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const shown = tab === 'output' && run ? 'output' : 'events';
  // 紀錄 ↔ 輸出是「同一個框」(RunOutput 的說明),互換時是換掉整個元件、新的那個重新掛上 ——
  // 不擋的話每換一次就重播一次 300ms 往上浮。進場只在紀錄區第一次出現時播;
  // 換過一次之後新掛上的那一塊一律不播。在 render 裡比對、當場 setState(只會翻一次),
  // 換的那一次 render 就已經是 true —— 放 effect 裡的話新的那塊會先帶著動畫畫一幀
  const [firstShown] = useState(shown);
  const [hasSwapped, setHasSwapped] = useState(false);
  if (!hasSwapped && shown !== firstShown) setHasSwapped(true);
  if (shown === 'output') {
    return <RunOutput detail={detail} onBack={() => onTab('events')} isCollapsed={isCollapsed} onToggle={onToggle} hasEnter={!hasSwapped} />;
  }
  return (
    <RunLog
      run={run}
      reach={reach}
      now={now}
      isNarrow={isNarrow}
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      hasEnter={!hasSwapped}
      // 有框(secondary)、寫全名,看得出是按鈕;不放圖示。窄的時候紀錄自己讓出進度條的位置,這顆整顆放得下
      actions={<Button label="查看每一步的輸出" variant="secondary" size="sm" onClick={() => onTab('output')} />}
    />
  );
}

const styles = stylex.create({
  page: {height: '100%', minHeight: 0, boxSizing: 'border-box', backgroundColor: 'var(--color-background-card)'},
  denied: {flex: '1 1 0', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-6)'},
  loading: {height: '100%', alignItems: 'center', justifyContent: 'center'},
  // 寬螢幕不換行:會換行的 flex 是「先換行、不先縮」,改名的輸入框就不會縮,執行鈕直接掉到第二行。
  // 放得下靠兩件事:排程寫在排程鈕上、DropdownMenu / Popover 各包一格
  head: {
    height: 56,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    paddingInline: 'var(--spacing-5) var(--spacing-4)',
    borderBottomWidth: 'var(--border-width)',
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--color-border)',
  },
  // 放不下就換行(手機寬度,或側邊欄展開的中等視窗,見 useHeadWraps);不換行的話儲存 / 執行會被切掉
  headNarrow: {height: 'auto', flexWrap: 'wrap', rowGap: 'var(--spacing-2)', paddingBlock: 'var(--spacing-2)', paddingInline: 'var(--spacing-3)'},
  headItem: {flexShrink: 0},
  // 「畫布 / 執行紀錄」兩格等寬:最長的「執行紀錄」四個字 + 內距 ≈ 80,兩格 160 再加外框
  viewSwitch: {width: 176, flexShrink: 0},
  // 最寬 240、擠的時候縮到 120。⚠️ 給外面這一格,不要直接給 TextInput —— 它裡面是直排,flex-basis 會變成高度
  renameInput: {flex: '0 1 240px', minWidth: 120},
  grow: {flex: '1 1 0', minWidth: 0},
  back: {marginInlineStart: 'calc(var(--spacing-2) * -1)'},
  warnText: {color: 'var(--color-warning)'},
  mutedText: {color: 'var(--color-text-secondary)'},
  statusBox: {
    position: 'absolute',
    top: 'var(--spacing-3)',
    left: 'var(--spacing-3)',
    // 右上角是縮放列,留出它的寬度,窄螢幕上換行而不是疊上去
    maxWidth: 'calc(100% - 200px)',
    zIndex: 10,
    paddingBlock: 'var(--spacing-1)',
    paddingInline: 'var(--spacing-2)',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-background-surface)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    boxShadow: 'var(--shadow-low)',
  },
  // 狀態字變成按鈕時:字色維持警告色,外框由 statusBox 給(按鈕自己不再加一圈)
  statusButton: {color: 'var(--color-warning)', marginBlock: 'calc(var(--spacing-1) * -1)', marginInline: 'calc(var(--spacing-2) * -1)'},
  main: {flex: '1 1 0', minHeight: 0},
  body: {height: '100%', minHeight: 0, position: 'relative', flexDirection: 'row'},
  bodyNarrow: {flexDirection: 'column'},
  // 寬度與分隔線由 LayoutPanel 給(見 PALETTE_WIDTH_PX);這裡只管內距。flexShrink:手機寬度那一條在畫布上方,
  // 視窗再矮也不能被壓扁
  palette: {
    flexShrink: 0,
    paddingBlock: 'var(--spacing-1-5) var(--spacing-4)',
    paddingInline: 'var(--spacing-2)',
  },
  paletteNarrow: {
    flexDirection: 'row',
    overflowX: 'auto',
    overflowY: 'hidden',
    borderBottomWidth: 'var(--border-width)',
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--color-border)',
    paddingBlock: 'var(--spacing-1-5)',
  },
  groupNarrow: {flexDirection: 'row'},
  palHead: {paddingBlock: 'var(--spacing-2) var(--spacing-1)', paddingInline: 'var(--spacing-2)'},
  palItem: {flexShrink: 0},
  // 拼圖盒的按鈕:靠左對齊、拖曳時不要選到字、不要觸發瀏覽器的觸控捲動
  // 只能拖到畫布上(不能點),所以要看得出「可以抓」:抓手游標、按下去縮一點(抓住的回饋)、
  // 拖出去的時候原位淡掉(那一塊在手上)
  palButton: {
    justifyContent: 'flex-start',
    cursor: {default: 'grab', ':active': 'grabbing'},
    touchAction: 'none',
    userSelect: 'none',
    transform: {default: null, ':active': {default: 'scale(0.97)', '@media (prefers-reduced-motion: reduce)': null}},
    transitionProperty: 'transform, opacity',
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-panel)',
  },
  palLifted: {opacity: 0.4},
  // 手機:橫的那一排要能用手指左右捲(橫向交給瀏覽器),往下拖到畫布才是拖拼圖
  palButtonNarrow: {touchAction: 'pan-x'},
  canvasWrap: {flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative'},
  // 留白交給裡面的 Section(跟 AdminPage 同一套),這一層只管捲動
  history: {height: '100%', minHeight: 0, overflowY: 'auto'},
  ghost: {
    position: 'fixed',
    // 位置是 inline 的 translate(placeGhost),從視窗左上角算
    left: 0,
    top: 0,
    zIndex: 100,
    pointerEvents: 'none',
    boxShadow: 'var(--shadow-med)',
    borderRadius: 'var(--radius-element)',
    transform: 'rotate(-2deg)',
    transitionProperty: 'transform',
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-panel)',
  },
  ghostOver: {transform: 'none'},
  // 飛回拼圖盒:只補間 transform(位移量寫在 inline style),轉正、影子收掉 —— 落回按鈕上的樣子
  ghostBack: {
    transitionProperty: 'transform, box-shadow',
    transitionDuration: 'var(--duration-medium)',
    transitionTimingFunction: 'var(--ease-panel)',
    boxShadow: 'none',
  },
  ghostFade: {transitionProperty: 'opacity', transitionDuration: 'var(--duration-fast)', transitionTimingFunction: 'var(--ease-panel)', opacity: 0},
});
