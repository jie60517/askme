// @vitest-environment jsdom
/**
 * 個人設定裡 Companion 底下那一塊(`components/CompanionLook.tsx`)。
 *
 * 測的是畫面上看不出來、壞了也沒人會發現的幾件事:
 *  1. 選 Classic 時型態 / 顏色那塊收起來了,而且是 `inert` —— 按鈕還在 DOM 裡(要演完收合),
 *     不擋的話鍵盤會 Tab 進一顆看不見的按鈕;
 *  2. 每顆只有圖示的按鈕都有報讀用的名字,而且**沒有 tooltip**(畫面上不放說明);
 *  3. 點了會寫進偏好(本機)並送伺服器,單選群組「再點一次已選的」不會把值清掉;
 *  4. 調色盤:點了往下長出來、選回色票就收起來(收起來時一樣要 inert),挑的色碼存同一個欄位。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  BLOB_COLOR_DEFAULT,
  BLOB_SHAPE_DEFAULT,
  setBlobColor,
  setBlobShape,
  setLastCustomColor,
} from '../../lib/companionPref';
import CompanionLook from '../CompanionLook';

const saveBlobLook = vi.fn(async () => {});
vi.mock('../../lib/loginApi', () => ({saveBlobLook: (...a: unknown[]) => saveBlobLook(...(a as []))}));
// 引擎本身不是這裡要測的(它要 rAF、canvas、matchMedia,jsdom 都沒有);換成空殼
vi.mock('../../pet/BloubAvatar', () => ({BloubAvatar: () => null, BLOB_SIZE_PX: 112}));

// ⚠️ 只載入一次,不要每條 `vi.resetModules()` 重新 import:那會讓整套設計系統每條重新轉譯一次,
// 整批跑時每條會超過 10 秒而逾時。偏好的初值由 beforeEach 直接設回預設。
afterEach(cleanup);
beforeEach(() => {
  setBlobShape(BLOB_SHAPE_DEFAULT);
  setBlobColor(BLOB_COLOR_DEFAULT);
  setLastCustomColor('#3b93f0');
  localStorage.clear();
  saveBlobLook.mockClear();
});

function mount(companion: 'classic' | 'blob') {
  return render(<CompanionLook companion={companion} />);
}

const group = (root: HTMLElement, label: string) => root.querySelector(`[aria-label="${label}"]`) as HTMLElement;

describe('CompanionLook', () => {
  it('Classic:型態 / 顏色那塊是 inert(鍵盤進不去)', async () => {
    const {container} = mount('classic');
    const shape = group(container, 'Shape');
    expect(shape).toBeTruthy();
    expect(shape.closest('[inert]')).not.toBeNull();
  });

  it('Bloub:那塊不是 inert,8 種型態、11 種顏色 + 調色盤都有報讀名字', async () => {
    const {container} = mount('blob');
    const shape = group(container, 'Shape');
    const color = group(container, 'Color');
    expect(shape.closest('[inert]')).toBeNull();
    const names = (g: HTMLElement) => [...g.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names(shape)).toEqual(['Circle', 'Pebble', 'Squircle', 'Capsule', 'Triangle', 'Hexagon', 'Cloud', 'Drop']);
    expect(names(color)).toEqual([
      'Auto', 'Gray', 'Brown', 'Red', 'Orange', 'Amber', 'Green', 'Teal', 'Blue', 'Violet', 'Pink', 'Custom color',
    ]);
  });

  it('滑到按鈕上不會出 tooltip', async () => {
    const {container} = mount('blob');
    const cloud = container.querySelector('[aria-label="Cloud"]') as HTMLElement;
    await userEvent.hover(cloud);
    expect(document.querySelectorAll('[role="tooltip"]').length).toBe(0);
    expect(cloud.getAttribute('aria-describedby')).toBeNull();
  });

  it('點了 → 寫進偏好、送伺服器;再點一次已選的不會清掉', async () => {
    const {container} = mount('blob');
    const cloud = container.querySelector('[aria-label="Cloud"]') as HTMLElement;
    await userEvent.click(cloud);
    expect(localStorage.getItem('t100_companion_shape')).toBe('nuage');
    expect(saveBlobLook).toHaveBeenLastCalledWith({shape: 'nuage'});

    await userEvent.click(cloud);
    expect(localStorage.getItem('t100_companion_shape')).toBe('nuage');
    expect(saveBlobLook).toHaveBeenCalledTimes(1);

    await userEvent.click(container.querySelector('[aria-label="Blue"]') as HTMLElement);
    expect(localStorage.getItem('t100_companion_color')).toBe('bleu');
    expect(saveBlobLook).toHaveBeenLastCalledWith({color: 'bleu'});
  });

  it('調色盤:點了換成上次挑的那色並往下長出來;選回色票就收起來', async () => {
    const {container} = mount('blob');
    const pad = () => container.querySelector('[aria-label="Saturation and brightness"]') as HTMLElement;
    expect(pad().closest('[inert]')).not.toBeNull();

    await userEvent.click(container.querySelector('[aria-label="Custom color"]') as HTMLElement);
    expect(localStorage.getItem('t100_companion_color')).toBe('#3b93f0');
    expect(saveBlobLook).toHaveBeenLastCalledWith({color: '#3b93f0'});
    expect(pad().closest('[inert]')).toBeNull();

    // 已經在用自訂色時再點一次 = 收起來,顏色不變
    await userEvent.click(container.querySelector('[aria-label="Custom color"]') as HTMLElement);
    expect(pad().closest('[inert]')).not.toBeNull();
    expect(localStorage.getItem('t100_companion_color')).toBe('#3b93f0');

    await userEvent.click(container.querySelector('[aria-label="Custom color"]') as HTMLElement);
    await userEvent.click(container.querySelector('[aria-label="Blue"]') as HTMLElement);
    expect(localStorage.getItem('t100_companion_color')).toBe('bleu');
    expect(pad().closest('[inert]')).not.toBeNull();
  });

  it('調色盤:打色碼 → 套用、記成上次挑的;還沒送的那筆關掉時送出去', async () => {
    const {container, unmount} = mount('blob');
    await userEvent.click(container.querySelector('[aria-label="Custom color"]') as HTMLElement);
    saveBlobLook.mockClear();
    const hex = within(container).getByLabelText('Hex') as HTMLInputElement;
    await userEvent.clear(hex);
    await userEvent.type(hex, 'E8590C');
    expect(localStorage.getItem('t100_companion_color')).toBe('#e8590c');
    expect(localStorage.getItem('t100_companion_custom')).toBe('#e8590c');
    // 打字中途(還不是合法色碼)不送;停下來之前也還沒送
    expect(saveBlobLook).not.toHaveBeenCalled();
    unmount();
    expect(saveBlobLook).toHaveBeenCalledTimes(1);
    expect(saveBlobLook).toHaveBeenLastCalledWith({color: '#e8590c'});
  });

  it('調色盤:還沒送的自訂色,改選色票時丟掉(不然兩個請求互搶,帳號可能停在自訂色)', async () => {
    const {container, unmount} = mount('blob');
    await userEvent.click(container.querySelector('[aria-label="Custom color"]') as HTMLElement);
    saveBlobLook.mockClear();
    const hex = within(container).getByLabelText('Hex') as HTMLInputElement;
    await userEvent.clear(hex);
    await userEvent.type(hex, '2fb380');
    await userEvent.click(container.querySelector('[aria-label="Blue"]') as HTMLElement);
    unmount();
    expect(saveBlobLook.mock.calls).toEqual([[{color: 'bleu'}]]);
  });
});
