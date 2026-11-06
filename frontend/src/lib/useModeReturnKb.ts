/**
 * 一般模式中專案選單讓位、這一題送 `general`(lib/composerMode.ts);**離開模式要回到進模式前選的專案**。
 *
 * 不記的話回不去:輸入框的專案平常取「這組對話最後一則用的環境」(Chat.tsx 的 conversationKb),
 * 而模式裡問過一題之後,最後一則存的是 `general`(不在專案清單裡)—— 按 ✕ 離開,專案退回全站預設,不是使用者原本選的。
 * 所以進模式那一刻記下當時的專案,離開時用 `restore` 選回去(= 在這組對話裡主動選,kbChoice)。
 *
 * - 模式中改選專案:記下的跟著換,離開時回到最後選的那個(一般模式中專案選單是拿掉的,目前碰不到;留給保留專案選單的模式)。
 * - 空白頁送出第一句會導到新對話、對話頁整個重掛:記著的那個交給新掛上來的那一份(`carryTo`)。
 */
import {useCallback, useEffect, useRef, useState} from 'react';

let carried: {to: string; kb: string} | null = null;

export function useModeReturnKb({
  storeKey,
  active,
  projectKb,
  restore,
}: {
  /** 跟兩個模式 hook 同一個 key:對話 id,空白頁用 NEW_KEY */
  storeKey: string;
  /** 兩個模式任一個開著 */
  active: boolean;
  /** 輸入框現在的專案(effectiveKb) */
  projectKb: string | undefined;
  restore: (kb: string) => void;
}) {
  const [adopted] = useState(() => (carried?.to === storeKey ? carried.kb : null));
  const returnKb = useRef<string | null>(adopted);
  const wasActive = useRef(active);
  const latest = useRef({projectKb, restore});
  latest.current = {projectKb, restore};

  useEffect(() => {
    if (adopted !== null && carried?.to === storeKey) carried = null;
    // 只在掛上那一刻接手
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active && !wasActive.current) returnKb.current = latest.current.projectKb ?? null;
    if (!active && wasActive.current) {
      const kb = returnKb.current;
      returnKb.current = null;
      if (kb) latest.current.restore(kb);
    }
    wasActive.current = active;
  }, [active]);

  /** 模式中使用者自己換了專案:離開時回到這個 */
  const notePick = useCallback(
    (kb: string) => {
      if (active) returnKb.current = kb;
    },
    [active],
  );

  const carryTo = useCallback(
    (to: string) => {
      if (active && returnKb.current) carried = {to, kb: returnKb.current};
    },
    [active],
  );

  return {notePick, carryTo};
}
