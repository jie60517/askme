/**
 * 個人筆記的內文編輯器(操作手感照 Notion)。
 *
 * 看跟改是同一個畫面:排好版的內容直接打字。
 *   - 區塊把手 ＋ ⋮⋮(`BlockHandle`):拖曳搬動、區塊選單。
 *   - 「/」選單行首或空白後都會跳(`slashCommand`)。
 *   - 選字工具列:轉換成、底線、顏色(`FormatBar`)。
 *   - 空白筆記第一行、游標所在空行的淡灰提示字。
 *   - 可收合清單、提示框、子頁、資料庫、圖片拉寬度(`nodeViews`)。
 *   - 標題 ↔ 內文:內文第一行按 ↑ / 開頭按 Backspace 回到標題。
 *
 * 內容:**有 doc(JSON)就用 doc**;沒有的是舊筆記,從 Markdown 讀。存的時候 doc + Markdown 一起交出去(Markdown 給搜尋、摘要)。
 * **打開不改寫**:讀進來還沒動過之前不交出去;改了字又改回原樣,交回原本那一份。
 *
 * 字級、間距、顏色在 `styles/note-editor.css`(編輯器的 DOM 是 ProseMirror 自己長的,StyleX 碰不到),全是 Astryx token;
 * 那個檔在 `main.tsx` 匯入,不在這裡(理由寫在那裡:放在 lazy 的這一包會把全站 StyleX 樣式一起搬走)。
 */
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Lightbox} from '@astryxdesign/core/Lightbox';
import {Stack} from '@astryxdesign/core/Layout';
import type {Extensions} from '@tiptap/core';
import {EditorContent, ReactNodeViewRenderer, useEditor, type Editor} from '@tiptap/react';

import {imageSrcOfRef, NOTE_IMAGE_TYPE} from '../../lib/notebookApi';
import {BlockHandle} from './BlockHandle';
import {BlockSelection, hasBlockSelection} from './blockSelection';
import {FormatBar} from './FormatBar';
import {NoteDatabaseView} from './NoteDatabase';
import {htmlHasStructure, looksLikeMarkdown, noteExtensions} from './noteExtensions';
import {DEFAULT_HOST, NoteHostContext, setHost, type NoteHost} from './noteHost';
import {CalloutView, CodeView, ImageView, MentionView, PageLinkView} from './nodeViews';
import {SlashCommand, SuggestionMenu} from './slashCommand';

const styles = stylex.create({
  // 區塊把手是 absolute,定位的基準是這一層
  wrap: {position: 'relative'},
});

/** 擴充清單只建一次:每次 render 重建的話,Tiptap 比對選項永遠不同,每打一個字都重設一次 */
const VIEWS = {
  image: ReactNodeViewRenderer(ImageView),
  codeBlock: ReactNodeViewRenderer(CodeView),
  callout: ReactNodeViewRenderer(CalloutView),
  pageLink: ReactNodeViewRenderer(PageLinkView),
  database: ReactNodeViewRenderer(NoteDatabaseView),
  mention: ReactNodeViewRenderer(MentionView, {as: "span"}),
};
const BASE_EXTENSIONS: Extensions = [...noteExtensions(VIEWS), SlashCommand, BlockSelection];

export type NoteEditorHandle = {focus: (where: 'start' | 'end') => void; editor: Editor | null};

export type NoteContent = {body: string; doc: string | null};

/**
 * 「有沒有改過」用的指紋:JSON,不算結尾的空段落 —— 游標一放進去,編輯器會在最後自動補一個空段落
 * (StarterKit 的 trailingNode,為了表格、圖片後面還能點下去打字),那不是使用者改的。
 */
export function contentKey(editor: Editor): string {
  const json = editor.getJSON();
  const blocks = [...(json.content ?? [])];
  while (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    if (last.type === 'paragraph' && !last.content?.length) blocks.pop();
    else break;
  }
  return JSON.stringify({...json, content: blocks});
}

