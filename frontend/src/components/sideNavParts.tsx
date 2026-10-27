/**
 * 主側欄(`Sidebar.tsx`)與筆記頁左側清單(`notes/NoteTree.tsx`)共用的幾樣東西 —— 兩份清單**長相與操作同一套**。
 * 獨立成檔,筆記清單才不必為了 HoverRegion 匯入整支 Sidebar(測試也會被拖進來)。
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {ContextMenuItem} from '@astryxdesign/core/ContextMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {Stack} from '@astryxdesign/core/Layout';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {ChevronDown, ChevronUp} from 'lucide-react';

import {highlightStyles, pendingLift} from './hover-lift';

/**
 * 對話標題、資料夾名稱的長度上限。跟後端 `schemas.MAX_TITLE_CHARS` 對齊
 * (`RenameConversationRequest.title`、`CreateFolderRequest` / `UpdateFolderRequest.name` 共用那一個)。
 *
 * 改名框沒有上限的話,貼進 201 字以上 → 後端 422,畫面只說「Could not rename this chat.」,
 * 剛打的字還被還原。在輸入框就擋住,打不進去比較好懂。
 * (`maxLength` 數的是 UTF-16 單位,emoji 算兩個 —— 只會比後端嚴,不會放過它擋的。)
 */
export const MAX_TITLE_CHARS = 200;
/**
 * 用展開的方式掛:`TextInput` 的型別只開了 `HTMLAttributes`(沒有 `maxLength`),
 * 但其餘屬性會原封不動落到裡面那顆 `<input>` 上(設計系統的 `{...rest}`)。
 * 筆記頁的標題上限也是 200(後端 `notebook.TITLE_MAX`),共用這一個。
 */
export const TITLE_INPUT_LIMIT = {maxLength: MAX_TITLE_CHARS};

/** 清單的導引線、拖曳幽靈、拖曳中原本那一列(兩份清單同一個樣子) */
export const sideNavStyles = stylex.create({
  /**
   * 拖曳中跟著指標走的那一塊。
   *
   * 裡面是**那一列的複本**(見 useLongPressDrag 的 `resolveVisual`)——
   * 不放大、不縮小、不傾斜、不換色,拿起來的還是原本那個東西。
   *
   * 這一層只做兩件事:
   * 1. 長得像**滑鼠滑過那一列的樣子**(漂浮框,不是白底)—— 跟 `hoverPill` 同一組:
   *    `--radius-element` + `--color-overlay-hover`。
   *    ⚠️ 那個 overlay 是 5% 的**半透明**黑,要疊在不透明的底上面
   *    (只有它的話,底下的列會從複本身上穿過去)。而底要用
   *    **`--color-background-body`**,不是 surface —— 側邊欄自己的底色就是
   *    `#f1f1f1`(body),用白的疊出來是 #f2f2f2,比真正的高亮塊淺一階,一眼就看得出不一樣。
   * 2. **浮起來**:陰影用 `--shadow-med`,比高亮塊的 low 高一階 ——
   *    它是被拿在手上的東西,本來就該離桌面遠一點。
   *    只動陰影,不放大不傾斜。
   * 3. 位置:照**按下去的那一點**擺(`grabX/grabY`),不置中 ——
   *    抓在三分之一處就一路是三分之一處。
   */
  dragGhost: {
    position: 'fixed',
    zIndex: 60,
    pointerEvents: 'none',
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-background-body)',
    backgroundImage:
      'linear-gradient(var(--color-overlay-hover), var(--color-overlay-hover))',
    boxShadow: 'var(--shadow-med)',
  },
  rowDragging: {opacity: 0.45},
  /**
   * 展開之後從圖示往下的那條灰線(設計系統 shell nav 的巢狀導引線,
   * 跟 TreeList 的 `lineGuides` 同一個處理)。
   *
   * 位置要對準**上一層那顆圖示的中心**:那一列的內距是 --spacing-2、
   * 圖示 16px(半寬也是 --spacing-2),所以圖示中心在列的左緣 +16px;
   * 而子項目已經被 SideNavItem 往內推了 --spacing-6(24px)。
   * 兩者相減 = -8px,線就落在圖示正下方。
   *
   * 收合時它一樣在,但外層那個 `overflow: hidden` 的格子高度是 0,
   * 所以看不到 —— 不必另外判斷開合。
   */
  nestGuide: {
    position: 'relative',
    '::before': {
      content: '""',
      position: 'absolute',
      insetInlineStart:
        'calc(var(--spacing-2) + var(--spacing-2) - var(--spacing-6))',
      insetBlockStart: 0,
      insetBlockEnd: 0,
      width: 'var(--border-width)',
      borderRadius: 'var(--radius-full)',
      backgroundColor: 'var(--color-border-emphasized)',
    },
  },
});

