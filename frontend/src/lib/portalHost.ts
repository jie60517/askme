/**
 * 自己 `createPortal` 出去的浮層要掛在**佈景那一層**底下,不能直接掛 `document.body`。
 *
 * 佈景(theme-neutral)的 token 宣告在 App 的 `<Theme>` 那個 `div[data-astryx-theme]` 上;
 * `<body>` 那一層讀到的是設計系統的**預設**值(例如 body 的 `--color-accent` 是 `#0064e0` 藍,
 * 佈景裡是 `#262626`)。掛在 body 的話,裡面的按鈕、卡片全是另一套顏色。
 *
 * ⚠️ 選擇器一定要限定 **`div`**:根佈景會把同一個 `data-astryx-theme` 也掛到 `<html>` 上,
 * 不限定的話抓到的是 `<html>`,又回到讀不到 token 的那一層。佈景層是 `display: contents`,
 * 不會變成 `position: fixed` 的定位基準,浮層的位置跟掛在 body 時一樣。
 * SSH 終端機深色時內層也有一個 `div[data-astryx-theme]`,但它是 App 那層的子孫,第一個仍是 App 那層。
 *
 * 找不到(還沒掛上、測試環境)就退回 body。
 */
export function portalHost(): HTMLElement {
  return document.querySelector<HTMLElement>('div[data-astryx-theme]') ?? document.body;
}
