/**
 * 載入中的那張動畫(整頁與每一塊區域的載入都用它)。
 *
 * **一陣風吹過**:一群細短的線條由左往右流過去,深淺不一、速度不一,邊緣淡進淡出。
 *
 * ⚠️ 設計前提是「載入很快,所以不用看得太清楚」:
 *   線很細、透明度很低、刻意不畫出明確的形狀 —— 它只要讓人感覺到「有東西在動」,
 *   不需要被看懂。想加密、加亮、加形狀之前先回來讀這一句。
 *
 * 跟另外兩組場景同一套規矩:
 *   - 顏色由外面用 Astryx token 解好餵進來(這個檔案裡不出現色碼),換佈景就 `setPalette`;
 *   - `prefers-reduced-motion` 只畫一格,不開 RAF;
 *   - 分頁切到背景、或捲出視線(`IntersectionObserver`,比照 `LoginScene`)就停畫;
 *     離開一定 dispose(geometry / material / renderer / canvas)。
 *
 * three 走動態 import,跟登入頁共用同一個 chunk。
 */
import type * as THREE_NS from 'three';

export type LoadingPalette = {
  /** 線條的顏色(`--color-accent`) */
  accent: string;
  /** 底色(`--color-background-body`)—— 線條最淡的那一端往它靠 */
  background: string;
};

export type LoadingHandle = {
  setPalette: (palette: LoadingPalette) => void;
  dispose: () => void;
};

/**
 * 幾條線(預設;區塊版由 `LoadingScreen` 照面積比例傳更少)。**刻意少** —— 每一塊區域的載入都會跑(包含手機),
 * 而且「不用太清楚」本來就不需要填滿畫面。
 * 一條線 = 2 個頂點,所以這裡是 560 個頂點。
 */
const COUNT = 280;
/**
 * 相機左右邊界的**初值**,也是第一批線撒下去的範圍。
 *
 * ⚠️ **這不是「視野的半寬」。** 真正的半寬是 `resize()` 從長寬比算出來的
 * `camera.right`,只有長寬比剛好 ~2.0 的時候才等於這個數字。
 * 線條回頭的邊界一律讀底下那個 `edge`(它跟著 `camera.right` 走)。
 * 寫死 `X_EDGE` 的話,手機上舞台約 350×380、可視半寬只有 0.57,線卻要跑到 1.25 才回頭,
 * **一大半的行程在畫面外空跑**,看起來就是「手機上幾乎沒有風」。
 */
const X_EDGE = 1.25;
/** 視野的半高。這一個是真的固定的 —— `resize()` 只動左右。 */
const Y_EDGE = 0.62;

