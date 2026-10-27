import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { NOTIF_BLUE } from "./bloub/decor";
import { BotEngine, type BotFrame, type Look } from "./bloub/engine";
import { EXPRESSION_BY_ID, type BotExpression, type ExpressionId } from "./bloub/expressions";
import { DEMI_VIEWBOX, RAYON } from "./bloub/repere";
import { COLOR_BY_ID, SHAPE_BY_ID, mixHex, type ColorId, type ShapeId } from "./bloub/skins";
import { STATE_BY_ID, type StateId } from "./bloub/states";
import { useReducedMotion } from "./useReducedMotion";

/**
 * bloub(github.com/jeremy-prt/bloub,MIT)的 React 外殼。
 *
 * 引擎在 `./bloub/`,**原封不動**從上游抓下來的(commit b4bb3c1),不要改那裡的檔 ——
 * 它的常數全是對著 x.ai 影片逐格量出來的,「改成好看一點的整數」就不像了
 * (上游 README 的「Why the numbers look arbitrary」)。要調行為改這個檔或 `bloubMap.ts`。
 * ⚠️ **唯一的例外**:`face.ts` 的眨眼取模(`BLINK_PERIOD`)。上游的眨眼時間表
 * 只排到 900 秒左右,而這裡的時鐘整天累加 —— 不補的話小夥伴 15 分鐘後就再也不眨眼。
 * 外殼這邊修不了:引擎所有的時間戳(換形狀、表情補間)都綁在同一顆時鐘上,歸零會讓補間跳掉。
 * 升級上游時要把那一段帶過去。
 *
 * 跟上游 Vue 元件(`BloubBot.vue`)的差別只有四件:
 *   1. 沒有時間軸/montage —— 狀態由外面直接給(小夥伴的狀態對應見 `bloubMap.ts`);
 *   2. 顏色從佈景 token 解析,不寫死 —— 淺色是近黑的身體,深色自動變近白;
 *   3. `mono` 時通知點與軌道環也用同一個顏色(Astryx 是單色系);
 *   4. 每一格的數值直接寫 DOM(`paintBloubSvg`),React 只在結構變了才重畫。
 *
 * ⚠️ 眼睛是 `<mask>` 挖的洞,不是白色圖形疊上去 —— 洞裡看到的是底下那層
 * `paper` 色的身體墊片。所以 `paper` 一定要等於畫面背景色,不然眼睛會是另一個顏色。
 */

/**
 * 一步:進到哪個狀態,外加(只在 `idle` 這類「靜止臉/靜止身體」的狀態上看得到的)
 * 表情與身體形狀。
 *
 * - `expr` 可以是上游的表情 id,也可以是自己做的一份表情資料(例如眼睛整個閉上的睡臉 ——
 *   上游最接近的 `somnolent` 只是半閉)。
 * - `shape` 是上游換裝用的身體形狀(`capsule` = 壓扁成一條,`galet` = 有點塌的石頭)。
 *   引擎只在 `baseBody` 的狀態上套用,其他狀態的身體本身就是動畫。
 */
export interface BloubStep {
  state: StateId;
  expr?: ExpressionId | BotExpression;
  shape?: ShapeId;
}

/**
 * 眼睛的腳本。小夥伴的 GIF 很多動作是「看著某個東西」(看書、看鍵盤、拿放大鏡張望),
 * bloub 沒有道具,能演的就是眼睛往哪看、怎麼動。只在靜止臉的狀態上生效。
 *
 * - `read`:往下看,慢慢由左掃到右再跳回來(一行一行讀)
 * - `type`:往下看,一小格一小格往右跳(打字)
 * - `scan`:左右大幅張望,到兩端會停一下(拿放大鏡找)
 * - `away`:看向旁邊,偶爾瞄回來(別的地方還有事)
 */
export type BloubGaze = "read" | "type" | "scan" | "away";

