/**
 * 把使用者挑的圖片變成一張**小的、方的** data URI,給頭像用。
 *
 * 為什麼一定要在前端縮:頭像存進資料庫,而且會被
 * `/api/shareable-users` **發給所有使用者** —— 一份 4MB 的手機相片乘上使用者人數,
 * 每個人每次開對話都要下載一次。縮到 256px 之後一張大約 20~40KB。
 *
 * ⚠️ 後端另有一道長度上限(`users.MAX_AVATAR_CHARS`)。這裡縮圖是為了「好用」,
 * 那一道是為了「擋人」—— 前端這道任何人直接打 API 就繞過去了,兩道都要有。
 *
 * ⚠️ **裁切框由使用者決定**(按 Change photo / Add photo 可以調整照片大小跟位置),
 * 人臉不在正中間的照片才不會被切掉半邊。置中裁切是**預設值**(`defaultCrop`)。
 *
 * 這個檔案分成兩半,分法是刻意的:
 *  - **純數學**(`clampCrop` / `cropRect`)—— 不碰 DOM,有測試
 *    (`lib/__tests__/avatarImage.test.ts`);
 *  - **畫布**(`loadAvatarSource` / `drawAvatarCrop` / `avatarCropToDataUri`)——
 *    預覽與輸出**共用同一支繪圖函式**,不然「看到的」跟「存下去的」會慢慢漂開。
 */

import {clampElastic} from './rubberband';

/** 縮到幾 px。頭像最大顯示是 32px,256 已經足夠應付高解析螢幕與之後放大。 */
export const AVATAR_PX = 256;

/** 壓縮品質。0.82 在 256px 上看不出差別,但檔案大小大約是 0.95 的一半。 */
const QUALITY = 0.82;

/**
 * 放大倍率的範圍。
 *
 * **1 = 取得到的最大正方形**(短邊撐滿),也就是預設的置中裁切;
 * 4 是把短邊的四分之一放到 256px —— 再往上就是在放大馬賽克了。
 * ⚠️ **下限不能小於 1**:小於 1 的正方形會超出照片邊界,空出來的地方
 * 會是鋪底的白色,看起來像是照片沒貼好。
 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/**
 * 挑圖失敗。
 *
 * ⚠️ **訊息一律英文**:它會直接進 `AccountSettingsDialog` 的 toast,
 * 而那個對話框照 `frontend/.claude/CLAUDE.md` 是英文的 ——
 * 「內容用繁中」的例外不含這裡。
 */
export class AvatarImageError extends Error {}

/** 解好、可以畫進 canvas 的一張圖。 */
export type AvatarSource = {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** ⚠️ 換掉或收工時要呼叫 —— `ImageBitmap` 不收的話大圖會一直留在記憶體裡。 */
  close: () => void;
};

/**
 * 裁切框:**來源影像座標系**上的一個正方形。
 *
 * 只記中心與倍率,不記左上角 —— 拖曳與縮放都是繞著中心在動的,
 * 記左上角的話每次改倍率都要自己再換算一次,而那正是會算錯的地方。
 */
export type AvatarCrop = {
  /** 放大倍率,見 `MIN_ZOOM` / `MAX_ZOOM`。 */
  zoom: number;
  /** 正方形的中心(來源影像的像素座標)。 */
  cx: number;
  cy: number;
};

type ImageSize = {width: number; height: number};

/** 置中、不放大(預設的裁切框)。 */
export function defaultCrop(size: ImageSize): AvatarCrop {
  return {zoom: MIN_ZOOM, cx: size.width / 2, cy: size.height / 2};
}

/**
 * 把一個裁切框收進合法範圍:倍率夾在 1~4,中心夾到**整個正方形都還在照片裡**。
 *
 * ⚠️ 夾中心要用「半個邊長」當邊界,不是照片的邊界本身 —— 用後者的話拖到角落時
 * 正方形會有一半跑到照片外,那一塊在輸出裡是鋪底的白色。
 *
 * 壞值(NaN / undefined)一律退回置中:這支的輸入來自拖曳與拉桿,
 * 中間任何一步算出 NaN,不擋的話會一路傳到 `drawImage` 然後畫出一片空白。
 */
