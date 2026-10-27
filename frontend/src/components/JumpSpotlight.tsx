/**
 * 「跳到這一則」之後,在那一則周圍繞一圈彩虹。
 *
 * 效果比照 godui 的 **magic-input**:**只有一圈在流動的柔光**,沒有硬邊環。
 *
 * 三條規則,**不要憑感覺調**:
 *
 *   1. **四邊都要滿**。⚠️ 不要做「重心在下緣」的遮罩。
 *   2. **顏色要順**:漸層走 `in oklab` 插值(sRGB 直插在紅↔綠之間會經過濁色),
 *      而且拉寬到 `GRADIENT_WIDTH`、把一趟放慢到 `SWEEP_S` ——
 *      同一段時間裡經過的色相少了,看起來是「在流動」不是「在閃」。
 *   3. **要圓**:半徑吃 `MIN_RADIUS_PX` 的下限。目標自己的圓角很小
 *      (ghost 泡泡幾乎是方的),照抄就會畫出方框。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 環是怎麼「只有邊」的
 * ─────────────────────────────────────────────────────────────────────
 * 用 **mask-composite 的兩層遮罩**(gradient-border 的標準做法):
 * 整塊塗滿漸層,然後用「整塊」減掉「內容框」,剩下的正好是 padding 那一圈。
 *
 * 為什麼不用 magic-input 自己那招(在底下墊一塊比較大的、讓邊緣露出來):
 * 那要求前景是**不透明**的。我們要圈的是聊天泡泡,而 AI 回答那顆是
 * `variant="ghost"` —— 透明的,墊在底下的漸層會整片透出來蓋住字。
 * 遮罩版不管前景長怎樣都只畫邊。
 */
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Stack} from '@astryxdesign/core/Layout';

import {RAINBOW_COLORS} from '../lib/rainbow';
import {JUMP_SPOTLIGHT, type JumpSpotlightDetail} from '../lib/jumpSpotlight';

/*
 * 這一圈的幾何。
 * ⚠️ 這幾個是**量出來的視覺值,沒有對應的 token** —— 設計系統沒有「光暈」
 * 這種東西的尺度。抽成具名常數而不是散在樣式裡,是為了讓下次要調的人
 * 一眼看到全部的旋鈕(跟 `PetCompanion` 的 `PET_SIZE_PX` 同一個處置)。
 */
/**
 * 環往外站多遠。
 *
 * 要留呼吸空間,不能跟泡泡貼在一起 —— 14 是一整格 `--spacing-3` 再多一點(6 太貼)。
 * ⚠️ 這個值一改,`global.css` 的 `[data-jump-anchor]` 那個
 * `scroll-margin-block-start` 也要夠大,不然框的上半會被捲動容器切掉
 *(那邊的註解寫著它同時是「彩虹框的呼吸空間」)。
 */
const RING_OFFSET_PX = 14;
/**
 * 柔光的環寬與模糊(參考圖那種「光是從框後面透出來」的樣子,
 * 不是「框旁邊有一條亮邊」)。⚠️ blur 要小於等於 `RING_OFFSET_PX`,
 * 不然光會糊到泡泡的字上面。
 *
 * 視覺上的粗細 ≈ 環寬 + 模糊,要調細兩個都要降,只降一個看不出差別。
 */
const GLOW_WIDTH_PX = 6;
const GLOW_BLUR_PX = 12;
/**
 * 柔光的濃度。四邊都要看得出來,太淡就等於沒做;再往上就會在泡泡外面糊成一團。
 */
const GLOW_OPACITY = 0.72;

/**
 * 圓角的**下限**。放得比直覺大一階,
 * 因為框整個往外站了 14px,弧要跟著大才會像同心圓。
 * 目標自己的圓角照樣吃(加上 `RING_OFFSET_PX`),只是不低於這個值 ——
 * ghost 泡泡的圓角接近 0,照抄就會畫出一個直角方框。
 */
const MIN_RADIUS_PX = 22;

/** 亮多久:淡入 → 停留 → 淡出。跟 CSS 的 keyframes 百分比是同一組時間。 */
const SPOTLIGHT_MS = 2600;

