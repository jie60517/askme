/**
 * 個人筆記編輯器(Tiptap)用的擴充清單。
 *
 * 內文的正本是編輯器格式(doc,Tiptap JSON):文字顏色、底線、可收合清單、提示框、圖片寬度、子頁連結、留言標記
 * 都只存得進 JSON。Markdown 仍然每次一起寫一份(`@tiptap/markdown`)給搜尋與清單摘要 —— 那一份可以有損。
 * 還沒有 doc 的舊筆記照舊從 Markdown 讀(打開不改寫、`canEditVisually` 只管它們)。
 *
 * 抽成自己的檔案:編輯器元件(`NoteEditor.tsx`)跟轉換測試要用同一份清單 —— 測試不畫 React 的節點外觀,
 * 只看內容進出,所以外觀(圖表、圖片、提示框、子頁連結、資料庫)用參數接進來。
 */
import {
  Extension,
  InputRule,
  Mark,
  Node,
  mergeAttributes,
  wrappingInputRule,
  type Editor,
  type Extensions,
  type NodeViewRenderer,
} from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import CodeBlock from '@tiptap/extension-code-block';
import {Details, DetailsContent, DetailsSummary} from '@tiptap/extension-details';
import Image from '@tiptap/extension-image';
import {TaskItem, TaskList} from '@tiptap/extension-list';
import {TableKit} from '@tiptap/extension-table';
import {BackgroundColor, Color, TextStyle} from '@tiptap/extension-text-style';
import {Placeholder} from '@tiptap/extensions';
import {Markdown} from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

import {Plugin, PluginKey, TextSelection, type Transaction} from '@tiptap/pm/state';
import {Decoration, DecorationSet} from '@tiptap/pm/view';

import {noteImageSrc, UNTITLED} from '../../lib/notebookApi';
import {cellText, type CellValue, type Column, type DatabaseData} from './databaseModel';

type Views = {
  /** 圖片的外觀(看大圖、拉寬度、置中、說明文字) */
  image?: NodeViewRenderer;
  /** 程式碼區塊的外觀(語言、複製) */
  codeBlock?: NodeViewRenderer;
  /** 提示框的外觀(點圖示換) */
  callout?: NodeViewRenderer;
  /** 子頁連結的外觀(標題跟著那一頁走) */
  pageLink?: NodeViewRenderer;
  /** 資料庫的外觀 */
  database?: NodeViewRenderer;
  /** 提及(人、頁面、日期)的外觀 */
  mention?: NodeViewRenderer;
};

/** 空行提示字(只在空白筆記第一行與游標所在的空行) */
export const PLACEHOLDER_EMPTY_NOTE = '輸入內容,或按「/」插入標題、清單、圖片';
export const PLACEHOLDER_LINE = '按「/」插入';

/** Notion 的文字顏色 / 底色。值是 Astryx 的色票 token,深色模式跟著換 */
export const TEXT_COLORS: {label: string; value: string | null}[] = [
  {label: '預設', value: null},
  {label: '灰色', value: 'var(--color-text-gray)'},
  {label: '橘色', value: 'var(--color-text-orange)'},
  {label: '黃色', value: 'var(--color-text-yellow)'},
  {label: '綠色', value: 'var(--color-text-green)'},
  {label: '藍色', value: 'var(--color-text-blue)'},
  {label: '紫色', value: 'var(--color-text-purple)'},
  {label: '粉紅', value: 'var(--color-text-pink)'},
  {label: '紅色', value: 'var(--color-text-red)'},
];
export const BACKGROUND_COLORS: {label: string; value: string | null}[] = [
  {label: '預設', value: null},
  {label: '灰色底', value: 'var(--color-background-gray)'},
  {label: '橘色底', value: 'var(--color-background-orange)'},
  {label: '黃色底', value: 'var(--color-background-yellow)'},
  {label: '綠色底', value: 'var(--color-background-green)'},
  {label: '藍色底', value: 'var(--color-background-blue)'},
  {label: '紫色底', value: 'var(--color-background-purple)'},
  {label: '粉紅底', value: 'var(--color-background-pink)'},
  {label: '紅色底', value: 'var(--color-background-red)'},
];

