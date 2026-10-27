/**
 * SSH 終端機(側邊欄 SSH Server,`/ssh`)的協定與 API。
 *
 * 兩條路:
 *   - WebSocket `/api/terminal/ws`:終端機本體。text frame 是 JSON 控制訊息、binary 是位元組。
 *     **第一個訊息一定是 auth 帶 token**(瀏覽器開 WebSocket 帶不了 Authorization 標頭)。
 *   - HTTP `/api/terminal/files*`:檔案欄。走 axios(帶 Bearer),每一支都要帶 session_id ——
 *     所以包成 `createFilesApi(sessionId)`,面板拿到一組綁好 session 的函式,不用每次都傳。
 *
 * 這個檔案**沒有 React**,純函式那幾支(路徑、大小、cd 指令、關閉碼對照)有單元測試。
 */
import {api} from './api';
import {getToken} from './auth';
import {scaleBytes} from './byteUnits';

// ── 協定 ─────────────────────────────────────────────────────────────

export type TerminalStatus = {
  type: 'status';
  state: 'connected';
  session_id: string;
  /** 檔案欄的起點(絕對路徑),由 sshd 那頭解出來 */
  home: string;
  /** 例如 `deploy@app-server` */
  label: string;
  /** 一次上傳的上限(MB),後端 MAX_REQUEST_MB;前端在送出前就先擋 */
  max_upload_mb: number;
  /** 同時能開幾條(頁籤的上限)。**只有這一份**,前端不自己寫死 —— 後端 SSH_TERMINAL_MAX_SESSIONS */
  max_sessions: number;
  /** 這台主機有沒有 claude CLI。沒有的話 AskME 那顆按鈕根本不要畫 */
  ai_enabled: boolean;
  /** 連的是主機清單裡的哪一台。閒置的螢幕保護靠它決定主機清單上哪張卡片是亮的 */
  host_id: string;
};

/**
 * 主機清單上的一台主機(`GET /api/terminal/hosts`)。
 *
 * ⚠️ **只有名字**:位址、帳號、憑證永遠不出伺服器。要連哪一台是送 `id` 過去,
 * 由後端自己查設定 —— 瀏覽器從頭到尾不知道那台機器在哪裡。
 */
export type TerminalHost = {
  id: string;
  /** 主機卡片與頁籤上的名字,例如「主機」或 `deploy@app-server` */
  label: string;
  /** 名字底下那行小字,例如 `app-server · deploy` */
  sub: string;
  /** 經過哪一台(跳板的 id)。空字串 = 直連 */
  via: string;
};

/** 主機清單上有哪幾台可以連。權限不足或功能沒開時後端回空陣列。 */
export async function listTerminalHosts(): Promise<TerminalHost[]> {
  const res = await api.get<{hosts: TerminalHost[]}>('/api/terminal/hosts');
  return res.data.hosts ?? [];
}

/**
 * 終端機的目前目錄變了(後端每秒看一次 `/proc/<shell>/cwd`,變了才送)。
 * 檔案欄收到就跟過去 —— 使用者在終端機 `cd`,左邊的檔案清單自己換位置。
 */
export type TerminalCwd = {
  type: 'cwd';
  path: string;
};

/**
 * 這個目錄裡的東西變了(後端每秒看一次目前目錄與檔案欄開著的目錄的修改時間,變了才送)。
 * 終端機裡 mkdir / rm 之後,檔案欄開著的正好是這個目錄就重列。
 */
export type TerminalDirChange = {
  type: 'dir';
  path: string;
};

export type ClosedReason =
  | 'exit'
  | 'idle'
  | 'server'
  | 'error'
  | 'left_page'
  /** 登入在連線期間失效了(登出、改密碼、被停用、職稱降級);後端會定期回頭確認,不是只在握手時驗 */
  | 'revoked'
  | 'network';

export type TerminalClosed = {
  type: 'closed';
  reason: ClosedReason;
  /** WebSocket 關閉碼(後端給的;網路直接斷時是瀏覽器的 close event code) */
  code: number;
  /** 後端給的中文;沒有(網路直接斷)就用 closeMessage() 補 */
  message: string;
};

/** 後端的 WebSocket 關閉碼(app/terminal.py)。 */
export const CLOSE_CODE = {
  unauthenticated: 4401,
  forbidden: 4403,
  disabled: 4404,
  idle: 4408,
  /** 開太多條(每人最多 SSH_TERMINAL_MAX_SESSIONS 條,滿了拒絕新的) */
  tooMany: 4429,
  unreachable: 4502,
} as const;

/**
 * 沒收到 `closed` 訊息時(網路斷、nginx 切掉、服務重啟)照關閉碼補一句給人看的話。
 * 收到 `closed` 的話一律以那句為準 —— 後端知道得比較多。
 */