const styles = stylex.create({
  /**
   * 會滑動的高亮塊:只有**一塊**,在列與列之間滑過去 ——
   * 每一列各自上底色的話,滑過去是「這裡亮、那裡亮」兩件事;
   * 一塊會動的則是同一個東西跟著你走。
   *
   * 它住在**一個區塊裡面**,不是掛在整份文件上。
   *
   * ⚠️ 不能用 `position: fixed` 掛在 SideNav **外面**:
   * SideNav 的**貼齊底部那條(sticky)帳號區**是 positioned 而且
   * 有不透明底色 —— 同樣的 z-index、DOM 順序又在後面,所以整條帳號區
   * 蓋在高亮上面,Dark mode / Sign out 那幾列的高亮**完全看不到**
   *(位置一直是對的,所以只讀 inline style 驗不出來)。
   * 反過來在會捲的那一區,高亮又蓋在 New chat / Search 的字上面。
   *
   * 一區一塊、`absolute` 定位在自己這區裡,兩邊都解決了 ——
   * 而且它跟著內容捲,不必再算 fixed 的定位基準、也不必捲動時把它藏起來。
   */
  hoverRegion: {
    // block 不是 flex:這一層只是拿來當定位基準,版面要維持原樣
    display: 'block',
    position: 'relative',
  },
  /**
   * 長相共用 `highlightStyles.pill`(見 hover-lift),這裡只補
   * 「定在這一區的左上角、寬度要跟著每一列變」。
   * 兩份用**組合**掛上去,不是展開 —— 展開會讓 StyleX 把那個模組當 theme 檔。
   */
  hoverPill: {
    insetBlockStart: 0,
    insetInlineStart: 0,
    /*
     * ⚠️ `width` / `height` **不在**過場清單裡:兩個都是排版屬性,
     * 每一次滑到另一列都在補它們的幀。寬高讓它直接跳到下一列的尺寸 —— 眼睛讀的是
     * 那塊在滑,不是它邊緣的幾 px 在長。reduced-motion:位移也不做,只留淡入淡出。
     */
    transitionProperty: {
      default: 'transform, opacity',
      '@media (prefers-reduced-motion: reduce)': 'opacity',
    },
  },
});

/**
 * `position: fixed` 的定位基準在哪。
 *
 * 規格上 fixed 是相對視窗,**但只要祖先鏈上有人帶 transform / filter /
 * perspective(或 `will-change: transform`),那個祖先就變成基準**,
 * 掛在裡面的 fixed 元素(拖曳幽靈)會整塊偏掉那個祖先的位置。
 *
 * ⚠️ 側邊欄的收合動畫**不是** transform —— 是 `transition: width`
 * (global.css 的 `.astryx-side-nav`),不會建立定位基準,所以目前這裡多半一路
 * 找到底、回 (0,0)。留著是因為祖先鏈上任何一層(設計系統的版面、之後加的動畫)
 * 掛上 transform 時,幽靈會無聲無息地偏掉,而這支會自己接住。
 *
 * 從 `start` **自己**開始往上找到第一個這種祖先,把它的左上角當原點;找不到就是視窗,回 (0,0)。
 * 幽靈掛在哪一層底下,就從哪一層開始找(見 `ghostOrigin`)。
 */
