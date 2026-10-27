/**
 * 檔案欄的排序。純函式,所以有測試。
 *
 * 規則只有兩條:
 *   1. **資料夾永遠在檔案前面** —— 不管照哪一欄排、升冪還是降冪。跟每一個檔案總管一樣;
 *      混在一起的話「上一層那幾個資料夾」會散在清單中間,反而難找。
 *   2. 同一組(都是資料夾 / 都是檔案)之內才照選到的那一欄比。名字一律不分大小寫,
 *      而且最後拿名字當**決勝局** —— 不然大小相同的兩個檔案每次重新整理順序都不一樣。
 */
import type {FileEntry} from '../../lib/terminalApi';

export type SortKey = 'name' | 'size' | 'mtime' | 'owner' | 'group' | 'access';
export type SortDir = 'asc' | 'desc';
export type Sort = {key: SortKey; dir: SortDir};

/** 一進來的樣子:名字升冪(後端本來就是這樣排的,畫面不要一載入就跳一下)。 */
export const DEFAULT_SORT: Sort = {key: 'name', dir: 'asc'};

/** 點同一欄就反向,點別欄就換過去、從升冪開始。 */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return {key, dir: 'asc'};
  return {key, dir: current.dir === 'asc' ? 'desc' : 'asc'};
}

function compareBy(key: SortKey, a: FileEntry, b: FileEntry): number {
  switch (key) {
    case 'size':
      return a.size - b.size;
    case 'mtime':
      return a.mtime - b.mtime;
    case 'owner':
      return a.owner.localeCompare(b.owner);
    case 'group':
      return a.group.localeCompare(b.group);
    case 'access':
      return a.access.localeCompare(b.access);
    default:
      return 0;
  }
}

/**
 * 名字的比法:不分大小寫、數字照數值(`file2` 在 `file10` 前面)。
 * ⚠️ **只建一顆、重複用**:`localeCompare(b, undefined, {…})` 帶 options 的話,V8 每呼叫一次就建一顆
 * collator —— 2 萬個檔排一次是幾十萬次比較,光這一步就要好幾秒。
 */
const NAME_COLLATOR = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});

/** 回一份**新的**陣列,不動原本那份(它是 `listing.entries`,直接排會動到快取)。 */
export function sortEntries(entries: readonly FileEntry[], sort: Sort): FileEntry[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  const byName = (a: FileEntry, b: FileEntry) => NAME_COLLATOR.compare(a.name, b.name);
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    const primary = sort.key === 'name' ? byName(a, b) : compareBy(sort.key, a, b);
    // 主要欄位相同就照名字排(升冪),排序才穩定
    return primary !== 0 ? primary * factor : byName(a, b);
  });
}
