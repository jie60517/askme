/**
 * 全站唯一那份使用者名冊。
 *
 * 這裡守的是四件會靜悄悄壞掉的事:
 *  1. `mentionablePeople()` 要把**自己**濾掉 —— `registerSelf()` 為了共用名單的
 *     頭像把自己併進 roster,但 @ 選單裡不該出現自己。
 *  2. 「抓失敗」跟「系統裡只有你一個」要分得出來。
 *  3. 名冊沒變時 `mentionablePeople()` 要回**同一個參考** —— 呼叫端拿它當
 *     `useMemo` 的相依,每次都回新陣列的話那些 memo 等於沒有作用。
 *  4. 名字與職稱由這裡解析,`@` 膠囊與頭像浮層才會給出同一個答案。
 *
 * ⚠️ 模組是有狀態的(roster 放在模組層),所以每一個 case 都要
 * `resetModules()` 之後重新 import,不然上一個 case 的名冊會漏過來。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';

const ROSTER = [
  {username: 'ming', display_name: '陳小明', role: 'Consultant', avatar: 'data:image/jpeg;base64,AAA'},
  {username: 'yu', display_name: 'Yu', role: 'Software engineer', avatar: null},
];

const listShareableUsers = vi.fn();

vi.mock('../conversationsApi', () => ({
  listShareableUsers: () => listShareableUsers(),
}));

async function freshModule() {
  vi.resetModules();
  return import('../peopleDirectory');
}

beforeEach(() => {
  listShareableUsers.mockReset();
  listShareableUsers.mockResolvedValue(ROSTER);
});

describe('載入與查詢', () => {
  it('抓一次就好 —— 重複呼叫不會再打一次 API', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    await dir.loadPeopleDirectory();
    expect(listShareableUsers).toHaveBeenCalledTimes(1);
  });

  it('名字、職稱、頭像都查得到,查不到回 undefined', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();

    expect(dir.displayNameOf('ming')).toBe('陳小明');
    expect(dir.roleOf('ming')).toBe('Consultant');
    expect(dir.avatarOf('ming')).toBe('data:image/jpeg;base64,AAA');

    // 沒設頭像的人回 undefined,`Avatar` 會退回名字縮寫 —— 那不是錯誤
    expect(dir.avatarOf('yu')).toBeUndefined();
    expect(dir.displayNameOf('nobody')).toBeUndefined();
    expect(dir.roleOf(null)).toBeUndefined();
  });

  it('帳號不分大小寫 —— 後端有些地方回帳號、有些回顯示名稱', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    expect(dir.displayNameOf('MING')).toBe('陳小明');
  });
});

describe('mentionablePeople', () => {
  it('把自己濾掉', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    dir.registerSelf({username: 'ming', display_name: '陳小明', avatar: null});

    const names = dir.mentionablePeople().map((p) => p.username);
    expect(names).toEqual(['yu']);
    // 但共用名單那一側仍然查得到自己,不然一整排的人都有照片、只有你是縮寫
    expect(dir.displayNameOf('ming')).toBe('陳小明');
  });

  it('名冊沒變時回同一個參考(呼叫端拿它當 useMemo 的相依)', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    expect(dir.mentionablePeople()).toBe(dir.mentionablePeople());
  });

  it('registerSelf 之後參考要換掉,不然畫面不會跟著更新', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    const before = dir.mentionablePeople();
    dir.registerSelf({username: 'ming', display_name: '陳小明', avatar: null});
    expect(dir.mentionablePeople()).not.toBe(before);
  });
});

describe('抓失敗 vs 系統裡只有你一個', () => {
  it('成功時 failed 是 false', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    expect(dir.peopleDirectoryFailed()).toBe(false);
  });

  it('抓失敗要標起來,而且名冊是空的 —— 兩者長得一樣,只能靠這個旗標分', async () => {
    listShareableUsers.mockRejectedValue(new Error('boom'));
    const dir = await freshModule();
    await dir.loadPeopleDirectory();

    expect(dir.peopleDirectoryFailed()).toBe(true);
    expect(dir.mentionablePeople()).toEqual([]);
  });

  it('失敗之後可以重試,而且成功時要把旗標清掉', async () => {
    listShareableUsers.mockRejectedValueOnce(new Error('boom'));
    const dir = await freshModule();

    await dir.loadPeopleDirectory();
    expect(dir.peopleDirectoryFailed()).toBe(true);

    await dir.loadPeopleDirectory();
    expect(dir.peopleDirectoryFailed()).toBe(false);
    expect(dir.mentionablePeople()).toHaveLength(2);
  });
});

describe('還在抓 vs 抓完了但沒有人(peopleDirectoryLoaded)', () => {
  /*
   * `ShareDialog` 靠這個旗標決定要轉圈還是講「沒有人可以分享」。
   * 少了它就只能看 `mentionablePeople().length === 0`,而那兩件事在那個
   * 判斷下長得一模一樣 —— 名冊還在路上的時候會直接顯示「沒有人」。
   */
  it('還沒開始抓 = 還沒載完', async () => {
    const dir = await freshModule();
    expect(dir.peopleDirectoryLoaded()).toBe(false);
  });

  it('抓成功算載完', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    expect(dir.peopleDirectoryLoaded()).toBe(true);
  });

  it('抓失敗**也算載完** —— 該停止轉圈,改顯示那條載入失敗的 Banner', async () => {
    listShareableUsers.mockRejectedValue(new Error('boom'));
    const dir = await freshModule();
    await dir.loadPeopleDirectory();

    expect(dir.peopleDirectoryLoaded()).toBe(true);
    expect(dir.peopleDirectoryFailed()).toBe(true);
  });
});

