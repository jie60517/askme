/**
 * 左側的頁面清單。
 *
 * **外觀與操作跟主側欄的對話清單同一套**:
 *   - 同一組元件:SideNav / SideNavItem。有子頁的那一頁就像資料夾 —— 展開箭頭在最右邊、子頁左邊一條導引線;
 *     選取是同一個圓角底色;滑過的高亮是主側欄那一塊會滑動的底色(`HoverRegion`)。
 *   - 滑過一列只出現一顆「⋯」,右鍵是同一份選單(重新命名、在底下新增一頁、複製一份、圖示與顏色兩排、刪除)。
 *     選單裡沒有 ↑↓(順序用拖的);圖示與顏色只在這裡改,頁面裡不改 ——
 *     兩排直接放在選單裡,跟主側欄資料夾的右鍵**同一套元件**(`FolderIconPicker` / `ColorPicker`)。
 *   - **字是英文**(跟主側欄一樣)—— 筆記頁右邊內文那一頁仍是中文(見 frontend/.claude/CLAUDE.md 的語言例外)。
 *   - 重新命名:那一列就地變輸入框(Enter / 點別處存、Esc 取消)。
 *   - 拖曳:跟對話一樣**長按**拖(`useLongPressDrag`),拿起來的是那一列的複本。
 *     放在一列的上緣 / 下緣 = 排在它前 / 後;放在中間 = 變成它的子頁;放在清單空白處 = 搬到最上層最後面。
 * 跟對話清單只差一點:點上層頁的**標題**會打開那一頁,點右邊的**箭頭**才是開合(SideNavItem 有 href + collapsible 時本來就分開)。
 *
 * 順序固定(改內容不會跳),新的放最上面。
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {ContextMenu, ContextMenuItem} from '@astryxdesign/core/ContextMenu';
import {Divider} from '@astryxdesign/core/Divider';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Token} from '@astryxdesign/core/Token';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {MoreHorizontal} from 'lucide-react';

import {listTitle, type NoteSummary} from '../../lib/notebookApi';
import {ColorTag, fixedOrigin, HoverRegion, sideNavStyles, TITLE_INPUT_LIMIT} from '../sideNavParts';
import {colorValue, isCustomColor, NO_COLOR_KEY} from '../sidebar-colors';
import {useLongPressDrag} from '../useLongPressDrag';
import {ColorPicker} from '../ColorPicker';
import {FolderIconPicker} from '../FolderIconPicker';
import {formatIcon, iconOf, NO_ICON_KEY, NOTE_PICKER_ICONS, PageIcon, parseIcon} from './pageIcons';

// 導引線、拖曳幽靈、拖曳中變淡、改名的字數上限都跟主側欄共用(sideNavParts)
const styles = stylex.create({
  // 主側欄的 SideNav 寬度是外框給的;這裡要佔滿這一欄
  nav: {width: '100%'},
  // ⚠️ 深色時 ListItem 內建的選取色跟內容區底色同一個,改用側邊欄同一個 token
  selectedRow: {backgroundColor: 'var(--color-overlay-pressed)'},
});

export type TreeActions = {
  onToggle: (id: number) => void;
  /** 搬到 parentId 底下第 index 個(拖曳) */
  onMove?: (id: number, parentId: number | null, index: number) => void;
  onAddChild?: (parentId: number) => void;
  onDuplicate?: (id: number) => void;
  onDelete?: (id: number) => void;
  onRename?: (id: number, title: string) => void;
  /** 改圖示與顏色(`名字:顏色`;null = 拿掉) */
  onSetIcon?: (id: number, icon: string | null) => void;
};

type Where = 'before' | 'after' | 'inside';