/**
 * 這一則能不能用編輯器改。**只管還沒有 doc 的舊筆記**:編輯器讀 Markdown 再寫回去會改壞內容的寫法,那一則退回原文編輯:
 *   - 手打的 HTML(`<br>` 例外:表格格子裡會原樣留著、段落裡變成換行,內容不變;`<https://…>` 自動連結也不算);
 *   - 註腳 `[^1]`(會被改寫成別的東西);
 *   - 表格格子裡的 `\|`(寫回去少了反斜線,一格裂成兩格);
 *   - 清單裡縮排的程式碼區塊(寫回去程式碼每行多一個空白)。
 * 只會被「整理」、內容不變的(`*` 清單寫成 `-`、表格補空白、`_斜體_` 寫成 `*斜體*`)不算 —— 見轉換測試。
 * 誤判(例如內文寫「a<b 而且 c>d」)只會讓那一則退回原文編輯,不會改壞東西。
 */
export function canEditVisually(md: string): boolean {
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const open = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence === null && open) {
      if (open[1].length > 0) return false;
      fence = open[2];
      continue;
    }
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const text = line.replace(/`[^`]*`/g, '');
    if (/<(?!br\s*\/?>)(?!https?:|mailto:)\/?[a-zA-Z][^>]*>/i.test(text)) return false;
    if (/\[\^[^\]]+\]/.test(text)) return false;
    if (/^\s*\|.*\\\|/.test(text)) return false;
  }
  return true;
}

/** 程式碼區塊:照 Tiptap 原本的讀法,另外把外觀(語言、複製)接上來 */
const NoteCodeBlock = CodeBlock.extend<{view?: NodeViewRenderer}>({
  addOptions() {
    return {...this.parent!(), view: undefined};
  },
  parseMarkdown: (token, helpers) => {
    const raw = token.raw ?? '';
    if (!raw.startsWith('```') && !raw.startsWith('~~~') && token.codeBlockStyle !== 'indented') return [];
    return helpers.createNode('codeBlock', {language: token.lang || null}, token.text ? [helpers.createTextNode(token.text)] : []);
  },
  addNodeView() {
    return this.options.view ?? null;
  },
});

/** 引用:Notion 是 `"`+空白(`>` 讓給可收合清單) */
const NoteBlockquote = Blockquote.extend({
  addInputRules() {
    return [wrappingInputRule({find: /^\s*["“”]\s$/, type: this.type})];
  },
});

/** 可收合清單:`>`+空白 開一個,跟 Notion 一樣。打開 / 收起的狀態存在節點上(persist) */
const NoteDetails = Details.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*>\s$/,
        handler: ({chain, range}) => {
          chain()
            .deleteRange(range)
            .command(({tr}) => textblockToToggle(tr))
            .run();
        },
      }),
    ];
  },
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], '\n\n'),
});
const NoteDetailsSummary = DetailsSummary.extend({
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? []),
});
const NoteDetailsContent = DetailsContent.extend({
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? [], '\n\n'),
});

/** 提示框:左邊一個線條圖示(存圖示名字,見 pageIcons.tsx;不認得的值(例如 emoji)畫預設燈泡)、右邊一般內容 */
const Callout = Node.create<{view?: NodeViewRenderer}>({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addOptions: () => ({view: undefined}),
  addAttributes: () => ({icon: {default: 'Lightbulb'}}),
  parseHTML: () => [{tag: 'div[data-callout]'}],
  renderHTML: ({HTMLAttributes}) => ['div', mergeAttributes(HTMLAttributes, {'data-callout': ''}), 0],
  // Markdown 只給搜尋與摘要:寫成一段引用
  renderMarkdown: (node, h) =>
    `> ${h
      .renderChildren(node.content ?? [], '\n\n')
      .split('\n')
      .join('\n> ')}`,
  addNodeView() {
    return this.options.view ?? null;
  },
});

