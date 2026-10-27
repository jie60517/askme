import {describe, expect, it} from 'vitest';

import type {Catalog, FlowGraph, Schedule} from '../workflowApi';
import {changedNode, clientIssue, clientOf, connect, needsClient, scriptProblem, curve, curveMid, defaultCfg, firstOnceDate, formatWhen, isUnset, nextRun, problemNodes, runProblems, scheduleShort} from '../workflowGraph';

/** 後端 `/catalog` 的最小形狀(只放測試用得到的幾種拼圖)。 */
const catalog = {
  base: {label: '主機', sub: ''},
  client_keys: {客戶A: ['host', 'sync', 'vpn_down', 'vpn_up'], 客戶B: ['vpn_up']},
  script_types: ['.py', '.sh'],
  utc_offset_min: 480,
  nodes: {
    start: {label: '主機', outs: ['開始'], fields: [], runs_command: false, retry: false, timeout: 1, required: [], inherits_client: false},
    vpn: {
      label: '連線客戶',
      outs: ['成功', '失敗'],
      fields: [{key: 'client', label: '客戶', kind: 'pick', default: '', options: [{value: '客戶A', label: '客戶A'}]}],
      runs_command: true,
      retry: true,
      timeout: 1,
      required: ['client'],
      inherits_client: false,
    },
    sync: {
      label: '同步程式',
      outs: ['成功', '失敗'],
      fields: [
        {key: 'src', label: '來源目錄', kind: 'path', default: ''},
        {key: 'dst', label: '目的目錄', kind: 'path', default: ''},
      ],
      runs_command: true,
      retry: true,
      timeout: 30,
      required: ['src', 'dst'],
      inherits_client: true,
      client_key: 'sync',
      client_after: null,
    },
    vpnoff: {label: '中斷連線', outs: ['完成'], fields: [], runs_command: true, retry: false, timeout: 1, required: [], inherits_client: true, client_key: 'vpn_down', client_after: null},
    wait: {
      label: '等待',
      outs: ['完成'],
      fields: [{key: 'sec', label: '秒數', kind: 'int', default: 30, min: 1, max: 3600}],
      runs_command: false,
      retry: false,
      timeout: 1,
      required: [],
      inherits_client: false,
    },
  },
} as unknown as Catalog;

const graph = (): FlowGraph => ({
  nodes: [
    {id: 'start', type: 'start', x: 0, y: 0},
    {id: 'n1', type: 'vpn', x: 1, y: 0, cfg: {client: '客戶A'}},
    {id: 'n2', type: 'sync', x: 2, y: 0, cfg: {src: '/srv', dst: '/srv2'}},
  ],
  edges: [
    {from: 'start', out: 0, to: 'n1'},
    {from: 'n1', out: 0, to: 'n2'},
  ],
});

describe('runProblems(跟後端 run_problems 同一套句子,必填欄位來自 catalog)', () => {
  it('接好、設定好就沒有問題', () => {
    expect(runProblems(graph(), catalog)).toEqual([]);
  });
  it('沒接上起點、沒選客戶、繞回頭、空的', () => {
    const g = graph();
    g.edges = g.edges.filter((e) => e.from !== 'start');
    expect(runProblems(g, catalog)).toContain('2 塊沒接上主機');

    const unset = graph();
    unset.nodes[1].cfg = {client: ''};
    expect(runProblems(unset, catalog)).toContain('1 塊還沒設定');
    expect(isUnset(unset.nodes[1], catalog)).toBe('客戶');
    // 狀態字「帶我到那一塊」:有問題的那幾塊,起點不算
    expect(problemNodes(unset, catalog)).toEqual([unset.nodes[1].id]);
    expect(problemNodes(graph(), catalog)).toEqual([]);
    // 同步兩個目錄都要填
    const noDst = graph();
    noDst.nodes[2].cfg = {src: '/srv'};
    expect(isUnset(noDst.nodes[2], catalog)).toBe('目的目錄');

    const loop = graph();
    loop.edges.push({from: 'n2', out: 0, to: 'n1'});
    expect(runProblems(loop, catalog)).toContain('流程裡有繞回頭的線(會一直跑不停)');

    expect(runProblems({nodes: [{id: 'start', type: 'start', x: 0, y: 0}], edges: []}, catalog)).toEqual(['流程裡還沒有任何拼圖']);
  });
});

