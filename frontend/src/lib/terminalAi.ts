/**
 * 終端機旁邊的 AI 助手:`POST /api/terminal/ask` 的 ndjson 串流。
 *
 * 為什麼不走 axios:它把回應整包讀完才給你,而這一支是**邊講邊送**的。
 * 這裡用 `fetch` + `lib/ndjson.ts` 切行,跟 `lib/runs.ts` 讀問答串流**共用同一支**。
 *
 * 事件只有三種:`delta`(一段字)、`done`、`error`。
 */
import {getToken} from './auth';
import {ndjsonLines} from './ndjson';

export type AiEvent =
  | {type: 'delta'; text: string}
  | {type: 'done'}
  | {type: 'error'; message: string};

/**
 * 問一句。`onEvent` 會被叫很多次(每一小段字一次),回傳的函式可以中途取消。
 *
 * 取消 = `AbortController.abort()`;後端那邊 `finally` 會把 claude 子行程收掉。
 */
export function askTerminalAi(
  params: {sessionId: string; question: string; context: string},
  onEvent: (event: AiEvent) => void,
): {cancel: () => void; done: Promise<void>} {
  const controller = new AbortController();
  const base = import.meta.env.VITE_API_BASE || '';

  const done = (async () => {
    let response: Response;
    try {
      response = await fetch(`${base}/api/terminal/ask`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${getToken() || ''}`},
        body: JSON.stringify({
          session_id: params.sessionId,
          question: params.question,
          context: params.context,
        }),
        signal: controller.signal,
      });
    } catch {
      onEvent({type: 'error', message: '送不出去,請檢查連線。'});
      return;
    }
    if (!response.ok || !response.body) {
      // 後端的 detail 是給人看的中文(沒有連線 409、沒設定 503、沒權限 403)
      let message = '問不到答案。';
      try {
        const data = await response.json();
        if (typeof data?.detail === 'string') message = data.detail;
      } catch {
        // 不是 JSON 就用上面那句
      }
      onEvent({type: 'error', message});
      return;
    }

    try {
      for await (const line of ndjsonLines(response.body)) {
        try {
          onEvent(JSON.parse(line) as AiEvent);
        } catch {
          // 壞掉的一行:丟掉,下一行會補上
        }
      }
    } catch {
      // 讀不下去了 —— 使用者按了停止,或連線斷了。不用再報一次錯。
      return;
    }
  })();

  return {cancel: () => controller.abort(), done};
}
