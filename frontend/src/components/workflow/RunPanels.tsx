/**
 * Work Flow 頁的附屬面板:排程(彈出框)、執行中的逐行紀錄(畫布下方的抽屜)、
 * 每一步的輸出、執行紀錄分頁的表格。
 */
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {DateInput} from '@astryxdesign/core/DateInput';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {Switch} from '@astryxdesign/core/Switch';
import {Table, pixel, proportional, type TableColumn, type TablePlugin} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {TimeInput} from '@astryxdesign/core/TimeInput';
import {ToggleButton, ToggleButtonGroup} from '@astryxdesign/core/ToggleButton';
import {Token, type TokenColor} from '@astryxdesign/core/Token';
import type {ISODateString, ISOTimeString} from '@astryxdesign/core/utils';
import {Check, ChevronDown, ChevronUp, X} from 'lucide-react';

import {growStyles} from '../growShell';
import {LoadingScreen} from '../LoadingScreen';
import type {Freq, RunRow, RunStatus, RunView, Schedule} from '../../lib/workflowApi';
import {WEEKDAYS, WEEK_ORDER, firstOnceDate, formatDuration, formatWhen, nextRun, todayIn} from '../../lib/workflowGraph';
import {TableCard} from '../TableCard';
import {useCompactTableSync, useTableKit} from '../tableKit';
import {panelMotion} from './panelMotion';

/** 紀錄抽屜比這個窄就改成兩行一則(時間 · 哪一塊 / 訊息)。三欄是 64 + 108 + 訊息,再窄訊息就放不下 */
const COMPACT_LOG_PX = 520;
/** 離底部這麼近(px)就算「看著最新的」,新的一行進來跟著捲;再上面就是人在讀前面的,不動他 */
const STICK_PX = 24;

// ── 狀態 ─────────────────────────────────────────────────────────────────────

const STATUS: Record<RunStatus, {text: string; color: TokenColor; icon?: typeof Check}> = {
  running: {text: '執行中', color: 'default'},
  ok: {text: '成功', color: 'green', icon: Check},
  fail: {text: '失敗', color: 'red', icon: X},
  stopped: {text: '已停止', color: 'yellow'},
  skipped: {text: '略過', color: 'yellow'},
};

/** 執行結果的小標。狀態一律走 `Token`(設計系統規則:Status = StatusDot/Token)。 */
export function StatusPill({status}: {status: RunStatus}) {
  const s = STATUS[status];
  return <Token size="sm" label={s.text} color={s.color} icon={s.icon ? <Icon icon={s.icon} size="xsm" /> : undefined} />;
}

// ── 排程 ─────────────────────────────────────────────────────────────────────