/**
 * 彩虹跑一圈幾秒。
 * ⚠️ 這個值要比 `SPOTLIGHT_MS` 短,不然整段亮著的時間裡漸層只走了半趟,
 * 看起來像「顏色慢慢偏掉」而不是「一圈在繞」。
 */
const SWEEP_S = 2.1;

/**
 * 漸層拉多寬(一個週期 = 光圈寬的幾 %)。
 * 越寬 = 同一段畫面上同時看得到的色相越少 = 顏色轉得越柔。
 * 底下的 `SWEEP_PERIODS` / `TRACK_SCALE` 都從它算,改這一個就好。
 */
const GRADIENT_WIDTH = 300;

/*
 * ─────────────────────────────────────────────────────────────────────
 * 彩虹怎麼「流動」
 * ─────────────────────────────────────────────────────────────────────
 * 不在光圈那一層動 `backgroundPosition`:那不是合成屬性,而同一層又有 `filter: blur()`,
 * 每一幀都要在主執行緒重畫背景、再重算一次模糊,而這段時間使用者多半正在捲動。
 * 漸層畫在一條**加寬的子層**(`track`)上,動的是它的 `transform`;
 * 遮罩、模糊、圓角留在光圈那一層。子層被光圈的 `overflow: hidden` 切在框內,模糊的範圍只有框那麼大。
 *
 * 每一趟往左走 (PERIOD − 1) 個週期(等同 `backgroundPosition` 從 0% 走到 GRADIENT_WIDTH% 的距離)。
 * 子層寬度要多留一個框寬,滑到底時右緣才還蓋得住光圈;走的是整數個週期,所以一圈接一圈不會跳。
 */
/** 一個週期是光圈寬的幾倍 */
const PERIOD = GRADIENT_WIDTH / 100;
/** 每一趟(`SWEEP_S`)走幾個週期,見上面 */
const SWEEP_PERIODS = PERIOD - 1;
/** 子層是光圈寬的幾倍:滑完一趟的距離 + 一個框寬 */
const TRACK_SCALE = SWEEP_PERIODS * PERIOD + 1;
/** 子層的寬、一個週期在子層上佔幾 %、一趟往左滑幾 %(`translateX` 的百分比相對於子層自己) */
const TRACK_WIDTH = `${TRACK_SCALE * 100}%`;
const TRACK_PERIOD = `${(PERIOD / TRACK_SCALE) * 100}%`;
const TRACK_SHIFT = `translateX(-${((SWEEP_PERIODS * PERIOD) / TRACK_SCALE) * 100}%)`;

/**
 * 彩虹漸層。頭尾同色才接得起來(不然每一圈會有一條接縫)。
 *
 * `in oklab`:sRGB 直插在互補色之間會經過灰濁的中段(紅→綠尤其明顯),
 * oklab 是感知均勻的空間,同一組色碼插出來的中間色乾淨得多
 * (全站的 `color-mix` 也都指定這個空間,見 global.css)。
 *
 * ⚠️ 這個值**走 inline style,不能寫進 `stylex.create`**:StyleX 的編譯器
 * 只吃靜態值,`[...].join()` 會被判成 `Unsupported expression: CallExpression`,
 * 整包 build 直接失敗(`Chat.tsx` 的通知動畫時長也是同一個理由走 inline)。
 * 換句話說 —— 顏色留在 `lib/rainbow.ts` 那一份(全站只有一條彩虹),
 * 這裡只負責把它組成 CSS。
 */
const RAINBOW_GRADIENT = `linear-gradient(90deg in oklab, ${[...RAINBOW_COLORS, RAINBOW_COLORS[0]].join(', ')})`;
/** 滑動層的漸層設定(一個週期 = 光圈寬的 GRADIENT_WIDTH %,換算成子層的 % 見 TRACK_PERIOD) */
const RAINBOW_STYLE = {
  backgroundImage: RAINBOW_GRADIENT,
  backgroundSize: `${TRACK_PERIOD} 100%`,
} as const;

/** 往左滑整數個週期(見「彩虹怎麼流動」那段):只動 transform */
const slide = stylex.keyframes({
  from: {transform: 'translateX(0)'},
  to: {transform: TRACK_SHIFT},
});

