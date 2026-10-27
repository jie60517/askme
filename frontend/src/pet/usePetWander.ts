import { useEffect, useLayoutEffect, useRef } from "react";

import { BALL_R, Wanderer, type WalkStyle } from "./petWander";

/**
 * 讓小夥伴閒著時逛一逛(路線與走法在 `petWander.ts`)。
 *
 * **每一格直接寫 DOM 的 transform,不經過 React state** —— PetCompanion 掛著 framer-motion 的
 * 氣泡和一堆 hook,一秒重繪 60 次只為了移幾 px 太浪費。
 *
 * 兩個 ref 分兩層(位移與身體變形分開):
 *   - `moveRef`:最外層,只管**位移**。氣泡在它裡面,所以會跟著走(對的);
 *   - `bodyRef`:角色那一層,管**跳起來、傾斜、壓扁拉長、滾動**。氣泡不在它裡面,
 *     不然字會跟著歪、跟著轉。
 *
 * @param active 這一刻要不要逛(閒晃狀態、沒在拖、滑鼠沒指著牠、沒開減少動態)。
 *   不逛的時候**停在原地**(位移保留),身體回正 —— 走到一半有工作進來,牠就在那裡開始做事。
 * @param resetKey 變了就回到家(被拖走的那一刻,見 `Wanderer.reset`)。
 * @returns `lookX` 的 ref:bloub 果凍滑行時眼睛要看前進方向,給 `BloubAvatar` 的 `lookXRef`。
 */
export function usePetWander(
  style: WalkStyle,
  range: [number, number],
  active: boolean,
  resetKey: unknown,
  moveRef: React.RefObject<HTMLElement | null>,
  bodyRef: React.RefObject<HTMLElement | null>,
) {
  const wanderRef = useRef<Wanderer | null>(null);
  const lookXRef = useRef<number | null>(null);

  // 換角色(Classic ↔ Blob)就換一套走法,從家重新開始
  useEffect(() => {
    wanderRef.current = new Wanderer(style, { range });
    if (moveRef.current) moveRef.current.style.transform = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);

  useEffect(() => {
    wanderRef.current?.setRange(range);
  }, [range[0], range[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  // 被拖走:位移歸零(拖曳已經把牠釘在畫面上看到的位置)。
  // ⚠️ 要 useLayoutEffect:setPinned 跟 dragging 是同一輪 commit 的,用 useEffect 的話
  // 那一格畫面「新的釘點 + 還沒清掉的位移」會先畫出來,牠被推開一格再跳回來。
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    wanderRef.current?.reset();
    if (moveRef.current) moveRef.current.style.transform = "";
  }, [resetKey, moveRef]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!active) {
      // 停在原地、身體回正(滾到一半的角度、跳到一半的高度都不要留著)——
      // 路線那邊也要同步回正,不然回到閒晃時角度會從 0 跳回去
      wanderRef.current?.interrupt();
      if (body) body.style.transform = "";
      lookXRef.current = null;
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      // 分頁藏起來再回來不要一口氣快轉
      const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0;
      last = ms;
      const w = wanderRef.current;
      if (!w) return;
      const f = w.step(dt);
      lookXRef.current = f.lookX;
      if (moveRef.current) moveRef.current.style.transform = f.x ? `translateX(${f.x.toFixed(2)}px)` : "";
      if (body) {
        const ball = style === "blob" || style === "jelly" || style === "roll";
        // 小夥伴:傾斜與壓扁都以腳底為準(GIF 裡腳底在框高 92% 的地方)。
        // bloub:滾動要繞球心轉,壓扁卻要以球底為準(不然像浮在空中被捏)——
        // 同一層做兩件事,所以縮放前先移到球底、縮完再移回來。
        body.style.transformOrigin = ball ? "50% 50%" : "50% 92%";
        const scale = `scale(${f.sx.toFixed(4)}, ${f.sy.toFixed(4)})`;
        body.style.transform =
          `translateY(${f.y.toFixed(2)}px) rotate(${f.rot.toFixed(2)}deg) ` +
          (ball ? `translateY(${BALL_R}px) ${scale} translateY(-${BALL_R}px)` : scale);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (body) body.style.transform = "";
    };
  }, [active, style, moveRef, bodyRef]);

  return lookXRef;
}
