/**
 * @ 選單「All <角色>」群組要列哪幾個角色、什麼順序(角色可以自訂)。
 *
 * 分組與順序都照後端給的:`role_id`(管理員是空字串 —— 他不是角色,不進任何角色群組)、
 * `role_rank`(角色表的順序,跟 Work Flow 通知名單、角色分頁同一個)。前端不寫死任何角色名。
 * 只有掛著人的角色才會出現 —— 群組是拿來一次標記一群人的,空的群組點了什麼都不會發生。
 * 抽成自己的模組是因為 `pages/Chat.tsx` 在 jsdom 裡連 import 都會逾時(見 .claude/CLAUDE.md),測不到。
 */
export type MentionRole = {name: string; usernames: string[]};

export function mentionRoles(
  people: ReadonlyArray<{username: string; role?: string | null; role_id?: string; role_rank?: number}>,
): MentionRole[] {
  const byId = new Map<string, {name: string; rank: number; usernames: string[]}>();
  for (const p of people) {
    const id = p.role_id ?? '';
    if (!id) continue;
    const group = byId.get(id) ?? {name: (p.role ?? '').trim() || id, rank: p.role_rank ?? Infinity, usernames: []};
    group.usernames.push(p.username);
    byId.set(id, group);
  }
  return [...byId.values()]
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'zh-Hant'))
    .map(({name, usernames}) => ({name, usernames}));
}
