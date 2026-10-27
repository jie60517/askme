import {useCallback, useEffect, useRef, useState} from 'react';

/**
 * 對話框的**退場**——全站共用的那半。
 *
 * ## 為什麼需要它
 *
 * `<dialog>` 一旦 `close()` 就是 `display: none`,**補不了幀**:退場動畫要演得完,
 * 唯一的辦法是呼叫端把 `close()` 延後。設計系統沒有這個機制,所以每個對話框
 * 自己得做一次。
 *
 * `global.css` 的進場規則套在全站的對話框上;沒有配對的退場的話,就會變成
 * 「進場演 225ms、關掉硬切」的不對稱。所以每個對話框都要走這支 hook。
 *
 * ## 怎麼用
 *
 * ```tsx
 * const exit = useDialogExit(onOpenChange);
 * <Dialog isOpen={isOpen} {...exit.dialogProps} …>
 *   <DialogHeader title="…" onOpenChange={exit.dialogProps.onOpenChange} />
 * ```
 *
 * 對話框內部自己要關掉的地方(Cancel 按鈕、送出成功之後)呼叫 `exit.requestClose()`,
 * **不要**直接 `onOpenChange(false)` —— 那會讓設計系統當場 `close()`,退場當場被切斷。
 *
 * ⚠️ 關掉之後才要做的事(跳轉、清狀態)有兩種放法,**選錯會閃一下**:
 *   - 跟關閉同時發生就好的(跳到另一頁)→ 照舊放在自己的 handler 裡,
 *     它會在 `requestClose()` 那一刻跑,對話框在上面淡出,底下已經換頁了;
 *   - 一定要等對話框不見了才能做的(把資料清成空的)→ 放在 `onOpenChange(false)`
 *     的那一側,它已經是延後的了。
 */

/**
 * 退場演多久(毫秒)。
 *
 * ⚠️ **要跟 `global.css` 那條 `[data-leaving]` 的 transition 一致** ——
 * 這邊是「什麼時候真的關掉」,那邊是「關掉之前畫什麼」,對不上就會在中途被切斷。
 * 值 = `--duration-fast-max`(165ms)。
 */
export const DIALOG_EXIT_MS = 165;

/** `global.css` 的進退場規則認這個記號。掛法交給 `dialogProps`,不要自己寫。 */
const APP_DIALOG = 'data-app-dialog';
/** 正在演退場。CSS 認它畫淡出 + 縮一點點。 */
const LEAVING = 'data-leaving';

export type DialogExit = {
  /** 正在演退場(需要時可以拿去停掉自動聚焦之類的事;多數呼叫端用不到) */
  isLeaving: boolean;
  /** 關掉它 —— 先演退場,`DIALOG_EXIT_MS` 之後才真的關 */
  requestClose: () => void;
  /**
   * 退場演到一半反悔 —— 取消那一次關閉,**留在開著的狀態**。
   * 回傳「剛才真的有在演退場嗎」,呼叫端可以用它決定要不要繼續做別的事。
   *
   * ⚠️ 這條路存在的理由:`isOpen` 在退場那 165ms 裡**還是 `true`**,
   * 所以呼叫端常見的 `isOpen ? 關 : 開` 在這段時間會走到「關」那一半 ——
   * 使用者按 ⌘K 想叫回來,結果按鍵被吃掉,要再按一次。
   * 取消之後 `data-leaving` 當場拿掉,CSS 的 transition 會**從當下那一幀反向**
   * 回到原狀,不會跳一下。
   */
  cancelClose: () => boolean;
  /** 直接攤進 `<Dialog>`:記號、退場旗標、包過的 `onOpenChange` */
  dialogProps: {
    [APP_DIALOG]: '';
    [LEAVING]?: '';
    onOpenChange: (open: boolean) => void;
  };
};

export function useDialogExit(onOpenChange: (open: boolean) => void): DialogExit {
  const [isLeaving, setIsLeaving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  /**
   * ⚠️ 「正在演退場」要**另外用 ref 記一份**,不能只靠 `setIsLeaving` 的 updater 判斷。
   *
   * 不要把守衛與 `setTimeout` 塞在 `setIsLeaving((leaving) => …)` 裡面:那個
   * updater **必須是純函式**,React 19 的 `StrictMode`(`main.tsx` 有開)會把它跑兩次,
   * 於是關一次排出兩顆計時器,而 `timer.current` 只留得住第二顆 —— 第一顆漏在外面,
   * 連 unmount 的 cleanup 都收不到。這支 hook 全站的對話框共用,
   * 競態保護不能建立在「updater 只會跑一次」這個 React 不保證的前提上。
   */
  const leaving = useRef(false);

  // 元件被拔掉時要收掉那顆計時器(對話框常常跟著整頁一起卸載)
  useEffect(() => () => window.clearTimeout(timer.current), []);

  /**
   * ⚠️ `onOpenChange` 多半是呼叫端**當場新做的箭頭函式**,放進相依等於每次 render
   * 都重建 `requestClose`。用 ref 接住最新的一份,`requestClose` 本身就能是穩定的。
   */
  const latest = useRef(onOpenChange);
  latest.current = onOpenChange;

  const requestClose = useCallback(() => {
    // 已經在演了就不要再排一次:連按兩下 Esc 會排出兩顆計時器,
    // 第二顆在對話框已經關掉之後才到,下一次打開會被它當場關掉。
    if (leaving.current) return;
    leaving.current = true;
    setIsLeaving(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      leaving.current = false;
      /*
       * ⚠️ **先把旗標收回來再關。** 不收的話 `data-leaving` 會留在元件身上,
       * 而多數對話框是常駐的(不像設定那個有 `key` 會重掛)——
       * 下一次打開就會帶著「正在離開」的樣子出場(淡掉 + 縮小)。
       */
      setIsLeaving(false);
      latest.current(false);
    }, DIALOG_EXIT_MS);
  }, []);

  const cancelClose = useCallback(() => {
    if (!leaving.current) return false;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    leaving.current = false;
    setIsLeaving(false);
    return true;
  }, []);

  return {
    isLeaving,
    requestClose,
    cancelClose,
    dialogProps: {
      [APP_DIALOG]: '',
      ...(isLeaving ? {[LEAVING]: '' as const} : {}),
      onOpenChange: (open: boolean) => {
        if (!open) {
          requestClose();
          return;
        }
        // 退場演到一半又要打開:取消就好,`isOpen` 從頭到尾沒被翻過
        if (cancelClose()) return;
        latest.current(true);
      },
    },
  };
}
