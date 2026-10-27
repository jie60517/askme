/**
 * 檔案欄的選取規則:點一下、Ctrl / ⌘ 加減一個、Shift 選一段、方向鍵上下。
 *
 * 抽出來是因為它是**純的**:一組檔名 + 現在的狀態 + 這一次的操作 → 新的狀態;
 * 滑鼠與空白鍵共用同一份規則。
 *
 * `anchor` 是「上一次點的那一列」,Shift 選一段與方向鍵都從它算起 —— 跟檔案總管一樣。
 */
export type Selection = {
  /** 選到的檔名。順序不重要;畫面上以清單本身的順序為準。 */
  selected: string[];
  /** Shift 選一段、方向鍵移動的起點;沒有選過就是 null。 */
  anchor: string | null;
};

export const EMPTY_SELECTION: Selection = {selected: [], anchor: null};

/** 滑鼠按了哪一種鍵。`toggle` = Ctrl / ⌘(Mac 上是 ⌘),`extend` = Shift。 */
export type ClickModifiers = {toggle?: boolean; extend?: boolean};

/** 點一列(或空白鍵)之後的新狀態。`names` 是**目前畫面上的順序**。 */
export function selectRow(
  names: readonly string[],
  current: Selection,
  name: string,
  modifiers: ClickModifiers = {},
): Selection {
  if (modifiers.extend && current.anchor) {
    const from = names.indexOf(current.anchor);
    const to = names.indexOf(name);
    if (from >= 0 && to >= 0) {
      const [a, b] = from < to ? [from, to] : [to, from];
      // 選一段不動 anchor:同一個起點可以一直往外拉,跟檔案總管一樣
      return {selected: names.slice(a, b + 1), anchor: current.anchor};
    }
  }
  if (modifiers.toggle) {
    const selected = current.selected.includes(name)
      ? current.selected.filter((n) => n !== name)
      : [...current.selected, name];
    return {selected, anchor: name};
  }
  return {selected: [name], anchor: name};
}

/**
 * 方向鍵上下:從 anchor 往前 / 往後一列,選那一列(不加選)。
 * 還沒選過就從頭 / 從尾開始;到頭到尾就停著不動。回傳新狀態與**要把焦點移到哪一列**。
 */
export function moveSelection(
  names: readonly string[],
  current: Selection,
  delta: 1 | -1,
): {selection: Selection; focus: string} | null {
  if (!names.length) return null;
  const at = current.anchor ? names.indexOf(current.anchor) : -1;
  const next = at < 0 ? (delta === 1 ? 0 : names.length - 1) : Math.min(names.length - 1, Math.max(0, at + delta));
  const name = names[next];
  if (at >= 0 && next === at) return null; // 已經在頭 / 尾了,什麼都不做
  return {selection: {selected: [name], anchor: name}, focus: name};
}

/**
 * 清單重列之後(例如終端機裡 rm 掉了幾個):拿掉已經不在的名字,起點不在了就清掉。
 * 都還在就回**同一個物件** —— 每秒都可能重列一次,不該每次都讓整欄重畫。
 */
export function pruneSelection(current: Selection, present: ReadonlySet<string>): Selection {
  const anchor = current.anchor !== null && present.has(current.anchor) ? current.anchor : null;
  if (anchor === current.anchor && current.selected.every((n) => present.has(n))) return current;
  return {selected: current.selected.filter((n) => present.has(n)), anchor};
}
