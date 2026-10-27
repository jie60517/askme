/**
 * 檔案燈箱。
 *
 * ⚠️ 名字是 `FileLightbox` 不是 `ImageLightbox`:它處理的東西裡只有一種是圖片
 * (其餘是 PDF / Office 抽文字 / Markdown / 程式碼 / 純文字),叫 Image 會讓下一個人
 * 以為 PDF 要另外做一個。
 *
 * ⚠️ 為什麼不用設計系統的 `Lightbox`:它的文件寫明「Don't use for non-image
 * content; specialized for images」,`LightboxMedia` 只有 `src` + `type: image|video`。
 * 而這裡的需求是「**所有看得了的檔案攤成一條**,左右切換走得遍整組對話」——
 * 圖片、PDF、試算表、原始碼會混在同一條裡。硬把文字塞進 `src` 是繞過那個元件的形狀。
 * 所以自己用 Astryx 的元件組,蓋在固定大小的 `Dialog`(`min(920px, 94vw)`,**不是全螢幕**)上,
 * 焦點循環、Esc、鎖背景捲動、關閉還焦點都是它的。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as stylex from '@stylexjs/stylex';

import {ChevronLeft, ChevronRight, Download, File, FileSpreadsheet, FileText} from 'lucide-react';

import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, Layout, LayoutContent, LayoutFooter, Stack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {Markdown} from '@astryxdesign/core/Markdown';
import {Thumbnail} from '@astryxdesign/core/Thumbnail';

import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {Icon} from '@astryxdesign/core/Icon';

import {codeLanguage} from '../lib/filekind';
import {createPointerOwner} from '../lib/pointerOwner';
import {prefersReducedMotion} from '../lib/rubberband';
import {releaseVelocityPxPerMs} from '../lib/velocity';
import {LoadingScreen} from './LoadingScreen';
import type {LightboxItem} from '../lib/lightboxItem';
import {useDialogExit} from './useDialogExit';

/**
 * 文字模式的截斷長度。跟後端 `files._MAX_PREVIEW_CHARS` 同一個量級 ——
 * 預覽的用途是「確認這份是不是我要的」,不是在網頁裡讀完一份幾 MB 的報表。
 */
const MAX_PREVIEW_CHARS = 200_000;

/** 這幾種副檔名以文件呈現(Markdown 渲染),不是原始碼。 */
const MARKDOWN_NAME = /\.(md|markdown)$/i;

