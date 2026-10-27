/**
 * 串流中的切法:追查依據的標題一出現就收進摺疊區,不先攤在上半段。
 */
import {describe, expect, it} from 'vitest';

import {splitAnswer, splitStreamingAnswer} from '../answerSections';

const FULL = `上個月採購金額前 5 大廠商如下。

來源：apmq501 採購單數量/日期查詢

## 追查依據
- 執行代號 x-20261005-0211
- SQL：SELECT ...`;

/** 模擬串流:一個字一個字送 */
const prefixes = (s: string) => Array.from({length: s.length + 1}, (_, i) => s.slice(0, i));

describe('splitStreamingAnswer', () => {
  it('串流的每一個時間點,上半段都不會出現依據的內容或半個標題', () => {
    for (const part of prefixes(FULL)) {
      const {body} = splitStreamingAnswer(part);
      expect(body).not.toContain('追查');
      expect(body).not.toContain('x-20261005');
      expect(body).not.toMatch(/#\s*$/);
    }
  });

  it('標題送完整之後,依據邊收邊長', () => {
    const cut = FULL.indexOf('- SQL');
    const {body, evidence} = splitStreamingAnswer(FULL.slice(0, cut));
    expect(body).toBe('上個月採購金額前 5 大廠商如下。\n\n來源：apmq501 採購單數量/日期查詢');
    expect(evidence).toBe('- 執行代號 x-20261005-0211');
  });

  it('還沒到標題時沒有摺疊區', () => {
    expect(splitStreamingAnswer('上個月採購金額').evidence).toBeNull();
  });

  it('答完那一刻跟 splitAnswer 切出來的上半段一樣,不會跳', () => {
    expect(splitStreamingAnswer(FULL).body).toBe(splitAnswer(FULL).body);
    expect(splitStreamingAnswer(FULL).evidence).toBe(splitAnswer(FULL).evidence);
  });

  it('一般的小標題只晚半拍出現,換行一到就顯示', () => {
    expect(splitStreamingAnswer('結論\n### 小結').body).toBe('結論');
    expect(splitStreamingAnswer('結論\n### 小結\n').body).toBe('結論\n### 小結');
  });

  it('整則只有依據(標題前面沒有結論)不收 —— 答完 splitAnswer 也不收,不會攤開', () => {
    const onlyEvidence = '## 追查依據\n- 執行代號 x-1\n- SQL：SELECT 1';
    for (const part of prefixes(onlyEvidence).filter((p) => p.endsWith('\n') || p === onlyEvidence)) {
      expect(splitStreamingAnswer(part).evidence).toBeNull();
    }
    expect(splitStreamingAnswer(onlyEvidence).body).toBe(splitAnswer(onlyEvidence).body);
  });

  it('舊格式【追查依據】也認得', () => {
    const {body, evidence} = splitStreamingAnswer('結論\n\n## 【追查依據】\n- a');
    expect(body).toBe('結論');
    expect(evidence).toBe('- a');
  });
});
