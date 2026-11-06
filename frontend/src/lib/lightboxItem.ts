/**
 * 一份檔案 →「燈箱要怎麼顯示它」+「幾條網址」的**唯一組法**。
 *
 * 檔案區、訊息串裡的附件、便條的附件都會開同一個燈箱,而每一處要的東西一樣:
 * 用哪一種模式畫、預覽抓哪裡、下載指哪裡、Office 的文字要跟誰要。
 * 這幾條網址各自都有一個「弄錯就 404」的陷阱(uploads/ 與 files/ 是兩個目錄、
 * 預覽要帶 `?inline=1`、Office 走的是另一條路由),所以只留一份組法。
 */

import {
  isDocumentFilename,
  isImageFilename,
  isPdfFilename,
  isSheetFilename,
  isTextFilename,
} from './filekind';
import {
  fileDownloadUrl,
  filePreviewUrl,
  officePreviewTextUrl,
  officePreviewUrl,
  uploadPreviewUrl,
  uploadUrl,
} from './files';

/**
 * 燈箱的顯示模式,外加「這個看不了,只能下載」。
 *
 * `document` / `sheet`:Word / 簡報轉成 PDF 看、Excel 畫成表格。
 * 轉不了(主機沒裝轉檔程式、檔案壞了)就退回 `textUrl` 那份純文字。
 */
export type LightboxMode = 'image' | 'pdf' | 'document' | 'sheet' | 'text' | 'none';

export type LightboxItem = {
  name: string;
  mode: LightboxMode;
  /** `<img>` / PDF iframe 用(帶 `?inline=1`) */
  previewUrl: string;
  /** 下載鈕用(不帶 inline,後端回 attachment) */
  downloadUrl: string;
  /**
   * 純文字模式要 fetch 的網址;Office 走後端抽文字,其餘就是檔案本身。
   * `document` / `sheet` 轉不了時也是退回這一條;`null` = 連純文字都沒有(舊版 .doc / .ppt)
   */
  textUrl: string | null;
  /** `document` = 轉好的 PDF、`sheet` = 工作表的 JSON;其餘模式是 null */
  convertUrl: string | null;
};

/**
 * 後端抽得出純文字的(`extract.extract_text`)。舊版 `.doc` / `.ppt` 抽不出來 ——
 * 後端回的是一段寫給 AI 看的說明,不能當預覽顯示。
 */
const TEXT_FALLBACK = /\.(docx|pptx|xlsx|xlsm|xls)$/i;

function modeOf(name: string): LightboxMode {
  // ⚠️ 順序有意義:`.pdf` 也通得過 `isTextFilename` 以外的判斷,而 Office 的
  // `.docx` 在 `BINARY_EXT` 裡 —— 先問明確的幾種,剩下的才交給排除法。
  if (isImageFilename(name)) return 'image';
  if (isPdfFilename(name)) return 'pdf';
  if (isDocumentFilename(name)) return 'document';
  if (isSheetFilename(name)) return 'sheet';
  if (isTextFilename(name)) return 'text';
  return 'none';
}

/**
 * `kind` 就是後端給的那個欄位:`upload` = 使用者附上去的(uploads/),
 * `output` = 這一題產出或交付的(files/)。**兩個目錄不通用**,給錯必 404。
 */
export function lightboxItem(
  kind: 'upload' | 'output',
  sessionId: string,
  name: string,
): LightboxItem {
  const isUpload = kind === 'upload';
  const scope = isUpload ? 'uploads' : 'files';
  const mode = modeOf(name);
  const previewUrl = isUpload
    ? uploadPreviewUrl(sessionId, name)
    : filePreviewUrl(sessionId, name);
  const downloadUrl = isUpload ? uploadUrl(sessionId, name) : fileDownloadUrl(sessionId, name);

  let textUrl: string | null = null;
  let convertUrl: string | null = null;
  if (mode === 'document' || mode === 'sheet') {
    convertUrl = officePreviewUrl(scope, sessionId, name, mode === 'document' ? 'pdf' : 'sheet');
    if (TEXT_FALLBACK.test(name)) textUrl = officePreviewTextUrl(scope, sessionId, name);
  } else if (mode === 'text') {
    // 純文字直接抓檔案本身。⚠️ 走 `previewUrl`(帶 inline)而不是下載網址:
    // 後端對 attachment 一樣會給內容,但帶 inline 才是「我要看,不是要存」,
    // 而且那條路徑的 `nosniff` 與 content-type 是照預覽設的。
    textUrl = previewUrl;
  }

  return {name, mode, previewUrl, downloadUrl, textUrl, convertUrl};
}
