/**
 * 「@」與「[[」選單的項目(照 Notion):
 *   - 「@」:同事、頁面、日期(今天 / 明天 / 昨天,也可以直接打 10/20、2026/10/20)。
 *   - 「[[」:頁面;打了字但找不到同名的頁(或一頁都沒有),最下面一項是「新增子頁」。
 * 選了就插一個提及(`noteMention` 節點,外觀在 nodeViews 的 MentionView)。
 *
 * 選單的引擎與畫面跟「/」共用(slashCommand.tsx);這裡只管「列哪些項目、選了插什麼」。
 */
import type {Editor} from '@tiptap/core';
import {CalendarDays, FilePlus, FileText, User} from 'lucide-react';

import {noteTitle} from '../../lib/notebookApi';
import {mentionablePeople} from '../../lib/peopleDirectory';
import type {MentionAttrs} from './noteExtensions';
import {hostOf} from './noteHost';
import {iconOf} from './pageIcons';
import type {MenuItem} from './slashCommand';

/** 每一類最多列幾個 */
const MENTION_LIMIT = 5;
const PAGE_LIMIT = 8;

/** 插一個提及,後面補一個空白接著打字 */
function insertMention(editor: Editor, attrs: MentionAttrs) {
  editor.chain().focus().insertContent([{type: 'noteMention', attrs}, {type: 'text', text: ' '}]).run();
}

/** 日期顯示:今年的寫 10/14,其他年份寫 2027/1/5 */
export function dateLabel(d: Date, now = new Date()): string {
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/** 日期存成 2026-10-14(含年份;只存「10/14」的話隔年就分不出是哪一年) */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 存下來的 2026-10-14 → 那一天;格式不對回 null */
export function fromIsoDate(iso: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** 打的字像日期(10/20、2026/10/20、2026-10-20):轉成那一天;不像回 null */
export function parseDateQuery(q: string, now = new Date()): Date | null {
  const m = /^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})$/.exec(q.trim());
  if (!m) return null;
  const d = new Date(m[1] ? Number(m[1]) : now.getFullYear(), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

/** 日期提及的內容:id 是含年份的日期,label 是搜尋 / 摘要用的完整寫法(2026/10/14);畫面上今年的只寫 10/14 */
function dateMention(d: Date): MentionAttrs {
  return {kind: 'date', id: isoDate(d), label: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`};
}

function pageItems(query: string, editor: Editor, limit: number): MenuItem[] {
  const q = query.trim().toLowerCase();
  return hostOf(editor)
    .pages()
    .filter((p) => !q || noteTitle(p.title).toLowerCase().includes(q))
    .slice(0, limit)
    .map((p) => ({
      label: noteTitle(p.title),
      icon: iconOf(p.icon) ?? FileText,
      keys: '',
      run: (e: Editor) => insertMention(e, {kind: 'page', id: p.id, label: p.title}),
    }));
}

export function mentionItems(query: string, editor: Editor): MenuItem[] {
  const q = query.trim().toLowerCase();
  const people = mentionablePeople()
    .filter((p) => !q || p.username.toLowerCase().includes(q) || (p.display_name || '').toLowerCase().includes(q))
    .slice(0, MENTION_LIMIT)
    .map((p) => ({
      label: p.display_name || p.username,
      icon: User,
      keys: '',
      run: (e: Editor) => insertMention(e, {kind: 'user', id: p.username, label: p.display_name || p.username}),
    }));
  const now = new Date();
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const typed = parseDateQuery(query, now);
  const dates = (
    typed
      ? [{name: dateLabel(typed, now), date: typed}]
      : [
          {name: `今天 ${dateLabel(day(0), now)}`, date: day(0)},
          {name: `明天 ${dateLabel(day(1), now)}`, date: day(1)},
          {name: `昨天 ${dateLabel(day(-1), now)}`, date: day(-1)},
        ]
  )
    .filter((d) => typed || !q || d.name.toLowerCase().includes(q))
    .map((d) => ({label: d.name, icon: CalendarDays, keys: '', run: (e: Editor) => insertMention(e, dateMention(d.date))}));
  return [...people, ...pageItems(query, editor, MENTION_LIMIT), ...dates];
}

export function pageLinkItems(query: string, editor: Editor): MenuItem[] {
  const title = query.trim();
  const found = pageItems(query, editor, PAGE_LIMIT);
  // 「新增子頁」只在打了字、又沒有同名的頁時出現(還沒打字時只列頁面);一頁都沒有時也給,不然選單是空的
  const wantsCreate = title ? !found.some((f) => f.label === title) : found.length === 0;
  if (!wantsCreate) return found;
  const create: MenuItem = {
    label: title ? `新增子頁「${title}」` : '新增子頁',
    icon: FilePlus,
    keys: '',
    // 建好直接連過去(不換頁,照 Notion)
    run: async (e: Editor) => {
      const page = await hostOf(e).newSubpage(title);
      if (page && !e.isDestroyed) insertMention(e, {kind: 'page', id: page.id, label: page.title});
    },
  };
  return [...found, create];
}