/** 子頁連結(「/頁面」):一列,標題與圖示跟著那一頁走(節點只存 id;看的時候查清單) */
const PageLink = Node.create<{view?: NodeViewRenderer}>({
  name: 'pageLink',
  group: 'block',
  atom: true,
  selectable: true,
  addOptions: () => ({view: undefined}),
  addAttributes: () => ({id: {default: null}, title: {default: ''}}),
  parseHTML: () => [{tag: 'div[data-page-link]'}],
  renderHTML: ({HTMLAttributes}) => ['div', mergeAttributes(HTMLAttributes, {'data-page-link': ''})],
  renderMarkdown: (node) => String(node.attrs?.title || UNTITLED),
  addNodeView() {
    return this.options.view ?? null;
  },
});

/** 提及的三種:人(id = 帳號)、頁面(id = 筆記 id)、日期(id = 2026-10-14) */
export type MentionKind = 'user' | 'page' | 'date';
export type MentionAttrs = {kind: MentionKind; id: string | number | null; label: string};

/** 節點上的屬性 → 提及(認不得的種類當成日期那種「照字畫」,不會壞) */
export function mentionAttrs(attrs: Record<string, unknown>): MentionAttrs {
  const kind = attrs.kind === 'user' || attrs.kind === 'page' ? attrs.kind : 'date';
  return {kind, id: (attrs.id as string | number | null) ?? null, label: String(attrs.label ?? '')};
}

/**
 * 提及(「@」人、頁面、日期;「[[」頁面):字裡的一個小標籤,整個一塊(游標進不去)。
 * 頁面那一種的名字跟著那一頁走(外觀裡同步,同子頁連結);人存帳號,顯示用名冊的名字。
 */
const Mention = Node.create<{view?: NodeViewRenderer}>({
  name: 'noteMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({view: undefined}),
  addAttributes: () => ({kind: {default: 'user'}, id: {default: null}, label: {default: ''}}),
  parseHTML: () => [{tag: 'span[data-mention]'}],
  renderHTML: ({HTMLAttributes}) => ['span', mergeAttributes(HTMLAttributes, {'data-mention': ''}), String(HTMLAttributes.label ?? '')],
  // Markdown 只給搜尋與摘要:人寫成 @名字,頁面寫標題,日期照字
  renderMarkdown: (node) => {
    const {kind, label} = mentionAttrs(node.attrs ?? {});
    return kind === 'user' ? `@${label}` : kind === 'page' ? label || UNTITLED : label;
  },
  addNodeView() {
    return this.options.view ?? null;
  },
});

/** 資料庫:整個資料庫(欄位、列、檢視)存在節點的 data 屬性(JSON 文字)。外觀在 NoteDatabase.tsx */
const Database = Node.create<{view?: NodeViewRenderer}>({
  name: 'database',
  group: 'block',
  atom: true,
  selectable: true,
  addOptions: () => ({view: undefined}),
  addAttributes: () => ({data: {default: ''}}),
  parseHTML: () => [{tag: 'div[data-database]'}],
  renderHTML: () => ['div', {'data-database': ''}],
  // Markdown 只給搜尋:寫成一張表
  renderMarkdown: (node) => databaseToMarkdown(String(node.attrs?.data ?? '')),
  addNodeView() {
    return this.options.view ?? null;
  },
});