const styles = stylex.create({
  /** 圖片:整張看得到就好,不要為了填滿而裁切 */
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
  },
  /** PDF 交給瀏覽器自己的檢視器,所以要給它一塊實際的高度 */
  frame: {
    width: '100%',
    height: '100%',
    borderWidth: 0,
  },
  /** 內容區:剩下的高度全給它,自己捲 */
  stage: {
    flexGrow: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  /**
   * 內容區的高度**固定**。高度跟著內容走的話,高的圖片把
   * 彈窗撐高、短的文字讓它縮回去,底下那排縮圖與左右鈕就跟著上下跳。
   * 定成視窗高的一半左右(彈窗本身 maxHeight 86dvh,扣掉標頭與縮圖列),
   * 每一個檔案的框都一樣大,鈕就釘住了。
   * ⚠️ 用 `dvh` 不用 `vh`:手機上 `vh` 量的是**網址列收起來**
   * 時的高度,網址列還在時彈窗下緣(縮圖列與左右鈕)會被切掉。跟 maxHeight 一起改。
   */
  stageFixed: {
    height: '56dvh',
  },
  /** 文字模式自己捲:高度固定之後,長文字不能再靠 LayoutContent 撐高來捲 */
  stageScroll: {
    overflowY: 'auto',
  },
  /**
   * 中間那一欄要**撐滿固定高度**,內容才會從頂端開始。
   * 外層 HStack 的 vAlign="center" 是給左右切換鈕的;中間這欄不撐開的話,
   * 高度只有內容那麼高、整塊被置中 —— 內容就從中間開始。撐滿之後
   * vAlign="start" 才真的是「從頂端開始」。
   */
  stageColumn: {
    alignSelf: 'stretch',
  },
  /** md 文件照範本的 articleBody:限寬置中,讀起來才像一份文件 */
  markdownBody: {
    width: '100%',
    maxWidth: 720,
    marginInline: 'auto',
    paddingBlock: 'var(--spacing-4)',
    paddingInline: 'var(--spacing-3)',
  },
  /** 底部縮圖列橫著捲,不要把上面的內容擠掉 */
  strip: {
    flexShrink: 0,
    overflowX: 'auto',
    paddingBlock: 'var(--spacing-2)',
  },
  /**
   * 圖片可以左右滑。`pan-y pinch-zoom`:**直的捲動與雙指縮放照樣交給瀏覽器**,
   * 只有橫的那一段歸我們 —— 寫 `none` 的話手機上在圖片上就捏不動、也捲不動外面了。
   */
  swipeable: {touchAction: 'pan-y pinch-zoom'},
  /** 跟著手指動的那一層:撐滿舞台(圖片的 `maxHeight: 100%` 要量得到一個確定的高度) */
  swipeTrack: {width: '100%', flexGrow: 1, minHeight: 0},
  current: {
    outlineWidth: 'var(--focus-outline-width)',
    outlineStyle: 'solid',
    outlineColor: 'var(--color-accent)',
    outlineOffset: 'var(--spacing-0-5)',
    borderRadius: 'var(--radius-element)',
  },
});

/**
 * 抓回來的東西是不是二進位。**執行期的第二道保險** ——
 * 第一道是 `filekind.isTextFilename` 的排除法,而它是照副檔名猜的,
 * 一定會有漏網之魚(例如一份 zip 被存成 `.log`)。
 *
 * 漏判的下場是整頁亂碼,而那看起來像「這個系統壞了」,不像「這個檔案不能預覽」。
 */
function looksBinary(text: string): boolean {
  // NUL 幾乎不會出現在文字檔裡,出現就是二進位
  if (text.includes('\u0000')) return true;
  // 解碼失敗的字元(U+FFFD)佔比。取前面一段就夠,整份掃在幾 MB 的檔案上很慢
  const sample = text.slice(0, 4000);
  if (sample.length === 0) return false;
  let broken = 0;
  for (const ch of sample) if (ch === '\uFFFD') broken += 1;
  return broken / sample.length > 0.02;
}

type TextState =
  | {status: 'loading'}
  | {status: 'ready'; text: string; isTruncated: boolean}
  /** 415:格式本身轉不出文字。跟「抓不到」要分開講,使用者要做的事不一樣 */
  | {status: 'unsupported'}
  /**
   * 401/403:登入過期了。**跟「抓不到」要分開講** —— 這條路徑不經 axios,
   * 所以 api.ts 那個「401 就清 token 跳登入頁」的攔截器踩不到,
   * 使用者只會看到一個沒有理由的失敗。他要做的事是重新登入,不是重試。
   */
  | {status: 'signedout'}
  | {status: 'failed'}
  /** 抓回來是二進位 */
  | {status: 'binary'};

/**
 * 觸控左右滑的門檻。
 *
 * - `SWIPE_SLOP_PX`:先走 10px 才決定這一下是橫的還是直的 —— 一按下去就鎖的話,
 *   想往下捲的手指稍微斜一點就被當成翻頁。鎖成直的就整段放手給瀏覽器。
 * - `SWIPE_DISTANCE_RATIO`:放手時「投射出去的位置」超過寬度的三成就翻。
 * - `SWIPE_VELOCITY`(px/ms):甩得夠快,距離不到也翻 —— 0.11 px/ms ≈ 110px/s,是「有意甩一下」的下限。
 * - `SWIPE_PROJECT_MS`:放手速度往前推這麼久當作投射位置(手放開之後內容本來還會滑一小段)。
 */
