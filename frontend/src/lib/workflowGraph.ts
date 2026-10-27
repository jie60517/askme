/**
 * Work Flow 畫布的純邏輯:圖的檢查、摘要文字、線的形狀、排程的「下一次」。
 *
 * **拼圖種類的定義不在這裡** —— 名字、出口、欄位、預設值、哪一欄必選,全部來自後端
 * `/catalog`(`app/workflows.py` 的 `NODES`),這裡的函式都吃那一份。前端不另寫一份
 * `REQUIRED` / 預設值:那樣加一種拼圖要改好幾處,而兩邊的預設逾時沒有任何東西在比對。
 *
 * 執行前檢查(`runProblems`)與排程計算(`nextRun`)**後端各有一份**,那一份才是真的擋人的;
 * 這裡只是讓畫面在按下執行之前就把黃框與停用的按鈕畫出來。兩邊的句子刻意一樣。
 */
import type {Catalog, FlowEdge, FlowGraph, FlowNode, NodeCfg, NodeType, Schedule} from './workflowApi';

/** 拼圖盒的分組與順序。 */
export const PALETTE: Array<{group: string; types: NodeType[]}> = [
  // 「連線客戶」就是 VPN + 主機一次連好,所以拼圖盒不另外給「連線客戶主機」;流程裡已經有的照顯示、照跑
  {group: '連線', types: ['vpn', 'vpnoff']},
  // 「備份資料庫」不放進拼圖盒;流程裡已經有的那塊照跑、照顯示
  {group: '程式', types: ['sync', 'script']},
  // 「條件判斷」不放進拼圖盒;流程裡已經有的那塊照跑、照顯示
  {group: '流程控制', types: ['wait']},
  {group: '通知', types: ['notify']},
];

/**
 * 拼圖盒裡有的種類。不在拼圖盒的(備份資料庫、條件判斷、連線客戶主機)流程裡已經有的照跑、照顯示,
 * 但**不能再複製出新的一塊**(右鍵的複製鈕不畫)—— 不在拼圖盒就是不要再多出來
 */
export const PALETTE_TYPES: ReadonlySet<NodeType> = new Set(PALETTE.flatMap((g) => g.types));

/** 新拖出來那一塊的設定:照後端給的欄位預設值與逾時。 */
export function defaultCfg(type: NodeType, catalog: Catalog): NodeCfg {
  const spec = catalog.nodes[type];
  const cfg: NodeCfg = {};
  if (spec.runs_command) cfg.timeout = spec.timeout;
  if (spec.retry) cfg.retry = 0;
  for (const f of spec.fields) cfg[f.key] = Array.isArray(f.default) ? [...f.default] : f.default;
  return cfg;
}

export function reachable(graph: FlowGraph): Set<string> {
  const seen = new Set(['start']);
  const queue = ['start'];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const e of graph.edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

/** 這塊第一個還沒填的必填欄位名(「客戶」「來源目錄」);都填了回 null。 */
export function isUnset(node: FlowNode, catalog: Catalog | null): string | null {
  const spec = catalog?.nodes[node.type];
  for (const key of spec?.required ?? []) {
    const v = node.cfg?.[key];
    // 「通知人員」的名單是陣列:空陣列也算沒選
    if (Array.isArray(v) ? v.length : v) continue;
    return spec?.fields.find((f) => f.key === key)?.label ?? key;
  }
  return null;
}

function hasCycle(graph: FlowGraph): boolean {
  const next = new Map<string, string[]>();
  for (const e of graph.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const m of next.get(id) ?? []) {
      if (state.get(m) === 1 || (!state.has(m) && visit(m))) return true;
    }
    state.set(id, 2);
    return false;
  };
  return visit('start');
}