/** 資料庫 → Markdown 表格(只給搜尋與摘要) */
export function databaseToMarkdown(data: string): string {
  try {
    const db = JSON.parse(data) as Partial<DatabaseData>;
    const cols = db.columns ?? [];
    if (!cols.length) return db.title ?? '';
    // 選項寫名稱不寫 id(搜「完成」才找得到)
    const cell = (c: Column, v: unknown) => cellText(c, (v ?? null) as CellValue).replace(/\|/g, '/').replace(/\n/g, ' ');
    const head = `| ${cols.map((c) => c.name).join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const rows = (db.rows ?? []).map((r) => `| ${cols.map((c) => cell(c, r.cells?.[c.id])).join(' | ')} |`);
    return [db.title ? `**${db.title}**\n` : '', head, sep, ...rows].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

/**
 * 留言標記。沒有留言功能,這個標記**只為了讀得懂舊內容**:
 * 拿掉的話,掛過留言的那幾段字讀進來時編輯器不認得這個標記。畫出來是普通的字(note-editor.css 沒有它的樣式)。
 */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes: () => ({id: {default: null}}),
  parseHTML: () => [{tag: 'span[data-comment]', getAttrs: (el) => ({id: Number((el as HTMLElement).dataset.comment)})}],
  renderHTML: ({HTMLAttributes}) => ['span', {'data-comment': HTMLAttributes.id, class: 'note-comment'}, 0],
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? []),
});

/** 圖片:寬度(%)、靠左 / 置中、說明文字。內文存 `notebook-image:<id>`,畫的時候才換成真網址 */
function noteImage(view?: NodeViewRenderer) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent!(),
        width: {default: null},
        align: {default: 'left'},
        caption: {default: ''},
      };
    },
    renderHTML({HTMLAttributes}) {
      return ['img', {...HTMLAttributes, src: noteImageSrc(String(HTMLAttributes.src ?? ''))}];
    },
    ...(view ? {addNodeView: () => view} : {}),
  });
}

/**
 * 游標所在的那一段變成可收合清單(照 Notion):**原本的字變成標題**、內容是空的一行、打開著,游標留在原本的位置。
 * Tiptap 的 setDetails 是把整段包進「內容」、標題空白、預設收起 —— 字看起來就不見了。
 */
export function textblockToToggle(tr: Transaction): boolean {
  const {$from} = tr.selection;
  const block = $from.parent;
  const {schema} = tr.doc.type;
  if (!block.isTextblock || !schema.nodes.details) return false;
  const start = $from.before($from.depth);
  const details = schema.nodes.details.create({open: true}, [
    schema.nodes.detailsSummary.create(null, block.content),
    schema.nodes.detailsContent.create(null, schema.nodes.paragraph.create()),
  ]);
  tr.replaceWith(start, start + block.nodeSize, details);
  // details 開頭 +1、標題開頭 +1
  tr.setSelection(TextSelection.create(tr.doc, start + 2 + Math.min($from.parentOffset, block.content.size)));
  return true;
}

/** 縮排最多幾層(每層 --spacing-6,樣式在 note-editor.css) */
export const MAX_INDENT = 8;

/**
 * 段落、標題可以縮排(照 Notion 的 Tab;不接的話 Tab 會讓游標跳出編輯器)。
 * 存在節點的 indent 屬性(doc 裡);Markdown 沒有這種寫法,搜尋與摘要用的那一份不管縮排。Enter 換行時新的一行沿用同一層。
 */
const Indent = Extension.create({
  name: 'noteIndent',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            keepOnSplit: true,
            parseHTML: (el) => Math.min(MAX_INDENT, Number(el.getAttribute('data-indent')) || 0),
            renderHTML: (attrs) => (attrs.indent ? {'data-indent': attrs.indent} : {}),
          },
        },
      },
    ];
  },
});

/** 這些容器裡的 Tab 交給它們自己(清單:變子項目;表格:下一格) */
const TAB_OWNERS = new Set(['listItem', 'taskItem', 'tableCell', 'tableHeader']);

/**
 * Tab / Shift+Tab(照 Notion):段落、標題縮排 / 退一層;程式碼區塊插兩個空白。
 * 回 false 的(清單、表格)交給它們自己;其他一律回 true —— 不然瀏覽器拿去換焦點,游標跳出編輯器。
 */
export function indentBlock(editor: Editor, dir: -1 | 1): boolean {
  const {state} = editor;
  const {$from} = state.selection;
  for (let d = $from.depth; d > 0; d--) if (TAB_OWNERS.has($from.node(d).type.name)) return false;
  const block = $from.parent;
  if (block.type.name === 'codeBlock') {
    if (dir > 0) editor.commands.insertContent('  ');
    return true;
  }
  if (!('indent' in block.attrs)) return true;
  const next = Math.max(0, Math.min(MAX_INDENT, Number(block.attrs.indent || 0) + dir));
  if (next !== block.attrs.indent) editor.view.dispatch(state.tr.setNodeMarkup($from.before(), undefined, {...block.attrs, indent: next}));
  return true;
}

/** 縮排的那一段在最開頭按 Backspace:先退一層(照 Notion),退到底才照常併到上一段 */
function outdentAtStart(editor: Editor): boolean {
  const {selection} = editor.state;
  const block = selection.$from.parent;
  if (!selection.empty || selection.$from.parentOffset !== 0 || !block.attrs.indent) return false;
  return indentBlock(editor, -1);
}

/** 清單項目(游標在它的第一行時整項一起搬) */
const MOVABLE_ITEMS = new Set(['listItem', 'taskItem']);

/**
 * Ctrl+Shift+↑↓(照 Notion):游標所在的那一塊往上 / 往下搬一格,游標跟著走。
 * 已經在頭尾就不動,但回 true 把按鍵吃掉(不然瀏覽器拿去選字 / 捲動)。
 */
export function shiftBlock(editor: Editor, dir: -1 | 1): boolean {
  const {state} = editor;
  const {$from, from, to} = state.selection;
  if ($from.depth < 1) return false;
  // 搬的是游標所在的那一段(在提示框、可收合清單的內容、表格格子裡就在裡面搬,不是把整個容器搬走);
  // 只有兩種往外一層:清單項目的第一行 = 搬整個項目、可收合清單的標題 = 搬整個可收合清單
  let depth = $from.depth;
  while (depth > 1) {
    const here = $from.node(depth);
    if (here.type.name === 'detailsSummary') depth -= 1;
    else if (MOVABLE_ITEMS.has($from.node(depth - 1).type.name) && $from.index(depth - 1) === 0) depth -= 1;
    else break;
  }
  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const target = index + dir;
  if (target < 0 || target >= parent.childCount) return true;
  const node = $from.node(depth);
  const start = $from.before(depth);
  const sibling = parent.child(target);
  const tr = state.tr;
  let newStart: number;
  if (dir < 0) {
    newStart = start - sibling.nodeSize;
    tr.delete(start, start + node.nodeSize).insert(newStart, node);
  } else {
    newStart = start + sibling.nodeSize;
    tr.insert(start + node.nodeSize + sibling.nodeSize, node).delete(start, start + node.nodeSize);
  }
  try {
    tr.setSelection(TextSelection.create(tr.doc, newStart + (from - start), newStart + (to - start)));
  } catch {
    // 選取的是整塊(圖片、資料庫):交給 ProseMirror 自己對應
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Ctrl+Enter(照 Notion):在待辦上勾 / 取消;在可收合清單上開 / 合 */
function toggleAtCursor(editor: Editor): boolean {
  const {$from} = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const attr = node.type.name === 'taskItem' ? 'checked' : node.type.name === 'details' ? 'open' : null;
    if (!attr) continue;
    editor.view.dispatch(editor.state.tr.setNodeMarkup($from.before(d), undefined, {...node.attrs, [attr]: !node.attrs[attr]}));
    return true;
  }
  return false;
}

/**
 * 貼上的純文字看起來是 Markdown(有標題、清單、引用、程式碼、表格、粗體):照 Notion 轉成格式。
 * 一般句子、網址不轉(網址要留給「貼網址變連結」)。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (/^\s*https?:\/\/\S+\s*$/.test(text)) return false;
  // 行首:標題、清單、編號、引用、程式碼、表格列、待辦
  const block = /^(#{1,6} |[-*+] (?!\d)|\d+\. |> |```|\|.+\|\s*$|- \[[ x]\] )/m;
  // 行內:**粗體**、[字](網址)
  const inline = /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/;
  return block.test(text) || inline.test(text);
}

