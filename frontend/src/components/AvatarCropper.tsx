/**
 * 頭像裁切:按 Change photo / Add photo 之後調整照片的大小跟位置。
 *
 * **看到的就是存下去的**:這塊圓形預覽跟最後那張 256px 走的是同一支
 * `drawAvatarCrop`(`lib/avatarImage.ts`)。分兩套繪圖的話,預覽跟結果會在
 * 邊界條件上慢慢漂開,而那種差異只有使用者會發現。
 *
 * ⚠️ **畫面上不放任何說明文字**(專案慣例:字幕 / 提示一律不要)——
 * 拖曳與拉桿自己會講話。用鍵盤的人靠 canvas 的 `aria-label` 與方向鍵,
 * 那句話只有報讀軟體聽得到。
 *
 * ⚠️ **這塊東西不能讓版面跳一下**:
 *  1. 圓形預覽跟它取代的 `Avatar size="xl"` **一樣大**(128px)——
 *     大小不同的話挑完照片那一瞬間頭貼會突然變大。
 *  2. 縮放的控制項**直立掛在圓圈旁邊**,不是在底下多長一列 ——
 *     多一列會把底下整疊設定往下推,使用者看到的就是「畫面震一下」。
 *     它用 `position: absolute` 掛在舞台外面,所以**不佔版面**,
 *     圓圈也就留在頭貼原本那個位置。
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import * as stylex from '@stylexjs/stylex';

import {Center} from '@astryxdesign/core/Center';
import {Stack} from '@astryxdesign/core/Stack';
import {Slider} from '@astryxdesign/core/Slider';

import {
  clampCrop,
  cropOvershoot,
  cropRect,
  drawAvatarCrop,
  MAX_ZOOM,
  MIN_ZOOM,
  NO_OVERSHOOT,
  type AvatarCrop,
  type AvatarSource,
  type CropOvershoot,
} from '../lib/avatarImage';
import {createPointerOwner} from '../lib/pointerOwner';
import {
  durationTokenMs,
  OVERDRAG_MAX_PX,
  prefersReducedMotion,
  tweenOut,
  unclampElastic,
} from '../lib/rubberband';
import {useSliderDrag} from './useSliderDrag';

/**
 * 圓形預覽的邊長(CSS px)。
 *
 * ⚠️ **這裡是少數幾個 px 說得通的地方**:canvas 的解析度本來就是像素數,
 * 而且它要跟著 `devicePixelRatio` 乘上去才不會糊。
 *
 * ⚠️ **128 = `Avatar size="xl"` 的實際尺寸**。
 * 這個數字必須跟它一致 —— 這塊預覽是**原地**取代那顆頭貼的,大小一不同,
 * 挑完照片的那一瞬間頭貼就會突然變大。
 * 設計系統升級之後 `xl` 變了,這裡要跟著量一次。
 */
export const PREVIEW_PX = 128;

/** 方向鍵一下移動幾個 CSS px。太小會讓人以為沒反應,太大會過頭。 */
const NUDGE_PX = 8;

/**
 * 拉桿的刻度。
 *
 * ⚠️ **0.01 不是 0.05**。
 * 倍率的範圍是 1~4、軌道約 112px —— 0.05 一格等於**拇指一次跳 1.9px**,
 * 拖起來就是一格一格的頓感。那不是效能問題,是刻度太粗;0.01
 * (一格 0.37px)才是連續的。
 */
const ZOOM_STEP = 0.01;