/** 平的清單 → 每一層的子頁(照 position 排) */
export function childrenMap(rows: NoteSummary[]): Map<number | null, NoteSummary[]> {
  const ids = new Set(rows.map((r) => r.id));
  const map = new Map<number | null, NoteSummary[]>();
  for (const r of rows) {
    // 上一層不在這份清單裡(上一層被刪了):當成最上層
    const parent = r.parent_id != null && ids.has(r.parent_id) ? r.parent_id : null;
    const list = map.get(parent) ?? [];
    list.push(r);
    map.set(parent, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || b.id - a.id);
  return map;
}

/** id 是不是 ancestor 底下(含自己) */
function isWithin(children: Map<number | null, NoteSummary[]>, ancestor: number, id: number): boolean {
  if (ancestor === id) return true;
  return (children.get(ancestor) ?? []).some((c) => isWithin(children, c.id, id));
}

/** 指標落在一列的哪裡:上四分之一 = 前面、下四分之一 = 後面、中間 = 變成它的子頁 */
export function dropWhere(rect: {top: number; height: number}, y: number): Where {
  const ratio = (y - rect.top) / rect.height;
  return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
}

/** 放下的結果:搬到哪一層第幾個;放在自己(或自己底下)回 null */
export function dropMove(
  children: Map<number | null, NoteSummary[]>,
  rows: NoteSummary[],
  from: number,
  target: number | 'root',
  where: Where,
): {parent: number | null; index: number} | null {
  if (target === 'root') return {parent: null, index: (children.get(null) ?? []).filter((c) => c.id !== from).length};
  if (isWithin(children, from, target)) return null;
  if (where === 'inside') return {parent: target, index: (children.get(target) ?? []).filter((c) => c.id !== from).length};
  const row = rows.find((r) => r.id === target);
  const parent = row?.parent_id != null && rows.some((r) => r.id === row.parent_id) ? row.parent_id : null;
  const siblings = (children.get(parent) ?? []).filter((c) => c.id !== from);
  const at = siblings.findIndex((c) => c.id === target);
  return {parent, index: where === 'before' ? at : at + 1};
}

type DragPayload = {id: number; title: string};

export function NoteTree({
  rows,
  selectedId,
  expanded,
  actions,
}: {
  rows: NoteSummary[];
  selectedId: number | null;
  expanded: ReadonlySet<number>;
  actions: TreeActions;
}) {
  const children = useMemo(() => childrenMap(rows), [rows]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  /** 選單開著的那一列:滑過的高亮釘在它身上(同主側欄) */
  const [pinned, setPinned] = useState<HTMLElement | null>(null);
  /** 拖曳中指標的高度(放在一列的上 / 中 / 下,看它) */
  const pointerY = useRef(0);

  const target = useCallback(
    (el: Element | null): string | undefined => {
      const root = rootRef.current;
      if (!el || !root?.contains(el)) return undefined;
      const item = el.closest('.astryx-side-nav-item');
      const row = item?.closest<HTMLElement>('[data-note-row]');
      if (!item || !row) return 'root';
      return `${row.dataset.noteRow}:${dropWhere(item.getBoundingClientRect(), pointerY.current)}`;
    },
    [],
  );

  /** 落點高亮直接掛屬性(不走 React,同主側欄的 paintDropOver;樣式在 global.css 的 [data-note-drop]) */
  const paint = useCallback(
    (over: string | undefined, payload: DragPayload) => {
      for (const el of rootRef.current?.querySelectorAll('[data-note-drop]') ?? []) el.removeAttribute('data-note-drop');
      if (!over || over === 'root') return;
      const [id, where] = over.split(':');
      if (dropMove(children, rows, payload.id, Number(id), where as Where) === null) return;
      rootRef.current?.querySelector(`[data-note-row="${id}"] .astryx-side-nav-item`)?.setAttribute('data-note-drop', where);
    },
    [children, rows],
  );

  const {drag, onPointerDown, onClickCapture, bindGhost} = useLongPressDrag<DragPayload>({
    resolveTarget: target,
    resolveScroller: () => rootRef.current?.closest<HTMLElement>('[data-notes-scroll]') ?? null,
    resolveVisual: (el) => el?.closest<HTMLElement>('.astryx-side-nav-item') ?? null,
    onOverChange: (over, payload) => paint(over, payload),
    onDrop: (payload, over) => {
      if (!actions.onMove) return;
      const [id, where] = over === 'root' ? ['root', 'after'] : over.split(':');
      const move = dropMove(children, rows, payload.id, id === 'root' ? 'root' : Number(id), where as Where);
      if (move) actions.onMove(payload.id, move.parent, move.index);
    },
  });
  // 拖曳中記下指標高度(resolveTarget 只拿得到元素)
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      pointerY.current = e.clientY;
    };
    window.addEventListener('pointermove', onMove, true);
    return () => window.removeEventListener('pointermove', onMove, true);
  }, [drag]);

  const ghostOrigin = drag ? fixedOrigin(rootRef.current?.parentElement ?? null) : {x: 0, y: 0};

  const renderRow = (row: NoteSummary) => {
    const kids = children.get(row.id) ?? [];
    return (
      <Row
        key={row.id}
        row={row}
        isSelected={row.id === selectedId}
        isOpen={expanded.has(row.id)}
        isRenaming={renaming === row.id}
        isDragging={drag?.payload.id === row.id}
        actions={actions}
        onStartRename={() => setRenaming(row.id)}
        onEndRename={() => setRenaming(null)}
        onPin={setPinned}
        dragHandlers={
          actions.onMove ? {onPointerDown: onPointerDown({id: row.id, title: listTitle(row.title)}), onClickCapture} : undefined
        }
      >
        {kids.length ? (
          <VStack gap={0.5} xstyle={sideNavStyles.nestGuide}>
            {kids.map((k) => renderRow(k))}
          </VStack>
        ) : undefined}
      </Row>
    );
  };

  return (
    <Stack ref={rootRef}>
      <HoverRegion isSuppressed={!!drag} pinnedRow={pinned}>
        <SideNav aria-label="Notes" xstyle={styles.nav}>
          <SideNavSection title="My notes" isHeaderHidden>
            <VStack gap={0.5}>{(children.get(null) ?? []).map((r) => renderRow(r))}</VStack>
          </SideNavSection>
        </SideNav>
      </HoverRegion>
      {drag ? (
        <Stack
          aria-hidden
          xstyle={sideNavStyles.dragGhost}
          width={drag.width || undefined}
          data-drag-ghost=""
          ref={(node: HTMLElement | null) => {
            // 位置由長按拖曳那支直接寫(不走 React),見主側欄的同一段
            bindGhost(node, ghostOrigin);
            if (!node || !drag.visual) return;
            if (node.firstChild === drag.visual) return;
            drag.visual.setAttribute('data-pinned', '');
            node.replaceChildren(drag.visual);
          }}
        >
          {drag.visual ? null : <Token label={drag.payload.title} />}
        </Stack>
      ) : null}
    </Stack>
  );
}

