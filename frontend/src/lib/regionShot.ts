/**
 * 存筆記的截圖:**直接抓畫面 + 框選範圍**(框選那一層是 `components/RegionPicker.tsx`)。
 *
 * 退路 `answerShot.ts` 是在網頁的主執行緒上把整則回答的 DOM 重畫成圖,回答長就卡好幾秒、整頁不能動,
 * 也不能自己選範圍。這裡用瀏覽器的分享分頁
 * (`getDisplayMedia`)抓**真的像素**:一格、馬上停 —— Chrome 每次都會問一次「允許」(瀏覽器規定,記不住)。
 *
 * 不支援(手機、非 https 的網址、Firefox / Safari 沒有「這個分頁」)時呼叫端退回 `answerShot.ts`。
 */

/** 框(畫面上的 CSS px,相對於那張凍住的圖左上角) */
export type Rect = {x: number; y: number; w: number; h: number};

/** 這麼小(含)以下的框當作沒選(點一下沒拖) */
export const MIN_RECT_PX = 8;

/** 寬或高沒超過 `MIN_RECT_PX` 就不算選了 */
export function isTooSmall(r: Rect): boolean {
  return r.w <= MIN_RECT_PX || r.h <= MIN_RECT_PX;
}

/**
 * 截圖本身失敗(不是存檔失敗)。名稱跟 `answerShot.ts` 的 `ScreenshotError` 一樣:`saveErrorMessage` 看名稱
 * 報「Could not take the screenshot」。不直接 import 那個類別 —— 那一包連著 modern-screenshot,只在退路才載。
 */
function screenshotFailed(): Error {
  const err = new Error('screenshot failed');
  err.name = 'ScreenshotError';
  return err;
}

/**
 * 這個瀏覽器能不能「只抓這個分頁」。
 * - `isSecureContext`:getDisplayMedia 只在 https / localhost 才有(直接打 http://<內網 IP>:<port> 就沒有);
 * - `userAgentData`:只有 Chromium 系(Chrome / Edge)有,它們才認 `preferCurrentTab`;Firefox / Safari 會跳出
 *   「選一個視窗或螢幕」,抓到的不見得是這一頁,框選的座標也對不上 —— 一律退回舊做法;
 * - 觸控為主的裝置(手機、平板)沒有 getDisplayMedia,或有也不好拖框。
 */
export function canGrabTab(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    'userAgentData' in navigator &&
    !window.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * `getDisplayMedia` 的選項;Chromium 才認的幾個欄位 TypeScript 的型別裡還沒有。
 * ⚠️ **解析度要自己要**:不指定的話 Chrome 給的那一格可能比畫面小很多,
 * 框出來的字是糊的。要「視窗 × 螢幕倍率」,高解析螢幕上才跟眼睛看到的一樣清楚。
 */
function tabOnly(): DisplayMediaStreamOptions {
  const dpr = window.devicePixelRatio || 1;
  return {
    video: {
      displaySurface: 'browser',
      width: {ideal: Math.round(window.innerWidth * dpr)},
      height: {ideal: Math.round(window.innerHeight * dpr)},
      frameRate: {ideal: 5},
    },
    audio: false,
    // 對話框裡只給「這個分頁」,不給選別的分頁、視窗、整個螢幕
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'exclude',
  } as DisplayMediaStreamOptions;
}

/** 「允許」那個對話框收掉之後再等這麼久才抓(不然那一格裡可能還有對話框的殘影) */
const SETTLE_MS = 150;

/**
 * 抓這個分頁現在的一格畫面。使用者按了「取消」回 null(不是錯誤:什麼都不做)。
 * 抓完**馬上停止分享**:Chrome 上方「正在分享這個分頁」那條只會閃一下。
 */
export async function grabTabFrame(): Promise<HTMLCanvasElement | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(tabOnly());
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') return null;
    throw err;
  }
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => window.setTimeout(r, SETTLE_MS));
    await nextFrame(video);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    video.srcObject = null;
    if (!canvas.width || !canvas.height) throw screenshotFailed();
    return canvas;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** 等新的一格最多等多久:畫面完全靜止時 Chrome 可能不送新格,不能讓分享列一直掛著 */
const FRAME_WAIT_MS = 1000;

/** 等影片真的畫出新的一格(有 requestVideoFrameCallback 就用它,沒有就等兩個 rAF);等不到就用手上那一格 */
function nextFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, FRAME_WAIT_MS);
    const v = video as HTMLVideoElement & {requestVideoFrameCallback?: (cb: () => void) => number};
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => resolve());
    else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * 畫面上的框 → 圖上的像素。凍住的那張圖鋪滿寬度、等比例(`RegionPicker`),所以兩軸是同一個倍率:
 * 圖的實際寬 ÷ 畫面上顯示的寬。⚠️ 不能拿視窗高度去算 —— 分享的那一下 Chrome 上方多一條「正在分享」,
 * 抓到的那格比現在的視窗矮,兩軸倍率不一樣是錯的。超出圖的部分裁掉。
 */
export function toImageRect(rect: Rect, shownWidth: number, image: {width: number; height: number}): Rect {
  const scale = image.width / shownWidth;
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  const right = Math.min(image.width, Math.round((rect.x + rect.w) * scale));
  const bottom = Math.min(image.height, Math.round((rect.y + rect.h) * scale));
  return {x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y)};
}

/** 從兩個點(按下、現在)算出框(往哪個方向拖都一樣) */
export function rectFrom(a: {x: number; y: number}, b: {x: number; y: number}): Rect {
  return {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y)};
}

/** 剛抓的那一格 → 畫在框選那一層的網址(用完要 `URL.revokeObjectURL`)。不用 data URL:整格好幾 MB,轉字串很慢 */
export function frameUrl(image: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) =>
    image.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(screenshotFailed())), 'image/png'),
  );
}

/** 裁出那一塊 → PNG */
export function cropToBlob(image: HTMLCanvasElement, r: Rect): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = r.w;
  out.height = r.h;
  out.getContext('2d')?.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return new Promise((resolve, reject) =>
    out.toBlob((blob) => (blob && blob.size ? resolve(blob) : reject(screenshotFailed())), 'image/png'),
  );
}