interface Props {
  /** 現在要演的。換掉就從當下那一格平順變過去 */
  step: BloubStep;
  /** 播完 `step` 之後接著停在哪(完成 → 爆開 → 開心臉)。不給就停在 `step` */
  then?: BloubStep;
  /**
   * 一次性的動畫要不要每播完一輪就重來(用在「一直在跑」的狀態上)。
   * 跟 `then` 一起給 = `step` 與 `then` 兩段輪流。
   */
  repeat?: boolean;
  /**
   * `step` 撐幾秒才換到 `then`(秒)。不給 = 那段動畫自己的長度(靜止臉是 2.4 秒)。
   * 被戳只有 1.4 秒、完成只顯示 4 秒,第一段照預設撐的話後面那段根本來不及出現。
   */
  hold?: number;
  /** 眼睛的腳本;給了就不跟游標 */
  gaze?: BloubGaze;
  /**
   * 外面直接指定眼睛往左右看(-1 = 最左、1 = 最右),`null` = 不指定。
   * 散步時用:出發前先看向要去的方向。優先於 `gaze` 腳本與游標(走路要看路)。
   */
  lookX?: number | null;
  /**
   * 同 `lookX`,但從 ref 讀 —— 散步是每一格都在變,走 prop 的話整個小夥伴要跟著重繪。
   * 兩個都給的話 `lookX` 優先。
   */
  lookXRef?: { readonly current: number | null };
  /** 顯示尺寸(px) */
  size: number;
  /** 通知點與軌道環也用身體的顏色 */
  mono?: boolean;
  /** 眼睛跟著游標 */
  follow?: boolean;
  /**
   * 使用者挑的身體形狀(個人設定)。狀態自己有指定形狀時照狀態,見 `shapeOf`。
   * 換掉時從當下那一格變形過去(引擎的 setShape 本來就從混到一半的形狀起跳)。
   */
  baseShape?: ShapeId;
  /**
   * 使用者挑的身體顏色:色票的 id,或調色盤挑的 `#rrggbb`。`null` / 不給 = 跟著佈景(`--color-accent`)。
   * 換掉時從**畫面上現在那個顏色**補間過去,連點也不會跳(調色盤拖曳時每格都在換,一樣是追著跑)。
   */
  color?: ColorId | `#${string}` | null;
}

