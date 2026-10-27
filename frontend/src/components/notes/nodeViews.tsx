/**
 * 筆記編輯器裡幾種自己畫的節點外觀:圖片(拉寬度、置中、說明文字、看大圖)、
 * 程式碼(語言、複製)、提示框(換圖示)、子頁連結(標題跟著那一頁走)。
 * 跟筆記頁要的東西(看大圖、子頁標題、打開子頁、唯讀)從 `useNoteHost()` 拿。
 */
import {useEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {NodeViewContent, NodeViewWrapper, type NodeViewProps} from '@tiptap/react';
import {AlignCenter, AlignLeft, Check, Copy, Lightbulb, Maximize2} from 'lucide-react';

import {noteImageSrc, noteTitle} from '../../lib/notebookApi';
import {displayNameOf} from '../../lib/peopleDirectory';
import {dateLabel, fromIsoDate} from './mentionMenu';
import {mentionAttrs} from './noteExtensions';
import {useNoteHost} from './noteHost';
import {iconOf, IconPicker, PageIcon} from './pageIcons';

const styles = stylex.create({
  // 工具列浮在圖片右上角(滑過 / 選取才出來,CSS 在 note-editor.css 的 .note-editor-image-action)
  imageTools: {position: 'absolute', top: 'var(--spacing-2)', right: 'var(--spacing-2)'},
  codeTools: {position: 'absolute', top: 'var(--spacing-2)', right: 'var(--spacing-2)'},
  // 子頁連結:ghost 鈕自己有左右內距,往左拉回去,圖示才跟內文左緣對齊(差 12)
  pageLink: {marginInlineStart: 'calc(var(--spacing-3) * -1)'},
});

/**
 * 圖片:左右兩邊拖曳調寬度(存成內文欄寬的百分比)、靠左 / 置中、下面一行說明文字、右上角看大圖。
 * 點一下是選取(可以刪、可以用區塊把手拖)。
 */
export function ImageView({node, selected, updateAttributes}: NodeViewProps) {
  const host = useNoteHost();
  const frame = useRef<HTMLDivElement>(null);
  const src = noteImageSrc(String(node.attrs.src ?? ''));
  const alt = String(node.attrs.alt || '筆記裡的圖片');
  const width = node.attrs.width as number | null;
  const align = (node.attrs.align as string) || 'left';
  const caption = String(node.attrs.caption ?? '');
  const show = () => host.showImage({src, alt});

  /** 拖左右邊:寬度 = 拖到的位置佔整欄的幾 %(10–100) */
  const startResize = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const fig = frame.current;
    const column = fig?.closest('.ProseMirror') as HTMLElement | null;
    if (!fig || !column) return;
    const box = column.getBoundingClientRect();
    const start = fig.getBoundingClientRect();
    const startX = e.clientX;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (side === 'right' ? 1 : -1) * (align === 'center' ? 2 : 1);
      const pct = Math.round(Math.min(100, Math.max(10, ((start.width + dx) / box.width) * 100)));
      updateAttributes({width: pct});
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <NodeViewWrapper className="note-editor-image" data-selected={selected ? '' : undefined} data-align={align}>
      <div ref={frame} className="note-editor-image-frame" style={width ? {width: `${width}%`} : undefined}>
        <img src={src} alt={alt} loading="lazy" draggable={false} onDoubleClick={show} />
        {!host.readOnly ? (
          <>
            <div className="note-editor-image-grip" data-side="left" contentEditable={false} onPointerDown={startResize('left')} />
            <div className="note-editor-image-grip" data-side="right" contentEditable={false} onPointerDown={startResize('right')} />
          </>
        ) : null}
        <div className="note-editor-image-action" contentEditable={false}>
          <Stack xstyle={styles.imageTools}>
            <Card elevation="high" padding={0.5} width="fit-content">
              <HStack gap={0.5}>
                {!host.readOnly ? (
                  <>
                    <IconButton label="靠左" size="sm" variant={align === 'left' ? 'secondary' : 'ghost'} icon={<Icon icon={AlignLeft} size="sm" />} onClick={() => updateAttributes({align: 'left'})} />
                    <IconButton label="置中" size="sm" variant={align === 'center' ? 'secondary' : 'ghost'} icon={<Icon icon={AlignCenter} size="sm" />} onClick={() => updateAttributes({align: 'center'})} />
                  </>
                ) : null}
                <IconButton label="看大圖" size="sm" variant="ghost" icon={<Icon icon={Maximize2} size="sm" />} onClick={show} />
              </HStack>
            </Card>
          </Stack>
        </div>
      </div>
      {/* 說明文字:沒寫又唯讀就不畫;可以改的時候是一行沒有框的輸入(同大標題的理由:Astryx 的輸入框都有框) */}
      {caption || !host.readOnly ? (
        <input
          className="note-editor-image-caption"
          contentEditable={false}
          aria-label="圖片說明"
          value={caption}
          readOnly={host.readOnly}
          onChange={(e) => updateAttributes({caption: e.target.value})}
          // 說明文字裡的鍵不要被編輯器接走(Enter 會變成換段、Backspace 會刪掉整張圖)
          onKeyDown={(e) => e.stopPropagation()}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

const LANGUAGES = ['純文字', 'sql', 'python', 'javascript', 'typescript', 'bash', 'json', 'xml', 'html', 'css', 'java', 'csharp', 'go', 'yaml'];

/** 程式碼區塊:右上角選語言、複製(Notion 也是) */
export function CodeView({node, updateAttributes}: NodeViewProps) {
  const host = useNoteHost();
  const [copied, setCopied] = useState(false);
  const language = (node.attrs.language as string) || '純文字';
  const copy = () => {
    void navigator.clipboard?.writeText(node.textContent).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <NodeViewWrapper className="note-editor-code">
      <pre spellCheck={false}>
        <NodeViewContent<'code'> as="code" />
      </pre>
      <div className="note-editor-code-tools" contentEditable={false}>
        <Stack xstyle={styles.codeTools}>
          <HStack gap={1} vAlign="center">
            {host.readOnly ? (
              <Text type="supporting" color="secondary">
                {language}
              </Text>
            ) : (
              <DropdownMenu
                button={{label: language, variant: 'ghost', size: 'sm'}}
                alignment="end"
                menuWidth={160}
                items={LANGUAGES.map((l) => ({label: l, onClick: () => updateAttributes({language: l === '純文字' ? null : l})}))}
              />
            )}
            <IconButton label={copied ? '已複製' : '複製'} size="sm" variant="ghost" icon={<Icon icon={copied ? Check : Copy} size="sm" />} onClick={copy} />
          </HStack>
        </Stack>
      </div>
    </NodeViewWrapper>
  );
}

/** 提示框:左邊一個線條圖示(點了換)、右邊一般內容 */
export function CalloutView({node, updateAttributes}: NodeViewProps) {
  const host = useNoteHost();
  const icon = iconOf(String(node.attrs.icon ?? '')) ?? Lightbulb;
  return (
    <NodeViewWrapper className="note-editor-callout">
      <div className="note-editor-callout-icon" contentEditable={false}>
        {host.readOnly ? (
          <Icon icon={icon} size="sm" color="secondary" />
        ) : (
          <IconPicker label="提示框圖示" onPick={(name) => updateAttributes({icon: name})}>
            <IconButton label="換圖示" size="sm" variant="ghost" icon={<Icon icon={icon} size="sm" color="secondary" />} />
          </IconPicker>
        )}
      </div>
      <NodeViewContent className="note-editor-callout-body" />
    </NodeViewWrapper>
  );
}

/**
 * 子頁連結、頁面提及共用:這一頁現在的標題與圖示,而且**存下來的那個字跟著它走**(Markdown 的搜尋、摘要用的是存下來的,
 * 不跟著走就會永遠停在建立當下的「未命名」)。只能看的人不改(他的改動存不回去)。
 * `attr` = 節點上存標題的那個屬性(子頁連結是 title、提及是 label)。
 */
function useLinkedPage(id: number | null, attr: 'title' | 'label', {node, editor, updateAttributes}: Pick<NodeViewProps, 'node' | 'editor' | 'updateAttributes'>) {
  const host = useNoteHost();
  const page = id == null ? undefined : host.page(id);
  const current = page?.title;
  const stored = node.attrs[attr];
  useEffect(() => {
    if (current === undefined || current === stored || !editor.isEditable) return;
    updateAttributes({[attr]: current});
  }, [attr, current, stored, editor, updateAttributes]);
  return page;
}

/** 子頁連結:一列,點了打開那一頁;標題 / 圖示跟著那一頁走 */
export function PageLinkView(props: NodeViewProps) {
  const {node, selected} = props;
  const host = useNoteHost();
  const id = Number(node.attrs.id);
  const page = useLinkedPage(id, 'title', props);
  const title = noteTitle(page?.title ?? String(node.attrs.title ?? ''));
  return (
    <NodeViewWrapper className="note-editor-pagelink" data-selected={selected ? '' : undefined} contentEditable={false}>
      <Button label={title} variant="ghost" size="sm" icon={<PageIcon icon={page?.icon} />} xstyle={styles.pageLink} onClick={() => host.openPage(id)} />
    </NodeViewWrapper>
  );
}

/**
 * 提及(「@」「[[」):字裡一個淡灰底的小標籤。頁面那一種多一個頁面圖示和底線,點了就進那一頁,
 * 名字跟著那一頁走;人顯示名冊上的名字;日期今年的寫 10/14、別年的帶年份(存的是含年份的日期)。
 */
export function MentionView(props: NodeViewProps) {
  const {node, selected} = props;
  const host = useNoteHost();
  const {kind, id, label} = mentionAttrs(node.attrs);
  const page = useLinkedPage(kind === 'page' ? Number(id) : null, 'label', props);
  const date = kind === 'date' ? fromIsoDate(String(id ?? '')) : null;
  const text =
    kind === 'user' ? `@${displayNameOf(String(id)) || label}` : kind === 'page' ? noteTitle(page?.title ?? label) : date ? dateLabel(date) : label;
  return (
    <NodeViewWrapper
      as="span"
      className="note-mention"
      data-kind={kind}
      data-selected={selected ? '' : undefined}
      contentEditable={false}
      role={kind === 'page' ? 'link' : undefined}
      onClick={kind === 'page' ? () => host.openPage(Number(id)) : undefined}
    >
      {kind === 'page' ? <PageIcon icon={page?.icon} /> : null}
      {text}
    </NodeViewWrapper>
  );
}