it('新拼圖的預設值照 catalog(逾時、欄位預設)', () => {
  expect(defaultCfg('sync', catalog)).toEqual({timeout: 30, retry: 0, src: '', dst: ''});
  // 不跑指令的拼圖沒有逾時與重試
  expect(defaultCfg('wait', catalog)).toEqual({sec: 30});
});

describe('客戶沿用上游的 VPN(跟後端 client_of 同一套規則)', () => {
  it('往回找碰到 VPN 就停;第二個 VPN 之後換成它的客戶', () => {
    const g = graph();
    expect(clientOf(g, 'n2')).toEqual(['客戶A']);
    g.nodes.push({id: 'b', type: 'vpn', x: 3, y: 0, cfg: {client: '客戶B'}}, {id: 'off', type: 'vpnoff', x: 4, y: 0});
    g.edges.push({from: 'n2', out: 0, to: 'b'}, {from: 'b', out: 0, to: 'off'});
    expect(clientOf(g, 'off')).toEqual(['客戶B']);
  });
  it('沒有上游 VPN、兩個客戶匯流、上游 VPN 還沒選', () => {
    const lonely = graph();
    lonely.edges = [{from: 'start', out: 0, to: 'n2'}];
    expect(clientIssue(lonely, lonely.nodes[2], catalog)).toEqual({kind: 'no_client', message: '前面沒有連線客戶'});
    expect(runProblems(lonely, catalog)).toContain('1 塊沒有客戶');

    const two = graph();
    two.nodes.push({id: 'b', type: 'vpn', x: 1, y: 1, cfg: {client: '客戶B'}});
    two.edges.push({from: 'start', out: 0, to: 'b'}, {from: 'b', out: 0, to: 'n2'});
    two.edges = two.edges.filter((e, i, all) => all.findIndex((x) => x.from === e.from && x.out === e.out) === i);
    two.edges.push({from: 'n1', out: 1, to: 'b'});
    expect(clientIssue(two, two.nodes[2], catalog)?.message).toBe('接到兩個客戶');

    const unset = graph();
    unset.nodes[1].cfg = {client: ''};
    // VPN 自己算「還沒設定」,下游不另外算
    expect(clientIssue(unset, unset.nodes[2], catalog)).toBeNull();
  });
  it('腳本:認不得的副檔名擋執行;接在「連線客戶」成功出口後面才沿用客戶(跟後端 needs_client 同一套)', () => {
    const cat = {...catalog, nodes: {...catalog.nodes, script: {...catalog.nodes.sync, label: '執行腳本', client_key: 'host', client_after: 'vpn', required: ['script']}}} as Catalog;
    const g = graph();
    g.nodes.push({id: 'sc', type: 'script', x: 5, y: 0, cfg: {script: '/srv/a.txt'}});
    g.edges.push({from: 'n2', out: 0, to: 'sc'});
    expect(scriptProblem(g.nodes[3], cat)).toBe('不支援這個腳本');
    expect(runProblems(g, cat)).toContain('1 塊的腳本類型不支援');
    g.nodes[3].cfg = {script: 'bin/a.py'};
    expect(scriptProblem(g.nodes[3], cat)).toBe('要填完整路徑');
    g.nodes[3].cfg = {script: '/srv/我的.py'};
    expect(scriptProblem(g.nodes[3], cat)).toBe('路徑只能有英數字與 . _ - /');
    expect(runProblems(g, cat)).toContain('1 塊的腳本路徑不對');
    g.nodes[3].cfg = {script: '/srv/A.PY'};
    expect(scriptProblem(g.nodes[3], cat)).toBeNull();
    // 「連線客戶」= VPN + 主機:它的成功出口下游(中間隔著同步也一樣)就在客戶主機跑
    expect(needsClient(g, g.nodes[3], cat)).toBe(true);
    // 接在「連線客戶」的失敗出口:沒連上,回主機
    const viaFail = graph();
    viaFail.nodes.push({id: 'sc', type: 'script', x: 5, y: 0, cfg: {script: '/srv/A.PY'}});
    viaFail.edges.push({from: 'n1', out: 1, to: 'sc'});
    expect(needsClient(viaFail, viaFail.nodes[3], cat)).toBe(false);
    // 設定檔裡沒有主機的客戶(客戶B):「連線客戶」只撥 VPN,後面的腳本照舊在主機跑
    const noHost = graph();
    noHost.nodes[1].cfg = {client: '客戶B'};
    noHost.nodes.push({id: 'sc', type: 'script', x: 5, y: 0, cfg: {script: '/srv/A.PY'}});
    noHost.edges.push({from: 'n1', out: 0, to: 'sc'});
    expect(needsClient(noHost, noHost.nodes[3], cat)).toBe(false);
  });
  it('客戶的設定檔少了這一步的指令:按執行之前就擋(跟後端同一句)', () => {
    const wb = graph();
    wb.nodes[1].cfg = {client: '客戶B'};
    expect(clientIssue(wb, wb.nodes[2], catalog)).toEqual({kind: 'config', message: '設定檔裡「客戶B」沒有這一步要用的指令'});
    expect(runProblems(wb, catalog)).toContain('1 塊的客戶在設定檔裡少了這一步的指令');
  });
});