const SWIPE_SLOP_PX = 10;
const SWIPE_DISTANCE_RATIO = 0.3;
const SWIPE_VELOCITY = 0.11;
const SWIPE_PROJECT_MS = 200;

/**
 * 放手那一刻要不要翻頁:回 `1`(下一張,往左滑)、`-1`(上一張,往右滑)或 `0`(彈回原位)。
 *
 * **方向看放手時的速度**,不是看總位移:往左拖了一大段、最後一下又往右甩回來,
 * 使用者的意思是「算了」—— 只看位移的話會照樣翻過去。速度太小(手停住才放)才退回看位移。
 */
export function swipeStep(dx: number, velocity: number, width: number): -1 | 0 | 1 {
  if (!(width > 0)) return 0;
  const moving = Math.abs(velocity) > 0.02;
  const direction = Math.sign(moving ? velocity : dx);
  if (direction === 0) return 0;
  // 位移與甩的方向相反(往左拖了一段、最後往右甩回來)= 算了:回到原本那張,不是翻到另一邊
  if (Math.sign(dx) === -direction) return 0;
  const projected = dx + velocity * SWIPE_PROJECT_MS;
  const far = Math.abs(projected) > width * SWIPE_DISTANCE_RATIO;
  const fast = Math.abs(velocity) > SWIPE_VELOCITY;
  if (!far && !fast) return 0;
  // 手往左(負)= 看下一張
  return direction < 0 ? 1 : -1;
}

/** 一段過場(回彈、滑進來)。`--ease-standard` 本身就是 ease-out 的形狀。 */
const SWIPE_TRANSITION = 'transform var(--duration-fast-max) var(--ease-standard)';
/**
 * 新的那張圖最多等它解碼多久才開始滑進來(ms)。快取裡的圖幾乎是立刻好;
 * 沒快取的大圖不能讓翻頁卡在那裡等,超過就先滑、圖晚一點自己出現。
 */
const SWIPE_DECODE_WAIT_MS = 120;

/**
 * 軌道**現在畫在哪裡**(px)。滑進來的過場跑到一半時,`style.transform` 寫的是終點 0,
 * 畫面上卻還在半路 —— 要從畫面上的位置接手,就得問算出來的樣式(直接從 0 起算的話,
 * 手指一碰就跳一段)。沒有 `DOMMatrix`(測試環境)就當 0。
 */
function presentedX(el: HTMLElement | null): number {
  if (!el || typeof DOMMatrixReadOnly === 'undefined') return 0;
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  try {
    return new DOMMatrixReadOnly(t).m41;
  } catch {
    return 0;
  }
}

/**
 * 燈箱裡圖片的觸控左右滑。只認觸控與觸控筆 —— 滑鼠有左右鈕與方向鍵,
 * 按住圖片拖還會撞上瀏覽器原生的圖片拖放。
 *
 * - 位移直接寫在元素的 `style.transform` 上,不經 React:跟手的那一段每一個 pointermove 都在動,
 *   走 state 就是每一下都重畫整個燈箱。
 * - 多點觸控(`lib/pointerOwner.ts`):第二根手指按下來代表要捏縮放,這一下滑動就作廢、彈回原位。
 * - `prefers-reduced-motion`:不跟手、不滑,放手判定要翻就直接換。**按下去那一刻讀一次**,
 *   不要每一個 pointermove 都去問 `matchMedia`。
 * - 翻頁的滑進來在**換好內容之後**才開始(`itemKey` 那支 layout effect):在放手的當下就動的話,
 *   軌道上還是舊的那張 —— 看到的是舊圖滑進來、再跳成新圖。
 */
