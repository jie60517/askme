/**
 * 一個 href 該交給 React Router 做前端跳轉,還是讓瀏覽器真的走一趟?
 *
 * 站上所有 Astryx 元件的連結都經過 `App.tsx` 的 `AppLink`(LinkProvider),
 * 而那個決定只有一處 —— 就是這支。抽出來是為了**測得到**。
 *
 * ⚠️ **`/api/...` 是後端的網址,不是前端路由。**
 * 交給 RouterLink 的話點下去只是前端換網址、不發任何請求,而 `<Route>` 裡
 * 沒有這條路徑 —— 最後被 `path="*"` 接住,畫出「Page not found」。
 * 症狀就是「按下載 → Page not found」:`VITE_API_BASE` 留空時,下載鈕是
 * `/api/files/{sid}/{檔名}` 這種**相對**網址,沒有這條判斷就會掉進 RouterLink。
 * (`VITE_API_BASE` 設成絕對網址時走的是 http(s) 那條,不會出事,所以這種錯只在
 * 相對網址的部署上看得到。)加新的「指向後端」的連結時
 * (下載、匯出、任何 `<a href>` 直接打 API 的東西)記得它們都要留在這條線的外面。
 */

/** 瀏覽器自己處理的:外部網址、寄信、打電話、同頁錨點。
 *  `//evil.com` 這種 protocol-relative 也算外部 —— 少了它會被當成前端路由,
 *  React Router 一 navigate 就是開放重導。 */
const BROWSER_HANDLED = /^(https?:|mailto:|tel:|#|\/\/)/;

/** true = 這是前端路由,交給 React Router;false = 讓瀏覽器自己去要。 */
export function isRouterHref(href: string | undefined): href is string {
  if (!href) return false;
  if (BROWSER_HANDLED.test(href)) return false;
  // 後端的網址。見上面那段。
  if (href === '/api' || href.startsWith('/api/')) return false;
  return true;
}