export function clampCrop(size: ImageSize, crop: AvatarCrop): AvatarCrop {
  const zoom = Number.isFinite(crop.zoom)
    ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, crop.zoom))
    : MIN_ZOOM;
  const half = Math.min(size.width, size.height) / zoom / 2;
  const fix = (value: number, limit: number) =>
    Number.isFinite(value) ? Math.min(limit - half, Math.max(half, value)) : limit / 2;
  return {zoom, cx: fix(crop.cx, size.width), cy: fix(crop.cy, size.height)};
}

/**
 * 拖曳中的超界量(**來源影像像素**):裁切框中心比合法範圍多走了多少。
 *
 * ⚠️ **只給預覽用**(拖到邊界硬停看起來像卡住,所以預覽讓它帶阻力地超出一點)。
 * 交給呼叫端、存進資料庫的永遠是 `clampCrop` 夾好的那一個 —— 超界那一段只畫在
 * 圓形預覽上(露出的是鋪底的白色,也就是「再過去就沒有照片了」),放手就收回 0。
 */
export type CropOvershoot = {dx: number; dy: number};

export const NO_OVERSHOOT: CropOvershoot = {dx: 0, dy: 0};

/**
 * 一個(可能超界的)裁切框 → 橡皮筋之後的超界量。`limit` 是最多能超多少(來源像素),
 * 阻力曲線見 `lib/rubberband.ts`。壞值一律當沒有超界。
 */
export function cropOvershoot(size: ImageSize, crop: AvatarCrop, limit: number): CropOvershoot {
  const safe = clampCrop(size, crop);
  const half = Math.min(size.width, size.height) / safe.zoom / 2;
  const axis = (raw: number, clamped: number, extent: number) =>
    Number.isFinite(raw) ? clampElastic(raw, half, extent - half, limit) - clamped : 0;
  return {dx: axis(crop.cx, safe.cx, size.width), dy: axis(crop.cy, safe.cy, size.height)};
}

/** 裁切框換算成 `drawImage` 要的來源矩形(左上角 + 邊長)。 */
export function cropRect(
  size: ImageSize,
  crop: AvatarCrop,
): {x: number; y: number; side: number} {
  const safe = clampCrop(size, crop);
  const side = Math.min(size.width, size.height) / safe.zoom;
  return {x: safe.cx - side / 2, y: safe.cy - side / 2, side};
}

/**
 * 工作副本的短邊上限。
 *
 * `AVATAR_PX * MAX_ZOOM` = 1024 —— 這是「即使放到最大也不會把畫素放大」需要的最小尺寸
 * (放到 4 倍時裁切框是短邊的四分之一,1024 / 4 = 256 = 輸出尺寸)。
 * 再大就只是在每一幀多搬像素。
 */
const WORKING_MAX = AVATAR_PX * MAX_ZOOM;

/**
 * 大圖先縮成一張**工作副本**再拿去用(裁切、預覽、輸出都用它)。
 *
 * ⚠️ 這是**效能**,不是畫質(畫質那一半是 `drawAvatarCrop` 的
 * `imageSmoothingQuality`)。預覽是**每一次 pointermove 都重畫一次**的 ——
 * 直接抱著一張 4000px 的手機相片,每一幀都要從它身上高品質縮到 128px,
 * 那是很貴的。先一次縮到短邊約 1024,之後每一幀的工作量就固定而且很小。
 * 順便也把記憶體收掉:一張 4000×3000 的 bitmap 是 48MB。
 * ⚠️ 一次只縮一半,每一步都在同一個數量級內,縮出來跟一次到位一樣乾淨。
 * ⚠️ 縮完要把原圖收掉 —— 後面不會再用到它。
 */