function useImageSwipe(enabled: boolean, itemKey: unknown, step: (delta: number) => void) {
  const ref = useRef<HTMLElement>(null);
  const owner = useState(createPointerOwner)[0];
  const gesture = useRef<{
    x: number;
    y: number;
    axis: 'pending' | 'x';
    width: number;
    /** 鎖成橫的那一刻軌道畫在哪裡(上一次滑進來還沒跑完時不是 0,見 `presentedX`) */
    base: number;
    /** 按下去那一刻讀的 `prefers-reduced-motion` */
    reduce: boolean;
    /** 最近幾筆位置,算放手速度用 */
    samples: {t: number; x: number}[];
  } | null>(null);
  /** 翻頁之後新內容要從哪裡滑進來(px);null = 沒有在等 */
  const enterFrom = useRef<number | null>(null);
  /**
   * 每一次滑進來的編號:等解碼的那段期間又**鎖成橫滑**了 / 又翻了一頁,舊的那次就不要再動。
   * ⚠️ 只在「鎖成橫的」那一刻作廢,不在按下去就作廢:按下去之後變成點一下、
   * 往下捲或捏縮放的話,沒有人會再把軌道歸零,新的那張就卡在畫面外面。
   */
  const enterSeq = useRef(0);

  const place = useCallback((offset: number, animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? SWIPE_TRANSITION : 'none';
    el.style.transform = offset === 0 ? '' : `translateX(${offset}px)`;
  }, []);
  const abort = () => {
    const was = gesture.current;
    gesture.current = null;
    owner.release();
    if (was?.axis === 'x') place(0, !was.reduce);
  };

  // 手勢進行中不能滑了(例如用方向鍵換到一份 PDF):殘留的位移歸零
  useEffect(() => {
    if (!enabled && gesture.current) {
      gesture.current = null;
      owner.release();
      place(0, false);
    }
  }, [enabled, owner, place]);

  /*
   * 換好內容之後才滑進來。layout effect:新的 `src` 已經寫進 DOM、還沒畫出來 ——
   * 先無過場地放到起點,這一幀畫出來的就是「新圖在旁邊」,不會閃一下舊圖。
   * 新圖還沒解碼的話等一下下(`SWIPE_DECODE_WAIT_MS`),不然滑進來的是一塊空白。
   * ⚠️ 開過場之前要強制排版一次,不然瀏覽器把兩次寫入合成一次,什麼都不動。
   */
  useLayoutEffect(() => {
    const from = enterFrom.current;
    enterFrom.current = null;
    if (from === null) return;
    const seq = ++enterSeq.current;
    place(from, false);
    const img = ref.current?.querySelector('img');
    const decoded =
      img && !img.complete && typeof img.decode === 'function'
        ? Promise.race([
            img.decode().catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, SWIPE_DECODE_WAIT_MS)),
          ])
        : Promise.resolve();
    void decoded.then(() => {
      if (seq !== enterSeq.current) return;
      void ref.current?.offsetWidth;
      place(0, true);
    });
  }, [itemKey, place]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return;
    const claim = owner.claim(e);
    if (claim === 'ignored') {
      // 第二根手指:要捏縮放了,這一下滑動作廢
      if (gesture.current) abort();
      return;
    }
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      axis: 'pending',
      width: e.currentTarget.getBoundingClientRect().width,
      base: 0,
      reduce: prefersReducedMotion(),
      samples: [{t: e.timeStamp, x: e.clientX}],
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || !owner.owns(e)) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.axis === 'pending') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        // 直的:整段交給瀏覽器捲,這一下不是我們的
        gesture.current = null;
        owner.release();
        return;
      }
      g.axis = 'x';
      // 上一次翻頁還在等解碼 / 還在滑進來:作廢,從畫面上的位置接手(不是從 0)
      enterSeq.current += 1;
      g.base = g.reduce ? 0 : presentedX(ref.current);
      // 鎖成橫的之後才抓指標:手指滑出圖片外面照樣跟手。
      // ⚠️ 觸控本來就隱含地抓在按到的那個子元素(<img>)上,這一下等於從它手上搶過來 ——
      // 它會收到一個 lostpointercapture 冒泡上來,見底下 `onLostPointerCapture` 的過濾。
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    g.samples.push({t: e.timeStamp, x: e.clientX});
    if (g.samples.length > 8) g.samples.shift();
    // 扣掉門檻那段,不然鎖定那一刻畫面會當場跳 10px
    if (!g.reduce) place(g.base + dx - Math.sign(dx) * SWIPE_SLOP_PX, false);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || !owner.owns(e)) return;
    gesture.current = null;
    owner.release();
    if (g.axis !== 'x') return;
    // 軌道放手時的位置:接手時的位置 + 手指走的(扣掉門檻那段)
    const dx = g.base + e.clientX - g.x - Math.sign(e.clientX - g.x) * SWIPE_SLOP_PX;
    // 放手那一筆也算進去:甩到一半停住、過一會兒才抬手 = 0(見 `lib/velocity.ts`)
    const velocity = releaseVelocityPxPerMs([...g.samples, {t: e.timeStamp, x: e.clientX}]).x;
    const delta = swipeStep(dx, velocity, g.width);
    if (delta === 0) {
      place(0, !g.reduce);
      return;
    }
    if (g.reduce) {
      place(0, false);
      step(delta);
      return;
    }
    /*
     * 新的那張從「它本來該在的位置」滑進來:往左滑看下一張 = 下一張從右邊進來,
     * 起點接在手指放開時舊圖的右緣後面,整段看起來是連續的一條。
     * 這裡只記起點、先換頁;真正的移動在 layout effect 裡(新內容到位之後)。
     */
    enterFrom.current = dx + (delta > 0 ? g.width : -g.width);
    step(delta);
  };

  return {
    ref,
    handlers: enabled
      ? {
          onPointerDown,
          onPointerMove,
          onPointerUp,
          // 瀏覽器接手了(開始捲動 / 捏縮放):彈回原位
          onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
            if (owner.owns(e)) abort();
          },
          /*
           * 指標被搶走:彈回原位。⚠️ **只認舞台自己丟掉的那一次**(`target === currentTarget`)——
           * 鎖成橫的那一刻舞台從 <img> 手上接過指標,<img> 收到的 lostpointercapture 會冒泡到這裡,
           * 同一個 pointerId;不過濾的話每一次滑動都在鎖定的當下被自己取消掉。
           */
          onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => {
            if (e.target === e.currentTarget && owner.owns(e)) abort();
          },
        }
      : {},
  };
}

