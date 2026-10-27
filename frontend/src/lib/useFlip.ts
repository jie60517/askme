/**
 * FLIP:清單裡的東西因為版面重排換了位置時,從**畫面上原本的位置**滑過去,
 * 而不是一格跳過去(例如附件通知堆疊:新的一張進來時,上面那張不能一格瞬移)。
 *
 * 用法:每個項目的外層掛 `ref={flip(key)}`;`deps` 變了(例如通知陣列換了)就演一次。
 *
 * ⚠️ **「原本的位置」是在這次重繪的 render 期間量的**,不是上一次 `deps` 變動時記下來的。
 * 不能存「上一次變動後的位置」:兩次變動之間別的東西也會搬動它
 * (附件通知是錨在輸入框底部的,抽屜慢慢長高時整疊跟著往下走),存下來的早就過期,
 * 算出來的位移剛好是 0,照樣一格跳。render 時 DOM 還是上一次 commit 的樣子,
 * 量到的就是「這一刻畫面上的位置」。
 *
 * ⚠️ **可以從半路接手**:量的是 `getBoundingClientRect`,含還在跑的那段位移 ——
 * 上一段還沒滑完又換位置,起點就是畫面上那一格,不會跳回去重來。
 * 跟 bloub 引擎的 `departFige`(凍結的起點)是同一個概念。
 *
 * ⚠️ 動的是 `transform`(Web Animations),建議掛在外層:項目自己的進退場多半用
 * `translate` / `opacity`(例如 global.css 的 `[data-notice]`),不要混在同一個元素上。
 *
 * 減少動態時不演(直接到新位置):這是位移,不是有助理解的淡入淡出。
 */
import {useCallback, useLayoutEffect, useRef} from 'react';

// 時間字串的解析全站共用 `lib/transitionMs.ts` 那一份(測試從這裡 import,所以照樣轉出去)
export {cssDurationMs} from './transitionMs';
import {cssDurationMs} from './transitionMs';

/** 從 CSS token 讀時間與曲線 —— Web Animations 不吃 `var()` */
function motionTokens(): {duration: number; easing: string} {
  const css = getComputedStyle(document.documentElement);
  const duration = cssDurationMs(css.getPropertyValue('--duration-medium-min')) || 225;
  const easing = css.getPropertyValue('--ease-standard').trim() || 'ease-out';
  return {duration, easing};
}

const sameDeps = (a: readonly unknown[] | null, b: readonly unknown[]) =>
  a !== null && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export function useFlip<K>(deps: readonly unknown[]): (key: K) => (el: HTMLElement | null) => void {
  const els = useRef(new Map<K, HTMLElement>());
  const anims = useRef(new Map<K, Animation>());
  const refs = useRef(new Map<K, (el: HTMLElement | null) => void>());
  const lastDeps = useRef<readonly unknown[] | null>(null);
  const first = useRef(new Map<K, number>());

  // First:deps 一變,趁 DOM 還是舊的,記下每一個「畫面上」的位置。
  // ⚠️ 只在 deps 變的那一次量(StrictMode 的第二次 render 看到 deps 沒變,不會覆蓋)。
  if (!sameDeps(lastDeps.current, deps)) {
    lastDeps.current = deps;
    const snap = new Map<K, number>();
    for (const [key, el] of els.current) snap.set(key, el.getBoundingClientRect().top);
    first.current = snap;
  }

  // Last / Invert / Play
  useLayoutEffect(() => {
    const before = first.current;
    first.current = new Map();
    if (before.size === 0) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let tokens: {duration: number; easing: string} | null = null;
    for (const [key, el] of els.current) {
      const from = before.get(key);
      // 新掛上的(沒有起點)交給它自己的進場
      if (from === undefined) continue;
      anims.current.get(key)?.cancel();
      anims.current.delete(key);
      if (reduce) continue;
      const delta = from - el.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) continue;
      tokens ??= motionTokens();
      anims.current.set(key, el.animate([{transform: `translateY(${delta}px)`}, {transform: 'none'}], tokens));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return useCallback((key: K) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el: HTMLElement | null) => {
        if (el) {
          els.current.set(key, el);
        } else {
          els.current.delete(key);
          anims.current.get(key)?.cancel();
          anims.current.delete(key);
          refs.current.delete(key);
        }
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);
}
