/**
 * `/api/config` 的模型清單快取(`getAllowedModels` / `peekAllowedModels` /
 * `prefetchAllowedModels`)。
 *
 * 這裡守的是四件會靜悄悄壞掉的事:
 *  1. **只問一次** —— 它存在的理由就是「個人設定打開之前清單已經在手上」,
 *     每次都重打就等於沒有快取,那一列又會晚一趟來回才出現。
 *  2. **`peek` 要回同一個陣列參考** —— 對話框拿它當 `useState` 的初值,
 *     之後 effect 還會 `setState` 同一份;不是同一個參考的話那次 setState
 *     會多一次重繪(而且是在進場動畫的中間)。
 *  3. **失敗要把快取清掉** —— 不清的話一次斷線就會讓這個分頁再也問不到清單。
 *  4. **`prefetch` 失敗要靜默** —— 它只是預熱,不該冒出 unhandled rejection。
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

/** 目前登入的 token(對話快取的 key 帶它,換人登入不會讀到上一個人的對話) */
const auth = vi.hoisted(() => ({token: 'token-a' as string | null}));
vi.mock('../auth', () => ({getToken: () => auth.token}));

async function freshModule() {
  vi.resetModules();
  return import('../chatApi');
}

const CONFIG = {
  data: {
    default_model: 'sonnet',
    allowed_models: ['opus', 'sonnet', 'haiku'],
    knowledge_bases: [],
    default_knowledge_base: '',
    max_upload_mb: 0,
    max_concurrent_asks: 1,
  },
};

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue(CONFIG);
  auth.token = 'token-a';
});