type Props = {
  /** 整組對話所有看得了的檔案,照畫面上的順序。空陣列 = 燈箱關著 */
  items: LightboxItem[];
  /** 目前看的是第幾個;null = 關著 */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
};

export function FileLightbox({items, index, onIndexChange, onClose}: Props) {
  /*
   * 退場跟其他對話框同一支 hook。這一顆收的是 `onClose`(沒有 open 的那一半),
   * 包成 `onOpenChange` 的形狀交給它 —— 只有關的時候才有事要做。
   */
  const exit = useDialogExit((open: boolean) => {
    if (!open) onClose();
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isOpen = index !== null;
  const current = isOpen ? items[index] : null;

  const step = useCallback(
    (delta: number) => {
      if (index === null || items.length === 0) return;
      // 循環:走到最後一張再按下一張回到第一張
      onIndexChange((index + delta + items.length) % items.length);
    },
    [index, items.length, onIndexChange],
  );

  /*
   * 觸控左右滑:手機上這個對話框是 94vw,左右滑是預期的手勢。
   * **只有圖片**:PDF 是 iframe(手勢進不來)、文字要能選字與橫向捲 CodeBlock,滑動會跟它們搶。
   * 鍵盤 ←/→ 與左右鈕是當場換、沒有過場。
   */
  const swipe = useImageSwipe(current?.mode === 'image' && items.length > 1, index, step);

  /*
   * 鍵盤掛在 **document 的捕獲階段**,不是 React 的 `onKeyDown`。
   *
   * 兩個理由:
   *  1. 底下的 `Dialog` 也在聽鍵(它把 keydown 掛在自己的 <dialog> 上),
   *     用冒泡的話順序不受控。
   *  2. 焦點可能落在面板裡任何一個東西上(縮圖、下載鈕),掛在某個元素上收不齊。
   *
   * 處理前先確認**焦點還在自己這一層**:不在就直接 return,
   * 讓位給疊在上面的東西 —— 不然在更上層按 ← 會把這一層的圖偷偷換掉。
   */
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!dialogRef.current?.contains(document.activeElement)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, step]);

  return (
    <Dialog
      ref={dialogRef}
      isOpen={isOpen}
      {...exit.dialogProps}
      /*
       * **固定大小,不要全螢幕**。
       * min():桌機固定 920,窄視窗自己縮 —— 手機路徑也是開這一顆。
       */
      width="min(920px, 94vw)"
      // dvh 不是 vh:理由見 stageFixed
      maxHeight="86dvh"
      purpose="info"
    >
      {/*
        ⚠️ `Layout` 的三格(跟 `FilesDialog` 同一個理由):
        `Dialog` 的內層是 `overflow: hidden`,自己排的話一份長文字會**捲不到**。
        標頭與底下那排縮圖留在原位,只有中間那一格捲。
      */}
      <Layout
        header={
          /*
            右上角的關閉鈕**不能省**:焦點一旦進了 PDF 的 iframe,
            鍵盤事件就收不到了 —— 那時候 Esc 是沒有用的,只剩下這顆鈕。
          */
          <DialogHeader title={current?.name ?? ''} onOpenChange={exit.dialogProps.onOpenChange} />
        }
        content={
          <LayoutContent>
            {current ? (
              <HStack gap={2} vAlign="center" xstyle={[styles.stage, styles.stageFixed]}>
                {/* 只有一個檔案時不畫左右鈕(它們點下去只會回到自己) */}
                {items.length > 1 ? (
                  <Button
                    variant="ghost"
                    isIconOnly
                    icon={<Icon icon={ChevronLeft} size="sm" />}
                    label="Previous file"
                    onClick={() => step(-1)}
                  />
                ) : null}
                {/* 內容**從頂端開始** —— 高度固定之後置中會讓短內容飄在中間,讀文件的預期是從頭開始 */}
                <Stack
                  xstyle={[
                    styles.stage,
                    styles.stageColumn,
                    current.mode === 'image' && items.length > 1 && styles.swipeable,
                  ]}
                  hAlign="center"
                  vAlign="start"
                  {...swipe.handlers}
                >
                  {/* 滑動時動的是這一層;外面那層(`overflow: hidden`)負責裁,圖不會滑到左右鈕上面 */}
                  <Stack ref={swipe.ref} xstyle={styles.swipeTrack} hAlign="center" vAlign="start">
                    <Preview item={current} />
                  </Stack>
                </Stack>
                {items.length > 1 ? (
                  <Button
                    variant="ghost"
                    isIconOnly
                    icon={<Icon icon={ChevronRight} size="sm" />}
                    label="Next file"
                    onClick={() => step(1)}
                  />
                ) : null}
              </HStack>
            ) : null}
          </LayoutContent>
        }
        footer={
          current ? (
            <LayoutFooter>
              <VStack gap={2}>
                <HStack gap={2} vAlign="center" hAlign="between">
                  <Text type="supporting" color="secondary">
                    {items.length > 1 ? `${(index ?? 0) + 1} of ${items.length}` : ''}
                  </Text>
                  {/*
                    下載是**獨立一顆**。預覽是「確認這是不是我要的」,
                    下載是下一個動作 —— 看得到不等於拿得到,兩件事不要合成一個入口。
                  */}
                  <Button
                    href={current.downloadUrl}
                    label="Download"
                    icon={<Icon icon={Download} size="sm" />}
                    variant="secondary"
                    size="sm"
                  />
                </HStack>
                {items.length > 1 ? (
                  // 縮圖列置中
                  <HStack gap={2} vAlign="center" hAlign="center" xstyle={styles.strip}>
                    {items.map((item, i) => (
                      <Stack
                        key={`${item.previewUrl}-${i}`}
                        xstyle={i === index ? styles.current : null}
                      >
                        {item.mode === 'image' ? (
                          <Thumbnail
                            src={item.previewUrl}
                            alt={item.name}
                            label={item.name}
                            onClick={() => onIndexChange(i)}
                          />
                        ) : (
                          /* 不是圖片的放圖示 + 檔名 —— 一排長得一樣的
                             灰方塊等於沒有縮圖列,人是靠檔名認出那份文件的 */
                          <Button
                            label={item.name}
                            icon={<ModeIcon mode={item.mode} />}
                            variant="ghost"
                            size="sm"
                            onClick={() => onIndexChange(i)}
                          />
                        )}
                      </Stack>
                    ))}
                  </HStack>
                ) : null}
              </VStack>
            </LayoutFooter>
          ) : undefined
        }
      />
    </Dialog>
  );
}

