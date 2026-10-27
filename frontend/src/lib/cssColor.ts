/**
 * 把 CSS 變數解析成 three.js / xterm 吃得下的顏色。
 *
 * 直接讀變數會拿到 `light-dark(#262626, #ebebeb)` 這種還沒決議的值;掛一個看不見的 span
 * 讓瀏覽器算一次 `color`,拿回來的就是 `rgb(...)`。登入頁的場景、終端機的連線動畫與
 * xterm 的 theme 都靠它 —— 場景與終端機裡不准出現色碼(換佈景會對不上)。
 */
export function resolveCssColor(host: HTMLElement, cssVar: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${cssVar})`;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  host.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}
