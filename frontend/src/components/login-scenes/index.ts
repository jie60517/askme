/**
 * 登入頁的場景清單:進首頁時隨機挑一款。
 *
 * 每一款都是**動態載入**的:一次只會用到其中一款,全部靜態 import 的話,
 * 每個進到登入頁的人都得先下載三款,而其中兩款他這次根本不會看到。
 * 代價是多一個 await(在 three.js 那個 await 旁邊,沒有多一次往返的感覺)。
 */
import type {SceneFactory} from './types';

type SceneEntry = {
  name: string;
  /** 真的要用它時才載入 */
  load: () => Promise<SceneFactory>;
};

const SCENES: SceneEntry[] = [
  {name: 'ripple', load: () => import('./ripple').then((m) => m.ripple)},
  {name: 'spectrum', load: () => import('./spectrum').then((m) => m.spectrum)},
  {name: 'particles', load: () => import('./particles').then((m) => m.particles)},
];

/**
 * 算力吃重的兩款,觸控裝置不抽。
 *
 * `ripple` 每一格在 CPU 端跑 (SEGMENTS+1)² = 5,329 個頂點,每個含三個 `Math.sin`
 * 加一次 `Math.hypot`(它自己的註解就寫「這一段一格要跑五千多次」);
 * `particles` 是 900 顆。而窄視窗時這塊會排到**整頁最上面、滿欄寬**(見 `pages/Login.tsx`
 * 的 `splitImage`),等於手機開登入頁第一眼就吃這個量。
 *
 * ⚠️ 判準用 `(any-pointer: coarse)` 而不是 `lib/media.ts` 的 `MOBILE_QUERY`(768):
 * 那一條問的是「要不要切成手機版面」,這一條問的是「這台機器的算力」——
 * 窄的桌機視窗照樣有桌機的 CPU。
 */
const HEAVY_SCENES = new Set(['ripple', 'particles']);

export function pickScene(isLowPower = false): SceneEntry {
  const pool = isLowPower ? SCENES.filter((s) => !HEAVY_SCENES.has(s.name)) : SCENES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 目錄外只用得到 `SceneHandle`(`LoginScene.tsx` 拿它存 handle);其餘型別
// 各場景直接 `from './types'`,不必經過這個入口。
export type {SceneHandle} from './types';