export function closeMessage(code: number, closed?: TerminalClosed | null): TerminalClosed {
  if (closed) return closed;
  const make = (reason: ClosedReason, message: string): TerminalClosed => ({
    type: 'closed',
    reason,
    code,
    message,
  });
  switch (code) {
    case CLOSE_CODE.unauthenticated:
      return make('error', '登入已過期,請重新整理後再試。');
    case CLOSE_CODE.forbidden:
      return make('error', '這個功能只開放給工程師。');
    case CLOSE_CODE.disabled:
      return make('error', 'SSH 終端機沒有開啟。');
    case CLOSE_CODE.idle:
      return make('idle', '太久沒有操作,已自動斷線。');
    case CLOSE_CODE.tooMany:
      return make('error', '同時開的連線已經到上限,關掉一個頁籤再開。');
    case CLOSE_CODE.unreachable:
      return make('error', '連不上主機。');
    case 1000:
      return make('exit', '連線已結束。');
    default:
      return make('network', '連線中斷(網路或伺服器重新啟動)。');
  }
}

// ── 路徑與顯示 ─────────────────────────────────────────────────────────

/** `dir/name`,不管 dir 尾巴有沒有斜線。 */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** 上一層。`/` 的上一層還是 `/`。 */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return '/';
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

export type Crumb = {label: string; path: string};

/**
 * 路徑列的每一段。家目錄底下的用 `~` 起頭(跟 shell 的習慣一樣),不在家目錄底下的從 `/` 起。
 *
 *   crumbsOf('/home/deploy/app/src', '/home/deploy') → ~ / app / src
 *   crumbsOf('/srv/data', '/home/deploy')            → / / srv / data
 */
export function crumbsOf(path: string, home: string): Crumb[] {
  const clean = path.replace(/\/+$/, '') || '/';
  const homeClean = home.replace(/\/+$/, '') || '/';
  const underHome = homeClean !== '/' && (clean === homeClean || clean.startsWith(homeClean + '/'));
  const root: Crumb = underHome ? {label: '~', path: homeClean} : {label: '/', path: '/'};
  const rest = underHome ? clean.slice(homeClean.length) : clean;
  const crumbs = [root];
  let acc = root.path === '/' ? '' : root.path;
  for (const seg of rest.split('/').filter(Boolean)) {
    acc += '/' + seg;
    crumbs.push({label: seg, path: acc});
  }
  return crumbs;
}

