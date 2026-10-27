/**
 * 「這個檔名是哪一類」的**單一事實來源**。
 *
 * 散在各處各寫一份(縮圖一份、燈箱一份、下載鈕一份)的話清單會悄悄分岔
 * —— 同一個 `.webp` 在縮圖那邊算圖片、在燈箱那邊不算,點下去就是一片空白。
 *
 * ⚠️ **「燈箱看得了」跟「可以讓瀏覽器直接開」是兩件事,不要合成一份名單。**
 * 這裡放寬(html 進燈箱只是被 React 轉義的原始碼),後端 `files.py` 的 `_INLINE_OK`
 * 維持保守 —— 前端與 API 同 origin,別人上傳的 html 若被**導覽**過去就能讀走
 * sessionStorage 裡的 token。放寬這一份不會動到那一份。
 */

function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  // 沒有副檔名,或整個檔名就是 `.bashrc` 那種(dot === 0)—— 兩種都當作沒有
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** 瀏覽器 `<img>` 畫得出來的。縮圖與燈箱的圖片模式都看這一份。 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg']);

/**
 * 後端抽得出文字的 Office 格式。**只有 OOXML**(2007 以後的 x 結尾)——
 * 舊的 `.doc` / `.xls` / `.ppt` 是另一套二進位格式,`extract.py` 讀不了,
 * 列進來只會讓使用者點開看到 415。
 */
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx']);

/**
 * 一定**不是**文字的副檔名。
 *
 * ⚠️ 文字用**排除法**,不是列舉。需求正是「能用記事本打開的都給我看」,
 * 而各家系統有一堆各自為政的副檔名,
 * 使用者自己還會生出 `.tmp1`、`.bak2` —— 列舉一定會漏,漏掉的下場是
 * 「這個檔沒辦法預覽」,而它明明只是一份純文字。
 *
 * 反過來多認一個二進位檔的代價很小:燈箱裡還有一道 `looksBinary()`
 * 的執行期保險,抓回來才發現是亂碼的會顯示「請下載」。
 */
const BINARY_EXT = new Set([
  // 圖片與影音
  ...IMAGE_EXT,
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.avi', '.mov', '.mkv', '.webm',
  // 文件與壓縮
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz', '.jar', '.war',
  // 可執行檔與編譯產物
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.class', '.pyc',
  // 字型與資料庫
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.db', '.sqlite', '.mdb',
]);

export function isImageFilename(name: string): boolean {
  return IMAGE_EXT.has(ext(name));
}

export function isPdfFilename(name: string): boolean {
  return ext(name) === '.pdf';
}

export function isOfficeFilename(name: string): boolean {
  return OFFICE_EXT.has(ext(name));
}

/**
 * 「記事本打得開」的。排除法,見 `BINARY_EXT` 的註解。
 *
 * 沒有副檔名的檔案(`Makefile`、`LICENSE`)算文字 —— 使用者真的會附這種。
 */
export function isTextFilename(name: string): boolean {
  return !BINARY_EXT.has(ext(name));
}

/**
 * 程式檔 → CodeBlock 的 `language`(程式檔用 IDE 樣式顯示:行號與上色)。
 * 查不到就回 null = 一般文字檔,燈箱維持 `<pre>`。
 *
 * ⚠️ 這份是**列舉**,跟上面「文字用排除法」不衝突:排除法決定「能不能看」,
 * 這份只決定「用哪種樣子看」—— 漏列的副檔名照樣看得到,只是沒有行號與上色。
 */
const CODE_EXT: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
};

export function codeLanguage(name: string): string | null {
  return CODE_EXT[ext(name)] ?? null;
}
