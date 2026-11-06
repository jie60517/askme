/**
 * 輸入框底列「專案」那一格:進出一般模式 `/general` 時,裡面的東西換掉(專案選單 ↔ 模式 Token),不要硬切。
 * 換的時候要有過場,不要有割裂感。
 *
 * 割裂感來自兩件事,各處理一件:
 * 1. **這一格的內容**:舊的退場(120ms,淡出 + 模糊 + 縮到 0.97)、新的進場(200ms,淡入 + 模糊散開 + 從 0.96 長回來)。
 *    模糊讓兩個狀態疊在一起的那幾格看起來像同一個東西在變形,不是兩顆鈕交換。退場比進場快:系統在回應,不拖。
 * 2. **這一格的寬度**:Token 跟專案鈕不一樣寬,不處理的話右邊的 Model 鈕會「跳」一格。寬度從舊值補到新值(220ms),
 *    右邊的鈕跟著滑過去。只動這一格的 width,一個小元素,不會拖到整列重排的成本。
 *
 * 曲線一律強 ease-out(`cubic-bezier(0.23, 1, 0.32, 1)`):一按就看得到在動。用 WAAPI 不用 keyframes:
 * 換到一半又換(進模式馬上按 ✕),寬度從**當下**的值接著補,不會從頭跳。
 * 減少動態(prefers-reduced-motion):不縮放、不模糊、不補寬度,只留新內容淡入。
 *
 * `slotKey` 變了才算換;同一個 key 的內容更新(例如 Token 的字)直接重畫,不演。
 *
 * ⚠️ **刻意的例外**(frontend/.claude/CLAUDE.md 有登記):三層是裸 `<span>`,不是設計系統的 Stack —— WAAPI 要直接拿到
 * 那個 DOM 元素量寬度、掛動畫。動畫值(模糊 2px、時間)也是寫死的:keyframes 吃不到 CSS 變數,而且那是動畫參數,不是版面數值。
 */
import {type ReactNode, useEffect, useLayoutEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {holdStalls} from '../lib/holdStalls';

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const ENTER_MS = 200;
const EXIT_MS = 120;
const WIDTH_MS = 220;
/** 減少動態:只留淡入 */
const REDUCED_MS = 150;
/** 兩個狀態疊在一起那幾格的模糊(交叉淡入淡出看起來像兩個東西時加一點;超過 20px 很貴) */
const BLUR = 'blur(2px)';

const styles = stylex.create({
  box: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    maxWidth: '100%',
  },
  layer: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--spacing-1)',
    transformOrigin: 'left center',
  },
  leaving: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    pointerEvents: 'none',
  },
});

type Snapshot = {key: string; node: ReactNode};

export function ComposerSlot({
  slotKey,
  children,
  timeScale = 1,
}: {
  slotKey: string;
  children: ReactNode;
  /** 動畫時間倍率(慢動作檢查用) */
  timeScale?: number;
}) {
  const [shownKey, setShownKey] = useState(slotKey);
  const [leaving, setLeaving] = useState<Snapshot | null>(null);
  // 上一次畫上去的內容:換 key 那一刻交給退場層。commit 之後才更新,同一個 key 的內容變了也是最新那份
  const lastChildren = useRef<ReactNode>(children);
  // 由 props 推出來的狀態(React 文件的「在 render 裡調整 state」):只在換 key 時 setState,同一個 key 不多畫一次
  if (slotKey !== shownKey) {
    setLeaving({key: shownKey, node: lastChildren.current});
    setShownKey(slotKey);
  }

  const boxRef = useRef<HTMLSpanElement>(null);
  const inRef = useRef<HTMLSpanElement>(null);
  const outRef = useRef<HTMLSpanElement>(null);
  const widthAnim = useRef<Animation | null>(null);
  const running = useRef(new Set<Animation>());
  // 沒在補寬度時這一格的寬:換 key 那一刻 DOM 已經是新內容了,舊寬度只能先記著
  const restWidth = useRef(0);
  const firstKey = useRef(slotKey);

  useLayoutEffect(() => {
    lastChildren.current = children;
  });

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    restWidth.current = box.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      if (!widthAnim.current) restWidth.current = box.getBoundingClientRect().width;
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // 卸載(換頁、整頁重掛)時把還在跑的動畫收掉:不收的話退場那支的 onfinish 會在元件不在之後才回來 setState
  useEffect(() => {
    const set = running.current;
    return () => {
      for (const a of [...set]) a.cancel();
      set.clear();
    };
  }, []);

  useLayoutEffect(() => {
    if (shownKey === firstKey.current && !leaving) return; // 第一次掛上:不演(StrictMode 的第二次也走這裡)
    firstKey.current = '';
    const box = boxRef.current;
    const inEl = inRef.current;
    if (!box || !inEl) return;
    // 這一輪建的動畫(交給 holdStalls;中途又換 key 被 cancel 的它自己會跳過)
    const started: Animation[] = [];
    const track = (a: Animation) => {
      started.push(a);
      running.current.add(a);
      const done = () => running.current.delete(a);
      a.addEventListener('finish', done);
      a.addEventListener('cancel', done);
      return a;
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLeaving(null);
      track(inEl.animate([{opacity: 0}, {opacity: 1}], {duration: REDUCED_MS * timeScale, easing: 'ease'}));
      return;
    }
    // 寬度:補到一半又換,從當下補到一半的值接著走
    const from = widthAnim.current ? box.getBoundingClientRect().width : restWidth.current;
    widthAnim.current?.cancel();
    const to = inEl.getBoundingClientRect().width;
    box.style.overflow = 'clip';
    const w = track(box.animate([{width: `${from}px`}, {width: `${to}px`}], {duration: WIDTH_MS * timeScale, easing: EASE_OUT}));
    widthAnim.current = w;
    w.onfinish = w.oncancel = () => {
      if (widthAnim.current !== w) return;
      widthAnim.current = null;
      box.style.overflow = '';
      restWidth.current = box.getBoundingClientRect().width;
    };
    track(
      inEl.animate(
        [
          {opacity: 0, transform: 'scale(0.96)', filter: BLUR},
          {opacity: 1, transform: 'none', filter: 'none'},
        ],
        {duration: ENTER_MS * timeScale, easing: EASE_OUT},
      ),
    );
    const outEl = outRef.current;
    if (outEl) {
      const o = track(
        outEl.animate(
          [
            {opacity: 1, transform: 'none', filter: 'none'},
            {opacity: 0, transform: 'scale(0.97)', filter: BLUR},
          ],
          {duration: EXIT_MS * timeScale, easing: EASE_OUT, fill: 'forwards'},
        ),
      );
      // 只認 finish:被 cancel = 卸載了,不 setState
      o.onfinish = () => setLeaving((l) => (l && outRef.current === outEl ? null : l));
    }
    // 減少動態那條路只有 150ms 淡入、上面就 return 了,不補(不值得為它排 rAF)
    return holdStalls(started);
    // 只在換 key 時演;leaving 變回 null 不是換
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  return (
    <span ref={boxRef} {...stylex.props(styles.box)}>
      <span key={shownKey} ref={inRef} {...stylex.props(styles.layer)}>
        {children}
      </span>
      {leaving ? (
        <span key={`out-${leaving.key}`} ref={outRef} aria-hidden inert {...stylex.props(styles.layer, styles.leaving)}>
          {leaving.node}
        </span>
      ) : null}
    </span>
  );
}