export function ModeIcon({mode}: {mode: LightboxItem['mode']}) {
  if (mode === 'office') return <Icon icon={FileSpreadsheet} size="sm" />;
  if (mode === 'pdf' || mode === 'text') return <Icon icon={FileText} size="sm" />;
  return <Icon icon={File} size="sm" />;
}

/**
 * 一份檔案的內容本身。分圖片 / PDF / 其餘三條路,其餘那條再由 `TextPreview`
 * 分成 Markdown、程式碼(有 `codeLanguage()`)與純文字。
 * 匯出是給**右側預覽面板**共用的 —— 燈箱與側欄要長得一模一樣,
 * 兩邊各刻一份的話 PDF 的框、文字的截斷、二進位的保險一定會分岔。
 */
export function Preview({item}: {item: LightboxItem}) {
  if (item.mode === 'image') {
    return <img src={item.previewUrl} alt={item.name} {...stylex.props(styles.image)} />;
  }
  if (item.mode === 'pdf') {
    return (
      /*
       * ⚠️ **不能加 `sandbox`。** Chrome 一律不在沙箱 iframe 裡開 PDF ——
       * 畫面是「Chrome 已封鎖這個網頁」,而且跟回應標頭無關:
       * 「什麼標頭都不送 + sandbox」也會被擋,補 `allow-same-origin` 也一樣。
       * 唯一放得出來的組合就是不帶這個屬性。
       *
       * 那安全上靠什麼:這個 iframe 的來源只會是 `/api/files/` 或 `/api/uploads/`,
       * 而那兩條**只對 `routers/files.py` 的 `_INLINE_OK` 那份名單 inline 送出**,
       * 名單裡沒有 html / svg / xml,其餘一律 `Content-Disposition: attachment`
       * (iframe 對它只會觸發下載,不會當文件執行),而且每個回應都帶 nosniff。
       * 也就是說這裡放得進來的只有圖片、PDF 與純文字,沒有一種會以 HTML 身分執行腳本。
       * ⚠️ **要往 `_INLINE_OK` 加副檔名之前先回來看這一段** —— 加了 html/svg
       * 就等於在同源、無沙箱的框裡執行別人上傳的腳本,而 token 就在 sessionStorage。
       */
      <iframe src={item.previewUrl} title={item.name} {...stylex.props(styles.frame)} />
    );
  }
  return <TextPreview item={item} />;
}

