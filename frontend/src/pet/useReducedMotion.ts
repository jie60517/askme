import { useEffect, useState } from "react";

/**
 * 使用者在作業系統關掉「動畫效果」時回傳 true。
 *
 * styles/pet.css 那邊已經有一份 @media (prefers-reduced-motion) 把 CSS 動畫停掉,
 * 但用 JS 逐格改 inline style 的動畫(氣泡的彈簧、跟著滑鼠傾斜)繞得過 CSS,
 * 所以那些地方要另外讀這個 hook,直接跳到最終狀態。
 *
 * ⚠️ **這個專案刻意留著兩份 `useMediaQuery`**:這一份,以及 `lib/media.ts` 的那一份
 * (那份給側邊欄的手機斷點用)。kit 要能整包複製給別的專案,不能 import 宿主的
 * 程式碼,所以自己帶一份。兩份現在的**行為一模一樣**(初值直接讀 `matchMedia`、
 * 訂閱後先同步一次、卸載時退訂),差別只有排版與內部變數名。
 * 動其中一份就把另一份一起看過 —— 真的要讓它們不一樣的話,在兩邊都寫下為什麼。
 *
 * 別的專案已經有同名 hook 的話,刪掉這個檔案改 import 自己的就好。
 */
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCE_QUERY);
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    // 訂閱之後先同步一次:query 換掉的那一幀,舊的結果還留在 state 裡
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