const styles = stylex.create({
  /*
   * 舞台:圓形預覽的尺寸,縮放那條軌道靠它定位(絕對定位掛在外面,不佔版面)。
   */
  stage: {
    position: 'relative',
    width: `${PREVIEW_PX}px`,
    height: `${PREVIEW_PX}px`,
  },
  /*
   * 縮放軌道:**貼在圓圈右邊、直立**。
   * ⚠️ `position: absolute` 是關鍵 —— 它不佔版面,所以圓圈仍然停在頭貼原本的
   * 正中央,底下那幾列也不會被往下推。改成一般的流排版就會讓版面震一下。
   */
  zoomRail: {
    position: 'absolute',
    insetInlineStart: '100%',
    marginInlineStart: 'var(--spacing-3)',
    /*
     * ⚠️ 上下各內縮一格:拉桿的**拇指是跨在軌道端點上的**(20px 高),
     * 軌道跟圓圈切齊的話最底下那一格會凸到圓圈下緣外面,壓在底下那排按鈕上。
     * 內縮之後拇指的行程完全留在圓圈的高度之內。
     */
    top: 'var(--spacing-2)',
    bottom: 'var(--spacing-2)',
    display: 'flex',
    alignItems: 'stretch',
  },
  /* 直立拉桿要自己撐滿軌道的高度,不然它會塌成 0。 */
  zoomSlider: {height: '100%'},
  /*
   * 圓形 —— 頭像本來就是圓的,方形預覽會讓人把四個角也算進去,存下來才發現被切掉。
   * `50%` 不是 `--radius-*` 上的一階,它是「一個圓」,跟 Avatar 自己那顆同一件事。
   * 寬高用 `PREVIEW_PX`:canvas 的尺寸本來就是像素數(見它的說明)。
   */
  preview: {
    width: `${PREVIEW_PX}px`,
    height: `${PREVIEW_PX}px`,
    borderRadius: '50%',
    backgroundColor: 'var(--color-background-muted)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    cursor: 'grab',
    // 按下去要變成「抓著」—— 拖曳互動的按下回饋,少了它只有一半
    ':active': {cursor: 'grabbing'},
    // 觸控要自己收:不關掉的話在手機上拖曳會被當成捲動
    touchAction: 'none',
    display: 'block',
  },
});