export function SchedulePanel({
  value,
  offsetMin,
  onChange,
}: {
  value: Schedule;
  /** 排程的時區(後端給的 `utc_offset_min`)。「下次執行」照它算,不照瀏覽器的。 */
  offsetMin: number;
  onChange: (s: Schedule) => void;
}) {
  const set = (patch: Partial<Schedule>) => onChange({...value, ...patch});
  const next = value.on ? nextRun(value, new Date(), offsetMin) : null;
  return (
    <VStack gap={3} xstyle={styles.sched}>
      <Switch label="排程" labelPosition="start" labelSpacing="spread" value={value.on} onChange={(on: boolean) => set({on})} />
      <VStack gap={3} xstyle={[styles.schedBody, !value.on && styles.schedOff]}>
        <SegmentedControl
          label="頻率"
          layout="fill"
          value={value.freq}
          onChange={(f: string) => set(f === 'once' && !value.date ? {freq: 'once', date: firstOnceDate(value.time, offsetMin)} : {freq: f as Freq})}
        >
          <SegmentedControlItem value="daily" label="每天" />
          <SegmentedControlItem value="weekly" label="每週" />
          <SegmentedControlItem value="hourly" label="每小時" />
          <SegmentedControlItem value="once" label="一次" />
        </SegmentedControl>
        {value.freq === 'weekly' ? (
          <ToggleButtonGroup
            type="multiple"
            label="星期"
            size="sm"
            value={value.days.map(String)}
            onChange={(days: string[]) => {
              // 至少留一天:全部取消的話這個排程永遠不會跑,而畫面上看不出來
              if (days.length) set({days: days.map(Number)});
            }}
          >
            {WEEK_ORDER.map((d) => (
              <ToggleButton key={d} value={String(d)} label={WEEKDAYS[d]} />
            ))}
          </ToggleButtonGroup>
        ) : null}
        {value.freq === 'hourly' ? (
          // 每小時只要選「第幾分」—— 用時間框的話會多出一個沒有意義的「幾點」
          <NumberInput
            label="第幾分"
            value={Number(value.time.slice(3))}
            min={0}
            max={59}
            isIntegerOnly
            units="分"
            width="100%"
            onChange={(m: number) => set({time: `00:${String(Math.max(0, Math.min(59, m))).padStart(2, '0')}`})}
          />
        ) : (
          <HStack gap={2}>
            {value.freq === 'once' ? (
              <Stack xstyle={styles.half}>
                <DateInput
                  label="日期"
                  value={(value.date || undefined) as ISODateString | undefined}
                  min={todayIn(offsetMin) as ISODateString}
                  width="100%"
                  onChange={(date) => set({date: date ?? ''})}
                />
              </Stack>
            ) : null}
            <Stack xstyle={styles.half}>
              <TimeInput
                label="時間"
                value={value.time as ISOTimeString}
                hourFormat="24h"
                width="100%"
                onChange={(time) => set({time: (time ?? '00:00').slice(0, 5)})}
              />
            </Stack>
          </HStack>
        )}
        <Selector
          label="上一次還沒跑完"
          options={[
            {value: 'skip', label: '跳過這一次'},
            {value: 'queue', label: '排在後面等'},
          ]}
          value={value.overlap}
          onChange={(v: string) => set({overlap: v === 'queue' ? 'queue' : 'skip'})}
        />
        {value.on ? (
          <Text type="supporting" color="secondary">
            {next ? `下次執行 ${formatWhen(next, offsetMin)}` : '沒有下一次'}
          </Text>
        ) : null}
      </VStack>
    </VStack>
  );
}

// ── 執行中的逐行紀錄 ─────────────────────────────────────────────────────────

/** 紀錄區標題列的高(px)。畫布「全部顯示」要扣掉整塊紀錄區(見 `LOG_DOCK_PX`),跟 `logHead` 的 height 是同一個數 */
const LOG_HEAD_PX = 40;
/**
 * 畫布底部被紀錄區蓋住多高(px):紀錄區離底邊的 spacing-3(12)+ 框線 2 + 標題列。
 * 給畫布「全部顯示」用 —— 紀錄區常駐,一進流程時它是收著的那一條(還沒有紀錄可看),
 * 不扣的話最底下那塊拼圖會被它蓋住
 */
export const LOG_DOCK_PX = 12 + 2 + LOG_HEAD_PX;

/**
 * 畫布底部的紀錄區(**常駐、不能關**,只能收起 / 展開):
 * 還沒執行過 = 空的一塊;跑起來或打開一次紀錄 = 那一次的逐行紀錄。
 */