function TextPreview({item}: {item: LightboxItem}) {
  const [state, setState] = useState<TextState>({status: 'loading'});

  useEffect(() => {
    if (!item.textUrl) {
      setState({status: 'unsupported'});
      return;
    }
    let alive = true;
    setState({status: 'loading'});
    fetch(item.textUrl)
      .then(async (res) => {
        if (!alive) return;
        // 415 = 這個格式轉不出文字;其他非 2xx 才是「抓不到」。
        // 兩者要分開講:一個是「換個方式看」,一個是「再試一次或找人」
        if (res.status === 415) {
          setState({status: 'unsupported'});
          return;
        }
        if (res.status === 401 || res.status === 403) {
          setState({status: 'signedout'});
          return;
        }
        if (!res.ok) {
          setState({status: 'failed'});
          return;
        }
        const text = await res.text();
        if (!alive) return;
        if (looksBinary(text)) {
          setState({status: 'binary'});
          return;
        }
        setState({
          status: 'ready',
          text: text.slice(0, MAX_PREVIEW_CHARS),
          isTruncated: text.length > MAX_PREVIEW_CHARS,
        });
      })
      .catch(() => {
        if (alive) setState({status: 'failed'});
      });
    return () => {
      // 切到下一個檔案時,前一個的回應到了也不要蓋掉畫面
      alive = false;
    };
  }, [item.textUrl]);

  if (state.status === 'loading') {
    // 不包 `Center`:外層是 `hAlign="center"` 的 Stack,`Center` 沒給寬會縮成內容寬,
    // 風的舞台(寬度用百分比)就被擠成一條縫。LoadingScreen 自己會置中。
    return <LoadingScreen isCompact />;
  }
  if (state.status === 'ready') {
    return (
      <VStack gap={2} xstyle={[styles.stage, styles.stageScroll]}>
        {/* React 會把內容轉義,所以 html/xml 在這裡只是被看見的原始碼,
            不是被執行的東西 —— 這正是 filekind 那份名單敢比後端寬的理由 */}
        {/*
          .md 用設計系統的 `Markdown` **畫成文件**,不是攤原始碼。
          Markdown 元件會轉義、fenced code 走它自己的 CodeBlock,沒有執行 html 的風險。
          其他文字檔走 CodeBlock(plaintext,不上色):程式碼與報表靠對齊吃飯,不能被當 markdown 重排。
        */}
        {MARKDOWN_NAME.test(item.name) ? (
          <Stack xstyle={styles.markdownBody}>
            <Markdown>{state.text}</Markdown>
          </Stack>
        ) : codeLanguage(item.name) !== null ? (
          /*
           * 程式檔走設計系統的 CodeBlock:標題列(檔名)、行號、複製鈕、認得的語言上色。
           * ⚠️ 不設 maxHeight —— 捲動交給外層 stageScroll 那一層,CodeBlock 自己再捲會疊出兩層捲軸。
           * (設計系統文件建議反過來:不要放進捲動容器、用 maxHeight。這裡不照做,是因為燈箱裡 md / 純文字 /
           * 程式檔共用同一個固定高的捲動層,捲軸都在面板邊緣、截斷提示的位置也一致。)
           */
          <CodeBlock
            code={state.text}
            language={codeLanguage(item.name) as string}
            title={item.name}
            hasLineNumbers
            // 長行折行,不要橫向捲軸(即使報表靠對齊吃飯也一樣)
            isWrapped
            width="100%"
          />
        ) : (
          // 其他文字檔(log、txt…)也走 CodeBlock,只是不上色(plaintext):標題列、複製鈕、等寬字跟程式檔一致
          <CodeBlock code={state.text} language="plaintext" title={item.name} isWrapped width="100%" />
        )}
        {state.isTruncated ? (
          <Text type="supporting" color="secondary">
            Only the first {MAX_PREVIEW_CHARS.toLocaleString()} characters are shown. Download the
            file to see all of it.
          </Text>
        ) : null}
      </VStack>
    );
  }

  const message =
    state.status === 'unsupported'
      ? 'This format cannot be shown here. Download it to open it in the right app.'
      : state.status === 'binary'
        ? 'This file is not text. Download it to open it in the right app.'
        : state.status === 'signedout'
          ? 'Your session has expired. Reload the page and sign in again.'
          : 'Could not load this file right now.';

  return (
    <Center>
      <Text type="supporting" color="secondary">
        {message}
      </Text>
    </Center>
  );
}