export function AvatarCropper({
  source,
  crop,
  onCropChange,
  xstyle,
}: {
  source: AvatarSource;
  crop: AvatarCrop;
  onCropChange: (crop: AvatarCrop) => void;
  /** 呼叫端掛的樣式(例如互換時的淡入,見 `AccountSettingsDialog`) */
  xstyle?: Parameters<typeof Center>[0]['xstyle'];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 拖縮放拉桿時要把拇指的過場關掉,見 `useSliderDrag`。 */
  const zoomDrag = useSliderDrag();
  /**
   * 這一次拖曳的起點(指標位置 + 當下的裁切中心)。null = 沒在拖。
   * `elastic`:這一趟能不能超界 —— `prefers-reduced-motion` 在按下去那一刻讀一次,
   * 不要每一個 pointermove 都去問 `matchMedia`。
   */
  const dragRef = useRef<{x: number; y: number; cx: number; cy: number; elastic: boolean} | null>(
    null,
  );
  /**
   * 這一次拖曳歸哪一根指標管(多點觸控保護,規則見 `lib/pointerOwner.ts`)。
   * 這塊是 `touch-action: none`,手機上很自然會想用雙指 —— 不擋的話第二根手指一按就覆寫起點,
   * 照片跳到另一根手指底下;任一根抬起也會把拖曳收掉。
   */
  const owner = useState(createPointerOwner)[0];
  /**
   * 拖過照片邊界的那一段(只畫在預覽上,見 `CropOvershoot`)。
   * 拖到邊界就硬停的話看起來像卡住;所以跟側邊欄的邊線一樣可以再拉一小段、越拉越沉,
   * 放手用一段短的 ease-out 收回來。ref 那一份給回彈的起點用(state 在閉包裡會是舊的)。
   */
  const [overshoot, setOvershootState] = useState<CropOvershoot>(NO_OVERSHOOT);
  const overshootRef = useRef<CropOvershoot>(NO_OVERSHOOT);
  const setOvershoot = useCallback((next: CropOvershoot) => {
    overshootRef.current = next;
    setOvershootState(next);
  }, []);
  /** 正在跑的回彈;下一次拖曳 / 方向鍵 / 卸載要先停掉它,不然兩邊搶著寫超界量。 */
  const cancelSpring = useRef<() => void>(() => {});
  useEffect(() => () => cancelSpring.current(), []);
  const stopSpring = () => {
    cancelSpring.current();
    cancelSpring.current = () => {};
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!owner.release(e)) return;
    dragRef.current = null;
    // 放手:超界那一段收回 0。`--duration-fast-max` 是「回應操作」那一級的上限 ——
    // 回彈是手放開那一下的回饋,不是一段要人看的動畫。
    const from = overshootRef.current;
    if (from.dx === 0 && from.dy === 0) return;
    stopSpring();
    cancelSpring.current = tweenOut(durationTokenMs('--duration-fast-max', 165), (k) =>
      setOvershoot(k === 0 ? NO_OVERSHOOT : {dx: from.dx * k, dy: from.dy * k}),
    );
  };
  // 換了一張照片:上一張的超界量沒有意義
  useEffect(() => {
    cancelSpring.current();
    setOvershoot(NO_OVERSHOOT);
  }, [source, setOvershoot]);

  // 每次裁切框變了就重畫。⚠️ 用 devicePixelRatio 撐解析度 —— 只設 CSS 尺寸的話
  // 在高解析螢幕上這塊預覽會明顯比旁邊的頭像糊。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(PREVIEW_PX * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawAvatarCrop(ctx, source, crop, px, overshoot);
  }, [source, crop, overshoot]);

  /**
   * 把「畫面上移動了幾 px」換成「裁切中心要移動幾個來源像素」。
   *
   * ⚠️ 比例是**裁切框的邊長 ÷ 預覽的邊長**,不是照片尺寸 ÷ 預覽尺寸:
   * 放大之後同樣拖一公分,照片上走的距離要跟著變短,不然放到 4 倍時
   * 輕輕一拖就飛到照片另一邊。
   * ⚠️ 方向要**相反**:拖曳是在搬照片,而我們動的是「看出去的那個框」。
   *
   * `elastic`:拖曳才給 —— 超過邊界的那一段算成橡皮筋的超界量
   * 畫在預覽上;**交出去的裁切框照樣是夾好的**。方向鍵不給,維持硬夾
   * (一下 8px 的離散步進,沒有「放手」那一刻可以回彈)。
   * `prefers-reduced-motion` 也不給(拖曳開始時讀好放在 `dragRef.elastic`):超界之後要靠一段動畫收回來,那正是要拿掉的東西。
   */
  const moveBy = useCallback(
    (dxCss: number, dyCss: number, from: {cx: number; cy: number}, elastic = false) => {
      const scale = cropRect(source, crop).side / PREVIEW_PX;
      const raw = {zoom: crop.zoom, cx: from.cx - dxCss * scale, cy: from.cy - dyCss * scale};
      onCropChange(clampCrop(source, raw));
      if (elastic) {
        // 上限用畫面上的 px 算(跟側邊欄同一個 32),換回來源像素
        setOvershoot(cropOvershoot(source, raw, OVERDRAG_MAX_PX * scale));
      } else if (overshootRef.current !== NO_OVERSHOOT) {
        setOvershoot(NO_OVERSHOOT);
      }
    },
    [source, crop, onCropChange, setOvershoot],
  );

  return (
    /*
      ⚠️ **只有一層 `Center`,沒有第二列。** 縮放那條軌道是絕對定位掛在舞台外面的
      (見 `styles.zoomRail`)—— 它不佔版面,所以挑完照片之後這塊的高度跟原本那顆
      頭貼**完全一樣**,底下幾列一格都不會動。
    */
    <Center axis="horizontal" xstyle={xstyle}>
      <Stack xstyle={styles.stage}>
      <canvas
        ref={canvasRef}
        {...stylex.props(styles.preview)}
        tabIndex={0}
        /*
         * ⚠️ 不能用 `role="img"`:這塊是**可以操作的**,
         * 方向鍵會動它。報讀軟體念成「圖片」的話,用鍵盤的人根本不知道
         * 焦點停在一個能動的東西上面。`application` 會讓報讀軟體把按鍵
         * 直接交給頁面 —— 而我們要的正是方向鍵。
         */
        role="application"
        aria-label="Photo position. Drag, or use the arrow keys, to move the photo."
        onPointerDown={(e) => {
          // 已經有別的指標在拖(第二根手指、別種指標):不理。收尾漏了的話這一下接手重來
          if (owner.claim(e) === 'ignored') return;
          // ⚠️ 一定要 setPointerCapture:不抓的話指標一滑出圓形就收不到
          // pointermove,照片會卡在半路(而使用者的手還在動)。
          e.currentTarget.setPointerCapture(e.pointerId);
          // 上一次放手的回彈還沒跑完就又抓住:停在當下那一格,**從畫面上的位置接著拖**
          stopSpring();
          const elastic = !prefersReducedMotion();
          const o = overshootRef.current;
          let {cx, cy} = crop;
          if (elastic && (o.dx !== 0 || o.dy !== 0)) {
            /*
             * 把現在的超界量折回拖曳起點(直接歸零的話,預覽一碰就跳回邊界)。
             * 起點要是「拖到哪裡、經過橡皮筋之後剛好是現在這個超界量」的那個位置 ——
             * 用 `unclampElastic` 反推;第一個 pointermove 算出來的超界量就跟現在一樣,不會跳。
             */
            const safe = clampCrop(source, crop);
            const half = Math.min(source.width, source.height) / safe.zoom / 2;
            const limit = OVERDRAG_MAX_PX * (cropRect(source, crop).side / PREVIEW_PX);
            cx = unclampElastic(safe.cx + o.dx, half, source.width - half, limit);
            cy = unclampElastic(safe.cy + o.dy, half, source.height - half, limit);
          } else if (o !== NO_OVERSHOOT) {
            setOvershoot(NO_OVERSHOOT);
          }
          dragRef.current = {x: e.clientX, y: e.clientY, cx, cy, elastic};
        }}
        onPointerMove={(e) => {
          const start = dragRef.current;
          if (!start || !owner.owns(e)) return;
          moveBy(e.clientX - start.x, e.clientY - start.y, start, start.elastic);
        }}
        onPointerUp={(e) => {
          if (!owner.owns(e)) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          endDrag(e);
        }}
        onPointerCancel={endDrag}
        /*
         * 抓住的指標不管怎麼結束(放開、取消、被別的元素搶走)都一定會發這一下 ——
         * up / cancel 萬一被攔掉了,這裡照樣收得到,拖曳不會卡在「還有一根在拖」。
         */
        onLostPointerCapture={endDrag}
        onKeyDown={(e) => {
          /*
           * ⚠️ **方向要跟拖曳一致**。
           * 這裡給的是「等同於把指標往哪邊拖」的位移,而 `aria-label` 也是這樣
           * 講的(Drag, **or use the arrow keys**, to move the photo)——
           * 所以 ArrowLeft = 往左拖 = 照片往左跑。
           * 反過來寫的話,同一句話描述的兩種操作會做出相反的事。
           */
          const step: Record<string, [number, number]> = {
            ArrowLeft: [-NUDGE_PX, 0],
            ArrowRight: [NUDGE_PX, 0],
            ArrowUp: [0, -NUDGE_PX],
            ArrowDown: [0, NUDGE_PX],
          };
          const delta = step[e.key];
          if (!delta) return;
          // 方向鍵在對話框裡預設會捲動內容,按一下同時搬照片又捲畫面很怪
          e.preventDefault();
          stopSpring();
          moveBy(delta[0], delta[1], crop);
        }}
      />
        {/* `data-avatar-zoom` 是給 global.css 那條「把直立軌道收成 100% 高」的規則
            認的 —— 設計系統把它寫死成 160px,見那邊的說明。 */}
        <Stack
          data-avatar-zoom
          {...(zoomDrag.isDragging ? {'data-dragging': ''} : {})}
          {...zoomDrag.handlers}
          xstyle={styles.zoomRail}
        >
          <Slider
            label="Zoom"
            isLabelHidden
            valueDisplay="none"
            orientation="vertical"
            xstyle={styles.zoomSlider}
            /* ⚠️ `formatValue` 不能省:Astryx 拿它填 `aria-valuetext`,
               少了它報讀軟體念的是沒有單位的 1.35。 */
            formatValue={(z: number) => `${Math.round(z * 100)}%`}
            value={crop.zoom}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            onChange={(zoom: number) => onCropChange(clampCrop(source, {...crop, zoom}))}
          />
        </Stack>
      </Stack>
    </Center>
  );
}