/** 淡入 → 停留 → 淡出。百分比對應 SPOTLIGHT_MS。 */
const fade = stylex.keyframes({
  '0%': {opacity: 0},
  '7%': {opacity: 1},
  '72%': {opacity: 1},
  '100%': {opacity: 0},
});

const styles = stylex.create({
  /**
   * 定位殼:`fixed` 貼在視窗上,位置與尺寸由 JS 每一格量目標寫進 inline style。
   * ⚠️ `pointerEvents: none` 不能拿掉 —— 它蓋在訊息上面,擋住的話
   * 那一則的複製鈕、附件連結在這兩秒內都按不到。
   * z-index 見 global.css 開頭那張表(50)。
   */
  host: {
    position: 'fixed',
    insetBlockStart: 0,
    insetInlineStart: 0,
    zIndex: 50,
    pointerEvents: 'none',
    animationName: fade,
    animationDuration: `${SPOTLIGHT_MS}ms`,
    animationTimingFunction: 'linear',
    animationFillMode: 'forwards',
  },
  /**
   * 柔光的環:`padding` 是環寬,遮罩把中間挖掉只留邊,再整層模糊。
   * **只有這一層**(沒有硬邊環,見檔頭)。漸層本身畫在裡面那條 `track` 上。
   *
   * ⚠️ 遮罩不能拿掉:
   * 一整塊沒挖洞的漸層 `inset: 0` 加 blur 會疊在 z-50、
   * 蓋在整則訊息上面兩秒,把字糊掉。挖過洞之後只有邊在發光,中間是空的。
   * ⚠️ `WebkitMask*` 那兩行也要留著:Safari 還只認前綴版,
   * 少了它在 Safari 上會變成一塊實心的彩虹方塊蓋住整則訊息。
   */
  glow: {
    position: 'absolute',
    inset: 0,
    padding: GLOW_WIDTH_PX,
    // 加寬的 track 切在框內:模糊只算框這麼大(filter 是套在切過的結果上)
    overflow: 'hidden',
    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    WebkitMaskComposite: 'xor',
    mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    maskComposite: 'exclude',
    filter: `blur(${GLOW_BLUR_PX}px)`,
    opacity: GLOW_OPACITY,
  },
  /**
   * 滑動的漸層層。漸層本身走 inline(見 RAINBOW_GRADIENT);拉寬了才有得滑,
   * 那是 magic-input 那個效果的核心。減少動態:不滑,只剩外殼的淡入淡出。
   */
  track: {
    position: 'absolute',
    insetBlock: 0,
    // 實體的 left 不是 inline-start:漸層是 90deg、滑的方向是 translateX,兩個都是實體方向
    left: 0,
    width: TRACK_WIDTH,
    animationName: {default: slide, '@media (prefers-reduced-motion: reduce)': 'none'},
    animationDuration: `${SWEEP_S}s`,
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
});

/** 一次點亮的目標。`nonce` 是重播的關鍵,見底下 `key` 的說明。 */
type SpotlightTarget = {el: HTMLElement; radius: number; nonce: number};

/**
 * 量目標實際佔的畫面範圍。
 *
 * ⚠️ **不能只用 `el.getBoundingClientRect()`**,不然 AI 回答的頭像框不進來。
 * `getBoundingClientRect` 回的是**border box**,
 * 溢出到外面的子元素不算 —— 而 AI 那顆頭像正是靠負邊距(`Chat.tsx` 的 `avatarBox`,
 * `margin-inline-start: -24px`)懸在內容欄左邊的留白裡,整顆都在 border box 外面。
 *
 * 所以要圈進來的東西自己標 `data-spotlight-include`,這裡把它們聯集起來。
 * 沒有寫成「聯集所有子孫」是因為那會把泡泡裡的絕對定位小東西(工具提示、
 * 浮層)一起算進去,框就會莫名其妙地變大。
 */
function measure(el: HTMLElement): DOMRect {
  const base = el.getBoundingClientRect();
  let {left, top} = base;
  let right = base.right;
  let bottom = base.bottom;
  for (const extra of el.querySelectorAll<HTMLElement>('[data-spotlight-include]')) {
    const r = extra.getBoundingClientRect();
    // 0×0 的(還沒排版、或被 display:none)不算 —— 它的 rect 是原點,會把框拉到左上角
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

export function JumpSpotlight() {
  const [request, setRequest] = useState<SpotlightTarget | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nonceRef = useRef(0);

  useEffect(() => {
    const onSpotlight = (event: Event) => {
      const {anchorId} = (event as CustomEvent<JumpSpotlightDetail>).detail;
      const el = document.getElementById(anchorId);
      // 找不到就當作沒這回事:對話還沒載完、或那一則已經被刪了
      if (!el) return;
      setRequest({
        el,
        // 圓角照目標自己的,但不低於 MIN_RADIUS_PX(見那個常數:照抄會很方)
        radius: Math.max(
          parseFloat(getComputedStyle(el).borderStartStartRadius) || 0,
          MIN_RADIUS_PX,
        ),
        nonce: ++nonceRef.current,
      });
    };
    window.addEventListener(JUMP_SPOTLIGHT, onSpotlight);
    return () => window.removeEventListener(JUMP_SPOTLIGHT, onSpotlight);
  }, []);

  /** 亮完就收 */
  useEffect(() => {
    if (!request) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setRequest(null), SPOTLIGHT_MS);
    return () => clearTimeout(timerRef.current);
  }, [request]);

  /**
   * 對準目標。
   *
   * ⚠️ **第一次一定要同步定位**(`useLayoutEffect`),不能只靠底下那個 rAF 迴圈:
   * 分頁在背景、視窗被蓋住時 rAF 一次都不會發 —— 那時候這一圈會以
   * 0×0 的尺寸畫在左上角(內嵌的瀏覽器面板就是不合成畫面的那種環境)。
   * rAF 迴圈只負責「跟著跑」:這兩秒裡使用者很可能還在捲動,
   * 只量一次的話那一圈會留在原地看著訊息滑走。
   */
  useLayoutEffect(() => {
    if (!request) return;
    // 上一次寫進去的寬高:只有變了才再寫(見 place)
    let lastWidth = -1;
    let lastHeight = -1;
    const place = () => {
      const host = hostRef.current;
      if (!host) return;
      // 含溢出到外面的頭像,見 measure()
      const rect = measure(request.el);
      host.style.transform = `translate3d(${rect.left - RING_OFFSET_PX}px, ${rect.top - RING_OFFSET_PX}px, 0)`;
      /*
       * 寬高是排版屬性,每一幀都寫的話瀏覽器每一幀都要重排這一層 —— 而這兩秒使用者
       * 多半正在捲動,位置在變、尺寸沒變。只有尺寸真的變了(視窗縮放、訊息重排)才寫。
       */
      const width = rect.width + RING_OFFSET_PX * 2;
      const height = rect.height + RING_OFFSET_PX * 2;
      if (width !== lastWidth) {
        host.style.width = `${width}px`;
        lastWidth = width;
      }
      if (height !== lastHeight) {
        host.style.height = `${height}px`;
        lastHeight = height;
      }
    };
    place();
    let raf = 0;
    const follow = () => {
      place();
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [request]);

  if (!request) return null;

  // 圓角比目標大一點(往外站了 RING_OFFSET_PX),弧才會跟泡泡同心
  const ringRadius = request.radius + RING_OFFSET_PX;

  // aria-hidden:純視覺的指路。「跳到哪一則」報讀軟體是靠焦點與內容知道的
  return (
    <Stack
      /*
       * ⚠️ `key` 掛 nonce:連點兩個檔案時,如果 React 重用同一個 DOM 節點,
       * 淡入淡出的 CSS animation **不會重跑** —— 使用者看到的是「第二次沒反應」。
       * 換 key 等於換一個新元素,動畫自然從頭開始。
       * (先 setState(null) 再排一個 rAF 設回去也做得到,但背景分頁沒有 rAF。)
       */
      key={request.nonce}
      ref={hostRef}
      aria-hidden
      xstyle={styles.host}
    >
      {/* 半徑走 inline 不用 `borderRadius: inherit`:host 的圓角是 JS 算出來的 */}
      <Stack xstyle={styles.glow} style={{borderRadius: ringRadius}}>
        <Stack xstyle={styles.track} style={RAINBOW_STYLE} />
      </Stack>
    </Stack>
  );
}