/** 執行前檢查。回空陣列 = 可以跑。句子跟後端 `run_problems` 一樣。 */
export function runProblems(graph: FlowGraph, catalog: Catalog | null): string[] {
  const out: string[] = [];
  if (graph.nodes.length < 2) out.push('流程裡還沒有任何拼圖');
  const reach = reachable(graph);
  const orphan = graph.nodes.filter((n) => !reach.has(n.id)).length;
  if (orphan) out.push(`${orphan} 塊沒接上主機`);
  const empty = graph.nodes.filter((n) => isUnset(n, catalog)).length;
  if (empty) out.push(`${empty} 塊還沒設定`);
  const scripts = graph.nodes.map((n) => scriptProblem(n, catalog)).filter(Boolean);
  const unsupported = scripts.filter((m) => m === '不支援這個腳本').length;
  if (unsupported) out.push(`${unsupported} 塊的腳本類型不支援`);
  // 路徑本身不合法的,後端存檔就會擋(safe_path);這裡先講,不要等按了儲存才知道
  if (scripts.length > unsupported) out.push(`${scripts.length - unsupported} 塊的腳本路徑不對`);
  const kinds = graph.nodes.map((n) => clientIssue(graph, n, catalog)?.kind);
  const noClient = kinds.filter((k) => k === 'no_client').length;
  const config = kinds.filter((k) => k === 'config').length;
  if (noClient) out.push(`${noClient} 塊沒有客戶`);
  if (config) out.push(`${config} 塊的客戶在設定檔裡少了這一步的指令`);
  if (hasCycle(graph)) out.push('流程裡有繞回頭的線(會一直跑不停)');
  return out;
}

/**
 * 有問題的那幾塊(沒接上、還沒設定、客戶有問題),照畫面上由左到右、由上到下排。
 * 畫布左上角那行「N 塊還沒設定」點下去,就照這個順序一塊一塊帶過去。
 */
export function problemNodes(graph: FlowGraph, catalog: Catalog | null): string[] {
  const reach = reachable(graph);
  return graph.nodes
    .filter((n) => n.id !== 'start' && (!reach.has(n.id) || isUnset(n, catalog) || scriptProblem(n, catalog) || clientIssue(graph, n, catalog)))
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((n) => n.id);
}

/** 接一條線:同一個出口只能有一條(新的蓋掉舊的);起點不能被接、不能接自己。回新的 edges,或 null = 不接。 */
export function connect(edges: FlowEdge[], from: string, out: number, to: string): FlowEdge[] | null {
  if (to === 'start' || to === from) return null;
  return [...edges.filter((e) => !(e.from === from && e.out === out)), {from, out, to}];
}

export const edgeKey = (e: {from: string; out: number}) => `${e.from}:${e.out}`;

