/**
 * 載入中的畫面:整頁,以及每一塊區域的載入。
 *
 * 1. **真的置中**:這裡自己撐開高度(整頁那次用 `100dvh`)。外層容器沒有高度的話,
 *    內容會貼在畫面最上面正中間。
 * 2. 動畫交給 three.js(`loading-scene.ts`),畫的是一陣風。
 *
 * 跟 `LoginScene` 同一套保險:WebGL 建不起來(舊機器、遠端桌面、關掉硬體加速)
 * 就退回 Spinner,不要留一塊空白。three 走動態 import。
 */
import {useEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Stack, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Spinner} from '@astryxdesign/core/Spinner';
import {useAnnounce} from '@astryxdesign/core/hooks';

import {resolveCssColor} from '../lib/cssColor';
import {useMediaQuery} from '../lib/media';
import {useThemeMode} from '../lib/theme';
import type {LoadingHandle} from './loading-scene';

const styles = stylex.create({
  root: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--spacing-4)',
  },
  /**
   * 整頁那一次(身分還沒載完、還沒登入)**要自己撐滿視窗、而且要自己畫底色**:
   * 那時候外面沒有任何版面 —— 沒有人撐高度,也**沒有人畫背景**。
   *
   * - `height: 100dvh`:不寫的話 `height: 100%` 會塌成內容高度,圖示就貼在畫面最上面。
   * - `backgroundColor`:不寫的話從 `<html>` 到這裡**每一層都是透明的**,
   *   看到的是瀏覽器的預設底,深淺色模式下都會是同一個底色。
   *   ⚠️ 走 token,**不要寫色碼** —— 深淺兩色都靠它。
   *   同一個做法見 `pages/Login.tsx` 的 `styles.page`(整頁路由都要自己畫底)。
   */
  fullPage: {height: '100dvh', backgroundColor: 'var(--color-background-body)'},
  /**
   * 動畫的 host:canvas 是 absolute inset:0,所以這一層要有明確的寬高。
   * ⚠️ 寬度用 `min()` 夾住:手機上才不會被寫死的寬度切掉。
   */
  stage: {
    position: 'relative',
    width: 'min(100%, 720px)',
    height: 380,
  },
  /**
   * 「正在載入」那一條。**風只是氛圍,它不負責告訴人發生什麼事** ——
   * 一條不定量的進度條是大家都認得的那個訊號,而風再怎麼調都只是「有東西在動」。
   * ⚠️ 比舞台**窄一半**:跟舞台等寬時它橫跨整個畫面,看起來像一條分隔線而不是一個進度指示。
   * 設計系統的 `ProgressBar` 本身不改。
   */
  bar: {width: 'min(100%, 360px)'},
  /**
   * **一塊區域**在等內容(管理頁的一個區塊、對話框裡的清單、側欄⋯⋯)用的小一號。
   * 整頁那張 720×380 放進一張卡片會把卡片撐到 400 多高、載完又縮回去,
   * 版面整個跳一次;這裡把舞台縮小,進度條跟著縮(維持「比舞台窄一半」那條)。
   * 上下留一點空,風才不會貼著卡片邊緣。
   * ⚠️ **長寬比要跟大舞台一樣**(720:380 ≈ 1.9)。場景的世界座標是「上下固定、左右跟著寬度延伸」,
   * 拉成 3:1 時上下被切成一條方塊、線又擠成一團,看起來是灰色雜訊不是風。
   * 同比例縮小就是同一陣風的縮小版。
   */
  compactRoot: {gap: 'var(--spacing-2)', paddingBlock: 'var(--spacing-4)'},
  compactStage: {width: 'min(100%, 304px)', height: 160},
  compactBar: {width: 'min(100%, 152px)'},
});

/** 小舞台的線條數:大舞台 280 條 × 面積比(304×160 ÷ 720×380 ≈ 0.18)再略多一點,小框裡才看得出是一陣風 */
const COMPACT_LINES = 60;

type Props = {
  /**
   * 這一次是**整頁**的載入(未登入 / 身分還沒回來),不是某一頁在換路由。
   * 整頁的要自己撐滿視窗高度;路由那次的外面已經有版面撐著了。
   */
  isFullPage?: boolean;
  /**
   * 要不要跑 three.js 那張場景(風)。**預設跑。**
   *
   * 整頁、路由切換、管理頁區塊、對話框清單⋯⋯**整塊區域在等內容的一律是風**。
   * 小轉圈(對話頁 Thinking…、SSH AI 的「想一下」、按鈕 isLoading、拼圖執行中)維持 Spinner。
   *
   * 唯一關掉的地方是 `App.tsx` 外層 Suspense 在開機前那一格(被開機蓋子壓住,看不到;`hasScene={isBooted}`);WebGL 建不起來時自動退回 Spinner(`hasFailed`)。
   */
  hasScene?: boolean;
  /** 一塊區域(卡片、對話框、側欄)裡的載入:舞台與進度條都小一號,見 `compactStage` */
  isCompact?: boolean;
  /** 進度條上那一行字,也是報讀的內容。管理頁那幾塊照慣例傳中文 */
  label?: string;
};

