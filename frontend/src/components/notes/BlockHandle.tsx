/**
 * 區塊把手:滑過每一段,左邊出現 ＋ 與 ⋮⋮。
 *   - ＋:在這一段下面加一行,並打開「/」選單(Notion 一樣)。
 *   - ⋮⋮:按住拖曳搬動;點一下(沒拖)出區塊選單(轉換成、複製一份、刪除)。
 *     拖曳是自己追蹤游標(pointer 事件),**不用瀏覽器原生的拖放**:原生的只有游標在編輯區裡面才放得下,
 *     按住 ⋮⋮ 直接往上拉(游標還在左邊那一欄)會完全不動。
 *     這裡只看游標的上下位置:落在哪一塊的上半 / 下半 = 放在它前面 / 後面,中間一條線標出落點;靠近上下邊緣自動捲動。
 * 清單裡的每一項自己算一塊(跟 Notion 一樣可以單獨拖一項),其他都是最上層那一塊。
 *
 * 不用 Tiptap 官方的 drag-handle:它要整套協作套件(yjs)才跑得起來,而且那個擴充的把手
 * 是一顆、清單項目不算一塊,跟 Notion 不一樣。
 * 觸控螢幕不出(手機上 Notion 也沒有這兩顆)。
 */
import {useCallback, useEffect, useRef, useState, type RefObject} from 'react';
import * as stylex from '@stylexjs/stylex';

import {DropdownMenu, DropdownMenuDivider, DropdownMenuItem, DropdownMenuSubMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack} from '@astryxdesign/core/Layout';
import type {Editor} from '@tiptap/core';
import {TextSelection} from '@tiptap/pm/state';
import type {Node as PMNode} from '@tiptap/pm/model';
import {Copy, GripVertical, Plus, Repeat2, Trash2} from 'lucide-react';

import {dragSourcePos, duplicateBlock, setDragSource, turnInto} from './noteExtensions';
import {TURN_INTO} from './slashCommand';

/** 把手那一排離內文左邊多遠(兩顆 sm 鈕 + 間距);項目 / 編號清單再往左讓出項目符號的位置(待辦的勾選框在項目裡面,不用讓) */
const HANDLE_WIDTH = 56;
const LIST_MARKER = 24;
/** 一顆 sm 鈕的高度:把手要跟那一塊的**第一行字**置中(不然提示框、表格的把手會貼在框的上緣) */
const BUTTON_HEIGHT = 28;

/** 按下去之後移動超過這麼多才算「拖」,不然是點一下(開選單) */
const DRAG_THRESHOLD = 4;
/** 游標離捲動區上下邊緣這麼近就自動捲 */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 14;

const styles = stylex.create({
  bar: {position: 'absolute', zIndex: 1},
  grip: {cursor: 'grab'},
  // 落點的那條線(Notion 是一條藍線)
  dropLine: {
    position: 'absolute',
    zIndex: 1,
    height: 'calc(var(--border-width) * 2)',
    borderRadius: 'var(--radius-full)',
    backgroundColor: 'var(--color-accent)',
    pointerEvents: 'none',
  },
});

type Hit = {pos: number; top: number; left: number};
type Drop = {pos: number; after: boolean};
type DropLine = {top: number; left: number; width: number};

const isItem = (n: PMNode | null | undefined) => !!n && (n.type.name === 'listItem' || n.type.name === 'taskItem');

/**
 * 把 from 那一塊搬到 target 那一塊的前面 / 後面(一個 transaction,復原一次就回來)。
 *   - 清單項目搬到同一種清單的項目旁邊:直接插進去;搬到別種清單(項目 ↔ 待辦):換成那一種項目。
 *   - 清單項目搬到清單外面:包一層它原本的清單。
 *   - 一般區塊搬到清單項目旁邊:放到那整個清單的前面 / 後面。
 *   - 清單裡只剩它一項:連那個清單一起拿走(不然留下一個空清單)。
 */
