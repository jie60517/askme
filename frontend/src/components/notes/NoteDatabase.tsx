/**
 * 筆記裡的資料庫,照 Notion 的 inline database:
 *   - 上面:資料庫名稱、檢視(表格 / 看板,可以多開幾個)、篩選、排序、新增一列。
 *   - 表格:每一格直接改;欄名點開可以改名、換類型、排序、編輯選項、刪除;最右邊「＋」加一欄;每一列左邊「⋯」打開成一頁 / 刪除。
 *   - 看板:依一個「選項」欄分組,卡片拖到別欄就是改那一格;每欄最下面「新增」。
 * 欄位類型:標題、文字、數字、選項、多選、日期、勾選、人員。
 *
 * 整個資料庫存在節點的 data 屬性(`databaseModel.ts`),所以跟著筆記一起存、一起復原 / 重做。
 * 唯讀時只能看、能切檢視(檢視不寫回去)。
 */
import {useMemo, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Popover} from '@astryxdesign/core/Popover';
import {Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {NodeViewWrapper, type NodeViewProps} from '@tiptap/react';
import {ArrowDownUp, Check, Ellipsis, FileText, Filter as FilterIcon, KanbanSquare, Plus, Table2, Trash2, X} from 'lucide-react';

import {UNTITLED} from '../../lib/notebookApi';
import {allPeople} from '../../lib/peopleDirectory';
import {
  cellText,
  COLUMN_TYPE_LABELS,
  newId,
  OPTION_COLORS,
  parseDatabase,
  visibleRows,
  type CellValue,
  type Column,
  type ColumnType,
  type DatabaseData,
  type Filter,
  type FilterOp,
  type Row,
  type SelectOption,
  type View,
} from './databaseModel';
import {useNoteHost} from './noteHost';

const styles = stylex.create({
  root: {marginBlock: 'var(--spacing-4)'},
  scroll: {overflowX: 'auto', maxWidth: '100%'},
  board: {overflowX: 'auto', paddingBottom: 'var(--spacing-2)'},
  lane: {flex: '1 0 180px', maxWidth: 280},
  laneDrop: {
    backgroundColor: 'var(--color-overlay-hover)',
    borderRadius: 'var(--radius-element)',
  },
  pad: {padding: 'var(--spacing-2)'},
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    paddingInline: 'var(--spacing-1-5)',
    borderRadius: 'var(--radius-inner)',
    whiteSpace: 'nowrap',
  },
  cellMin: {minWidth: 140},
  titleCell: {minWidth: 200},
  // 列選單鈕那一欄:格子是 overflow hidden,不給寬度會被表格擠成 24,28 的鈕被裁成一個點
  rowTools: {width: 'var(--spacing-10)', minWidth: 'var(--spacing-10)'},
  // 欄名、選項格是 ghost 鈕,自己有左內距:往左拉回去,字才跟輸入格(標題、文字、數字)對齊(差 12)
  ghostAlign: {marginInlineStart: 'calc(var(--spacing-3) * -1)'},
});

/** 選項的小色塊:Astryx 的文字色 + 底色成對 */
function Chip({option}: {option: SelectOption | undefined}) {
  if (!option) return null;
  return (
    <Stack
      xstyle={styles.chip}
      style={{
        color: `var(--color-text-${option.color})`,
        backgroundColor: `var(--color-background-${option.color})`,
      }}
    >
      <Text type="supporting" color="inherit">
        {option.name || UNTITLED}
      </Text>
    </Stack>
  );
}

const TYPE_ORDER: ColumnType[] = ['text', 'number', 'select', 'multi', 'date', 'checkbox', 'person'];
const FILTER_OPS: {op: FilterOp; label: string}[] = [
  {op: 'contains', label: '包含'},
  {op: 'equals', label: '等於'},
  {op: 'not-empty', label: '有填'},
  {op: 'empty', label: '沒填'},
  {op: 'checked', label: '有勾'},
  {op: 'unchecked', label: '沒勾'},
];

