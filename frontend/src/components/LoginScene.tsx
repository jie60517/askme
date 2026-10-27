/**
 * 登入頁右側那塊。
 *
 * three.js 的場景 —— 每次重新整理從 `login-scenes` 的三款裡隨機挑一款。
 * 版面尺寸完全沿用範本放圖片的那個格子,不會因為換場景而變動。
 *
 * 幾個刻意的取捨:
 * - 顏色從 Astryx 的 token 解析出來,不是寫死的色碼。token 的值是
 *   `light-dark(#a, #b)`,three.js 讀不懂,所以拿一個隱形的 probe 元素
 *   讓瀏覽器先算成 rgb() 再交給它。
 * - 分頁切走、或這塊捲出視線時停掉 rAF。登入頁擺著不動也不該一直吃 GPU。
 * - prefers-reduced-motion 時沒有 rAF 迴圈:畫一格靜態畫面就停(尺寸變了才補畫)。
 * - WebGL 建不起來(舊機器、遠端桌面、關掉硬體加速),或 three.js / 場景模組下載失敗,
 *   就只鋪卡片的底色(`--color-background-card`,跟著深淺色走),不放替代圖。
 */
import {useEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Stack} from '@astryxdesign/core/Layout';

import {pickScene, type SceneHandle} from './login-scenes';
import {useThemeMode} from '../lib/theme';
import {useMediaQuery} from '../lib/media';
import {resolveCssColor} from '../lib/cssColor';
import {easeStep, frameDelta} from '../lib/frameEase';

/** 指標用追的,每 60Hz 一幀走掉剩餘距離的這個比例(實際比例照 dt 換算,見 `lib/frameEase.ts`)。 */
const POINTER_EASE = 0.08;

const styles = stylex.create({
  /** 場景起不來時的退路:這一格坐在登入卡片上,鋪卡片的底色 */
  fallback: {
    width: '100%',
    height: '100%',
    backgroundColor: 'var(--color-background-card)',
  },
});

/**
 * 這塊是純裝飾,一律 `aria-hidden`,不開 `label` 讓呼叫端把它變成 `role="img"` ——
 * 真要說明登入頁那塊動畫,該寫的是旁邊的文案不是它的 alt。
 */
