/**
 * 小夥伴(Classic)的氣泡高度(`pet-sprites.ts` 的 `bubbleDropPx`)。
 *
 * 一張圖一個值。守兩件事:每個狀態用到的圖都量過
 * (換圖忘了重量的話氣泡會退回單一規格、飄在頭頂上方一大截),以及氣泡不會壓到
 * 那張圖的內容頂端。
 */
import {describe, expect, it} from 'vitest';

import {PET_SPRITES, bubbleDropPx} from '../pet-sprites';

/** 認不得的圖退回的舊規格 —— 用來判斷「這張沒量過」 */
const FALLBACK = bubbleDropPx('/pet/not-a-real-sprite.gif');

describe('bubbleDropPx', () => {
  it('每個狀態用到的圖都有量過的頂端', () => {
    const missing = Object.entries(PET_SPRITES)
      .filter(([, sprite]) => bubbleDropPx(sprite.src) === FALLBACK)
      .map(([state, sprite]) => `${state} → ${sprite.src}`);
    expect(missing).toEqual([]);
  });

  it('閒晃那張貼近頭頂,不再照最高那張擺', () => {
    // idle.gif 內容頂端 99px,留 16px → 83;舊的單一規格是 28
    expect(bubbleDropPx('/pet/idle.gif')).toBe(83);
  });

  it('跳最高的那幾張氣泡也比較高,不會蓋到角色', () => {
    expect(bubbleDropPx('/pet/happy.gif')).toBeLessThan(bubbleDropPx('/pet/idle.gif'));
    expect(bubbleDropPx('/pet/react-double-jump.gif')).toBeLessThan(bubbleDropPx('/pet/idle.gif'));
  });

  it('認不得的圖與沒有圖時退回舊規格', () => {
    expect(FALLBACK).toBe(28);
    expect(bubbleDropPx(null)).toBe(28);
  });
});
