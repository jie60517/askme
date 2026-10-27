/**
 * 品牌列長按彩蛋的動畫(Canvas 2D)。
 *
 * 精緻度靠的是 2D 本來就擅長的那幾件事:
 * - **DPR 縮放**:所有東西照 devicePixelRatio 畫,邊緣是實心的不是糊的
 *   (2D 動畫看起來廉價,九成是這一步沒做)。
 * - **玻璃感**:彩虹底 + 上緣白色高光 + 下緣壓暗的直向漸層,一條會發光的果凍。
 * - **流動**:一道柔和的反光沿著已填滿的部分來回掃,填頭有一圈呼吸的光暈。
 * - **彩帶**:三種形狀(緞帶 / 紙片 / 圓點)、真的重力與空氣阻力、
 *   緞帶靠水平縮放模擬翻面 —— 這是 2D 彩帶「像在飄」而不是「像在滑」的關鍵。
 *
 * ⚠️ 彩虹的色碼在 `lib/rainbow.ts`:跳轉那一圈也要用同一條,
 * 而從這個檔案 import 會把整包彩蛋拉進主 chunk —— 那條動態載入就白做了。
 * 誰能引用那條彩虹以 `lib/rainbow.ts` 那份為準(兩個宿主,其餘不得引用)。
 */

import {RAINBOW_COLORS} from '../lib/rainbow';

/** 爆發時噴幾片彩帶。 */
const CONFETTI_COUNT = 64;
/**
 * 彩帶活多久(秒)。外面的復原計時器(`BRAND_BURST_MS`)要比這個長一點。
 * 太短(約 1s)的話彩帶剛彈上去、落回膠囊高度就開始淡,還沒灑進側邊欄。
 * 畫布一路延伸到**視窗底部**(Sign out 底下),
 * 彩帶要真的落到底。從膠囊落到底約 1.4s(v₀≈-150、g=900、~685px),
 * 壽命 2.0s 讓它們著地時還是實心的,淡出(最後 30%)發生在落地之後。
 */
const BURST_LIFE_S = 2.0;
/** 重力(px/s²)。 */
const GRAVITY = 900;
/** 空氣阻力(每秒保留的速度比例)—— 少了它彩帶會像石頭一樣直直墜。 */
const DRAG = 0.62;

/**
 * easeOutCubic:只給**爆開那圈光環**與**放開時退回**用。
 * ⚠️ 長按的進度**不准**用它:半時就填到 87.5%,
 * 剩下的 750ms 只爬最後一截 —— 進度條在騙人,看起來「快好了」其實還要等一半。
 * 按住是在做決定,進度要等速、要誠實。
 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export type BrandHoldSceneOptions = {
  /** 長按要撐多久(毫秒)—— 進度的時鐘由場景自己走,跟元件的計時器同一個數 */
  holdMs: number;
  /** 膠囊在 host 座標系裡的位置(px,原點是 host 左上角) */
  capsule: {left: number; top: number; width: number; height: number};
};

export type BrandHoldScene = {
  /** 進度滿了,開始噴彩帶(由元件的計時器叫 —— 兩邊的時鐘要同源) */
  burst: () => void;
  /**
   * 中途放開:已填的那段在 `ms` 內 ease-out 退回 0(之後畫面是空的,等元件卸掉)。
   * 卸載的時間點由元件的計時器決定,跟 `burst` 一樣 —— 場景只管畫。
   */
  release: (ms: number) => void;
  dispose: () => void;
};

type Shape = 'ribbon' | 'strip' | 'dot';

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 自轉角與角速度 */
  rot: number;
  vrot: number;
  w: number;
  h: number;
  color: string;
  shape: Shape;
  /** 緞帶翻面用的相位與速度(水平縮放的來源) */
  flutter: number;
  flutterSpeed: number;
};

/**
 * 建動畫。拿不到 2D context(理論上不會)就回 null ——
 * 彩蛋沒了 app 不能跟著死,呼叫端要接受 null。
 */