describe('changedNode(上一步 / 下一步之後帶到哪一塊)', () => {
  const base: FlowGraph = {
    nodes: [
      {id: 'start', type: 'start', x: 0, y: 0},
      {id: 'n1', type: 'vpn', x: 200, y: 0, cfg: {client: '客戶A'}},
      {id: 'n2', type: 'notify', x: 400, y: 0},
    ],
    edges: [{from: 'start', out: 0, to: 'n1'}],
  };
  it('退回刪除:回來的那一塊,而且標成「回來的」(要播進場)', () => {
    const removed = {nodes: base.nodes.filter((n) => n.id !== 'n2'), edges: base.edges};
    expect(changedNode(removed, base)).toEqual({id: 'n2', isBack: true});
  });
  it('退回移動或改設定:動過的那一塊', () => {
    const moved = {...base, nodes: base.nodes.map((n) => (n.id === 'n1' ? {...n, x: 260} : n))};
    expect(changedNode(moved, base)).toEqual({id: 'n1', isBack: false});
  });
  it('只有線變了:那條線指到的那一塊;退回新增(那塊不見了)沒得帶', () => {
    const linked = {...base, edges: [...base.edges, {from: 'n1', out: 0, to: 'n2'}]};
    expect(changedNode(base, linked)).toEqual({id: 'n2', isBack: false});
    expect(changedNode(linked, base)).toEqual({id: 'n2', isBack: false});
    const added = {...base, nodes: [...base.nodes, {id: 'n3', type: 'wait' as const, x: 600, y: 0}]};
    expect(changedNode(added, base)).toBeNull();
  });
});

describe('connect', () => {
  it('同一個出口只留最新那條', () => {
    expect(connect(graph().edges, 'n1', 0, 'start')).toBeNull();
    const next = connect(graph().edges, 'start', 0, 'n2')!;
    expect(next.filter((e) => e.from === 'start')).toEqual([{from: 'start', out: 0, to: 'n2'}]);
    expect(connect(graph().edges, 'n1', 1, 'n1')).toBeNull();
  });
});

it('線上刪除鈕的位置就在 curve 那條線的中點', () => {
  expect(curveMid({x: 0, y: 0}, {x: 200, y: 50})).toEqual({x: 100, y: 25});
  // 往回接(控制點被拉出 48px)也一樣是那條曲線的中點
  expect(curveMid({x: 100, y: 0}, {x: 100, y: 80})).toEqual({x: 100, y: 40});
});

