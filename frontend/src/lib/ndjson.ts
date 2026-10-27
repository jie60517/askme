/**
 * ndjson 串流:把 `fetch` 的 body 切成一行一行。
 *
 * 這個檔案的存在理由是**只有一份切行邏輯**:`lib/runs.ts`(問答)與
 * `lib/terminalAi.ts`(終端機旁的 AI)共用 `getReader` + `TextDecoder` +
 * 「最後一段可能是半行,留到下一輪」—— 那個半行的處理
 * 正是這種讀法最容易寫錯的地方(少了它,長回答會在任意位置爆出壞掉的 JSON)。
 *
 * 只負責**切行**,不負責解析,也不決定出錯要怎麼辦:
 *   - 解析交給呼叫端(兩邊的事件型別不一樣)。
 *   - `reader.read()` 丟出來的錯就往外丟,兩邊的處置本來就不同 ——
 *     問答那邊要在 `finally` 裡把 pending 標成結束,終端機那邊按停止是預期中的事、
 *     安靜收掉就好。共用「怎麼處理錯誤」只會逼兩邊之一說謊。
 *
 * 空白行直接跳過(ndjson 允許),吐出來的每一行都已經 `trim()` 過。
 */
export async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    // 最後一段可能只收到一半,留到下一輪
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (text) yield text;
    }
  }
}
