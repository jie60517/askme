/**
 * 拼圖上的設定:欄位直接畫在拼圖上。
 *
 * **欄位照後端 `/catalog` 給的定義畫**(`NodeSpec.fields`,來源是 `app/workflows.py` 的 `NODES`),
 * 這裡不寫「哪種拼圖有哪些欄位」;哪幾個畫在拼圖上由 `INLINE_FIELDS` 決定,沒列到的照後端預設值跑。
 *
 * 指令永遠不會出現在這裡:只有「選清單裡的哪一個」與目錄。
 */
import {useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Popover} from '@astryxdesign/core/Popover';
import {Selector} from '@astryxdesign/core/Selector';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Token} from '@astryxdesign/core/Token';
import {UserPlus, Users} from 'lucide-react';

import {MentionList, type MentionListStrings} from '../MentionList';
import {personName} from '../../lib/people';
import type {FieldSpec} from '../../lib/workflowApi';

type Value = string | number | boolean | string[];

/** 這一頁的介面文字是中文(介面語言的例外見 frontend/.claude/CLAUDE.md) */
const MENTION_STRINGS_ZH: MentionListStrings = {search: '搜尋名字或帳號', empty: '找不到這個人', people: '同事', groups: '群組'};

/**
 * 「通知人員」要 @ 誰。長得像一格輸入框(跟郵件的「收件人」同一種):已選的人 / 群組排成小標籤,
 * **點這一格任何地方**都打開跟聊天同一份的 @ 選單,選單就掛在這一格底下。
 * 可以複選,再點一次取消;標籤上的 × 直接拿掉。群組存群組本身,跑的時候才展開成人。
 *
 *  - 一整格:位置固定、點擊範圍是整格,看得出這一整塊是同一個欄位(不另外放一顆小小的「@ 選人」)。
 *  - 左邊不寫欄位名「通知」:拼圖的標題已經是「通知人員」。
 *  - 沒選任何人的時候格子是空的(只有「加人」),不放「選擇要通知的人」這種說明字(畫面上不放教學文字)。
 * 鍵盤走格子最右邊那顆「加人」(整格本身不是按鈕 —— 裡面的 × 已經是按鈕,按鈕不能包按鈕)。
 *
 * ⚠️ 「加人」在 JSX 裡**排第一個**、畫面上靠 `order` 排到最右邊:設計系統的 Popover 把錨點裡
 * **第一顆按鈕**當成開關(原生的 click 監聽)。排在標籤後面的話,開關會變成第一個標籤的 ×——
 * 點 × 順便開關選單、那顆 × 拿掉之後開關指到已經不在的按鈕。
 */
function PeopleField({field, value, isDisabled, onChange}: {field: FieldSpec; value: string[]; isDisabled: boolean; onChange: (v: string[]) => void}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = field.options ?? [];
  const byValue = new Map(options.map((o) => [o.value, o]));
  const people = options.filter((o) => !o.group).map((o) => ({username: o.value, display_name: o.label, role: o.role}));
  const groups = options
    .filter((o) => o.group)
    .map((o) => ({key: o.value, label: o.label, description: `${o.count ?? 0} 人`}));
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key]);
  const open = (next: boolean) => {
    setIsOpen(next);
    // 每次打開都是乾淨的搜尋框(跟聊天那顆同一個理由)
    if (next) setQuery('');
  };
  return (
    <Popover
      isOpen={isOpen}
      onOpenChange={open}
      label={field.label}
      placement="below"
      alignment="start"
      content={
        <MentionList
          people={people}
          groups={groups}
          query={query}
          onQueryChange={setQuery}
          onPickPerson={toggle}
          onPickGroup={toggle}
          selected={new Set(value)}
          strings={MENTION_STRINGS_ZH}
        />
      }
    >
      <HStack
        gap={1}
        vAlign="center"
        xstyle={[styles.people, isDisabled && styles.peopleDisabled, isOpen && styles.peopleOpen]}
        // 畫布看到 data-field 就不當成「拖拼圖」(見 FlowCanvas 的 onPointerDown),點擊才到得了這一格
        {...{'data-field': ''}}
        // 點格子的空白處也打開。按在按鈕上(加人 = Popover 自己開關、× = 拿掉)不要再開一次,
        // 不然「開著的時候按加人」會關了又馬上打開
        onClick={
          isDisabled
            ? undefined
            : (e: React.MouseEvent) => {
                if (!(e.target as HTMLElement).closest('button')) open(true);
              }
        }
      >
        {isDisabled ? null : (
          <IconButton label="加人" icon={<Icon icon={UserPlus} size="xsm" />} variant="ghost" size="sm" xstyle={styles.addBtn} />
        )}
        <HStack gap={1} wrap="wrap" vAlign="center" xstyle={styles.chips}>
          {value.map((key) => {
              const o = byValue.get(key);
              // 選單裡已經沒有的(帳號停用了):存檔時後端會拿掉,這裡先照帳號名顯示
              const name = o?.group ? o.label : personName(o?.label ?? key);
              return (
                <Token
                  key={key}
                  size="sm"
                  label={name}
                  icon={o?.group ? <Icon icon={Users} size="xsm" /> : undefined}
                  onRemove={isDisabled ? undefined : () => toggle(key)}
                />
              );
            })}
        </HStack>
      </HStack>
    </Popover>
  );
}

