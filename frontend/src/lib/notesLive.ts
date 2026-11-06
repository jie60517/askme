/**
 * 對話頁的即時推送線(@ 便條已讀)。
 *
 * 開著一組對話就連著 `/api/conversations/{id}/live`:有人看過便條、或有人寫了新便條,
 * 伺服器推一則 `notes`,這裡就叫 `onChange` —— 呼叫端拿它去重抓便條。推的只是「變了」,
 * 資料一律走 `GET /notes`(權限、顯示名稱、已讀時間只有那一份)。
 *
 * ⚠️ **連上(`ready`)也算一次 `onChange`。** 斷線那段時間錯過的推送靠這一下補回來 ——
 * 少了它,筆電睡一覺醒來,睡著時同事看過的那幾個頭像永遠不會出現(直到下一個人動作)。
 *
 * 斷線就重連,間隔一次比一次長(伺服器重啟時幾十個分頁不要同一秒擠回來)。
 * 只有「重連也沒用」的幾種不重連:沒登入 / 登入失效、來源不符、看不到這組對話。
 */
import {getToken} from './auth';
import {apiWsUrl} from './terminalApi';

/** 第 n 次重連前等多久;超過就一直用最後一格。 */
export const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * 重連也沒用的關閉碼:4401 沒登入或登入失效、4403 來源不符、4404 看不到這組對話。
 * 跟後端 `terminal.CLOSE_*` 與 `routers/notes.CLOSE_NOT_FOUND` 同一組數字。
 */
const FINAL_CODES = new Set([4401, 4403, 4404]);

type Deps = {
  WebSocket: typeof WebSocket;
  url: (path: string) => string;
  token: () => string | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

const defaultDeps = (): Deps => ({
  WebSocket,
  url: (path) => apiWsUrl(path),
  token: getToken,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
});

/** 開始盯這組對話。回傳的函式把線收掉(換對話、離開頁面時呼叫)。 */
export function watchConversationNotes(
  conversationId: string,
  onChange: () => void,
  deps: Deps = defaultDeps(),
): () => void {
  let ws: WebSocket | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    timer = null;
    const sock = new deps.WebSocket(deps.url(`/api/conversations/${conversationId}/live`));
    ws = sock;
    sock.addEventListener('open', () => {
      sock.send(JSON.stringify({type: 'auth', token: deps.token() || ''}));
    });
    sock.addEventListener('message', (e: MessageEvent) => {
      let type: unknown;
      try {
        type = (JSON.parse(String(e.data)) as {type?: unknown}).type;
      } catch {
        return;
      }
      if (type === 'ready') {
        attempt = 0;
        onChange();
      } else if (type === 'notes') {
        onChange();
      }
      // ping:只是讓代理不要把這條安靜的線當死掉的切掉,不用理
    });
    sock.addEventListener('close', (e: CloseEvent) => {
      if (ws === sock) ws = null;
      if (stopped || FINAL_CODES.has(e.code)) return;
      timer = deps.setTimeout(connect, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
      attempt += 1;
    });
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== null) deps.clearTimeout(timer);
    ws?.close(1000);
    ws = null;
  };
}