/** 兩個接點之間的曲線(水平出、水平進)。往回接的時候至少拉出 `CURVE_MIN_PX`。 */
const CURVE_MIN_PX = 48;
export function curve(a: {x: number; y: number}, b: {x: number; y: number}): string {
  const dx = Math.max(CURVE_MIN_PX, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

/** `curve` 那條線的中點(三次貝茲 t = 0.5 = (a + 3c1 + 3c2 + b) / 8)。線上的刪除鈕放這裡,跟 `curve` 同一組控制點。 */
export function curveMid(a: {x: number; y: number}, b: {x: number; y: number}): {x: number; y: number} {
  const dx = Math.max(CURVE_MIN_PX, Math.abs(b.x - a.x) * 0.5);
  return {x: (a.x + 3 * (a.x + dx) + 3 * (b.x - dx) + b.x) / 8, y: (a.y + b.y) / 2};
}

/**
 * `curve` 那條線在中點的**單位法線**,朝畫面上方的那一側(y < 0;線剛好垂直時朝左)。
 * 選到線時那顆刪除鈕沿著它推開 —— 只往正上方推的話,陡的那段線(兩塊拼圖上下錯開)還是會被按鈕壓住
 * 切線 = 三次貝茲在 t = 0.5 的導數:0.75(c1 − a) + 1.5(c2 − c1) + 0.75(b − c2)。
 */
export function curveMidNormal(a: {x: number; y: number}, b: {x: number; y: number}): {x: number; y: number} {
  const dx = Math.max(CURVE_MIN_PX, Math.abs(b.x - a.x) * 0.5);
  const tx = 1.5 * (b.x - a.x) - 1.5 * dx;
  const ty = 1.5 * (b.y - a.y);
  const len = Math.hypot(tx, ty) || 1;
  // 兩條法線 (ty, −tx) 與 (−ty, tx),挑朝上的那一條
  let nx = ty / len;
  let ny = -tx / len;
  if (ny > 0 || (ny === 0 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  return {x: nx, y: ny};
}

/**
 * 哪些欄位畫在拼圖上。沒列到的欄位畫面上不出現,照後端的預設值跑 —— 逾時與重試一律用預設。
 * 這張表只決定**放在哪裡**;欄位本身的定義(名字、種類、選項)在後端 `/catalog`。
 */
export const INLINE_FIELDS: Record<NodeType, string[]> = {
  start: [],
  vpn: ['client'],
  ssh: [],
  vpnoff: [],
  sync: ['src', 'dst'],
  script: ['script'],
  backup: ['db'],
  cond: ['cond'],
  wait: ['sec'],
  // 通知內容不用選:一律附完整的失敗原因與輸出
  notify: ['who'],
};

/**
 * 跑到這一塊的時候客戶主機是不是連著的:往回找得到「連線客戶」(或「連線客戶主機」)的**成功**出口
 * (跟後端 `connected_to_client_host` 同一份)。碰到「中斷連線」、或接在它們的失敗出口就不算。
 * 「連線客戶」就是 VPN + 主機一起連,所以它的成功出口也算 —— **但只有那個客戶設定檔裡有主機
 * (`client_keys` 有 `host`)時才算**;沒寫主機的客戶只撥 VPN,後面的腳本照舊在主機跑。
 */
export function connectedToClientHost(graph: FlowGraph, id: string, catalog: Catalog | null): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.edges) {
      if (e.to !== cur || seen.has(e.from)) continue;
      seen.add(e.from);
      const up = byId.get(e.from);
      const t = up?.type;
      const hasHost = t === 'vpn' && !!catalog?.client_keys[String(up?.cfg?.client ?? '')]?.includes('host');
      if (t === 'ssh' || hasHost) {
        if (e.out === 0) return true;
        continue;
      }
      if (t === 'vpnoff' || t === 'vpn') continue;
      stack.push(e.from);
    }
  }
  return false;
}

/** 這一塊要不要沿用上游「連線客戶」的客戶。條件照 `/catalog` 的 `client_after`,跟後端 `needs_client` 同一份。 */
export function needsClient(graph: FlowGraph, node: FlowNode, catalog: Catalog | null): boolean {
  const spec = catalog?.nodes[node.type];
  if (!spec?.inherits_client) return false;
  return !spec.client_after || connectedToClientHost(graph, node.id, catalog);
}

/** 跟後端 `workflows._PATH_RE` 同一條:`/` 或 `~/` 開頭,只有英數與 `._-/` */
const PATH_RE = /^(~(\/|$)|\/)[A-Za-z0-9._/-]*$/;

/**
 * 「執行腳本」填的路徑有什麼問題(打完就畫在拼圖上,不等存檔才報)。沒填回 null(那是「還沒設定」)。
 * 路徑的規則跟後端 `safe_path` 一樣、副檔名清單來自後端 `/catalog` 的 `script_types`。
 */
export function scriptProblem(node: FlowNode, catalog: Catalog | null): string | null {
  const path = node.type === 'script' ? String(node.cfg?.script ?? '') : '';
  if (!path || !catalog) return null;
  if (!path.startsWith('/') && !path.startsWith('~/')) return '要填完整路徑';
  if (!PATH_RE.test(path) || path.split('/').includes('..')) return '路徑只能有英數字與 . _ - /';
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || !catalog.script_types.includes(name.slice(dot).toLowerCase())) return '不支援這個腳本';
  return null;
}

/**
 * 沿著線往回找,這一塊的客戶來自哪幾個「連線客戶」—— 碰到「連線客戶」就停,不再往上。
 * 跟後端 `workflows.client_of` 同一套規則:排序過、不重複;上游 VPN 還沒選客戶的話裡面有一個空字串。
 */
