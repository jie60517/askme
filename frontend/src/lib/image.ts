/**
 * 上傳前縮圖。
 *
 * 手機拍的照片動輒 4000px、好幾 MB,而模型看的是縮過的版本 —— 原尺寸傳上去
 * 只是讓使用者等,答案不會比較好。長邊壓到 1568px(模型實際會用到的解析度)。
 *
 * ⚠️ **任何一步失敗都回原檔**,不要讓「縮圖壞掉」變成「檔案傳不上去」。
 * canvas 會因為很多理由失敗(記憶體不夠、格式不支援、toBlob 回 null),
 * 那時候原檔一定還在,傳原檔就好。
 */

/** 長邊上限。模型的視覺解析度上限,再大也只是浪費上傳時間。 */
const MAX_EDGE = 1568;

/** 比這個小就不值得動 —— 重新編碼的成本比省下來的多。 */
const SKIP_UNDER_BYTES = 300 * 1024;

/** PNG 壓完還這麼大就改試 JPEG。 */
const PNG_TOO_BIG_BYTES = 1.5 * 1024 * 1024;

const JPEG_QUALITY = 0.85;

/**
 * 不動的格式:
 *   - GIF:重畫只會剩第一格,動畫整個沒了
 *   - SVG:向量,畫進 canvas 等於變成點陣圖,放大就糊
 */
const KEEP_AS_IS = ['image/gif', 'image/svg+xml'];

export async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (KEEP_AS_IS.includes(file.type)) return file;
  if (file.size < SKIP_UNDER_BYTES) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // 先試 PNG:沒有壓縮失真,螢幕截圖(這裡最常見的附件)特別吃這一點
    const png = await toBlob(canvas, 'image/png');
    if (!png) return file;
    if (png.size <= PNG_TOO_BIG_BYTES) return smaller(file, png, 'png');

    // PNG 還是太大 —— 照片類的內容 JPEG 會小非常多
    const jpeg = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (!jpeg) return smaller(file, png, 'png');
    return smaller(file, jpeg.size < png.size ? jpeg : png, jpeg.size < png.size ? 'jpg' : 'png');
  } catch {
    return file;
  }
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * 壓完比原檔大就用原檔 —— 小圖重新編碼常常會變大,
 * 那時候還硬換等於為了「有處理過」而讓使用者傳更多資料。
 */
function smaller(original: File, blob: Blob, ext: string): File {
  if (blob.size >= original.size) return original;
  const base = original.name.replace(/\.[^.]+$/, '');
  return new File([blob], `${base}.${ext}`, {type: blob.type, lastModified: Date.now()});
}
