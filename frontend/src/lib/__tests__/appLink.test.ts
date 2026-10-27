/** isRouterHref:哪些連結交給 React Router,哪些讓瀏覽器自己走。 */
import {describe, expect, it} from 'vitest';

import {isRouterHref} from '../appLink';

describe('isRouterHref', () => {
  it('前端路由交給 Router', () => {
    expect(isRouterHref('/')).toBe(true);
    expect(isRouterHref('/stats')).toBe(true);
    expect(isRouterHref('/c/abc123')).toBe(true);
    // 開頭是 /api 但不是 /api/ 的前端路由不要被誤傷
    expect(isRouterHref('/apiary')).toBe(true);
  });

  it('外部網址、寄信、電話、錨點讓瀏覽器處理', () => {
    expect(isRouterHref('https://example.com')).toBe(false);
    expect(isRouterHref('http://localhost:8123/api/files/abc/a.md')).toBe(false);
    expect(isRouterHref('mailto:someone@example.com')).toBe(false);
    expect(isRouterHref('tel:0212345678')).toBe(false);
    expect(isRouterHref('#main')).toBe(false);
  });

  it('沒有 href 就是普通的 <a>', () => {
    expect(isRouterHref(undefined)).toBe(false);
    expect(isRouterHref('')).toBe(false);
  });

  /*
   * 這條是回歸測試:VITE_API_BASE 留空時下載網址是相對路徑,
   * 走進 RouterLink 的話點下去只會畫出 NotFound,一個位元組都不會下載。
   */
  it('指向後端的相對網址不要走 Router', () => {
    expect(isRouterHref('/api/files/e9197ba0f55449c09c9526f3ed3a81eb/conversation.md')).toBe(false);
    expect(isRouterHref('/api/uploads/e9197ba0f55449c09c9526f3ed3a81eb/報價單.xlsx')).toBe(false);
    expect(isRouterHref('/api/files/abc/a.png?inline=1')).toBe(false);
    expect(isRouterHref('/api/preview/files/abc/a.docx')).toBe(false);
  });
});