export function LoginScene() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [sceneName, setSceneName] = useState<string>();
  // 換佈景要整個重建:顏色是在建立時就烤進 material 的
  const mode = useThemeMode();
  /**
   * ⚠️ 用**訂閱**(`useMediaQuery`)而不是在 effect 裡讀一次 `matchMedia(...).matches`。
   * 快照只在建場景那一刻成立:使用者在作業系統把「減少動態」打開時,這顆已經建好的
   * 場景不會知道,那條 rAF 迴圈會一路跑下去。
   *
   * 進了底下那支 effect 的依賴 —— 偏好一變就重建一顆(跟換佈景走同一條路),
   * 因為 `SceneHandle` 沒有改這個旗標的介面,它是在 `create()` 時烤進去的。
   * ⚠️ 重建會**重抽一款場景**(`pickScene` 在那支 effect 裡),換深 / 淺色也一樣。
   * 切偏好時換一款是預期行為,不是 bug。
   */
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    let raf = 0;
    let handle: SceneHandle | undefined;
    let renderer: import('three').WebGLRenderer | undefined;
    let visible = true;
    let onScreen = true;

    const pointer = {x: 0, y: 0};
    const target = {x: 0, y: 0};

    const onPointerMove = (e: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      target.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      target.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    };
    const onPointerLeave = () => {
      target.x = 0;
      target.y = 0;
    };

    void (async () => {
      // 場景模組跟 three.js 一起等:兩個都是動態載入的,排在一起等於只多幾毫秒。
      // 一定要在建 renderer **之前** —— 建完才 await 的話,這中間被卸載就會漏掉
      // 一個 WebGL context(cleanup 那時還沒設好)。
      // 這裡量到的就只是「有粗指標」(觸控)—— 觸控桌機與二合一筆電也算,
      // 那些機器算力並不低。**要不要因此視為低算力,是 `pickScene` 的判斷**,
      // 所以這個變數只照實講它量到什麼。
      const isCoarsePointer = window.matchMedia('(any-pointer: coarse)').matches;
      // 模組下載失敗(斷線、上版後舊的 chunk 不見了)跟 WebGL 建不起來走同一個退路
      const loaded = await Promise.all([
        import('three'),
        pickScene(isCoarsePointer).load(),
      ]).catch(() => null);
      if (cancelled) return;
      if (!loaded) {
        setFailed(true);
        return;
      }
      const [THREE, factory] = loaded;
      setSceneName(factory.name);

      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;

      try {
        // `powerPreference: 'low-power'` 跟 loading-scene 對齊:
        // 這塊是登入頁的裝飾,沒有理由去要獨立顯卡。`alpha: false` 不要動 ——
        // resize 補畫那段(reduced-motion 下的那一格)的前提就是它是實心底。
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: false,
          powerPreference: 'low-power',
        });
      } catch {
        setFailed(true);
        return;
      }
      if (cancelled) {
        renderer.dispose();
        renderer.forceContextLoss();
        return;
      }

      // 高 DPI 螢幕不要照單全收:2 以上肉眼看不出差別,但畫素量是平方成長
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      const canvas = renderer.domElement;
      // 淡進來,不要硬切(規則在 `global.css` 的 `[data-scene-fade]`)。
      // 這一支是 `alpha: false`,所以硬切的話是一塊**實心**的畫面瞬間蓋上來 ——
      // 比 `loading-scene` 那支(`alpha: true`)更明顯。
      canvas.dataset.sceneFade = '';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      host.appendChild(canvas);

      handle = factory.create({
        renderer,
        width,
        height,
        reducedMotion,
        palette: {
          accent: resolveCssColor(host, '--color-accent'),
          background: resolveCssColor(host, '--color-background-body'),
          muted: resolveCssColor(host, '--color-text-secondary'),
        },
      });

      const resizeObserver = new ResizeObserver(() => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer?.setSize(w, h, false);
        handle?.resize(w, h);
        // 減少動態時沒有迴圈會接手,而 `setSize` 會清掉畫面 —— 要自己補一格,
        // 不然轉個方向、或跨過併成一欄的斷點之後,這塊就永遠是空白的
        //(`alpha: false`,所以那是一塊實心的空白,不是透出底色)。
        // 時間點與指標固定,跟底下初次那一格一致。
        if (reducedMotion) handle?.update(0, pointer);
      });
      resizeObserver.observe(host);

      const intersectionObserver = new IntersectionObserver(([entry]) => {
        onScreen = entry.isIntersecting;
      });
      intersectionObserver.observe(host);

      const onVisibility = () => {
        visible = document.visibilityState === 'visible';
      };
      document.addEventListener('visibilitychange', onVisibility);
      host.addEventListener('pointermove', onPointerMove);
      host.addEventListener('pointerleave', onPointerLeave);

      const start = performance.now();
      let lastTs: number | undefined;
      const loop = (ts: number) => {
        raf = requestAnimationFrame(loop);
        if (!visible || !onScreen) {
          // 停過之後的第一格當一幀算,不要拿整段停頓去追(frameDelta 也會夾,這裡更乾淨)
          lastTs = undefined;
          return;
        }
        // 指標用追的,不要直接跳 —— 直接跳的話快速移動會像瞬移。
        // 比例照兩幀之間實際過了多久換算:固定每 rAF 0.08
        // 在 120Hz 的螢幕上會追快一倍。
        const k = easeStep(POINTER_EASE, frameDelta(lastTs, ts));
        lastTs = ts;
        pointer.x += (target.x - pointer.x) * k;
        pointer.y += (target.y - pointer.y) * k;
        handle?.update((performance.now() - start) / 1000, pointer);
      };

      // 先畫一格再開迴圈:不先畫的話第一個 rAF 之前是一塊空白的 canvas,
      // 頁面載入時會閃一下。減少動態時之後只有 resize 才會再畫。
      handle.update(0, pointer);
      if (!reducedMotion) {
        raf = requestAnimationFrame(loop);
      }

      cleanup = () => {
        cancelAnimationFrame(raf);
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        host.removeEventListener('pointermove', onPointerMove);
        host.removeEventListener('pointerleave', onPointerLeave);
        handle?.dispose();
        renderer?.dispose();
        /*
         * `dispose()` 不會放掉 WebGL context(要等 GC)—— 換深淺色、切減少動態都會
         * 重建 renderer,死掉的 context 疊到瀏覽器上限時 Chrome 會丟掉最舊的那個。
         * 理由同 `loading-scene.ts` 的 dispose。
         */
        renderer?.forceContextLoss();
        canvas.remove();
      };
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, [mode, reducedMotion]);

  if (failed) {
    return <Stack aria-hidden xstyle={styles.fallback} />;
  }

  return (
    <div
      ref={hostRef}
      aria-hidden
      data-scene={sceneName}
      style={{position: 'relative', width: '100%', height: '100%', overflow: 'hidden'}}
    />
  );
}