export function NoteDatabaseView({node, updateAttributes, selected}: NodeViewProps) {
  const host = useNoteHost();
  const readOnly = host.readOnly;
  const db = useMemo(() => parseDatabase(String(node.attrs.data ?? '')), [node.attrs.data]);
  // 唯讀的人切檢視不寫回去,記在自己這邊
  const [localView, setLocalView] = useState<string | null>(null);
  const view = db.views.find((v) => v.id === (readOnly ? (localView ?? db.activeView) : db.activeView)) ?? db.views[0];
  const save = (next: DatabaseData) => {
    if (!readOnly) updateAttributes({data: JSON.stringify(next)});
  };
  // 用最新的那一份改(打開成一頁要等建頁回來,那時候閉包裡的 db 已經舊了)
  const latest = useRef(db);
  latest.current = db;
  const patch = (fn: (d: DatabaseData) => DatabaseData) => save(fn(structuredClone(latest.current)));
  const patchView = (fn: (v: View) => View) =>
    patch((d) => ({
      ...d,
      views: d.views.map((v) => (v.id === view.id ? fn(v) : v)),
    }));

  const setCell = (rowId: string, colId: string, value: CellValue) =>
    patch((d) => ({
      ...d,
      rows: d.rows.map((r) => (r.id === rowId ? {...r, cells: {...r.cells, [colId]: value}} : r)),
    }));
  const addRow = (cells: Record<string, CellValue> = {}) => patch((d) => ({...d, rows: [...d.rows, {id: newId('r'), cells}]}));
  const deleteRow = (rowId: string) => patch((d) => ({...d, rows: d.rows.filter((r) => r.id !== rowId)}));

  /** 打開成一頁(第一次點才建,放在這則筆記底下;標題用這一列的名稱) */
  const openRow = async (row: Row) => {
    if (row.pageId) return host.openPage(row.pageId);
    const titleCol = db.columns.find((c) => c.type === 'title');
    const page = await host.newSubpage(titleCol ? cellText(titleCol, row.cells[titleCol.id] ?? null) : '');
    if (!page) return;
    patch((d) => ({
      ...d,
      rows: d.rows.map((r) => (r.id === row.id ? {...r, pageId: page.id} : r)),
    }));
    host.openPage(page.id);
  };

  const rows = visibleRows(db, view);

  return (
    <NodeViewWrapper className="note-editor-database" data-selected={selected ? '' : undefined} contentEditable={false}>
      <VStack gap={2} xstyle={styles.root}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <input
              className="note-editor-db-title"
              aria-label="資料庫名稱"
              placeholder="未命名資料庫"
              value={db.title}
              readOnly={readOnly}
              onChange={(e) => patch((d) => ({...d, title: e.target.value}))}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </StackItem>
          <HStack gap={0.5} vAlign="center">
            {db.views.map((v) => (
              <Button
                key={v.id}
                label={v.name}
                size="sm"
                variant={v.id === view.id ? 'secondary' : 'ghost'}
                icon={<Icon icon={v.type === 'board' ? KanbanSquare : Table2} size="sm" />}
                onClick={() => (readOnly ? setLocalView(v.id) : patch((d) => ({...d, activeView: v.id})))}
              />
            ))}
            {!readOnly ? (
              <DropdownMenu
                button={{
                  label: '新增檢視',
                  icon: <Icon icon={Plus} size="sm" />,
                  isIconOnly: true,
                  variant: 'ghost',
                  size: 'sm',
                }}
                hasChevron={false}
                menuWidth={140}
                items={[
                  {
                    label: '表格',
                    icon: <Icon icon={Table2} size="sm" />,
                    onClick: () => patch((d) => addView(d, 'table')),
                  },
                  {
                    label: '看板',
                    icon: <Icon icon={KanbanSquare} size="sm" />,
                    onClick: () => patch((d) => addView(d, 'board')),
                  },
                ]}
              />
            ) : null}
          </HStack>
          <FilterButton db={db} view={view} readOnly={readOnly} onChange={(filters) => patchView((v) => ({...v, filters}))} />
          <SortButton db={db} view={view} readOnly={readOnly} onChange={(sort) => patchView((v) => ({...v, sort}))} />
          {view.type === 'board' && !readOnly && db.columns.filter((c) => c.type === 'select').length > 1 ? (
            <DropdownMenu
              button={{
                label: `分組:${db.columns.find((c) => c.id === view.groupBy)?.name ?? db.columns.find((c) => c.type === 'select')?.name}`,
                variant: 'ghost',
                size: 'sm',
              }}
              menuWidth={180}
              items={db.columns
                .filter((c) => c.type === 'select')
                .map((c) => ({
                  label: c.name,
                  onClick: () => patchView((v) => ({...v, groupBy: c.id})),
                }))}
            />
          ) : null}
          {/* 看板每一欄底下自己有「新增」 */}
          {!readOnly && view.type !== 'board' ? (
            <Button label="新增" size="sm" variant="secondary" icon={<Icon icon={Plus} size="sm" />} onClick={() => addRow()} />
          ) : null}
        </HStack>

        {view.type === 'board' ? (
          <Board db={db} view={view} rows={rows} readOnly={readOnly} setCell={setCell} addRow={addRow} openRow={openRow} />
        ) : (
          <Stack xstyle={styles.scroll}>
            <Table dividers="rows" textOverflow="wrap">
              <TableHeader>
                <TableRow>
                  {!readOnly ? <TableHeaderCell xstyle={styles.rowTools}>{null}</TableHeaderCell> : null}
                  {db.columns.map((col) => (
                    <TableHeaderCell key={col.id} xstyle={col.type === 'title' ? styles.titleCell : styles.cellMin}>
                      <Stack xstyle={!readOnly && styles.ghostAlign}>
                        <ColumnHeader col={col} readOnly={readOnly} patch={patch} patchView={patchView} />
                      </Stack>
                    </TableHeaderCell>
                  ))}
                  {!readOnly ? (
                    <TableHeaderCell xstyle={styles.rowTools}>
                      <IconButton
                        label="新增一欄"
                        size="sm"
                        variant="ghost"
                        icon={<Icon icon={Plus} size="sm" />}
                        onClick={() =>
                          patch((d) => ({
                            ...d,
                            columns: [
                              ...d.columns,
                              {
                                id: newId('c'),
                                name: `欄位 ${d.columns.length + 1}`,
                                type: 'text',
                              },
                            ],
                          }))
                        }
                      />
                    </TableHeaderCell>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    {!readOnly ? (
                      <TableCell>
                        <Stack className="note-editor-db-hover">
                          <DropdownMenu
                            button={{
                              label: '這一列',
                              icon: <Icon icon={Ellipsis} size="sm" />,
                              isIconOnly: true,
                              variant: 'ghost',
                              size: 'sm',
                            }}
                            hasChevron={false}
                            menuWidth={160}
                            items={[
                              {
                                label: '打開成一頁',
                                icon: <Icon icon={FileText} size="sm" />,
                                onClick: () => void openRow(row),
                              },
                              {
                                label: '刪除這一列',
                                icon: <Icon icon={Trash2} size="sm" />,
                                variant: 'destructive',
                                onClick: () => deleteRow(row.id),
                              },
                            ]}
                          />
                        </Stack>
                      </TableCell>
                    ) : null}
                    {db.columns.map((col) => (
                      <TableCell key={col.id}>
                        <CellEditor
                          col={col}
                          value={row.cells[col.id] ?? null}
                          readOnly={readOnly}
                          onChange={(v) => setCell(row.id, col.id, v)}
                          onOpen={col.type === 'title' ? () => void openRow(row) : undefined}
                        />
                      </TableCell>
                    ))}
                    {!readOnly ? <TableCell>{null}</TableCell> : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Stack>
        )}
        {!rows.length ? (
          <Text type="supporting" color="secondary">
            {db.rows.length ? '沒有符合篩選的列' : '還沒有資料'}
          </Text>
        ) : null}
      </VStack>
    </NodeViewWrapper>
  );
}

function addView(d: DatabaseData, type: View['type']): DatabaseData {
  const select = d.columns.find((c) => c.type === 'select');
  const v: View = {
    id: newId('v'),
    name: type === 'board' ? '看板' : '表格',
    type,
    groupBy: type === 'board' ? (select?.id ?? null) : null,
  };
  return {...d, views: [...d.views, v], activeView: v.id};
}

/** 一格:依欄位類型換輸入方式 */
function CellEditor({
  col,
  value,
  readOnly,
  onChange,
  onOpen,
}: {
  col: Column;
  value: CellValue;
  readOnly: boolean;
  onChange: (v: CellValue) => void;
  /** 標題欄:旁邊一顆「打開」 */
  onOpen?: () => void;
}) {
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  switch (col.type) {
    case 'title':
    case 'text':
      return (
        <HStack gap={1} vAlign="center">
          <StackItem size="fill">
            <input
              className="note-editor-db-input"
              aria-label={col.name}
              placeholder={col.type === 'title' ? UNTITLED : undefined}
              value={String(value ?? '')}
              readOnly={readOnly}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={stop}
            />
          </StackItem>
          {onOpen ? (
            <Stack className="note-editor-db-hover">
              <Button label="打開" size="sm" variant="secondary" icon={<Icon icon={FileText} size="sm" />} onClick={onOpen} />
            </Stack>
          ) : null}
        </HStack>
      );
    case 'number':
      return (
        <input
          className="note-editor-db-input"
          aria-label={col.name}
          inputMode="decimal"
          value={value == null ? '' : String(value)}
          readOnly={readOnly}
          onChange={(e) => {
            const raw = e.target.value.trim();
            const n = Number(raw);
            onChange(raw === '' ? null : Number.isFinite(n) ? n : raw);
          }}
          onKeyDown={stop}
        />
      );
    case 'date':
      // 空的日期格平常不出「年/月/日」與日曆圖示,滑過那一列才出來(每一列都掛著太吵)
      return (
        <Stack className={value ? undefined : 'note-editor-db-hover'}>
          <input
            className="note-editor-db-input"
            type="date"
            aria-label={col.name}
            value={String(value ?? '')}
            readOnly={readOnly}
            onChange={(e) => onChange(e.target.value || null)}
            onKeyDown={stop}
          />
        </Stack>
      );
    case 'checkbox':
      return (
        <CheckboxInput label={col.name} isLabelHidden value={!!value} isDisabled={readOnly} onChange={(checked) => onChange(checked)} />
      );
    case 'select': {
      const current = col.options?.find((o) => o.id === value);
      if (readOnly) return <Chip option={current} />;
      return (
        <HStack xstyle={styles.ghostAlign} className={current ? undefined : 'note-editor-db-hover'}>
          <DropdownMenu
            button={{
              label: current?.name || '選擇',
              variant: 'ghost',
              size: 'sm',
            }}
            hasChevron={false}
            menuWidth={180}
            items={[
              ...(col.options ?? []).map((o) => ({
                label: o.name || UNTITLED,
                icon: current?.id === o.id ? <Icon icon={Check} size="sm" /> : undefined,
                onClick: () => onChange(o.id),
              })),
              {type: 'divider' as const},
              {label: '清除', onClick: () => onChange(null)},
            ]}
          />
        </HStack>
      );
    }
    case 'multi': {
      const picked = Array.isArray(value) ? value : [];
      if (readOnly)
        return (
          <HStack gap={1} wrap="wrap">
            {picked.map((id) => (
              <Chip key={id} option={col.options?.find((o) => o.id === id)} />
            ))}
          </HStack>
        );
      return (
        <HStack xstyle={styles.ghostAlign} className={picked.length ? undefined : 'note-editor-db-hover'}>
          <DropdownMenu
            button={{
              label: cellText(col, picked) || '選擇',
              variant: 'ghost',
              size: 'sm',
            }}
            hasChevron={false}
            menuWidth={180}
            items={(col.options ?? []).map((o) => ({
              label: o.name || UNTITLED,
              hasCloseOnSelect: false,
              icon: picked.includes(o.id) ? <Icon icon={Check} size="sm" /> : undefined,
              onClick: () => onChange(picked.includes(o.id) ? picked.filter((p) => p !== o.id) : [...picked, o.id]),
            }))}
          />
        </HStack>
      );
    }
    case 'person': {
      const name = value ? personName(String(value)) : '';
      if (readOnly) return <Text>{name}</Text>;
      return (
        <HStack xstyle={styles.ghostAlign} className={name ? undefined : 'note-editor-db-hover'}>
          <DropdownMenu
            button={{label: name || '選擇', variant: 'ghost', size: 'sm'}}
            hasChevron={false}
            menuWidth={200}
            items={[
              ...allPeople().map((p) => ({
                label: p.display_name || p.username,
                onClick: () => onChange(p.username),
              })),
              {type: 'divider' as const},
              {label: '清除', onClick: () => onChange(null)},
            ]}
          />
        </HStack>
      );
    }
  }
}

function personName(username: string): string {
  const p = allPeople().find((x) => x.username === username);
  return p?.display_name || username;
}

/** 欄名:點開改名、換類型、排序、編輯選項、刪除 */
function ColumnHeader({
  col,
  readOnly,
  patch,
  patchView,
}: {
  col: Column;
  readOnly: boolean;
  patch: (fn: (d: DatabaseData) => DatabaseData) => void;
  patchView: (fn: (v: View) => View) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const setCol = (fn: (c: Column) => Column) =>
    patch((d) => ({
      ...d,
      columns: d.columns.map((c) => (c.id === col.id ? fn(c) : c)),
    }));
  if (readOnly) return <Text weight="semibold">{col.name}</Text>;
  if (renaming)
    return (
      <TextInput
        label="欄位名稱"
        isLabelHidden
        size="sm"
        value={col.name}
        hasAutoFocus
        onChange={(name) => setCol((c) => ({...c, name}))}
        onEnter={() => setRenaming(false)}
        onBlur={() => setRenaming(false)}
      />
    );
  return (
    <Popover
      label="編輯選項"
      isOpen={optionsOpen}
      onOpenChange={setOptionsOpen}
      width={280}
      content={<OptionsEditor col={col} onChange={(options) => setCol((c) => ({...c, options}))} />}
    >
      <DropdownMenu
        button={{label: col.name, variant: 'ghost', size: 'sm'}}
        hasChevron={false}
        menuWidth={200}
        items={[
          {label: '重新命名', onClick: () => setRenaming(true)},
          ...(col.type !== 'title'
            ? [
                {
                  type: 'section' as const,
                  title: '類型',
                  items: TYPE_ORDER.map((t) => ({
                    label: COLUMN_TYPE_LABELS[t],
                    icon: col.type === t ? <Icon icon={Check} size="sm" /> : undefined,
                    onClick: () =>
                      setCol((c) => ({
                        ...c,
                        type: t,
                        options: t === 'select' || t === 'multi' ? (c.options ?? []) : c.options,
                      })),
                  })),
                },
              ]
            : []),
          ...(col.type === 'select' || col.type === 'multi' ? [{label: '編輯選項', onClick: () => setOptionsOpen(true)}] : []),
          {type: 'divider' as const},
          {
            label: '遞增排序',
            onClick: () =>
              patchView((v) => ({
                ...v,
                sort: {column: col.id, dir: 'asc'},
              })),
          },
          {
            label: '遞減排序',
            onClick: () =>
              patchView((v) => ({
                ...v,
                sort: {column: col.id, dir: 'desc'},
              })),
          },
          ...(col.type !== 'title'
            ? [
                {type: 'divider' as const},
                {
                  label: '刪除欄位',
                  variant: 'destructive' as const,
                  onClick: () =>
                    patch((d) => ({
                      ...d,
                      columns: d.columns.filter((c) => c.id !== col.id),
                      views: d.views.map((v) => ({
                        ...v,
                        sort: v.sort?.column === col.id ? null : v.sort,
                        filters: (v.filters ?? []).filter((f) => f.column !== col.id),
                        groupBy: v.groupBy === col.id ? null : v.groupBy,
                      })),
                    })),
                },
              ]
            : []),
        ]}
      />
    </Popover>
  );
}

/** 選項欄的選項:改名、換顏色、刪除、新增 */
function OptionsEditor({col, onChange}: {col: Column; onChange: (options: SelectOption[]) => void}) {
  const options = col.options ?? [];
  const set = (id: string, patch: Partial<SelectOption>) => onChange(options.map((o) => (o.id === id ? {...o, ...patch} : o)));
  return (
    <VStack gap={2} xstyle={styles.pad}>
      {options.map((o) => (
        <HStack key={o.id} gap={1} vAlign="center">
          <StackItem size="fill">
            <TextInput label="選項名稱" isLabelHidden size="sm" value={o.name} onChange={(name) => set(o.id, {name})} />
          </StackItem>
          <DropdownMenu
            button={{label: '顏色', variant: 'ghost', size: 'sm'}}
            hasChevron={false}
            menuWidth={140}
            items={OPTION_COLORS.map((c) => ({
              label: c,
              endContent: <Chip option={{id: c, name: '●', color: c}} />,
              onClick: () => set(o.id, {color: c}),
            }))}
          />
          <IconButton
            label="刪除選項"
            size="sm"
            variant="ghost"
            icon={<Icon icon={X} size="sm" />}
            onClick={() => onChange(options.filter((x) => x.id !== o.id))}
          />
        </HStack>
      ))}
      <Button
        label="新增選項"
        size="sm"
        variant="ghost"
        icon={<Icon icon={Plus} size="sm" />}
        onClick={() =>
          onChange([
            ...options,
            {
              id: newId('o'),
              name: '',
              color: OPTION_COLORS[options.length % OPTION_COLORS.length],
            },
          ])
        }
      />
    </VStack>
  );
}

function FilterButton({
  db,
  view,
  readOnly,
  onChange,
}: {
  db: DatabaseData;
  view: View;
  readOnly: boolean;
  onChange: (filters: Filter[]) => void;
}) {
  const filters = view.filters ?? [];
  if (readOnly && !filters.length) return null;
  return (
    <Popover
      label="篩選"
      width={420}
      content={
        <VStack gap={2} xstyle={styles.pad}>
          {filters.map((f, i) => {
            const col = db.columns.find((c) => c.id === f.column);
            const set = (patch: Partial<Filter>) => onChange(filters.map((x, j) => (j === i ? {...x, ...patch} : x)));
            return (
              <HStack key={i} gap={1} vAlign="center">
                <DropdownMenu
                  button={{
                    label: col?.name ?? '欄位',
                    variant: 'ghost',
                    size: 'sm',
                  }}
                  menuWidth={160}
                  items={db.columns.map((c) => ({
                    label: c.name,
                    onClick: () => set({column: c.id}),
                  }))}
                />
                <DropdownMenu
                  button={{
                    label: FILTER_OPS.find((o) => o.op === f.op)?.label ?? '',
                    variant: 'ghost',
                    size: 'sm',
                  }}
                  menuWidth={120}
                  items={FILTER_OPS.map((o) => ({
                    label: o.label,
                    onClick: () => set({op: o.op}),
                  }))}
                />
                {f.op === 'contains' || f.op === 'equals' ? (
                  <StackItem size="fill">
                    {col && (col.type === 'select' || col.type === 'multi') ? (
                      <DropdownMenu
                        button={{
                          label: col.options?.find((o) => o.id === f.value)?.name ?? '選一個',
                          variant: 'ghost',
                          size: 'sm',
                        }}
                        menuWidth={160}
                        items={(col.options ?? []).map((o) => ({
                          label: o.name || UNTITLED,
                          onClick: () => set({value: o.id, op: 'equals'}),
                        }))}
                      />
                    ) : (
                      <TextInput label="值" isLabelHidden size="sm" value={f.value ?? ''} onChange={(value) => set({value})} />
                    )}
                  </StackItem>
                ) : (
                  <StackItem size="fill">{null}</StackItem>
                )}
                <IconButton
                  label="移除這個條件"
                  size="sm"
                  variant="ghost"
                  icon={<Icon icon={X} size="sm" />}
                  onClick={() => onChange(filters.filter((_, j) => j !== i))}
                />
              </HStack>
            );
          })}
          <Button
            label="新增條件"
            size="sm"
            variant="ghost"
            icon={<Icon icon={Plus} size="sm" />}
            onClick={() => onChange([...filters, {column: db.columns[0]?.id ?? '', op: 'contains', value: ''}])}
          />
        </VStack>
      }
    >
      <Button
        label={filters.length ? `篩選 ${filters.length}` : '篩選'}
        size="sm"
        variant={filters.length ? 'secondary' : 'ghost'}
        icon={<Icon icon={FilterIcon} size="sm" />}
      />
    </Popover>
  );
}

function SortButton({
  db,
  view,
  readOnly,
  onChange,
}: {
  db: DatabaseData;
  view: View;
  readOnly: boolean;
  onChange: (sort: View['sort']) => void;
}) {
  const sort = view.sort;
  const col = sort ? db.columns.find((c) => c.id === sort.column) : undefined;
  if (readOnly && !sort) return null;
  return (
    <DropdownMenu
      button={{
        label: col ? `排序:${col.name}${sort?.dir === 'desc' ? ' ↓' : ' ↑'}` : '排序',
        variant: col ? 'secondary' : 'ghost',
        size: 'sm',
        icon: <Icon icon={ArrowDownUp} size="sm" />,
      }}
      menuWidth={200}
      items={[
        ...db.columns.flatMap((c) => [
          {
            label: `${c.name} 遞增`,
            onClick: () => onChange({column: c.id, dir: 'asc'}),
          },
          {
            label: `${c.name} 遞減`,
            onClick: () => onChange({column: c.id, dir: 'desc'}),
          },
        ]),
        ...(sort ? [{type: 'divider' as const}, {label: '不排序', onClick: () => onChange(null)}] : []),
      ]}
    />
  );
}

/** 看板:依一個選項欄分組;卡片拖到別欄 = 改那一格 */
function Board({
  db,
  view,
  rows,
  readOnly,
  setCell,
  addRow,
  openRow,
}: {
  db: DatabaseData;
  view: View;
  rows: Row[];
  readOnly: boolean;
  setCell: (rowId: string, colId: string, value: CellValue) => void;
  addRow: (cells?: Record<string, CellValue>) => void;
  openRow: (row: Row) => Promise<void>;
}) {
  const [over, setOver] = useState<string | null>(null);
  const group = db.columns.find((c) => c.id === view.groupBy && c.type === 'select') ?? db.columns.find((c) => c.type === 'select');
  const titleCol = db.columns.find((c) => c.type === 'title');
  if (!group) {
    return (
      <Text type="supporting" color="secondary">
        看板要有一個「選項」欄才能分組
      </Text>
    );
  }
  const unsorted = rows.some((r) => !group.options?.some((o) => o.id === r.cells[group.id]));
  const lanes: {id: string | null; option?: SelectOption}[] = [
    ...(unsorted ? [{id: null}] : []),
    ...(group.options ?? []).map((o) => ({id: o.id, option: o})),
  ];
  const others = db.columns.filter((c) => c.id !== group.id && c.type !== 'title');
  return (
    <Stack xstyle={styles.board}>
      <HStack gap={3} vAlign="start">
        {lanes.map((lane) => {
          const laneRows = rows.filter(
            (r) => (r.cells[group.id] ?? null) === lane.id || (lane.id === null && !group.options?.some((o) => o.id === r.cells[group.id])),
          );
          return (
            <Stack
              key={lane.id ?? 'none'}
              xstyle={[styles.lane, over === (lane.id ?? 'none') && styles.laneDrop]}
              onDragOver={(e: React.DragEvent) => {
                if (readOnly || !e.dataTransfer.types.includes('application/x-note-db-row')) return;
                e.preventDefault();
                setOver(lane.id ?? 'none');
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e: React.DragEvent) => {
                const rowId = e.dataTransfer.getData('application/x-note-db-row');
                setOver(null);
                if (rowId) {
                  e.preventDefault();
                  setCell(rowId, group.id, lane.id);
                }
              }}
            >
              <VStack gap={2}>
                <HStack gap={2} vAlign="center">
                  {lane.option ? (
                    <Chip option={lane.option} />
                  ) : (
                    <Text type="supporting" color="secondary">
                      沒有{group.name}
                    </Text>
                  )}
                  <Text type="supporting" color="secondary">
                    {laneRows.length}
                  </Text>
                </HStack>
                {laneRows.map((row) => (
                  <Stack
                    key={row.id}
                    draggable={!readOnly}
                    onDragStart={(e: React.DragEvent) => {
                      e.dataTransfer.setData('application/x-note-db-row', row.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.stopPropagation();
                    }}
                  >
                    <Card padding={2} onClick={() => void openRow(row)}>
                      <VStack gap={1}>
                        <Text weight="medium">{titleCol ? cellText(titleCol, row.cells[titleCol.id] ?? null) || UNTITLED : UNTITLED}</Text>
                        {others.map((c) => {
                          const text = cellText(c, row.cells[c.id] ?? null);
                          return text ? (
                            <Text key={c.id} type="supporting" color="secondary">
                              {c.type === 'person' ? personName(String(row.cells[c.id])) : text}
                            </Text>
                          ) : null;
                        })}
                      </VStack>
                    </Card>
                  </Stack>
                ))}
                {!readOnly ? (
                  <HStack>
                    <Button
                      label="新增"
                      size="sm"
                      variant="ghost"
                      icon={<Icon icon={Plus} size="sm" />}
                      onClick={() => addRow(lane.id ? {[group.id]: lane.id} : {})}
                    />
                  </HStack>
                ) : null}
              </VStack>
            </Stack>
          );
        })}
      </HStack>
    </Stack>
  );
}
