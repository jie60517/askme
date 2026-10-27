/**
 * @ 提及規則。
 * ⚠️ 這些案例對應後端 `notes.py` 的 `_MENTION` —— 兩邊必須一模一樣,
 * 改任何一邊都要讓這份測試跟後端的 `test_notes_mentions.py` 同時過。
 */
import {describe, expect, it} from 'vitest';

import {looksLikeMention, mentionedUsernames} from '../mentions';

const KNOWN = ['ming', 'ming2', 'sarah'];

describe('mentionedUsernames', () => {
  it('中文緊貼也算(打中文不會在 @ 前面空一格)', () => {
    expect(mentionedUsernames('請@ming看一下', KNOWN)).toEqual(['ming']);
  });

  it('email 不觸發(@ 前面是英數字)', () => {
    expect(mentionedUsernames('寄到 user@example.com', KNOWN)).toEqual([]);
  });

  it('@ming2 不會被當成 @ming', () => {
    expect(mentionedUsernames('@ming2 你看', KNOWN)).toEqual(['ming2']);
  });

  it('大小寫不敏感,回傳的是名單裡的原字', () => {
    expect(mentionedUsernames('@MING 你看', KNOWN)).toEqual(['ming']);
  });

  it('保序去重', () => {
    expect(mentionedUsernames('@sarah @ming @sarah', KNOWN)).toEqual(['sarah', 'ming']);
  });

  it('對不上名單的當普通文字', () => {
    expect(mentionedUsernames('@nobody 在嗎', KNOWN)).toEqual([]);
  });

  it('排除自己(比對不分大小寫)', () => {
    expect(mentionedUsernames('@ming @sarah', KNOWN, 'MING')).toEqual(['sarah']);
  });
});

describe('looksLikeMention', () => {
  it('看起來像 @ 人就是 true,不管對不對得上帳號', () => {
    expect(looksLikeMention('@whoever 幫我看')).toBe(true);
  });

  it('同一個字串連問兩次要一樣(不帶 g 的 regex,lastIndex 不殘留)', () => {
    const text = '@ming 你看一下';
    expect(looksLikeMention(text)).toBe(true);
    expect(looksLikeMention(text)).toBe(true);
  });

  it('email 不算', () => {
    expect(looksLikeMention('user@example.com')).toBe(false);
  });
});