describe('getAllowedModels', () => {
  it('只打一次 API —— 第二次走快取', async () => {
    const mod = await freshModule();
    expect(await mod.getAllowedModels()).toEqual(['opus', 'sonnet', 'haiku']);
    expect(await mod.getAllowedModels()).toEqual(['opus', 'sonnet', 'haiku']);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('同時有兩個呼叫端也只打一次', async () => {
    const mod = await freshModule();
    await Promise.all([mod.getAllowedModels(), mod.getAllowedModels()]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('失敗之後快取要清掉,下一次會重新問', async () => {
    const mod = await freshModule();
    get.mockRejectedValueOnce(new Error('offline'));
    await expect(mod.getAllowedModels()).rejects.toThrow('offline');
    expect(await mod.getAllowedModels()).toEqual(['opus', 'sonnet', 'haiku']);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('peekAllowedModels', () => {
  it('還沒問到是 null', async () => {
    const mod = await freshModule();
    expect(mod.peekAllowedModels()).toBeNull();
  });

  it('問到之後回**同一個陣列參考**(對話框拿它當 state 初值)', async () => {
    const mod = await freshModule();
    const list = await mod.getAllowedModels();
    expect(mod.peekAllowedModels()).toBe(list);
  });

  it('那一次失敗不會讓它變成空陣列 —— 仍然是「還沒問到」', async () => {
    const mod = await freshModule();
    get.mockRejectedValueOnce(new Error('offline'));
    await expect(mod.getAllowedModels()).rejects.toThrow();
    expect(mod.peekAllowedModels()).toBeNull();
  });
});

describe('prefetchAllowedModels', () => {
  it('失敗是靜默的,而且之後還問得到', async () => {
    const mod = await freshModule();
    get.mockRejectedValueOnce(new Error('offline'));
    expect(() => mod.prefetchAllowedModels()).not.toThrow();
    // 讓那條被吞掉的 rejection 走完,再確認重試這條路還在
    await Promise.resolve();
    await Promise.resolve();
    expect(await mod.getAllowedModels()).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('預熱過之後,呼叫端拿到的是同一份,不會再打一次', async () => {
    const mod = await freshModule();
    mod.prefetchAllowedModels();
    expect(await mod.getAllowedModels()).toEqual(['opus', 'sonnet', 'haiku']);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

/*
 * 對話頁重掛時的初值:New chat ↔ 對話的過場拍終點畫面用的是掛上的第一格,
 * 那一格要已經有設定、歷史、檔案清單,不然過場演完按鈕才冒出來、整排位移。
 */
describe('peekConfig', () => {
  it('還沒問過是 null,問到之後同步讀得到', async () => {
    const mod = await freshModule();
    expect(mod.peekConfig()).toBeNull();
    await mod.getConfig();
    expect(mod.peekConfig()?.default_model).toBe('sonnet');
  });
});

describe('對話歷史 / 檔案清單的快取', () => {
  const TURNS = {data: [{id: 1, question: 'q'}]};
  const FILES = {data: [{record_id: 1, files: []}]};
  const byUrl = (url: string) => Promise.resolve(url.endsWith('/files') ? FILES : TURNS);

  it('抓過的歷史與檔案清單 peek 得到', async () => {
    get.mockImplementation(byUrl);
    const mod = await freshModule();
    expect(mod.peekConversationTurns('c1')).toBeNull();
    await mod.getConversationTurns('c1');
    await mod.listConversationFiles('c1');
    expect(mod.peekConversationTurns('c1')).toEqual(TURNS.data);
    expect(mod.peekConversationFiles('c1')).toEqual(FILES.data);
  });

  it('換人登入就讀不到上一個人的', async () => {
    get.mockImplementation(byUrl);
    const mod = await freshModule();
    await mod.getConversationTurns('c1');
    auth.token = 'token-b';
    expect(mod.peekConversationTurns('c1')).toBeNull();
  });

  it('預抓一次打兩支(歷史 + 檔案),剛抓過的不再預抓', async () => {
    get.mockImplementation(byUrl);
    const mod = await freshModule();
    mod.prefetchConversation('c1');
    mod.prefetchConversation('c1'); // 還在抓 → 不重打
    await vi.waitFor(() => expect(mod.peekConversationFiles('c1')).not.toBeNull());
    mod.prefetchConversation('c1'); // 剛抓過 → 不重打
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('預抓失敗是靜默的', async () => {
    get.mockRejectedValue(new Error('offline'));
    const mod = await freshModule();
    mod.prefetchConversation('c1');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(mod.peekConversationTurns('c1')).toBeNull();
  });

  it('最多留 30 組,最久沒碰的先丟', async () => {
    get.mockImplementation(byUrl);
    const mod = await freshModule();
    for (let i = 0; i < 31; i++) await mod.getConversationTurns(`c${i}`);
    expect(mod.peekConversationTurns('c0')).toBeNull();
    expect(mod.peekConversationTurns('c30')).not.toBeNull();
  });
});

describe('快取的邊界:換人登入、刪掉的對話、太舊的資料', () => {
  const TURNS = {data: [{id: 1, question: 'q'}]};
  const byUrl = (url: string) => Promise.resolve(url.endsWith('/files') ? {data: []} : url.endsWith('/config') ? CONFIG : TURNS);

  it('設定快取也按登入身分分開:換人登入不先畫上一個人的專案清單', async () => {
    const mod = await freshModule();
    await mod.getConfig();
    expect(mod.peekConfig()).not.toBeNull();
    auth.token = 'token-b';
    expect(mod.peekConfig()).toBeNull();
  });

  it('forgetConversation 之後讀不到(刪掉的對話按上一頁不會被快取救回來)', async () => {
    get.mockImplementation(byUrl);
    const mod = await freshModule();
    await mod.getConversationTurns('c1');
    await mod.listConversationFiles('c1');
    mod.forgetConversation('c1');
    expect(mod.peekConversationTurns('c1')).toBeNull();
    expect(mod.peekConversationFiles('c1')).toBeNull();
  });

  it('太舊的不拿來先畫', async () => {
    vi.useFakeTimers();
    try {
      get.mockImplementation(byUrl);
      const mod = await freshModule();
      await mod.getConversationTurns('c1');
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(mod.peekConversationTurns('c1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
