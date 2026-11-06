import * as stylex from '@stylexjs/stylex';
import {AvatarGroup} from '@astryxdesign/core/AvatarGroup';
import {Icon} from '@astryxdesign/core/Icon';
import {Check} from 'lucide-react';

import {PersonAvatar} from './PersonDisplay';

/** 小頭像的大小。泡泡底下那排 metadata 的字高,再大會把那一列撐高。 */
const RECEIPT_AVATAR_PX = 20;

const styles = stylex.create({
  /*
   * 第二顆之後往前疊。**`AvatarGroup` 自己的重疊在這裡不會生效**:它靠
   * `:not(:first-child)` 加負邊距,而 `PersonAvatar` 外面那層 `HoverCard`
   * (display: contents)讓每顆頭像都成了自己那層的第一個 —— 實機看到的是並排。
   * `AvatarGroup` 自己算的是 0.25 × 尺寸 = 5px;這裡用最接近的 spacing token(4px),
   * 不寫死 px(CLAUDE.md)。差 1px 看不出來。
   */
  stacked: {
    marginInlineStart: 'calc(var(--spacing-1) * -1)',
  },
});

/**
 * 後端的 `seen`(帳號 → 看過的時間)照**看過的先後**排成帳號清單。
 *
 * ⚠️ 不能直接 `Object.keys`:帳號可以是純數字(員編),而 JS 物件的整數鍵一律
 * 由小到大排在最前面,後端排好的順序就亂了。時間是同一種
 * ISO 格式,字串比較就是時間先後。
 */
export function seenInOrder(seen: Record<string, string> | undefined): string[] {
  return Object.entries(seen ?? {})
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([username]) => username);
}

/**
 * @ 便條的已讀:看過的人的小頭像,一個都還沒看就是一個勾。
 *
 * - **只畫看過的人**。沒看的不畫(不畫灰頭像)。
 * - 對話裡每個人看到的都一樣,不只寫便條的人。
 * - 頭像跟聊天裡的同事頭像是同一個元件(`PersonAvatar`):滑過去是那個人的名片,
 *   不另外做 tooltip(全站「頭像浮層要統一」那條)。
 *
 * `seen` 是後端照看的先後排好的(`notes.seen_by_note`),這裡不再排。
 * `names` 是便條自帶的顯示名稱,名冊查不到那個人時才用得到(同 `PersonAvatar` 的 `fallbackName`)。
 */
export function NoteReceipt({seen, names}: {seen: string[]; names?: Record<string, string>}) {
  if (seen.length === 0) {
    return <Icon icon={Check} size="sm" color="secondary" label="Not seen yet" />;
  }
  return (
    <AvatarGroup size={RECEIPT_AVATAR_PX} aria-label={`Seen by ${seen.length}`}>
      {seen.map((username, i) => (
        <PersonAvatar
          key={username}
          username={username}
          fallbackName={names?.[username]}
          size={RECEIPT_AVATAR_PX}
          xstyle={i > 0 ? styles.stacked : undefined}
        />
      ))}
    </AvatarGroup>
  );
}
