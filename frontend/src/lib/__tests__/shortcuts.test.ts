import {describe, expect, it} from 'vitest';

import {holdPetEars, isPetListening} from '../../pet/petSpeech';
import {
  chordKeys,
  chordLabel,
  chordsCollide,
  cleanOverrides,
  collisionWith,
  defaultChord,
  recordKey,
  resolveShortcut,
  sameChord,
  SHORTCUTS,
} from '../shortcuts';

const ev = (key: string, mods: Partial<{ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean}> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const c = (key: string, mods: Partial<{mod: boolean; shift: boolean; alt: boolean}> = {}) => ({
  mod: false,
  shift: false,
  alt: false,
  key,
  ...mods,
});

describe('快捷鍵', () => {
  it('預設三個:Ctrl+K、Ctrl+Shift+O、Ctrl+Shift+S', () => {
    expect(SHORTCUTS.map((s) => [s.id, chordKeys(s.binding)])).toEqual([
      ['search', 'mod+k'],
      ['new_chat', 'mod+shift+o'],
      ['sidebar', 'mod+shift+s'],
    ]);
    expect(defaultChord('new_chat')).toBe(SHORTCUTS[1].binding);
  });

  it('錄鍵:只按修飾鍵還不算;Shift 下的大寫存小寫;⌘ 與 Ctrl 都算 mod', () => {
    expect(recordKey(ev('Shift', {shiftKey: true}))).toEqual({kind: 'wait'});
    expect(recordKey(ev('O', {ctrlKey: true, shiftKey: true}))).toEqual({kind: 'chord', chord: c('o', {mod: true, shift: true})});
    expect(recordKey(ev('j', {metaKey: true}))).toEqual({kind: 'chord', chord: c('j', {mod: true})});
    expect(recordKey(ev('n', {altKey: true}))).toEqual({kind: 'chord', chord: c('n', {alt: true})});
  });

  it('錄鍵:沒帶 Ctrl / Alt 的不收;Esc 取消;Tab 讓焦點離開', () => {
    for (const key of ['Enter', ' ', 'a', 'ArrowDown']) expect(recordKey(ev(key)).kind).toBe('needs-modifier');
    expect(recordKey(ev('A', {shiftKey: true})).kind).toBe('needs-modifier');
    expect(recordKey(ev('Escape')).kind).toBe('cancel');
    expect(recordKey(ev('Tab')).kind).toBe('leave');
    expect(recordKey(ev('Tab', {shiftKey: true})).kind).toBe('leave');
  });

  it('Kbd / useHotkeys 的字串:方向鍵與 + 號換成它們認得的名字', () => {
    expect(chordKeys(c('ArrowUp', {mod: true, alt: true}))).toBe('mod+alt+up');
    expect(chordKeys(c('+', {mod: true}))).toBe('mod+plus');
  });

  it('報讀的字照平台念', () => {
    expect(chordLabel(c('o', {mod: true, shift: true}), false)).toBe('Ctrl + Shift + O');
    expect(chordLabel(c('o', {mod: true, shift: true}), true)).toBe('Command + Shift + O');
  });

  it('撞鍵照 useHotkeys 的比法:Shift 不管,Ctrl / Alt / 鍵要一樣', () => {
    expect(chordsCollide(c('o', {mod: true}), c('o', {mod: true, shift: true}))).toBe(true);
    expect(chordsCollide(c('o', {mod: true}), c('o', {alt: true}))).toBe(false);
    expect(chordsCollide(c('O', {mod: true}), c('o', {mod: true}))).toBe(true);
    // 把 Toggle sidebar 改成 Ctrl+O 會撞到 New chat 的 Ctrl+Shift+O
    expect(collisionWith({}, 'sidebar', c('o', {mod: true}))).toBe('new_chat');
    // 停用的不算
    expect(collisionWith({new_chat: false}, 'sidebar', c('o', {mod: true}))).toBeUndefined();
    // 自己不算
    expect(collisionWith({}, 'search', c('k', {mod: true}))).toBeUndefined();
  });

  it('清洗:不認得的 id、壞掉的值、沒帶 Ctrl / Alt 的丟掉;停用留著;跟預設一樣的改動丟掉', () => {
    expect(
      cleanOverrides({
        search: false,
        new_chat: {mod: true, shift: true, key: 'o'},
        sidebar: {mod: true, key: 'b'},
        nope: false,
      }),
    ).toEqual({search: false, sidebar: c('b', {mod: true})});
    expect(cleanOverrides({search: {key: ''}, new_chat: 'x', sidebar: {mod: true, key: 'x'.repeat(17)}})).toEqual({});
    expect(cleanOverrides({search: {key: 'Enter'}, sidebar: {mod: true, key: '\u0000'}})).toEqual({});
    expect(cleanOverrides(null)).toEqual({});
    expect(cleanOverrides([1])).toEqual({});
  });

  it('現在是哪一組:沒改過照預設、停用回 false', () => {
    expect(resolveShortcut({}, 'search')).toEqual(SHORTCUTS[0].binding);
    expect(resolveShortcut({search: false}, 'search')).toBe(false);
    const b = c('b', {mod: true});
    expect(resolveShortcut({sidebar: b}, 'sidebar')).toBe(b);
    expect(sameChord(c('O', {mod: true}), c('o', {mod: true}))).toBe(true);
  });
});

describe('吉祥物在不在聽(PetSpeechToast 靠它決定要不要發 toast)', () => {
  it('掛上才算在聽,放掉就不算;兩隻各自算', () => {
    expect(isPetListening()).toBe(false);
    const a = holdPetEars();
    const b = holdPetEars();
    expect(isPetListening()).toBe(true);
    a();
    expect(isPetListening()).toBe(true);
    b();
    expect(isPetListening()).toBe(false);
  });
});
