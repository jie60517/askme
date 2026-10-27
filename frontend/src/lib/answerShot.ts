/**
 * 把畫面上的一塊(一則回答)轉成 PNG(存到筆記的「截圖」)。
 *
 * 用 `modern-screenshot`(MIT、沒有依賴):它把那塊 DOM 連同算好的樣式複製進一張 SVG `foreignObject`
 * 再畫到 canvas —— 所以是「照畫面上的樣子」,深色佈景截出來就是深色、圖表(recharts 的 SVG)也照樣在。
 *
 * ⚠️ 背景色要自己給:回答泡泡是 ghost(透明),截出來的 PNG 會是透明底 —— 在筆記頁的另一種佈景裡
 * 字就看不見了。往上找第一個不透明的祖先,用它的底色。
 */
import {domToBlob} from 'modern-screenshot';

function backdropOf(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
  }
  return getComputedStyle(document.body).backgroundColor || '#ffffff';
}

/** 四周留白(px):沒有的話字貼著圖的邊,放進筆記加了外框之後很擠 */
const PAD = 16;

/** 截一塊。解析度最多兩倍(高解析螢幕上字才不會糊;再高只是檔案變大) */
export async function captureElement(el: HTMLElement): Promise<Blob> {
  const blob = await domToBlob(el, {
    type: 'image/png',
    scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    backgroundColor: backdropOf(el),
    // 留白加在複製出來的那一份上;`content-box` 讓內容維持原本的寬度,不會因為多了 padding 而重新換行
    width: el.offsetWidth + PAD * 2,
    height: el.offsetHeight + PAD * 2,
    style: {padding: `${PAD}px`, boxSizing: 'content-box'},
  });
  // ⚠️ 分頁在背景(看不見)的時候 canvas 畫不出東西,拿到的是 0 位元組 —— 送上去只會被後端當成「不是圖片」。
  // 在這裡就擋下來,讓呼叫端報「截圖失敗」
  if (!blob || blob.size === 0) throw new ScreenshotError();
  return blob;
}

/** 截圖本身失敗(不是存檔失敗):呼叫端用它換一句比較準的話 */
export class ScreenshotError extends Error {
  constructor() {
    super('screenshot failed');
    this.name = 'ScreenshotError';
  }
}