export function clientOf(graph: FlowGraph, nodeId: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const found = new Set<string>();
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.edges) {
      if (e.to !== cur || seen.has(e.from)) continue;
      seen.add(e.from);
      const up = byId.get(e.from);
      if (!up) continue;
      if (up.type === 'vpn') found.add(String(up.cfg?.client ?? ''));
      else stack.push(up.id);
    }
  }
  return [...found].sort();
}

/** 客戶問題:沒有客戶 / 客戶的設定檔少了這一步的指令。種類跟後端 `NO_CLIENT` / `CLIENT_CONFIG` 一樣。 */
export type ClientIssue = {kind: 'no_client' | 'config'; message: string};

/** 這一塊在客戶這件事上的問題(拼圖上那個黃色標籤);沒有問題回 null。規則與句子跟後端 `client_issue` 一樣。 */
export function clientIssue(graph: FlowGraph, node: FlowNode, catalog: Catalog | null): ClientIssue | null {
  if (!catalog || !needsClient(graph, node, catalog)) return null;
  const names = clientOf(graph, node.id);
  const real = names.filter(Boolean);
  if (real.length > 1) return {kind: 'no_client', message: '接到兩個客戶'};
  if (real.length === 0) return names.includes('') ? null : {kind: 'no_client', message: '前面沒有連線客戶'};
  if (!catalog.client_keys[real[0]]?.includes(catalog.nodes[node.type].client_key)) {
    return {kind: 'config', message: `設定檔裡「${real[0]}」沒有這一步要用的指令`};
  }
  return null;
}

/** 拿掉一塊拼圖(連同接在它身上的線)。起點拿不掉。 */
export function withoutNode(graph: FlowGraph, id: string): FlowGraph {
  if (id === 'start') return graph;
  return {nodes: graph.nodes.filter((n) => n.id !== id), edges: graph.edges.filter((e) => e.from !== id && e.to !== id)};
}

/** 拿掉一條線(`edgeKey`)。 */
export function withoutEdge(graph: FlowGraph, key: string): FlowGraph {
  return {...graph, edges: graph.edges.filter((e) => edgeKey(e) !== key)};
}

/**
 * 上一步 / 下一步之後,畫面該帶到哪一塊:`after` 裡第一塊「回來的」(before 沒有)或「動過的」(位置、設定變了);
 * 拼圖都沒變、只有線變了,就是那條線指到的那一塊。都找不到(例如退回的是新增,那塊不見了)回 null。
 */
export function changedNode(before: FlowGraph, after: FlowGraph): {id: string; isBack: boolean} | null {
  const old = new Map(before.nodes.map((n) => [n.id, JSON.stringify(n)]));
  for (const n of after.nodes) {
    const was = old.get(n.id);
    if (was === undefined) return {id: n.id, isBack: true};
    if (was !== JSON.stringify(n)) return {id: n.id, isBack: false};
  }
  const oldEdges = new Set(before.edges.map(edgeKey));
  const newEdges = new Set(after.edges.map(edgeKey));
  const edge = after.edges.find((e) => !oldEdges.has(edgeKey(e))) ?? before.edges.find((e) => !newEdges.has(edgeKey(e)));
  if (edge && after.nodes.some((n) => n.id === edge.to)) return {id: edge.to, isBack: false};
  return null;
}

// ── 排程 ─────────────────────────────────────────────────────────────────────
//
// ⚠️ **一律照後端的時區算**(`Catalog.utc_offset_min`,預設 +480),不照瀏覽器的。
// 排程是後端在跑,在國外出差的人打開畫面,看到的「下次執行」要是真的會觸發的那個時間 ——
// 用瀏覽器時區的話兩邊差幾個小時。做法:把時間平移成「那個時區的牆上時間」,用 UTC 的
// getter/setter 算(不受瀏覽器時區影響),算完再平移回來。

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
/** 星期幾的按鈕順序:一到日(週一開頭)。 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const DEFAULT_SCHEDULE: Schedule = {
  on: false,
  freq: 'daily',
  time: '02:00',
  days: [1, 2, 3, 4, 5],
  date: '',
  overlap: 'skip',
};

const MINUTE = 60_000;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 星期幾的簡寫:連續三天以上寫成區間(「週一至五」),其他用頓號(「週六、日」)。
 * 頁首那顆標籤放不下「每週一、二、三、四、五」—— 字變長會把旁邊的切換鈕往右推。
 */
