// @vitest-environment jsdom
/**
 * 右下角的吉祥物(`lib/companionPref.ts`)。
 *
 * ⚠️ **要 jsdom** —— 這一支讀寫 localStorage。
 *
 * 值得測的是兩條規矩:沒設過一律 classic,
 * 以及伺服器回來的值不認得就不採用(畫不出來的角色不能設進去)。
 * 模組在 import 時讀一次 localStorage,所以每條都用 `vi.resetModules()` 重新載入。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const load = () => import('../companionPref');

describe('吉祥物偏好', () => {
  it('沒設過是 classic', async () => {
    const m = await load();
    expect(m.COMPANION_DEFAULT).toBe('classic');
    expect(localStorage.getItem('t100_companion')).toBeNull();
  });

  it('在設定裡選了 → 寫進 localStorage(下次開頁面同步讀得到)', async () => {
    (await load()).setCompanion('blob');
    expect(localStorage.getItem('t100_companion')).toBe('blob');
  });

  it('本機存了不認得的值 → 當成 classic(之後採用 classic 不會再寫一次,證明現值就是 classic)', async () => {
    localStorage.setItem('t100_companion', 'dragon');
    const m = await load();
    // 退回預設之後再採用同一個值不該寫入(值沒變)
    m.adoptServerCompanion('classic');
    expect(localStorage.getItem('t100_companion')).toBe('dragon');
  });

  it('伺服器回來的值:認得的才採用,null 與不認得的都不動本機', async () => {
    const m = await load();
    m.setCompanion('blob');
    m.adoptServerCompanion(null);
    expect(localStorage.getItem('t100_companion')).toBe('blob');
    m.adoptServerCompanion('dragon');
    expect(localStorage.getItem('t100_companion')).toBe('blob');
    m.adoptServerCompanion('classic');
    expect(localStorage.getItem('t100_companion')).toBe('classic');
  });
});

describe('Bloub 的型態與顏色', () => {
  it('沒設過是圓形 + auto(加這兩項之前的樣子)', async () => {
    const m = await load();
    expect(m.BLOB_SHAPE_DEFAULT).toBe('cercle');
    expect(m.BLOB_COLOR_DEFAULT).toBe('auto');
    expect(localStorage.getItem('t100_companion_shape')).toBeNull();
    expect(localStorage.getItem('t100_companion_color')).toBeNull();
  });

  it('選了 → 寫進 localStorage', async () => {
    const m = await load();
    m.setBlobShape('nuage');
    m.setBlobColor('bleu');
    expect(localStorage.getItem('t100_companion_shape')).toBe('nuage');
    expect(localStorage.getItem('t100_companion_color')).toBe('bleu');
  });

  it('上游的 encre / creme 不收(那就是 auto 的樣子),不認得的型態也不收', async () => {
    const m = await load();
    m.setBlobColor('vert');
    m.adoptServerBlobColor('encre');
    m.adoptServerBlobColor('creme');
    expect(localStorage.getItem('t100_companion_color')).toBe('vert');
    m.setBlobShape('goutte');
    m.adoptServerBlobShape('dragon');
    m.adoptServerBlobShape(null);
    expect(localStorage.getItem('t100_companion_shape')).toBe('goutte');
    m.adoptServerBlobShape('triangle');
    expect(localStorage.getItem('t100_companion_shape')).toBe('triangle');
  });

  it('本機存了不認得的值 → 當成預設', async () => {
    localStorage.setItem('t100_companion_color', 'encre');
    const m = await load();
    // 採用預設值不會寫入(值沒變),證明現值就是 auto
    m.adoptServerBlobColor('auto');
    expect(localStorage.getItem('t100_companion_color')).toBe('encre');
  });

  it('跟後端的白名單是同一份(後端 users.COMPANION_SHAPES / COMPANION_COLORS)', async () => {
    const m = await load();
    expect([...m.BLOB_SHAPES].sort()).toEqual(
      ['capsule', 'cercle', 'galet', 'goutte', 'hexagone', 'nuage', 'squircle', 'triangle'],
    );
    expect([...m.BLOB_COLORS].sort()).toEqual(
      ['ambre', 'auto', 'bleu', 'brun', 'gris', 'orange', 'rose', 'rouge', 'turquoise', 'vert', 'violet'],
    );
  });

  it('調色盤挑的 #rrggbb 也收(只收小寫六碼,後端 users._pick_color 同一條)', async () => {
    const m = await load();
    m.setBlobColor('vert');
    m.adoptServerBlobColor('#e8590c');
    expect(localStorage.getItem('t100_companion_color')).toBe('#e8590c');
    for (const bad of ['#fff', 'e8590c', '#E8590C', '#e8590c80', 'url(#x)']) m.adoptServerBlobColor(bad);
    expect(localStorage.getItem('t100_companion_color')).toBe('#e8590c');
  });

  it('本機存的自訂色讀得回來', async () => {
    localStorage.setItem('t100_companion_color', '#2fb380');
    const m = await load();
    m.adoptServerBlobColor('#2fb380');
    // 值沒變就不寫:證明現值已經是它
    expect(localStorage.getItem('t100_companion_color')).toBe('#2fb380');
    expect(m.isBlobColor('#2fb380')).toBe(true);
  });
});