/** 把家目錄底下的路徑縮成 `~/...`(給標題、拖放提示用)。 */
export function shortPath(path: string, home: string): string {
  const homeClean = home.replace(/\/+$/, '');
  if (homeClean && (path === homeClean || path.startsWith(homeClean + '/'))) {
    return '~' + path.slice(homeClean.length);
  }
  return path;
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * 1023 B / 4.2 KB / 1.5 MB / 2.0 GB。
 *
 * ⚠️ 升單位看的是**四捨五入之後**的值:1,048,575 B 是 1023.999 KB,
 * 只比 1024 小一點點,`toFixed(1)` 之後卻變成「1024.0 KB」—— 一個不該出現的數字。
 * 進位後到了 1024 就當下一個單位的 1.0(規則在 `lib/byteUnits.ts`,跟檔案區共用)。
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const {value, unit} = scaleBytes(bytes, SIZE_UNITS, (v) => Math.round(v * 10) / 10);
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * `YYYY-MM-DD HH:mm`。mtime 是秒。
 *
 * **一律帶年**:檔案欄常常在看好幾年前的程式碼,省掉年份反而要多想一下。
 */
export function formatMtime(mtimeSec: number): string {
  if (!mtimeSec) return '';
  const d = new Date(mtimeSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── WebSocket ────────────────────────────────────────────────────────

/** `ws(s)://…/api/terminal/ws`,跟 axios 同一個 base(留空 = 同源)。 */
export function terminalWsUrl(
  base: string = import.meta.env.VITE_API_BASE || '',
  loc: {protocol: string; host: string} = window.location,
): string {
  const path = '/api/terminal/ws';
  if (base) return base.replace(/^http/, 'ws').replace(/\/$/, '') + path;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${path}`;
}

export type TerminalHandlers = {
  onStatus: (status: TerminalStatus) => void;
  onData: (data: Uint8Array) => void;
  onClosed: (closed: TerminalClosed) => void;
  /** 終端機的目前目錄變了(含連上之後的第一次)。認不出 shell 的機器上永遠不會叫。 */
  onCwd?: (path: string) => void;
  /** 這個目錄裡的東西變了(終端機裡 mkdir / rm 之類)。讀不到修改時間的主機上永遠不會叫。 */
  onDirChange?: (change: TerminalDirChange) => void;
};

export type TerminalConnection = {
  /** 鍵盤輸入(xterm 給的是字串;二進位貼上就是 Uint8Array) */
  sendInput: (data: string | Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  /** 檔案欄有操作 —— 讓後端重設閒置計時 */
  activity: () => void;
  /** 使用者離開這一頁。後端會以 left_page 收線,不會再回 closed。 */
  close: () => void;
};

/**
 * 開一條終端機。連上之後 `onStatus` 會帶 session_id(檔案 API 要用)。
 * 結束(不管誰結束的)一定會呼叫 **一次** `onClosed`;自己 `close()` 的不算。
 *
 * `hostId` 是主機清單上點的那一台(`listTerminalHosts` 的 id)。**只送 id** ——
 * 連到哪、用誰、拿什麼憑證都是後端查設定決定的,不認得的 id 後端會拒絕(不會默默連別台)。
 */
export function connectTerminal(
  size: {cols: number; rows: number; hostId?: string},
  handlers: TerminalHandlers,
): TerminalConnection {
  const ws = new WebSocket(terminalWsUrl());
  ws.binaryType = 'arraybuffer';
  const encoder = new TextEncoder();
  let closed: TerminalClosed | null = null;
  let announced = false;
  let closedByUs = false;

  const announce = (c: TerminalClosed) => {
    if (announced || closedByUs) return;
    announced = true;
    handlers.onClosed(c);
  };

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        type: 'auth',
        token: getToken() || '',
        cols: size.cols,
        rows: size.rows,
        host: size.hostId || '',
      }),
    );
  });
  ws.addEventListener('message', (e: MessageEvent) => {
    if (typeof e.data === 'string') {
      let msg: {type?: string};
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'status') handlers.onStatus(msg as TerminalStatus);
      else if (msg.type === 'cwd') handlers.onCwd?.((msg as TerminalCwd).path);
      else if (msg.type === 'dir') handlers.onDirChange?.(msg as TerminalDirChange);
      else if (msg.type === 'closed') closed = msg as TerminalClosed;
      return;
    }
    handlers.onData(new Uint8Array(e.data as ArrayBuffer));
  });
  ws.addEventListener('close', (e: CloseEvent) => announce(closeMessage(e.code, closed)));
  ws.addEventListener('error', () => {
    // error 之後一定跟著 close;這裡不做事,免得 onClosed 叫兩次
  });

  const sendIfOpen = (payload: string | ArrayBuffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  };
  // WebSocket.send 要的是 ArrayBuffer;Uint8Array 可能是某個大 buffer 的一段,切出剛好那一段
  const toBuffer = (u8: Uint8Array): ArrayBuffer =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

  return {
    sendInput(data) {
      sendIfOpen(toBuffer(typeof data === 'string' ? encoder.encode(data) : data));
    },
    resize(cols, rows) {
      sendIfOpen(JSON.stringify({type: 'resize', cols, rows}));
    },
    activity() {
      sendIfOpen(JSON.stringify({type: 'activity'}));
    },
    close() {
      closedByUs = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'left_page');
      }
    },
  };
}

// ── 檔案欄 ─────────────────────────────────────────────────────────

export type FileEntry = {
  name: string;
  is_dir: boolean;
  size: number;
  /** 秒 */
  mtime: number;
  mode: number;
  /** `drwxr-xr-x`,跟 `ls -l` 第一欄同一套(後端算的) */
  access: string;
  /** 擁有者名字;拿不到名字(SFTP v4+ 沒有 longname)就是 uid 數字 */
  owner: string;
  /** 群組名字;同上,拿不到就是 gid 數字 */
  group: string;
};

export type DirListing = {path: string; home: string; entries: FileEntry[]};

/** 上傳撞名:後端 409 帶的清單。呼叫端問過使用者再帶 `overwrite: true` 送一次。 */
export class UploadConflictError extends Error {
  exists: string[];
  constructor(exists: string[]) {
    super('已有同名檔案');
    this.exists = exists;
  }
}

export type FilesApi = {
  list: (path: string) => Promise<DirListing>;
  upload: (
    dirPath: string,
    files: File[],
    options?: {overwrite?: boolean; onProgress?: (fraction: number) => void},
  ) => Promise<{path: string; uploaded: Array<{name: string; size: number}>}>;
  /** 下載走 `<a href>`(帶下載用的 cookie),不走 axios —— 大檔不該先整個讀進記憶體再組 blob。 */
  downloadUrl: (path: string) => string;
  remove: (path: string) => Promise<void>;
};

/** 綁好 session_id 的四支檔案 API。session 一斷(409)整組就失效,面板要重新拿一組。 */
export function createFilesApi(sessionId: string): FilesApi {
  const base = import.meta.env.VITE_API_BASE || '';
  return {
    async list(path) {
      const res = await api.get<DirListing>('/api/terminal/files', {
        params: {session_id: sessionId, path},
      });
      return res.data;
    },
    async upload(dirPath, files, options = {}) {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      try {
        const res = await api.post('/api/terminal/files/upload', form, {
          params: {session_id: sessionId, path: dirPath, overwrite: options.overwrite ? 1 : 0},
          onUploadProgress: (e) => {
            if (options.onProgress && e.total) options.onProgress(e.loaded / e.total);
          },
        });
        return res.data;
      } catch (err) {
        const response = (
          err as {response?: {status?: number; data?: {detail?: {exists?: string[]}}}}
        ).response;
        if (response?.status === 409 && response.data?.detail?.exists) {
          throw new UploadConflictError(response.data.detail.exists);
        }
        throw err;
      }
    },
    downloadUrl(path) {
      const q = new URLSearchParams({session_id: sessionId, path});
      return `${base}/api/terminal/files/download?${q.toString()}`;
    },
    async remove(path) {
      await api.delete('/api/terminal/files', {params: {session_id: sessionId, path}});
    },
  };
}
