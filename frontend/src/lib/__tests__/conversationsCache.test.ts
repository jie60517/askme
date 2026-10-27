/**
 * 對話清單的模組層快取(`listConversations` / `peekConversations` /
 * `resetConversationsCache`)。
 *
 * 這裡守的是三件會靜悄悄壞掉的事:
 *  1. **問過就留著** —— 命令面板靠它在打開的那一幀就有清單可以畫,
 *     沒留的話第一次按 ⌘K 會先閃一下空狀態再跳出清單。
 *  2. **問失敗不要把手上那份洗掉** —— 一次斷線不該讓面板變成空的。
 *  3. **登出一定要清掉** —— 這是**這個人的**對話標題,而模組層的東西活得比頁面久:
 *     登出不重新整理頁面,不清的話同一個分頁換一個人登入,面板一打開鋪上去的是
 *     上一個人的清單。規矩跟名冊(`peopleDirectory`)一樣。
 *     ⚠️ 第 3 條特別要有測試:它不會有任何錯誤訊息,只會在換人登入時**默默外洩**,
 *     而那是最不容易在開發時遇到的一條路。
 *
 * ⚠️ 模組是有狀態的(快取放在模組層),所以每一個 case 都要 `resetModules()`
 * 之後重新 import,不然上一個 case 的快取會漏過來。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';

const get = vi.fn();

vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
  },
}));

async function freshModule() {
  vi.resetModules();
  return import('../conversationsApi');
}

const ROWS = [
  {conversation_id: 'a', title: '嗨一', updated_at: '2026-09-18T01:00:00Z'},
  {conversation_id: 'b', title: '採購單', updated_at: '2026-09-17T01:00:00Z'},
];

beforeEach(() => {
  get.mockReset();
});

describe('對話清單的快取', () => {
  it('還沒問過的時候是空的', async () => {
    const api = await freshModule();
    expect(api.peekConversations()).toEqual([]);
  });

  it('問過一次之後 peek 就拿得到,而且是同一份', async () => {
    get.mockResolvedValue({data: ROWS});
    const api = await freshModule();
    const list = await api.listConversations();
    expect(api.peekConversations()).toBe(list);
    expect(api.peekConversations()).toHaveLength(2);
  });

  it('問失敗不會把手上那份洗掉', async () => {
    get.mockResolvedValueOnce({data: ROWS});
    const api = await freshModule();
    await api.listConversations();

    get.mockRejectedValueOnce(new Error('offline'));
    await expect(api.listConversations()).rejects.toThrow();

    expect(api.peekConversations()).toHaveLength(2);
  });

  it('登出要清掉 —— 不清的話換一個人登入會看到上一個人的對話標題', async () => {
    get.mockResolvedValue({data: ROWS});
    const api = await freshModule();
    await api.listConversations();
    expect(api.peekConversations()).toHaveLength(2);

    api.resetConversationsCache();
    expect(api.peekConversations()).toEqual([]);
  });
});
