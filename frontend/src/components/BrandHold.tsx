/**
 * 品牌列的長按彩蛋。
 *
 * 按住 logo 那一塊 `BRAND_HOLD_MS`:膠囊外框亮起,一條會發光的彩虹果凍
 * 從左往右填滿它,填滿的那一刻炸成彩帶噴出去,然後回復原樣。
 * 中途放開就取消:已填的那段 `BRAND_RELEASE_MS` 內退回,再卸掉。
 * 動畫本體在 `brand-hold-scene.ts`(Canvas 2D)。
 *
 * 獨立成元件是因為手機版的頂列與抽屜標頭也用同一個彩蛋,而那兩處不在 Sidebar 的 JSX 裡。
 *
 * - 動畫**動態載入**:它只服務一個彩蛋,沒人長按就不該下載。
 *   首次載入的延遲用「剩餘時間」補:動畫拿到的 holdMs 是扣掉已經按住的時間,
 *   進度條跟完成計時器同時到終點。
 * - 按在**按鈕**上不啟動(收合鈕 / 手機的選單鈕是另一顆控制)。
 * - 觸發完的那一下 click 要吞掉 —— 品牌字是連結(headingHref="/"),
 *   不吞的話彩帶還沒噴完頁面就導走了。
 * - reduced-motion:整個彩蛋不啟動(它純粹是裝飾,不值得為它動誰的前庭)。
 * - 拿不到 2D context 時回 null:只剩膠囊外框亮一下,app 不受影響。
 */
import {useEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Stack} from '@astryxdesign/core/Layout';

// ⚠️ 只能 import type:動畫本體是長按時才動態載入的(它只服務一個彩蛋,
// 沒人長按就不該下載)。改成一般 import 會讓它進主 chunk。
import type {BrandHoldScene as BrandHoldSceneHandle} from './brand-hold-scene';

/** 長按品牌列多久觸發彩蛋(進度填滿的時間)。 */
const BRAND_HOLD_MS = 1500;

/** 彩帶噴完到復原的時間 —— 要比動畫的 `BURST_LIFE_S`(2.0s)長一點。 */
const BRAND_BURST_MS = 2200;

/**
 * 中途放開時,已填的那段退回去要多久。
 * 直接卸掉的話,填了八成的彩虹一下子消失,看不出是「取消了」還是「壞了」。
 * 退回要快(不能擋著下一次按),但要看得出是往回縮。
 * 卸載計時器用同一個數,跟 `burst` 一樣由元件的時鐘決定什麼時候收。
 */
const BRAND_RELEASE_MS = 200;

/**
 * 這顆彩蛋長在三個地方,幾何各自不同 —— 用一個具名的樣態,不要用一堆 boolean:
 *
 * - `nav`  桌機側邊欄展開:整條都是觸發區,**右邊要讓出收合鈕的位置**。
 * - `rail` 桌機側邊欄收合:整條都是觸發區(只有 48px 寬),右邊**沒有**收合鈕要讓。
 * - `bar`  手機頂列 / 抽屜標頭:那一條是整個螢幕寬,膠囊只包**品牌字**,
 *   所以縮到內容寬,不留大片空白。
 *
 * ⚠️ 「要不要讓出收合鈕」跟「要不要撐滿」是**兩件事**,rail 是「撐滿 + 不讓」。
 * 用一個旗標把兩件事綁在一起的話,rail 會變成「縮到內容寬 + 不讓」,膠囊只剩
 * 20px 寬、32px 高,是一顆直立的藥丸。
 */
export type BrandHoldVariant = 'nav' | 'rail' | 'bar';

/** 放開時膠囊外框跟著退場淡掉(只有 opacity,沒有位移) */
const capsuleFadeOut = stylex.keyframes({from: {opacity: 1}, to: {opacity: 0}});

