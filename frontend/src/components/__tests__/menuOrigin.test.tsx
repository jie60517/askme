// @vitest-environment jsdom
/**
 * 選單 morph 從哪個角長出來(`MenuHighlightLayer` 的 `menuOrigin` / `orientMenu`)。
 *
 * 守的是:往下開 → 左上角、往下落(預設的樣子);翻到 anchor 上面 → 從下緣長、往上浮;
 * 翻到左邊 → 從右緣長。以及「量不到 anchor 就回到 CSS 的預設值」,
 * 和 `beforetoggle` 打開時真的會去寫變數。
 */
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render} from '@testing-library/react';

import {MenuHighlightLayer, menuOrigin, orientMenu} from '../MenuHighlightLayer';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
  x: left,
  y: top,
  toJSON: () => ({}),
});

describe('menuOrigin', () => {
  // 「⋯」鈕在 (100,100),24×24
  const trigger = box(100, 100, 24, 24);

  it('往右下開(below-start)→ 左上', () => {
    expect(menuOrigin(box(100, 128, 200, 160), trigger)).toEqual({x: 'left', y: 'top'});
  });
  it('靠下緣翻到上面 → 從下緣長', () => {
    expect(menuOrigin(box(100, -64, 200, 160), trigger)).toEqual({x: 'left', y: 'bottom'});
  });
  it('靠右緣翻到左邊(span-left)→ 從右緣長', () => {
    expect(menuOrigin(box(-76, 128, 200, 160), trigger)).toEqual({x: 'right', y: 'top'});
  });
  it('右鍵選單的 anchor 是游標上的一個點:翻到左上 → 右下角', () => {
    const cursor = box(500, 400, 0, 0);
    expect(menuOrigin(box(300, 240, 200, 160), cursor)).toEqual({x: 'right', y: 'bottom'});
  });
  it('跟觸發鈕一樣寬(minWidth = anchor-size)時打平 → 左', () => {
    expect(menuOrigin(box(100, 128, 24, 160), trigger).x).toBe('left');
  });
});

/** 搭一份設計系統長相的 DOM:popover(行內 position-anchor)> [role=menu],anchor 的行內樣式有 anchor-name */
function mount(panel: ReturnType<typeof box>, anchorBox: ReturnType<typeof box> | null) {
  const popover = document.createElement('div');
  (popover.style as unknown as Record<string, string>).positionAnchor = '--layer-7';
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  popover.appendChild(menu);
  popover.getBoundingClientRect = () => panel as DOMRect;
  document.body.appendChild(popover);
  if (anchorBox) {
    const anchor = document.createElement('span');
    // jsdom 的 CSSStyleDeclaration 不認 anchor-name:屬性字串給選擇器比對,屬性值給程式讀
    anchor.setAttribute('style', 'anchor-name: --layer-7');
    (anchor.style as unknown as Record<string, string>).anchorName = '--other, --layer-7';
    anchor.getBoundingClientRect = () => anchorBox as DOMRect;
    document.body.appendChild(anchor);
  }
  return {popover, menu};
}

describe('orientMenu', () => {
  it('翻到上面:寫 bottom 與往上浮的 --menu-drop', () => {
    const {popover, menu} = mount(box(100, -64, 200, 160), box(100, 100, 24, 24));
    orientMenu(popover);
    expect(menu.style.getPropertyValue('--menu-origin-y')).toBe('bottom');
    expect(menu.style.getPropertyValue('--menu-origin-x')).toBe('left');
    expect(menu.style.getPropertyValue('--menu-drop')).toBe('1');
  });

  it('找不到 anchor:把上一次的方向拿掉,回到 CSS 預設', () => {
    const {popover, menu} = mount(box(100, 128, 200, 160), null);
    menu.style.setProperty('--menu-origin-y', 'bottom');
    menu.style.setProperty('--menu-drop', '1');
    orientMenu(popover);
    expect(menu.style.getPropertyValue('--menu-origin-y')).toBe('');
    expect(menu.style.getPropertyValue('--menu-drop')).toBe('');
  });

  it('beforetoggle(open)之後、下一個 microtask 就寫好', async () => {
    render(<MenuHighlightLayer />);
    const {popover, menu} = mount(box(-76, 128, 200, 160), box(100, 100, 24, 24));
    const ev = Object.assign(new Event('beforetoggle'), {newState: 'open'});
    popover.dispatchEvent(ev);
    expect(menu.style.getPropertyValue('--menu-origin-x')).toBe('');
    await Promise.resolve();
    expect(menu.style.getPropertyValue('--menu-origin-x')).toBe('right');
    expect(menu.style.getPropertyValue('--menu-drop')).toBe('-1');
  });

  it('beforetoggle(closed)不動它', async () => {
    render(<MenuHighlightLayer />);
    const {popover, menu} = mount(box(-76, 128, 200, 160), box(100, 100, 24, 24));
    popover.dispatchEvent(Object.assign(new Event('beforetoggle'), {newState: 'closed'}));
    await Promise.resolve();
    expect(menu.style.getPropertyValue('--menu-origin-x')).toBe('');
  });
});