function toWorkingCopy(
  image: CanvasImageSource,
  width: number,
  height: number,
): {image: CanvasImageSource; width: number; height: number} | null {
  let w = width;
  let h = height;
  let current = image;
  let made = false;
  while (Math.min(w, h) / 2 >= WORKING_MAX) {
    const nw = Math.round(w / 2);
    const nh = Math.round(h / 2);
    const canvas = document.createElement('canvas');
    canvas.width = nw;
    canvas.height = nh;
    const ctx = canvas.getContext('2d');
    // 拿不到 2D context 就維持原圖 —— 只是慢一點、糊一點,不該讓整個流程失敗
    if (!ctx) return made ? {image: current, width: w, height: h} : null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, w, h, 0, 0, nw, nh);
    current = canvas;
    w = nw;
    h = nh;
    made = true;
  }
  return made ? {image: current, width: w, height: h} : null;
}

/**
 * 把裁切框畫進一個**正方形**的 2D context。預覽與輸出共用這一支。
 *
 * ⚠️ 先鋪白底再畫。JPEG **沒有透明色** —— 來源是去背的 PNG 時,
 * 透明的部分會變成黑色(canvas 的預設是透明,轉 JPEG 時當成 0,0,0)。
 * 鋪白底之後去背的圖看起來就像放在白紙上,而不是黑色剪影。
 *
 * ⚠️ **`imageSmoothingQuality = 'high'` 這一行不能拿掉**。
 * 預設是 `'low'`,而 `'low'` 在大幅縮小時幾乎是點取樣:細棋盤格縮小之後是
 * 整片雜訊,`'high'` 才是該有的均勻中灰。照片上的症狀就是邊緣毛毛的、細節變雜點。
 *
 * 不需要再自己「分次對半縮」(mipmap 那一套):Chrome 的 `'high'`
 * 自己就會做多階取樣,再加一層量不出差別。
 */
export function drawAvatarCrop(
  ctx: CanvasRenderingContext2D,
  source: AvatarSource,
  crop: AvatarCrop,
  size: number,
  /**
   * 拖曳中的超界量(見 `CropOvershoot`)—— **只有預覽會給**,輸出那條路(`avatarCropToDataUri`)不給。
   * 來源矩形超出照片的那一段 `drawImage` 會自己裁掉(規格:來源矩形先裁到影像內,目的矩形等比例跟著裁),
   * 露出底下的白底。
   */
  overshoot: CropOvershoot = NO_OVERSHOOT,
): void {
  const r = cropRect(source, crop);
  r.x += overshoot.dx;
  r.y += overshoot.dy;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source.image, r.x, r.y, r.side, r.side, 0, 0, size, size);
}

/** 裁切框 → 256px 的 JPEG data URI。這就是存進資料庫的那個字串。 */
export function avatarCropToDataUri(source: AvatarSource, crop: AvatarCrop): string {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AvatarImageError('This browser cannot process images.');
  drawAvatarCrop(ctx, source, crop, AVATAR_PX);
  return canvas.toDataURL('image/jpeg', QUALITY);
}

/**
 * 檔案 → 可以畫進 canvas 的東西。
 *
 * 優先用 `createImageBitmap`(解碼在背景執行緒,大圖不會卡住畫面);
 * 不支援就退回 `<img>` + object URL。
 */
export async function loadAvatarSource(file: File): Promise<AvatarSource> {
  if (!file.type.startsWith('image/')) {
    throw new AvatarImageError('Please choose an image file.');
  }
  try {
    const bitmap = await createImageBitmap(file);
    const working = toWorkingCopy(bitmap, bitmap.width, bitmap.height);
    if (working) {
      // 已經有副本了,原圖立刻收掉
      bitmap.close();
      return {...working, close: () => {}};
    }
    return {
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    // 有些格式(舊瀏覽器的 HEIC/AVIF)這條會失敗,退回下面那條
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new AvatarImageError('That image file could not be read.'));
      el.src = url;
    });
    const working = toWorkingCopy(img, img.naturalWidth, img.naturalHeight);
    if (working) {
      // 副本做好了就可以放掉 object URL(`img` 的點陣資料已經被畫進畫布)
      URL.revokeObjectURL(url);
      return {...working, close: () => {}};
    }
    return {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      // 解碼完就可以放掉;`img` 已經持有解好的點陣資料
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    // ⚠️ 失敗這條要**自己收 URL**:上面那個 close 只有成功時才回得出去
    URL.revokeObjectURL(url);
    throw err;
  }
}