/** 從佈景 token 解析成 #rrggbb。mixHex 只吃 hex,而 token 可能是 oklch / light-dark() */
function resolveColor(el: Element, cssVar: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${cssVar})`;
  el.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#0a0a0c";
  ctx.fillStyle = computed;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((x) => (x ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/** 佈景換深淺時重新解析顏色(data-theme 或系統設定) */
export function useInkPaper(ref: React.RefObject<Element | null>) {
  const [colors, setColors] = useState({ ink: "#0a0a0c", paper: "#ffffff" });
  useEffect(() => {
    const read = () => {
      const el = ref.current;
      if (!el) return;
      setColors({
        ink: resolveColor(el, "--color-accent"),
        paper: resolveColor(el, "--color-background-body"),
      });
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", read);
    };
  }, [ref]);
  return colors;
}

/**
 * 右下角的 bloub 畫多大(px)。放在跟圖同一個 144px 的框裡,球的直徑約是這個數字的 63%
 * (引擎的 viewBox 半徑 158、球半徑 100,外圈留給軌道環與碎片)。
 * 放在這裡而不是 PetCompanion:個人設定的預覽台(`components/CompanionLook.tsx`)也要同一個數字,
 * 而 PetCompanion 是整包延後載入的,從它 import 會把整個小夥伴拉進設定頁。
 */
export const BLOB_SIZE_PX = 112;

const VB = DEMI_VIEWBOX;

/** `repeat` 時兩輪之間回到靜止臉多久(秒) */
const REPEAT_REST_S = 1.2;

/**
 * 沒指定形狀就用圓 —— 不能給 null:引擎從「壓扁」換回 null 時不會變形回去,
 * 而是直接跳回圓(`shapeAtTime` 在目標是 null 時不內插)。
 */
const CIRCLE = SHAPE_BY_ID.get("cercle")?.radii ?? null;

/**
 * 這一步要用的身體形狀:狀態自己指定的(被戳壓扁的 capsule 等)優先,
 * 沒指定就用使用者在設定裡挑的 `base` —— 動作不能被換裝蓋掉,演完回到使用者的形狀。
 */
const shapeOf = (s: BloubStep, base?: ShapeId) => {
  const id = s.shape ?? base;
  return id ? (SHAPE_BY_ID.get(id)?.radii ?? CIRCLE) : CIRCLE;
};

const easeOutQuint = (x: number) => 1 - (1 - x) ** 5;
/** 換色多久(秒)。跟引擎的 SHAPE_MORPH 一樣長:型態與顏色一起換時同時落定 */
const COLOR_MORPH_S = BotEngine.SHAPE_MORPH;

/** 顏色補間:`from` → `to`,從 `at` 秒開始 */
type Tint = { from: string; to: string; at: number };
function tintAt(t: Tint, now: number): string {
  const p = Math.min(1, Math.max(0, (now - t.at) / COLOR_MORPH_S));
  return p >= 1 ? t.to : mixHex(t.from, t.to, easeOutQuint(p));
}

const exprOf = (s: BloubStep): BotExpression | null =>
  typeof s.expr === "object" ? s.expr : (EXPRESSION_BY_ID.get(s.expr ?? "neutre") ?? null);

const stepKey = (s: BloubStep) =>
  `${s.state}/${typeof s.expr === "object" ? JSON.stringify(s.expr) : (s.expr ?? "")}/${s.shape ?? ""}`;

/** 一段動畫要演多久才算演完(一次性的看 minDuration,其餘看 duration) */
function lengthOf(state: StateId): number {
  const def = STATE_BY_ID.get(state);
  return def?.minDuration ?? def?.duration ?? 2;
}

function applyStep(engine: BotEngine, s: BloubStep, now: number, base?: ShapeId) {
  engine.setExpression(exprOf(s), now);
  engine.setShape(shapeOf(s, base), now);
  engine.setState(s.state, now);
}

/**
 * 眼睛腳本在 `t` 秒時要看哪裡。yaw / pitch 是**絕對**角度(度):yaw 正 = 往右,
 * pitch 正 = 往上(中性臉本來就看右上方,約 28°/28°)。
 */
function gazeAt(gaze: BloubGaze, t: number): Look {
  const look = (yaw: number, pitch: number): Look => ({ yaw, pitch, mix: 1, spin: 0, wander: 0.15 });
  switch (gaze) {
    case "read": {
      // 一行 1.8 秒:1.5 秒由左讀到右,0.3 秒跳回行首
      const p = t % 1.8;
      const yaw = p < 1.5 ? -22 + (44 * p) / 1.5 : 22 - (44 * (p - 1.5)) / 0.3;
      return look(yaw, -26);
    }
    case "type": {
      // 一秒跳 5 格,5 格一行
      const col = Math.floor(t * 5) % 5;
      return look(-16 + col * 8, -20);
    }
    case "scan": {
      // 左右張望,|sin| 開根號讓它在兩端多停一下
      const s = Math.sin(t * 1.3);
      return look(Math.sign(s) * Math.pow(Math.abs(s), 0.35) * 42, 4);
    }
    case "away": {
      // 看左邊;每 5 秒在 3.8~4.6 秒之間瞄回來一下
      const p = t % 5;
      return p > 3.8 && p < 4.6 ? look(22, 22) : look(-44, 10);
    }
  }
}

export function BloubAvatar({ step, then, repeat, hold, gaze, lookX, lookXRef: lookXSource, size, mono, follow, baseShape, color }: Props) {
  // 每一格都會變的值走 ref,不要讓它重設排程
  const lookXRef = useRef(lookX);
  lookXRef.current = lookX;
  const sourceRef = useRef(lookXSource);
  sourceRef.current = lookXSource;
  const svgRef = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const { ink, paper } = useInkPaper(svgRef);
  const uid = useId().replace(/:/g, "");

  const engineRef = useRef<BotEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new BotEngine(RAYON, step.state, shapeOf(step, baseShape), exprOf(step));
  }
  const engine = engineRef.current;
  const clock = useRef(0);
  /**
   * React 畫的那一格 —— **只在結構變了的時候才換**。
   * 每格的數值(身體輪廓、眼睛、透明度、顏色補間)由 `show` 直接寫進 DOM,不經過 React:
   * rAF 每一格都 `setFrame` 的話,整顆 SVG 一秒重新協調 60 次,而小夥伴是整天常駐的。
   */
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(0));
  /** 最新算出來的一格(畫面上實際該是這一格,`frame` 可能比它舊) */
  const latest = useRef(frame);
  /** React 現在畫好的元素是哪一種結構(`frameShape`);null = 還沒掛上 */
  const drawnShape = useRef<string | null>(null);
  /** 畫面上現在的身體顏色(補間中每格都在變,一樣不經過 React) */
  const inkNow = useRef<string | null>(null);
  const view = useRef({ paper, mono, uid });
  view.current = { paper, mono, uid };
  /**
   * 把一格畫上去:結構跟 React 畫好的一樣就直接寫屬性;不一樣(多了碎片、軌道環出現…)才交給 React
   * 增刪元素,commit 之後底下那個 layout effect 會再把最新一格寫一次。
   */
  /** React 畫好的元素按種類分好(每次 commit 之後重抓一次,見底下的 layout effect) */
  const parts = useRef<BloubParts | null>(null);
  const show = useCallback((f: BotFrame) => {
    latest.current = f;
    const v = view.current;
    if (parts.current && inkNow.current && drawnShape.current === frameShape(f, v.mono)) {
      paintBloubSvg(parts.current, f, inkNow.current, v.paper, v.mono, v.uid);
    } else {
      setFrame(f);
    }
  }, []);
  // 排程裡每次 applyStep 都要用「當下」使用者挑的形狀,走 ref 才不必把它放進排程的依賴
  const baseRef = useRef(baseShape);
  baseRef.current = baseShape;

  // 身體顏色:使用者挑的,或跟著佈景。補間從畫面上現在那個顏色出發(見 `Tint`)
  const target = !color ? ink : color.startsWith("#") ? color : (COLOR_BY_ID.get(color)?.hex ?? ink);
  const tint = useRef<Tint>({ from: target, to: target, at: -10 });
  /** React 畫的顏色:只在補間跑完、或直接跳色時才更新(補間中每格的顏色走 `inkNow`) */
  const [shownInk, setShownInk] = useState(target);
  if (inkNow.current === null) inkNow.current = target;
  const lastColor = useRef(color);
  useEffect(() => {
    const now = clock.current;
    // ⚠️ **只有使用者換色才補間**。佈景換深淺、或剛掛上時 token 才解析出來
    // (`useInkPaper` 第一格是預設的近黑)也走這裡 —— 那些要直接跳,
    // 不然深色佈景一打開頁面,牠會從黑色慢慢變白。
    if (lastColor.current !== color && !reduced) {
      tint.current = { from: tintAt(tint.current, now), to: target, at: now };
    } else {
      tint.current = { from: target, to: target, at: -10 };
      setShownInk(target);
      // 減少動態時沒有迴圈幫忙寫;而 `shownInk` 剛好等於 target 時 React 也不會重繪 —— 自己寫一次
      inkNow.current = target;
      show(latest.current);
    }
    lastColor.current = color;
  }, [target, color, reduced, show]);

  // 使用者換了形狀:從當下那一格變過去。狀態自己有指定形狀的(壓扁等)照狀態,見 `shapeOf`
  const lastBase = useRef(baseShape);
  useEffect(() => {
    if (lastBase.current === baseShape) return;
    lastBase.current = baseShape;
    const now = clock.current;
    const p = plan.current;
    const showing = p.phase === "then" && p.then ? p.then : p.step;
    engine.setShape(shapeOf(showing, baseShape), now);
    if (reduced) show(engine.sample(now + 5));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseShape, engine, reduced]);

  // 狀態排程:進 step,(一次性的)播完接 then 或重來
  const plan = useRef({
    step,
    then,
    repeat,
    hold,
    gaze,
    gazeSince: 0,
    nextAt: Infinity,
    phase: "step" as "step" | "then" | "rest",
  });
  // step / then 是每次重繪都新建的物件,比內容就好(表情可能是一份物件,比 id 不夠)
  const key =
    stepKey(step) + "|" + (then ? stepKey(then) : "") + "|" + !!repeat + "|" + (hold ?? "") + "|" + (gaze ?? "");
  useEffect(() => {
    const now = clock.current;
    plan.current = {
      step,
      then,
      repeat,
      hold,
      gaze,
      gazeSince: now,
      nextAt: then || repeat ? now + (hold ?? lengthOf(step.state)) : Infinity,
      phase: "step",
    };
    applyStep(engine, step, now, baseRef.current);
    // 減少動態:沒有迴圈,直接跳到結果那一格
    if (reduced) {
      const target = then ?? step;
      applyStep(engine, target, now, baseRef.current);
      engine.reset(target.state, now);
      show(engine.sample(now + 5));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduced, engine]);

  // 游標位置(只在 follow 時)
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!follow) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "touch") pointer.current = { x: e.clientX, y: e.clientY };
    };
    const leave = () => (pointer.current = null);
    window.addEventListener("pointermove", move);
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
    };
  }, [follow]);

  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let last = 0;
    let aiming = false;
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      // 分頁藏起來再回來不要一口氣快轉(rAF 那段時間是停的)
      const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0;
      last = ms;
      clock.current += dt;
      const now = clock.current;

      const p = plan.current;
      if (now >= p.nextAt) {
        if (p.phase === "step" && p.then) {
          // `then` + `repeat` = 兩段輪流(寫回答:興奮臉 ↔ 抖動的「!」);只有 `then` 就停在後面那段
          p.phase = "then";
          p.nextAt = p.repeat ? now + lengthOf(p.then.state) : Infinity;
          applyStep(engine, p.then, now, baseRef.current);
        } else if (p.phase === "then" && p.repeat) {
          p.phase = "step";
          p.nextAt = now + (p.hold ?? lengthOf(p.step.state));
          applyStep(engine, p.step, now, baseRef.current);
        } else if (p.repeat && p.phase === "step") {
          // 重來不用 reset(那會硬跳回第一格):跟原影片一樣,先回靜止臉喘一下再演一次,
          // 兩段都是引擎自己的變形
          p.phase = "rest";
          p.nextAt = now + REPEAT_REST_S;
          engine.setState("idle", now);
        } else if (p.repeat) {
          p.phase = "step";
          p.nextAt = now + lengthOf(p.step.state);
          engine.setState(p.step.state, now);
        } else {
          p.nextAt = Infinity;
        }
      }

      // 視線只在「靜止臉」的狀態上動,其他狀態的眼睛本身就是動畫。
      // 腳本優先於游標 —— 正在看書的時候不該轉頭去看滑鼠。
      const restFace = STATE_BY_ID.get(engine.state)?.baseFace;
      const lx = lookXRef.current ?? sourceRef.current?.current ?? null;
      // 優先序:散步指定的方向(走路看路)> 眼睛腳本 > 游標
      if (restFace && lx != null) {
        engine.setLook({ yaw: lx * 45, pitch: 8, mix: 1, spin: 0, wander: 0.1 }, now);
        aiming = true;
      } else if (restFace && p.gaze) {
        engine.setLook(gazeAt(p.gaze, now - p.gazeSince), now);
        aiming = true;
      } else if (follow && restFace && pointer.current) {
        const box = svgRef.current?.getBoundingClientRect();
        if (box && box.width > 0) {
          const nx = Math.max(-1, Math.min(1, (pointer.current.x - (box.left + box.width / 2)) / Math.max(1, window.innerWidth / 2)));
          const ny = Math.max(-1, Math.min(1, (pointer.current.y - (box.top + box.height / 2)) / Math.max(1, window.innerHeight / 2)));
          engine.setLook({ yaw: nx * 40, pitch: -ny * 30, mix: 1, spin: 0, wander: 0.3 }, now);
          aiming = true;
        }
      } else if (aiming) {
        engine.setLook(null, now);
        aiming = false;
      }

      const ink = tintAt(tint.current, now);
      inkNow.current = ink;
      show(engine.sample(now));
      // 補間跑完才回寫給 React 一次(之後值都一樣,Object.is 相同 React 不重繪)——
      // 讓 React 那份不要停在補間開始前的顏色:之後要是剛好「跳回」那個顏色,React 會以為沒變而不寫
      if (ink === tint.current.to) setShownInk(ink);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, follow, reduced, show]);

  // 每次 React commit 之後:記下畫好的是哪一種結構,再把**最新**那一格寫上去。
  // ⚠️ 不能只靠 React 寫:`frame` 可能是好幾格之前的,而 React 只寫「跟它上一次畫的不一樣」的屬性 ——
  // 屬性被 `show` 直接改過、React 那份剛好沒變的話,畫面會停在舊值。所以不給依賴,每次 commit 都補一次。
  // 元素清單也在這裡重抓:commit 很少(結構變了才有),每格都抓才是浪費。
  useLayoutEffect(() => {
    drawnShape.current = frameShape(frame, mono);
    const svg = svgRef.current;
    parts.current = svg ? collectBloubParts(svg) : null;
    const f = latest.current;
    if (parts.current && inkNow.current && frameShape(f, mono) === drawnShape.current) {
      paintBloubSvg(parts.current, f, inkNow.current, paper, mono, uid);
    }
  });

  return <BloubSvg ref={svgRef} frame={frame} ink={shownInk} paper={paper} size={size} mono={mono} uid={uid} />;
}

type Dot = BotFrame["dots"][number];
/*
 * 每個屬性怎麼從一格算出來 —— `BloubSvg`(React 畫)與 `paintBloubSvg`(直接寫 DOM)共用這幾支,
 * 兩條路不會各算各的而對不起來。
 */
const dotFill = (d: Dot, ink: string, paper: string, mono?: boolean) =>
  mono ? ink : (d.color ?? (d.depth === undefined ? ink : mixHex(paper, ink, d.depth)));
const dotOpacity = (d: Dot, mono?: boolean) => d.opacity * (mono && d.depth !== undefined ? d.depth : 1);
const dotTransform = (d: Dot) => `translate(${d.x} ${d.y}) rotate(${d.rot ?? 0}) scale(${RAYON})`;
const arcStroke = (uid: string, id: string, ink: string, mono?: boolean) => (mono ? ink : `url(#${uid}-${id})`);
const notifFill = (ink: string, mono?: boolean) => (mono ? ink : NOTIF_BLUE);

/**
 * 一格的「結構」:有幾個、哪一種元素(眼睛幾顆、有沒有缺口 / 通知點、粒子是圓還是水滴、哪幾條軌道環)。
 * 結構一樣 = 只有數值在變,可以直接寫屬性;不一樣才要 React 增刪元素(見 `BloubAvatar` 的 `show`)。
 */
export function frameShape(frame: BotFrame, mono?: boolean): string {
  let dots = "";
  for (const d of frame.dots) dots += d.d ? "p" : "c";
  let arcs = "";
  for (const a of frame.arcs) arcs += `${a.id}:${a.grad.stops.length},`;
  return `${frame.eyes.length}|${frame.notch ? 1 : 0}|${frame.notif ? 1 : 0}|${frame.dotsBehind ? 1 : 0}|${dots}|${arcs}|${mono ? 1 : 0}`;
}

/** 值沒變就不寫(同一個值再 setAttribute 一次,瀏覽器照樣當成變了) */
function attr(el: Element, name: string, value: string | number) {
  const v = String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

/**
 * `BloubSvg` 畫好的、每格要改的元素,按種類分好(順序 = 文件順序 = frame 裡陣列的順序)。
 * 結構一變(React 增刪了元素)就要重抓,見 `collectBloubParts`。
 */
export type BloubParts = {
  maskBody: Element[];
  pad: Element[];
  eyes: Element[];
  notch: Element[];
  grads: Element[];
  backs: Element[];
  fronts: Element[];
  dots: Element[];
  alpha: Element[];
  ink: Element[];
  notif: Element[];
};

/**
 * 照 `data-bloub` 把元素分組。**只在 React commit 之後叫一次**(`BloubAvatar` 的 layout effect),
 * 不要每格叫 —— 每一格都 querySelectorAll 再逐個比字串,省下來的 React 協調又花回去一部分。
 */
export function collectBloubParts(svg: SVGSVGElement): BloubParts {
  const parts: BloubParts = {
    maskBody: [],
    pad: [],
    eyes: [],
    notch: [],
    grads: [],
    backs: [],
    fronts: [],
    dots: [],
    alpha: [],
    ink: [],
    notif: [],
  };
  const kinds: Record<string, keyof BloubParts> = {
    "mask-body": "maskBody",
    pad: "pad",
    eye: "eyes",
    notch: "notch",
    grad: "grads",
    back: "backs",
    front: "fronts",
    dot: "dots",
    alpha: "alpha",
    ink: "ink",
    notif: "notif",
  };
  for (const el of svg.querySelectorAll("[data-bloub]")) {
    const kind = kinds[el.getAttribute("data-bloub") ?? ""];
    if (kind) parts[kind].push(el);
  }
  return parts;
}

/**
 * 把一格**直接寫進** `BloubSvg` 已經畫好的元素。
 *
 * 不讓 rAF 每一格 `setFrame`(那是 React 每秒重新協調整顆 SVG 60 次,而小夥伴整天常駐);
 * 每格的變化直接寫 DOM(跟 `usePetWander` 同一個做法),React 只管增刪元素。
 * ⚠️ 只能在**結構相同**(`frameShape` 一樣)時呼叫 —— `parts` 是照順序一個一個對的。
 */
export function paintBloubSvg(
  parts: BloubParts,
  frame: BotFrame,
  ink: string,
  paper: string,
  mono: boolean | undefined,
  uid: string,
) {
  for (const el of parts.maskBody) attr(el, "d", frame.bodyPath);
  for (const el of parts.pad) {
    attr(el, "d", frame.bodyPath);
    attr(el, "fill", paper);
  }
  parts.eyes.forEach((el, i) => {
    const e = frame.eyes[i];
    if (!e) return;
    attr(el, "d", e.d);
    attr(el, "transform", e.matrix);
    attr(el, "opacity", e.alpha);
  });
  const notch = frame.notch;
  if (notch) {
    for (const el of parts.notch) {
      attr(el, "cx", notch.x);
      attr(el, "cy", notch.y);
      attr(el, "r", notch.r);
    }
  }
  parts.grads.forEach((el, i) => {
    const a = frame.arcs[i];
    if (!a) return;
    attr(el, "x1", a.grad.x1);
    attr(el, "y1", a.grad.y1);
    attr(el, "x2", a.grad.x2);
    attr(el, "y2", a.grad.y2);
    a.grad.stops.forEach((c, j) => {
      const stop = el.children[j];
      if (stop) attr(stop, "stop-color", c);
    });
  });
  const arcPath = (el: Element, i: number, side: "back" | "front") => {
    const a = frame.arcs[i];
    if (!a) return;
    attr(el, "d", a[side]);
    attr(el, "stroke", arcStroke(uid, a.id, ink, mono));
    attr(el, "stroke-width", a.width);
    attr(el, "opacity", a.opacity);
  };
  parts.backs.forEach((el, i) => arcPath(el, i, "back"));
  parts.fronts.forEach((el, i) => arcPath(el, i, "front"));
  parts.dots.forEach((el, i) => {
    const d = frame.dots[i];
    if (!d) return;
    if (d.d) {
      attr(el, "d", d.d);
      attr(el, "transform", dotTransform(d));
    } else {
      attr(el, "cx", d.x);
      attr(el, "cy", d.y);
      attr(el, "r", d.r);
    }
    attr(el, "fill", dotFill(d, ink, paper, mono));
    attr(el, "opacity", dotOpacity(d, mono));
  });
  for (const el of parts.alpha) attr(el, "opacity", frame.bodyAlpha);
  for (const el of parts.ink) attr(el, "fill", ink);
  const notif = frame.notif;
  if (notif) {
    for (const el of parts.notif) {
      attr(el, "cx", notif.x);
      attr(el, "cy", notif.y);
      attr(el, "r", notif.r);
      attr(el, "fill", notifFill(ink, mono));
    }
  }
}

/**
 * 把引擎的一格畫成 SVG。純繪製,沒有時鐘 —— 給 `BloubAvatar` 用,
 * 也可以直接拿 `engine.sample(t)` 的結果來畫(例如做逐格對照表)。
 *
 * 每個會逐格變的元素都掛 `data-bloub`,`collectBloubParts` 照它把元素分組(順序就是文件順序)。
 */
export function BloubSvg({
  frame,
  ink,
  paper,
  size,
  mono,
  uid,
  ref,
}: {
  frame: BotFrame;
  ink: string;
  paper: string;
  size: number;
  mono?: boolean;
  /** 一頁有好幾隻時,mask / 漸層的 id 要分開 */
  uid: string;
  ref?: React.Ref<SVGSVGElement>;
}) {
  const maskId = `bloub-mask-${uid}`;
  const dotEl = (d: Dot, key: string) =>
    d.d ? (
      <path
        key={key}
        data-bloub="dot"
        d={d.d}
        fill={dotFill(d, ink, paper, mono)}
        opacity={dotOpacity(d, mono)}
        transform={dotTransform(d)}
      />
    ) : (
      <circle
        key={key}
        data-bloub="dot"
        cx={d.x}
        cy={d.y}
        r={d.r}
        fill={dotFill(d, ink, paper, mono)}
        opacity={dotOpacity(d, mono)}
      />
    );

  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
      aria-hidden="true"
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-VB} y={-VB} width={VB * 2} height={VB * 2}>
          <path data-bloub="mask-body" d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, i) => (
            <path key={i} data-bloub="eye" d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />
          ))}
          {frame.notch && (
            <circle data-bloub="notch" cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />
          )}
        </mask>
        {!mono &&
          frame.arcs.map((arc) => (
            <linearGradient
              key={arc.id}
              data-bloub="grad"
              id={`${uid}-${arc.id}`}
              gradientUnits="userSpaceOnUse"
              x1={arc.grad.x1}
              y1={arc.grad.y1}
              x2={arc.grad.x2}
              y2={arc.grad.y2}
            >
              {arc.grad.stops.map((c, i) => (
                <stop key={i} offset={i / (arc.grad.stops.length - 1)} stopColor={c} />
              ))}
            </linearGradient>
          ))}
      </defs>

      {/* 軌道環的後半圈:畫在身體之前,被身體擋住 */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`b${arc.id}`}
            data-bloub="back"
            d={arc.back}
            stroke={arcStroke(uid, arc.id, ink, mono)}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>

      {frame.dotsBehind && <g>{frame.dots.map((d, i) => dotEl(d, `pb${i}`))}</g>}

      <g data-bloub="alpha" opacity={frame.bodyAlpha}>
        {/* 身體墊片:眼睛是洞,洞裡看到的就是這一層 */}
        <path data-bloub="pad" d={frame.bodyPath} fill={paper} />
        <g mask={`url(#${maskId})`}>
          <rect data-bloub="ink" x={-VB} y={-VB} width={VB * 2} height={VB * 2} fill={ink} />
        </g>
      </g>

      {!frame.dotsBehind && <g>{frame.dots.map((d, i) => dotEl(d, `pf${i}`))}</g>}

      {frame.notif && (
        <circle data-bloub="notif" cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={notifFill(ink, mono)} />
      )}

      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`f${arc.id}`}
            data-bloub="front"
            d={arc.front}
            stroke={arcStroke(uid, arc.id, ink, mono)}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>
    </svg>
  );
}
