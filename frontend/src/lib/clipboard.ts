/**
 * 複製到剪貼簿。
 *
 * ⚠️ **`navigator.clipboard` 在非安全內容裡是 undefined。**
 * 部署在內網用 http 直連(沒有 https)時就是這種情況。少了備援的話,
 * 開發機上(localhost 算安全內容)一切正常,上線之後「複製」全站失效。
 * `crypto.randomUUID` 是同一件事(見 `lib/ids.ts`)。
 *
 * 備援用的 `document.execCommand('copy')` 雖然被標為 deprecated,
 * 但它是非安全內容裡唯一還能用的一條路,瀏覽器短期內不會拿掉。
 */

/**
 * 這個分頁最後一次**自己**複製出去的文字。
 *
 * 讀剪貼簿(`readText`)比寫更嚴:非安全內容裡整個 `navigator.clipboard` 不存在,
 * 有 https 的時候也要使用者按下「允許」才讀得到,而且**沒有** `execCommand` 那種備援
 * (`execCommand('paste')` 所有瀏覽器都擋)。終端機的「選取即複製 → 右鍵貼上」
 * (PuTTY 的用法)幾乎都是貼自己剛剛選的那一段,所以留一份在這裡當備援。
 */
let lastCopied = '';

/** 把文字放進剪貼簿。回傳有沒有成功 —— 呼叫端要據此決定講什麼。 */
export async function copyText(text: string): Promise<boolean> {
  lastCopied = text;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 使用者拒絕授權、或分頁沒有焦點 —— 掉到下面那條再試一次
  }
  return legacyCopy(text);
}

/**
 * 讀剪貼簿。讀不到(非安全內容、沒授權)就回這個分頁自己複製的最後一段;
 * 兩個都沒有就回空字串 —— 呼叫端拿到空字串就什麼都別做。
 */
export async function readClipboardText(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text) return text;
    }
  } catch {
    // 沒授權 / 沒焦點:退回自己那一份
  }
  return lastCopied;
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  // 要留在版面裡才選得到(display:none 的內容選不起來),
  // 所以是移到畫面外而不是隱藏。readOnly 是為了手機不要跳出鍵盤。
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.insetInlineStart = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    // iOS Safari 的 select() 對 readonly 的 textarea 不一定選得起來,
    // clipboard.js 也是 select() 之後再補這一行。桌機上多做一次無害。
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
