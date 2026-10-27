/**
 * 拖曳類元件共用的多點觸控保護(`lib/pointerOwner.ts`)。規則寫在那個檔的檔頭。
 */
import {describe, expect, it} from 'vitest';

import {STALE_MS, createPointerOwner} from '../pointerOwner';

const touch = (pointerId: number, isPrimary = true) => ({pointerId, pointerType: 'touch', isPrimary});
const mouse = (pointerId: number) => ({pointerId, pointerType: 'mouse', isPrimary: true});

function setup() {
  let t = 0;
  const owner = createPointerOwner(() => t);
  return {owner, advance: (ms: number) => (t += ms)};
}

describe('pointerOwner', () => {
  it('沒人在用就接手,放開之後換別人', () => {
    const {owner} = setup();
    expect(owner.claim(touch(1))).toBe('claimed');
    expect(owner.owns(touch(1))).toBe(true);
    expect(owner.release(touch(1))).toBe(true);
    expect(owner.isActive).toBe(false);
    expect(owner.claim(mouse(9))).toBe('claimed');
  });

  it('第二根手指(不是主指標)不理,也放不掉第一根', () => {
    const {owner} = setup();
    owner.claim(touch(1));
    expect(owner.claim(touch(2, false))).toBe('ignored');
    expect(owner.owns(touch(2))).toBe(false);
    expect(owner.release(touch(2))).toBe(false);
    expect(owner.owns(touch(1))).toBe(true);
  });

  it('同一種的主指標又按下來 = 上一次的收尾漏了,換這一根', () => {
    const {owner} = setup();
    owner.claim(touch(1));
    expect(owner.claim(touch(7))).toBe('restarted');
    expect(owner.owns(touch(7))).toBe(true);
    expect(owner.owns(touch(1))).toBe(false);
  });

  it('別種指標搶不走正在進行的手勢', () => {
    const {owner, advance} = setup();
    owner.claim(mouse(1));
    advance(500);
    expect(owner.claim(touch(5))).toBe('ignored');
    expect(owner.owns(mouse(1))).toBe(true);
  });

  it('舊手勢太久沒動靜:別種指標也能接手(收尾事件真的丟了,不能永遠卡死)', () => {
    const {owner, advance} = setup();
    owner.claim(touch(1));
    advance(STALE_MS + 1);
    expect(owner.claim(mouse(9))).toBe('restarted');
  });

  it('有在動的手勢不算沒動靜', () => {
    const {owner, advance} = setup();
    owner.claim(touch(1));
    advance(STALE_MS - 100);
    owner.owns(touch(1)); // 一次 move
    advance(STALE_MS - 100);
    expect(owner.claim(mouse(9))).toBe('ignored');
  });
});