export function moveBlock(editor: Editor, from: number, drop: Drop): boolean {
  const {state} = editor;
  const node = state.doc.nodeAt(from);
  const target = state.doc.nodeAt(drop.pos);
  if (!node || !target) return false;
  if (drop.pos >= from && drop.pos < from + node.nodeSize) return false; // 放在自己身上 / 自己裡面

  let content: PMNode = node;
  let insertAt = drop.after ? drop.pos + target.nodeSize : drop.pos;
  if (isItem(node)) {
    if (isItem(target)) {
      if (target.type !== node.type) content = target.type.create(target.type.name === 'taskItem' ? {checked: false} : null, node.content);
    } else {
      const list = state.doc.resolve(from).parent;
      content = list.type.create(list.attrs, node);
    }
  } else if (isItem(target)) {
    const $t = state.doc.resolve(drop.pos);
    const listPos = $t.before($t.depth);
    insertAt = drop.after ? listPos + $t.parent.nodeSize : listPos;
  }

  // 要拿掉的範圍:清單裡只剩它一項 → 整個清單
  let delFrom = from;
  let delTo = from + node.nodeSize;
  if (isItem(node)) {
    const $f = state.doc.resolve(from);
    if ($f.parent.childCount === 1) {
      delFrom = $f.before($f.depth);
      delTo = delFrom + $f.parent.nodeSize;
    }
  }
  if (insertAt > delFrom && insertAt < delTo) return false;

  const tr = state.tr.delete(delFrom, delTo);
  const at = tr.mapping.map(insertAt, drop.after ? 1 : -1);
  tr.insert(at, content);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** 編輯器外面那一層會捲的(筆記頁的內容欄) */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** 滑鼠下面那一塊的開頭位置:清單項目自己算一塊,其他是最上層那一塊 */
export function blockAt(editor: Editor, x: number, y: number): number | null {
  const {view} = editor;
  const coords = view.posAtCoords({left: x, top: y});
  if (!coords) return null;
  const {doc} = view.state;
  if (coords.inside >= 0 && doc.resolve(coords.inside).depth === 0) return coords.inside;
  const $pos = doc.resolve(coords.pos);
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'listItem' || name === 'taskItem') return $pos.before(d);
  }
  return $pos.depth >= 1 ? $pos.before(1) : null;
}

/**
 * 這一塊「第一行」的位置與高度,把手跟它置中。
 *   - 有字的:第一個字的座標(段落、標題、清單、提示框、表格…)。
 *   - 沒有字、但裡面有段落的(空行、空的清單 / 待辦項目):那個段落的上緣 + 它的行高。
 *   - 整塊的(子頁連結、分隔線、圖片、資料庫):矮的(兩顆鈕以內)整塊置中,高的對齊上緣。
 */
function firstLine(editor: Editor, pos: number, dom: HTMLElement): {top: number; height: number} {
  const rect = dom.getBoundingClientRect();
  const node = editor.state.doc.nodeAt(pos);
  if (node && !node.isAtom && node.textContent) {
    try {
      let first: number | null = null;
      node.descendants((child, offset) => {
        if (first !== null) return false;
        if (child.isText) first = pos + 1 + offset;
        return first === null;
      });
      const c = editor.view.coordsAtPos(first ?? pos + 1);
      return {top: c.top, height: c.bottom - c.top};
    } catch {
      // 座標算不出來(還沒畫好):往下走
    }
  }
  const block = node?.isTextblock ? dom : dom.querySelector<HTMLElement>('p, h1, h2, h3, h4, li > div > p');
  if (block) {
    const lh = parseFloat(getComputedStyle(block).lineHeight);
    const r = block.getBoundingClientRect();
    return {top: r.top, height: Number.isFinite(lh) ? lh : r.height};
  }
  if (rect.height <= BUTTON_HEIGHT * 2) return {top: rect.top, height: rect.height};
  return {top: rect.top, height: BUTTON_HEIGHT};
}