/** 一個欄位:照後端給的 `kind` 選輸入元件。`isCompact` = 畫在拼圖上(小一號、標籤另外排)。 */
export function FieldInput({
  field,
  value,
  isDisabled,
  isCompact,
  onChange,
}: {
  field: FieldSpec;
  value: Value | undefined;
  isDisabled: boolean;
  isCompact?: boolean;
  onChange: (v: Value) => void;
}) {
  const size = isCompact ? 'sm' : 'md';
  switch (field.kind) {
    case 'people':
      return <PeopleField field={field} value={Array.isArray(value) ? value : []} isDisabled={isDisabled} onChange={onChange} />;
    case 'pick': {
      const options = field.options ?? [];
      return (
        <Selector
          label={field.label}
          isLabelHidden={isCompact}
          size={size}
          width="100%"
          options={options}
          // 選單一律往下長。不給的話設計系統預設把「選中的那一項」疊在輸入框上,展開時蓋住原本那一格
          placement="below"
          value={String(value ?? '')}
          // 空的時候不放「請選擇」這種教學字;設定檔一個選項都沒有是**狀態**,照講
          placeholder={options.length ? undefined : '設定檔裡還沒有可選的項目'}
          isDisabled={isDisabled || !options.length}
          onChange={(v: string) => onChange(v)}
        />
      );
    }
    case 'bool':
      return (
        <Switch
          label={field.label}
          labelPosition="start"
          labelSpacing="spread"
          value={Boolean(value)}
          onChange={(v: boolean) => onChange(v)}
          isDisabled={isDisabled}
        />
      );
    case 'int':
      return (
        <NumberInput
          label={field.label}
          isLabelHidden={isCompact}
          size={size}
          width="100%"
          value={Number(value ?? field.default)}
          min={field.min}
          max={field.max}
          isIntegerOnly
          onChange={(v: number) => onChange(v)}
          isDisabled={isDisabled}
        />
      );
    default:
      // path:自由文字,後端過白名單
      return (
        <TextInput
          label={field.label}
          isLabelHidden={isCompact}
          size={size}
          width="100%"
          value={String(value ?? '')}
          onChange={(v: string) => onChange(v)}
          isDisabled={isDisabled}
        />
      );
  }
}

/** 拼圖上一列:左邊欄位名,右邊輸入框。 */
export function FieldRow({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <HStack gap={2} vAlign="center" xstyle={styles.row}>
      <Text type="supporting" color="secondary" xstyle={styles.key}>
        {label}
      </Text>
      {/* data-field 掛在整個輸入框那一格,不是只靠控制項本身:下拉選單的外框比裡面那顆按鈕寬
          (右邊的箭頭與留白不在按鈕裡),按在那裡會被畫布當成「拖拼圖」、選單打不開。
          欄位名稱那一格照樣可以拖 */}
      <Stack xstyle={styles.grow} {...{'data-field': ''}}>
        {children}
      </Stack>
    </HStack>
  );
}

const styles = stylex.create({
  grow: {flex: '1 1 0', minWidth: 0},
  row: {minHeight: 28},
  // 欄位名固定寬、輸入框才對齊;放得下五個字
  key: {width: 64, flexShrink: 0, whiteSpace: 'nowrap'},
  // 「通知人員」那一格:長得跟旁邊的輸入框一樣(同樣的框線、圓角、高度),整格都能點
  people: {
    // Popover 的錨點那一層是 flex:要自己撐滿,不然這一格只有標籤那麼寬
    flexGrow: 1,
    minWidth: 0,
    minHeight: 32,
    paddingBlock: 2,
    paddingInlineStart: 'var(--spacing-1-5)',
    paddingInlineEnd: 2,
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    // 觸控點一下會觸發假的 :hover 而且黏住 —— 跟 FlowCanvas 同一個條件(lib/media.ts 的 HOVER_QUERY)
    borderColor: {
      default: 'var(--color-border-emphasized)',
      ':hover': {default: 'var(--color-border-emphasized)', '@media (hover: hover) and (pointer: fine)': 'var(--color-text-secondary)'},
    },
    borderRadius: 'var(--radius-element)',
    backgroundColor: 'var(--color-background-card)',
    cursor: 'pointer',
    transitionProperty: 'border-color',
    transitionDuration: 'var(--duration-fast)',
    transitionTimingFunction: 'var(--ease-standard)',
  },
  peopleOpen: {borderColor: 'var(--color-text-primary)'},
  peopleDisabled: {cursor: 'default', borderColor: 'var(--color-border)', backgroundColor: 'transparent'},
  // 見 PeopleField 的註解:DOM 裡排第一、畫面上排最後
  addBtn: {flexShrink: 0, order: 2},
  chips: {flex: '1 1 0', minWidth: 0, order: 1},
});