export function fixedOrigin(start: HTMLElement | null): {x: number; y: number} {
  let node = start;
  while (node) {
    const cs = getComputedStyle(node);
    if (
      cs.transform !== 'none' ||
      cs.filter !== 'none' ||
      cs.perspective !== 'none' ||
      cs.willChange.includes('transform')
    ) {
      const rect = node.getBoundingClientRect();
      return {x: rect.left, y: rect.top};
    }
    /*
     * top layer(`showModal()` 開的 `<dialog>`,手機抽屜就是)以外的祖先**當不了**它裡面
     * fixed 元素的基準 —— 再往上找的話,app 外層哪天掛了 transform,幽靈會被扣掉一段
     * 瀏覽器根本沒套的位移。走到這裡就是視窗。
     */
    if (node.matches(':modal')) break;
    node = node.parentElement;
  }
  return {x: 0, y: 0};
}

/**
 * 「一塊會滑的高亮」的宿主。把一區的內容包起來就好。
 *
 * 為什麼是一區一塊,而不是整個側邊欄共用一塊:見 `styles.hoverRegion`。
 * 簡短版 —— 貼齊底部的帳號區是 sticky 而且有不透明底色,
 * 掛在外面的那塊會被它整條蓋掉。
 *
 * 監聽是**委派**的(認設計系統公開的 `.astryx-side-nav-item`),
 * 不是每一列各掛一個:側邊欄上可以按的東西不只對話列,一個一個掛的話
 * 以後多一個項目就少一塊高亮,而且不會有人發現。
 */
