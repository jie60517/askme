/**
 * 從筆記「回到上次對話」跳到那一題:跳好之前不顯示、跳好之後不能再震一下或被拉走,空白時間要短。
 *
 * 訊息區是設計系統的「黏底」捲動(`@astryxdesign/core` 的 `useChatStreamScroll`,查過 dist):
 *   - 鎖住時內容一長高(答案裡的圖是 lazy 載入的)就用彈簧把畫面拉回最底。
 *   - 只有「往上捲、而且跟上一個捲動事件之間內容高度沒變」才當成使用者往上捲、解除;高度在變的那幾下當成版面變動。
 *   - 捲動結束(scrollend)時離底部 ≤ 10px 又會鎖回去。
 * 所以要停在那一題、之後長高也不被拉走,要顧四件事:
 *   1. 先跳到那一題再往下 1px、等那個捲動事件(它記下「現在的高度」),再往上捲回 1px —— 最後一下一定是往上,高度沒變它就會解除;
 *      自己也量一次兩個事件之間的高度,有變(剛好在長高)就重來。(不能先往上推 1px 再跳:那一題在下面時那一跳是往下,解不開。)
 *   2. 那一題下面不夠一整頁時(最後幾題、圖還沒載入),跳過去會停在離底部 10px 內、被鎖回去 → 先在訊息串底部墊一段空間。
 *   3. 跳好之後,上面幾題的圖才長出來會把那一題往下推(這個捲動區沒有瀏覽器的捲動錨定)→ 用 ResizeObserver 在畫面畫出來之前
 *      把它捲回原位(使用者看不到那一下);使用者自己動了(滾輪、觸控、點、按鍵)或過了 KEEP_MAX_MS 才放手,這時才收掉墊的空間。
 *   4. 跳好當場就顯示,不等任何 render。(「等高度連續穩定才跳」也解得開,但要空白 0.3~3 秒。)
 */

/** 等一個捲動事件最多等多久(沒捲動就不會有事件) */
const SCROLL_WAIT_MS = 120;
/** 黏底沒解開時最多重試幾次(再不行就照樣顯示,不讓訊息區一直藏著) */
const MAX_TRIES = 8;
/** 設計系統鎖回去的距離(`useChatStreamScroll` 的 lockThreshold 預設 10),墊的時候多留 1px */
const LOCK_THRESHOLD = 10;
/** 跳好之後最多幫忙把那一題釘在原位多久(使用者沒動的話);lazy 的圖通常 2 秒內長完 */
const KEEP_MAX_MS = 10_000;

/** 這個元素所在的捲動區(往上找第一個 overflow-y 是 auto / scroll 的) */
export function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  let box = el?.parentElement ?? null;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  return box;
}

/** 等這個捲動區的下一個捲動事件;等不到(沒捲動)就逾時。回傳取消 */
function nextScroll(box: HTMLElement, then: (fired: boolean) => void): () => void {
  let done = false;
  const finish = (fired: boolean, call = true) => {
    if (done) return;
    done = true;
    box.removeEventListener('scroll', onScroll);
    window.clearTimeout(timer);
    if (call) then(fired);
  };
  const onScroll = () => finish(true);
  box.addEventListener('scroll', onScroll, {passive: true});
  const timer = window.setTimeout(() => finish(false), SCROLL_WAIT_MS);
  return () => finish(false, false);
}

/** 內容尺寸(用來比「兩個捲動事件之間有沒有長高」,跟設計系統比的是同兩個值) */
const sizeOf = (box: HTMLElement) => `${box.scrollHeight}x${box.offsetHeight}`;

/**
 * 在訊息串底部暫時墊一段空間,讓 target 捲得到最上面、而且離底部超過鎖回去的距離。回傳收掉的函式(不用墊也回一個空的)。
 */
function addRoom(list: HTMLElement | null, scroller: HTMLElement, target: HTMLElement): () => void {
  if (!list) return () => {};
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - margin;
  const need = Math.ceil(top + scroller.clientHeight + LOCK_THRESHOLD + 1 - scroller.scrollHeight);
  if (need <= 0) return () => {};
  const base = parseFloat(getComputedStyle(list).paddingBottom) || 0;
  list.style.setProperty('padding-bottom', `${base + need}px`);
  return () => list.style.removeProperty('padding-bottom');
}

/**
 * 把 target 釘在現在的位置:內容長高把它推走時,在畫出來之前捲回來。使用者自己動了、或過了 KEEP_MAX_MS 就放手(也呼叫 onRelease)。
 * 回傳放手的函式。
 */
