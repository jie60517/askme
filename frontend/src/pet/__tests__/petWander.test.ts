/**
 * 散步路線(`pet/petWander.ts`)。
 *
 * 守的是這幾件事:不翻面(sx 永遠是正的)、不走出可以去的範圍
 * (被拖到左邊時往左走會出畫面)、滾完一定回到正面(停在倒過來的臉很怪)。
 */
import {describe, expect, it} from 'vitest';

import {Wanderer, type WalkStyle} from '../petWander';

/** 固定種子的亂數,讓每次跑的路線一樣 */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function run(style: WalkStyle, seconds: number, range: [number, number] = [-200, 0]) {
  const w = new Wanderer(style, {range, random: seeded(7)});
  const frames = [];
  for (let t = 0; t < seconds; t += 1 / 60) frames.push(w.step(1 / 60));
  return frames;
}

describe.each<WalkStyle>(['hop', 'jelly', 'roll', 'blob'])('%s', (style) => {
  const frames = run(style, 120);

  it('不翻面:水平縮放永遠是正的', () => {
    expect(frames.every((f) => f.sx > 0)).toBe(true);
  });

  it('真的有在走,而且不會走出範圍(果凍蓄力時往後縮的幾 px 除外)', () => {
    const xs = frames.map((f) => f.x);
    expect(Math.min(...xs)).toBeLessThan(-50);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-200 - 4);
    expect(Math.max(...xs)).toBeLessThanOrEqual(0 + 4);
  });

  it('不是一直在動:大部分時間停著', () => {
    const still = frames.filter((f) => !f.moving).length / frames.length;
    expect(still).toBeGreaterThan(0.5);
  });

  it('停著的時候是正的(沒有歪著、沒有倒過來)', () => {
    const rests = frames.filter((f) => !f.moving);
    expect(rests.every((f) => Math.abs(f.rot % 360) < 0.5)).toBe(true);
  });
});

it('範圍很窄時(被拖到牆邊)也找得到地方去,不會原地抖', () => {
  const frames = run('hop', 60, [-60, 0]);
  const xs = frames.map((f) => f.x);
  expect(Math.min(...xs)).toBeLessThanOrEqual(-50);
});

it('bloub(blob):果凍滑行與滾動一趟換一趟 —— 有些趟會轉、有些趟只會傾斜', () => {
  const frames = run('blob', 180);
  // 滾動那幾趟角度會超過 90 度;果凍那幾趟只傾斜幾度,但會指定眼睛方向
  expect(frames.some((f) => Math.abs(f.rot) > 90)).toBe(true);
  expect(frames.some((f) => f.lookX != null)).toBe(true);
});

it('滾到一半被打斷(換狀態、滑鼠指著)→ 位置留著、角度歸零,回來時不會從 0 跳回原本的角度', () => {
  const w = new Wanderer('roll', {range: [-200, 0], random: seeded(3)});
  let f = w.step(0);
  // 走到正在滾的那一刻
  for (let i = 0; i < 60 * 30 && Math.abs(f.rot) < 60; i++) f = w.step(1 / 60);
  expect(Math.abs(f.rot)).toBeGreaterThanOrEqual(60);
  const x = f.x;
  w.interrupt();
  const after = w.step(1 / 60);
  expect(after.rot).toBe(0);
  expect(after.x).toBeCloseTo(x, 0);
  expect(after.moving).toBe(false);
});
