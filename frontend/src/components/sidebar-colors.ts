/**
 * 側邊欄的顏色標記(資料夾、Personal / Shared、對話列共用同一組色盤)。
 *
 * ⚠️ 後端沒有顏色欄位 —— 資料夾只有 id / name / parent_id,對話只有標題那幾個,
 * 所以選了什麼色存在本機(見 folder-icons.ts 的同一段說明)。
 *
 * 基礎色一律走設計系統的 token(`--color-icon-*` 深、`--color-border-*` 淺),
 * 不是自己配的:那兩組本來就是為了「彼此分得開但同一個調性」調的,
 * 而且深色模式會自己跟著換。存的是 key 不是色碼,所以佈景換了選擇也不會失效。
 *
 * 例外是**自訂色**:使用者從調色盤挑的顏色只能存色碼(`#rrggbb`)。
 * 那是使用者的資料不是設計決策 —— 但它不會跟著佈景走,深色模式下可能會太暗或太亮,
 * 這是選它的人自己的選擇。
 *
 * 兩張表分開存:資料夾的 key 是 folder id(以及 `personal` / `shared` 這兩個
 * 不是資料夾的節點),對話的 key 是 conversation_id。混在一張表裡的話,
 * 哪天 id 撞號就會互相蓋掉。
 */
import {readJson, writeJson} from '../lib/safeStorage';

export type SidebarColor = {
  key: string;
  /** 給 aria-label 用 */
  label: string;
  /** CSS 顏色值(token 或色碼) */
  value: string;
};

/**
 * 九個色相,各有深淺兩階 —— 加上「不指定」正好 19 格。
 *
 * ⚠️ 順序不是隨便排的:**前四個要是紅 / 藍 / 黃 / 綠**。
 * 收合時只露出 `QUICK_COLOR_COUNT` 個,所以那一排會是
 * 無色 → 紅 → 藍 → 黃 → 綠。改順序等於改那一排。
 */
const HUES = [
  ['red', 'Red'],
  ['blue', 'Blue'],
  ['yellow', 'Yellow'],
  ['green', 'Green'],
  ['orange', 'Orange'],
  ['cyan', 'Cyan'],
  ['teal', 'Teal'],
  ['pink', 'Pink'],
  ['purple', 'Purple'],
] as const;

/**
 * 主要那一組是**中間調**,不是佈景現成的任何一組。
 *
 * 佈景現成的兩組都不合用:
 *   - `--color-icon-*` 太深(淺色佈景下紅是 #89001a、藍是 #00458c,近乎黑)
 *     —— 一排深色看起來像在挑「強調色」,不像在做記號。
 *   - `--color-border-*` 太淺(#e6bab8 / #b1c9e7)—— 一排粉彩看起來太童趣、不專業。
 *
 * 佈景沒有中間那一階,所以**用兩個 token 調出來**(`color-mix`)——
 * 不是自己挑一組色碼:調出來的值在深色佈景會跟著兩端一起翻面,
 * 寫死色碼就只有淺色模式是對的。60% 深的比例
 * 出來大概是 #4e79b1(藍)/ #b25857(紅)/ #53864b(綠)這種商務圖表的調子。
 *
 * ⚠️ **key 不能換**(中間調仍然是 `red-soft`、深的仍然是 `red`)。
 * 已經挑過顏色的人存的是 key —— 換掉的話查不到,會直接掉回「不指定」,
 * 等於把他的選擇清掉。變的只有那個 key 對到的顏色值。
 */
const MID_DEPTH = '60%';

export const SIDEBAR_COLORS: SidebarColor[] = [
  // 預設**不畫**那條線:顏色是使用者自己想加的記號,不是每個資料夾都要有
  {key: 'neutral', label: 'No colour', value: 'transparent'},
  ...HUES.map(([key, label]) => ({
    key: `${key}-soft`,
    label,
    value: `color-mix(in oklab, var(--color-icon-${key}) ${MID_DEPTH}, var(--color-border-${key}))`,
  })),
  ...HUES.map(([key, label]) => ({
    key,
    label: `${label} (deep)`,
    value: `var(--color-icon-${key})`,
  })),
];

/** 「No colour」那一格的 key(= 沒選);筆記那邊要用它分辨 */
export const NO_COLOR_KEY = SIDEBAR_COLORS[0].key;

/** 收合時先顯示幾個 */
export const QUICK_COLOR_COUNT = 5;

/** 自訂色的 key 長這樣:`#rrggbb`。跟 token 的 key 一眼分得出來。 */
export function isCustomColor(key: string | undefined): key is string {
  return key !== undefined && key.startsWith('#');
}

const FOLDER_KEY = 't100_folder_colors';
const CONVERSATION_KEY = 't100_conversation_colors';

function readMap(key: string): Record<string, string> {
  return (
    readJson(key, (value) =>
      value && typeof value === 'object' ? (value as Record<string, string>) : null,
    ) ?? {}
  );
}

/** 資料夾(以及 `personal` / `shared`)的顏色 */
export function readFolderColors(): Record<string, string> {
  return readMap(FOLDER_KEY);
}

export function writeFolderColors(map: Record<string, string>) {
  writeJson(FOLDER_KEY, map);
}

/** 對話列的顏色標記 */
export function readConversationColors(): Record<string, string> {
  return readMap(CONVERSATION_KEY);
}

export function writeConversationColors(map: Record<string, string>) {
  writeJson(CONVERSATION_KEY, map);
}

/** 沒選過、或選了一個已經不存在的 key,一律退回第一個(= 不畫,transparent)。 */
export function colorValue(key: string | undefined): string {
  if (isCustomColor(key)) return key;
  return (SIDEBAR_COLORS.find((c) => c.key === key) ?? SIDEBAR_COLORS[0]).value;
}

/** 有沒有真的挑過一個看得見的顏色(挑「No colour」不算)。 */
export function hasColor(key: string | undefined): boolean {
  return key !== undefined && colorValue(key) !== 'transparent';
}
