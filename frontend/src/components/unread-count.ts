/**
 * 側邊欄未讀數 Badge 上**看得到的**那串字。
 *
 * 不能直接印 `String(n)`:資料夾 / Shared 收合時掛的是**整層加總**,
 * 幾百則一進來 Badge 就撐成四五個字寬,把同一列的標題擠得更短。
 * 封頂在 `99+`(常見慣例,兩位數以內的寬度不會變)。
 *
 * ⚠️ 只管**看得到的字**。確切數字要另外留給報讀軟體(`Sidebar.tsx` 的 `UnreadBadge`
 * 用 `VisuallyHidden` 帶 `String(n)`)—— 封頂是版面的事,不是資訊可以少給的理由。
 */
export const UNREAD_CAP = 99;

export function formatUnreadCount(n: number): string {
  return n > UNREAD_CAP ? `${UNREAD_CAP}+` : String(n);
}

/** 看得到的字跟確切數字不一樣(= 被封頂了),報讀軟體那份才需要另外給 */
export function isUnreadCapped(n: number): boolean {
  return n > UNREAD_CAP;
}
