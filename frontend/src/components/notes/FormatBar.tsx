/**
 * 選一段字浮出來的格式工具列,照 Notion 的順序:
 * 「轉換成 ▾」| 粗體 斜體 底線 刪除線 程式碼 | 連結 | 顏色 ▾。
 *   - 連結:按鈕或 Ctrl+K 打開網址框;已經是連結的話變成「拿掉連結」。
 *   - 顏色:文字顏色與底色各 9 種(Astryx 的色票 token,深色模式跟著換)。一個下拉選單、每種寫名字
 *     (只放 18 個沒有名字的「A」看不出哪個是哪個)。
 * 觸控螢幕不出(用系統自己的選字選單);程式碼區塊、整塊選取(圖片、圖表)、唯讀也不出。
 */
import {useEffect, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Card} from '@astryxdesign/core/Card';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {NodeSelection} from '@tiptap/pm/state';
import {useEditorState, type Editor} from '@tiptap/react';
import {BubbleMenu} from '@tiptap/react/menus';
import {
  Baseline,
  Bold,
  Check,
  Code,
  Italic,
  Link as LinkIcon,
  Strikethrough,
  Underline,
  Unlink,
  type LucideIcon,
} from 'lucide-react';

import {BACKGROUND_COLORS, TEXT_COLORS, turnInto, type BlockKind} from './noteExtensions';
import {useNoteHost} from './noteHost';
import {MENU_MAX_HEIGHT_CSS, TURN_INTO} from './slashCommand';

const styles = stylex.create({
  // 位置由 BubbleMenu(floating-ui)自己寫在 style 上,這裡只給層級(42,見 global.css 的層級表)
  bubble: {zIndex: 42},
  linkInput: {width: 220},
  swatch: {
    width: 'var(--spacing-5)',
    height: 'var(--spacing-5)',
    borderRadius: 'var(--radius-inner)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    display: 'grid',
    placeItems: 'center',
  },
});


/** 現在這一段是什麼(「轉換成」按鈕上顯示它的名字、選單裡它打勾) */
function currentKind(e: Editor): BlockKind {
  if (e.isActive('heading', {level: 1})) return 'h1';
  if (e.isActive('heading', {level: 2})) return 'h2';
  if (e.isActive('heading', {level: 3})) return 'h3';
  if (e.isActive('taskList')) return 'todo';
  if (e.isActive('bulletList')) return 'bullet';
  if (e.isActive('orderedList')) return 'ordered';
  if (e.isActive('details')) return 'toggle';
  if (e.isActive('callout')) return 'callout';
  if (e.isActive('blockquote')) return 'quote';
  return 'paragraph';
}

