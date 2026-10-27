/**
 * Work Flow 的畫布:拼圖、連線、平移縮放、拉線、執行時的動畫。
 *
 * ⚠️ 這裡用原生的 `<div>` / `<svg>` 而不是 Astryx 的版面元件:整個世界要套一個
 * `transform: translate() scale()`、每一塊拼圖是絕對定位、接點要量 `offsetLeft` ——
 * 這是自己畫的圖,不是版面(跟 `terminal/HostStage.tsx` 的 stage 同一個例外)。
 *
 * 接點的位置**從 DOM 量**(`offsetLeft` 一路加回拼圖,不受 transform 影響),
 * 不是用常數算:拼圖的高度跟摘要有沒有第二行、字型有沒有載好都有關,
 * 寫死的話線會對不準接點。
 */
import {forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Token} from '@astryxdesign/core/Token';
import {Check, Copy, Maximize2, Minus, Plus, Trash2, TriangleAlert, X} from 'lucide-react';

import type {Catalog, FlowGraph, FlowNode, NodeCfg} from '../../lib/workflowApi';
import {FRAME_MS, easeStep, frameDelta} from '../../lib/frameEase';
import {prefersReducedMotion} from '../../lib/rubberband';
import {useLatest} from '../../lib/useLatest';
import {releaseVelocityPxPerMs} from '../../lib/velocity';
import {INLINE_FIELDS, PALETTE_TYPES, clientIssue, type ClientIssue, connect, curve, curveMid, curveMidNormal, edgeKey, isUnset, scriptProblem, reachable, withoutEdge, withoutNode} from '../../lib/workflowGraph';
import {FieldInput, FieldRow} from './NodeFields';
import {NODE_ICONS} from './nodeIcons';

export type Selection = {kind: 'node' | 'edge'; id: string} | null;

/** 執行時每一塊 / 每一條線的樣子。沒有在跑的時候整個是 null。 */
export type RunVisual = {
  nodes: Record<string, 'running' | 'ok' | 'fail' | 'skip'>;
  edges: Record<string, 'done' | 'fail' | 'dim'>;
  progress: Record<string, number | null>;
  /** 同步那塊執行中第二行改成檔案數之類的字 */
  sub: Record<string, string>;
};

export type FlowCanvasHandle = {
  fit: () => void;
  /**
   * 選到這一塊並把它平移進畫面(已經選著、已經在畫面裡也照做 —— 狀態字「帶我到那一塊」用)。
   * `instant` = 直接跳過去、不補間:上一步 / 下一步是會連按的動作,補間的話按越快畫面越追在後面。
   * 只有狀態字那顆按鈕(點一下、看它帶你過去)保留補間
   */
  reveal: (id: string, opts?: {instant?: boolean}) => void;
  /** 從拼圖盒放下來:螢幕座標在畫布裡就回世界座標,不在回 null。 */
  worldAt: (clientX: number, clientY: number) => {x: number; y: number} | null;
  center: () => {x: number; y: number};
  /** 目前的縮放比例。拼圖盒放下時把「抓在小卡哪一點」(螢幕 px)換成世界座標用 */
  scale: () => number;
};

type Props = {
  graph: FlowGraph;
  catalog: Catalog | null;
  selected: Selection;
  onSelect: (s: Selection) => void;
  onGraphChange: (g: FlowGraph) => void;
  /** 拼圖右鍵的「複製」 */
  onDuplicate: (id: string) => void;
  /** 剛加進來的那一塊(拖出來、點出來、複製出來),播一次進場。頁面在加的那一刻給、動畫播完就收回 */
  freshId?: string | null;
  run: RunVisual | null;
  isLocked: boolean;
  /**
   * 掛上來時用這個視角(上次離開畫布時的縮放與位置),不重新「全部顯示」。null = 第一次打開,全部顯示。
   * 「畫布 → 執行紀錄 → 畫布」畫布是重新掛的,不帶著的話縮放、平移每切一次就重來
   */
  initialView?: View | null;
  /** 畫布底部被蓋住多高(常駐的紀錄區,見 RunPanels 的 LOG_DOCK_PX)。「全部顯示」扣掉它,拼圖不會被紀錄區蓋住 */
  bottomInsetPx?: number;
  /** 視角每變一次就回報(給上一層記著,見 initialView) */
  onViewChange?: (v: View) => void;
};

export type View = {x: number; y: number; k: number};
type Pt = {x: number; y: number};

/** 拼圖的寬度(px)。從拼圖盒點一下放到畫面中央時,拿它的一半對齊。設定直接畫在拼圖上,要放得下一個下拉選單。 */
export const NODE_WIDTH = 240;
/** 放到畫面中央時,拼圖左上角離中心點多遠(大約半塊拼圖)。 */
export const NODE_CENTER_OFFSET = {x: NODE_WIDTH / 2, y: 50};

const K_MIN = 0.25;
const K_MAX = 1.8;
/**
 * 打開時「全部顯示」最多縮到多小。放不下就讓使用者自己拖畫布。
 * 再小的話拼圖上的字幾乎讀不到 —— 先看得清楚,全貌用「全部顯示」鈕或縮小鈕(手動仍可縮到 25%)。
 */
const K_FIT_MIN = 0.85;
/**
 * 拖拼圖 / 平移的門檻(**螢幕** px):移動小於這個當成點一下。滑鼠穩,手指會抖 ——
 * 照畫布座標算(除以縮放比例)的話,縮到 25% 時手指抖 1px 就算拖了:拼圖點不選、還多一步「上一步」
 */
const CLICK_SLOP_MOUSE = 4;
const CLICK_SLOP_TOUCH = 10;
const slopOf = (pointerType: string) => (pointerType === 'mouse' ? CLICK_SLOP_MOUSE : CLICK_SLOP_TOUCH);
/** 從按下去的地方移動 (dx, dy) 算不算「拖」(不是點一下)。拼圖盒的拖曳也用這一條,門檻全頁一致 */
export const exceedsSlop = (dx: number, dy: number, pointerType: string) => Math.hypot(dx, dy) > slopOf(pointerType);
/** 觸控長按多久算「右鍵」(ms)。跟系統的長按選單差不多 */
const LONG_PRESS_MS = 500;
/**
 * 拉線時離輸入接點多近就吸過去(螢幕 px)。**照螢幕算,不照世界座標**:
 * 縮到 60% 的時候手要移的距離跟 100% 一樣。游標停在拼圖上面也算吸到。
 */
const SNAP_PX = 56;
/** 接上之後,新的線與目標拼圖閃一下多久(ms)。⚠️ 要 ≥ 樣式裡 `edgeJust`(300ms)與 `nodeJust`(250ms)的動畫長度,不然動畫會被切掉 */
const JUST_LINKED_MS = 350;
/**
 * 縮放鈕 / 全部顯示的補間多久之後關掉(ms)。補間本身是 `--duration-fast`(佈景給的,125–230ms),
 * 這裡要比它長。只有按鈕觸發才補間,滾輪與拖曳是直接操作,不能有延遲。
 */
const VIEW_ANIM_OFF_MS = 250;
/**
 * 拖拼圖 / 拉線時,指標離畫布邊緣這麼近(px)就自動往那邊捲;越靠邊越快,到邊上(或出了畫布)是每幀
 * `EDGE_PAN_MAX` px。不然拖不到畫面外的地方:要先放下、捲過去、再拿起來
 */
const EDGE_PAN_PX = 32;
const EDGE_PAN_MAX = 12;
/**
 * 回彈(rubber-banding):縮放到上下限不硬停、平移有邊界(不然整張流程可以推到畫面外找不回來)。
 * 超過界線越拉越緊(`RUBBER_C` 是 Apple 的係數),放手 `SETTLE_MS` 後彈回界線內。
 *  - 平移的界線:流程(所有拼圖的外框)至少還有 `PAN_KEEP_PX` 留在畫面裡(彈回後)。
 *  - 縮放:最多超出上下限 `ZOOM_BAND`(6%),越往外越難推。
 */
const PAN_KEEP_PX = 120;
/**
 * 平移超過界線時回彈的「尺」:`rubberband` 再怎麼拉都逼近不到 PAN_RUBBER_DIM 本身,所以它要比 PAN_KEEP_PX 小 ——
 * 拉到最遠流程也還有 40px 以上在畫面裡。用畫布寬當尺的話整張流程會被拉出畫面、看起來像一片空白
 */
const PAN_RUBBER_DIM = 80;
/** 彈回之後至少要有一塊拼圖露出這麼多(px)—— 只看外框的話,斜拉到角落露出來的可能是外框的空角 */
const NODE_KEEP_PX = 60;
const RUBBER_C = 0.55;
const ZOOM_BAND = 0.06;
const SETTLE_MS = 150;
/** 超過界線多少,畫面上只跟著走這麼多(越拉越緊,再怎麼拉都到不了 dim) */
const rubberband = (over: number, dim: number) => (over * dim * RUBBER_C) / (dim + RUBBER_C * over);
/** raw 在 [lo, hi] 裡就照走,出了界線就回彈式地跟 */
const softClamp = (raw: number, lo: number, hi: number, dim: number) =>
  raw < lo ? lo - rubberband(lo - raw, dim) : raw > hi ? hi + rubberband(raw - hi, dim) : raw;
/** 縮放的回彈:超出上下限的部分壓到最多 ZOOM_BAND(指數趨近,越推越難) */
const softZoom = (raw: number) =>
  raw > K_MAX
    ? K_MAX * (1 + ZOOM_BAND * (1 - Math.exp(-(raw / K_MAX - 1) / ZOOM_BAND)))
    : raw < K_MIN
      ? K_MIN * (1 - ZOOM_BAND * (1 - Math.exp(-(1 - raw / K_MIN) / ZOOM_BAND)))
      : raw;
/** 「全部顯示」時畫布上方留的空白(px):左上角的狀態字、右上角的縮放列在這一條,不要蓋到拼圖 */
const TOP_BAR_PX = 56;
/** 右鍵拼圖浮出的那兩顆鈕,上面放不下(拼圖貼著畫布頂端)就改放下面 */
const NODE_BAR_ROOM_PX = 48;
/**
 * 選到線時那顆 X 的半寬(IconButton sm = 28px 的一半;縮放前)與它離線的間距 —— 用來算沿法線推多遠。
 * 間距跟 spacing-1-5 同值(6px):這裡是 JS 算位置,讀不到 CSS 變數。
 */
const EDGE_X_HALF_PX = 14;
const EDGE_X_GAP_PX = 6;

/**
 * 補間中畫面上「看得到」的視角:world 那一層 computed 的 transform(transition 跑到一半的值)。
 * 補間中再按下 / 滾輪,要從這裡接手 —— 直接拿掉 transition 的話,畫面會跳到補間的終點,拖曳也從終點開始算。
 * 讀不出來('none'、不是 2D 矩陣)回 null。jsdom 沒有 DOMMatrixReadOnly,退回自己解 `matrix(a, b, c, d, e, f)`
 */
export function presentedView(transform: string): View | null {
  if (!transform || transform === 'none') return null;
  if (typeof DOMMatrixReadOnly !== 'undefined') {
    try {
      const m = new DOMMatrixReadOnly(transform);
      return {x: m.e, y: m.f, k: m.a};
    } catch {
      // 解不了就往下用字串解
    }
  }
  const m = /^matrix\(([^)]+)\)$/.exec(transform.trim());
  if (!m) return null;
  const [a, , , , e, f] = m[1].split(',').map(Number);
  return [a, e, f].every(Number.isFinite) ? {x: e, y: f, k: a} : null;
}

