/**
 * 全站快捷鍵(Settings → Keyboard shortcuts)。
 *
 * 長相照官網 Astryx 0.7.8 `settings-dialog` 範本的 Keyboard shortcuts(
 * 點按鍵改成別的鍵、每個有開關可停用、改過的旁邊有還原)。清單只有三個:
 * Ctrl+K、New chat 與收合側邊欄。
 *
 * - **加一個快捷鍵只改兩處**:這裡的 `SHORTCUTS`(id、名稱、圖示、預設鍵)與後端白名單 `users.SHORTCUT_IDS`
 *   (`backend/tests/test_shortcut_prefs.py` 會讀這個檔對)。再到按下去的那個主人那裡掛 `useShortcut`。
 * - 只存**改過的**(`ShortcutOverrides`):`false` = 停用,`Chord` = 改成這組。沒改過的照 `SHORTCUTS` 的預設。
 * - 跟帳號走:localStorage 讓這台電腦一打開就是對的,伺服器那份 `/api/me` 回來時採用一次
 *  (同 `companionPref.ts` 的分工)。
 * - 按下去由各自的主人接(`useShortcut`):搜尋在 `CommandPalette`、New chat 在 `App`、收合在 `Sidebar`。
 */
import {useSyncExternalStore} from 'react';

import {useHotkeys} from '@astryxdesign/core/hooks';
import {PanelLeft, Search, SquarePen, type LucideIcon} from 'lucide-react';

import {readJson, writeJson} from './safeStorage';

/** 一組按鍵。`mod` = Mac 上的 ⌘、其他平台的 Ctrl(Astryx 的 `Kbd` / `useHotkeys` 自己判斷) */
export type Chord = {mod: boolean; shift: boolean; alt: boolean; key: string};

export const SHORTCUTS = [
  {id: 'search', label: 'Search chats', icon: Search, binding: {mod: true, shift: false, alt: false, key: 'k'}},
  {id: 'new_chat', label: 'New chat', icon: SquarePen, binding: {mod: true, shift: true, alt: false, key: 'o'}},
  {id: 'sidebar', label: 'Toggle sidebar', icon: PanelLeft, binding: {mod: true, shift: true, alt: false, key: 's'}},
] as const satisfies readonly {id: string; label: string; icon: LucideIcon; binding: Chord}[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

export type ShortcutOverrides = Partial<Record<ShortcutId, Chord | false>>;

/** 後端 `users._MAX_KEY_CHARS` */
const MAX_KEY_CHARS = 16;
/** 後端用 `str.isprintable()` 擋;這裡擋控制字元,兩邊收的一樣 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 這個快捷鍵出廠的那一組 */
export function defaultChord(id: ShortcutId): Chord {
  return SHORTCUTS.find((s) => s.id === id)!.binding;
}

/**
 * 是不是 Apple 平台 —— 照抄 Astryx 內部的 `isApplePlatform`(`@astryxdesign/core/src/utils/isApplePlatform.ts`,
 * 它刻意不匯出)。`Kbd` 畫鍵帽、`useHotkeys` 認 `mod` 都用那一支,報讀念的字要跟它們同一個判斷,
 * 不然 iPad 之類 `navigator.platform` 跟 client hints 講不一樣的機器,畫的是 ⌘、念的是 Ctrl。
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = 'userAgentData' in navigator ? (navigator as {userAgentData?: {platform?: unknown}}).userAgentData : null;
  const named = typeof uaData?.platform === 'string' ? uaData.platform.trim() : '';
  if (named !== '' && named.toLowerCase() !== 'unknown') return /mac/i.test(named);
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
}

/**
 * `KeyboardEvent.key` 裡 `Kbd` / `useHotkeys` 不認得原名的那幾個(範本的 KBD_KEY_NAMES):
 * 方向鍵兩邊都用短名,`+` 是它們拆字的符號,一定要寫成 plus。
 */
const KEY_NAMES: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  '+': 'plus',
  ' ': 'space',
};

/** `Kbd` 的 keys 與 `useHotkeys` 的 keys 是同一種字串:`mod+shift+o` */
export function chordKeys(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('mod');
  if (chord.shift) parts.push('shift');
  if (chord.alt) parts.push('alt');
  const key = chord.key.toLowerCase();
  parts.push(KEY_NAMES[key] ?? key);
  return parts.join('+');
}

/** 報讀用的字(按鈕上畫的是鍵帽):「Ctrl + Shift + O」 */
export function chordLabel(chord: Chord, isApple: boolean): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(isApple ? 'Command' : 'Ctrl');
  if (chord.shift) parts.push('Shift');
  if (chord.alt) parts.push(isApple ? 'Option' : 'Alt');
  parts.push(chord.key === ' ' ? 'Space' : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join(' + ');
}

export type Recorded = {kind: 'chord'; chord: Chord} | {kind: 'wait'} | {kind: 'needs-modifier'} | {kind: 'cancel'} | {kind: 'leave'};