export async function createLoadingScene(
  host: HTMLElement,
  palette: LoadingPalette,
  reducedMotion: boolean,
  /** 幾條線。預設 `COUNT`;小舞台(`LoadingScreen` 的 `isCompact`)照面積比例少給,密度才跟大的一樣 */
  count: number = COUNT,
): Promise<LoadingHandle> {
  const THREE: typeof THREE_NS = await import('three');

  /*
   * ⚠️ `alpha: true` + 透明的 clear color:底色交給 `LoadingScreen` 的 `fullPage`
   * (整頁載入畫面自己畫底)。場景自己再畫一次底的話,兩邊要各自維護同一個 token。
   */
  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, powerPreference: 'low-power'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const canvas = renderer.domElement;
  // 淡進來,不要硬切(規則在 `global.css` 的 `[data-scene-fade]`)。
  canvas.dataset.sceneFade = '';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  /*
   * 正交相機:風是一層平的東西,不需要透視。
   * 用固定的世界座標範圍,`resize` 只改相機的左右邊界 —— 這樣線的粗細與長度
   * 在任何視窗寬度下看起來都一樣(透視相機會讓它們隨著距離變形)。
   */
  const camera = new THREE.OrthographicCamera(-X_EDGE, X_EDGE, Y_EDGE, -Y_EDGE, 0.1, 10);
  camera.position.z = 1;
  /** 目前的可視半寬 —— 撒點、回頭、羽化三處都讀它,`resize()` 負責更新。 */
  let edge = X_EDGE;

  /** 每一條線自己的狀態。`depth` 同時決定速度與濃淡 —— 遠的慢而且淡。 */
  const streaks = Array.from({length: count}, () => {
    const depth = Math.random();
    return {
      x: (Math.random() * 2 - 1) * edge,
      y: (Math.random() * 2 - 1) * Y_EDGE,
      depth,
      // 遠的短、近的長。快的同時也長一點 —— 那是「拖出殘影」的感覺,不是一根根短棒
      len: 0.06 + depth * 0.22,
      /*
       * 遠的慢、近的快:這個差距就是「風有厚度」的來源。
       *
       * ⚠️ **這組數字是照「載入通常不到一秒」定的**。橫越一趟是 `2 × edge`,
       * 而 `edge` 跟著舞台的長寬比走:桌機那塊 720×380 約 2.35,所以 1.0 → 約 2.4 秒、
       * 3.2 → 約 0.7 秒 —— **最快的那幾條在畫面存活的期間內就吹得完一趟**。
       * 手機更窄,只會更快。
       * 速度若只有 0.1–0.6,橫越要 4–21 秒 —— 在一秒的視窗裡等於不會動,
       * 看起來只是一片靜止的線。調慢之前先想想它只被看得到多久。
       */
      speed: 1.0 + depth * 2.2,
      // 上下飄的相位與幅度,讓它不是一條直線
      phase: Math.random() * Math.PI * 2,
      drift: 0.004 + Math.random() * 0.012,
    };
  });

  const positions = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    /*
     * ⚠️ 整體很淡是**刻意的**(見檔頭的設計前提)。
     * 再加上每一條自己的濃淡(`depth`)與頭尾的漸層,最遠那幾條幾乎看不見 ——
     * 那正是「風」而不是「一堆線」的原因。
     * 實際的值在 `applyOpacity()` 決定 —— **深淺兩色不一樣**,理由寫在那裡。
     */
    depthWrite: false,
  });
  scene.add(new THREE.LineSegments(geometry, material));

  let head = new THREE.Color(palette.accent);
  /** 尾巴那一端:往底色靠,所以每一條都是「濃 → 無」的一抹。 */
  let tail = new THREE.Color(palette.background);

  /**
   * 整體濃度**跟著底色的亮度走**,深淺兩色不能用同一個數字。
   *
   * **同樣的淡在兩種底上讀起來差很多**:深底上一抹亮線很容易看見(眼睛對暗處的亮點敏感),
   * 淺底上同樣淡的線幾乎溶進背景。這個佈景的 accent 是藍的(`#0074e2` 那一類),
   * 把它往近白的底色混,更是一下就沒了。
   *
   * ⚠️ 判斷**從 palette 算**,不要去讀 `data-theme` 或 `prefers-color-scheme` ——
   * 場景裡不准出現色碼,也不該知道「現在是哪個佈景」;它只需要知道「我畫在亮的還是暗的上面」。
   *
   * ⚠️ **門檻是 linear 的 0.2,不是 0.5。** three 從 r152 起預設開 `ColorManagement`
   * (`ColorManagement.enabled === true`),`new THREE.Color('#…')` 存進去
   * 已經是 **linear-sRGB**,不是網頁上那個 0–255 的值。而 0.2126/0.7152/0.0722 正是
   * **linear 值**的相對亮度公式,所以 `lum` 算出來就是 Y。
   * 寫 `> 0.5` 的話門檻會落在 sRGB 的 ~0.74:中灰的底(`#808080`,Y ≈ 0.216)
   * 會被判成「暗」而拿到深色那份 0.34,整片直接消失。0.2 對應 sRGB 的 ~0.5,
   * 才是真的中點(`#fafafa` Y=0.956、`#1a1a1a` Y=0.010)。
   */
  const applyOpacity = () => {
    // 相對亮度 Y(linear-sRGB;為什麼不是 sRGB 見上面)
    const lum = 0.2126 * tail.r + 0.7152 * tail.g + 0.0722 * tail.b;
    // 0.9 / 0.34:兩個數字差這麼多是刻意的 —— 見上面那段「同樣的淡在兩種底上讀起來差很多」。
    material.opacity = lum > 0.2 ? 0.9 : 0.34;
  };
  applyOpacity();

  /**
   * 每一格重算顏色。**每條線的濃度 = 自己的遠近 × 邊緣的羽化。**
   *
   * ⚠️ 羽化是這張圖的關鍵:沒有它的話那群線被相機的邊界切成一個**矩形**,
   * 看起來是「一塊線」不是一陣風。
   * 上下靠 `|y|` 淡掉、左右各留一段淡入淡出,線就沒有「開始」與「結束」的位置。
   *
   * 淡到最後是**混到底色**而不是調透明度:`LoadingScreen` 的底也是同一個 token
   * (`--color-background-body`),混過去等於看不見,不必為了 alpha 多開一條通道。
   */
  const writeColors = () => {
    const half = Math.max(0.001, edge);
    for (let i = 0; i < count; i += 1) {
      const s = streaks[i];
      // 遠的淡。下限壓到 0.12:最遠那一批幾乎只是底色上的一點點擾動
      let k = 0.12 + s.depth * 0.88;
      // 上下羽化:中間最濃,越靠上下邊界越淡
      const fy = 1 - Math.min(1, Math.abs(s.y) / Y_EDGE) ** 1.6;
      // 左右羽化:兩側各留 35% 的淡入淡出帶
      const fx = Math.min(1, (1 - Math.min(1, Math.abs(s.x) / half)) / 0.35);
      k *= fy * Math.max(0, fx);
      const o = i * 6;
      // 尾巴再淡一階,所以每一條都是「濃 → 無」的一抹
      colors[o] = tail.r + (head.r - tail.r) * k * 0.15;
      colors[o + 1] = tail.g + (head.g - tail.g) * k * 0.15;
      colors[o + 2] = tail.b + (head.b - tail.b) * k * 0.15;
      colors[o + 3] = tail.r + (head.r - tail.r) * k;
      colors[o + 4] = tail.g + (head.g - tail.g) * k;
      colors[o + 5] = tail.b + (head.b - tail.b) * k;
    }
    geometry.attributes.color.needsUpdate = true;
  };

  let raf = 0;
  let last = performance.now();
  let t = 0;
  let alive = true;
  /** 分頁在背景 */
  let hidden = document.hidden;
  /** 舞台在視線內(`IntersectionObserver`,見底下) */
  let onScreen = true;
  let paused = hidden;

  function frame(now: number) {
    if (!alive) return;
    // 停了就連這一格都不畫(停下來那一刻佇列裡可能還躺著一支);減少動態的單格(resize / 換色)照畫
    if (paused && !reducedMotion) return;
    // 上限 50ms:分頁切回來的第一幀 dt 很大,不夾的話整片會瞬移
    // (跟 `lib/frameEase.ts` 的 `MAX_FRAME_GAP_MS` 同一個判斷)
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;

    for (let i = 0; i < count; i += 1) {
      const s = streaks[i];
      s.x += s.speed * dt;
      // 吹過頭就從左邊回來,順便換一個高度 —— 不然會看出它在繞圈
      if (s.x - s.len > edge) {
        s.x = -edge - s.len;
        s.y = (Math.random() * 2 - 1) * Y_EDGE;
      }
      const y = s.y + Math.sin(t * (0.7 + s.depth) + s.phase) * s.drift;
      const o = i * 6;
      positions[o] = s.x - s.len;
      positions[o + 1] = y;
      positions[o + 2] = 0;
      positions[o + 3] = s.x;
      positions[o + 4] = y;
      positions[o + 5] = 0;
    }
    geometry.attributes.position.needsUpdate = true;
    writeColors();
    renderer.render(scene, camera);

    if (alive && !reducedMotion && !paused) raf = requestAnimationFrame(frame);
  }

  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    // 高度固定、左右跟著長寬比走 —— 視窗變寬就看到更長的一段風,不是把它拉扁
    const half = (Y_EDGE * w) / h;
    edge = half;
    camera.left = -half;
    camera.right = half;
    camera.updateProjectionMatrix();
    // 減少動態時沒有迴圈會接手,而 `setSize` 會清掉畫面 —— 自己補一格
    if (reducedMotion) frame(performance.now());
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  /** 分頁在背景或捲出視線就停;兩個都回來了才接著畫 */
  const updatePaused = () => {
    paused = hidden || !onScreen;
    if (!paused && alive && !reducedMotion) {
      last = performance.now();
      // ⚠️ 先取消再排:分頁切走時瀏覽器只是不叫 rAF,**上一支還躺在佇列裡**
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    }
  };
  const onVisibility = () => {
    hidden = document.hidden;
    updatePaused();
  };
  document.addEventListener('visibilitychange', onVisibility);
  /*
   * 捲出視線也停。每一塊區域的載入都是這張風,
   * 管理頁一長排卡片同時在載入時,捲出去的那幾張不該照樣每一格跑 WebGL。
   * 比照 `LoginScene`;只在狀態真的翻過來時才動(observe 當下會先回報一次目前的狀態)。
   * 沒有 IntersectionObserver 的環境(測試的 jsdom)當成一直在視線內。
   */
  const intersectionObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (!entry || entry.isIntersecting === onScreen) return;
          onScreen = entry.isIntersecting;
          updatePaused();
        });
  intersectionObserver?.observe(host);

  // 先畫一格再讓迴圈接手:不先畫的話 canvas 進了 DOM 之後要等到下一個 rAF 才有東西,
  // 而那一格剛好跟 `[data-scene-fade]` 的淡入疊在一起 —— 等於淡入的前半段在淡一塊空白。
  // ⚠️ `frame()` 自己會在結尾排下一支(前提是 `paused` 這時候是 false),不要再排一次。
  frame(performance.now());

  return {
    setPalette(next) {
      head = new THREE.Color(next.accent);
      tail = new THREE.Color(next.background);
      applyOpacity();
      // 顏色在 `frame()` 裡每一格都會重算,所以這裡只要換掉兩端就好 ——
      // 但 reducedMotion 沒有下一格,得自己補一次。
      if (reducedMotion) frame(performance.now());
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      /*
       * ⚠️ `renderer.dispose()` **不會**放掉 WebGL context(three 只拆自己的快取與監聽),
       * 要等 GC。每一塊區域的載入都是風,翻檔案預覽、快速切頁會一直建新的,
       * 死掉但還沒被回收的 context 疊到瀏覽器上限(約 16)時,Chrome 會丟掉最舊的那個 ——
       * 可能是還活著的場景(例如同一頁另一塊還在載入的風)。主動 loseContext 就不會疊。
       */
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