export function RunLog({
  run,
  reach,
  isCollapsed,
  onToggle,
  now,
  actions,
  isNarrow = false,
  hasEnter = true,
}: {
  /** null = 還沒有要看的那一次(空的紀錄區) */
  run: RunView | null;
  reach: number;
  isCollapsed: boolean;
  onToggle: () => void;
  now: number;
  actions?: React.ReactNode;
  /** 手機寬度:每則紀錄分兩行(時間與哪一塊在上、訊息在下),三欄並排的話訊息只剩一個字寬 */
  isNarrow?: boolean;
  /** 掛上時播 `panelMotion.enter`。紀錄 ↔ 輸出互換時不播(見 `RunOutput` 與 Workflow 的 RunLogWithTabs) */
  hasEnter?: boolean;
}) {
  // 不只手機:寬螢幕上視窗一窄,畫布也會窄到放不下三欄 —— 量抽屜自己的寬度決定
  const rootRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = isNarrow || (width > 0 && width < COMPACT_LOG_PX);
  // 新的一行進來才捲到底,而且只在人本來就看著底部的時候 —— 每次 render(秒數每 0.5 秒跳一次)
  // 都硬捲到底的話,執行中往上捲回去讀前面的紀錄,半秒後就被拉回來
  const linesRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);
  const onLinesScroll = () => {
    const el = linesRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };
  const eventCount = run?.events.length ?? 0;
  // 換成另一次執行(重新執行、從執行紀錄打開別次)就重新貼底:上一次往上捲過,不該帶到這一次
  const runId = run?.id;
  useLayoutEffect(() => {
    stickRef.current = true;
  }, [runId]);
  useLayoutEffect(() => {
    const el = linesRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [eventCount, isCollapsed, runId]);
  const done = run ? run.steps.filter((s) => s.status !== 'running').length : 0;
  const cur = run?.steps.find((s) => s.status === 'running');
  const frac = !run ? 0 : run.status === 'running' ? Math.min(1, (done + (cur?.progress ?? 0)) / Math.max(1, reach)) : 1;
  const started = run?.started_at ? Date.parse(run.started_at) : now;
  const ended = run?.finished_at ? Date.parse(run.finished_at) : now;
  const secs = Math.max(0, Math.floor((ended - started) / 1000));
  const isOpen = !isCollapsed && !!run;
  return (
    <VStack
      gap={0}
      xstyle={[styles.log, isOpen ? styles.dockOpen : styles.dockClosed, hasEnter && panelMotion.enter]}
      role="region"
      aria-label="執行紀錄"
      ref={rootRef}
    >
      <HStack gap={3} vAlign="center" xstyle={styles.logHead}>
        {run ? (
          <>
            <Stack xstyle={styles.fixed}>
              <StatusPill status={run.status} />
            </Stack>
            {/* 窄的時候(手機、視窗很窄)讓出進度條的位置:「查看每一步的輸出」要整顆(字 + 圖示)放得下,收合鈕不能被擠出去。
                進度看狀態標籤與秒數、拼圖上各自的條 */}
            <Stack xstyle={[styles.bar, compact && styles.hidden]}>
              <ProgressBar
                label="執行進度"
                isLabelHidden
                value={Math.round(frac * 100)}
                variant={run.status === 'ok' ? 'success' : run.status === 'fail' || run.status === 'stopped' ? 'error' : 'accent'}
              />
            </Stack>
            <Text type="supporting" color="secondary" xstyle={[styles.mono, styles.fixed]}>
              {String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}
            </Text>
          </>
        ) : (
          // 還沒有要看的那一次:狀態那一格寫「等待啟動」(跟成功 / 失敗同一個位置、同一種標籤),紀錄區收著、不能展開 ——
          // 沒有東西可看
          <Stack xstyle={styles.fixed}>
            <Token size="sm" label="等待啟動" />
          </Stack>
        )}
        <PanelHeadEnd isCollapsed={isCollapsed || !run} onToggle={onToggle} isToggleDisabled={!run}>
          {run ? actions : null}
        </PanelHeadEnd>
      </HStack>
      <Stack xstyle={[growStyles.shell, styles.dockShellBound, isOpen && growStyles.open]}>
        <Stack xstyle={growStyles.clip} inert={!isOpen}>
          <Stack xstyle={[styles.lines, styles.bodyDivider]} ref={linesRef} onScroll={onLinesScroll}>
            {(run?.events ?? []).map((e, i) => {
              const msg = (
                <Text type="supporting" xstyle={[styles.mono, styles.msg, e.level === 'ok' && styles.textOk, e.level === 'fail' && styles.textFail]}>
                  {e.msg}
                </Text>
              );
              return compact ? (
                <VStack key={i} gap={0}>
                  <Text type="supporting" color="secondary" xstyle={styles.mono}>
                    {e.t} {e.label}
                  </Text>
                  {msg}
                </VStack>
              ) : (
                <HStack key={i} gap={3} vAlign="start">
                  <Text type="supporting" color="secondary" xstyle={[styles.mono, styles.lineTime]}>
                    {e.t}
                  </Text>
                  <Text type="supporting" color="secondary" xstyle={[styles.mono, styles.lineWho]} maxLines={1}>
                    {e.label}
                  </Text>
                  {msg}
                </HStack>
              );
            })}
          </Stack>
        </Stack>
      </Stack>
    </VStack>
  );
}

