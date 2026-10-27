/**
 * 後端會送哪些工具、各自算什麼 —— **這份是唯一來源**。
 *
 * 工具名是後端 `agent.py` 的 `_TOOL_TARGET_FIELDS` 決定的,而前端有兩個地方
 * 要對它做判斷:小夥伴要換表情、匯出要算「參考來源」。兩邊各抄一份小表的話,
 * 後端多送一種工具時就會變成「只有一邊認得」—— 所以收成一份。
 *
 * ⚠️ 後端加新工具時**只改這個檔案**:
 *   1. 在 `TOOL_KINDS` 裡給它一個類別(讀 / 找 / 跑);
 *   2. 如果它是「讀程式碼」的手段,`isReadTool` 自然就會算進參考來源。
 */

/** 工具的粗略分類。小夥伴的圖只有這幾種,使用者要的也只是「它在幹嘛」。 */
export type ToolKind = 'read' | 'search' | 'run';

/**
 * 工具名 → 類別。
 * ⚠️ 查不到的一律當 **read**(「在讀東西」),不要當成「沒有動作」——
 * 後端的工具集會長,認不得的新工具要看起來像在做事,不是像卡住了。
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  Bash: 'run',
  Write: 'run',
  Edit: 'run',
  MultiEdit: 'run',
  NotebookEdit: 'run',
  Task: 'run',
};

/** MCP 工具在 claude 那邊的全名前綴。畫面上不顯示它,只顯示後面那段。 */
const MCP_PREFIX = /^mcp__.+?__/;

/**
 * 執行過程上顯示的工具名。內建工具原樣;MCP 工具去掉 `mcp__<server>__` 前綴
 * (`mcp__docs__search` → `search`)—— 全名在窄螢幕上會把那一列擠爆,而 server 名稱對使用者沒有資訊量。
 */
export function toolLabel(tool: string): string {
  return tool.replace(MCP_PREFIX, '');
}

export function toolKind(tool: string): ToolKind {
  return TOOL_KINDS[tool] ?? 'read';
}

/**
 * 這個工具算不算「讀了程式碼」——匯出的 Sources 那一節用。
 *
 * ⚠️ `Bash` 要算:白名單裡的 `Bash(cat:*)` / `Bash(grep:*)` 也是讀檔的手段。
 * 反過來 `Write` / `WebSearch` 不算 —— 那是產出與查網頁,不是這個回答的依據,
 * 列進來只會稀釋掉真正的來源。
 */
const READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
]);

export function isReadTool(tool: string): boolean {
  return READ_TOOLS.has(tool);
}