function Row({
  row,
  isSelected,
  isOpen,
  isRenaming,
  isDragging,
  actions,
  onStartRename,
  onEndRename,
  onPin,
  dragHandlers,
  children,
}: {
  row: NoteSummary;
  isSelected: boolean;
  isOpen: boolean;
  isRenaming: boolean;
  isDragging: boolean;
  actions: TreeActions;
  onStartRename: () => void;
  onEndRename: () => void;
  onPin: (el: HTMLElement | null) => void;
  dragHandlers?: {onPointerDown: (e: React.PointerEvent) => void; onClickCapture: (e: React.MouseEvent) => void};
  children?: React.ReactNode;
}) {
  const title = listTitle(row.title);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  /** 選單關掉就 +1:兩排挑選器重新掛,展開的格子歸零(同主側欄的 pickerNonce) */
  const [pickerNonce, setPickerNonce] = useState(0);
  /**
   * 圖示與顏色那兩排**碰過這一列才長出來**:Astryx 的 ContextMenu 不管開沒開都會把選單內容畫出來,
   * 每列常駐兩排挑選器就是每列多十幾顆鈕(主側欄資料夾同一招,`Sidebar.tsx` 的 `menuReady` 是正本)。
   * 三個入口都要備好:滑鼠移上來、鍵盤焦點、觸控長按(pointerdown)。
   */
  const [menuReady, setMenuReady] = useState(false);
  const hasMenu = !!actions.onDelete;
  const showMenu = hasMenu && (isHovered || isMenuOpen);

  const pin = (open: boolean) => onPin(open ? (wrapRef.current?.querySelector<HTMLElement>('.astryx-side-nav-item') ?? null) : null);
  const pinWhenOpen = (open: boolean) => {
    // 釘住高亮塊:指標移到選單上時這一列的 mouseleave 會發生,不釘的話「我按的是哪一列」正好在那一刻消失
    setIsMenuOpen(open);
    pin(open);
    if (!open) setPickerNonce((n) => n + 1);
  };
  // 改名時那一列換成輸入框,滑鼠離開的事件不會來:結束時自己清掉「滑過」,不然「⋯」會一直掛著
  const endRename = () => {
    setIsHovered(false);
    onEndRename();
  };
  const commitRename = (draft: string) => {
    const next = draft.trim();
    endRename();
    // 空的不存(同主側欄):清空再點別處,當作沒改
    if (next && next !== row.title) actions.onRename?.(row.id, next);
  };

  const menuContent = hasMenu ? (
    <VStack gap={0.5} {...{'data-menu-flush': ''}}>
      <ContextMenuItem label="Rename" onClick={onStartRename} />
      <ContextMenuItem label="Add page inside" onClick={() => actions.onAddChild?.(row.id)} />
      <ContextMenuItem label="Duplicate" onClick={() => actions.onDuplicate?.(row.id)} />
      {actions.onSetIcon && menuReady ? (
        <NoteAppearancePickers nonce={pickerNonce} value={row.icon} onChange={(next) => actions.onSetIcon?.(row.id, next)} />
      ) : null}
      <Divider />
      <ContextMenuItem label="Delete" variant="destructive" onClick={() => actions.onDelete?.(row.id)} />
    </VStack>
  ) : null;

  if (isRenaming) return <RenameInput initial={row.title} onCommit={commitRename} onCancel={endRename} />;

  const item = (
    <SideNavItem
      href={`/notes/${row.id}`}
      label={title}
      icon={<PageIcon icon={row.icon} />}
      isSelected={isSelected}
      collapsible={children ? {isCollapsed: !isOpen, onCollapsedChange: () => actions.onToggle(row.id)} : undefined}
      endContent={
        // 這一區在連結裡面:不擋的話按 ⋯ 會連帶把整列的連結一起觸發(同主側欄)
        <HStack
          gap={1}
          vAlign="center"
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {/* 顏色記號:列最右邊那顆點,跟主側欄的對話列一樣排在「⋯」前面(它一直在,「⋯」來來去去) */}
          <NoteColorTag icon={row.icon} />
          {showMenu ? (
            <DropdownMenu
              button={{label: `More actions for "${title}"`, icon: <Icon icon={MoreHorizontal} size="xsm" />, variant: 'ghost', size: 'sm', isIconOnly: true}}
              hasChevron={false}
              onOpenChange={pinWhenOpen}
            >
              {menuContent}
            </DropdownMenu>
          ) : null}
        </HStack>
      }
    >
      {children}
    </SideNavItem>
  );

  return (
    <Stack
      ref={wrapRef}
      data-note-row={row.id}
      xstyle={isDragging ? sideNavStyles.rowDragging : undefined}
      onMouseEnter={() => {
        setIsHovered(true);
        setMenuReady(true);
      }}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => {
        setIsHovered(true);
        setMenuReady(true);
      }}
      onPointerDownCapture={() => setMenuReady(true)}
      onBlur={(e: React.FocusEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsHovered(false);
      }}
      // 拖曳時不要讓瀏覽器自己的拖放把連結拖走
      onDragStart={(e: React.DragEvent) => e.preventDefault()}
      {...dragHandlers}
    >
      {hasMenu ? (
        <ContextMenu menuContent={menuContent} label={`Actions for "${title}"`} onOpenChange={pinWhenOpen}>
          {item}
        </ContextMenu>
      ) : (
        item
      )}
    </Stack>
  );
}