/**
 * 觸控平移放手後的慣性:觸控板走 wheel 有系統的慣性,手指拖畫布放手就停的話,同一張畫布會有兩種手感。
 * 照 Apple 的 UIScrollView:每 1ms 速度乘 `INERTIA_DECAY`(0.998 = normal 減速),落點 `project()`。
 * **只給觸控 / 觸控筆**:滑鼠拖畫布放手就停是桌面的慣例(Figma、Miro 都是)。減少動態時不滑
 */
const INERTIA_DECAY = 0.998;
/** 每 60Hz 一幀走掉剩餘距離的比例(換成 easeStep 用,120Hz 螢幕一樣快) */
const INERTIA_PER_FRAME = 1 - Math.pow(INERTIA_DECAY, FRAME_MS);
/** 速度看放手前最近幾筆移動、多久以內(ms)。手指停住一下才放(超過這段時間沒動)= 沒有速度 */
const INERTIA_SAMPLES = 5;
const INERTIA_WINDOW_MS = 100;
/** 推出去不到這麼遠(px)就不滑:手指放開時的小抖動不要變成一小段漂移 */
const INERTIA_MIN_PX = 6;
/** 每一幀移動小於這個(px)就停。界線外(滑進回彈帶)用大一點的,早點交給 settle 彈回,不要在帶子裡慢慢爬 */
const INERTIA_STOP_PX = 0.1;
const INERTIA_STOP_OUTSIDE_PX = 1;
/** Apple 的 `project(initialVelocity, decelerationRate)`:速度(px/s)照這個減速會停在多遠(px) */
export const project = (v: number, d: number = INERTIA_DECAY) => ((v / 1000) * d) / (1 - d);
/**
 * 慣性的一幀:`remaining` = 照目前速度還會滑多遠(一開始是 project(放手速度)),這一幀走掉 easeStep 那一份。
 * 回傳的是**位移量**,呼叫端加在「現在的視角」上 —— 不是朝一個放手時算好的絕對落點逼近:
 * 滑的途中視角被別人改了(選到的拼圖平移進畫面、畫布大小改變保持中心點),下一幀不會把畫面拉回去。
 * `over`:這一軸已經滑出界線多少(px,往外為正、在界線內是 0)。越出去阻力越大,到 PAN_RUBBER_DIM 就停 ——
 * 跟拖曳的 rubberband 同一把尺,滑進回彈帶就停下交給 settle
 */
export function glideStep(remaining: Pt, dtMs: number, over: Pt): {step: Pt; remaining: Pt} {
  const s = easeStep(INERTIA_PER_FRAME, dtMs);
  const axis = (r: number, o: number) => {
    const drag = o > 0 ? Math.max(0, 1 - o / PAN_RUBBER_DIM) : 1;
    const step = r * s * drag;
    return {step, remaining: (r - r * s) * drag};
  };
  const x = axis(remaining.x, over.x);
  const y = axis(remaining.y, over.y);
  return {step: {x: x.step, y: y.step}, remaining: {x: x.remaining, y: y.remaining}};
}
export type PointerSample = {x: number; y: number; t: number};
/**
 * 放手時的速度(px/s):最近 INERTIA_WINDOW_MS 內第一筆到最後一筆的平均,不到兩筆 = 0。
 * 算法在 `lib/velocity.ts`(跟燈箱的左右滑共用一份,那邊是 px/ms),這裡只換成 `project` 要的 px/s。
 */
function releaseVelocityPxPerS(samples: PointerSample[], now: number): Pt {
  const v = releaseVelocityPxPerMs(samples, now, INERTIA_WINDOW_MS);
  return {x: v.x * 1000, y: v.y * 1000};
}

/**
 * 接點離它那塊拼圖左上角多遠。拖拼圖時只有位置在變,偏移量不變 ——
 * 所以拖曳的每一格不用重量 DOM,只在拼圖內容 / 大小可能變的時候量,位置用 `n.x + 偏移` 算
 */
export type PortOffset = {node: string; x: number; y: number};
export function portsAt(nodes: FlowNode[], offsets: Record<string, PortOffset>): Record<string, Pt> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Record<string, Pt> = {};
  for (const [key, o] of Object.entries(offsets)) {
    const n = byId.get(o.node);
    if (n) out[key] = {x: n.x + o.x, y: n.y + o.y};
  }
  return out;
}

/** 點點格線一格多寬(縮放 100% 時,px) */
const GRID_PX = 20;
/**
 * 格線那一層往左上偏多少:整層比畫布大一格,平移只動 `translate(x mod g)` ——
 * 走合成層,不用每一格改 host 的 background-position 整片重畫。回傳值在 [-g, 0)
 */
export const gridShift = (v: number, g: number) => (((v % g) + g) % g) - g;

