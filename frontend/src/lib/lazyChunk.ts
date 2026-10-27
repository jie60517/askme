/**
 * `lazy()` 的替身,多一層「分包抓不到就重新載入一次」。
 *
 * 為什麼需要:上版之後 `dist/assets` 底下的檔名整批換過,而**已經開著的舊分頁**
 * 手上那份 JS 記的還是舊檔名。他一點側邊欄的 Stats / Users / SSH Server,
 * 動態 import 就去要一個已經不存在的檔 → 404 → promise reject →
 * `ErrorBoundary` 接住,畫面變成「This page stopped working」。
 *
 * 使用者不會把這個講成「看到舊畫面」,會講成「壞了」—— 但成因跟舊分頁看不到
 * 新功能是同一個(見 `lib/appVersion.ts` 的開頭)。這裡是那件事的兜底:
 * 真的抓不到就整頁重載,載回來就是新版,他只會覺得那一下慢了一點。
 *
 * ⚠️ **只重載一次。** 記號寫在 sessionStorage,不然「分包真的壞掉」
 * (build 出來就少檔、CDN 掛了)會變成無限重整,而那比白畫面糟得多 ——
 * 白畫面至少還能按重新整理,無限重整連關掉分頁都來不及。
 *
 * ⚠️ **記號是「上次重載的時間」,不是一個會被清掉的布林。** 寫成
 * 「成功載入就 removeSessionKey」會變成無限迴圈:
 * 頁面掛著好幾個 `lazyChunk`,重載之後 `PetCompanion` 之類的先載成功就把記號抹掉,
 * 接著 `Users` 再次 404 —— 於是它以為自己是第一次失敗,再重載一次,永遠出不來。
 * 記號屬於「這個分頁最近重載過」,不屬於任何一個分包的成敗,所以沒有人該清它。
 */
import {lazy, type ComponentType, type LazyExoticComponent} from 'react';

import {readSessionString, writeSessionString} from './safeStorage';

const RELOADED_KEY = 't100_chunk_reloaded_at';

/**
 * 這麼久之內重載過就不要再重載。
 *
 * 一分鐘足夠涵蓋「一次上版造成的連環 404」(重載一次就全好了),又不會把
 * 半小時後的**另一次**上版也一起擋掉 —— 那一次該有自己的重載機會。
 */
const COOLDOWN_MS = 60 * 1000;

/*
 * 約束抄 React 自己的 `lazy`(`T extends ComponentType<any>`)。
 * 這是這支檔案裡唯一的 `any`,而且是**跟著上游型別走**不是放棄型別:
 * 換成 `unknown` / `never` 都會在 `lazy()` 那一行爆 TS2344 ——
 * `ComponentType` 的 props 是逆變的,收窄它等於讓任何真實元件都不合格。
 * 泛型 T 本身照樣把各頁的 props 型別帶回呼叫端。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyChunk<T extends ComponentType<any>>(
  factory: () => Promise<{default: T}>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((err: unknown) => {
      const lastReload = Number(readSessionString(RELOADED_KEY)) || 0;
      // 剛重載過還是抓不到 = 這不是「舊分頁要舊檔名」,是分包真的有問題。
      // 交給 ErrorBoundary 出一句話跟一顆重新整理,比再重載一次誠實。
      if (Date.now() - lastReload < COOLDOWN_MS) throw err;

      writeSessionString(RELOADED_KEY, String(Date.now()));
      window.location.reload();
      // 重載已經在路上,這個 promise 永遠不要 settle —— resolve 或 reject
      // 都會讓 React 在畫面被換掉之前先閃一下錯誤畫面。
      return new Promise<never>(() => {});
    }),
  );
}