function keepInPlace(scroller: HTMLElement, target: HTMLElement, watch: HTMLElement, onRelease: () => void): () => void {
  const top = target.getBoundingClientRect().top;
  const pin = () => {
    const drift = target.getBoundingClientRect().top - top;
    if (Math.abs(drift) >= 1) scroller.scrollTop += drift;
  };
  // 兩種時機都在畫面畫出來之前,使用者看不到被推走的那一格:
  //   - MutationObserver:React 改完 DOM(圖表長出來)當下就跑,比下一格的 ResizeObserver 早 —— 只用 ResizeObserver 時
  //     會有一格停在被推走的位置;
  //   - ResizeObserver:不是改 DOM 造成的長高(圖片載入完成)。
  const mo = new MutationObserver(pin);
  mo.observe(watch, {subtree: true, childList: true, attributes: true, characterData: true});
  const ro = new ResizeObserver(pin);
  // 看每一題(長高的是裡面某一題;訊息串本身可能被撐成固定高度、尺寸不變,只看它的話要好幾格才追上)
  for (const el of [watch, ...Array.from(watch.children)]) ro.observe(el);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    ro.disconnect();
    mo.disconnect();
    window.clearTimeout(timer);
    scroller.removeEventListener('wheel', release);
    scroller.removeEventListener('touchstart', release);
    scroller.removeEventListener('pointerdown', release);
    window.removeEventListener('keydown', release, true);
    onRelease();
  };
  scroller.addEventListener('wheel', release, {passive: true});
  scroller.addEventListener('touchstart', release, {passive: true});
  scroller.addEventListener('pointerdown', release);
  window.addEventListener('keydown', release, true);
  const timer = window.setTimeout(release, KEEP_MAX_MS);
  return release;
}

/**
 * 跳到 target、解除黏底,好了(或放棄)呼叫 onShown —— 這時才顯示。回傳取消(還沒跳好時取消:墊的空間收掉、不呼叫 onShown)。
 * 跳好之後「把它釘在原位」那一段活得比這一次跳轉久(呼叫端跳完就清 state,這裡的取消會先跑),放手的函式交給 onKeep,
 * 由呼叫端在換對話 / 離開時呼叫。list = 訊息串(墊空間、看它長高);沒有就不墊、看捲動區第一層。
 */
export function jumpAndUnlock(
  target: HTMLElement,
  list: HTMLElement | null,
  onKeep: (release: () => void) => void,
  onShown: () => void,
): () => void {
  const scroller = scrollerOf(target);
  if (!scroller) {
    onShown();
    return () => {};
  }
  let cancel = () => {};
  let tries = 0;
  let removeRoom: (() => void) | null = null;
  const done = () => {
    const room = removeRoom ?? (() => {});
    removeRoom = null;
    const watch = list ?? (scroller.firstElementChild as HTMLElement | null) ?? scroller;
    onKeep(keepInPlace(scroller, target, watch, room));
    onShown();
  };
  const attempt = () => {
    removeRoom ??= addRoom(list, scroller, target);
    const from = scroller.scrollTop;
    target.scrollIntoView({block: 'start'});
    scroller.scrollTop += 1;
    const stepUp = () => {
      const before = sizeOf(scroller);
      const at = scroller.scrollTop;
      scroller.scrollTop = at - 1;
      // 往上捲不動 = 已經在最上面,捲動區沒有可以捲的,不會被拉走
      if (scroller.scrollTop === at) {
        done();
        return;
      }
      cancel = nextScroll(scroller, (moved) => {
        if (!moved || sizeOf(scroller) === before || ++tries >= MAX_TRIES) done();
        else attempt();
      });
    };
    // 沒捲動(本來就在那裡)就不會有事件,不用等
    if (scroller.scrollTop === from) stepUp();
    else cancel = nextScroll(scroller, stepUp);
  };
  // 等兩格畫面再開始:設計系統剛掛上時自己會「第一次填滿就跳到最底」(mount 的 rAF、ResizeObserver 那一下),
  // 搶在它前面跳的話,它隨後又把畫面送回最底。分頁在背景時 rAF 不跑,100ms 保底
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    window.clearTimeout(fallback);
    attempt();
  };
  const fallback = window.setTimeout(start, 100);
  requestAnimationFrame(() => requestAnimationFrame(start));
  cancel = () => {
    started = true;
    window.clearTimeout(fallback);
  };
  return () => {
    cancel();
    removeRoom?.();
    removeRoom = null;
  };
}
