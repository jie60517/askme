// @vitest-environment jsdom
/**
 * @ 便條的已讀:看過的人的小頭像,一個都還沒看是一個勾。
 *
 * 要守的:**只畫看過的人、照後端給的順序**(看的先後),而且名字跟聊天裡的頭像是同一套
 * (名冊查不到就退回便條自帶的顯示名稱)。沒看的人不能出現 ——
 * 畫出沒看的人會被讀成「他看過了」。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render} from '@testing-library/react';

const displayNameOf = vi.fn((u: string) => (u === 'jim' ? '吉姆' : undefined));

vi.mock('../../lib/peopleDirectory', () => ({
  mentionablePeople: () => [],
  allPeople: () => [],
  displayNameOf: (u: string) => displayNameOf(u),
  roleOf: () => undefined,
  avatarOf: () => undefined,
  // `avatarTint()` 用的;見 PersonDisplay.test.tsx 同一段的說明
  rosterIndexOf: () => undefined,
}));

const {NoteReceipt, seenInOrder} = await import('../NoteReceipt');

afterEach(cleanup);

describe('NoteReceipt', () => {
  it('nobody has seen it: one check, no avatars', () => {
    const {getByLabelText, container} = render(<NoteReceipt seen={[]} />);
    expect(getByLabelText('Not seen yet')).toBeTruthy();
    expect(container.querySelectorAll('.astryx-avatar')).toHaveLength(0);
  });

  it('draws only the people who have seen it, in the order they saw it', () => {
    const {getByLabelText, queryByLabelText, getAllByRole} = render(
      <NoteReceipt seen={['ming', 'jim']} names={{ming: '小明', jim: 'Jim', hua: '阿華'}} />,
    );
    expect(queryByLabelText('Not seen yet')).toBeNull();
    expect(getByLabelText('Seen by 2')).toBeTruthy();
    // 名冊有的(jim → 吉姆)用名冊;查不到的(ming)退回便條自帶的名字
    const names = getAllByRole('img').map((el) => el.getAttribute('aria-label'));
    expect(names).toEqual(['小明', '吉姆']);
  });

  it('orders by the time they saw it, even when an account name is all digits', () => {
    // 整數鍵在 JS 物件裡一律排最前面;照 Object.keys 會變成 ['10023', 'ming']
    const seen = {ming: '2026-10-29T03:54:30.911205', '10023': '2026-10-29T03:55:01.000000'};
    expect(Object.keys(seen)).toEqual(['10023', 'ming']);
    expect(seenInOrder(seen)).toEqual(['ming', '10023']);
    expect(seenInOrder(undefined)).toEqual([]);
  });
});