export function createBrandHoldScene(
  host: HTMLElement,
  {holdMs, capsule}: BrandHoldSceneOptions,
): BrandHoldScene | null {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width === 0 || height === 0) return null;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  /*
   * ⚠️ DPR 一定要做:CSS 尺寸給 style、實際像素給 canvas.width,
   * 再把座標系縮回 CSS 像素。少了這一步,在 2x 螢幕上所有邊緣都是糊的 ——
   * 「2D 看起來很廉價」多半就是這個原因。上限 2 是效能與畫質的折衷。
   */
  const dpr = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.pointerEvents = 'none';
  ctx.scale(dpr, dpr);
  host.appendChild(canvas);

  const cap = capsule;
  const radius = cap.height / 2;

  /** 膠囊的圓角矩形路徑(填滿與裁切共用同一份) */
  const capsulePath = () => {
    ctx.beginPath();
    ctx.roundRect(cap.left, cap.top, cap.width, cap.height, radius);
  };

  /** 彩虹漸層:橫跨整條膠囊,而不是只跨已填滿的部分 —— 顏色的位置才不會隨進度亂跑 */
  const rainbow = ctx.createLinearGradient(cap.left, 0, cap.left + cap.width, 0);
  RAINBOW_COLORS.forEach((color, i) => {
    rainbow.addColorStop(i / (RAINBOW_COLORS.length - 1), color);
  });

  /** 玻璃感:上緣一道白高光、中段透明、下緣壓暗 */
  const glass = ctx.createLinearGradient(0, cap.top, 0, cap.top + cap.height);
  glass.addColorStop(0, 'rgba(255,255,255,0.45)');
  glass.addColorStop(0.45, 'rgba(255,255,255,0.06)');
  glass.addColorStop(0.55, 'rgba(0,0,0,0.02)');
  glass.addColorStop(1, 'rgba(0,0,0,0.12)');

  const startedAt = performance.now();
  let burstAt: number | null = null;
  /** 放開的那一刻、當時填到哪、退多久;null = 還按著 */
  let released: {at: number; from: number; ms: number} | null = null;
  const pieces: Piece[] = [];
  let raf: number | undefined;
  let disposed = false;
  let lastTime = startedAt;

  const spawnConfetti = () => {
    const originY = cap.top + cap.height / 2;
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const shape: Shape = i % 5 === 0 ? 'dot' : i % 3 === 0 ? 'strip' : 'ribbon';
      // 沿著膠囊整條噴,不是從一個點 —— 一個點噴出來像煙火,整條噴出來像拉炮
      const x = cap.left + Math.random() * cap.width;
      /*
       * ⚠️ **往上只彈一點點,主要是往兩側散開再落下**(拉炮,不是煙火)。
       * 品牌列就在視窗最頂端,上面沒有空間 —— 照煙火的上半圓噴
       * (初速 320~780 全朝上)的話,彩帶在 0.2 秒內就整批飛出畫布上緣,
       * 爆發後畫面上什麼都看不到。所以是小幅上彈 + 橫向散開,
       * 靠重力灑落(畫布一路延伸到視窗底,彩帶落到 Sign out 下面)。
       */
      const sideSpeed = 70 + Math.random() * 230;
      /*
       * 上彈初速的上限是**算出來的**,不是喜好:峰高 = v²/2g,
       * 290² / (2×900) ≈ 47px —— 而膠囊上方到畫布頂只有約 50px。
       * 再快就會有一批彩帶飛出上緣、消失一下再掉回來(閃一下,很醜)。
       * 落下的部分不必算得那麼緊:掉出下緣是預期的(它們就是要灑出去)。
       */
      pieces.push({
        x,
        y: originY,
        vx: (Math.random() < 0.5 ? -1 : 1) * sideSpeed,
        vy: -(110 + Math.random() * 180),
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 16,
        w: shape === 'dot' ? 3.5 + Math.random() * 2 : 5 + Math.random() * 4,
        h: shape === 'ribbon' ? 9 + Math.random() * 5 : shape === 'strip' ? 3 : 0,
        color: RAINBOW_COLORS[i % RAINBOW_COLORS.length],
        shape,
        flutter: Math.random() * Math.PI * 2,
        flutterSpeed: 6 + Math.random() * 8,
      });
    }
  };

  /** 等速:按了多久就填多少(理由見 easeOutCubic 的說明) */
  const holdProgress = (now: number) => Math.min(1, (now - startedAt) / holdMs);

  const drawProgress = (now: number) => {
    // 放開了就從放開那一刻的位置退回去:快出發、慢收尾,看得出是「退」而不是「消失」
    const progress = released
      ? released.from * (1 - easeOutCubic(Math.min(1, (now - released.at) / released.ms)))
      : holdProgress(now);
    const filled = cap.width * progress;
    const t = (now - startedAt) / 1000;

    ctx.save();
    capsulePath();
    ctx.clip();

    // 底:彩虹 + 玻璃層。整體壓到 0.4,底下的品牌字要一直讀得到
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = rainbow;
    ctx.fillRect(cap.left, cap.top, filled, cap.height);
    ctx.fillStyle = glass;
    ctx.fillRect(cap.left, cap.top, filled, cap.height);

    // 反光:一道柔和的白帶沿著已填滿的部分來回掃
    if (filled > 8) {
      const sweep = (Math.sin(t * 1.6) * 0.5 + 0.5) * filled;
      const band = ctx.createLinearGradient(
        cap.left + sweep - 26,
        0,
        cap.left + sweep + 26,
        0,
      );
      band.addColorStop(0, 'rgba(255,255,255,0)');
      band.addColorStop(0.5, 'rgba(255,255,255,0.5)');
      band.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = band;
      ctx.fillRect(cap.left, cap.top, filled, cap.height);
    }
    ctx.restore();

    // 填頭那圈呼吸的光暈:畫在裁切**外面**,才會微微溢出膠囊(發光的關鍵)
    if (progress > 0.02 && progress < 1) {
      const headX = cap.left + filled;
      const headY = cap.top + cap.height / 2;
      const pulse = 1 + 0.18 * Math.sin(t * 7);
      const r = cap.height * 0.85 * pulse;
      const glow = ctx.createRadialGradient(headX, headY, 0, headX, headY, r);
      const color = RAINBOW_COLORS[Math.min(
        RAINBOW_COLORS.length - 1,
        Math.floor(progress * RAINBOW_COLORS.length),
      )];
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(headX, headY, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  const drawBurst = (now: number, dt: number) => {
    const life = (now - (burstAt as number)) / 1000 / BURST_LIFE_S;

    // 一圈快速擴散的膠囊形光環:給爆開那一下「砰」的力道(前 30% 演完)
    if (life < 0.3) {
      const k = life / 0.3;
      const grow = 26 * easeOutCubic(k);
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - k);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(
        cap.left - grow,
        cap.top - grow,
        cap.width + grow * 2,
        cap.height + grow * 2,
        radius + grow,
      );
      ctx.stroke();
      ctx.restore();
    }

    // 後 30% 才淡出 —— 一出生就開始淡會像殘影,太早淡則是「還沒落下就不見了」
    const fade = life < 0.7 ? 1 : Math.max(0, 1 - (life - 0.7) / 0.3);
    const damp = Math.pow(DRAG, dt);

    for (const p of pieces) {
      p.vy += GRAVITY * dt;
      p.vx *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      p.flutter += p.flutterSpeed * dt;

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(0, 0, p.w, 0, Math.PI * 2);
        ctx.fill();
      } else {
        /*
         * 緞帶靠**水平縮放**模擬翻面(0 → 看到側邊 → 反面)。
         * 這是 2D 彩帶會「飄」的關鍵:只有旋轉的話,看起來像貼紙在滑。
         */
        ctx.scale(Math.max(0.12, Math.abs(Math.cos(p.flutter))), 1);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
  };

  const tick = () => {
    if (disposed) return;
    const now = performance.now();
    // dt 夾在 1/30:分頁凍結一陣子回來,一格補三秒的重力會把彩帶直接打出畫面
    const dt = Math.min(1 / 30, (now - lastTime) / 1000);
    lastTime = now;

    ctx.clearRect(0, 0, width, height);
    if (burstAt === null) drawProgress(now);
    else drawBurst(now, dt);

    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    burst: () => {
      if (burstAt !== null || released) return;
      burstAt = performance.now();
      spawnConfetti();
    },
    release: (ms: number) => {
      if (burstAt !== null || released) return;
      const now = performance.now();
      released = {at: now, from: holdProgress(now), ms: Math.max(1, ms)};
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (raf !== undefined) cancelAnimationFrame(raf);
      pieces.length = 0;
      canvas.remove();
    },
  };
}