const styles = stylex.create({
  brandHold: {
    position: 'relative',
    /*
     * ⚠️ 長按 1.5 秒的手勢,不准讓系統搶走:
     * iOS 按住約 0.5 秒就開始選字 / 跳出連結選單(品牌字是連結),
     * 接著送 `pointercancel` —— 彩蛋在手機上永遠按不完。
     * 三條都要:`userSelect` 管選字、`WebkitTouchCallout` 管連結 / 圖片的長按選單。
     */
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  /** 整條都是彩蛋的觸發區(nav / rail) */
  brandHoldFill: {
    width: '100%',
  },
  brandCapsule: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    // 收合鈕不包進膠囊(它是另一顆按鈕,蓋住會像把它一起按了)
    insetInlineEnd: 'calc(var(--spacing-6) + var(--spacing-4))',
    borderRadius: 'var(--radius-full)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border-emphasized)',
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  /** 右邊沒有收合鈕要讓(rail / bar):膠囊包到底 */
  brandCapsuleFlush: {
    insetInlineEnd: 0,
  },
  /** 放開後退場:外框在進度退回的那段時間內淡掉(fast ≤ BRAND_RELEASE_MS,卸掉前就淡完) */
  brandCapsuleLeaving: {
    animationName: capsuleFadeOut,
    animationDuration: 'var(--duration-fast)',
    animationTimingFunction: 'ease-out',
    animationFillMode: 'forwards',
  },
  /**
   * 彩蛋的畫布(Canvas 2D,動畫本體在 `brand-hold-scene.ts`)。
   *
   * **釘在視窗上(fixed、鋪滿)**,不是包在品牌列裡:彩帶要一路落到視窗最底
   * (落到登出鈕下面),而且手機版的頂列是一條
   * `overflow: hidden` 的 48px 橫條,包在裡面的畫布連對話區都碰不到。
   * 膠囊的位置在掛載時量成畫布座標,所以畫布放哪裡都對得準。
   *
   * ⚠️ 手機抽屜裡它仍然只蓋得到抽屜:抽屜面板有 transform,fixed 會以它為
   * 定位基準 —— 那本來就是 modal,彩帶留在抽屜裡是對的。
   * pointerEvents none:它只是畫面,滑鼠事件照常打到底下的列。
   * zIndex 10:見 global.css 的層級表。
   */
  brandStage: {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 10,
  },
});

export function BrandHold({
  children,
  variant = 'nav',
}: {
  children: React.ReactNode;
  /** 長在哪裡 —— 三種樣態的幾何差異見 `BrandHoldVariant` */
  variant?: BrandHoldVariant;
}) {
  // 只有手機那條要縮到內容寬;右邊要不要讓位是另一件事
  const isFill = variant !== 'bar';
  const isFlush = variant !== 'nav';
  // releasing:中途放開,進度正在退回(BRAND_RELEASE_MS 後回 idle)
  const [phase, setPhase] = useState<'idle' | 'holding' | 'releasing' | 'burst'>('idle');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const suppressClick = useRef(false);
  const holdStartedAt = useRef(0);
  const stageRef = useRef<HTMLElement>(null);
  const capsuleRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<BrandHoldSceneHandle | null>(null);

  // 卸載時把計時器與場景收掉,不然 setPhase 會打在已卸載的元件上、renderer 洩漏
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    },
    [],
  );

  /*
   * phase 進 holding 才載場景;回 idle 就拆。
   * ⚠️ 建場景要在**量得到膠囊**之後(它要知道進度條畫在哪),
   * 而 stage 與 capsule 都是 holding 才掛上 DOM 的 —— 所以放 effect 裡,
   * render 完才跑。
   */
  useEffect(() => {
    if (phase === 'idle') {
      sceneRef.current?.dispose();
      sceneRef.current = null;
      return;
    }
    if (phase !== 'holding' || sceneRef.current) return;
    let cancelled = false;
    void import('./brand-hold-scene').then(({createBrandHoldScene}) => {
      // 載完可能已經放開了(首次下載要一點時間)—— 那就不要掛
      if (cancelled || phaseRef.current !== 'holding') return;
      const host = stageRef.current;
      const capsuleEl = capsuleRef.current;
      if (!host || !capsuleEl) return;
      // 畫布鋪滿視窗(fixed),膠囊的位置換算成畫布座標。
      // 彩蛋只活兩秒,不處理中途改變視窗大小。
      const hostRect = host.getBoundingClientRect();
      const capRect = capsuleEl.getBoundingClientRect();
      sceneRef.current = createBrandHoldScene(host, {
        // 首次載入的延遲從進度裡扣掉,場景跟完成計時器同時到終點
        holdMs: Math.max(200, BRAND_HOLD_MS - (performance.now() - holdStartedAt.current)),
        capsule: {
          left: capRect.left - hostRect.left,
          top: capRect.top - hostRect.top,
          width: capRect.width,
          height: capRect.height,
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const start = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 收合鈕 / 選單鈕(或未來加進 header 的任何按鈕)不啟動
    if (e.target instanceof Element && e.target.closest('button')) return;
    // 純裝飾的動畫,reduced-motion 的人整個不啟動
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    clearTimeout(timer.current);
    // 上一次放開還在退的話,那顆場景已經是「退回」狀態、不會再往前填 ——
    // 收掉讓 effect 重建一顆(模組已經載過,幾乎是同步的)
    if (phaseRef.current === 'releasing') {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    }
    holdStartedAt.current = performance.now();
    setPhase('holding');
    timer.current = setTimeout(() => {
      suppressClick.current = true;
      setPhase('burst');
      sceneRef.current?.burst();
      timer.current = setTimeout(() => setPhase('idle'), BRAND_BURST_MS);
    }, BRAND_HOLD_MS);
  };

  const cancel = () => {
    // 只取消「還在長按」的;彩帶噴到一半不收(讓它演完)
    if (phaseRef.current !== 'holding') return;
    clearTimeout(timer.current);
    const scene = sceneRef.current;
    /*
     * 已填的那段退回去再卸。場景還沒載到(首次下載中)就沒有東西可退,
     * 直接回 idle。reduced-motion 不必另外處理:那種情況整個彩蛋根本不會啟動(`start`)。
     */
    if (!scene) {
      setPhase('idle');
      return;
    }
    scene.release(BRAND_RELEASE_MS);
    setPhase('releasing');
    timer.current = setTimeout(() => setPhase('idle'), BRAND_RELEASE_MS);
  };

  return (
    <Stack
      xstyle={[styles.brandHold, isFill && styles.brandHoldFill]}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onClickCapture={(e: React.MouseEvent) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
      {/* 膠囊外框只在長按中亮(進度與彩帶都是畫布畫的);放開時跟著淡掉 */}
      {phase === 'holding' || phase === 'releasing' ? (
        <Stack
          ref={capsuleRef}
          aria-hidden
          xstyle={[
            styles.brandCapsule,
            isFlush && styles.brandCapsuleFlush,
            phase === 'releasing' && styles.brandCapsuleLeaving,
          ]}
        />
      ) : null}
      {/* 畫布:holding / releasing / burst 都在;idle 卸掉(effect 會 dispose) */}
      {phase !== 'idle' ? <Stack ref={stageRef} aria-hidden xstyle={styles.brandStage} /> : null}
    </Stack>
  );
}
