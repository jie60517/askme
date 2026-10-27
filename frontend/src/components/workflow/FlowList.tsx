/**
 * Work Flow 的流程清單(`/workflow`):有哪些流程、排程、下次與上次執行,排程開關直接在這裡切。
 * 點一列進 `/workflow/:id` 的編輯器。
 *
 * 點表頭排序、拖表頭改欄寬:全站資料表共用的 `components/tableKit.ts`(規則寫在那裡)。
 */
import {useMemo, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {ContextMenu} from '@astryxdesign/core/ContextMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {Switch} from '@astryxdesign/core/Switch';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Pencil, Trash2} from 'lucide-react';
import {Table, proportional, useTableSelection, useTableSelectionState, type TableColumn, type TablePlugin} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';

import type {WorkflowSummary} from '../../lib/workflowApi';
import {formatWhen, scheduleShort} from '../../lib/workflowGraph';
import {TableCard} from '../TableCard';
import {SELECTION_COLUMN_PX, useCompactTableSync, useTableKit} from '../tableKit';
import {StatusPill} from './RunPanels';

type Row = WorkflowSummary & {[key: string]: unknown};

/**
 * 每一欄最窄多少(px)。值是照欄位裡最寬的那段字量的(「10/1(四) 02:00」、「週一至五 22:30」)。
 * 份數與最小寬要配:表格會把「一份」撐到「最小寬 ÷ 份數」最大的那個值(開關給 0.6 份、最少 88px
 * 的話一份就被撐成 147px,整張表 851px)。
 */
const MIN_PX: Record<string, number> = {name: 160, schedule: 104, next_run_at: 112, last_status: 112, on: 88};
/** 五欄(加最前面的勾選框)都放得下要多寬;不到就改成兩欄(開關會被擠到捲動區外面) */
const MIN_TOTAL_PX = Object.values(MIN_PX).reduce((a, b) => a + b, 0) + SELECTION_COLUMN_PX;
/** 窄的時候只留這兩欄:流程(底下再寫排程與上次結果)、排程開關 */
const COMPACT_KEYS = new Set(['name', 'on']);

/** 排序。沒有值的(從未執行、沒排程)升降冪都排最後,見 EMPTY_LAST */
const byTime = (a: string | null, b: string | null) => (a ? Date.parse(a) : Infinity) - (b ? Date.parse(b) : Infinity);
const COMPARATORS = {
  name: (a: Row, b: Row) => a.name.localeCompare(b.name, 'zh-Hant'),
  // 排程:有開的在前,再照下次執行
  schedule: (a: Row, b: Row) => Number(!a.schedule?.on) - Number(!b.schedule?.on) || byTime(a.next_run_at, b.next_run_at),
  next_run_at: (a: Row, b: Row) => byTime(a.next_run_at, b.next_run_at),
  // 上次執行:照時間(欄位裡看得到的那個時間)
  last_status: (a: Row, b: Row) => byTime(a.last_run_at, b.last_run_at),
  on: (a: Row, b: Row) => Number(!!b.schedule?.on) - Number(!!a.schedule?.on),
};
const EMPTY_LAST = {
  next_run_at: (r: Row) => !r.next_run_at,
  last_status: (r: Row) => !r.last_run_at,
};

/** 排程那段字:沒開的話灰色。寬螢幕是自己一欄,手機寫在名稱底下 —— 兩處同一個樣子。 */
function ScheduleText({row}: {row: WorkflowSummary}) {
  return (
    <Text type="supporting" color={row.schedule?.on ? undefined : 'secondary'}>
      {scheduleShort(row.schedule)}
    </Text>
  );
}

export function FlowList({
  rows,
  offsetMin,
  onOpen,
  onSwitch,
  onRename,
  onDelete,
  isNarrow,
  selectedIds,
  onSelectedIdsChange,
}: {
  rows: WorkflowSummary[];
  /**
   * 勾選了哪幾個流程(id 字串)。表格最前面一欄是勾選框,表頭可以全選;勾了之後在頁首一次刪掉(呼叫端)。
   */
  selectedIds: Set<string>;
  onSelectedIdsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** 手機:只留「流程」與開關兩欄,排程與上次結果寫在名稱底下(五欄擠不下,開關會被推到畫面外) */
  isNarrow: boolean;
  offsetMin: number;
  onOpen: (id: number) => void;
  /** 排程開關。回傳的 promise 結束前開關顯示轉圈 */
  onSwitch: (id: number, on: boolean) => Promise<void>;
  /** 右鍵 → 重新命名(名稱那格就地變成輸入框) */
  onRename: (id: number, name: string) => void;
  /** 右鍵 → 刪除(確認框在呼叫端) */
  onDelete: (row: WorkflowSummary) => void;
}) {
  /** 滑鼠停在哪一列:右鍵選單是整張表共用一個,開的時候看這個決定是哪一個流程 */
  const [menuRow, setMenuRow] = useState<WorkflowSummary | null>(null);
  /**
   * 按右鍵那一刻停在哪一列 —— 選單的內容照**這個**畫,不照 menuRow。
   * ⚠️ 選單開著的時候滑鼠一移出表格 menuRow 就清成 null,照它畫的話選單會變成一個空殼
   * 留在畫面上(列上浮著一個白色小框)。
   */
  const [openRow, setOpenRow] = useState<WorkflowSummary | null>(null);
  /** 正在改名的那一列,與輸入框裡的字 */
  const [renaming, setRenaming] = useState<{id: number; name: string} | null>(null);
  // 同一次改名只收尾一次:Enter / Esc 之後輸入框消失還會送一次 blur,那時 state 還沒更新,
  // 照 state 判斷的話 Esc 後又被存一次、Enter 後存兩次
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const finishRename = (keep: boolean) => {
    const cur = renamingRef.current;
    if (!cur) return;
    renamingRef.current = null;
    const name = cur.name.trim();
    const row = rows.find((r) => r.id === cur.id);
    setRenaming(null);
    if (keep && name && row && name !== row.name) onRename(cur.id, name);
  };
  // 放不下五欄的最小寬(視窗不寬、側邊欄又開著)就改成跟手機一樣的兩欄。寬度是 tableKit 量的
  const [isCompact, setIsCompact] = useState(isNarrow);

  const columns = useMemo<TableColumn<Row>[]>(() => {
    const all: TableColumn<Row>[] = [
      {
        key: 'name',
        header: '流程',
        width: proportional(2, {minWidth: MIN_PX.name}),
        renderCell: (r) => (
          <VStack gap={0.5} xstyle={styles.nameCell}>
            {renaming?.id === r.id ? (
              <TextInput
                label="流程名稱"
                isLabelHidden
                size="sm"
                value={renaming.name}
                hasAutoFocus
                onChange={(name: string) => setRenaming({id: r.id, name})}
                onEnter={() => finishRename(true)}
                onBlur={() => finishRename(true)}
                onKeyDown={(e: React.KeyboardEvent) => e.key === 'Escape' && finishRename(false)}
              />
            ) : (
              <Text type="body" weight="semibold" xstyle={styles.clip}>
                {r.name}
              </Text>
            )}
            {r.path.length ? (
              <Text type="supporting" color="secondary" xstyle={styles.clip}>
                {r.path.join(' → ')}
              </Text>
            ) : null}
            {isCompact ? (
              <HStack gap={2} vAlign="center">
                <ScheduleText row={r} />
                {r.last_status ? <StatusPill status={r.last_status} /> : null}
              </HStack>
            ) : null}
          </VStack>
        ),
      },
      {
        key: 'schedule',
        header: '排程',
        width: proportional(1.04, {minWidth: MIN_PX.schedule}),
        renderCell: (r) => <ScheduleText row={r} />,
      },
      {
        key: 'next_run_at',
        header: '下次執行',
        width: proportional(1.12, {minWidth: MIN_PX.next_run_at}),
        renderCell: (r) => (
          <Text type="supporting" color={r.next_run_at ? undefined : 'secondary'} xstyle={styles.num}>
            {r.next_run_at ? formatWhen(new Date(r.next_run_at), offsetMin) : '—'}
          </Text>
        ),
      },
      {
        key: 'last_status',
        header: '上次執行',
        width: proportional(1.2, {minWidth: MIN_PX.last_status}),
        renderCell: (r) =>
          r.last_status ? (
            <VStack gap={0.5} xstyle={styles.last}>
              <StatusPill status={r.last_status} />
              {r.last_run_at && r.last_status !== 'running' ? (
                <Text type="supporting" color="secondary" xstyle={styles.num}>
                  {formatWhen(new Date(r.last_run_at), offsetMin)}
                </Text>
              ) : null}
            </VStack>
          ) : (
            <Text type="supporting" color="secondary">
              從未執行
            </Text>
          ),
      },
      {
        key: 'on',
        header: '排程開關',
        width: proportional(0.88, {minWidth: MIN_PX.on}),
        renderCell: (r) => (
          <Switch
            label={`${r.name} 排程開關`}
            isLabelHidden
            size="sm"
            value={!!r.schedule?.on}
            changeAction={(on: boolean) => onSwitch(r.id, on)}
          />
        ),
      },
    ];
    return isCompact ? all.filter((c) => COMPACT_KEYS.has(c.key)) : all;
    // finishRename 每次 render 都是新的,但它讀的就是 renaming 與 rows,跟著這兩個重建就夠
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsetMin, onSwitch, isCompact, renaming, rows]);

  const table = useTableKit<Row>({storageKey: 't100_workflow_list_col_px', columns, data: rows as Row[], comparators: COMPARATORS, emptyLast: EMPTY_LAST, isResizable: !isCompact, reservedPx: SELECTION_COLUMN_PX});
  // layout effect:畫出來之前就切好,窄的容器不會先閃一格五欄
  useCompactTableSync(setIsCompact, isNarrow, table.tableWidth, MIN_TOTAL_PX);

  // 勾選框那一欄(設計系統的勾選外掛):全選只選畫面上這幾列
  const {selectionConfig} = useTableSelectionState<Row>({
    data: table.data,
    idKey: rowKey,
    selectedKeys: selectedIds,
    setSelectedKeys: onSelectedIdsChange,
  });
  const selection = useTableSelection<Row>({...selectionConfig, getRowLabel: rowLabel});

  const rowClick = useMemo<TablePlugin<Row>>(
    () => ({
      transformBodyRow: (props, item) => ({
        ...props,
        xstyle: [...props.xstyle, styles.clickable],
        htmlProps: {
          ...props.htmlProps,
          // 點到排程開關是切開關、點到勾選框那一格是勾選,都不是打開流程;改名中的那一列點了也不打開
          onClick: (e: React.MouseEvent) => {
            const t = e.target as HTMLElement;
            if (t.closest('input, label, [role="switch"], [role="menu"]') || isSelectCell(t) || renaming?.id === item.id) return;
            onOpen(item.id);
          },
          // 右鍵選單要知道是哪一列:滑鼠移上去就記住(右鍵之前一定先移上去過)
          onPointerEnter: () => setMenuRow(item),
        },
      }),
    }),
    [onOpen, renaming],
  );
  const menuItems = openRow
    ? [
        {
          label: '重新命名',
          icon: <Icon icon={Pencil} size="sm" />,
          onClick: () => setRenaming({id: openRow.id, name: openRow.name}),
        },
        {
          label: '刪除',
          icon: <Icon icon={Trash2} size="sm" />,
          variant: 'destructive' as const,
          onClick: () => onDelete(openRow),
        },
      ]
    : [];
  return (
    <Stack
      ref={table.wrapRef}
      {...table.wrapProps}
      onPointerLeave={() => setMenuRow(null)}
      // capture:趕在 ContextMenu 打開之前把這一列固定下來
      onContextMenuCapture={() => setOpenRow(menuRow)}
    >
      {/* 表頭與空白處沒有對到流程:交回瀏覽器自己的右鍵選單 */}
      <ContextMenu items={menuItems} isDisabled={!menuRow} label={openRow ? `「${openRow.name}」` : '流程'} menuWidth={160}>
        <TableCard>
          <Table<Row>
            data={table.data}
            columns={table.columns}
            idKey="id"
            density="balanced"
            dividers="rows"
            hasHover
            plugins={{...table.plugins, selection, rowClick}}
          />
        </TableCard>
      </ContextMenu>
    </Stack>
  );
}

// 勾選外掛的列鍵與讀給螢幕閱讀器的名字。放模組層:外掛照 idKey 的參考決定要不要重建,寫在 render 裡每次都是新的
const rowKey = (r: Row) => String(r.id);
const rowLabel = (r: Row) => r.name;

/** 點在勾選框那一格(第一格)的空白處:當成勾選那一欄,不打開流程 —— 勾選框很小,點偏一點不該整頁跳走 */
function isSelectCell(t: HTMLElement): boolean {
  const cell = t.closest('td');
  return !!cell && cell === cell.parentElement?.firstElementChild && !!cell.querySelector('input[type="checkbox"]');
}

const styles = stylex.create({
  clickable: {cursor: 'pointer'},
  nameCell: {minWidth: 0},
  clip: {whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'},
  num: {fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap'},
  last: {alignItems: 'flex-start'},
});
