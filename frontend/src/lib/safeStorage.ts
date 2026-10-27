/**
 * localStorage 的統一包裝。
 *
 * 每一次存取都要 try/catch:無痕模式、配額滿、企業政策關掉 storage 的機器上
 * 光是 `localStorage.getItem` 就會丟例外,而那不該讓整個畫面掛掉。
 * 這段 try/catch 只寫在這裡,不要在各處各抄一份 —— 抄漏一次就是一個白畫面。
 */

/**
 * 兩種 storage 共用同一份 try/catch。
 *
 * ⚠️ **不要為了 sessionStorage 再抄一份三件組** —— 那正是這個檔案開頭那段
 * 在講的事(抄漏一次就是一個白畫面)。差別只有「用哪個 storage」,
 * 所以把它當參數傳,不要當成兩套東西。
 *
 * 取用的時機也要延後到呼叫當下:`window.sessionStorage` 在某些環境
 * (企業政策關掉 storage)光是**存取那個屬性**就會丟例外,
 * 所以連取得 storage 本身都要包在 try 裡。
 */
type StorageKind = 'local' | 'session';

function withStorage<T>(kind: StorageKind, work: (s: Storage) => T, fallback: T): T {
  try {
    return work(kind === 'local' ? localStorage : sessionStorage);
  } catch {
    // 無痕模式、配額滿、企業政策關掉 storage —— 都不該讓整個畫面掛掉
    return fallback;
  }
}

export function readString(key: string): string | null {
  return withStorage('local', (s) => s.getItem(key), null);
}

export function writeString(key: string, value: string) {
  withStorage('local', (s) => s.setItem(key, value), undefined);
}

export function removeKey(key: string) {
  withStorage('local', (s) => s.removeItem(key), undefined);
}

/*
 * ── sessionStorage 那一半 ─────────────────────────────────────────────
 *
 * 登入 token 存 sessionStorage(「關掉瀏覽器就要重新登入」,見 `lib/auth.ts`)。
 */

export function readSessionString(key: string): string | null {
  return withStorage('session', (s) => s.getItem(key), null);
}

export function writeSessionString(key: string, value: string) {
  withStorage('session', (s) => s.setItem(key, value), undefined);
}

export function removeSessionKey(key: string) {
  withStorage('session', (s) => s.removeItem(key), undefined);
}

/** `"1"` / `"0"` 這種旗標。 */
export function readFlag(key: string): boolean {
  return readString(key) === '1';
}

export function writeFlag(key: string, value: boolean) {
  writeString(key, value ? '1' : '0');
}

/**
 * 存進去的 JSON。
 *
 * 驗證交給呼叫端的 `accept` —— 存的東西長什麼樣只有它知道,
 * 而「舊版本存的格式」與「被手動改壞的值」都必須當成沒有,不能直接信。
 */
export function readJson<T>(key: string, accept: (value: unknown) => T | null): T | null {
  const raw = readString(key);
  if (!raw) return null;
  try {
    return accept(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    writeString(key, JSON.stringify(value));
  } catch {
    // 轉不成 JSON(循環參照)也不該炸掉呼叫端
  }
}