export function weekdaysShort(days: number[]): string {
  const order = WEEK_ORDER.filter((d) => days.includes(d));
  if (order.length === 7) return '每天';
  const parts: string[] = [];
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && WEEK_ORDER.indexOf(order[j + 1]) === WEEK_ORDER.indexOf(order[j]) + 1) j++;
    const run = order.slice(i, j + 1).map((d) => WEEKDAYS[d]);
    parts.push(run.length >= 3 ? `${run[0]}至${run[run.length - 1]}` : run.join('、'));
    i = j + 1;
  }
  return `週${parts.join('、')}`;
}

export function scheduleShort(s: Schedule): string {
  if (!s.on) return '未排程';
  if (s.freq === 'daily') return `每天 ${s.time}`;
  if (s.freq === 'weekly') return `${weekdaysShort(s.days)} ${s.time}`;
  if (s.freq === 'hourly') return `每小時 ${Number(s.time.slice(3))} 分`;
  return `${s.date ? s.date.slice(5).replace('-', '/') : ''} ${s.time}`.trim();
}

/** `after` 之後(不含)的下一次。`offsetMin` = 排程時區比 UTC 快幾分鐘。跟後端 `next_run` 同一套規則。 */
export function nextRun(s: Schedule, after: Date, offsetMin: number): Date | null {
  if (!s.on) return null;
  const [hh, mm] = s.time.split(':').map(Number);
  // 「排程時區的牆上時間」,用 UTC getter 讀
  const wall = new Date(after.getTime() + offsetMin * MINUTE);
  const back = (d: Date) => new Date(d.getTime() - offsetMin * MINUTE);
  if (s.freq === 'hourly') {
    const d = new Date(wall);
    d.setUTCMinutes(mm, 0, 0);
    if (d <= wall) d.setUTCHours(d.getUTCHours() + 1);
    return back(d);
  }
  if (s.freq === 'once') {
    if (!s.date) return null;
    const d = new Date(`${s.date}T${s.time}:00Z`);
    return d > wall ? back(d) : null;
  }
  for (let i = 0; i < 8; i++) {
    const d = new Date(wall);
    d.setUTCDate(wall.getUTCDate() + i);
    d.setUTCHours(hh, mm, 0, 0);
    if (d <= wall) continue;
    if (s.freq === 'weekly' && !s.days.includes(d.getUTCDay())) continue;
    return back(d);
  }
  return null;
}

/** 顯示成排程時區的「9/25(五) 02:00」。 */
export function formatWhen(d: Date, offsetMin: number): string {
  const w = new Date(d.getTime() + offsetMin * MINUTE);
  return `${w.getUTCMonth() + 1}/${w.getUTCDate()}(${WEEKDAYS[w.getUTCDay()]}) ${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

/** 排程時區的「今天」(YYYY-MM-DD)。 */
export function todayIn(offsetMin: number, now = new Date()): string {
  const w = new Date(now.getTime() + offsetMin * MINUTE);
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/**
 * 切到「只跑一次」時預設帶哪一天:這個時間今天還沒過就今天,過了就明天。
 * 直接帶今天的話,下午打開、時間是 02:00 —— 畫面立刻變成「沒有下一次」。
 */
export function firstOnceDate(time: string, offsetMin: number, now = new Date()): string {
  const next = nextRun({...DEFAULT_SCHEDULE, on: true, freq: 'daily', time}, now, offsetMin)!;
  return todayIn(offsetMin, next);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)} 分 ${pad(s % 60)} 秒`;
}