/**
 * 錄鍵框收到一個按鍵之後怎麼辦。
 * - 只按修飾鍵:還不算,等它修飾的那個鍵(`wait`)。
 * - Esc:取消(`cancel`)。沒帶修飾鍵的 Tab:讓焦點照常離開(`leave`,錄鍵框失焦就取消)——
 *   吞掉的話鍵盤使用者被困在錄鍵框裡。
 * - **一定要帶 Ctrl / ⌘ 或 Alt**(`needs-modifier`):不帶的話 Enter、Space、方向鍵、字母都收得進去,
 *   收了之後全站 preventDefault 掉,按鈕按不下、捲不動。Shift 不算:Shift + 字母就是打大寫。
 * - 字母一律存小寫 —— Shift 按著時 `event.key` 是大寫,比對又不分大小寫,統一才好比。
 */
export function recordKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): Recorded {
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'Dead', 'Process', 'Unidentified'].includes(e.key)) return {kind: 'wait'};
  const mod = e.metaKey || e.ctrlKey;
  if (!mod && !e.altKey) {
    if (e.key === 'Escape') return {kind: 'cancel'};
    if (e.key === 'Tab') return {kind: 'leave'};
    return {kind: 'needs-modifier'};
  }
  return {kind: 'chord', chord: {mod, shift: e.shiftKey, alt: e.altKey, key: e.key.length === 1 ? e.key.toLowerCase() : e.key}};
}

export function sameChord(a: Chord, b: Chord): boolean {
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key.toLowerCase() === b.key.toLowerCase();
}

/**
 * 兩組會不會被同一下按鍵觸發 —— **照 `useHotkeys` 的比法**:Ctrl / ⌘ / Alt 要一模一樣,
 * Shift 只在寫了的時候才檢查(沒寫 Shift 的 `mod+o`,按 Ctrl+Shift+O 也會觸發)。
 * 所以只要修飾鍵(Shift 以外)與鍵相同就算撞,Shift 不管。用 `sameChord` 判斷撞鍵會漏掉這種。
 */
export function chordsCollide(a: Chord, b: Chord): boolean {
  return a.mod === b.mod && a.alt === b.alt && a.key.toLowerCase() === b.key.toLowerCase();
}

/** 這個快捷鍵現在是哪一組;`false` = 停用 */
export function resolveShortcut(overrides: ShortcutOverrides, id: ShortcutId): Chord | false {
  const o = overrides[id];
  if (o === false) return false;
  return o ?? defaultChord(id);
}

/** 把 `id` 設成 `chord` 的話會跟哪一個(還開著的)撞;沒有就 undefined */
export function collisionWith(overrides: ShortcutOverrides, id: ShortcutId, chord: Chord): ShortcutId | undefined {
  return SHORTCUTS.find((s) => {
    if (s.id === id) return false;
    const other = resolveShortcut(overrides, s.id);
    return other !== false && chordsCollide(other, chord);
  })?.id;
}

/**
 * 從 localStorage / 伺服器讀進來的:只留認得的 id、形狀對的值(同後端 `users.clean_shortcuts`)。
 * 跟預設一模一樣的改動丟掉 —— 不然「改過」的還原鈕會在預設值旁邊出現。
 */
export function cleanOverrides(raw: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const {id} of SHORTCUTS) {
    if (!(id in src)) continue;
    const value = src[id];
    if (value === false) {
      out[id] = false;
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (typeof v.key !== 'string' || !v.key || v.key.length > MAX_KEY_CHARS || CONTROL_CHARS.test(v.key)) continue;
    const chord: Chord = {mod: v.mod === true, shift: v.shift === true, alt: v.alt === true, key: v.key};
    // 沒帶 Ctrl / ⌘ / Alt 的不收(理由見 `recordKey`;後端同一條)
    if (!chord.mod && !chord.alt) continue;
    if (sameChord(chord, defaultChord(id))) continue;
    out[id] = chord;
  }
  return out;
}

// ── 存放(本機先套、伺服器之後追上) ─────────────────────────────────────

const STORAGE_KEY = 't100_shortcuts';
let current: ShortcutOverrides = readJson(STORAGE_KEY, (v) => cleanOverrides(v)) ?? {};
const listeners = new Set<() => void>();

/**
 * 換成這一份(先清洗)。使用者在 Settings 裡改的、`/api/me` 回來時伺服器那份,都走這一支 ——
 * 只套本機,送伺服器是 Settings 那邊的事(`saveShortcuts`)。伺服器回 null = 全部照預設。
 */
export function setShortcutOverrides(next: unknown): void {
  current = cleanOverrides(next);
  writeJson(STORAGE_KEY, current);
  for (const l of listeners) l();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * 掛一個快捷鍵。停用了就不聽;改過鍵就聽新的那組(`useHotkeys` 每次 render 讀最新的設定,不必重掛)。
 * 能設的組合一定帶 Ctrl / ⌘ 或 Alt(`recordKey`),所以在輸入框裡也聽 ——
 * Ctrl+K 原本就是這樣:常常打到一半才想起要找舊對話。
 */
export function useShortcut(id: ShortcutId, onPress: (e: KeyboardEvent) => void, opts: {isDisabled?: boolean} = {}): void {
  const chord = resolveShortcut(useShortcutOverrides(), id);
  useHotkeys([
    {
      keys: chord ? chordKeys(chord) : '',
      onPress,
      allowInInputs: true,
      isDisabled: chord === false || opts.isDisabled,
    },
  ]);
}
