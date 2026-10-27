/**
 * 小夥伴閒著時怎麼「逛」。
 *
 * 不用「等速橫移、到底用 scaleX 翻面再滑回來」那種 CSS 動畫:兩隻角色都是**正面**朝向觀眾的
 * (小夥伴的 GIF 是正面站著、bloub 是一顆眼睛長在球面上的球),翻面在牠們身上不成立,
 * 腳不動就橫移則像在溜冰。
 *
 * 這裡只算「這一刻在哪、身體怎麼變形」,不碰 DOM、不管時鐘 —— 呼叫端每一格給 dt。
 *
 * 路線(三種走法共用):停一陣子 → 挑一個附近的點 → 預備動作 → 移過去(有起步有煞車)→ 穩住。
 * 走法(身體怎麼動):
 *   - `hop`  小夥伴:一小步一小步跳,起跳前蹲、落地壓扁,身體往前進方向微傾
 *   - `jelly` bloub 果凍滑行:眼睛先看向要去的方向,移動時順著速度拉長,停下來回彈晃兩下
 *   - `roll`  bloub 滾動:照距離轉(眼睛跟著轉一圈),停下來像不倒翁晃回正
 *   - `blob`  bloub 正式用的:上面兩種一趟換一趟
 *
 * 幅度刻意小 —— 這是每天開八小時的工作工具,牠只是在旁邊動一動,不是主角。
 */

/** 一趟用哪種走法 */
type TripStyle = "hop" | "jelly" | "roll";
/**
 * 角色用哪一套。`blob` = 果凍滑行與滾動**一趟換一趟**。
 * `jelly` / `roll` 單獨留著給對照頁用。
 */
export type WalkStyle = TripStyle | "blob";

export interface WalkFrame {
  /** 水平位移(px),0 = 家(右下角的位置),負 = 往左 */
  x: number;
  /** 垂直位移(px),負 = 往上(跳起來) */
  y: number;
  /** 水平 / 垂直縮放(壓扁拉長),以腳底為基準 */
  sx: number;
  sy: number;
  /** 旋轉(度)。hop / jelly 是傾斜,roll 是滾動的角度 */
  rot: number;
  /** 眼睛看向哪邊(-1 左、1 右);null = 不指定(交給游標) */
  lookX: number | null;
  /** 正在移動(含預備與穩住)—— 這段時間不要讓狀態動畫插進來 */
  moving: boolean;
}

interface Options {
  /** 可以去的範圍(相對家的位移,px),例如 [-200, 0] */
  range: [number, number];
  /** 時間倍率(模擬頁用來快轉),預設 1 */
  speed?: number;
  /** 亂數來源(測試用) */
  random?: () => number;
}

/**
 * bloub 在 112px 框裡的球半徑(px):112 × 100 / 316(引擎的 viewBox 半徑 158、球半徑 100)。
 * 滾動的角度 = 距離 / 半徑;`usePetWander` 也拿它當壓扁的基準(球底)。
 */
export const BALL_R = 35.4;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

type Phase =
  | { kind: "rest"; until: number }
  | { kind: "prep"; until: number; to: number }
  | { kind: "move"; from: number; to: number; t0: number; dur: number; rot0: number }
  | { kind: "settle"; t0: number; dir: number; rotFrom: number; rotTo: number };

/** 每種走法的個性參數 */
const STYLE = {
  // 小夥伴:步子小、節奏明快,停得比較久(牠是會四處張望的那種)
  hop: { speed: 70, prep: 0.22, settle: 0.35, rest: [4, 10] as const },
  // 果凍:滑得比較快、預備比較長(先看一眼才出發),停下來晃比較久
  jelly: { speed: 90, prep: 0.5, settle: 0.7, rest: [3, 9] as const },
  // 滾動:慢一點才看得清楚眼睛在轉,停下來的不倒翁晃最久
  roll: { speed: 75, prep: 0.3, settle: 1.1, rest: [4, 10] as const },
};

/** 一跳多遠、多久、多高(幅度刻意小,見檔頭) */
const HOP_LEN = 22;
const HOP_DUR = 0.3;
const HOP_H = 4;
/** 跳的時候壓扁 / 拉長多少、往前傾幾度 */
const HOP_SQUASH = 0.05;
const HOP_STRETCH = 0.03;
const HOP_LEAN = 2;