export const FlowCanvas = forwardRef<FlowCanvasHandle, Props>(function FlowCanvas(
  {graph, catalog, selected, onSelect, onGraphChange, onDuplicate, freshId, run, isLocked, initialView, onViewChange, bottomInsetPx = 0},
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const bottomInsetRef = useLatest(bottomInsetPx);
  const [view, setView] = useState<View>(() => initialView ?? {x: 40, y: 40, k: 1});
  const viewRef = useRef(view);
  viewRef.current = view;
  /**
   * 視角定位好了沒。還沒之前整片世界藏著(visibility),不然第一幀會是 100%、左上角的樣子,
   * 下一幀才跳到「全部顯示」—— 看起來就是進流程畫面閃一下
   */
  const [isPlaced, setIsPlaced] = useState(initialView != null);
  const onViewChangeRef = useLatest(onViewChange);
  useEffect(() => {
    onViewChangeRef.current?.(view);
  }, [view]);
  /** 接點離拼圖左上角的偏移(量 DOM 得來,見 measure)。key:`out:<node>:<i>` / `in:<node>` */
  const [portOffsets, setPortOffsets] = useState<Record<string, PortOffset>>({});
  /** 接點位置(世界座標)= 拼圖位置 + 偏移。拖拼圖每一格只重算這個,不量 DOM */
  const ports = useMemo(() => portsAt(graph.nodes, portOffsets), [graph.nodes, portOffsets]);
  // 自動捲動的那一圈 rAF 拿不到最新一次 render 的 ports,透過 ref 讀
  const portsRef = useLatest(ports);
  const [wire, setWire] = useState<{from: string; out: number; a: Pt; b: Pt; target: string | null} | null>(null);
  const [justLinked, setJustLinked] = useState<{edge: string; node: string} | null>(null);
  /** 正在被拖的那一塊(浮起來:影子加深、游標變抓著) */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 這一次視角改變要不要補間(只有縮放鈕與「全部顯示」) */
  const [animView, setAnimView] = useState(false);

  const [panning, setPanning] = useState(false);
  /** 右鍵點了哪一塊(上方浮出「複製」「刪除」) */
  const [barFor, setBarFor] = useState<string | null>(null);
  /** 觸控長按拼圖的計時器:iOS Safari 不送 contextmenu,長按才叫得出複製、刪除 */
  const longPress = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // 每塊拼圖要的「拓撲」資料(客戶問題、哪幾個出口接了線、有沒有進來的線)只跟連線與設定有關,跟位置無關:
  // 拖的時候位置一直變,用不含位置的那一份當 key 才算一次,NodeCard 拿到的值不變、memo 就擋得住重畫。
  // 量接點(measure)也看它:位置以外的東西沒變,拼圖的內容就沒變
  const topoKey = useMemo(
    () => JSON.stringify({n: graph.nodes.map((n) => [n.id, n.type, n.cfg ?? null]), e: graph.edges}),
    [graph],
  );

  // ── 量接點 ────────────────────────────────────────────────────────────────
  // 量的是**偏移**(接點離拼圖左上角多遠),跟拼圖擺在哪無關:
  // 拖曳 / 平移的每一格都量的話,每一格都要 querySelectorAll + 讀 offsetLeft(強制同步排版)。只在拼圖的內容可能變的時候量,兩道:
  //  1. **NodeCard 收到的每一個「位置以外」的 prop** 一變就量(見下面 layout effect 的 deps,跟 NodeCard 的 props 一一對應):
  //     拓撲 / 設定、型錄、執行狀態、鎖定、選取、拖著哪一塊、吸到哪一塊、剛接上、剛加的那一塊。這些都不會在平移 / 拖曳的每一格變,
  //     所以拖曳時一次都不量;而拼圖畫出來的樣子只由這些 props 決定,以後就算加了「選到才出現的一列」也會被量到。
  //  2. 拼圖自己內部的變化(字型載好、欄位自己長高、@ 選單撐開、手機斷點換圓的大小)交給 ResizeObserver:
  //     看每塊拼圖,**也看每個接點一路到拼圖的那幾層**(量的就是它們的 offsetLeft / offsetTop),border-box(框線粗細變了也算)。
  // ⚠️ 不要改成每一格都量:那正是要避開的強制同步排版
  const measure = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const next: Record<string, PortOffset> = {};
    world.querySelectorAll<HTMLElement>('[data-port]').forEach((p) => {
      let x = p.offsetWidth / 2;
      let y = p.offsetHeight / 2;
      let el: HTMLElement | null = p;
      while (el && !el.dataset.node) {
        x += el.offsetLeft;
        y += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
        if (el) {
          x += el.clientLeft;
          y += el.clientTop;
        }
      }
      if (!el) return;
      next[p.dataset.port!] = {node: el.dataset.node!, x, y};
    });
    setPortOffsets((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  useLayoutEffect(measure, [measure, topoKey, catalog, run, isLocked, selected?.kind, selected?.id, draggingId, wire?.target, justLinked?.node, freshId]);
  useEffect(() => {
    // 字型載好之後拼圖的高度會變一點
    void document.fonts?.ready.then(measure);
  }, [measure]);
  useEffect(() => {
    const world = worldRef.current;
    if (!world || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    const watched = new Set<HTMLElement>();
    world.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => watched.add(el));
    world.querySelectorAll<HTMLElement>('[data-port]').forEach((p) => {
      for (let el: HTMLElement | null = p; el && el !== world && !watched.has(el); el = el.offsetParent as HTMLElement | null) {
        watched.add(el);
        if (el.dataset.node) break;
      }
    });
    watched.forEach((el) => ro.observe(el, {box: 'border-box'}));
    return () => ro.disconnect();
    // topoKey / catalog 變 = 有拼圖或出口加進來 / 拿掉,要重新掛
  }, [measure, topoKey, catalog]);

  // ── 視角 ──────────────────────────────────────────────────────────────────
  // 包一層:按鈕觸發的視角變化才補間,時間到就關掉(之後的滾輪、拖曳要即時跟手)
  const animTimer = useRef(0);
  /** 補間還沒關掉(animView 的同步版:stopViewAnim 要在同一個事件裡知道) */
  const isTweening = useRef(false);
  /** 觸控放手後的慣性那一圈 rAF(見 startInertia) */
  const inertiaFrame = useRef(0);
  const stopInertia = useCallback(() => {
    cancelAnimationFrame(inertiaFrame.current);
    inertiaFrame.current = 0;
  }, []);
  const animated = useCallback((change: () => void) => {
    stopInertia();
    window.clearTimeout(animTimer.current);
    isTweening.current = true;
    setAnimView(true);
    change();
    animTimer.current = window.setTimeout(() => {
      isTweening.current = false;
      setAnimView(false);
    }, VIEW_ANIM_OFF_MS);
  }, [stopInertia]);
  useEffect(
    () => () => {
      window.clearTimeout(animTimer.current);
      cancelAnimationFrame(inertiaFrame.current);
    },
    [],
  );
  /**
   * 手一碰(按下、滾輪)就收掉按鈕觸發的補間:不然縮放鈕 / 全部顯示之後 250ms 內的拖曳、滾輪
   * 會被那段補間拖著慢半拍(動畫要隨時讓手接手)。觸控放手的慣性也一起停。
   * ⚠️ 補間跑到一半時,**先把畫面上看得到的值(presentedView)寫回視角再拿掉 transition**:
   * 直接拿掉的話畫面會跳到補間的終點、拖曳也從終點算 —— 最常見的是拉出界、放手、回彈途中再抓一次。
   * 兩個 setState 同一次 render 生效:transition 拿掉的那一幀 transform 已經是畫面上的值,不會再補間一次
   */
  const stopViewAnim = useCallback(() => {
    stopInertia();
    window.clearTimeout(animTimer.current);
    if (isTweening.current) {
      isTweening.current = false;
      const world = worldRef.current;
      const p = world ? presentedView(getComputedStyle(world).transform) : null;
      if (p) {
        viewRef.current = p;
        setView(p);
      }
    }
    setAnimView(false);
  }, [stopInertia]);

  /** 以 (cx, cy)(畫布內座標)為中心縮放。`isSoft` = 滾輪 / 捏合:可以超出上下限一點(回彈),按鈕一律硬夾 */
  const zoomAt = useCallback((k: number, cx: number, cy: number, isSoft = false): View => {
    const v = viewRef.current;
    const nk = isSoft ? k : Math.min(K_MAX, Math.max(K_MIN, k));
    const wx = (cx - v.x) / v.k;
    const wy = (cy - v.y) / v.k;
    const next = {k: nk, x: cx - wx * nk, y: cy - wy * nk};
    viewRef.current = next;
    setView(next);
    return next;
  }, []);

  // ── 回彈的界線 ─────────────────────────────────────────────────────────────
  /** 所有拼圖的外框(世界座標),量 DOM 上的大小。一塊都沒有回 null */
  const graphBox = useCallback(() => {
    const world = worldRef.current;
    if (!world) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    world.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
      const n = graphRef.current.nodes.find((m) => m.id === el.dataset.node);
      if (!n) return;
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + el.offsetWidth);
      y1 = Math.max(y1, n.y + el.offsetHeight);
    });
    return Number.isFinite(x0) ? {x0, y0, x1, y1} : null;
  }, []);
  /** 這個縮放比例下 view.x / view.y 可以在哪個範圍:流程至少還有 PAN_KEEP_PX 留在畫面裡 */
  const panBounds = useCallback(
    (k: number) => {
      const host = hostRef.current;
      const box = graphBox();
      if (!host || !box) return null;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const xMin = PAN_KEEP_PX - box.x1 * k;
      const xMax = w - PAN_KEEP_PX - box.x0 * k;
      const yMin = PAN_KEEP_PX - box.y1 * k;
      const yMax = h - PAN_KEEP_PX - box.y0 * k;
      return {xMin: Math.min(xMin, xMax), xMax: Math.max(xMin, xMax), yMin: Math.min(yMin, yMax), yMax: Math.max(yMin, yMax), w, h};
    },
    [graphBox],
  );
  /** 拉回界線內的視角:縮放先夾回上下限(以 anchor 為中心),平移再夾回 panBounds */
  const clampView = useCallback(
    (v: View, anchor?: Pt): View => {
      let {x, y, k} = v;
      const nk = Math.min(K_MAX, Math.max(K_MIN, k));
      if (nk !== k) {
        const host = hostRef.current;
        const a = anchor ?? {x: (host?.clientWidth ?? 0) / 2, y: (host?.clientHeight ?? 0) / 2};
        x = a.x - ((a.x - x) / k) * nk;
        y = a.y - ((a.y - y) / k) * nk;
        k = nk;
      }
      const b = panBounds(k);
      if (b) {
        x = Math.min(b.xMax, Math.max(b.xMin, x));
        y = Math.min(b.yMax, Math.max(b.yMin, y));
        // 外框留在畫面裡還不夠:斜著拉到角落時,露出來的可能是外框的空角(那裡沒有拼圖),看起來一片空白。
        // 至少要有一塊露出 NODE_KEEP_PX,不夠就把最近的那一塊拉進來
        let best: Pt | null = null;
        worldRef.current?.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
          const n = graphRef.current.nodes.find((m) => m.id === el.dataset.node);
          if (!n) return;
          const need = (start: number, size: number, span: number) => {
            const keep = Math.min(NODE_KEEP_PX, size);
            return start + size < keep ? keep - (start + size) : start > span - keep ? span - keep - start : 0;
          };
          const d = {x: need(x + n.x * k, el.offsetWidth * k, b.w), y: need(y + n.y * k, el.offsetHeight * k, b.h)};
          if (!best || Math.hypot(d.x, d.y) < Math.hypot(best.x, best.y)) best = d;
        });
        if (best) {
          x += (best as Pt).x;
          y += (best as Pt).y;
        }
      }
      return {x, y, k};
    },
    [panBounds],
  );
  /** 手放開之後:超出界線的話補間彈回去(跟縮放鈕同一段補間;減少動態時直接到位) */
  const settle = useCallback(
    (anchor?: Pt) => {
      const v = viewRef.current;
      const c = clampView(v, anchor);
      if (Math.abs(c.x - v.x) < 0.5 && Math.abs(c.y - v.y) < 0.5 && c.k === v.k) return;
      animated(() => setView(c));
    },
    [clampView, animated],
  );

  /**
   * 觸控平移放手:照放手時的速度滑一段再停(常數見 INERTIA_DECAY)。
   * 每一幀走掉剩餘距離的 1 − 0.998^dt(指數衰減 = Apple 的減速,照實際幀間隔算,見 lib/frameEase),
   * **以位移量加在當下的 viewRef 上**(glideStep),不朝放手時算好的絕對落點逼近:滑的途中
   * 選取平移、畫布大小改變(這些 setView 不經過 stopViewAnim)會改視角,朝絕對落點逼近的話下一幀就把畫面拉回去。
   * 界線每一幀重算(畫布大小可能變了);滑出界線越遠阻力越大,停下再交給 settle 彈回。
   * 回傳有沒有滑(沒有的話呼叫端自己 settle)。任何新的按下、滾輪、縮放鈕都會經過 stopViewAnim / animated 停掉它
   */
  const startInertia = useCallback(
    (vel: Pt): boolean => {
      if (prefersReducedMotion()) return false;
      let remaining = {x: project(vel.x), y: project(vel.y)};
      if (Math.hypot(remaining.x, remaining.y) < INERTIA_MIN_PX) return false;
      stopInertia();
      let lastTs: number | undefined;
      const tick = (ts: number) => {
        const dt = frameDelta(lastTs, ts);
        lastTs = ts;
        const v = viewRef.current;
        const b = panBounds(v.k);
        // 往外為正:往右滑(remaining.x > 0)看右邊的界線 xMax,往左看 xMin
        const outward = (pos: number, lo: number, hi: number, dir: number) => (dir > 0 ? Math.max(0, pos - hi) : dir < 0 ? Math.max(0, lo - pos) : 0);
        const over = b ? {x: outward(v.x, b.xMin, b.xMax, remaining.x), y: outward(v.y, b.yMin, b.yMax, remaining.y)} : {x: 0, y: 0};
        const g = glideStep(remaining, dt, over);
        remaining = g.remaining;
        const next = {...v, x: v.x + g.step.x, y: v.y + g.step.y};
        viewRef.current = next;
        setView(next);
        const isOutside = !!b && (next.x < b.xMin || next.x > b.xMax || next.y < b.yMin || next.y > b.yMax);
        if (Math.hypot(g.step.x, g.step.y) < (isOutside ? INERTIA_STOP_OUTSIDE_PX : INERTIA_STOP_PX)) {
          inertiaFrame.current = 0;
          settle();
          return;
        }
        inertiaFrame.current = requestAnimationFrame(tick);
      };
      inertiaFrame.current = requestAnimationFrame(tick);
      return true;
    },
    [panBounds, settle, stopInertia],
  );

  /** 回傳有沒有真的定位(畫布還沒有大小、一塊拼圖都沒有就沒有) */
  const fit = useCallback((minK: number = K_FIT_MIN): boolean => {
    const host = hostRef.current;
    if (!host) return false;
    const r = host.getBoundingClientRect();
    if (r.width === 0) return false;
    const box = graphBox();
    if (!box) return false;
    const {x0, y0, x1, y1} = box;
    const pad = 64;
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    // 能放拼圖的高度:扣掉上方那一條與底部的紀錄區
    const usableH = r.height - bottomInsetRef.current;
    const k = Math.min(1, Math.max(minK, Math.min((r.width - pad * 2) / w, (usableH - pad - TOP_BAR_PX) / h)));
    // 垂直置中在「上方那一條以下」的空間裡
    const y = TOP_BAR_PX + Math.max(0, (usableH - TOP_BAR_PX - pad / 2 - h * k) / 2);
    setView({k, x: Math.max(pad / 2, (r.width - w * k) / 2) - x0 * k, y: y - y0 * k});
    return true;
  }, [graphBox]);

  // ── 讓選到的拼圖看得見 ─────────────────────────────────────────────────────
  //
  // 選到的拼圖(新拖出來的、複製出來的、點到的)有一部分在畫面外就平移進來。
  // **用數學算,不量螢幕位置**:畫布大小改變時的「保持中心點」跟這個平移可能在同一幀發生,
  // 量 DOM 的話會量到還沒套用的舊位置(選到的那塊會被切掉一截)。
  // 兩件事都寫成「給目前的視角,回新的視角」,在同一個 setView 裡接著算。
  const selectedNodeId = selected?.kind === 'node' ? selected.id : null;
  const selectedRef = useRef(selectedNodeId);
  selectedRef.current = selectedNodeId;

  const revealed = useCallback((v: View): View => {
    const host = hostRef.current;
    const id = selectedRef.current;
    const n = id ? graphRef.current.nodes.find((m) => m.id === id) : null;
    const el = id ? worldRef.current?.querySelector<HTMLElement>(`[data-node="${id}"]`) : null;
    if (!host || !n || !el) return v;
    const margin = 24;
    const w = host.clientWidth;
    const h = host.clientHeight;
    const left = v.x + n.x * v.k;
    const top = v.y + n.y * v.k;
    const right = left + el.offsetWidth * v.k;
    const bottom = top + el.offsetHeight * v.k;
    let dx = 0;
    let dy = 0;
    if (right > w - margin) dx = w - margin - right;
    if (left + dx < margin) dx = margin - left;
    if (bottom > h - margin) dy = h - margin - bottom;
    // 上緣要讓出左上角的狀態字與右上角的縮放列那一條
    if (top + dy < TOP_BAR_PX) dy = TOP_BAR_PX - top;
    return dx || dy ? {...v, x: v.x + dx, y: v.y + dy} : v;
  }, []);

  // 選取改變的時候(新拖出來、複製出來的那塊):等它掛上來量得到大小(下一幀)再算
  useEffect(() => {
    if (!selectedNodeId) return;
    const id = requestAnimationFrame(() => setView((v) => revealed(v)));
    return () => cancelAnimationFrame(id);
  }, [selectedNodeId, revealed]);

  // 畫布大小改變(執行紀錄抽屜、視窗縮放、手機轉向):**保持中心點**,不重新縮放;
  // 有選到拼圖的話接著確保它看得見。
  // ⚠️ 不要改成重新「全部顯示」:畫布一窄就把整張圖縮到很小看不清;
  // 什麼都不做的話視窗一變,圖就跑出畫面外。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let last = {w: host.clientWidth, h: host.clientHeight};
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === last.w && h === last.h) return;
      const dw = w - last.w;
      const dh = h - last.h;
      last = {w, h};
      setView((v) => revealed({...v, x: v.x + dw / 2, y: v.y + dh / 2}));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [revealed]);

  const toWorld = useCallback((cx: number, cy: number): Pt => {
    const r = hostRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return {x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k};
  }, []);

  // ── 點點格線 ────────────────────────────────────────────────────────────────
  // 自己一層(比畫布大一格),位置直接寫 DOM:平移只改 transform(合成層),縮放才改格子大小(重畫,只在縮放時)。
  // 按鈕的補間中(縮放鈕、全部顯示、回彈)world 走 CSS transition,格線是 mod 過的位置、不能自己補間(跨格時會倒退跑),
  // 所以每一幀讀 world 畫面上的值(presentedView)跟著畫
  const gridRef = useRef<HTMLDivElement>(null);
  const gridSize = useRef(0);
  const paintGrid = useCallback((v: View) => {
    const el = gridRef.current;
    if (!el) return;
    const g = GRID_PX * v.k;
    if (g !== gridSize.current) {
      gridSize.current = g;
      el.style.backgroundSize = `${g}px ${g}px`;
      el.style.width = `calc(100% + ${g}px)`;
      el.style.height = `calc(100% + ${g}px)`;
    }
    el.style.transform = `translate3d(${gridShift(v.x, g)}px, ${gridShift(v.y, g)}px, 0)`;
  }, []);
  useLayoutEffect(() => {
    if (!animView) {
      paintGrid(view);
      return;
    }
    let raf = 0;
    const follow = () => {
      const world = worldRef.current;
      paintGrid((world && presentedView(getComputedStyle(world).transform)) || viewRef.current);
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(raf);
  }, [view, animView, paintGrid]);

  // 第一次打開就全部顯示 —— **在畫出來之前**(layout effect 裡拼圖已經在 DOM 上、量得到大小)。
  // 等兩幀才 fit 的話,第一幀會先畫 100% 左上角,看起來閃一下。
  // 量不到(畫布還沒有大小)才退回下一幀再試,那之前世界一直藏著
  const isPlacedRef = useLatest(isPlaced);
  useLayoutEffect(() => {
    if (isPlacedRef.current) return;
    if (fit()) {
      setIsPlaced(true);
      return;
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      fit();
      setIsPlaced(true);
    }));
    return () => cancelAnimationFrame(id);
  }, [fit]);

  useImperativeHandle(
    ref,
    () => ({
      fit: () => fit(),
      reveal: (id, opts) => {
        selectedRef.current = id;
        // 等選取那一次 render 掛上外框再算;按鈕觸發的視角變化補間(見 animated)。
        // instant(上一步 / 下一步)直接跳:連按時前一下的補間也一起收掉,不然這一下又被它拖著慢半拍
        requestAnimationFrame(() => {
          if (opts?.instant) {
            stopViewAnim();
            setView((v) => revealed(v));
          } else {
            animated(() => setView((v) => revealed(v)));
          }
        });
      },
      worldAt: (cx, cy) => {
        const host = hostRef.current;
        if (!host) return null;
        const r = host.getBoundingClientRect();
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
        return toWorld(cx, cy);
      },
      center: () => {
        const r = hostRef.current!.getBoundingClientRect();
        return toWorld(r.left + r.width / 2, r.top + r.height / 2);
      },
      scale: () => viewRef.current.k,
    }),
    [fit, toWorld, animated, stopViewAnim, revealed],
  );

  // 滾輪:滑鼠滾輪與觸控板捏合 = 縮放;觸控板雙指 = 平移。要 passive: false 才擋得住整頁捲動。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      // 在通知人員的 @ 選單、下拉選單裡滾:是在捲那份清單,畫布不能跟著縮放
      // (那些浮層的 DOM 掛在拼圖裡,滾輪事件照樣冒泡到畫布)
      if ((e.target as HTMLElement).closest?.('[popover], [role="listbox"], [role="dialog"]')) return;
      e.preventDefault();
      stopViewAnim();
      const r = host.getBoundingClientRect();
      const anchor = {x: e.clientX - r.left, y: e.clientY - r.top};
      // 一串滾輪算一次手勢:記著「沒有回彈的話會到哪」(raw),畫面照 raw 回彈式地跟;停 SETTLE_MS 就彈回界線內。
      // 用 raw 算(不是拿畫面上的值再加):往回推的時候馬上就往回走,不會卡在界線上
      const cur = viewRef.current;
      const g = (wheelGesture.current ??= {x: cur.x, y: cur.y, k: cur.k, timer: 0, anchor});
      window.clearTimeout(g.timer);
      if (e.ctrlKey || e.metaKey || e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50)) {
        g.k *= Math.exp(-e.deltaY * 0.0015);
        g.anchor = anchor;
        const next = zoomAt(softZoom(g.k), anchor.x, anchor.y, true);
        g.x = next.x;
        g.y = next.y;
      } else {
        g.x -= e.deltaX;
        g.y -= e.deltaY;
        const b = panBounds(cur.k);
        const next = b ? {...cur, x: softClamp(g.x, b.xMin, b.xMax, PAN_RUBBER_DIM), y: softClamp(g.y, b.yMin, b.yMax, PAN_RUBBER_DIM)} : {...cur, x: g.x, y: g.y};
        viewRef.current = next;
        setView(next);
      }
      g.timer = window.setTimeout(() => {
        wheelGesture.current = null;
        settle(g.anchor);
      }, SETTLE_MS);
    };
    host.addEventListener('wheel', onWheel, {passive: false});
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomAt, stopViewAnim, panBounds, settle]);
  const wheelGesture = useRef<{x: number; y: number; k: number; timer: number; anchor: Pt} | null>(null);
  useEffect(() => () => window.clearTimeout(wheelGesture.current?.timer), []);

  // ── 指標:平移 / 拖拼圖 / 拉線 / 點選 ─────────────────────────────────────
  const drag = useRef<
    // samples:最近幾筆指標位置(觸控放手算慣性用,見 startInertia)
    // isStopper:這一下是用來停住還在滑的畫布(見 onPointerDown 的 wasGliding)—— 沒拖就放開不算點一下
    | {kind: 'pan'; sx: number; sy: number; ox: number; oy: number; moved: boolean; samples: PointerSample[]; isStopper: boolean}
    // gx / gy:按下去的那一點離拼圖左上角多遠(世界座標)。拼圖照「指標所在的世界座標 − 這段距離」擺 ——
    // 畫布自動捲動時指標沒動、世界座標變了,拼圖照樣留在手指下面
    | {kind: 'node'; id: string; sx: number; sy: number; gx: number; gy: number; moved: boolean; isStopper: boolean}
    | {kind: 'wire'; from: string; out: number; a: Pt; target: string | null}
    | null
  >(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 放手後還在滑的畫布:手一碰(按在哪裡都算,包括拼圖上的欄位)就停在畫面上那一點。
    // 按在欄位 / 浮層上(下面那兩個 return)不會接著拖,停的地方可能在回彈帶裡,要自己彈回
    const wasGliding = inertiaFrame.current !== 0;
    stopInertia();
    if (e.pointerType === 'touch') {
      touchPoints.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (touchPoints.current.size === 2) {
        startPinch(e.pointerId);
        return;
      }
      if (touchPoints.current.size > 2) return;
    }
    const t = e.target as HTMLElement;
    // ⚠️ 下拉選單的選項、@ 選單這類浮層:畫面上浮在最上層,DOM 卻還掛在拼圖裡面(原生 popover),
    // 或是 portal 到畫布外、React 事件照樣冒泡上來。不擋的話按在選項上會被當成「拖拼圖」、
    // 指標被抓到畫布上,選項收不到 click
    if (!hostRef.current?.contains(t) || t.closest('[popover], [role="listbox"], [role="dialog"]')) {
      if (wasGliding) settle();
      return;
    }
    // 按在任何地方(那兩顆鈕自己除外)都收起右鍵浮出的鈕
    if (!t.closest('[data-node-bar]')) setBarFor(null);
    // 拼圖上的輸入框、下拉選單、開關、通知人員那一格(data-field),縮放列、線上的刪除鈕:交給它們自己處理,不是拖曳。
    // 只看**輸入框那一格**(FieldRow 右邊那格整格掛 data-field),不是整片欄位區 —— 按在欄位名稱上照樣可以拖、可以選
    if (t.closest('[data-chrome], [data-field], input, textarea, button, [role="combobox"], [role="switch"]')) {
      if (wasGliding) settle();
      return;
    }
    stopViewAnim();
    // 滾輪手勢還沒收尾(停下不到 SETTLE_MS)就用手拖:那串滾輪算結束 —— 不然下一次滾輪會跳回舊的 raw 位置,
    // 等著回彈的計時器也會在拖到一半時觸發、把畫面拉走
    if (wheelGesture.current) {
      window.clearTimeout(wheelGesture.current.timer);
      wheelGesture.current = null;
    }
    edgePanned.current = false;
    const port = t.closest<HTMLElement>('[data-port^="out:"]');
    const nodeEl = t.closest<HTMLElement>('[data-node]');
    const hit = t.closest<SVGElement>('[data-edge]');
    if (port && !isLocked) {
      const [, from, out] = port.dataset.port!.split(':');
      const a = ports[port.dataset.port!];
      if (!a) return;
      drag.current = {kind: 'wire', from, out: Number(out), a, target: null};
      setWire({from, out: Number(out), a, b: a, target: null});
    } else if (nodeEl) {
      const n = graph.nodes.find((m) => m.id === nodeEl.dataset.node)!;
      const at = toWorld(e.clientX, e.clientY);
      drag.current = {kind: 'node', id: n.id, sx: e.clientX, sy: e.clientY, gx: at.x - n.x, gy: at.y - n.y, moved: false, isStopper: wasGliding};
      if (e.pointerType === 'touch' && !isLocked && n.id !== 'start') {
        window.clearTimeout(longPress.current);
        longPress.current = window.setTimeout(() => {
          // 手指一直沒動才算長按(動了就是在拖,onPointerMove 會清掉這個計時器)
          if (drag.current?.kind === 'node' && !drag.current.moved) {
            onSelect({kind: 'node', id: n.id});
            setBarFor(n.id);
          }
        }, LONG_PRESS_MS);
      }
    } else if (hit && !wasGliding) {
      // 按在線上停住滑動的那一下不選線(下面當成平移,見 isStopper)
      onSelect({kind: 'edge', id: hit.dataset.edge!});
      return;
    } else {
      // 從 viewRef 拿(不是這一次 render 的 view):滾輪剛改過、還沒重畫的那一下,不然拖的起點是舊位置
      const v0 = viewRef.current;
      drag.current = {kind: 'pan', sx: e.clientX, sy: e.clientY, ox: v0.x, oy: v0.y, moved: false, samples: [{x: e.clientX, y: e.clientY, t: e.timeStamp}], isStopper: wasGliding};
    }
    lastPointer.current = {x: e.clientX, y: e.clientY};
    hostRef.current!.setPointerCapture(e.pointerId);
  };

  // ── 拖到邊上自動捲 ─────────────────────────────────────────────────────────
  const lastPointer = useRef<Pt>({x: 0, y: 0});
  const edgePanFrame = useRef(0);
  /** 拼圖擺到指標底下(扣掉抓的那一點) */
  const placeNode = (d: {id: string; gx: number; gy: number}, cx: number, cy: number) => {
    const p = toWorld(cx, cy);
    const g = graphRef.current;
    onGraphChange({...g, nodes: g.nodes.map((n) => (n.id === d.id ? {...n, x: Math.round(p.x - d.gx), y: Math.round(p.y - d.gy)} : n))});
  };
  /** 線的尾巴跟著指標(吸到接點就停在接點上) */
  const placeWire = (d: {from: string; target: string | null}, cx: number, cy: number) => {
    const p = toWorld(cx, cy);
    const target = snapTarget(cx, cy, p, d.from);
    d.target = target;
    setWire((w) => (w ? {...w, b: (target && portsRef.current[`in:${target}`]) || p, target} : w));
  };
  /** 指標離邊多近 → 這一幀畫布捲多少(往指標那一側捲:靠右邊時內容往左走,view.x 變小) */
  const edgeSpeed = (cx: number, cy: number): Pt => {
    const r = hostRef.current?.getBoundingClientRect();
    if (!r) return {x: 0, y: 0};
    const f = (dist: number) => (dist >= EDGE_PAN_PX ? 0 : EDGE_PAN_MAX * (1 - Math.max(0, dist) / EDGE_PAN_PX));
    return {x: f(cx - r.left) - f(r.right - cx), y: f(cy - r.top) - f(r.bottom - cy)};
  };
  /** 這次拖曳有沒有自動捲過。有的話放手時彈回界線內(拉線捲出去、沒接到任何一塊,流程可能已經被捲出畫面) */
  const edgePanned = useRef(false);
  const edgePanTick = () => {
    edgePanFrame.current = 0;
    const d = drag.current;
    // isLocked 每一幀都是最新的(下一幀透過 edgePanTickRef 拿最新一次 render 的這支函式):
    // 按住拼圖停在邊上時流程開始執行、畫布鎖住,拼圖就不能再被移動
    if (!d || isLocked || !(d.kind === 'wire' || (d.kind === 'node' && d.moved))) return;
    const {x: cx, y: cy} = lastPointer.current;
    const sp = edgeSpeed(cx, cy);
    if (!sp.x && !sp.y) return;
    const v = viewRef.current;
    const next = {...v, x: v.x + sp.x, y: v.y + sp.y};
    viewRef.current = next;
    setView(next);
    edgePanned.current = true;
    if (d.kind === 'node') placeNode(d, cx, cy);
    else placeWire(d, cx, cy);
    edgePanFrame.current = requestAnimationFrame(() => edgePanTickRef.current());
  };
  const edgePanTickRef = useLatest(edgePanTick);
  const startEdgePan = () => {
    if (!edgePanFrame.current) edgePanFrame.current = requestAnimationFrame(() => edgePanTickRef.current());
  };

  // ── 觸控:兩指捏合縮放 ───────────────────────────────────────────────────────
  // 滾輪、觸控板有捏合,手指也要有。第二指一放上去,第一指的拖曳取消(拖到一半的拼圖留在原地),
  // 以兩指中點為中心縮放、跟著中點平移;超出上下限一樣回彈(softZoom),放開再彈回界線內
  const touchPoints = useRef(new Map<number, Pt>());
  const pinch = useRef<{d0: number; k0: number; wx: number; wy: number; mid: Pt} | null>(null);
  const pinchNow = () => {
    const [a, b] = [...touchPoints.current.values()];
    const r = hostRef.current!.getBoundingClientRect();
    return {mid: {x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top}, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))};
  };
  // 手指在畫布外放開(例如選單浮層、portal 出去的東西上)時,畫布收不到那一下 pointerup:全頁聽一次,
  // 不然那根手指一直被當成「還按著」,之後每一根單指都會被當成第二指、變成捏合
  useEffect(() => {
    const lift = (e: PointerEvent) => {
      if (e.pointerType === 'touch') touchPoints.current.delete(e.pointerId);
    };
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    return () => {
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', lift);
    };
  }, []);
  const startPinch = (pointerId: number) => {
    window.clearTimeout(longPress.current);
    cancelAnimationFrame(edgePanFrame.current);
    edgePanFrame.current = 0;
    drag.current = null;
    setPanning(false);
    setDraggingId(null);
    setWire(null);
    stopViewAnim();
    const {mid, dist} = pinchNow();
    const v = viewRef.current;
    pinch.current = {d0: dist, k0: v.k, wx: (mid.x - v.x) / v.k, wy: (mid.y - v.y) / v.k, mid};
    hostRef.current?.setPointerCapture(pointerId);
  };
  useEffect(() => () => cancelAnimationFrame(edgePanFrame.current), []);

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && touchPoints.current.has(e.pointerId)) {
      touchPoints.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
      const p = pinch.current;
      if (p && touchPoints.current.size >= 2) {
        const {mid, dist} = pinchNow();
        const k = softZoom((p.k0 * dist) / p.d0);
        const next = {k, x: mid.x - p.wx * k, y: mid.y - p.wy * k};
        p.mid = mid;
        viewRef.current = next;
        setView(next);
        return;
      }
    }
    const d = drag.current;
    if (!d) return;
    lastPointer.current = {x: e.clientX, y: e.clientY};
    const slop = slopOf(e.pointerType);
    if (d.kind === 'node' && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > slop) window.clearTimeout(longPress.current);
    if (d.kind === 'pan') {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) > slop) {
        d.moved = true;
        setPanning(true);
      }
      d.samples.push({x: e.clientX, y: e.clientY, t: e.timeStamp});
      if (d.samples.length > INERTIA_SAMPLES) d.samples.shift();
      // 流程快被推出畫面:越拉越緊(放手由 endDrag 彈回)
      const cur = viewRef.current;
      const b = panBounds(cur.k);
      const next = b
        ? {...cur, x: softClamp(d.ox + dx, b.xMin, b.xMax, PAN_RUBBER_DIM), y: softClamp(d.oy + dy, b.yMin, b.yMax, PAN_RUBBER_DIM)}
        : {...cur, x: d.ox + dx, y: d.oy + dy};
      // viewRef 跟著寫(跟滾輪、自動捲同一個作法):放手時的 settle() 要從這一格算,不是上一格
      viewRef.current = next;
      setView(next);
    } else if (d.kind === 'node') {
      if (isLocked) return;
      // 門檻看螢幕上動了多少,不是畫布座標(縮小時畫布座標會被放大)
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < slop) return;
      if (!d.moved) setDraggingId(d.id);
      d.moved = true;
      placeNode(d, e.clientX, e.clientY);
      startEdgePan();
    } else {
      placeWire(d, e.clientX, e.clientY);
      startEdgePan();
    }
  };

  /** 拉線時吸到哪一塊:游標在拼圖上面,或離它的輸入接點 `SNAP_PX` 以內(螢幕距離)。 */
  const snapTarget = (cx: number, cy: number, p: Pt, from: string): string | null => {
    const over = document.elementFromPoint(cx, cy)?.closest<HTMLElement>('[data-node]')?.dataset.node;
    if (over && over !== 'start' && over !== from) return over;
    const k = viewRef.current.k;
    let best: string | null = null;
    let bestD = SNAP_PX;
    for (const n of graphRef.current.nodes) {
      if (n.id === 'start' || n.id === from) continue;
      const q = portsRef.current[`in:${n.id}`];
      if (!q) continue;
      const dist = Math.hypot(q.x - p.x, q.y - p.y) * k;
      if (dist < bestD) {
        bestD = dist;
        best = n.id;
      }
    }
    return best;
  };

  const endDrag = (e?: React.PointerEvent) => {
    if (e?.pointerType === 'touch') {
      touchPoints.current.delete(e.pointerId);
      const p = pinch.current;
      if (p) {
        // 捏合中放開一指:剩下那一指不接著拖(不然畫面會突然跟著它跑);兩指都不夠了就彈回界線內
        if (touchPoints.current.size < 2) {
          pinch.current = null;
          settle(p.mid);
        }
        return;
      }
    }
    window.clearTimeout(longPress.current);
    cancelAnimationFrame(edgePanFrame.current);
    edgePanFrame.current = 0;
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    setDraggingId(null);
    if (!d) return;
    if (d.kind !== 'pan' && edgePanned.current) settle();
    edgePanned.current = false;
    if (d.kind === 'pan' && d.moved) {
      // 手指 / 觸控筆放開時還在動:滑一段,滑完才 settle;滑鼠、被取消(pointercancel)、停住才放的直接 settle
      let isGliding = false;
      if (e && e.type === 'pointerup' && (e.pointerType === 'touch' || e.pointerType === 'pen')) {
        const samples = [...d.samples, {x: e.clientX, y: e.clientY, t: e.timeStamp}];
        isGliding = startInertia(releaseVelocityPxPerS(samples, e.timeStamp));
      }
      if (!isGliding) settle();
    }
    // 停住滑動的那一下被「吃掉」(iOS 的作法):沒拖就放開,不取消選取、也不選到底下那一塊
    if (d.kind === 'pan' && !d.moved && !d.isStopper) onSelect(null);
    if (d.kind === 'node' && !d.moved && !d.isStopper) onSelect({kind: 'node', id: d.id});
    // 停的地方可能在回彈帶裡,彈回界線內
    if ((d.kind === 'pan' || d.kind === 'node') && !d.moved && d.isStopper) settle();
    if (d.kind === 'wire') {
      setWire(null);
      const to = d.target;
      if (!to) return;
      const edges = connect(graph.edges, d.from, d.out, to);
      if (!edges) return;
      onGraphChange({...graph, edges});
      setJustLinked({edge: edgeKey({from: d.from, out: d.out}), node: to});
    }
  };

  useEffect(() => {
    if (!justLinked) return;
    const t = window.setTimeout(() => setJustLinked(null), JUST_LINKED_MS);
    return () => window.clearTimeout(t);
  }, [justLinked]);

  // ⚠️ setCfg / onNodeContextMenu 要是**固定的函式**(NodeCard 包了 memo):每次 render 都新建的話,拖一塊拼圖
  // 每一格移動所有拼圖全部重畫,拼圖一多拖起來就卡
  const onGraphChangeRef = useLatest(onGraphChange);
  const setCfg = useCallback((id: string, cfg: NodeCfg) => {
    const g = graphRef.current;
    onGraphChangeRef.current({...g, nodes: g.nodes.map((n) => (n.id === id ? {...n, cfg} : n))});
  }, []);
  const removeNode = (id: string) => {
    onGraphChange(withoutNode(graphRef.current, id));
    if (selected?.id === id) onSelect(null);
  };

  // 右鍵拼圖:選它、上方浮出兩顆鈕。執行中(唯讀)不給;起點不能複製也不能刪
  const nodeMenuLatest = useLatest((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    if (isLocked || id === 'start') return;
    onSelect({kind: 'node', id});
    setBarFor(id);
  });
  const onNodeContextMenu = useCallback((id: string, e: React.MouseEvent) => nodeMenuLatest.current(id, e), []);
  // 收起:Esc、那塊不見了(被刪、復原)、鎖起來(開始執行)
  useEffect(() => {
    if (!barFor) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBarFor(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [barFor]);
  // 卸載時收掉還沒到時間的長按
  useEffect(() => () => window.clearTimeout(longPress.current), []);
  const barNode = barFor && !isLocked ? graph.nodes.find((n) => n.id === barFor) : undefined;
  const barEl = barNode ? worldRef.current?.querySelector<HTMLElement>(`[data-node="${barNode.id}"]`) : null;

  // ── 執行時:新走過的線放一顆亮點 ──────────────────────────────────────────
  const [packets, setPackets] = useState<Array<{key: string; d: string; t0: number}>>([]);
  const seenEdges = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!run) {
      seenEdges.current = new Set();
      return;
    }
    const fresh: Array<{key: string; d: string; t0: number}> = [];
    for (const [k, s] of Object.entries(run.edges)) {
      if (s === 'dim' || seenEdges.current.has(k)) continue;
      seenEdges.current.add(k);
      const e = graph.edges.find((x) => edgeKey(x) === k);
      const a = e && ports[`out:${e.from}:${e.out}`];
      const b = e && ports[`in:${e.to}`];
      if (a && b) fresh.push({key: k, d: curve(a, b), t0: performance.now()});
    }
    if (fresh.length) setPackets((p) => [...p, ...fresh]);
  }, [run, graph.edges, ports]);

  const reach = reachable(graph);
  // topoKey 見上面「量接點」那一段
  const topo = useMemo(() => {
    const g = graphRef.current;
    const out = new Map<string, {issue: ClientIssue | null; linkedOuts: number[]; hasIn: boolean}>();
    for (const n of g.nodes) {
      out.set(n.id, {
        issue: n.type === 'start' ? null : clientIssue(g, n, catalog),
        linkedOuts: g.edges.filter((e) => e.from === n.id).map((e) => e.out),
        hasIn: g.edges.some((e) => e.to === n.id),
      });
    }
    return out;
    // topoKey 代表 graph 裡除了位置以外的全部;graph 本身每格移動都會變,不能放進來
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey, catalog]);
  const v = view;
  // 選到的那條線:線的中點上方一點點,一顆紅色 X
  const selEdge = selected?.kind === 'edge' && !isLocked ? graph.edges.find((e) => edgeKey(e) === selected.id) : undefined;
  const selA = selEdge && ports[`out:${selEdge.from}:${selEdge.out}`];
  const selB = selEdge && ports[`in:${selEdge.to}`];
  const selMid = selA && selB ? curveMid(selA, selB) : null;
  /*
   * 那顆 X 的**中心**放在哪(畫面座標)。從中點沿著法線推開,推多遠照方向算:正方形按鈕在方向 n 上的半寬是
   * EDGE_X_HALF_PX × (|nx| + |ny|),再加一格間距 —— 四個角都離線 spacing-1-5,水平線時就是「正上方 6px」,
   * 陡的線會往旁邊推(正中心壓在中點上的話容易誤刪)。推出去會跑出畫布上緣就改推另一側。
   */
  const selX = (() => {
    if (!selA || !selB || !selMid) return null;
    const n = curveMidNormal(selA, selB);
    const s = overlayScale(v.k);
    const reach = EDGE_X_HALF_PX * s * (Math.abs(n.x) + Math.abs(n.y)) + EDGE_X_GAP_PX;
    const mx = v.x + selMid.x * v.k;
    const my = v.y + selMid.y * v.k;
    const up = {left: mx + n.x * reach, top: my + n.y * reach};
    if (up.top - EDGE_X_HALF_PX * s >= 0) return up;
    return {left: mx - n.x * reach, top: my - n.y * reach};
  })();
  const nameOf = (id: string) => {
    const n = graph.nodes.find((m) => m.id === id);
    if (!n) return '';
    return n.type === 'start' ? (catalog?.base.label ?? '主機') : (catalog?.nodes[n.type]?.label ?? n.type);
  };

  return (
    <div
      ref={hostRef}
      {...stylex.props(styles.host, panning && styles.panning, wire && styles.wiring)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      aria-label="流程畫布"
      role="application"
    >
      {/* 點點格線:位置與格子大小由 paintGrid 直接寫(見上面),不經過 React 的 style */}
      <Stack ref={gridRef} xstyle={styles.grid} aria-hidden />
      <div ref={worldRef} {...stylex.props(styles.world, animView && styles.worldAnim, !isPlaced && styles.worldHidden)} style={{transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})`}}>
        <svg {...stylex.props(styles.edges)} aria-hidden="true">
          {graph.edges.map((e) => {
            const a = ports[`out:${e.from}:${e.out}`];
            const b = ports[`in:${e.to}`];
            if (!a || !b) return null;
            const k = edgeKey(e);
            const d = curve(a, b);
            const rs = run?.edges[k];
            const isSel = selected?.kind === 'edge' && selected.id === k;
            return (
              <g key={k}>
                <path d={d} data-edge={k} {...stylex.props(styles.edgeHit)} />
                <path
                  d={d}
                  {...stylex.props(
                    styles.edge,
                    isSel && styles.edgeSel,
                    justLinked?.edge === k && styles.edgeJust,
                    rs === 'done' && styles.edgeDone,
                    rs === 'fail' && styles.edgeFail,
                    (rs === 'dim' || (run && !rs)) && styles.edgeDim,
                    // 從已經有線的出口再拉一條:舊的那條放開就會被換掉,拉的時候先變淡(不然放開時它悄悄消失)
                    wire?.from === e.from && wire.out === e.out && styles.edgeDim,
                  )}
                />
              </g>
            );
          })}
          {wire ? <path d={curve(wire.a, wire.b)} {...stylex.props(styles.edge, styles.edgeTemp, wire.target != null && styles.edgeSnapped)} /> : null}
          {packets.map((p) => (
            <Packet key={p.key + p.t0} d={p.d} onDone={() => setPackets((ps) => ps.filter((x) => x !== p))} />
          ))}
        </svg>
        {graph.nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            issue={topo.get(n.id)?.issue ?? null}
            catalog={catalog}
            isSelected={selected?.kind === 'node' && selected.id === n.id}
            isOrphan={!run && n.id !== 'start' && !reach.has(n.id)}
            isSnapTarget={wire?.target === n.id}
            isJustLinked={justLinked?.node === n.id}
            // 只有剛加的那一塊播進場。⚠️ 不要改成「打開之後才出現的都算新」:那個標記會一直掛著,
            // 之後接上線(nodeJust)或跑完(nodeRunning)動畫名稱一換回來,進場就重播一次
            isNew={freshId === n.id}
            isDragging={draggingId === n.id}
            linkedOuts={topo.get(n.id)?.linkedOuts ?? NO_OUTS}
            hasIn={topo.get(n.id)?.hasIn ?? false}
            state={run ? (run.nodes[n.id] ?? 'skip') : null}
            progress={run?.progress[n.id] ?? null}
            subOverride={run?.sub[n.id]}
            isLocked={isLocked}
            onCfg={setCfg}
            onContextMenu={onNodeContextMenu}
          />
        ))}
      </div>

      {/* 右鍵拼圖:正上方兩顆鈕。放在世界外面(不跟著縮放 —— 按鈕永遠是原尺寸),位置照視角算 */}
      {barNode && barEl ? (
        <HStack
          gap={0.5}
          data-chrome
          data-node-bar
          role="toolbar"
          aria-label={nameOf(barNode.id)}
          xstyle={[styles.nodeBar, v.y + barNode.y * v.k < NODE_BAR_ROOM_PX && styles.nodeBarBelow]}
          style={{
            left: v.x + (barNode.x + barEl.offsetWidth / 2) * v.k,
            top: v.y + barNode.y * v.k < NODE_BAR_ROOM_PX ? v.y + (barNode.y + barEl.offsetHeight) * v.k : v.y + barNode.y * v.k,
            scale: String(overlayScale(v.k)),
          }}
        >
          {/* 只有圖示、小一號;名字只給報讀(label),不放 tooltip。
              拼圖盒裡沒有的種類不給複製,見 PALETTE_TYPES */}
          {PALETTE_TYPES.has(barNode.type) ? (
            <IconButton
              label="複製"
              icon={<Icon icon={Copy} size="xsm" />}
              variant="ghost"
              size="sm"
              onClick={() => {
                setBarFor(null);
                onDuplicate(barNode.id);
              }}
            />
          ) : null}
          <IconButton
            label="刪除"
            icon={<Icon icon={Trash2} size="xsm" />}
            variant="destructive"
            size="sm"
            onClick={() => {
              setBarFor(null);
              removeNode(barNode.id);
            }}
          />
        </HStack>
      ) : null}

      {selEdge && selX ? (
        <HStack
          data-chrome
          data-edge-bar
          xstyle={styles.edgeX}
          style={{left: selX.left, top: selX.top, scale: String(overlayScale(v.k))}}
        >
          <IconButton
            label="刪除這條線"
            icon={<Icon icon={X} size="xsm" />}
            variant="destructive"
            size="sm"
            onClick={() => {
              onGraphChange(withoutEdge(graph, edgeKey(selEdge)));
              onSelect(null);
            }}
          />
        </HStack>
      ) : null}

      <HStack gap={0.5} vAlign="center" xstyle={styles.zoom} data-chrome>
        <IconButton label="縮小" icon={<Icon icon={Minus} size="sm" />} variant="ghost" size="sm" onClick={() => animated(() => zoomAt(v.k / 1.2, center(hostRef).x, center(hostRef).y))} />
        <Button label={`${Math.round(v.k * 100)}%`} variant="ghost" size="sm" onClick={() => animated(() => zoomAt(1, center(hostRef).x, center(hostRef).y))} />
        <IconButton label="全部顯示" icon={<Icon icon={Maximize2} size="sm" />} variant="ghost" size="sm" onClick={() => animated(() => fit(K_MIN))} />
        <IconButton label="放大" icon={<Icon icon={Plus} size="sm" />} variant="ghost" size="sm" onClick={() => animated(() => zoomAt(v.k * 1.2, center(hostRef).x, center(hostRef).y))} />
      </HStack>
    </div>
  );
});

/**
 * 右鍵那兩顆、選線的 X 跟著畫布縮放比例一起縮:
 * 縮到 25% 時還是原尺寸的話,比整張圖還搶眼。不直接放進會縮放的 world:縮到 25% 會小到點不到,
 * 所以夾在 OVERLAY_MIN_SCALE 以上;放大時不跟著變大(原尺寸就夠點)。
 */
const OVERLAY_MIN_SCALE = 0.5;
function overlayScale(k: number): number {
  return Math.min(1, Math.max(OVERLAY_MIN_SCALE, k));
}

function center(ref: React.RefObject<HTMLDivElement | null>): Pt {
  const r = ref.current?.getBoundingClientRect();
  return {x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2};
}

/** 沿著一條線跑一次的亮點。**以時間為準**:分頁在背景時 rAF 不走,也要準時結束。 */
function Packet({d, onDone}: {d: string; onDone: () => void}) {
  const pathRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGGElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const path = pathRef.current;
    const dot = dotRef.current;
    if (!path || !dot) return;
    const reduce = prefersReducedMotion();
    const len = path.getTotalLength();
    const dur = reduce ? 0 : Math.min(900, 380 + len * 1.2);
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = dur ? Math.min(1, (t - t0) / dur) : 1;
      const ez = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const pt = path.getPointAtLength(len * ez);
      dot.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const timer = window.setTimeout(() => doneRef.current(), dur + 120);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <g>
      <path ref={pathRef} d={d} fill="none" stroke="none" />
      <g ref={dotRef} transform="translate(-99999 -99999)">
        <circle r={11} {...stylex.props(styles.pktGlow)} />
        <circle r={5} {...stylex.props(styles.pkt)} />
      </g>
    </g>
  );
}

type NodeCardProps = {
  node: FlowNode;
  /** 這一塊的客戶問題(FlowCanvas 依拓撲算好的,見 topo)*/
  issue: ClientIssue | null;
  catalog: Catalog | null;
  isSelected: boolean;
  isOrphan: boolean;
  /** 拉線時線吸在這一塊上 */
  isSnapTarget: boolean;
  /** 剛接上,閃一下 */
  isJustLinked: boolean;
  /** 剛加進來的那一塊(播一次進場,見 FlowCanvas 的 freshId) */
  isNew: boolean;
  /** 正在被拖 */
  isDragging: boolean;
  linkedOuts: number[];
  hasIn: boolean;
  state: 'running' | 'ok' | 'fail' | 'skip' | null;
  progress: number | null;
  subOverride?: string;
  isLocked: boolean;
  /** 固定的函式(見 FlowCanvas 的 setCfg),第一個參數是哪一塊 */
  onCfg: (id: string, cfg: NodeCfg) => void;
  /** 右鍵:上方浮出複製、刪除。固定的函式,第一個參數是哪一塊 */
  onContextMenu: (id: string, e: React.MouseEvent) => void;
};

const NO_OUTS: number[] = [];

/** memo:拖一塊拼圖的時候,其他沒動的不重畫(props 都是值或固定的函式,見 FlowCanvas 的 topo / setCfg) */
const NodeCard = memo(function NodeCard({
  node,
  issue,
  catalog,
  isSelected,
  isOrphan,
  isSnapTarget,
  isJustLinked,
  isNew,
  isDragging,
  linkedOuts,
  hasIn,
  state,
  progress,
  subOverride,
  isLocked,
  onCfg,
  onContextMenu,
}: NodeCardProps) {
  const IconC = NODE_ICONS[node.type];
  const spec = catalog?.nodes[node.type];
  const label = spec?.label ?? node.type;
  // 位置用 `translate`(不是 left / top):拖拼圖每一格只動合成層,不重排版。
  // ⚠️ 用獨立的 translate 屬性、不是 transform:進場(land)與接上線(pulse)的 keyframes 動的是 transform,會蓋掉它。
  // 瀏覽器底線:獨立的 translate 屬性要 Chromium 104+ / Safari 14.1+ / Firefox 72+,不做退路
  const pos = {translate: `${node.x}px ${node.y}px`};

  if (node.type === 'start') {
    return (
      <div data-node="start" {...stylex.props(styles.startNode)} style={pos}>
        <div
          {...stylex.props(
            styles.disc,
            isSelected && styles.discSel,
            state === 'running' && styles.discRunning,
            state === 'ok' && styles.discOk,
            state === 'fail' && styles.discFail,
          )}
        >
          <Icon icon={IconC} size="lg" strokeWidth={1.75} xstyle={styles.discIcon} />
          <span data-port="out:start:0" {...stylex.props(styles.port, styles.portStart, linkedOuts.length > 0 && styles.portLinked)} />
        </div>
        <span {...stylex.props(styles.capName)}>{catalog?.base.label ?? '主機'}</span>
        {/* 名字底下不寫任何東西 */}
      </div>
    );
  }

  const cfg = node.cfg ?? {};
  const inlineKeys = INLINE_FIELDS[node.type];
  const inline = spec?.fields.filter((f) => inlineKeys.includes(f.key)) ?? [];
  const unset = isUnset(node, catalog);
  const badScript = scriptProblem(node, catalog);
  // 同步跑的時候還不知道總數(progress 是 null,rsync 還在列清單)就畫不定長度的進度條,不畫一條會亂跳的百分比。
  const isIndeterminate = node.type === 'sync' && progress == null && state === 'running';
  // 清單收齊前就失敗:沒有百分比,整條紅 —— 不然條子直接消失,看不出是失敗
  const isFailedEarly = node.type === 'sync' && progress == null && state === 'fail';
  const showProgress =
    isIndeterminate || isFailedEarly || (node.type === 'sync' && progress != null && state != null && state !== 'skip');
  const set = (key: string, value: NodeCfg[string]) => onCfg(node.id, {...cfg, [key]: value});

  return (
    <div
      data-node={node.id}
      onContextMenu={(e: React.MouseEvent) => onContextMenu(node.id, e)}
      {...stylex.props(
        styles.node,
        // 拖著的時候浮起來;選著的拖,外框留著(sel 排在後面蓋過影子)
        isDragging && styles.nodeDragging,
        isSelected && styles.nodeSel,
        (isOrphan || (!state && (unset != null || issue != null || badScript != null))) && styles.nodeWarn,
        isNew && styles.nodeNew,
        isSnapTarget && styles.nodeSnap,
        isJustLinked && styles.nodeJust,
        state === 'running' && styles.nodeRunning,
        state === 'ok' && styles.nodeOk,
        state === 'fail' && styles.nodeFail,
        state === 'skip' && styles.nodeSkip,
      )}
      style={pos}
    >
      <span data-port={`in:${node.id}`} {...stylex.props(styles.port, styles.portIn, hasIn && styles.portLinked, isSnapTarget && styles.portSnap)} />
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.headIcon)}>
          <Icon icon={IconC} size="sm" />
        </span>
        <span {...stylex.props(styles.title)}>{label}</span>
        {/* 執行時才佔位 */}
        {state && state !== 'skip' ? (
          <span {...stylex.props(styles.stateIcon, state === 'ok' && styles.textOk, state === 'fail' && styles.textFail)}>
            {/* 執行中用 Astryx 的 Spinner(減少動態時元件自己處理)。
                ⚠️ 用 sm 不用 md:Spinner 的外框是「直徑 + 兩側線寬」,sm = 10 + 2×2 = 14px、線粗 2,
                放得進 18px 的 stateIcon 格子而且置中;md 是 14 + 2×3 = 20px,
                會比旁邊 15px 的 ✓/✗ 大一號,還溢出格子往右下偏。 */}
            {state === 'running' ? <Spinner size="sm" /> : state === 'ok' ? <Icon icon={Check} size="sm" /> : <Icon icon={X} size="sm" />}
          </span>
        ) : null}
      </div>
      {issue || inline.length || subOverride ? (
        <VStack gap={1.5} xstyle={styles.body}>
          {/* 客戶沿用前面的「連線客戶」,平常不再寫一次;
              只有接不到客戶、或設定檔少指令的時候才冒出黃色警告 */}
          {issue ? (
            <FieldRow label="客戶">
              <Token size="sm" color="yellow" label={issue.message} icon={<Icon icon={TriangleAlert} size="xsm" />} />
            </FieldRow>
          ) : null}
          {inline.map((f) =>
            // 「通知人員」的名單整列寬、不放欄位名(標題已經是「通知人員」,左邊再寫「通知」是同一件事講兩次)
            f.kind === 'people' ? (
              <FieldInput key={f.key} field={f} value={cfg[f.key]} isCompact isDisabled={isLocked} onChange={(v) => set(f.key, v)} />
            ) : (
              <FieldRow key={f.key} label={f.label}>
                <FieldInput
                  field={f}
                  value={cfg[f.key]}
                  isCompact
                  isDisabled={isLocked}
                  onChange={(v) => set(f.key, v)}
                />
              </FieldRow>
            ),
          )}
          {badScript ? <Token size="sm" color="yellow" label={badScript} icon={<Icon icon={TriangleAlert} size="xsm" />} /> : null}
          {subOverride ? <span {...stylex.props(styles.sub)}>{subOverride}</span> : null}
        </VStack>
      ) : null}
      <div {...stylex.props(styles.outs)}>
        {(spec?.outs ?? []).map((o, i) => (
          <div key={o} {...stylex.props(styles.out)}>
            {o}
            <span data-port={`out:${node.id}:${i}`} {...stylex.props(styles.port, styles.portOut, linkedOuts.includes(i) && styles.portLinked)} />
          </div>
        ))}
      </div>
      {showProgress ? (
        // 設計系統的 ProgressBar(不定長度、減少動態它都處理好了)
        <Stack xstyle={styles.prog}>
          <ProgressBar
            label={`${label}進度`}
            isLabelHidden
            isIndeterminate={isIndeterminate}
            value={isFailedEarly ? 100 : Math.round((progress ?? 0) * 100)}
            variant={state === 'ok' ? 'success' : state === 'fail' ? 'error' : 'accent'}
          />
        </Stack>
      ) : null}
    </div>
  );
});

/**
 * 執行中那一塊的呼吸光暈。keyframes 直接動 box-shadow 的話無限循環、每一幀重畫,
 * 所以兩圈都畫在偽元素上:內圈(3px)在 ::before、靜態;外圈(8px)在 ::after、只動 opacity(合成層)。
 * ⚠️ **拼圖本身的 box-shadow 不碰**:選取的外圈、拖曳的影子照樣在(靜態內圈寫在拼圖的 boxShadow 上的話,
 * 減少動態時會蓋掉選取外圈)。減少動態時兩個偽元素都不畫,只剩黑框
 */
const RUNNING_RING = {
  content: '""',
  position: 'absolute',
  borderRadius: 'inherit',
  pointerEvents: 'none',
  display: {default: 'block', '@media (prefers-reduced-motion: reduce)': 'none'},
} as const;
const beat = stylex.keyframes({'0%, 100%': {opacity: 0}, '50%': {opacity: 1}});
// 新拼圖進場:從 95% 淡入(不從 0 開始,也不衝過頭 —— 工具介面不要彈)。減少動態時只淡入
const land = stylex.keyframes({from: {transform: 'scale(.95)', opacity: 0}});
const fadeIn = stylex.keyframes({from: {opacity: 0}});
const pulse = stylex.keyframes({'40%': {transform: 'scale(1.03)'}});
const thick = stylex.keyframes({from: {strokeWidth: 5}});
// 右鍵浮鈕、選線的 X:淡入(浮層的進場)
// ⚠️ 只動 opacity:縮放比例是 inline 的 `scale`(overlayScale),keyframes 再動 scale 會在進場那一下蓋掉它
const barIn = stylex.keyframes({from: {opacity: 0}});
/**
 * 這張畫布的動畫一律用專案的 `--ease-panel`(global.css:起步快、尾巴長長收住)配佈景的時間 token。
 * ⚠️ hover 條件寫死在各條樣式裡(StyleX 的條件鍵要是字面值),跟 `lib/media.ts` 的 `HOVER_QUERY` 是同一條線:
 * `(hover: hover) and (pointer: fine)`,改一邊要改另一邊。
 */

const styles = stylex.create({
  host: {
    position: 'relative',
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: 'var(--color-background-body)',
    touchAction: 'none',
    userSelect: 'none',
    outline: 'none',
  },
  /**
   * 點點格線自己一層:比畫布大一格(寬高由 paintGrid 寫),平移只動 transform。
   * 縮放鈕 / 全部顯示的補間中格線跟著 world 畫面上的值走(paintGrid 每一幀讀),不用自己的 transition
   */
  grid: {
    position: 'absolute',
    left: 0,
    top: 0,
    pointerEvents: 'none',
    backgroundImage: 'radial-gradient(circle, var(--color-overlay-pressed) 1px, transparent 1.2px)',
    willChange: 'transform',
  },
  panning: {cursor: 'grabbing'},
  worldAnim: {
    transitionProperty: {default: 'transform', '@media (prefers-reduced-motion: reduce)': 'none'},
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-panel)',
  },
  wiring: {cursor: 'crosshair'},
  world: {position: 'absolute', left: 0, top: 0, transformOrigin: '0 0'},
  // 視角還沒定位(見 isPlaced):佔位、量得到大小,但不畫
  worldHidden: {visibility: 'hidden'},
  edges: {position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none'},
  edgeHit: {fill: 'none', stroke: 'transparent', strokeWidth: 14, pointerEvents: 'stroke', cursor: 'pointer'},
  edge: {
    fill: 'none',
    stroke: 'var(--color-text-secondary)',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    pointerEvents: 'none',
    transitionProperty: 'stroke, opacity, stroke-width',
    transitionDuration: 'var(--duration-medium)',
    transitionTimingFunction: 'var(--ease-panel)',
  },
  edgeSel: {stroke: 'var(--color-text-primary)', strokeWidth: 2.5},
  edgeTemp: {stroke: 'var(--color-text-primary)', strokeDasharray: '5 5'},
  // 吸住了:虛線變實線
  edgeSnapped: {strokeDasharray: 'none', strokeWidth: 2.5},
  // 減少動態時不播「剛接上變粗再收回」,線直接是終態
  edgeJust: {stroke: 'var(--color-text-primary)', animationName: {default: thick, '@media (prefers-reduced-motion: reduce)': 'none'}, animationDuration: 'var(--duration-medium)', animationTimingFunction: 'var(--ease-panel)'},
  edgeDone: {stroke: 'var(--color-success)', strokeWidth: 2.25},
  edgeFail: {stroke: 'var(--color-error)', strokeWidth: 2.25},
  edgeDim: {opacity: 0.25},
  pkt: {fill: 'var(--color-text-primary)'},
  pktGlow: {fill: 'var(--color-text-primary)', opacity: 0.16},

  node: {
    position: 'absolute',
    left: 0,
    top: 0,
    // 每塊拼圖自己一層:疊在一起的時候,底下那塊的接點(z-index 2)不能穿到上面那塊裡
    isolation: 'isolate',
    width: NODE_WIDTH,
    borderRadius: 'var(--radius-container)',
    backgroundColor: 'var(--color-background-surface)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border-emphasized)',
    // 影子只在真正的滑鼠上跟著 hover 變(觸控點一下會黏住)
    boxShadow: {default: 'var(--shadow-low)', ':hover': {default: 'var(--shadow-low)', '@media (hover: hover) and (pointer: fine)': 'var(--shadow-med)'}},
    transitionProperty: 'box-shadow, border-color, opacity',
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-panel)',
    cursor: 'grab',
    color: 'var(--color-text-primary)',
  },
  nodeSel: {zIndex: 3, borderColor: 'var(--color-text-primary)', boxShadow: '0 0 0 3px var(--color-overlay-pressed), var(--shadow-med)'},
  nodeWarn: {borderStyle: 'dashed', borderColor: 'var(--color-warning)'},
  nodeSnap: {zIndex: 3, outlineWidth: 2, outlineStyle: 'solid', outlineColor: 'var(--color-text-primary)', outlineOffset: 3, boxShadow: 'var(--shadow-med)'},
  nodeNew: {
    animationName: {default: land, '@media (prefers-reduced-motion: reduce)': fadeIn},
    animationDuration: 'var(--duration-fast)',
    animationTimingFunction: 'var(--ease-panel)',
  },
  nodeJust: {
    animationName: {default: pulse, '@media (prefers-reduced-motion: reduce)': 'none'},
    animationDuration: 'var(--duration-fast)',
    animationTimingFunction: 'var(--ease-panel)',
  },
  // 拿起來:影子加深、游標變抓著、疊在最上面
  nodeDragging: {zIndex: 4, boxShadow: 'var(--shadow-high)', cursor: 'grabbing'},
  nodeRunning: {
    borderColor: 'var(--color-text-primary)',
    // 減少動態:不閃、也不畫光暈,黑框本身就看得出是這一步在跑。
    // 兩圈貼著外框(往外推一個框線寬,跟 box-shadow 的起點一樣),見 beat / RUNNING_RING
    '::before': {...RUNNING_RING, inset: 'calc(var(--border-width) * -1)', boxShadow: '0 0 0 3px var(--color-overlay-pressed)'},
    '::after': {
      ...RUNNING_RING,
      inset: 'calc(var(--border-width) * -1)',
      boxShadow: '0 0 0 8px var(--color-overlay-hover)',
      opacity: 0,
      animationName: {default: beat, '@media (prefers-reduced-motion: reduce)': 'none'},
      animationDuration: '1.4s',
      animationIterationCount: 'infinite',
      animationTimingFunction: 'ease-in-out',
    },
  },
  nodeOk: {borderColor: 'var(--color-success)'},
  nodeFail: {borderColor: 'var(--color-error)', boxShadow: '0 0 0 3px var(--color-error-muted)'},
  nodeSkip: {opacity: 0.4},
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-2)',
    height: 38,
    paddingInline: 'var(--spacing-2) var(--spacing-1-5)',
  },
  // 圖示放進淡色方塊
  headIcon: {
    width: 24,
    height: 24,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 'var(--radius-inner)',
    backgroundColor: 'var(--color-neutral)',
  },
  title: {flex: '1 1 0', minWidth: 0, fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'},
  stateIcon: {width: 18, height: 18, display: 'grid', placeItems: 'center'},
  textOk: {color: 'var(--color-success)'},
  textFail: {color: 'var(--color-error)'},
  // 欄位區的游標是一般箭頭(整塊拼圖是 grab)
  body: {paddingBlock: 'var(--spacing-2) 0', paddingInline: 'var(--spacing-3)', cursor: 'default'},
  sub: {
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    fontFamily: 'var(--font-family-code)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  // 出口區跟設定區用一條線隔開
  outs: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--spacing-0-5)',
    marginTop: 'var(--spacing-2)',
    paddingBlock: 'var(--spacing-1-5)',
    paddingInline: 'var(--spacing-3)',
    borderTopWidth: 'var(--border-width)',
    borderTopStyle: 'solid',
    borderTopColor: 'var(--color-border)',
  },
  out: {
    position: 'relative',
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    height: 20,
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    paddingRight: 6,
  },
  port: {
    position: 'absolute',
    // 看起來 12px,能點的範圍 28px(::before 往外擴 8px):拉線要先點中接點,12px 太難點準。
    // 吸附判斷用 elementFromPoint,偽元素一樣算在接點上
    '::before': {content: '""', position: 'absolute', inset: -8, borderRadius: '50%'},
    width: 12,
    height: 12,
    boxSizing: 'border-box',
    borderRadius: '50%',
    backgroundColor: 'var(--color-background-surface)',
    borderWidth: 2,
    borderStyle: 'solid',
    borderColor: 'var(--color-text-secondary)',
    zIndex: 2,
    // 吸住時的放大(portSnap)在減少動態時直接跳到終態,不補間
    transitionProperty: {default: 'transform', '@media (prefers-reduced-motion: reduce)': 'none'},
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-panel)',
  },
  // 接點 hover 放大只在真正的滑鼠上(觸控點一下會黏住)
  portOut: {right: -19, top: 4, cursor: 'crosshair', transform: {default: 'none', ':hover': {default: 'none', '@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)': 'scale(1.35)'}}},
  portIn: {left: -7, top: 13},
  // 起點那顆圓的出口接點:垂直置中在圓的右緣(圓 60 → top 24;手機的圓 48 → top 18)
  portStart: {right: -6, top: {default: 24, '@media (max-width: 768px)': 18}, cursor: 'crosshair', transform: {default: 'none', ':hover': {default: 'none', '@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)': 'scale(1.35)'}}},
  portLinked: {backgroundColor: 'var(--color-text-primary)', borderColor: 'var(--color-text-primary)'},
  portSnap: {transform: 'scale(1.6)', backgroundColor: 'var(--color-text-primary)', borderColor: 'var(--color-text-primary)'},
  prog: {marginInline: 'var(--spacing-3)', marginBottom: 'var(--spacing-2)'},

  discIcon: {width: {default: 24, '@media (max-width: 768px)': 20}, height: {default: 24, '@media (max-width: 768px)': 20}},
  startNode: {
    position: 'absolute',
    left: 0,
    top: 0,
    isolation: 'isolate',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    cursor: 'grab',
    color: 'var(--color-text-primary)',
  },
  /**
   * 起點「主機」那顆圓。手機小一號(圓 60 → 48、圖示 24 → 20):寬螢幕的尺寸直接放到手機上又大又擠。
   * ⚠️ 媒體查詢跟 `lib/media.ts` 的 `MOBILE_QUERY` 同一條線;出口接點的 top 跟著改(portStart)
   */
  disc: {
    position: 'relative',
    width: {default: 60, '@media (max-width: 768px)': 48},
    height: {default: 60, '@media (max-width: 768px)': 48},
    borderRadius: '50%',
    backgroundColor: 'var(--color-accent)',
    color: 'var(--color-on-accent)',
    display: 'grid',
    placeItems: 'center',
    boxShadow: 'var(--shadow-med)',
    transitionProperty: 'box-shadow',
    transitionDuration: 'var(--duration-medium)',
    transitionTimingFunction: 'var(--ease-panel)',
    marginBottom: 4,
  },
  discSel: {boxShadow: '0 0 0 4px var(--color-overlay-pressed), var(--shadow-med)'},
  // 跟 nodeRunning 同一套(靜態內圈 + 偽元素外圈只動 opacity、同一條曲線)
  discRunning: {
    '::before': {...RUNNING_RING, inset: 0, boxShadow: '0 0 0 3px var(--color-overlay-pressed)'},
    '::after': {
      ...RUNNING_RING,
      inset: 0,
      boxShadow: '0 0 0 8px var(--color-overlay-hover)',
      opacity: 0,
      animationName: {default: beat, '@media (prefers-reduced-motion: reduce)': 'none'},
      animationDuration: '1.4s',
      animationIterationCount: 'infinite',
      animationTimingFunction: 'ease-in-out',
    },
  },
  discOk: {boxShadow: '0 0 0 4px var(--color-success-muted), var(--shadow-med)'},
  discFail: {boxShadow: '0 0 0 4px var(--color-error-muted), var(--shadow-med)'},
  capName: {fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap'},

  zoom: {
    position: 'absolute',
    top: 'var(--spacing-3)',
    right: 'var(--spacing-3)',
    padding: 'var(--spacing-0-5)',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-background-surface)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    boxShadow: 'var(--shadow-low)',
    fontVariantNumeric: 'tabular-nums',
    zIndex: 10,
  },
  // 右鍵拼圖的兩顆鈕:貼著拼圖上緣置中(上面放不下就貼下緣,nodeBarBelow)
  nodeBar: {
    position: 'absolute',
    zIndex: 12,
    translate: '-50% calc(-100% - var(--spacing-1-5))',
    transformOrigin: 'bottom center',
    padding: 'var(--spacing-0-5)',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-background-popover)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    boxShadow: 'var(--shadow-med)',
    animationName: {default: barIn, '@media (prefers-reduced-motion: reduce)': fadeIn},
    animationDuration: 'var(--duration-fast)',
    animationTimingFunction: 'var(--ease-panel)',
  },
  nodeBarBelow: {translate: '-50% var(--spacing-1-5)', transformOrigin: 'top center'},
  // 選到的線:中點上方一顆紅 X,**跟右鍵那兩顆一樣大**(IconButton sm + xsm 圖示),跟著畫布縮放(overlayScale)
  edgeX: {
    position: 'absolute',
    zIndex: 12,
    // 位置(中心點)由元件算好給 —— 沿線的法線推開到線的上面一點點,見 `selX`
    translate: '-50% -50%',
    borderRadius: 'var(--radius-element)',
    boxShadow: 'var(--shadow-med)',
    animationName: {default: barIn, '@media (prefers-reduced-motion: reduce)': fadeIn},
    animationDuration: 'var(--duration-fast)',
    animationTimingFunction: 'var(--ease-panel)',
  },
});
