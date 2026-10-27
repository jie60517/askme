// @vitest-environment jsdom
/**
 * 常用模型與「這組對話用哪個」。
 *
 * ⚠️ **要 jsdom** —— 這一支讀寫 localStorage。
 *
 * 為什麼值得測:`pickModel` 的優先序是一條明確的規則
 * (個人常用是 opus 時,在某組對話手動切成 sonnet,重新整理後那組還要是 sonnet,
 * 開新對話才是 opus)。它錯了不會丟例外,
 * 症狀是「換過的對話自己跳回去」或「臨時換一次變成永久設定」——
 * 兩種都要有人剛好注意到才會發現。
 */
import {beforeEach, describe, expect, it} from 'vitest';

import {
  conversationModelOf,
  modelLabel,
  pickModel,
  PREFERRED_MODEL_DEFAULT,
  rememberConversationModel,
} from '../modelPref';

const ALLOWED = ['haiku', 'sonnet', 'opus'];

beforeEach(() => {
  localStorage.clear();
});

describe('每組對話記住自己的模型', () => {
  it('沒選過回 null —— 那時候才輪到個人常用', () => {
    expect(conversationModelOf('conv-1')).toBeNull();
  });

  it('選過就記住', () => {
    rememberConversationModel('conv-1', 'sonnet');
    expect(conversationModelOf('conv-1')).toBe('sonnet');
  });

  /*
   * ⚠️ 這條釘的是「換新的對話框才會是預設的」那一半 —— 兩組對話不能互相汙染。
   */
  it('各組互不影響', () => {
    rememberConversationModel('conv-1', 'sonnet');
    rememberConversationModel('conv-2', 'haiku');
    expect(conversationModelOf('conv-1')).toBe('sonnet');
    expect(conversationModelOf('conv-2')).toBe('haiku');
    expect(conversationModelOf('conv-3')).toBeNull();
  });

  /** 新對話在送出前還沒有 id,呼叫端會傳 undefined 進來。 */
  it('沒有 id 就回 null,不要炸', () => {
    expect(conversationModelOf(undefined)).toBeNull();
    expect(conversationModelOf(null)).toBeNull();
    expect(conversationModelOf('')).toBeNull();
  });

  /*
   * ⚠️ **不能寫進 `t100_preferred_model`** —— 那是「我習慣用的」,
   * 這是「這一組我當初特地換過」。混在一起的話,臨時換一次會變成永久設定,
   * 那就錯了。
   */
  it('不會去動個人常用那一把鍵', () => {
    rememberConversationModel('conv-1', 'haiku');
    expect(localStorage.getItem('t100_preferred_model')).toBeNull();
  });
});

describe('pickModel 的優先序', () => {
  it('這組對話選過的優先', () => {
    expect(pickModel({chosen: 'sonnet', preferred: 'opus', serverDefault: 'haiku', allowed: ALLOWED})).toBe('sonnet');
  });

  it('沒選過就用個人常用', () => {
    expect(pickModel({chosen: null, preferred: 'opus', serverDefault: 'haiku', allowed: ALLOWED})).toBe('opus');
  });

  it('都沒有才退回後端的預設', () => {
    expect(pickModel({chosen: null, preferred: null, serverDefault: 'haiku', allowed: ALLOWED})).toBe('haiku');
  });

  /*
   * ⚠️ 每一階都要過白名單。模型下架或換一台伺服器之後,localStorage 裡會留著
   * 一個沒有人認得的名字 —— 不濾的話輸入框上會印出一個選不到的選項,
   * 而後端會默默退回它自己的預設,於是**使用者看到的跟實際跑的不一樣**。
   */
  it('不在白名單裡的每一階都要跳過', () => {
    expect(pickModel({chosen: 'gone', preferred: 'opus', serverDefault: 'haiku', allowed: ALLOWED})).toBe('opus');
    expect(pickModel({chosen: null, preferred: 'gone', serverDefault: 'haiku', allowed: ALLOWED})).toBe('haiku');
    expect(pickModel({chosen: 'gone', preferred: 'alsogone', serverDefault: 'nope', allowed: ALLOWED})).toBeNull();
  });

  it('環境有預設模型時,排在個人常用前面(環境預設 Sonnet,個人常用 Opus)', () => {
    expect(pickModel({chosen: null, kbDefault: 'sonnet', preferred: 'opus', serverDefault: 'haiku', allowed: ALLOWED})).toBe('sonnet');
  });

  it('這組對話手動選過的仍然比環境預設優先', () => {
    expect(pickModel({chosen: 'opus', kbDefault: 'sonnet', preferred: 'opus', serverDefault: 'haiku', allowed: ALLOWED})).toBe('opus');
  });

  it('環境預設不在白名單、或沒填,就照舊走個人常用', () => {
    expect(pickModel({chosen: null, kbDefault: 'gone', preferred: 'opus', serverDefault: 'haiku', allowed: ALLOWED})).toBe('opus');
    expect(pickModel({chosen: null, kbDefault: null, preferred: 'opus', serverDefault: 'haiku', allowed: ALLOWED})).toBe('opus');
  });

  /** `/api/config` 還沒回來時不知道有哪些能用 —— 那時候不要濾掉任何東西。 */
  it('還不知道白名單就先照用', () => {
    expect(pickModel({chosen: null, preferred: 'opus', serverDefault: undefined, allowed: undefined})).toBe('opus');
  });
});

describe('modelLabel', () => {
  it('只動第一個字元', () => {
    expect(modelLabel('sonnet')).toBe('Sonnet');
    expect(modelLabel('')).toBe('');
  });
});

describe('預設值', () => {
  /** ⚠️ 前端的預設 sonnet,跟後端的 `default_model` 是兩件事。 */
  it('沒設過的人用 sonnet', () => {
    expect(PREFERRED_MODEL_DEFAULT).toBe('sonnet');
  });
});