export function BlockHandle({editor, container}: {editor: Editor; container: RefObject<HTMLElement | null>}) {
  const [hit, setHit] = useState<Hit | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  /** 拖曳中:onMove 不要換把手的位置、滑出編輯區 / 打字也不要收起來 */
  const draggingRef = useRef(false);
  /** 拖到一半元件被卸載(換頁):收掉視窗上的監聽與捲動計時器 */
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const hideTimer = useRef<number | null>(null);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;

  const cancelHide = () => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hideSoon = useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      // 拖到頂端時游標會離開這一區:拖曳中不收(不然把手跟落點線一起不見,拖曳還在進行)
      if (!menuOpenRef.current && !draggingRef.current) setHit(null);
    }, 300);
  }, []);

  useEffect(() => {
    const root = container.current;
    if (!root || window.matchMedia('(pointer: coarse)').matches) return;
    const onMove = (e: MouseEvent) => {
      if (menuOpenRef.current || draggingRef.current) return;
      const content = editor.view.dom.getBoundingClientRect();
      if (e.clientY < content.top || e.clientY > content.bottom) return;
      // 滑鼠在左邊把手那一欄也算(往把手移的路上不要消失):x 夾進內文裡面去找
      const x = Math.min(Math.max(e.clientX, content.left + 4), content.right - 4);
      const pos = blockAt(editor, x, e.clientY);
      if (pos == null) return;
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
      if (!dom || !(dom instanceof HTMLElement)) return;
      const box = root.getBoundingClientRect();
      const rect = dom.getBoundingClientRect();
      const hasMarker = dom.tagName === 'LI' && dom.parentElement?.dataset.type !== 'taskList';
      const line = firstLine(editor, pos, dom);
      cancelHide();
      setHit({
        pos,
        top: line.top - box.top + (line.height - BUTTON_HEIGHT) / 2,
        left: rect.left - box.left - HANDLE_WIDTH - (hasMarker ? LIST_MARKER : 0),
      });
    };
    // 開始打字就收起來(Notion 也是),滑鼠再動才出來
    const onKey = () => {
      if (!menuOpenRef.current && !draggingRef.current) setHit(null);
    };
    root.addEventListener('mousemove', onMove);
    root.addEventListener('mouseleave', hideSoon);
    editor.view.dom.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('mouseleave', hideSoon);
      editor.view.dom.removeEventListener('keydown', onKey);
      cancelHide();
    };
  }, [editor, container, hideSoon]);

  const line = dropLine ? <Stack xstyle={styles.dropLine} style={{top: dropLine.top, left: dropLine.left, width: dropLine.width}} /> : null;
  if (!hit) return line;
  const node = editor.state.doc.nodeAt(hit.pos);
  if (!node) return line;
  const from = hit.pos;

  /** ＋:下面加一行(清單裡就加一項),打開「/」選單 */
  const addBelow = () => {
    const end = hit.pos + node.nodeSize;
    const isItem = node.type.name === 'listItem' || node.type.name === 'taskItem';
    const content = isItem ? {type: node.type.name, content: [{type: 'paragraph'}]} : {type: 'paragraph'};
    editor
      .chain()
      .insertContentAt(end, content)
      .focus(end + (isItem ? 2 : 1))
      .insertContent('/')
      .run();
    setHit(null);
  };

  /**
   * 按住 ⋮⋮:移動超過 DRAG_THRESHOLD 才開始拖(不然放開時是點一下,照常開選單)。
   * 拖的時候只看游標的上下位置找落點(左右夾進內文裡),所以沿著左邊那一欄直接往上 / 往下拉也行。
   */
  const onGripPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const root = container.current;
    const sourceDom = editor.view.nodeDOM(from);
    if (!root || !(sourceDom instanceof HTMLElement)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let lastY = startY;
    let drop: Drop | null = null;
    const scroller = scrollParent(editor.view.dom);

    /** 被拖的那一塊「現在」的位置:拖的途中內容變了(例如圖片載入完成),位置會移(DragSource 外掛幫忙對照) */
    const source = () => dragSourcePos(editor) ?? from;
    const findDrop = () => {
      const content = editor.view.dom.getBoundingClientRect();
      const y = Math.min(Math.max(lastY, content.top + 1), content.bottom - 1);
      const x = content.left + Math.min(40, content.width / 2);
      let pos = blockAt(editor, x, y);
      const src = source();
      const srcNode = editor.state.doc.nodeAt(src);
      // 一般區塊落在清單項目上:放的是整個清單的前 / 後,線也畫在清單的邊上(不要畫在兩個項目中間)
      if (pos != null && srcNode && !isItem(srcNode) && isItem(editor.state.doc.nodeAt(pos))) {
        const $p = editor.state.doc.resolve(pos);
        pos = $p.before($p.depth);
      }
      const dom = pos == null ? null : editor.view.nodeDOM(pos);
      if (pos == null || !srcNode || !(dom instanceof HTMLElement) || (pos >= src && pos < src + srcNode.nodeSize)) {
        drop = null;
        setDropLine(null);
        return;
      }
      const r = dom.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      const marker = dom.tagName === 'LI' && dom.parentElement?.dataset.type !== 'taskList' ? LIST_MARKER : 0;
      drop = {pos, after};
      setDropLine({top: (after ? r.bottom : r.top) - box.top - 1, left: r.left - box.left - marker, width: r.width + marker});
    };

    // 游標停在邊緣也要一直捲:用計時器,不是只在 pointermove 時捲
    const scrollTimer = window.setInterval(() => {
      if (!active || !scroller) return;
      const r = scroller.getBoundingClientRect();
      if (lastY < r.top + SCROLL_EDGE) scroller.scrollTop -= SCROLL_STEP;
      else if (lastY > r.bottom - SCROLL_EDGE) scroller.scrollTop += SCROLL_STEP;
      else return;
      findDrop();
    }, 16);

    const onPointerMove = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (!active) {
        if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
        active = true;
        draggingRef.current = true;
        setDragSource(editor, from);
        document.body.style.cursor = 'grabbing';
      }
      ev.preventDefault();
      findDrop();
    };
    /** 收掉監聽、計時器、拖曳的樣子(放開、取消、元件卸載都走這裡) */
    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.clearInterval(scrollTimer);
      dragCleanup.current = null;
      if (!active) return;
      if (!editor.isDestroyed) setDragSource(editor, null);
      document.body.style.cursor = '';
      draggingRef.current = false;
    };
    const finish = (ev: PointerEvent) => {
      const wasActive = active;
      // 放開那一刻用最新的內容再找一次落點、拿最新的來源位置(拖的途中別人可能改了內容)
      if (wasActive && ev.type === 'pointerup' && !editor.isDestroyed) findDrop();
      const src = source();
      cleanup();
      if (!wasActive) return; // 沒拖:是點一下,讓選單照常打開
      setDropLine(null);
      setHit(null);
      if (ev.type !== 'pointerup') return;
      // 這一下放開不要變成「點一下」把選單打開。click 跟在 pointerup 後面同一輪送出;
      // 下一輪還沒用掉就拿掉(放開在視窗外、沒有 click 的時候),不然會吃掉使用者下一次點擊
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener('click', swallow, {capture: true, once: true});
      window.setTimeout(() => window.removeEventListener('click', swallow, {capture: true}), 0);
      // 來源已經不是當初那一塊(被刪掉、換成別的):不搬
      const srcNode = editor.state.doc.nodeAt(src);
      if (drop && srcNode && srcNode.type === node.type) moveBlock(editor, src, drop);
    };
    dragCleanup.current = cleanup;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  /** 區塊選單的「轉換成」:游標先放進那一塊再轉 */
  const turn = (kind: (typeof TURN_INTO)[number]['kind']) => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(hit.pos + 1))));
    turnInto(editor, kind);
  };

  return (
    <>
      {line}
      <Stack xstyle={styles.bar} style={{top: hit.top, left: hit.left}} onMouseEnter={cancelHide}>
        <HStack gap={0} vAlign="center">
          <IconButton
            label="在下面加一行"
            size="sm"
            variant="ghost"
            icon={<Icon icon={Plus} size="sm" color="secondary" />}
            onClick={addBelow}
          />
          <Stack xstyle={styles.grip} onPointerDown={onGripPointerDown}>
            <DropdownMenu
              button={{
                label: '拖曳搬動,或點一下開選單',
                icon: <Icon icon={GripVertical} size="sm" color="secondary" />,
                isIconOnly: true,
                variant: 'ghost',
                size: 'sm',
              }}
              hasChevron={false}
              isMenuOpen={menuOpen}
              onOpenChange={(open) => {
                setMenuOpen(open);
                if (!open) hideSoon();
              }}
              menuWidth={200}
            >
              {/* 照 Notion 的順序:常用的動作在上面,「轉換成」是子選單(11 種轉換排在最上面的話,刪除會被擠到要捲才看得到)。
                  用元件寫而不是 items 陣列:子選單要掛 menuDataTestId,才能用 note-editor.css 把 Astryx 寫死的 300px 高度放寬,
                  11 種一次看完 */}
              <DropdownMenuItem label="複製一份" icon={<Icon icon={Copy} size="sm" />} onClick={() => void duplicateBlock(editor, hit.pos)} />
              <DropdownMenuSubMenu label="轉換成" icon={<Icon icon={Repeat2} size="sm" />} menuDataTestId="note-turn-into">
                {TURN_INTO.map((t) => (
                  <DropdownMenuItem key={t.kind} label={t.label} icon={<Icon icon={t.icon} size="sm" />} onClick={() => turn(t.kind)} />
                ))}
              </DropdownMenuSubMenu>
              <DropdownMenuDivider />
              <DropdownMenuItem
                label="刪除"
                variant="destructive"
                icon={<Icon icon={Trash2} size="sm" />}
                onClick={() => {
                  editor
                    .chain()
                    .focus()
                    .deleteRange({from: hit.pos, to: hit.pos + node.nodeSize})
                    .run();
                  setHit(null);
                }}
              />
            </DropdownMenu>
          </Stack>
        </HStack>
      </Stack>
    </>
  );
}