export function HoverRegion({
  isSuppressed,
  pinnedRow,
  pinnedNonce,
  onRoot,
  children,
}: {
  /** 拖曳中不要畫 —— 那時候該看的是拖曳幽靈 */
  isSuppressed?: boolean;
  /** 右鍵選單開著時釘住的那一列(null = 沒釘) */
  pinnedRow?: HTMLElement | null;
  /**
   * 「釘著的那一列自己換位置了」的訊號(選單裡的 ^ / v)。
   * 元素沒變、只是被搬到別的位置 —— 沒有這個計數器就不會重量,
   * 高亮會留在原地(而那顆按鈕不關選單,所以看得一清二楚)。
   */
  pinnedNonce?: number;
  /**
   * 這一區的根節點掛上 / 卸下時通知外面(手機抽屜要從這裡找捲動層,見 `bindDrawerList`)。
   * ⚠️ 要給**穩定**的函式:每次 render 換一支的話,React 每次都會先 null 再重掛一次。
   */
  onRoot?: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const bindRoot = useCallback(
    (el: HTMLElement | null) => {
      rootRef.current = el;
      onRoot?.(el);
    },
    [onRoot],
  );
  /**
   * ⚠️ 收起來的時候**只改 opacity,位置留著**。位置一起清掉的話,
   * 下一次滑上來就是從這一區的左上角「掉」下來(每一次都會發生)。
   */
  const [box, setBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [isOn, setIsOn] = useState(false);
  /**
   * 這一次是**重新亮起來**(上一刻是收著的):位置直接到位,不要滑。
   *
   * 側邊欄有**三個** `HoverRegion`(上方工具 / 會捲的清單 / 帳號區),
   * 各記各的 `box`,而且離開一區時**只關 opacity、位置刻意留著**(見 `box` 的註解)。
   * 所以從對話列移到 Search 時,動的是「上方工具」那一區的浮框 —— 它上次若停在
   * New chat / New folder(在 Search **上面**),就會一邊淡入一邊從上面滑下來。
   *
   * ⚠️ **不能改成「離開就把位置清掉」** —— `box` 的註解寫著那會讓每一次滑進來
   * 都從該區左上角掉下來,更糟。要處理的是「從收著到亮起來」那一次不要滑。
   * 做法跟 `MenuHighlightLayer` 的 `isSnap` 一樣:只把 `transform` 拿出過場清單,
   * **淡入淡出留著**(不然它會硬生生出現)。區內從一列滑到另一列照舊會滑 ——
   * 那才是這塊高亮的重點。
   */
  const [isSnap, setIsSnap] = useState(false);
  /**
   * `isOn` 的 ref 版 —— `place` 要知道「上一刻亮著沒」才能決定要不要 snap。
   *
   * ⚠️ **不要改成在 `setIsOn` 的 updater 裡讀**:
   * updater 必須是純函式,在裡面呼叫另一個 `setState` 的時序不保證,
   * 結果 `transitionProperty` 會從頭到尾都是預設值。
   * 也不要把 `isOn` 列進 `place` 的相依 —— `place` 進了好幾支 effect 的相依鏈。
   */
  const isOnRef = useRef(false);
  const turnOff = useCallback(() => {
    isOnRef.current = false;
    setIsOn(false);
  }, []);
  const lastItem = useRef<Element | null>(null);

  /**
   * 量某一列相對於這一區的位置。
   * `snap` = 不管上一刻亮著沒,這一次都直接到位(釘住的那一列被 ^ / v 搬走時,見下面的 effect)。
   */
  const place = useCallback((el: Element | null, snap = false) => {
    const root = rootRef.current;
    if (!root || !el) return;
    const a = el.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    // 每一列滑上去都會往上浮(global.css 的 `--row-float`)——
    // 高亮要停在浮好之後的位置,所以補上還差的那一段(見 hover-lift.ts)
    const lift = pendingLift(el);
    // 上一刻是收著的 → 這一次直接到位、不要滑(見 `isSnap`)
    setIsSnap(snap || !isOnRef.current);
    isOnRef.current = true;
    setIsOn(true);
    setBox({
      left: a.left - b.left,
      top: a.top - b.top - lift,
      width: a.width,
      height: a.height,
    });
  }, []);

  /*
   * 釘住的那一列掛 `data-pinned`:右鍵之後指標一移到選單上,
   * `:hover` 就沒了,不掛的話那一列會掉下來抖一下 —— 而那正是使用者盯著它的時候。
   *
   * 屬性用 DOM 直接掛:那一列是設計系統畫的,React 不管這個屬性,
   * 而「哪一列被釘住」只有這裡知道(右鍵、「⋯」兩個入口都會經過)。
   */
  useEffect(() => {
    if (!pinnedRow) return;
    pinnedRow.setAttribute('data-pinned', '');
    return () => pinnedRow.removeAttribute('data-pinned');
  }, [pinnedRow]);

  /*
   * 上一次量的時候 `pinnedNonce` 是多少 —— 分得出「釘住的那一列被搬走了」
   * 跟「剛釘上去」。
   */
  const lastNonce = useRef(pinnedNonce);
  /** 上一次釘的是哪一列 —— 「搬走」只算同一列被搬,換釘另一列(同一次 commit 裡也 bump 了)不算 */
  const lastPinned = useRef(pinnedRow);
  useEffect(() => {
    const moved = pinnedNonce !== lastNonce.current && pinnedRow !== null && pinnedRow === lastPinned.current;
    lastNonce.current = pinnedNonce;
    lastPinned.current = pinnedRow;
    if (pinnedRow) {
      lastItem.current = pinnedRow;
      /*
       * ⚠️ 被 ^ / v 搬走的那一次**直接到位**:列是 CSS `order`
       * 瞬間換位的,高亮卻帶著果凍曲線的過衝追過去 —— 字已經到了、高亮還在追,
       * 而使用者會「連按好幾下」,每一下都追一次。跟重新亮起來那次同一招(`isSnap`),
       * 只拿掉位置的過場,淡入淡出不受影響。
       */
      place(pinnedRow, moved);
    } else {
      // 放開之後讓下一次 pointerover 重新點亮(不歸零的話,指標還停在同一列,
      // 而「同一列就不重算」會讓它一直不亮)
      lastItem.current = null;
      turnOff();
    }
  }, [pinnedRow, pinnedNonce, place, turnOff]);

  return (
    <Stack
      ref={bindRoot}
      xstyle={styles.hoverRegion}
      // ⚠️ 用 pointerover(會冒泡)而不是 pointerenter,委派才收得到。
      // 代價是同一列裡移動也會一直發 —— 所以認到同一列就不重算:
      // 對話列滑上去會浮 2px,重算時量到的是**已經浮起來**的位置。
      onPointerOver={(e: React.PointerEvent) => {
        if (pinnedRow) return;
        /*
         * ⚠️ **不認觸控**。觸控點一下瀏覽器會補發相容的 mouseover —— 聽 mouseover 的話,
         * 高亮會從上一次點的那列帶著過衝滑過來,而且一直黏著(觸控沒有 mouseleave)。
         * `--row-float` 在觸控上歸零(hover 只在有滑鼠的裝置上做)管不到這塊,它是 JS 點亮的。
         * 聽 pointerover 才分得出指標種類。
         * 右鍵 / 長按釘住(`pinnedRow`)走的是上面那支 effect,不經過這裡,照舊會亮。
         */
        // 只擋觸控:會懸停的觸控筆(Surface Pen、Apple Pencil)跟滑鼠一樣有 hover,照舊亮
        if (e.pointerType === 'touch') return;
        const target = e.target;
        if (!(target instanceof Element)) return;
        const item = target.closest('.astryx-side-nav-item');
        /*
         * ⚠️ 沒認到列的時候**不要**把它收掉。
         *
         * 列與列之間有幾 px 的縫,滑過去的那一兩格會落在縫裡 ——
         * 收掉再亮起來就是一閃一閃的,不夠滑順。
         * 真的離開這一區有 onMouseLeave 管。
         */
        if (!item || item === lastItem.current) return;
        lastItem.current = item;
        place(item);
      }}
      // 收掉這一半維持 mouseleave:只有滑鼠點得亮(上面那條),觸控補發的 mouseleave
      // 頂多是對已經收著的高亮再收一次;釘住時另外擋著。
      onMouseLeave={() => {
        lastItem.current = null;
        if (!pinnedRow) turnOff();
      }}
    >
      {box ? (
        <Stack
          aria-hidden
          xstyle={[highlightStyles.pill, styles.hoverPill]}
          style={{
            transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
            width: box.width,
            height: box.height,
            opacity: isOn && !isSuppressed ? 1 : 0,
            // 重新亮起來的那一次直接到位(見 isSnap);淡入淡出留著。
            // ⚠️ `width` / `height` 也要一起拿掉:換一區重亮時列寬多半不同,
            // 只擋 transform 的話會變成「位置到了、寬度還在長」。
            ...(isSnap ? {transitionProperty: 'opacity'} : null),
          }}
        />
      ) : null}
      {children}
    </Stack>
  );
}

/**
 * 選單裡置中的 ↑ / ↓(主側欄的 MoveItem;筆記清單沒有 ↑↓):**只有符號,置中**,
 * 名字塞一份 `VisuallyHidden` 給報讀程式 —— 選單項目的可及名稱不能是空的。
 * 圖示不用 `icon` 插槽:那個插槽是靠左的,置中要自己佔滿一整列。按了不關選單(連按幾下一路搬)。
 */
export function MoveMenuItem({direction, name, onMove}: {direction: 'up' | 'down'; name: string; onMove: () => void}) {
  return (
    <ContextMenuItem
      label={
        <Stack hAlign="center" width="100%">
          {direction === 'up' ? <Icon icon={ChevronUp} size="sm" /> : <Icon icon={ChevronDown} size="sm" />}
          <VisuallyHidden>{name}</VisuallyHidden>
        </Stack>
      }
      hasCloseOnSelect={false}
      onClick={onMove}
    />
  );
}

const colorTagStyles = stylex.create({
  tag: {
    width: 'var(--spacing-2)',
    height: 'var(--spacing-2)',
    flexShrink: 0,
    borderRadius: 'var(--radius-full)',
    backgroundColor: 'var(--item-color, transparent)',
  },
});

/**
 * 使用者自己挑的顏色記號:列右邊那顆點(設計系統 side nav 右邊那顆點的位置)。
 * 主側欄的對話列、筆記左側清單共用。顏色畫在最右邊這顆點上,不是讓圖示變色。
 *
 * 不用 `StatusDot` —— 它的顏色是語意的(accent / success / error…),
 * 這顆是使用者自己挑的任意顏色,硬塞進那四種會讓「紅色」看起來像出事了。
 * 尺寸跟 StatusDot 對齊(--spacing-2 = 8px),排在一起才不會一大一小。
 * `color` 是 CSS 顏色值(`sidebar-colors.ts` 的 `colorValue(key)`)。
 */
export function ColorTag({color}: {color: string}) {
  return <Stack aria-hidden xstyle={colorTagStyles.tag} style={{'--item-color': color} as React.CSSProperties} />;
}
