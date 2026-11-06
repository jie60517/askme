// @vitest-environment jsdom
/**
 * `styles/global.css`「巢狀列的縮排」那兩條規則認的是設計系統 SideNavItem 的 StyleX 動態變數
 * `--x-paddingInlineStart`(Astryx 0.7.8)。那不是公開介面 —— 升版改了名字,
 * 規則就靜靜失效,資料夾底下的對話列、筆記樹的子頁又會貼回左邊。這一檔就是那條線上的警報。
 *
 * 驗兩種列:一般的巢狀列(變數在 `.astryx-side-nav-item` 自己身上),
 * 以及「本身有連結又能展開」的列(變數在 `.astryx-side-nav-item` 底下那個 `<a>` 上)。
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render} from '@testing-library/react';

import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';

afterEach(cleanup);

const HOOK = '--x-paddingInlineStart';

describe('SideNavItem 的巢狀縮排變數(global.css 認它)', () => {
  it('一般巢狀列與有連結又能展開的列,都帶著 global.css 認的那個變數', () => {
    const {container} = render(
      <SideNav aria-label="Test">
        <SideNavSection title="Test" isHeaderHidden>
          <SideNavItem label="Folder" collapsible={{defaultIsCollapsed: false}}>
            <SideNavItem label="Plain child" href="/plain" />
            <SideNavItem label="Page with kids" href="/page" collapsible={{defaultIsCollapsed: false}}>
              <SideNavItem label="Grandchild" href="/grandchild" />
            </SideNavItem>
          </SideNavItem>
        </SideNavSection>
      </SideNav>,
    );
    const plain = [...container.querySelectorAll<HTMLElement>('.astryx-side-nav-item')].find(
      (e) => e.textContent?.trim() === 'Plain child',
    );
    expect(plain?.getAttribute('style') ?? '').toContain(HOOK);
    const wrapperLink = container.querySelector<HTMLElement>('a[href="/page"]');
    expect(wrapperLink?.parentElement?.classList.contains('astryx-side-nav-item')).toBe(true);
    expect(wrapperLink?.getAttribute('style') ?? '').toContain(HOOK);
  });

  it('global.css 的兩條規則還在,而且認的是同一個名字', () => {
    const css = readFileSync(join(__dirname, '../../styles/global.css'), 'utf8');
    expect(css).toContain(`.astryx-side-nav-item[style*='${HOOK}']`);
    expect(css).toContain(`.astryx-side-nav-item > [style*='${HOOK}']`);
  });
});
