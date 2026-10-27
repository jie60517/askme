/**
 * Work Flow(側邊欄 Work Flow,`/workflow`)的 API 與型別。後端是 `app/routers/workflows.py`。
 * 功能是可選的:主機上沒有 `workflow_actions.json` 的話這組 API 一律 404,`/api/me` 的 `workflow_enabled` 是 false。
 *
 * ⚠️ 前端**永遠不送指令**:拼圖的設定只有「選了清單裡的哪一個」與同步的目錄、腳本路徑,
 * 選單內容來自 `/catalog`,跑什麼是主機上 `workflow_actions.json` 決定的。
 */
import {api} from './api';

export type NodeType =
  | 'start'
  | 'vpn'
  | 'ssh'
  | 'vpnoff'
  | 'sync'
  | 'script'
  | 'backup'
  | 'cond'
  | 'wait'
  | 'notify';

/** 拼圖的設定值。`string[]` 是「通知人員」要 @ 的人與群組(`people` 欄位) */
export type NodeCfg = Record<string, string | number | boolean | string[]>;

export type FlowNode = {id: string; type: NodeType; x: number; y: number; cfg?: NodeCfg};
export type FlowEdge = {from: string; out: number; to: string};
export type FlowGraph = {nodes: FlowNode[]; edges: FlowEdge[]};

export type Freq = 'daily' | 'weekly' | 'hourly' | 'once';
export type Schedule = {
  on: boolean;
  freq: Freq;
  /** HH:MM(每小時的話只看分鐘) */
  time: string;
  /** 0 = 星期日(跟 JS `getDay()` 同一套,後端也照這個) */
  days: number[];
  /** YYYY-MM-DD,只有 once 用 */
  date: string;
  overlap: 'skip' | 'queue';
  /** 誰設的這個排程(後端填,排程觸發的執行記在他名下) */
  by?: string;
};

export type RunStatus = 'running' | 'ok' | 'fail' | 'stopped' | 'skipped';

export type WorkflowSummary = {
  id: number;
  name: string;
  schedule: Schedule;
  next_run_at: string | null;
  last_status: RunStatus | null;
  last_run_at: string | null;
  /** 從主機沿著「成功」一路走下去的拼圖名稱(清單頁那一行灰字) */
  path: string[];
};

export type WorkflowDetail = {
  id: number;
  name: string;
  graph: FlowGraph;
  schedule: Schedule;
  next_run_at: string | null;
  updated_by: string;
  updated_at: string | null;
  running_run_id: number | null;
};

export type Option = {
  value: string;
  label: string;
  /** 以下只有 `people` 欄位有:職稱(人)、是不是群組、群組現在幾個人 */
  role?: string;
  group?: boolean;
  count?: number;
};

/** 拼圖的一個設定欄位(後端 `workflows.Field`)。設定面板照 `kind` 畫輸入框。 */
export type FieldSpec = {
  key: string;
  label: string;
  kind: 'pick' | 'path' | 'bool' | 'int' | 'people';
  default: string | number | boolean | string[];
  options?: Option[];
  min?: number;
  max?: number;
};

/** 一種拼圖(後端 `workflows.NODES` 的一列)。**這是唯一的定義**,前端不另寫一份。 */
export type NodeSpec = {
  label: string;
  outs: string[];
  fields: FieldSpec[];
  runs_command: boolean;
  retry: boolean;
  /** 新拖出來那一塊的預設逾時(分鐘) */
  timeout: number;
  /** 執行前一定要填的那幾欄(同步是來源、目的兩個) */
  required: string[];
  /** 客戶沿用上游「連線客戶」選的那一個,自己不選 */
  inherits_client: boolean;
  /** 這一步要用客戶設定裡的哪一個鍵(`client_keys` 裡沒有就是設定檔少了指令) */
  client_key: string;
  /** 只有上游連著客戶主機時才沿用客戶(「執行腳本」接在「連線客戶」或「連線客戶主機」成功出口後面才在客戶主機跑,見 `connectedToClientHost`);null = 一律沿用 */
  client_after: NodeType | null;
};

export type Catalog = {
  base: {label: string; sub: string};
  nodes: Record<NodeType, NodeSpec>;
  /** 每個客戶在設定檔裡有哪幾個鍵(只有鍵名,沒有指令) */
  client_keys: Record<string, string[]>;
  /** 「執行腳本」認得的副檔名(`.py`、`.sh`…,後端 SCRIPT_RUNNERS) */
  script_types: string[];
  /** 排程的時區(比 UTC 快幾分鐘)。「下次執行」照這個算,不照瀏覽器的。 */
  utc_offset_min: number;
};

export type StepStatus = 'running' | 'ok' | 'fail';
export type RunStep = {
  node: string;
  type: NodeType;
  label: string;
  status: StepStatus;
  started: string;
  finished: string;
  progress: number | null;
  message: string;
  /** 執行中的副標(同步的「x / N 個檔案」),空字串就不顯示 */
  detail: string;
  line_count: number;
  lines?: string[];
};
export type RunEvent = {t: string; node: string; label: string; msg: string; level: '' | 'ok' | 'fail'};
export type PathEdge = FlowEdge & {state: 'done' | 'fail'};
export type RunView = {
  id: number;
  workflow_id: number;
  status: RunStatus;
  trigger: 'manual' | 'schedule';
  triggered_by: string;
  started_at: string | null;
  finished_at: string | null;
  stopped_at: string;
  steps: RunStep[];
  path: PathEdge[];
  /** 這一次跑的是哪一版的圖(事後改了流程,重播的仍是當時那一版) */
  graph: FlowGraph;
  events: RunEvent[];
  events_total: number;
};
export type RunRow = {
  id: number;
  trigger: 'manual' | 'schedule';
  triggered_by: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  stopped_at: string;
};

type SaveBody = {name: string; graph: FlowGraph; schedule: Schedule; base_updated_at?: string | null};

export async function getCatalog(): Promise<Catalog> {
  return (await api.get<Catalog>('/api/workflows/catalog')).data;
}
export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return (await api.get<WorkflowSummary[]>('/api/workflows')).data;
}
export async function getWorkflow(id: number): Promise<WorkflowDetail> {
  return (await api.get<WorkflowDetail>(`/api/workflows/${id}`)).data;
}
export async function createWorkflow(body: Partial<SaveBody>): Promise<WorkflowDetail> {
  return (await api.post<WorkflowDetail>('/api/workflows', body)).data;
}
export async function saveWorkflow(id: number, body: SaveBody): Promise<WorkflowDetail> {
  return (await api.put<WorkflowDetail>(`/api/workflows/${id}`, body)).data;
}
/** 清單頁的排程開關:只動 on,其他排程內容不變。 */
export async function switchSchedule(id: number, on: boolean): Promise<WorkflowDetail> {
  return (await api.patch<WorkflowDetail>(`/api/workflows/${id}/schedule`, {on})).data;
}
export async function deleteWorkflow(id: number): Promise<void> {
  await api.delete(`/api/workflows/${id}`);
}
export async function runWorkflow(id: number): Promise<RunView> {
  return (await api.post<RunView>(`/api/workflows/${id}/run`)).data;
}
export async function getRun(runId: number, since = 0, lines = false): Promise<RunView> {
  return (await api.get<RunView>(`/api/workflows/runs/${runId}`, {params: {since, lines}})).data;
}
export async function stopRun(runId: number): Promise<void> {
  await api.post(`/api/workflows/runs/${runId}/stop`);
}
export async function listRuns(id: number): Promise<RunRow[]> {
  return (await api.get<RunRow[]>(`/api/workflows/${id}/runs`)).data;
}