export class Wanderer {
  private t = 0;
  private x = 0;
  private rot = 0;
  private phase: Phase;
  private readonly mode: WalkStyle;
  /** 這一趟用的走法(`blob` 每趟換一次) */
  private style: TripStyle;
  private trips = 0;
  private range: [number, number];
  private readonly speed: number;
  private readonly random: () => number;

  constructor(style: WalkStyle, opts: Options) {
    this.mode = style;
    this.style = style === "blob" ? "jelly" : style;
    this.range = opts.range;
    this.speed = opts.speed ?? 1;
    this.random = opts.random ?? Math.random;
    // 一開場先站一下,不要一掛上去就跑
    this.phase = { kind: "rest", until: 1.5 + this.random() * 2 };
  }

  /** 範圍變了(被拖到別處、視窗變窄)。正在走的這一趟照走,下一趟才用新範圍 */
  setRange(range: [number, number]) {
    this.range = range;
  }

  /**
   * 回到家、從頭開始停一陣子。被拖走的那一刻用:拖曳量的是畫面上看到的位置(含位移),
   * 釘好之後位移必須歸零,不然會被推開一次。
   */
  reset() {
    this.x = 0;
    this.rot = 0;
    this.phase = { kind: "rest", until: this.t + 1.5 + this.random() * 2 };
  }

  /**
   * 被打斷(不是閒晃了、滑鼠指著牠):停在**現在的位置**,身體回正,從頭停一陣子。
   * 呼叫端會把身體那層的 transform 清掉 —— 不同步歸零的話,滾到一半(例如 137°)被打斷,
   * 回來時會從 0° 一下跳回 137°。
   */
  interrupt() {
    this.rot = 0;
    this.phase = { kind: "rest", until: this.t + this.restFor() };
  }

  /** 前進 dt 秒,回傳這一刻的樣子 */
  step(dt: number): WalkFrame {
    this.t += dt * this.speed;
    const t = this.t;
    const cfg = STYLE[this.style];
    const p = this.phase;

    switch (p.kind) {
      case "rest": {
        if (t >= p.until) {
          if (this.mode === "blob") this.style = this.trips++ % 2 === 0 ? "jelly" : "roll";
          this.phase = { kind: "prep", until: t + STYLE[this.style].prep, to: this.pickTarget() };
        }
        return this.still(null);
      }
      case "prep": {
        const dir = Math.sign(p.to - this.x) || 1;
        if (t >= p.until) {
          const dist = Math.abs(p.to - this.x);
          const dur =
            this.style === "hop" ? Math.max(1, Math.round(dist / HOP_LEN)) * HOP_DUR : dist / cfg.speed + 0.35;
          this.phase = { kind: "move", from: this.x, to: p.to, t0: t, dur, rot0: this.rot };
          return this.still(this.style === "jelly" ? dir : null);
        }
        const k = 1 - (p.until - t) / cfg.prep; // 0 → 1
        if (this.style === "hop") {
          // 起跳前蹲一下
          const c = Math.sin(k * Math.PI) * HOP_SQUASH;
          return { x: this.x, y: 0, sx: 1 + c * 0.6, sy: 1 - c, rot: 0, lookX: null, moving: true };
        }
        if (this.style === "jelly") {
          // 眼睛先轉過去,身體往反方向縮一下蓄力
          const c = Math.sin(k * Math.PI) * 0.06;
          return { x: this.x - dir * c * 30, y: 0, sx: 1 - c, sy: 1 + c * 0.5, rot: 0, lookX: dir, moving: true };
        }
        return this.still(null, true);
      }
      case "move": {
        const k = clamp01((t - p.t0) / p.dur);
        const dir = Math.sign(p.to - p.from) || 1;
        if (k >= 1) {
          this.x = p.to;
          const rotTo = this.style === "roll" ? Math.round(this.rot / 360) * 360 : 0;
          this.phase = { kind: "settle", t0: t, dir, rotFrom: this.rot, rotTo };
          return this.step(0);
        }
        if (this.style === "hop") return this.hopFrame(p.from, p.to, k, p.dur, dir);
        const e = easeInOutCubic(k);
        this.x = p.from + (p.to - p.from) * e;
        // 速度(0~1):easeInOutCubic 的導數在中點最大 = 1.5
        const v = Math.min(1, Math.abs(6 * (k < 0.5 ? k * k : (1 - k) * (1 - k))) / 1.5);
        if (this.style === "roll") {
          this.rot = p.rot0 + ((this.x - p.from) / BALL_R) * (180 / Math.PI);
          return { x: this.x, y: 0, sx: 1, sy: 1, rot: this.rot, lookX: null, moving: true };
        }
        // jelly:順著速度拉長、往前傾一點
        const s = 1 + 0.16 * v;
        return { x: this.x, y: 0, sx: s, sy: 1 / s, rot: dir * 4 * v, lookX: dir, moving: true };
      }
      case "settle": {
        const k = (t - p.t0) / cfg.settle;
        if (k >= 1) {
          this.rot = p.rotTo;
          this.phase = { kind: "rest", until: t + this.restFor() };
          return this.still(null);
        }
        const time = t - p.t0;
        if (this.style === "roll") {
          // 不倒翁:從停下來的角度晃回最近的正面
          this.rot = p.rotTo + (p.rotFrom - p.rotTo) * Math.exp(-4 * time) * Math.cos(9 * time);
          return { x: this.x, y: 0, sx: 1, sy: 1, rot: this.rot, lookX: null, moving: true };
        }
        if (this.style === "jelly") {
          // 煞車:先往前擠扁再彈回,晃兩下
          const w = -0.14 * Math.exp(-5 * time) * Math.cos(14 * time);
          const sx = 1 + w;
          return {
            x: this.x,
            y: 0,
            sx,
            sy: 1 / sx,
            rot: -p.dir * 3 * Math.exp(-6 * time) * Math.cos(14 * time),
            lookX: k < 0.6 ? p.dir : null,
            moving: true,
          };
        }
        // hop:最後一跳落地的餘震
        const c = HOP_SQUASH * 0.8 * Math.exp(-9 * time) * Math.cos(20 * time);
        return { x: this.x, y: 0, sx: 1 + c * 0.6, sy: 1 - c, rot: 0, lookX: null, moving: true };
      }
    }
  }

