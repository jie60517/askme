/**
 * 用量頁最上面那張大折線圖(Astryx `dashboard` 模板的 `ActiveUsersChart`)。
 *
 * 模板畫的是 All Users / Desktop / Mobile 三條線;這裡只畫**總提問數**一條
 * (範本沒有未登入的提問,拆成「使用者」那條會跟總數完全重疊)。
 *
 * ⚠️ **圖 `aria-hidden` + 底下永遠配一份 sr-only 表格**(專案慣例,見 frontend/.claude/CLAUDE.md)。
 * recharts 不會幫忙做這件事,所以在這裡自己補。
 * 拿掉表格等於這一頁對螢幕閱讀器是空白的。
 */
import {useMemo} from 'react';

import {Card} from '@astryxdesign/core/Card';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {Table, type TableColumn} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {CHART_COLORS, CHART_GRID, CHART_TICK} from './dashboardChart';

export type TrendPoint = Record<string, unknown> & {
  id: string;
  period: string;
  total: number;
};

const SERIES = [{key: 'total', label: '總提問數', color: CHART_COLORS.blue}] as const;

/*
 * 座標字級走 token 的字串值,不是寫死的 px —— recharts 的 `tick` 是 SVG 屬性,
 * 吃得下 `var(...)`(模板本身就是這樣寫的)。
 */
const TICK_STYLE = {
  fontSize: 'var(--font-size-sm, 12px)',
  fill: CHART_TICK,
} as const;

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{name?: string; value?: number; color?: string}>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <Card padding={3}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary">
          {label ?? ''}
        </Text>
        {payload.map((entry) => (
          <HStack key={entry.name} gap={2} vAlign="center">
            <Swatch color={entry.color ?? CHART_COLORS.neutral} />
            <Text type="supporting">
              {entry.name}:{entry.value}
            </Text>
          </HStack>
        ))}
      </VStack>
    </Card>
  );
}

/**
 * 圖例 / 提示框的色塊。
 *
 * 模板用 heroicons 的 `StopIcon` 當色塊,這裡用一個吃 token 的小方塊 ——
 * 為了一個實心正方形載一整包圖示套件不划算,而且 `Icon` 的 `style={{color}}`
 * 在 StyleX 編譯下要多繞一層。寬高吃 spacing 階,圓角吃 radius 階。
 */
