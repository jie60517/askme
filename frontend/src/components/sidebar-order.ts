/**
 * 側邊欄的自訂順序。
 *
 * 右鍵選單最上面一顆 `^`、最下面一顆 `v`,把那一列在**同一層的兄弟之間**
 * 往上/往下移一格。跨層不做:那已經是「搬家」,而搬家有拖曳與
 * 「Move out of folder」兩條路了。
 *
 * **只存本機**(`t100_sidebar_order`)—— 後端的資料夾只有 id / name / parent_id,
 * 對話是照 `updated_at` 排的,兩邊都沒有順序欄位。跟 `t100_folder_icons` /
 * `t100_folder_colors` 同一類:「我看側邊欄的方式」留在這台機器上。
 *
 * 一張表存所有的清單:key 是那一層的名字(見 `Sidebar` 的 `listKey`),
 * value 是那一層由上到下的成員。存**整份順序**而不是「誰被移到第幾格」——
 * 稀疏的偏移量在有東西被刪掉之後就對不回來了。
 */
import {readJson, writeJson} from '../lib/safeStorage';

export const ORDER_KEY = 't100_sidebar_order';

/** 清單名稱 → 那一層由上到下的成員 key */
export type OrderMap = Record<string, string[]>;

export function readSidebarOrder(): OrderMap {
  return (
    readJson<OrderMap>(ORDER_KEY, (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const out: OrderMap = {};
      for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
        // 一筆壞掉不要丟掉整張表 —— 其餘的順序還是使用者排過的
        if (Array.isArray(list) && list.every((x) => typeof x === 'string')) {
          out[key] = list as string[];
        }
      }
      return out;
    }) ?? {}
  );
}

export function writeSidebarOrder(next: OrderMap) {
  writeJson(ORDER_KEY, next);
}

/**
 * 把一層的成員照存下來的順序重排。沒排過就原樣回傳。
 *
 * ⚠️ **沒在名單裡的排最前面**(而且彼此維持原本的順序)。
 * 那些是排過之後才出現的東西 —— 新對話、剛建的資料夾。
 * 排最後的話,一份排過順序的長清單裡,新開的對話會直接掉到看不見的地方,
 * 使用者會以為它沒建起來。自然順序本來就是「新的在上面」。
 */
export function applyOrder<T>(
  order: OrderMap,
  listKey: string,
  items: T[],
  keyOf: (item: T) => string,
): T[] {
  const saved = order[listKey];
  if (!saved?.length) return items;
  const rank = new Map(saved.map((key, i) => [key, i]));
  return items
    .map((item, index) => ({item, index, rank: rank.get(keyOf(item))}))
    .sort((a, b) => {
      if (a.rank === undefined && b.rank === undefined) return a.index - b.index;
      if (a.rank === undefined) return -1;
      if (b.rank === undefined) return 1;
      return a.rank - b.rank;
    })
    .map((entry) => entry.item);
}

/**
 * 把 `key` 在 `keys`(**畫面上現在的順序**)裡往上/往下移一格,回傳新的表。
 *
 * 移不動就回傳**原本那個物件**(參照相同)—— 呼叫端靠這個判斷「什麼都沒發生」,
 * 不必再寫一次邊界條件。
 *
 * 存的是整份 `keys`(換過位置的版本):第一次移動就把這一層的順序固定下來,
 * 之後每一次都是在完整的名單上換位置。
 */
export function moveWithin(
  order: OrderMap,
  listKey: string,
  keys: string[],
  key: string,
  delta: number,
): OrderMap {
  const from = keys.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= keys.length) return order;
  const next = [...keys];
  next[from] = keys[to];
  next[to] = key;
  return {...order, [listKey]: next};
}

/**
 * 把 `a` 跟 `b` **對調**,回傳新的表(長按拖曳時,跟同一個資料夾裡的對話換位置)。
 *
 * ⚠️ 是**對調**不是「插到那一格」——跟右鍵那兩顆 `^` / `v` 同一個語意
 *(`moveWithin` 也是對調相鄰的兩個)。兩個入口做同一件事,使用者才不會
 * 因為換了操作方式就得重新學一次結果會怎樣。
 *
 * 任何一邊不在 `keys` 裡、或兩個是同一個 → 回**原本那個物件**(參照相同),
 * 呼叫端靠這個判斷「什麼都沒發生」。
 */
export function swapWithin(
  order: OrderMap,
  listKey: string,
  keys: string[],
  a: string,
  b: string,
): OrderMap {
  const i = keys.indexOf(a);
  const j = keys.indexOf(b);
  if (i < 0 || j < 0 || i === j) return order;
  const next = [...keys];
  next[i] = b;
  next[j] = a;
  return {...order, [listKey]: next};
}

/** 一列能不能往上/往下,以及怎麼移。`undefined` = 這一列不給排序。 */
export type Reorder = {
  canUp: boolean;
  canDown: boolean;
  move: (delta: number) => void;
};
