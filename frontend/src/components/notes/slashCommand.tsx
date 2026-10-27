/**
 * 「/」選單:跟 Notion 一樣**行首或空白後**打「/」就跳(`@tiptap/suggestion`),
 * 繼續打字篩選(中文名稱、英文關鍵字都行),對不到就自己收起;方向鍵 + Enter 選、Esc 收起(「/」留著)。
 *
 * 選單本身畫在 React(`SuggestionMenu`),擴充與畫面之間用一個小的外部 store 傳狀態 —— suggestion 的 render 回呼
 * 是在 React 外面被叫的。
 *
 * 這一支是三個選單共用的**引擎與畫面**(「/」「@」「[[」,`menuSuggestion`);「/」的項目在這裡,
 * 「@」「[[」的項目在 mentionMenu.ts。
 */
import {useEffect, useLayoutEffect, useState, useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import * as stylex from '@stylexjs/stylex';

import {Card} from '@astryxdesign/core/Card';
import {Icon} from '@astryxdesign/core/Icon';
import {Stack} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {Extension, type Editor, type Range} from '@tiptap/core';
import {PluginKey, type EditorState} from '@tiptap/pm/state';
import Suggestion, {exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps} from '@tiptap/suggestion';
import {
  ChevronRight,
  Code2,
  Database as DatabaseIcon,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List as ListIcon,
  ListChecks,
  ListOrdered,
  MessageSquareWarning,
  Minus,
  Pilcrow,
  Quote,
  Table as TableIcon,
  type LucideIcon,
} from 'lucide-react';

import {mentionItems, pageLinkItems} from './mentionMenu';
import {hostOf} from './noteHost';
import {turnInto, type BlockKind} from './noteExtensions';
import {emptyDatabase} from './databaseModel';
import {portalHost} from '../../lib/portalHost';

/** 「轉換成」那一份清單(區塊選單、選字工具列共用;圖示跟「/」選單同一個) */
export const TURN_INTO: {label: string; kind: BlockKind; icon: LucideIcon}[] = [
  {label: '文字', kind: 'paragraph', icon: Pilcrow},
  {label: '標題 1', kind: 'h1', icon: Heading1},
  {label: '標題 2', kind: 'h2', icon: Heading2},
  {label: '標題 3', kind: 'h3', icon: Heading3},
  {label: '待辦清單', kind: 'todo', icon: ListChecks},
  {label: '項目清單', kind: 'bullet', icon: ListIcon},
  {label: '編號清單', kind: 'ordered', icon: ListOrdered},
  {label: '可收合清單', kind: 'toggle', icon: ChevronRight},
  {label: '引用', kind: 'quote', icon: Quote},
  {label: '提示框', kind: 'callout', icon: MessageSquareWarning},
  {label: '程式碼', kind: 'code', icon: Code2},
];

/** 選單的一項(「/」「@」「[[」三個選單共用:名字、圖示、英文關鍵字、選了做什麼) */
export type MenuItem = {label: string; icon: LucideIcon; keys: string; run: (editor: Editor) => void | Promise<void>};

/** 「/」選單的項目 */
export const SLASH_ITEMS: MenuItem[] = [
  {label: '文字', icon: Pilcrow, keys: 'text paragraph plain', run: (e) => void turnInto(e, 'paragraph')},
  {label: '標題 1', icon: Heading1, keys: 'h1 heading title', run: (e) => void turnInto(e, 'h1')},
  {label: '標題 2', icon: Heading2, keys: 'h2 heading', run: (e) => void turnInto(e, 'h2')},
  {label: '標題 3', icon: Heading3, keys: 'h3 heading', run: (e) => void turnInto(e, 'h3')},
  {label: '頁面', icon: FileText, keys: 'page subpage', run: insertSubpage},
  {label: '待辦清單', icon: ListChecks, keys: 'todo task check', run: (e) => void turnInto(e, 'todo')},
  {label: '項目清單', icon: ListIcon, keys: 'bullet list ul', run: (e) => void turnInto(e, 'bullet')},
  {label: '編號清單', icon: ListOrdered, keys: 'number ordered ol', run: (e) => void turnInto(e, 'ordered')},
  {label: '可收合清單', icon: ChevronRight, keys: 'toggle details collapse', run: (e) => void turnInto(e, 'toggle')},
  {label: '引用', icon: Quote, keys: 'quote', run: (e) => void turnInto(e, 'quote')},
  {label: '提示框', icon: MessageSquareWarning, keys: 'callout note tip', run: (e) => void turnInto(e, 'callout')},
  {label: '分隔線', icon: Minus, keys: 'divider hr line', run: (e) => void e.chain().focus().setHorizontalRule().run()},
  {label: '程式碼', icon: Code2, keys: 'code', run: (e) => void turnInto(e, 'code')},
  {label: '表格', icon: TableIcon, keys: 'table', run: (e) => void e.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()},
  {label: '資料庫', icon: DatabaseIcon, keys: 'database db board kanban', run: (e) => void e.chain().focus().insertContent({type: 'database', attrs: {data: JSON.stringify(emptyDatabase())}}).run()},
  {label: '圖片', icon: ImageIcon, keys: 'image picture photo', run: (e) => hostOf(e).pickImage()},
];

async function insertSubpage(editor: Editor) {
  const page = await hostOf(editor).newSubpage();
  if (!page || editor.isDestroyed) return;
  editor.chain().focus().insertContent({type: 'pageLink', attrs: {id: page.id, title: page.title}}).run();
  // 跟 Notion 一樣直接進到新的那一頁(連結已經插好、這一頁換頁時會先存)
  hostOf(editor).openPage(page.id, {edit: true});
}

export function filterSlash(query: string): MenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) => item.label.includes(q) || item.keys.includes(q));
}