/**
 * 「每一步的輸出」那一頁:跟執行紀錄**同一個框、同一條標題列**(高度、底線、按鈕貼右)。
 * ⚠️ 既然是同一個框,跟紀錄互換時**不重播進場**(`hasEnter={false}`):不然每按一次「查看每一步的輸出」/
 * 「回到紀錄」整塊重新往上浮 300ms,面板明明沒離開。
 */
export function RunOutput({
  detail,
  onBack,
  isCollapsed,
  onToggle,
  hasEnter = true,
}: {
  /** 帶完整輸出的那一份(`getRun(..., lines=true)`);還沒抓回來是 null */
  detail: RunView | null;
  onBack: () => void;
  isCollapsed: boolean;
  onToggle: () => void;
  /** 掛上時播 `panelMotion.enter`(見 RunLog 的同名 prop) */
  hasEnter?: boolean;
}) {
  return (
    <VStack
      gap={0}
      // outputTall 不看收合:收起時 dockClosed 的上限蓋過它;跟著收合切換的話,收起那一下上限先從 65% 跳回 42%
      xstyle={[styles.log, styles.outputTall, isCollapsed ? styles.dockClosed : styles.dockOpen, hasEnter && panelMotion.enter]}
      role="region"
      aria-label="每一步的輸出"
    >
      <HStack gap={3} vAlign="center" xstyle={styles.logHead}>
        <Text type="label">每一步的輸出</Text>
        <PanelHeadEnd isCollapsed={isCollapsed} onToggle={onToggle}>
          {/* 不放圖示,有框看得出是按鈕 */}
          <Button label="回到紀錄" variant="secondary" size="sm" onClick={onBack} />
        </PanelHeadEnd>
      </HStack>
      <Stack xstyle={[growStyles.shell, styles.dockShellBound, !isCollapsed && growStyles.open]}>
        <Stack xstyle={growStyles.clip} inert={isCollapsed}>
          <Stack xstyle={[styles.outputBody, styles.bodyDivider]}>{detail ? <StepDetail run={detail} /> : isCollapsed ? null : <LoadingScreen isCompact label="載入中" />}</Stack>
        </Stack>
      </Stack>
    </VStack>
  );
}

/**
 * 紀錄 / 輸出兩塊標題列的右半段:撐開的空白、動作鈕、收合鈕。**按鈕一律貼右**,所以兩塊用同一份,不會各漂各的。
 * 收合鈕不是關閉:紀錄區常駐、不能關,展開時箭頭朝下(往下收),收起時朝上(往上展開)。
 */
function PanelHeadEnd({
  isCollapsed,
  onToggle,
  isToggleDisabled = false,
  children,
}: {
  isCollapsed: boolean;
  onToggle: () => void;
  /** 還沒有紀錄可看:收著、不能展開 */
  isToggleDisabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <>
      <Stack xstyle={styles.grow} />
      <Stack xstyle={styles.fixed}>{children}</Stack>
      <IconButton
        label={isCollapsed ? '展開執行紀錄' : '收起執行紀錄'}
        icon={<Icon icon={isCollapsed ? ChevronUp : ChevronDown} size="sm" />}
        variant="ghost"
        size="sm"
        isDisabled={isToggleDisabled}
        onClick={onToggle}
      />
    </>
  );
}