/**
 * 剪貼簿的 HTML 自己有沒有排版結構(標題、清單、表格、引用、段落)。沒有的(VS Code 給的上色原始碼只有 div / span / br、
 * 網頁上原始碼框是 pre / code)= 那份 HTML 只是「長得像程式碼的字」,純文字那一份如果是 Markdown 就照 Markdown 轉。
 */
export function htmlHasStructure(html: string): boolean {
  return /<(h[1-6]|ul|ol|li|table|blockquote|p)[\s>]/i.test(html);
}

/** 改一段的種類(Notion 的「轉換成」、Ctrl+Alt+數字、「/」選單共用) */
export type BlockKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'todo' | 'bullet' | 'ordered' | 'toggle' | 'quote' | 'callout' | 'code';

export function turnInto(editor: Editor, kind: BlockKind) {
  const c = editor.chain().focus();
  // 先退回一般段落(拆掉清單、引用),再套成要的種類 —— 不然「待辦」轉「編號」會變成兩層
  const reset = () => {
    if (editor.isActive('taskList')) c.toggleTaskList();
    if (editor.isActive('bulletList')) c.toggleBulletList();
    if (editor.isActive('orderedList')) c.toggleOrderedList();
    if (editor.isActive('blockquote')) c.lift('blockquote');
    return c.setParagraph();
  };
  switch (kind) {
    case 'paragraph':
      return reset().run();
    case 'h1':
    case 'h2':
    case 'h3':
      return reset()
        .setNode('heading', {level: Number(kind[1])})
        .run();
    case 'todo':
      return reset().toggleTaskList().run();
    case 'bullet':
      return reset().toggleBulletList().run();
    case 'ordered':
      return reset().toggleOrderedList().run();
    case 'quote':
      return reset().toggleBlockquote().run();
    case 'code':
      return reset().toggleCodeBlock().run();
    case 'toggle':
      return reset()
        .command(({tr}) => textblockToToggle(tr))
        .run();
    case 'callout':
      return reset().wrapIn('callout').run();
  }
}

