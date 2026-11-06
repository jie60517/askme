import {describe, expect, it} from 'vitest';

import {
  carryGeneral,
  clearCarriedGeneral,
  generalActive,
  isCarriedGeneral,
  isGeneralConversation,
  parseGeneralCommand,
} from '../generalMode';

describe('一般模式 /general', () => {
  it('只認開頭整個字的 /general,後面帶的字就是這一題', () => {
    expect(parseGeneralCommand('/general')).toEqual({pending: ''});
    expect(parseGeneralCommand('  /general  ')).toEqual({pending: ''});
    expect(parseGeneralCommand('/general 幫我寫 regex\n第二行')).toEqual({pending: '幫我寫 regex\n第二行'});
    expect(parseGeneralCommand('/generalx')).toBeNull();
    expect(parseGeneralCommand('請用 /general')).toBeNull();
  });

  it('從歷史打開:看最後一題記的環境', () => {
    expect(isGeneralConversation([])).toBe(false);
    expect(isGeneralConversation([{knowledge_base: 't100'}, {knowledge_base: 'general'}])).toBe(true);
    expect(isGeneralConversation([{knowledge_base: 'general'}, {knowledge_base: 't100'}])).toBe(false);
    // 還沒記到環境的那一題(串流中)不算,往前看
    expect(isGeneralConversation([{knowledge_base: 'general'}, {knowledge_base: null}])).toBe(true);
  });

  it('自己選過的優先,沒選過跟著這組對話上一題', () => {
    expect(generalActive({choice: null, conversationIsGeneral: true})).toBe(true);
    expect(generalActive({choice: null, conversationIsGeneral: false})).toBe(false);
    expect(generalActive({choice: false, conversationIsGeneral: true})).toBe(false);
    expect(generalActive({choice: true, conversationIsGeneral: false})).toBe(true);
  });

  it('空白頁送出第一句:模式交給新對話那一份,問幾次都在、清了才沒有', () => {
    carryGeneral('conv-1');
    expect(isCarriedGeneral('conv-2')).toBe(false);
    expect(isCarriedGeneral('conv-1')).toBe(true);
    expect(isCarriedGeneral('conv-1')).toBe(true); // StrictMode 跑兩次初始值
    clearCarriedGeneral('conv-1');
    expect(isCarriedGeneral('conv-1')).toBe(false);
  });
});