/** 每一步的狀態、時間、訊息與完整輸出(後端每步留最後 200 行)。 */
export function StepDetail({run}: {run: RunView}) {
  return (
    <VStack gap={3}>
      {run.steps.map((s) => (
        <VStack key={s.node} gap={1}>
          <HStack gap={2} vAlign="center">
            <Text type="label">{s.label}</Text>
            <StatusPill status={s.status} />
            <Text type="supporting" color="secondary">
              {s.started}
              {s.finished ? ` – ${s.finished}` : ''}
            </Text>
          </HStack>
          {s.message ? <Text type="supporting">{s.message}</Text> : null}
          {/* 給標題列(行數):沒有標題列的話複製鈕浮在內容右上角,蓋住第一行的尾巴 */}
          {s.lines?.length ? (
            <CodeBlock
              code={s.lines.join('\n')}
              title={`${s.lines.length} 行`}
              language="text"
              hasLanguageLabel={false}
              size="sm"
              isWrapped
              maxHeight={260}
              width="100%"
            />
          ) : null}
        </VStack>
      ))}
    </VStack>
  );
}

// ── 執行紀錄分頁 ─────────────────────────────────────────────────────────────

type HistRow = RunRow & Record<string, unknown>;

/** 耗時(ms);沒有的(還在跑、略過)升降冪都排最後,見 useTableKit 的 emptyLast */
const durationOf = (r: HistRow) =>
  r.started_at && r.finished_at && r.status !== 'skipped' ? Date.parse(r.finished_at) - Date.parse(r.started_at) : Infinity;
const HIST_COMPARATORS: Partial<Record<string, (a: HistRow, b: HistRow) => number>> = {
  started_at: (a, b) => (a.started_at ? Date.parse(a.started_at) : Infinity) - (b.started_at ? Date.parse(b.started_at) : Infinity),
  trigger: (a, b) => a.trigger.localeCompare(b.trigger) || a.triggered_by.localeCompare(b.triggered_by),
  // 照畫面上的字(成功 / 失敗 / …),不是英文代號
  status: (a, b) => STATUS[a.status].text.localeCompare(STATUS[b.status].text, 'zh-Hant'),
  finished_at: (a, b) => durationOf(a) - durationOf(b),
  stopped_at: (a, b) => a.stopped_at.localeCompare(b.stopped_at, 'zh-Hant'),
};

/** 執行紀錄表比這個窄(手機、視窗很窄)就改成兩欄:時間那一欄底下再寫觸發與耗時,另一欄是結果 —— 跟流程清單的窄版同一個作法 */
const HISTORY_COMPACT_PX = 520;
/** 窄的時候只留這兩欄:開始時間(底下再寫觸發與耗時)、結果 */
const HISTORY_COMPACT_KEYS = new Set(['started_at', 'status']);

const runDuration = (r: RunRow) =>
  r.started_at && r.finished_at && r.status !== 'skipped' ? formatDuration(Date.parse(r.finished_at) - Date.parse(r.started_at)) : '—';
const runStart = (r: RunRow, offsetMin: number) => (r.started_at ? formatWhen(new Date(r.started_at), offsetMin) : `#${r.id}`);
const runTrigger = (r: RunRow) => (r.trigger === 'schedule' ? `排程(${r.triggered_by})` : `手動(${r.triggered_by})`);