export function LoadingScreen({isFullPage = false, hasScene = true, isCompact = false, label = 'Loading'}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const mode = useThemeMode();
  /**
   * ⚠️ 用**訂閱**不是快照 —— 不要在 effect 裡改讀一次 `matchMedia(...).matches`。
   * 理由與代價寫在底下建場景那支 effect 上面。
   */
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const handleRef = useRef<LoadingHandle | null>(null);
  /**
   * 場景是 async 載進來的。handle 就緒時佈景可能早就定了,而底下那支重上色的
   * effect 的依賴那時候不會再變 —— 靠這個旗標讓它在 handle 到位後補跑一次。
   * 做法跟 `HostStage` 一樣。
   */
  const [isSceneReady, setIsSceneReady] = useState(false);
  /*
   * 「Loading」的報讀走設計系統那支常駐的 live region,不靠畫面上那一句。
   *
   * `role="status"` **帶著文字一起插進 DOM** 時,多數螢幕閱讀器不保證會念 ——
   * live region 的規格保證的是「已經存在的區域內容變了」。`useAnnounce` 維護的是
   * 一對常駐的 polite / assertive 區域,把字塞進去,過一下自己清掉。
   * ⚠️ 條件要**同時**看 `hasScene` 與 `hasFailed`:那兩種情況畫的是 `Spinner`,
   *    它自己帶 `label`,這裡再報一次就會念兩遍。
   *
   * ⚠️ 已知限制:
   *  1. 設計系統的 `Spinner` 用的**就是** `role="status"` + 同時渲染的 label ——
   *     也就是上面說不可靠的那個模式。所以「WebGL 失敗」那條路不受這段保護。
   *  2. `useAnnounce` 會在兩秒後自清,而載入畫面常駐得更久 ——
   *     晚一步才把螢幕閱讀器指過來的人讀不到任何狀態;
   *     `role="status"` 的做法至少一直留在無障礙樹裡。
   *  這裡選的是「插進來那一刻一定會念」。
   */
  const announce = useAnnounce();
  useEffect(() => {
    if (hasScene && !hasFailed) announce(label);
  }, [announce, hasScene, hasFailed, label]);

  // 建場景。依賴**不含 mode** —— 換深 / 淺色不必把整個 WebGL context 連同 canvas
  // 拆掉重建,改用 `loading-scene.ts` 的 `setPalette`。
  //
  // `reducedMotion` **要進依賴**:那個旗標是在建場景時一次餵進去的,`LoadingHandle`
  // 只有 setPalette / dispose,沒有改它的管道。所以偏好一變就得重建一顆 ——
  // 這跟顏色不一樣,顏色有 setPalette 可以改,動不動是寫死在那條迴圈裡的。
  // ⚠️ 不重建的話,使用者在系統設定裡打開「減少動態」時,這顆已經建好的場景收不到,
  //    那條 rAF 迴圈會一路跑下去。重建的代價是切換那一刻多建一顆 renderer,
  //    看不出黑畫面,而且這個系統設定很少切換。
  useEffect(() => {
    if (!hasScene) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    void import('./loading-scene')
      .then(({createLoadingScene}) =>
        // 分包還在路上時就已經載完、卸掉了(資料秒回的區塊很常見)—— 不要再建一顆馬上丟掉的 renderer,
        // 而且宿主已經離開 DOM,這時讀到的顏色也可能是空的
        cancelled
          ? null
          : createLoadingScene(
          host,
          {
            accent: resolveCssColor(host, '--color-accent'),
            background: resolveCssColor(host, '--color-background-body'),
          },
          reducedMotion,
          // 小舞台面積約是大的 1/5.6,線也照比例少 —— 280 條塞進去是一團灰
          isCompact ? COMPACT_LINES : undefined,
        ),
      )
      .then(
        (scene) => {
          if (!scene) return;
          // 等它建好的這段時間可能已經載完了 —— 那就直接收掉,不要留一顆在跑的 renderer
          if (cancelled) scene.dispose();
          else {
            handleRef.current = scene;
            setIsSceneReady(true);
          }
        },
        () => {
          // ⚠️ 失敗這條路徑**不要**設 `isSceneReady` —— 沒有 handle,補送重上色沒有意義。
          if (!cancelled) setHasFailed(true);
        },
      );

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
      setIsSceneReady(false);
    };
  }, [hasScene, reducedMotion, isCompact]);

  // 換佈景只重上色 —— 不重建。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    handleRef.current?.setPalette({
      accent: resolveCssColor(host, '--color-accent'),
      background: resolveCssColor(host, '--color-background-body'),
    });
  }, [mode, isSceneReady]);

  return (
    <VStack xstyle={[styles.root, isCompact && styles.compactRoot, isFullPage && styles.fullPage]}>
      {hasScene && !hasFailed ? (
        <>
          {/* 這一層是 three.js 的 render host(它自己往裡面塞 canvas),
              跟 LoginScene 同一類,是刻意的例外,不是版面用的 div。
              動畫是純裝飾,狀態由 `useAnnounce` 報讀(見上面那段),
              底下那一句是給看得見的人的。 */}
          <div ref={hostRef} {...stylex.props(styles.stage, isCompact && styles.compactStage)} aria-hidden />
          {/*
            ⚠️ `label` 就是畫面上那行字(`ProgressBar` 預設會把它畫出來),所以這裡
            **不要**再補一顆 `<Text>` —— 補了會變成兩行 Loading。
            報讀走上面那支 `useAnnounce`;這一條自己是 `role="progressbar"`,兩邊不衝突。
          */}
          <Stack xstyle={[styles.bar, isCompact && styles.compactBar]}>
            <ProgressBar label={label} isIndeterminate />
          </Stack>
        </>
      ) : (
        <Spinner label={label} />
      )}
    </VStack>
  );
}