function Swatch({color}: {color: string}) {
  return (
    <Stack
      aria-hidden
      style={{
        width: 'var(--spacing-2)',
        height: 'var(--spacing-2)',
        borderRadius: 'var(--radius-inner)',
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

/**
 * x 軸的刻度字。日粒度時**把年拿掉**(`2026-09-17` → `09-17`)。
 *
 * 一整排 `2026-09-11 2026-09-12 …` 有一半的字元是同一個年份,擠掉的是真正在變的
 * 那兩格。年份在旁邊的日期欄與「只統計 X 到 Y」那句裡都看得到,軸上不必再講一次。
 * 月(`2026-09`)與年(`2026`)粒度原樣留著 —— 那兩種格式本來就短,而且年就是資訊。
 *
 * ⚠️ 只動**畫面上的刻度**。sr-only 表格與提示框走的是完整的 `period`,
 * 不然報讀軟體聽到的是一串沒有年份的日期。
 */
function shortPeriod(period: string): string {
  // 一刻鐘(`2026-09-17 14:30`)與小時(`2026-09-17 14`)粒度:日期在旁邊的起訖欄裡,
  // 軸上只要時間。一刻鐘的鍵本身就帶分,小時的補上 `:00`。
  const [datePart, timePart] = period.split(' ');
  if (timePart !== undefined) return timePart.includes(':') ? timePart : `${timePart}:00`;
  const parts = datePart.split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : period;
}

const SR_COLUMNS: TableColumn<TrendPoint>[] = [
  {key: 'period', header: '期間'},
  {key: 'total', header: '總提問數'},
];

export function TrendChart({
  data,
  tickEvery,
}: {
  data: TrendPoint[];
  /**
   * 每幾格放一個 x 軸標籤。不給就讓 recharts 自己依寬度算(`preserveStart`)。
   *
   * 一刻鐘粒度一定要給:96 格交給 recharts 自己算,它會挑出一個「剛好塞得下」的
   * 間隔(例如每 8 格 = 2 小時,而且會擠),那不是一個讀得出時間感的軸。
   * 給 24(= 6 小時)之後標籤落在 00:00 / 06:00 / 12:00 / 18:00,一眼看得出早晚。
   */
  tickEvery?: number;
}) {
  const height = 300;

  const isEmpty = data.length === 0;

  /*
   * ⚠️ 明確給 `ticks` 時**不要**同時給 `interval` —— recharts 會拿 interval 再去
   * 疏化一次我們挑好的那幾個,結果又變成不等距。
   */
  const ticks = tickEvery
    ? data.filter((_, i) => i % tickEvery === 0).map((d) => d.period)
    : undefined;

  return (
    <VStack gap={3}>
      {isEmpty ? (
        <Text type="supporting" color="secondary">
          這段期間沒有資料。
        </Text>
      ) : (
        <>
          {/* 圖本身對螢幕閱讀器隱藏,等價資訊在底下那份表格 */}
          <Stack aria-hidden>
            <ResponsiveContainer width="100%" height={height}>
              {/*
                ⚠️ `right` 給得比模板大:x 軸最後一格的標籤是**靠中對齊**在最後一個
                資料點上,右邊沒有留白的話它會被切掉一半(「2026-09-17」只剩
                「2026-09-1」)。而最後一格正是這張圖最常被看的那一格。
              */}
              <LineChart data={data} margin={{top: 5, right: 32, left: 0, bottom: 5}}>
                <CartesianGrid horizontal vertical={false} stroke={CHART_GRID} />
                <XAxis
                  dataKey="period"
                  /*
                   * ⚠️ **`preserveStart`,不是 `preserveStartEnd`。**
                   *
                   * `preserveStartEnd` 會先照均勻間隔挑刻度,再**硬把最後一個點加上去** ——
                   * 於是最後一格的間距跟其他格對不上(例如單日 24 格:
                   * 00:00 起每 2 小時一格,到 20:00 之後直接跳到 23:00)。
                   * 一條刻度不等距的時間軸,讀起來會誤判密度
                   *(看起來像最後那段時間拉長了)。
                   *
                   * `preserveStart` 只保證頭,間距一路均勻;最後一格沒有標籤是可以的 ——
                   * 區間的結束日期就寫在上面的「迄」欄位裡。
                   */
                  {...(ticks ? {ticks} : {interval: 'preserveStart' as const})}
                  tickFormatter={shortPeriod}
                  tick={TICK_STYLE}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={TICK_STYLE}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <Tooltip content={<ChartTooltip />} cursor={{stroke: CHART_GRID}} />
                {SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="linear"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Stack>

          <HStack gap={6} vAlign="center" wrap="wrap">
            {SERIES.map((s) => (
              <HStack key={s.key} gap={2} vAlign="center">
                <Swatch color={s.color} />
                <Text type="supporting" color="secondary">
                  {s.label}
                </Text>
              </HStack>
            ))}
          </HStack>

          <VisuallyHidden as="div">
            <Table<TrendPoint>
              data={data}
              columns={SR_COLUMNS}
              idKey="id"
              // Table 沒有 caption prop —— 標題走 aria-label
              aria-label="提問數的時間分布"
            />
          </VisuallyHidden>
        </>
      )}
    </VStack>
  );
}

/**
 * `by_period` → 一份給 recharts 吃的陣列。
 */
export function useTrendData(
  /**
   * 期間軸。**由呼叫端決定**,不是從 `total` 的鍵推出來的 ——
   * 只選一天時要畫滿 24 個鐘點(沒人問的補 0),而後端只回有題目的那幾格。
   * 見 `Stats.tsx` 的 `periods`。
   */
  periods: string[],
  total: Record<string, number> | undefined,
): TrendPoint[] {
  return useMemo(
    () =>
      periods.map((period) => ({
        id: period,
        period,
        total: total?.[period] ?? 0,
      })),
    [periods, total],
  );
}
