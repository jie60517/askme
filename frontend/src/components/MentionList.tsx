/**
 * @ 選單的內容:搜尋框、同事名單、分隔線、常駐群組(All Consultant / All Software Engineer / ALL)。
 *
 * 聊天的 @ 按鈕(`pages/Chat.tsx` 的 `MentionPicker`)與 Work Flow 的「通知人員」共用這一份:
 * 選單跟邏輯一樣,差在「通知人員」可以複選(`selected`)、字是中文(`strings`)。
 * 外面那層 `Popover` 與觸發鈕由呼叫端各自決定;搜尋字也由呼叫端持有(每次打開要清空)。
 *
 * ⚠️ 不要改成 `DropdownMenu`:選單面板自己管焦點與按鍵,搜尋框打不了字(見 Chat.tsx)。
 */
import {useMemo} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Divider} from '@astryxdesign/core/Divider';
import {Item} from '@astryxdesign/core/Item';
import {VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Icon} from '@astryxdesign/core/Icon';
import {Check} from 'lucide-react';

import {filterPeople, personName} from '../lib/people';
import {allPeople} from '../lib/peopleDirectory';
import {personDescription} from './PersonDisplay';

export type MentionPerson = {username: string; display_name?: string | null; role?: string};
export type MentionGroup = {key: string; label: string; /** 群組底下那一行(「3 people」) */ description: string};

export type MentionListStrings = {search: string; empty: string; people: string; groups: string};

/** 聊天用的英文字(介面語言是英文,見 frontend/.claude/CLAUDE.md) */
const MENTION_STRINGS_EN: MentionListStrings = {
  search: 'Search colleagues',
  empty: 'No colleague matches that.',
  people: 'Colleagues',
  groups: 'Groups',
};

export function MentionList({
  people,
  groups,
  query,
  onQueryChange,
  onPickPerson,
  onPickGroup,
  selected,
  strings = MENTION_STRINGS_EN,
}: {
  people: readonly MentionPerson[];
  /** 常駐的群組:不受搜尋影響,永遠釘在清單最底下 */
  groups: readonly MentionGroup[];
  query: string;
  onQueryChange: (q: string) => void;
  onPickPerson: (username: string) => void;
  onPickGroup: (key: string) => void;
  /** 已選的人與群組(key)—— 可以複選的地方(通知人員)在那一列打勾;聊天不傳 */
  selected?: ReadonlySet<string>;
  strings?: MentionListStrings;
}) {
  /*
   * 撞名比對的名單:整份名冊(含自己)併上這份選單的人。名冊外的人(例如已離職、但還是對話成員的)
   * 也要互相比到;沒併的話名冊一載到就只比名冊,那些人同名也不補帳號。
   * 名冊與 people 都沒變就是同一份陣列,`personDescription` 的快取才吃得到。
   */
  const roster = allPeople();
  const compareWith = useMemo(() => {
    const known = new Set(roster.map((p) => p.username.toLowerCase()));
    const extra = people.filter((p) => !known.has(p.username.toLowerCase()));
    return extra.length ? [...roster, ...extra] : roster.length ? roster : people;
  }, [roster, people]);
  const shown = filterPeople(people, query);
  const check = (key: string) => (selected?.has(key) ? <Icon icon={Check} size="sm" /> : undefined);
  return (
    <VStack gap={1} xstyle={styles.panel} {...{'data-thin-scrollbar': ''}}>
      <TextInput
        label={strings.search}
        isLabelHidden
        value={query}
        // ⚠️ 原樣進 state:注音的還原在 `filterPeople` 裡做(想搜 jacky
        // 不必先切輸入法),在這裡改寫會把輸入法的組字打斷
        onChange={onQueryChange}
        placeholder={strings.search}
        // Popover 自己會聚焦「第一個可聚焦元素」,但那可能是它隱藏的關閉鈕 ——
        // 搜尋框自己再要一次,打開就能直接打字
        hasAutoFocus
        hasClear
      />
      {/*
        清單掛 `role="listbox"`、每一列掛 `role="option"`:
        這不只是語意 —— 全站「會滑的高亮 + hover 變粗」認的就是這兩個角色
        (global.css 的 hover 規則與 MenuHighlightLayer 的委派),掛上去
        這個浮層就跟其他選單同一套效果,不必自己再畫一份。
        ⚠️ label/description 給**字串**:Item 在有 role 時把標籤放進
        素的 span(字重靠繼承),包 <Text> 的話 hover 變粗的規則蓋不進去。
      */}
      {shown.length === 0 ? (
        <Text type="supporting" color="secondary">
          {strings.empty}
        </Text>
      ) : (
        <VStack gap={0} role="listbox" aria-label={strings.people} aria-multiselectable={selected ? true : undefined}>
          {shown.map((p) => {
            const label = personName(p.display_name || p.username);
            return (
              <Item
                key={p.username}
                role="option"
                aria-selected={selected ? selected.has(p.username) : undefined}
                density="compact"
                onClick={() => onPickPerson(p.username)}
                label={label}
                // 撞名的話補 `· @帳號`(兩位同名同職稱的同事要分得開)。比的是**整份**名單(見 compareWith)
                // 不是 `shown`:不然搜尋把另一位濾掉時,這一列的副標會跟著跳
                description={personDescription(compareWith, p.username, label, p.role)}
                endContent={check(p.username)}
              />
            );
          })}
        </VStack>
      )}
      {/* 常駐群組:**搜尋打錯字也要在** —— 它們不進 filterPeople,釘在最底下,跟上面的名單用一條線分開 */}
      <Divider />
      <VStack gap={0} role="listbox" aria-label={strings.groups} aria-multiselectable={selected ? true : undefined}>
        {groups.map((g) => (
          <Item
            key={g.key}
            role="option"
            aria-selected={selected ? selected.has(g.key) : undefined}
            density="compact"
            onClick={() => onPickGroup(g.key)}
            label={g.label}
            description={g.description}
            endContent={check(g.key)}
          />
        ))}
      </VStack>
    </VStack>
  );
}

const styles = stylex.create({
  panel: {
    width: 260,
    maxHeight: 320,
    overflowY: 'auto',
    padding: 'var(--spacing-1)',
  },
});