export function FormatBar({editor}: {editor: Editor}) {
  const host = useNoteHost();
  const [linking, setLinking] = useState<string | null>(null);
  // 按鈕的「開著」要跟著選取走:編輯器設了 shouldRerenderOnTransaction:false,不訂這個的話會停在上一次 render 的樣子
  // (選到一段連結時,按鈕要變成「拿掉連結」)
  const active = useEditorState({
    editor,
    selector: ({editor: e}) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      kind: currentKind(e),
      color: (e.getAttributes('textStyle').color as string | undefined) ?? null,
      background: (e.getAttributes('textStyle').backgroundColor as string | undefined) ?? null,
    }),
  });

  useEffect(() => {
    const reset = () => setLinking(null);
    editor.on('selectionUpdate', reset);
    // Ctrl+K:選了字就打開網址框
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k' && !editor.state.selection.empty) {
        e.preventDefault();
        setLinking(editor.getAttributes('link').href ?? '');
      }
    };
    editor.view.dom.addEventListener('keydown', onKey);
    return () => {
      editor.off('selectionUpdate', reset);
      editor.view.dom.removeEventListener('keydown', onKey);
    };
  }, [editor]);

  const button = (label: string, icon: LucideIcon, isOn: boolean, run: () => void) => (
    <IconButton key={label} label={label} size="sm" variant={isOn ? 'secondary' : 'ghost'} icon={<Icon icon={icon} size="sm" />} onClick={run} />
  );
  const applyLink = () => {
    const href = linking?.trim();
    if (href) editor.chain().focus().extendMarkRange('link').setLink({href}).run();
    else editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinking(null);
  };
  const setColor = (value: string | null) => {
    const c = editor.chain().focus();
    (value ? c.setColor(value) : c.unsetColor()).run();
  };
  const setBackground = (value: string | null) => {
    const c = editor.chain().focus();
    (value ? c.setBackgroundColor(value) : c.unsetBackgroundColor()).run();
  };

  /** 顏色選單的一列:左邊一個「A」色塊(文字色或底色),右邊名字,現在用的打勾 */
  const colorItems = (list: typeof TEXT_COLORS, current: string | null, isBackground: boolean, apply: (v: string | null) => void) =>
    list.map((c) => ({
      label: c.label,
      icon: (
        <Stack xstyle={styles.swatch} style={isBackground ? {backgroundColor: c.value ?? 'transparent'} : undefined}>
          <Text type="supporting" style={!isBackground && c.value ? {color: c.value} : undefined}>
            A
          </Text>
        </Stack>
      ),
      endContent: current === c.value ? <Icon icon={Check} size="sm" /> : undefined,
      onClick: () => apply(c.value),
    }));

  return (
    <BubbleMenu
      editor={editor}
      className={stylex.props(styles.bubble).className}
      options={{placement: 'top', offset: 8}}
      shouldShow={({state, from, to}) =>
        from !== to &&
        !host.readOnly &&
        !(state.selection instanceof NodeSelection) &&
        !editor.isActive('codeBlock') &&
        !window.matchMedia('(pointer: coarse)').matches
      }
    >
      <Card elevation="high" padding={1} width="fit-content">
        {linking !== null ? (
          <HStack gap={1} vAlign="center">
            <Stack xstyle={styles.linkInput}>
              <TextInput label="連結網址" isLabelHidden size="sm" value={linking} hasAutoFocus onChange={setLinking} onEnter={applyLink} />
            </Stack>
            {button('套用連結', Check, false, applyLink)}
          </HStack>
        ) : (
          <HStack gap={0.5} vAlign="center">
            <DropdownMenu
              button={{label: TURN_INTO.find((k) => k.kind === active.kind)?.label ?? '文字', variant: 'ghost', size: 'sm'}}
              menuWidth={180}
              // 最高跟「/」選單一樣(Astryx 預設 300px,轉換成 11 項、顏色 18 項都要捲)
              style={{maxHeight: MENU_MAX_HEIGHT_CSS}}
              items={TURN_INTO.map((k) => ({
                label: k.label,
                icon: <Icon icon={k.icon} size="sm" />,
                endContent: k.kind === active.kind ? <Icon icon={Check} size="sm" /> : undefined,
                onClick: () => turnInto(editor, k.kind),
              }))}
            />
            {button('粗體', Bold, active.bold, () => editor.chain().focus().toggleBold().run())}
            {button('斜體', Italic, active.italic, () => editor.chain().focus().toggleItalic().run())}
            {button('底線', Underline, active.underline, () => editor.chain().focus().toggleUnderline().run())}
            {button('刪除線', Strikethrough, active.strike, () => editor.chain().focus().toggleStrike().run())}
            {button('程式碼', Code, active.code, () => editor.chain().focus().toggleCode().run())}
            {active.link
              ? button('拿掉連結', Unlink, true, () => editor.chain().focus().extendMarkRange('link').unsetLink().run())
              : button('連結', LinkIcon, false, () => setLinking(''))}
            <DropdownMenu
              button={{
                label: '顏色',
                icon: <Icon icon={Baseline} size="sm" />,
                isIconOnly: true,
                variant: active.color || active.background ? 'secondary' : 'ghost',
                size: 'sm',
              }}
              hasChevron={false}
              menuWidth={180}
              // 最高跟「/」選單一樣(Astryx 預設 300px,轉換成 11 項、顏色 18 項都要捲)
              style={{maxHeight: MENU_MAX_HEIGHT_CSS}}
              items={[
                {type: 'section', title: '文字顏色', items: colorItems(TEXT_COLORS, active.color, false, setColor)},
                {type: 'section', title: '底色', items: colorItems(BACKGROUND_COLORS, active.background, true, setBackground)},
              ]}
            />
          </HStack>
        )}
      </Card>
    </BubbleMenu>
  );
}