  private hopFrame(from: number, to: number, k: number, dur: number, dir: number): WalkFrame {
    const hops = Math.max(1, Math.round(dur / HOP_DUR));
    const f = k * hops;
    const i = Math.min(hops - 1, Math.floor(f));
    const h = f - i; // 這一跳的進度 0~1
    const per = (to - from) / hops;
    // 每一跳裡水平是緩進緩出:在空中走,落地時腳停
    this.x = from + per * (i + easeInOutSine(h));
    const y = -HOP_H * Math.sin(Math.PI * h);
    // 離地拉長、落地壓扁
    let sx = 1;
    let sy = 1;
    if (h < 0.15) {
      const c = (1 - h / 0.15) * HOP_SQUASH;
      sx = 1 + c * 0.6;
      sy = 1 - c;
    } else if (h < 0.5) {
      const c = Math.sin(((h - 0.15) / 0.35) * Math.PI) * HOP_STRETCH;
      sx = 1 - c * 0.5;
      sy = 1 + c;
    }
    return { x: this.x, y, sx, sy, rot: dir * HOP_LEAN, lookX: null, moving: true };
  }

  private still(lookX: number | null, moving = false): WalkFrame {
    return { x: this.x, y: 0, sx: 1, sy: 1, rot: this.rot, lookX, moving };
  }

  private restFor() {
    const [a, b] = STYLE[this.style].rest;
    return a + this.random() * (b - a);
  }

  /** 範圍內挑一個點,至少離現在 50px(太近的話看起來像抖了一下) */
  private pickTarget(): number {
    const [lo, hi] = this.range;
    for (let i = 0; i < 8; i++) {
      const to = lo + this.random() * (hi - lo);
      if (Math.abs(to - this.x) >= 50) return Math.round(to);
    }
    // 範圍太窄:往離自己最遠的那一端
    return Math.abs(lo - this.x) > Math.abs(hi - this.x) ? lo : hi;
  }
}