// ---------------------------------------------------------------- 擴充 ↔ 畫面
/** key:是哪一個選單(「/」「@」「[[」共用同一個畫面;Esc 要收對的那一個) */
type MenuState = {editor: Editor; items: MenuItem[]; rect: DOMRect | null; range: Range; active: number; key: PluginKey} | null;

let state: MenuState = null;
const listeners = new Set<() => void>();
function set(next: MenuState) {
  state = next;
  listeners.forEach((fn) => fn());
}

function pick(item: MenuItem, editor: Editor, range: Range) {
  editor.chain().focus().deleteRange(range).run();
  void item.run(editor);
}

export const slashKey = new PluginKey('noteSlash');
export const mentionKey = new PluginKey('noteMentionMenu');
export const pageLinkKey = new PluginKey('notePageLinkMenu');

/** 有沒有建議選單開著(「/」「@」「[[」;選整塊的 Esc 要讓它先收選單) */
export function suggestionOpen(state: EditorState): boolean {
  return [slashKey, mentionKey, pageLinkKey].some((k) => !!(k.getState(state) as {active?: boolean} | undefined)?.active);
}

/** 一個建議選單:打 char 跳出來、繼續打字篩選、方向鍵 + Enter 選、Esc 收起(打的字留著) */
function menuSuggestion(
  editor: Editor,
  key: PluginKey,
  char: string,
  items: (query: string, editor: Editor) => MenuItem[],
  allowedPrefixes: string[] | null,
) {
  return Suggestion<MenuItem, MenuItem>({
    editor,
    pluginKey: key,
    char,
    startOfLine: false,
    allowSpaces: false,
    allowedPrefixes,
    items: ({query, editor: ed}) => items(query, ed),
    command: ({editor: ed, range, props}) => pick(props, ed, range),
    render: () => ({
      onStart: (p: SuggestionProps<MenuItem, MenuItem>) =>
        set({editor: p.editor, items: p.items, rect: p.clientRect?.() ?? null, range: p.range, active: 0, key}),
      onUpdate: (p: SuggestionProps<MenuItem, MenuItem>) =>
        set({editor: p.editor, items: p.items, rect: p.clientRect?.() ?? null, range: p.range, active: 0, key}),
      onKeyDown: ({event}: SuggestionKeyDownProps) => {
        if (!state || !state.items.length) return false;
        const n = state.items.length;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          set({...state, active: (state.active + (event.key === 'ArrowDown' ? 1 : -1) + n) % n});
          return true;
        }
        if (event.key === 'Enter') {
          pick(state.items[state.active], state.editor, state.range);
          set(null);
          return true;
        }
        if (event.key === 'Escape') {
          // 照 Notion:收掉之後打的字留著,接著打字不會再跳(只收畫面的話 Suggestion 還開著,下一個字又出來)
          exitSuggestion(state.editor.view, state.key);
          set(null);
          return true;
        }
        return false;
      },
      onExit: () => set(null),
    }),
  });
}