export function HistoryTable({
  rows,
  offsetMin,
  onOpen,
  isNarrow = false,
}: {
  rows: RunRow[];
  offsetMin: number;
  onOpen: (id: number) => void;
  isNarrow?: boolean;
}) {
  // 窄的時候切成精簡版:五欄擠在手機寬度裡要左右滑;寬度是 tableKit 量的
  const [isCompact, setIsCompact] = useState(isNarrow);
  const columns = useMemo<TableColumn<HistRow>[]>(() => {
    const all: TableColumn<HistRow>[] = [
      {
        key: 'started_at',
        header: '開始時間',
        width: proportional(1),
        renderCell: (r) =>
          isCompact ? (
            <VStack gap={0.5}>
              <Text type="supporting">{runStart(r, offsetMin)}</Text>
              <Text type="supporting" color="secondary">
                {runTrigger(r)} {runDuration(r)}
              </Text>
            </VStack>
          ) : (
            <Text type="supporting">{runStart(r, offsetMin)}</Text>
          ),
      },
      {
        key: 'trigger',
        header: '觸發',
        width: proportional(1),
        renderCell: (r) => (
          <Text type="supporting" color="secondary">
            {runTrigger(r)}
          </Text>
        ),
      },
      {key: 'status', header: '結果', width: pixel(96), renderCell: (r) => <StatusPill status={r.status} />},
      {
        key: 'finished_at',
        header: '耗時',
        width: pixel(110),
        renderCell: (r) => <Text type="supporting">{runDuration(r)}</Text>,
      },
      {
        key: 'stopped_at',
        header: '停在',
        width: proportional(1),
        renderCell: (r) => (
          <Text type="supporting" color="secondary">
            {r.stopped_at}
          </Text>
        ),
      },
    ];
    return isCompact ? all.filter((c) => HISTORY_COMPACT_KEYS.has(c.key)) : all;
  }, [offsetMin, isCompact]);
  // 整列可點(跟 Stats 的 useTableRowLink 同一個作法,只是這裡是打開那一次,不是換頁)。略過的那幾列沒有內容可看
  const rowClick = useMemo<TablePlugin<HistRow>>(
    () => ({
      transformBodyRow: (props, item) =>
        item.status === 'skipped'
          ? props
          : {...props, xstyle: [...props.xstyle, styles.clickable], htmlProps: {...props.htmlProps, onClick: () => onOpen(item.id)}},
    }),
    [onOpen],
  );
  // 點表頭排序、拖表頭改欄寬(全站資料表共用,見 components/tableKit.ts)
  const table = useTableKit<HistRow>({
    storageKey: 't100_table_cols:workflow_history',
    columns,
    data: rows as HistRow[],
    comparators: HIST_COMPARATORS,
    emptyLast: {started_at: (r) => !r.started_at, finished_at: (r) => durationOf(r) === Infinity},
    isResizable: !isCompact,
  });
  // layout effect:畫出來之前就切好,窄的容器不會先閃一格五欄
  useCompactTableSync(setIsCompact, isNarrow, table.tableWidth, HISTORY_COMPACT_PX);
  return (
    <Stack ref={table.wrapRef} {...table.wrapProps}>
      <TableCard>
        <Table<HistRow>
          data={table.data}
          columns={table.columns}
          idKey="id"
          density="balanced"
          dividers="rows"
          hasHover
          plugins={{...table.plugins, rowClick}}
        />
      </TableCard>
    </Stack>
  );
}

