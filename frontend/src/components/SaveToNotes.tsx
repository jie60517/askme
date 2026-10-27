/**
 * 對話裡「存到筆記」的三個入口:
 *
 *   - 回答下面那排的書籤鈕(`SaveAnswerMenu`):`Question and answer` / `Screenshot`;
 *   - 反白一段之後浮出來的 `Save to notes`(`SelectionSaveButton`);
 *   - 存的動作本身與「這組對話哪幾題存過」(`useSaveToNotes`)。
 *
 * `Screenshot`:直接抓這個分頁的畫面 → 框選範圍(`RegionPicker`)→ 按 ✓ 才存。
 * 瀏覽器不支援(手機、非 https、Firefox / Safari)才退回「截整則回答」(`lib/answerShot.ts`)。
 *
 * 三種都是直接新增一則、不跳對話框,右下 toast `Saved to notes.` + `Open`;存過的那題書籤鈕變實心。
 * 對話頁的字照全站慣例是英文;筆記頁本身才是中文。
 *
 * 抽成自己的檔案:`pages/Chat.tsx` 很大,而且元件測試不能 import 它(見 frontend/.claude/CLAUDE.md)。
 */
import {useCallback, useEffect, useRef, useState, type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {useNavigate} from 'react-router-dom';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {Stack} from '@astryxdesign/core/Layout';
import {Bookmark, BookmarkPlus, Image as ImageIcon, MessageSquareText} from 'lucide-react';

import {RegionPicker} from './RegionPicker';
import {portalHost} from '../lib/portalHost';
import {canGrabTab, cropToBlob, frameUrl, grabTabFrame, type Rect} from '../lib/regionShot';
import {
  qaIdFromAnchor,
  saveQaToNotes,
  saveScreenshotToNotes,
  saveSelectionToNotes,
  saveErrorMessage,
  savedQaIds,
  type Note,
  type NoteKind,
} from '../lib/notebookApi';
import {toastError, toastWithAction} from '../lib/toast';

/** 三種存法就是筆記的三種來源(`NoteKind`),不另外定義一份 */
export type SaveKind = NoteKind;

/** 截圖要截的那一塊:`Chat.tsx` 的 `Turn` 把回答內容包在掛著這個屬性的那一層 */
export const ANSWER_SHOT_ATTR = 'data-answer-shot';

const styles = stylex.create({
  // 數字見 global.css 的層級表(42)
  // 字體與字色自己帶:平常掛在佈景層裡會繼承到,但 portalHost 找不到佈景層時退回 body,
  // 那裡沒有(會變成 Times New Roman)
  floating: {position: 'fixed', zIndex: 42, fontFamily: 'var(--font-family-body)', color: 'var(--color-text-primary)'},
});

/** 框選中:剛抓的那一格與它是哪一題的 */
type PendingShot = {qaId: number; image: HTMLCanvasElement; url: string};

/**
 * 這組對話的「存到筆記」:存過哪幾題 + 存的動作 + 截圖時的框選那一層(`overlay`,頁面要畫出來)。
 * `save` 的參照穩定(傳給 memo 過的 `Turn`)。
 */
export function useSaveToNotes(conversationId: string | undefined) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState<ReadonlySet<number>>(new Set());
  const [pick, setPick] = useState<PendingShot | null>(null);
  const busy = useRef(new Set<string>());

  /** 存好了:書籤變實心、右下 toast + Open */
  const done = useCallback(
    (qaId: number, note: Note) => {
      setSaved((set) => new Set(set).add(qaId));
      const id = note.id;
      toastWithAction(
        'Saved to notes.',
        {label: 'Open', onClick: () => navigate(`/notes/${id}`)},
        `saved-to-notes-${id}`,
      );
    },
    [navigate],
  );

  const closePick = useCallback(() => setPick(null), []);
  // 那一格的網址:換掉、收掉、或整頁卸載(換對話、離開對話頁)時放掉
  useEffect(() => {
    if (!pick) return;
    return () => URL.revokeObjectURL(pick.url);
  }, [pick]);

  useEffect(() => {
    setSaved(new Set());
    if (!conversationId) return;
    let alive = true;
    savedQaIds(conversationId).then(
      (ids) => {
        if (alive) setSaved(new Set(ids));
      },
      () => {
        // 加值功能(書籤實心),讀不到就當沒存過,不報錯
      },
    );
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const save = useCallback(
    async (qaId: number, kind: SaveKind, text?: string) => {
      const key = `${qaId}:${kind}:${text ?? ''}`;
      if (busy.current.has(key)) return; // 連點
      busy.current.add(key);
      try {
        let note;
        if (kind === 'qa') note = await saveQaToNotes(qaId);
        else if (kind === 'selection') note = await saveSelectionToNotes(qaId, text ?? '');
        else {
          // 抓畫面(Chrome 會問一次允許)→ 框選那一層接手;按了取消(null)就什麼都不做
          const image = canGrabTab() ? await grabTabFrame().catch(() => undefined) : undefined;
          if (image === null) return;
          if (image) {
            setPick({qaId, image, url: await frameUrl(image)});
            return;
          }
          // 不支援、或抓的時候出錯(不是使用者按取消):退回截整則回答
          const el = document.querySelector<HTMLElement>(`[${ANSWER_SHOT_ATTR}="${qaId}"]`);
          if (!el) throw new Error('answer not on screen');
          // 按下去才載入截圖套件:對話頁是進站第一眼,不該為一個少用的動作多下載一包
          const {captureElement} = await import('../lib/answerShot');
          note = await saveScreenshotToNotes(qaId, await captureElement(el));
        }
        done(qaId, note);
      } catch (err) {
        toastError(saveErrorMessage(err));
      } finally {
        busy.current.delete(key);
      }
    },
    [done],
  );

  /** 框選那一層按了 ✓:裁、存;不管成敗都收掉這一層(失敗跳 toast) */
  const confirmPick = useCallback(
    async (rect: Rect) => {
      if (!pick) return;
      try {
        done(pick.qaId, await saveScreenshotToNotes(pick.qaId, await cropToBlob(pick.image, rect)));
      } catch (err) {
        toastError(saveErrorMessage(err));
      } finally {
        closePick();
      }
    },
    [closePick, done, pick],
  );

  const overlay = pick ? (
    <RegionPicker image={pick.image} imageUrl={pick.url} onConfirm={confirmPick} onCancel={closePick} />
  ) : null;

  return {saved, save, overlay};
}

/** 回答下面那排的書籤鈕。存過就是實心 */
export function SaveAnswerMenu({
  qaId,
  isSaved,
  onSave,
}: {
  qaId: number;
  isSaved: boolean;
  onSave: (qaId: number, kind: SaveKind) => void;
}) {
  return (
    <DropdownMenu
      button={{
        label: isSaved ? 'Saved to notes' : 'Save to notes',
        icon: <Icon icon={isSaved ? Bookmark : BookmarkPlus} size="sm" fill={isSaved ? 'currentColor' : 'none'} />,
        isIconOnly: true,
        variant: 'ghost',
        size: 'sm',
      }}
      hasChevron={false}
      menuWidth={220}
      items={[
        {
          label: 'Question and answer',
          icon: <Icon icon={MessageSquareText} size="sm" />,
          onClick: () => onSave(qaId, 'qa'),
        },
        {label: 'Screenshot', icon: <Icon icon={ImageIcon} size="sm" />, onClick: () => onSave(qaId, 'screenshot')},
      ]}
    />
  );
}

type Spot = {top: number; left: number; qaId: number; text: string};

/** 浮動鈕大約多寬(定位用:不要超出視窗右緣) */
const BUTTON_WIDTH = 140;
/** 浮在選取範圍上面多高 */
const ABOVE = 44;

/** 選取範圍落在哪一題(提問 `turn-*` 或答案 `answer-*`)。頭尾不在同一則就不算 */
function spotOf(root: HTMLElement): Spot | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const anchor = (n: Node) =>
    (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('[id^="turn-"], [id^="answer-"]') ?? null;
  const a = anchor(range.startContainer);
  if (!a || a !== anchor(range.endContainer) || !root.contains(a)) return null;
  // 輸入框裡選字不算(便條、輸入框都在對話區裡)
  if ((range.startContainer as Element).closest?.('textarea, input')) return null;
  const qaId = qaIdFromAnchor(a.id);
  if (qaId == null) return null;
  const rects = range.getClientRects();
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? first;
  // 觸控:手機自己的選字選單在上面,我們放到下面
  const below = window.matchMedia('(pointer: coarse)').matches;
  const top = below ? last.bottom + 8 : first.top - ABOVE;
  const left = Math.min(Math.max(8, first.left), window.innerWidth - BUTTON_WIDTH - 8);
  return {top: Math.max(8, top), left, qaId, text};
}

/**
 * 反白一段 → 選取範圍上方浮出 `Save to notes`。存成一則新筆記:引用區塊放反白的字。
 *
 * 只在**放開滑鼠 / 手指之後**出現:拖著選的時候 `selectionchange` 一直在發,跟著跳會很吵。
 * 用 portal 掛到對話區外面:對話區那幾層有 transform(換頁過場、輸入框變形),fixed 會被它們困住。
 * 掛的是佈景那一層(`portalHost`),不是 body —— body 讀不到佈景的 token。
 */
export function SelectionSaveButton({
  root,
  onSave,
}: {
  root: RefObject<HTMLElement | null>;
  onSave: (qaId: number, kind: SaveKind, text?: string) => void;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);

  useEffect(() => {
    let pointerDown = false;
    const update = () => {
      const el = root.current;
      setSpot(el && !pointerDown ? spotOf(el) : null);
    };
    const onDown = (e: PointerEvent) => {
      // 按在浮動鈕自己身上不算(那一下是要存)
      if ((e.target as Element | null)?.closest?.('[data-save-selection]')) return;
      pointerDown = true;
      setSpot(null);
    };
    const onUp = () => {
      pointerDown = false;
      // 等瀏覽器把選取範圍定下來
      window.setTimeout(update);
    };
    const onSelection = () => {
      if (document.getSelection()?.isCollapsed) setSpot(null);
      else if (!pointerDown) update(); // 鍵盤(Shift + 方向鍵)選的
    };
    const onScroll = () => setSpot((s) => (s ? (root.current ? spotOf(root.current) : null) : s));
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('selectionchange', onSelection);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('selectionchange', onSelection);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [root]);

  if (!spot) return null;
  return createPortal(
    <Stack data-save-selection="" xstyle={styles.floating} style={{top: spot.top, left: spot.left}}>
      <Button
        label="Save to notes"
        icon={<Icon icon={BookmarkPlus} size="sm" />}
        // 實心(底色填滿),跟 SSH 終端機反白後的「問 AskME」同一種樣式,見 TerminalView.tsx
        variant="primary"
        size="sm"
        elevation="med"
        // 按下去不要讓選取範圍消失(不然 click 之前它就被清掉了)
        onPointerDown={(e: React.PointerEvent) => e.preventDefault()}
        onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
        onClick={() => {
          const {qaId, text} = spot;
          setSpot(null);
          document.getSelection()?.removeAllRanges();
          onSave(qaId, 'selection', text);
        }}
      />
    </Stack>,
    // 掛在佈景那一層,不是 body(body 讀不到佈景的 token,按鈕會變成設計系統預設的藍,見 lib/portalHost.ts)
    portalHost(),
  );
}
