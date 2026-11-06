import {describe, expect, it} from 'vitest';

import {mentionRoles} from '../mentionGroups';

describe('mentionRoles', () => {
  it('照 role_id 分組、照 role_rank 排,管理員(role_id 空的)不進任何角色群組', () => {
    const people = [
      {username: 'leo', role: '業務', role_id: 'r_1', role_rank: 2},
      {username: 'ming', role: 'Software engineer', role_id: 'Software engineer', role_rank: 1},
      {username: 'tiptop', role: 'Admin', role_id: '', role_rank: -1},
      {username: 'amy', role: 'Consultant', role_id: 'Consultant', role_rank: 0},
      {username: 'vivian', role: '業務', role_id: 'r_1', role_rank: 2},
    ];
    expect(mentionRoles(people)).toEqual([
      {name: 'Consultant', usernames: ['amy']},
      {name: 'Software engineer', usernames: ['ming']},
      {name: '業務', usernames: ['leo', 'vivian']},
    ]);
  });

  it('改了名字照樣照角色表的順序;舊後端沒給 role_id 就沒有角色群組', () => {
    expect(mentionRoles([{username: 'amy', role: '顧問', role_id: 'Consultant', role_rank: 0}])).toEqual([
      {name: '顧問', usernames: ['amy']},
    ]);
    expect(mentionRoles([{username: 'amy', role: 'Consultant'}])).toEqual([]);
  });
});
