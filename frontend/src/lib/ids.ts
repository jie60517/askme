/**
 * 對話 id 在送出當下就決定,不等後端 —— 網址、側邊欄、暫存狀態從第一秒就對得起來。
 *
 * ⚠️ `crypto.randomUUID` 在**非安全內容**底下是 undefined(內網用 http 直連就是),
 * 所以備援不能隨便產字串:後端會拿這個 id 當 claude 的 session id,
 * 格式不對會被擋下來。備援一定要生出標準 v4。
 */
export function newConversationId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // v4 的兩個固定位:版本 4、variant 10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}
