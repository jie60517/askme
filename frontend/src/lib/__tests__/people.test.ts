/** `personName`(只動第一個字元)與 `filterPeople`(只比開頭)。 */
import {describe, expect, it} from 'vitest';

import {filterPeople, personName} from '../people';

describe('personName', () => {
  it('把第一個字母改成大寫', () => {
    expect(personName('ming')).toBe('Ming');
  });

  it('只動第一個字元 —— 使用者自己打的大小寫要保留', () => {
    expect(personName('mingChen')).toBe('MingChen');
    expect(personName("o'brien")).toBe("O'brien");
  });

  it('中文原字返回、空值回空字串', () => {
    expect(personName('小明')).toBe('小明');
    expect(personName(null)).toBe('');
    expect(personName(undefined)).toBe('');
    expect(personName('')).toBe('');
  });
});

describe('filterPeople', () => {
  const people = [
    {username: 'jacky', display_name: 'Jacky'},
    {username: 'sarah', display_name: 'Sarah'},
    {username: 'stuart', display_name: 'Stuart'},
    {username: 'ming', display_name: '小明'},
  ];

  it('空查詢回全部(順序不動)', () => {
    expect(filterPeople(people, '')).toEqual(people);
    expect(filterPeople(people, '  ')).toEqual(people);
  });

  it('只比開頭(打 a 是找開頭是 a 的)', () => {
    const hits = filterPeople(people, 's');
    expect(hits.map((p) => p.username)).toEqual(['sarah', 'stuart']);
  });

  it('子字串**不**命中(includes 的做法已收回,不要加回來)', () => {
    expect(filterPeople(people, 'ky')).toEqual([]);
    const list = [
      {username: 'ann', display_name: 'Ann'},
      {username: 'joanne', display_name: 'Joanne'},
    ];
    expect(filterPeople(list, 'an').map((p) => p.username)).toEqual(['ann']);
  });

  it('顯示名稱也比(中文名找得到)', () => {
    expect(filterPeople(people, '小明').map((p) => p.username)).toEqual(['ming']);
  });

  it('不分大小寫', () => {
    expect(filterPeople(people, 'JAC').map((p) => p.username)).toEqual(['jacky']);
  });

  it('沒命中就是空陣列', () => {
    expect(filterPeople(people, 'zzz')).toEqual([]);
  });

  /*
   * 注音的還原搬進來了(呼叫端的 onChange 不能改寫值,
   * 那會把輸入法的組字打斷)。兩件事要同時成立 ——
   */
  it('注音打出來的符號還原成英打(想搜 jacky 不必先切輸入法)', () => {
    // 大千式鍵盤上 j / a / c / k / y = ㄨ / ㄇ / ㄏ / ㄜ / ㄗ
    expect(filterPeople(people, 'ㄨㄇㄏㄜㄗ').map((p) => p.username)).toEqual(['jacky']);
  });
});
