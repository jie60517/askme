import {fileURLToPath} from 'node:url';

import {astryxStylex} from '@astryxdesign/build/vite';
import react from '@vitejs/plugin-react';
// ⚠️ `defineConfig` 要從 **vitest/config** 拿,不是 `vite` —— vite 那支的型別
// 不認得 `test` 這個鍵,加了設定會是 TS2769。執行期兩者一樣,差別只在型別。
import {defineConfig} from 'vitest/config';

/**
 * `/api` 轉給後端的規則。`server`(dev)與 `preview`(跑 `dist/`)共用同一份 ——
 * **量效能一定要在 `preview` 上量**:dev 的 React 與 StyleX 都是開發版,
 * 同一個動作在 dev 上可能慢好幾倍,拿 dev 的數字當結論會去優化一個 build 產物裡根本沒有的問題。
 */
const apiProxy = {
  '/api': {
    target: process.env.API_TARGET || 'http://localhost:8123',
    changeOrigin: true,
    // SSH 終端機的 WebSocket(/api/terminal/ws)也要轉,不然本機開發時握手會被 vite 吃掉
    ws: true,
  },
};

/*
 * ⚠️ **不掛 React Compiler**:在長串流的對話頁上它讓主執行緒更忙、long task 變多,
 * 還加大 bundle 與建置時間。`Chat.tsx` 該擋的 render 已經用 `React.memo` 手工擋掉,
 * 編譯器的自動記憶化只是每次 render 多做一次快取比對。
 *
 * 要量的話:對著 `dist/`(`npm run preview`)量「16ms 計時器遲到多久」,不是幀間隔 ——
 * rAF 在背景或嵌入式的瀏覽器分頁裡會被節流。而且先確認機器是安靜的:`npm run test`
 * 收尾時「close timed out」留下的 vitest worker 會各吃滿一顆核心好一陣子。
 */
export default defineConfig({
  plugins: [...astryxStylex(), react()],
  /** 跑 `dist/` 的那台(`npm run preview`)。要打 API 就得跟 dev 一樣轉 `/api`。 */
  preview: {
    port: Number(process.env.PREVIEW_PORT) || 4173,
    proxy: apiProxy,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    /*
     * `/api` 轉給後端,讓**本機跟正式部署一樣是同一個 origin**。不要改成跨 origin 直連後端:
     *   1. 下載網址會變成絕對網址,跟正式部署的相對網址行為不同(見 lib/appLink.ts)。
     *   2. 下載用的 HttpOnly cookie 只有同源才送得出去(見後端 auth.SESSION_COOKIE)。
     *
     * 要改打別台設 `API_TARGET`,例如 `API_TARGET=http://localhost:8100 npm run dev`。
     */
    /*
     * ⚠️ **跑測試時一定要關掉。** vitest 用的是同一份 config,而它為 jsdom 環境
     * 起的那個 Vite server 一旦帶著 proxy 就會卡住 —— 症狀正是 `.claude/CLAUDE.md`
     * 記的那兩種:單獨跑會 `Timeout waiting for worker to respond`,整組跑則是
     * **安靜地少收 jsdom 的測試檔然後回報成功**。
     */
    proxy: process.env.VITEST ? undefined : apiProxy,
  },
  test: {
    /*
     * 預設跑在 `node`,**不是** jsdom —— 這裡絕大多數測試是純函式
     * (`lib/` 底下那些),給它們一個 DOM 只是白白變慢。
     *
     * 需要 DOM 的檔案自己在第一行寫 `// @vitest-environment jsdom`
     * (見 `components/__tests__/PersonDisplay.test.tsx`)。用檔案層級的註解
     * 而不是 `environmentMatchGlobs`:後者在 vitest 3 之後已經棄用,
     * 而註解這個寫法各版都成立。
     */
    environment: 'node',
    /*
     * ⚠️ **元件測試不要 import `pages/Chat.tsx`**。那個檔案很大、
     * 連著整組元件的 StyleX transform,在 jsdom 裡光是 import 就會讓 worker
     * 逾時(vitest 報「Timeout waiting for worker to respond」)。要測的東西先抽成自己的模組
     * —— `components/PersonDisplay.tsx` 就是為了這件事抽出來的。
     */
    testTimeout: 10_000,
  },
});