const styles = stylex.create({
  sched: {width: 300, padding: 'var(--spacing-1)'},
  half: {flex: '1 1 0', minWidth: 0},
  clickable: {cursor: 'pointer'},
  schedBody: {transitionProperty: 'opacity', transitionDuration: 'var(--duration-fast)', transitionTimingFunction: 'var(--ease-standard)'},
  schedOff: {opacity: 0.4, pointerEvents: 'none'},
  log: {
    position: 'absolute',
    left: 'var(--spacing-3)',
    right: 'var(--spacing-3)',
    bottom: 'var(--spacing-3)',
    zIndex: 12,
    maxHeight: '42%',
    borderRadius: 'var(--radius-container)',
    backgroundColor: 'var(--color-background-popover)',
    borderWidth: 'var(--border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    boxShadow: 'var(--shadow-med)',
  },
  logHead: {
    height: LOG_HEAD_PX,
    flexShrink: 0,
    paddingInline: 'var(--spacing-3) var(--spacing-1-5)',
  },
  // 畫布變窄時:狀態標籤、秒數、按鈕都不縮,進度條吃剩下的寬度
  fixed: {flexShrink: 0},
  grow: {flex: '1 1 0'},
  hidden: {display: 'none'},
  /**
   * 紀錄區收起 / 展開要補間:`display: none` 切換的話一下從 40px 的標題列變成畫布的 42%(輸出 65%),
   * 上緣瞬移、一下蓋掉一大塊畫布。跟 Chat 的 `growShell` 同一組(時間、曲線、`0fr → 1fr`):
   * 展開 `--duration-medium-min` + `--ease-panel`,收起 `--duration-fast-max` + `--ease-standard`,減少動態直接切。
   *
   * ⚠️ **兩層一起補間,缺一不可**(框的上限 `dockOpen` / `dockClosed` 與殼的 `growStyles.shell`):
   *  - 只有殼:`0fr → 1fr` 是照**內容全高**等比長,紀錄一長(幾千 px)前幾 % 就撞到 42% 的上限,
   *    看起來還是一下跳開;
   *  - 只有框的上限:內容很短時上限還沒降到內容高之前什麼都不動(收起來先停一下才開始縮)。
   *  兩個同時間、同曲線,框的高 = min(標題列 + x·內容, 上限(x)),長短都是整段時間平順長開。
   * 殼要 `minHeight: 0`,不然 flex 縮不下去、撐破 42% / 65% 的上限(grid 殼的最小高不是 0,要明寫)。
   * 殼裡面夾住的那層撐滿列高,`lines` / `outputBody` 在裡面捲。
   */
  // 殼本身是共用的 `growStyles`(components/growShell.ts);這裡只補「不能超過外框上限」那一條
  dockShellBound: {minHeight: 0},
  // 收起:框的上限 = 標題列 + 上下框線,剛好是收起來的高,不會切到標題列
  dockClosed: {
    maxHeight: `calc(${LOG_HEAD_PX}px + var(--border-width) * 2)`,
    transition: {
      default: 'max-height var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  // 展開:上限回到 `log` 的 42% / `outputTall` 的 65%(這裡不寫 maxHeight,只給展開那一段的時間)
  dockOpen: {
    transition: {
      default: 'max-height var(--duration-medium-min) var(--ease-panel)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  /**
   * 標題列底下那條線。收合要補間,所以線畫在被夾的內容頂端、跟著內容一起收掉 ——
   * 畫在標題列上的話,收起那一下線先不見,底下的內容還在縮
   */
  bodyDivider: {
    borderTopWidth: 'var(--border-width)',
    borderTopStyle: 'solid',
    borderTopColor: 'var(--color-border)',
  },
  // 「每一步的輸出」照內容長高,最多到畫布的 65%(固定撐到底的話,內容少的時候底下空一大塊)
  outputTall: {maxHeight: '65%'},
  outputBody: {flex: '0 1 auto', minHeight: 0, overflowY: 'auto', paddingBlock: 'var(--spacing-3)', paddingInline: 'var(--spacing-4)'},
  bar: {flex: '1 1 0', minWidth: 48, maxWidth: 240},
  mono: {fontFamily: 'var(--font-family-code)', fontVariantNumeric: 'tabular-nums'},
  lines: {overflowY: 'auto', overflowX: 'hidden', paddingBlock: 'var(--spacing-2)', paddingInline: 'var(--spacing-3)', gap: 'var(--spacing-0-5)'},
  lineTime: {width: 64, flexShrink: 0, color: 'var(--color-text-disabled)'},
  lineWho: {width: 108, flexShrink: 0},
  msg: {flex: '1 1 0', minWidth: 0, overflowWrap: 'anywhere'},
  textOk: {color: 'var(--color-success)'},
  textFail: {color: 'var(--color-error)'},
});
