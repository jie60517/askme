/**
 * 版本(知識庫)id → 顯示名稱。
 */
import {describe, expect, it} from 'vitest';

import {buildKnowledgeBaseLabels, describeKnowledgeBase} from '../knowledgeBase';
import type {AppConfig} from '../chatApi';

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    default_model: 'opus',
    allowed_models: ['opus'],
    knowledge_bases: [
      {id: 'kb-main', label: 'Main docs', suggestions: []},
      {id: 'kb-new', label: 'Product docs (26/08)', suggestions: []},
    ],
    default_knowledge_base: 'kb-main',
    max_upload_mb: 0,
    max_concurrent_asks: 2,
    ...over,
  };
}

describe('buildKnowledgeBaseLabels', () => {
  it('現行的 id 直接對到 label', () => {
    const labels = buildKnowledgeBaseLabels(config());
    expect(labels.get('kb-main')).toBe('Main docs');
  });

  it('清單上沒有的 id → 照實標 (removed)', () => {
    // 假裝它還在會讓人拿著不存在的版本去對答案
    const labels = buildKnowledgeBaseLabels(config());
    expect(describeKnowledgeBase('kb-old', labels)).toBe('kb-old (removed)');
  });
});