export const SlashCommand = Extension.create({
  name: 'noteSlash',
  addProseMirrorPlugins() {
    return [
      // 「/」:行首或空白後才算(網址裡的「/」不要跳)
      menuSuggestion(this.editor, slashKey, '/', (q) => filterSlash(q), [' ', '　']),
      // 「@」提及人、頁面、日期;行首或空白後才算(email 裡的 @ 不要跳)
      menuSuggestion(this.editor, mentionKey, '@', mentionItems, [' ', '　']),
      // 「[[」連結頁面;哪裡都可以打
      menuSuggestion(this.editor, pageLinkKey, '[[', pageLinkItems, null),
    ];
  },
});

// ---------------------------------------------------------------- 畫面
/** 「/」選單的尺寸(定位在 JS 裡算) */
const MENU_WIDTH = 240;
/**
 * 選單最高多高:一般螢幕「/」16 項、「轉換成」11 項都一次看完;
 * 矮螢幕最多佔視窗高的 MENU_VIEWPORT_SHARE。選字工具列的兩個選單用 MENU_MAX_HEIGHT_CSS;
 * 「轉換成」子選單在 note-editor.css(Astryx 沒開放那一層的高度,見那裡),**改這裡要一起改那裡**。
 */
export const MENU_MAX_HEIGHT = 520;
const MENU_VIEWPORT_SHARE = 0.6;
export const MENU_MAX_HEIGHT_CSS = `min(${MENU_MAX_HEIGHT}px, ${MENU_VIEWPORT_SHARE * 100}vh)`;
/** 一項多高、上下內距(只用來判斷往上還是往下開) */
const MENU_ROW = 30;
const MENU_PAD = 8;
const GAP = 6;
const EDGE = 8;

const styles = stylex.create({
  // 數字見 global.css 的層級表(42:跟著游標走的那幾個浮層)
  // 字體與字色自己帶:平常掛在佈景層裡會繼承到,但 portalHost 找不到佈景層時退回 body,
  // 那裡沒有(會是 Times New Roman)
  floating: {position: 'fixed', zIndex: 42, fontFamily: 'var(--font-family-body)', color: 'var(--color-text-primary)'},
  scroll: {overflowY: 'auto'},
});

export function SuggestionMenu() {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => state,
  );
  // 捲動時跟著游標走
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!s) return;
    const update = () => rerender((n) => n + 1);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [s]);
  // 選中的那一項捲進看得到的地方
  useLayoutEffect(() => {
    document.querySelector('[data-slash-active="true"]')?.scrollIntoView({block: 'nearest'});
  }, [s?.active]);

  if (!s || !s.items.length || !s.rect) return null;
  const caret = s.rect;
  const maxHeight = Math.min(MENU_MAX_HEIGHT, Math.round(window.innerHeight * MENU_VIEWPORT_SHARE));
  const needed = Math.min(maxHeight, s.items.length * MENU_ROW + MENU_PAD);
  const spaceBelow = window.innerHeight - caret.bottom - GAP - EDGE;
  const below = spaceBelow >= needed || spaceBelow >= caret.top - GAP - EDGE;
  const left = Math.max(EDGE, Math.min(caret.left, window.innerWidth - MENU_WIDTH - EDGE));
  const place = below ? {top: caret.bottom + GAP, left} : {bottom: window.innerHeight - caret.top + GAP, left};
  return createPortal(
    // 按在選單上不要讓編輯器失焦(失焦選單就收起來了,點擊來不及到)
    <Stack xstyle={styles.floating} style={place} onMouseDown={(e: React.MouseEvent) => e.preventDefault()}>
      <Card elevation="med" padding={1} width={MENU_WIDTH}>
        <Stack xstyle={styles.scroll} style={{maxHeight}}>
          <List density="compact">
            {s.items.map((item, i) => (
              <Stack key={`${i}:${item.label}`} data-slash-active={i === s.active ? 'true' : undefined}>
                <ListItem
                  label={item.label}
                  startContent={<Icon icon={item.icon} size="sm" color="secondary" />}
                  isSelected={i === s.active}
                  onClick={() => {
                    pick(item, s.editor, s.range);
                    set(null);
                  }}
                />
              </Stack>
            ))}
          </List>
        </Stack>
      </Card>
    </Stack>,
    // 掛在佈景那一層,不是 body(body 讀不到佈景的 token,見 lib/portalHost.ts)
    portalHost(),
  );
}