describe('登出要清掉名冊(resetPeopleDirectory)', () => {
  /*
   * 這一組守的是:名冊放在模組層,而登出
   * **不重新整理頁面**(`signOut()` 只清 token)。不清的話,同一個分頁換一個
   * 人登入時看到的是上一個人的名冊,而 `mentionablePeople()` 濾掉的也還是
   * 上一個人 —— 新登入的人反而 @ 得到自己。
   */
  it('清掉之後名冊是空的,而且回到「還沒載入」', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    expect(dir.mentionablePeople()).toHaveLength(2);

    dir.resetPeopleDirectory();

    expect(dir.mentionablePeople()).toEqual([]);
    expect(dir.peopleDirectoryLoaded()).toBe(false);
    expect(dir.peopleDirectoryFailed()).toBe(false);
    expect(dir.displayNameOf('ming')).toBeUndefined();
    expect(dir.rosterIndexOf('ming')).toBeUndefined();
  });

  it('清掉之後會重新抓 —— 不是永久停在空名冊', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    dir.resetPeopleDirectory();

    await dir.loadPeopleDirectory();

    expect(listShareableUsers).toHaveBeenCalledTimes(2);
    expect(dir.mentionablePeople()).toHaveLength(2);
  });

  it('**`selfKey` 也要清掉** —— 不清的話新登入的人 @ 得到自己、卻 @ 不到前一個人', async () => {
    const dir = await freshModule();
    dir.registerSelf({username: 'ming', display_name: '陳小明'});
    await dir.loadPeopleDirectory();
    // ming 是「自己」,所以 @ 名單裡只剩 yu
    expect(dir.mentionablePeople().map((p) => p.username)).toEqual(['yu']);

    dir.resetPeopleDirectory();
    // 換成 yu 登入
    dir.registerSelf({username: 'yu', display_name: 'Yu'});
    await dir.loadPeopleDirectory();

    expect(dir.mentionablePeople().map((p) => p.username)).toEqual(['ming']);
  });
});

describe('rosterIndexOf(頭像配色照名冊位置分)', () => {
  it('依帳號排序後的位置,而不是名冊回來的順序', async () => {
    const dir = await freshModule();
    await dir.loadPeopleDirectory();
    // 排序後是 ming, yu
    expect(dir.rosterIndexOf('ming')).toBe(0);
    expect(dir.rosterIndexOf('yu')).toBe(1);
  });

  it('名冊還沒載完時回 undefined —— 那時候配色會退回雜湊', async () => {
    const dir = await freshModule();
    expect(dir.rosterIndexOf('ming')).toBeUndefined();
  });
});