/** Notion 的快捷鍵:Ctrl+Alt+0 文字、1/2/3 標題、4 待辦、5 項目、6 編號、7 可收合、8 程式碼;Ctrl+D 複製這一段;
 * Ctrl+Enter 勾待辦 / 開合;Ctrl+Shift+↑↓ 搬動這一塊 */
/**
 * 區塊把手拖曳中,被拖的那一塊變淡(BlockHandle)。用裝飾(decoration)標,不能直接改它的 DOM class ——
 * ProseMirror 會把那當成外來的改動、重畫時洗掉。
 * 只帶 meta 的 transaction 不改內容,不會觸發存檔、也不會同步給其他人。
 */
const dragSourceKey = new PluginKey<number | null>('noteDragSource');
const DragSource = Extension.create({
  name: 'noteDragSource',
  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: dragSourceKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(dragSourceKey);
            if (meta !== undefined) return meta as number | null;
            return value == null ? null : tr.mapping.map(value);
          },
        },
        props: {
          decorations(state) {
            const pos = dragSourceKey.getState(state);
            const node = pos == null ? null : state.doc.nodeAt(pos);
            if (pos == null || !node) return null;
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, {class: 'note-editor-dragging'})]);
          },
        },
      }),
    ];
  },
});

/** 正在被拖的那一塊現在在哪裡(拖的途中別人改了內容,位置會跟著移;沒在拖 = null) */
export function dragSourcePos(editor: Editor): number | null {
  return dragSourceKey.getState(editor.state) ?? null;
}

/** 標 / 取消「正在被拖的那一塊」(pos = null 取消) */
export function setDragSource(editor: Editor, pos: number | null) {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(dragSourceKey, pos));
}

/**
 * ⚠️ 優先權要比 1000 高:StarterKit 的標題自帶 Ctrl+Alt+1~6(toggleHeading,而且 1~6 都開著),
 * 跟這裡搶同一組鍵 —— 1/2/3 轉過去又被轉回來、4/5/6 變成標題 4~6。
 * 每個都回 true:這裡處理過就不要再往下傳。
 */
