import {describe, expect, it} from 'vitest';

import {splitAnswer} from '../answerSections';

describe('splitAnswer', () => {
  it('splits at the heading and drops the heading line itself', () => {
    const {body, evidence} = splitAnswer('結論在這裡。\n\n## 追查依據\n\n`billing.py:75`');
    expect(body).toBe('結論在這裡。');
    expect(evidence).toBe('`billing.py:75`');
  });

  it('still recognises the older 【追查依據】 form', () => {
    // DB 裡幾百則舊回答用的是帶方頭括號的版本,認不得的話它們全部不會摺疊
    const {body, evidence} = splitAnswer('結論。\n\n## 【追查依據】\n細節');
    expect(body).toBe('結論。');
    expect(evidence).toBe('細節');
  });

  it('accepts any heading level', () => {
    for (const hashes of ['#', '##', '###', '######']) {
      expect(splitAnswer(`結論\n${hashes} 追查依據\n細節`).evidence).toBe('細節');
    }
  });

  it('leaves a plain answer alone', () => {
    const answer = '這支作業是參數設定作業,用途是指定哪些欄位由集團控管。';
    expect(splitAnswer(answer)).toEqual({body: answer, evidence: null});
  });

  it('does not split on the words appearing mid-sentence', () => {
    // 只有自成一行的標題才是切點 —— 內文提到這四個字不算
    const answer = '我把追查依據整理在下面。\n\n讀了 billing.py 之後…';
    expect(splitAnswer(answer).evidence).toBeNull();
  });

  it('does not split when the heading has other words on the line', () => {
    expect(splitAnswer('結論\n## 追查依據與後續建議\n細節').evidence).toBeNull();
  });

  it('keeps everything visible when the heading is the last thing in the answer', () => {
    // 串流正好切在標題上、或模型印了標題就沒下文:摺疊區會是一顆點開來空的按鈕
    const answer = '結論。\n\n## 追查依據\n\n   ';
    expect(splitAnswer(answer)).toEqual({body: answer, evidence: null});
  });

  it('keeps everything visible when there is no conclusion above the heading', () => {
    // 全部摺起來的話畫面上一個字都沒有,看起來像壞掉
    const answer = '## 追查依據\n細節';
    expect(splitAnswer(answer)).toEqual({body: answer, evidence: null});
  });

  it('folds a second heading into the first evidence block', () => {
    const {body, evidence} = splitAnswer('結論\n## 追查依據\n甲\n## 追查依據\n乙');
    expect(body).toBe('結論');
    expect(evidence).toBe('甲\n## 追查依據\n乙');
  });
});
