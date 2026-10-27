// @vitest-environment jsdom
/**
 * 認出 entry chunk 的檔名 —— 整個版本偵測唯一的判斷依據。
 *
 * 需要 jsdom:`entryFromHtml` 走 `DOMParser`,刻意跟 `readCurrentEntry()`
 * 用同一個選擇器,兩邊才比得起來(見 `appVersion.ts` 的說明)。
 */
import {describe, expect, it} from 'vitest';

import {entryFromHtml, parseEntry} from '../appVersion';

describe('parseEntry', () => {
  it('認得 build 出來的 entry', () => {
    expect(parseEntry('/assets/index-Dr68Pp7X.js')).toBe('index-Dr68Pp7X.js');
    // hash 允許 - 與 _(base64url 的那兩個字元,實際 build 出現過)
    expect(parseEntry('/assets/index-4yW-ThUm.js')).toBe('index-4yW-ThUm.js');
    expect(parseEntry('/assets/index-BB4_kmRF.js')).toBe('index-BB4_kmRF.js');
  });

  it('css 不是 entry', () => {
    expect(parseEntry('/assets/index-DiWTwwMI.css')).toBeNull();
  });

  it('開發模式的 entry 沒有 hash,認不得 —— 整個功能會因此關掉', () => {
    // vite dev server 給的是這個。比對不出東西來,所以 isWatchable() 要是 false,
    // 不然本機開發每存一次檔都會以為「有新版」。
    expect(parseEntry('/src/main.tsx')).toBeNull();
  });

  it('沒有 src 就是沒有', () => {
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry(undefined)).toBeNull();
    expect(parseEntry('')).toBeNull();
  });

  /*
   * ⚠️ 回歸測試:**只認 entry,不能認其他分包。**
   *
   * `dist/assets` 底下有 86 個檔,除了 entry 以外都是 `lazy()` 切出來的分包。
   * 它們的 hash 各自獨立 —— 只改了 Stats 那一頁的話,`Stats-xxx.js` 會變、
   * entry 不會變。要是這支把分包也收進來,「伺服器上的第一個 js」就不再是
   * 同一個東西,比對會在兩邊都沒換版的情況下得到不同答案,提示就會亂跳。
   */
  it('不認其他分包', () => {
    expect(parseEntry('/assets/Stats-B4pu92RV.js')).toBeNull();
    expect(parseEntry('/assets/Login-BsOMT1tV.js')).toBeNull();
    expect(parseEntry('/assets/rolldown-runtime-hePW80VL.js')).toBeNull();
    // 名字裡**含有** index 但不是 entry 的也不能收
    expect(parseEntry('/assets/reindex-AbCdEf12.js')).toBeNull();
  });

});

describe('entryFromHtml', () => {
  it('從整份 index.html 裡挑得出來', () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon.svg" />
      <link rel="modulepreload" href="/assets/rolldown-runtime-hePW80VL.js">
      <script type="module" crossorigin src="/assets/index-CGfGjure.js"></script>
      </head><body><div id="root"></div></body></html>`;
    expect(entryFromHtml(html)).toBe('index-CGfGjure.js');
  });

  /*
   * ⚠️ 回歸測試:**只認 `<script type="module">`,不要掃整份 HTML 的文字。**
   *
   * 之前是用正則掃第一個 `/assets/index-*.js`。`modulepreload` 那幾行排在
   * entry 的 script 前面(實際 build 就是這個順序),所以哪天有人寫了
   * `pages/index.tsx` 之類的東西被切成 `index-*.js` 分包並 preload,
   * 掃到的就會是那顆 —— 而本頁那邊讀的是 script 標籤,兩邊認的東西不一樣,
   * 就會在**其實同版**的情況下判成「有新版」,每次上版都跳提示。
   */
  it('preload 的同名分包不能蓋過真正的 entry', () => {
    const html = `
      <link rel="modulepreload" href="/assets/index-DECOY01.js">
      <link rel="modulepreload" href="/assets/themeProps-9LhqDPvw.js">
      <script type="module" crossorigin src="/assets/index-B74_5CR2.js"></script>`;
    expect(entryFromHtml(html)).toBe('index-B74_5CR2.js');
  });

  it('沒有 module script 就是認不得', () => {
    expect(entryFromHtml('<html><body>Bad gateway</body></html>')).toBeNull();
    expect(entryFromHtml('')).toBeNull();
  });

  /*
   * 後端重啟那幾秒可能回一段 HTML 錯誤頁。認不得要回 null,讓呼叫端
   * 當成「沒事發生」—— 把「讀不到」當成「有新版」的話,那幾秒內全站會一起重整。
   */
  it('錯誤頁不會被當成新版', () => {
    expect(entryFromHtml('<html><head><title>502</title></head><body>oops</body></html>')).toBeNull();
  });
});