function initialContent(doc: string | null, body: string) {
  if (doc) {
    try {
      return {content: JSON.parse(doc), contentType: 'json' as const};
    } catch {
      // 壞掉的 doc(不該發生):退回 Markdown,至少字還在
    }
  }
  return {content: body, contentType: 'markdown' as const};
}

export function NoteEditor({
  body,
  doc,
  onChange,
  host,
  handle,
  onExitTop,
}: {
  /** 這一則現在的 Markdown(草稿) */
  body: string;
  /** 這一則現在的編輯器格式(草稿);null = 舊筆記 */
  doc: string | null;
  /** 使用者改了內容:新的 Markdown 與 doc */
  onChange: (next: NoteContent) => void;
  host: Partial<NoteHost>;
  handle?: RefObject<NoteEditorHandle | null>;
  /** 內文最上面按 ↑ / 開頭按 Backspace:回到標題 */
  onExitTop?: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** 最後一次交出去 / 收進來的內容:外面傳回同一份就不重設編輯器 */
  const last = useRef<NoteContent>({body, doc});
  /** 讀進來的那一份(改回原樣時交回它) */
  const loaded = useRef<NoteContent>({body, doc});
  /** 讀進來、還沒動過時的指紋 */
  const baseline = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  const onExitTopRef = useRef(onExitTop);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    onExitTopRef.current = onExitTop;
  });
  const [shown, setShown] = useState<{src: string; alt: string} | null>(null);
  const [isShown, setIsShown] = useState(false);
  const readOnly = !!host.readOnly;
  // onUpdate 是建編輯器那一刻的閉包:唯讀改了要從這裡讀
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const editorRef = useRef<Editor | null>(null);

  const insertImages = useCallback(
    async (editor: Editor, files: File[]) => {
      for (const file of files) {
        const ref = await (host.uploadImage ?? DEFAULT_HOST.uploadImage)(file);
        const src = ref && imageSrcOfRef(ref);
        if (!src || editor.isDestroyed) continue;
        // 插在**當下**的游標(上傳要等,先記好的位置可能已經不在了),插完游標在圖後面,下一張接著插
        editor.commands.insertContent({type: 'image', attrs: {src}});
      }
    },
    [host.uploadImage],
  );

  const fullHost: NoteHost = useMemo(
    () => ({
      ...DEFAULT_HOST,
      ...host,
      showImage: (image) => {
        setShown(image);
        setIsShown(true);
      },
      pickImage: () => fileInput.current?.click(),
    }),
    [host],
  );

  const init = initialContent(doc, body);
  const editor = useEditor(
    {
      extensions: BASE_EXTENSIONS,
      ...init,
      editable: !readOnly,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {class: 'note-editor-content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': '內容'},
        handlePaste: (_view, e) => {
          const ed = editorRef.current;
          if (!ed) return false;
          // 貼上 Markdown(照 Notion):轉成標題、清單、表格、粗體;程式碼區塊裡照原樣貼。
          // 帶 HTML 的也算 —— 從 VS Code、網頁上的原始碼框複製的,HTML 只是上了色的原始碼(沒有標題 / 清單 / 表格這些結構);
          // HTML 本身就有結構的(從排好版的網頁、Word 複製)照 HTML 貼
          const text = e.clipboardData?.getData('text/plain') ?? '';
          const html = e.clipboardData?.getData('text/html') ?? '';
          if (text && !ed.isActive('codeBlock') && looksLikeMarkdown(text) && !htmlHasStructure(html)) {
            e.preventDefault();
            ed.commands.insertContent(text, {contentType: 'markdown'});
            return true;
          }
          // 從 Excel / Word 複製的同時帶 HTML 和一張圖:那是要貼表格 / 文字,不是要貼圖
          if (html) return false;
          const files = [...(e.clipboardData?.files ?? [])].filter((f) => NOTE_IMAGE_TYPE.test(f.type));
          if (!files.length) return false;
          e.preventDefault();
          void insertImages(ed, files);
          return true;
        },
        handleDrop: (view, e, _slice, moved) => {
          if (moved) return false;
          const files = [...(e.dataTransfer?.files ?? [])].filter((f) => NOTE_IMAGE_TYPE.test(f.type));
          const ed = editorRef.current;
          if (!files.length || !ed) return false;
          e.preventDefault();
          const at = view.posAtCoords({left: e.clientX, top: e.clientY})?.pos;
          if (at != null) ed.commands.setTextSelection(at);
          void insertImages(ed, files);
          return true;
        },
        handleKeyDown: (view, e) => {
          // 標題 ↔ 內文:最上面那一行按 ↑、最開頭按 Backspace(而且第一段是空的)回到標題
          const {selection, doc: d} = view.state;
          // 選著整塊的時候 ↑ 是換一塊(blockSelection),不是回標題
          if (hasBlockSelection(view.state)) return false;
          const atStart = selection.empty && selection.from <= 1;
          if (atStart && e.key === 'ArrowUp' && onExitTopRef.current) {
            e.preventDefault();
            onExitTopRef.current();
            return true;
          }
          if (atStart && e.key === 'Backspace' && onExitTopRef.current && d.firstChild?.type.name === 'paragraph') {
            if (d.firstChild.content.size === 0 && d.childCount > 1) return false; // 刪掉這個空段落就好
            // 縮排的先退一層(NotionKeys 的 Backspace);這裡比它先拿到鍵,不讓開的話縮排永遠退不掉
            if (d.firstChild.attrs.indent) return false;
            e.preventDefault();
            onExitTopRef.current();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({editor: ed}) => {
        if (readOnlyRef.current) return;
        const key = contentKey(ed);
        const next: NoteContent = key === baseline.current || key === loaded.current.doc ? loaded.current : {body: ed.getMarkdown().trimEnd(), doc: key};
        if (next.body === last.current.body && next.doc === last.current.doc) return;
        last.current = next;
        onChangeRef.current(next);
      },
    },
    [],
  );
  useLayoutEffect(() => {
    editorRef.current = editor;
    setHost(editor, fullHost);
  });
  // 基準在編輯器一建好就記下(immediatelyRender:這一輪 render 就有編輯器)。不能等 onCreate —— 它比第一次更新還晚到
  if (baseline.current === null) baseline.current = contentKey(editor);

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // 外面換了內容(切回分頁重讀到別台電腦 / 別人改過的版本):重設編輯器,這一下不算使用者改的
  useEffect(() => {
    if (body === last.current.body && doc === last.current.doc) return;
    last.current = {body, doc};
    loaded.current = {body, doc};
    const next = initialContent(doc, body);
    editor.commands.setContent(next.content, {contentType: next.contentType, emitUpdate: false});
    baseline.current = contentKey(editor);
  }, [body, doc, editor]);

  useLayoutEffect(() => {
    if (!handle) return;
    handle.current = {focus: (where) => editor.commands.focus(where), editor};
    return () => {
      handle.current = null;
    };
  }, [handle, editor]);

  return (
    <NoteHostContext.Provider value={fullHost}>
      <Stack ref={wrap} xstyle={styles.wrap}>
        <EditorContent editor={editor} className="note-editor" />
        {!readOnly ? <BlockHandle editor={editor} container={wrap} /> : null}
      </Stack>
      <FormatBar editor={editor} />
      <SuggestionMenu />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].filter((f) => NOTE_IMAGE_TYPE.test(f.type));
          e.target.value = '';
          if (files.length) void insertImages(editor, files);
        }}
      />
      {/* 燈箱在編輯器 DOM 外面:它是原生 <dialog>,放在裡面的話燈箱裡的點擊會落進編輯器。關的時候留著上一張,退場動畫才不會變空白 */}
      {shown ? <Lightbox isOpen={isShown} onOpenChange={setIsShown} media={shown} hasZoom /> : null}
    </NoteHostContext.Provider>
  );
}