it('curve 從出口水平出去、水平進入接點', () => {
  expect(curve({x: 0, y: 0}, {x: 200, y: 50})).toBe('M0,0 C100,0 100,50 200,50');
  // 往回接的時候至少拉出 48px,不會變成一條折回去的直線
  expect(curve({x: 100, y: 0}, {x: 100, y: 80})).toBe('M100,0 C148,0 52,80 100,80');
});

describe('排程(跟後端 next_run 同一套規則,一律照排程時區算;這裡用 +480)', () => {
  const s = (patch: Partial<Schedule>): Schedule => ({on: true, freq: 'daily', time: '02:00', days: [1, 2, 3, 4, 5], date: '', overlap: 'skip', ...patch});
  // 用 UTC 寫「UTC+8 的牆上時間」:UTC+8 的 02:00 = UTC 前一天 18:00。2026-09-24 是星期四。
  const tw = (wall: string) => new Date(new Date(`${wall}Z`).getTime() - 480 * 60_000);
  const TW = 480;

  it('每天:過了今天的點就是明天', () => {
    expect(nextRun(s({}), tw('2026-09-24T01:59:00'), TW)).toEqual(tw('2026-09-24T02:00:00'));
    expect(nextRun(s({}), tw('2026-09-24T02:00:00'), TW)).toEqual(tw('2026-09-25T02:00:00'));
  });
  it('每週:星期用 JS 編號(0 = 日),而且是排程時區的星期幾', () => {
    expect(nextRun(s({freq: 'weekly', days: [6], time: '23:30'}), tw('2026-09-24T12:00:00'), TW)).toEqual(tw('2026-09-26T23:30:00'));
    expect(nextRun(s({freq: 'weekly', days: [0], time: '08:00'}), tw('2026-09-26T09:00:00'), TW)).toEqual(tw('2026-09-27T08:00:00'));
  });
  it('每小時與只跑一次', () => {
    expect(nextRun(s({freq: 'hourly', time: '00:15'}), tw('2026-09-24T10:20:00'), TW)).toEqual(tw('2026-09-24T11:15:00'));
    expect(nextRun(s({freq: 'once', date: '2026-09-25', time: '09:00'}), tw('2026-09-24T10:00:00'), TW)).toEqual(tw('2026-09-25T09:00:00'));
    expect(nextRun(s({freq: 'once', date: '2026-09-25', time: '09:00'}), tw('2026-09-25T10:00:00'), TW)).toBeNull();
    expect(nextRun(s({on: false}), tw('2026-09-24T10:00:00'), TW)).toBeNull();
  });
  it('切到「只跑一次」預設帶下一個還沒過的那天', () => {
    expect(firstOnceDate('02:00', TW, tw('2026-09-24T15:00:00'))).toBe('2026-09-25');
    expect(firstOnceDate('23:00', TW, tw('2026-09-24T15:00:00'))).toBe('2026-09-24');
  });
  it('顯示成排程時區的時間,不管瀏覽器在哪一區', () => {
    expect(formatWhen(tw('2026-09-25T02:00:00'), TW)).toBe('9/25(五) 02:00');
  });
  it('頁首那顆標籤', () => {
    expect(scheduleShort(s({}))).toBe('每天 02:00');
    expect(scheduleShort(s({freq: 'weekly', days: [0, 6]}))).toBe('週六、日 02:00');
    expect(scheduleShort(s({freq: 'weekly', days: [1, 2, 3, 4, 5]}))).toBe('週一至五 02:00');
    expect(scheduleShort(s({freq: 'weekly', days: [1, 3, 4, 5, 0]}))).toBe('週一、三至五、日 02:00');
    expect(scheduleShort(s({freq: 'hourly', time: '00:15'}))).toBe('每小時 15 分');
    expect(scheduleShort(s({on: false}))).toBe('未排程');
  });
});