const NotionKeys = Node.create({
  name: 'notionKeys',
  priority: 1100,
  addKeyboardShortcuts() {
    const to = (kind: BlockKind) => () => {
      turnInto(this.editor, kind);
      return true;
    };
    return {
      'Mod-Alt-0': to('paragraph'),
      'Mod-Alt-1': to('h1'),
      'Mod-Alt-2': to('h2'),
      'Mod-Alt-3': to('h3'),
      'Mod-Alt-4': to('todo'),
      'Mod-Alt-5': to('bullet'),
      'Mod-Alt-6': to('ordered'),
      'Mod-Alt-7': to('toggle'),
      'Mod-Alt-8': to('code'),
      'Mod-d': () => duplicateBlock(this.editor),
      'Mod-Enter': () => toggleAtCursor(this.editor),
      'Mod-Shift-ArrowUp': () => shiftBlock(this.editor, -1),
      'Mod-Shift-ArrowDown': () => shiftBlock(this.editor, 1),
      Tab: () => indentBlock(this.editor, 1),
      'Shift-Tab': () => indentBlock(this.editor, -1),
      Backspace: () => outdentAtStart(this.editor),
    };
  },
});

/**
 * 複製一份放在正下方(區塊選單、Ctrl+D)。`pos` = 那一塊開頭的位置(區塊把手給的);
 * 沒給 = 游標所在的最上層那一塊。
 */
export function duplicateBlock(editor: Editor, pos?: number): boolean {
  const {state} = editor;
  const start = pos ?? (state.selection.$from.depth > 0 ? state.selection.$from.before(1) : state.selection.from);
  const node = state.doc.nodeAt(start);
  if (!node) return false;
  return editor.chain().insertContentAt(start + node.nodeSize, node.toJSON()).run();
}

export function noteExtensions(views: Views = {}): Extensions {
  return [
    StarterKit.configure({
      codeBlock: false,
      blockquote: false,
      // 點連結就開(Notion 一樣);改連結用選字工具列或 Ctrl+K
      link: {openOnClick: true, autolink: true, linkOnPaste: true},
    }),
    NoteCodeBlock.configure({view: views.codeBlock}),
    NoteBlockquote,
    NoteDetails.configure({
      persist: true,
      HTMLAttributes: {class: 'note-details'},
      renderToggleButton: ({element, isOpen}) => element.setAttribute('aria-label', isOpen ? '收起' : '展開'),
    }),
    NoteDetailsSummary,
    NoteDetailsContent,
    Callout.configure({view: views.callout}),
    PageLink.configure({view: views.pageLink}),
    Database.configure({view: views.database}),
    Mention.configure({view: views.mention}),
    CommentMark,
    TextStyle,
    Color,
    BackgroundColor,
    TableKit.configure({table: {resizable: false}}),
    TaskList,
    TaskItem.configure({
      nested: true,
      // 報讀程式念的那句(內建是英文「Task item checkbox for …」)
      a11y: {checkboxLabel: (node, checked) => `${checked ? '已完成' : '待辦'}:${node.textContent || '空的待辦'}`},
    }),
    noteImage(views.image),
    Placeholder.configure({
      showOnlyCurrent: true,
      includeChildren: false,
      placeholder: ({editor, node}) => {
        // 提示字只有兩處:空白筆記第一行、游標所在的空行。標題空著也算空行;
        // 可收合清單的標題不放(「標題 N」「可收合清單」這類提示是多餘的說明文字)
        if (node.type.name === 'heading') return PLACEHOLDER_LINE;
        if (node.type.name !== 'paragraph') return '';
        return editor.isEmpty ? PLACEHOLDER_EMPTY_NOTE : PLACEHOLDER_LINE;
      },
    }),
    Indent,
    NotionKeys,
    DragSource,
    Markdown,
  ];
}