/** 選了顏色就在列最右邊畫一顆點(主側欄對話列的 ColorTag);沒選不畫 */
function NoteColorTag({icon}: {icon: string | null | undefined}) {
  const {color} = parseIcon(icon);
  return color ? <ColorTag color={colorValue(color)} /> : null;
}

/**
 * 右鍵選單裡的圖示、顏色兩排 —— 跟主側欄資料夾右鍵的 `AppearancePickers` 同一套元件:
 * 圖示換成筆記的(pageIcons.tsx 的 `NOTE_PICKER_ICONS`),顏色直接用 ColorPicker 的預設(主側欄那組 19 色 + 調色盤)。
 * 存的格式:`名字:顏色 key`(見 pageIcons.tsx 的 `parseIcon`)。
 */
function NoteAppearancePickers({
  nonce,
  value,
  onChange,
}: {
  nonce: number;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const {name, color} = parseIcon(value);
  // 不在圖示表裡的值(例如 emoji)當作沒選(同 PageIcon)
  const icon = name && iconOf(value) ? name : null;
  /*
   * 「文件」那一格就是**沒有圖示**:它本來就是沒選時畫的預設頁面圖示,沒選過的筆記也圈在這一格。
   * 主側欄的挑選器沒有「無」這一格,所以選它就存 null,圖示的部分回到沒選(不然選過圖示就回不去了)。
   */
  const toStored = (key: string) => (key === NO_ICON_KEY ? null : key);
  /*
   * 調色盤(自訂色)是拖著挑的:系統選色器在拖曳中會一直發 onChange。主側欄存在本機無所謂,
   * 筆記是存到伺服器的 —— 每動一下就存一次會連發一串 PUT(還可能互相撞版本)。
   * 所以自訂色等手停 400ms 才存,挑選器被收掉時(選單關掉)把最後一個存下去。
   * ⚠️ 兩件事:
   *  - 等著存的那段時間,調色盤先顯示剛挑的顏色(`shownColor`):它是受控的 `<input type="color">`,
   *    值沒跟上的話一重畫就被拉回舊色,拖曳會跳。
   *  - 存的一律是**最新的**圖示 + 顏色(`latest`),不是挑的那一刻抓住的值:
   *    等著存的時候又點了圖示,不能被舊圖示蓋回去。
   */
  const [shownColor, setShownColor] = useState<string | null>(null);
  const latest = useRef({icon, color});
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 新的值存好回來了:以它為準(等著存的那筆除外 —— 那筆比它新)
  useEffect(() => {
    if (pending.current) return;
    latest.current = {icon, color};
    setShownColor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const save = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    onChangeRef.current(formatIcon(latest.current.icon, latest.current.color));
  };
  useEffect(
    () => () => {
      if (pending.current) save();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const pickIcon = (key: string) => {
    latest.current = {...latest.current, icon: toStored(key)};
    save();
  };
  const pickColor = (key: string) => {
    latest.current = {...latest.current, color: key === NO_COLOR_KEY ? null : key};
    if (!isCustomColor(key)) {
      save();
      return;
    }
    setShownColor(key);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(save, 400);
  };
  return (
    <>
      <FolderIconPicker key={`icon-${nonce}`} icons={NOTE_PICKER_ICONS} value={icon ?? NO_ICON_KEY} onPick={pickIcon} />
      <ColorPicker key={`color-${nonce}`} value={shownColor ?? color ?? NO_COLOR_KEY} onPick={pickColor} />
    </>
  );
}

/**
 * 搜尋結果(平的清單,每列多一行摘要)。右鍵跟頁面樹同一份裡能用的那幾項:
 * Duplicate、圖示與顏色兩排、Delete(改名、在底下新增要看得到樹,搜尋結果裡不放)。
 * 整份清單共用一個右鍵選單:右鍵時記下是哪一列(每列各掛一份的話 List 裡會多一層包裝)。
 */
export function NoteSearchList({
  rows,
  selectedId,
  onOpen,
  actions,
}: {
  rows: NoteSummary[];
  selectedId: number | null;
  onOpen: (id: number) => void;
  actions: TreeActions;
}) {
  const [menuRow, setMenuRow] = useState<NoteSummary | null>(null);
  /** 選單關掉就 +1:兩排挑選器重新掛,展開的格子歸零 */
  const [pickerNonce, setPickerNonce] = useState(0);
  /** 右鍵按在哪一列:記下來 */
  const pickRow = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-search-row]');
    const row = el ? rows.find((r) => String(r.id) === el.dataset.searchRow) : undefined;
    setMenuRow(row ?? null);
  };
  const menuContent = menuRow ? (
    <VStack gap={0.5} {...{'data-menu-flush': ''}}>
      <ContextMenuItem label="Duplicate" onClick={() => actions.onDuplicate?.(menuRow.id)} />
      {actions.onSetIcon ? (
        <NoteAppearancePickers
          nonce={pickerNonce}
          value={rows.find((r) => r.id === menuRow.id)?.icon ?? null}
          onChange={(next) => actions.onSetIcon?.(menuRow.id, next)}
        />
      ) : null}
      <Divider />
      <ContextMenuItem label="Delete" variant="destructive" onClick={() => actions.onDelete?.(menuRow.id)} />
    </VStack>
  ) : null;
  return (
    <Stack onContextMenuCapture={pickRow}>
      <ContextMenu
        menuContent={menuContent}
        label={menuRow ? `Actions for "${listTitle(menuRow.title)}"` : 'Actions'}
        onOpenChange={(open) => {
          if (!open) setPickerNonce((n) => n + 1);
        }}
      >
        <List density="compact" header={<VisuallyHidden>Search results</VisuallyHidden>}>
          {rows.map((n) => (
            <ListItem
              key={n.id}
              data-search-row={n.id}
              label={listTitle(n.title)}
              description={n.summary || undefined}
              startContent={<PageIcon icon={n.icon} />}
              endContent={<NoteColorTag icon={n.icon} />}
              isSelected={n.id === selectedId}
              xstyle={n.id === selectedId ? styles.selectedRow : undefined}
              onClick={() => onOpen(n.id)}
            />
          ))}
        </List>
      </ContextMenu>
    </Stack>
  );
}

/**
 * 改名的輸入框。**每次開始改名才掛上**,草稿從那一刻的標題開始(頁面裡剛改過的名字也拿得到;
 * 草稿若住在列上、只在列第一次出現時取一次值,改名會存回舊的或空的)。
 * Enter / 點別處存、Esc 取消(Esc 不能靠 blur 收尾:blur 會存,見主側欄同一段的說明)。
 */
function RenameInput({initial, onCommit, onCancel}: {initial: string; onCommit: (draft: string) => void; onCancel: () => void}) {
  const [draft, setDraft] = useState(initial);
  return (
    <TextInput
      label="Page name"
      isLabelHidden
      value={draft}
      onChange={setDraft}
      {...TITLE_INPUT_LIMIT}
      hasAutoFocus
      onBlur={() => onCommit(draft)}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter') onCommit(draft);
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}
