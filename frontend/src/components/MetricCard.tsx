/**
 * KPI 卡(Astryx `dashboard` 模板的 `MetricCard`)。
 *
 * 模板的形狀:標籤(Heading 4)→ 大數字(Heading 2)+ 漲跌 → 對照說明 → sparkline。
 *
 * ⚠️ **`lowerIsBetter` 不是可選的裝飾。** 模板寫死「往上 = 綠、往下 = 紅」,
 * 那對提問數、帳號數成立,對**平均耗時不成立** —— 耗時變短是好事。
 * 箭頭方向照實畫(變小就是向下),顏色照語意給。
 *
 * ⚠️ **沒有對照期就整個不畫漲跌**(`previous` 是 undefined)。
 * 拿 0 當對照期的話每張卡都會是 `+∞%`,而那看起來像功能壞了。
 */
import {useMemo} from 'react';

import {Card} from '@astryxdesign/core/Card';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import NumberFlow from '@number-flow/react';
import {ArrowDown, ArrowUp} from 'lucide-react';
import {Line, LineChart, ResponsiveContainer} from 'recharts';

import {CHART_COLORS} from './dashboardChart';

/**
 * 數字換區間時滾過去,不是硬跳。時間與曲線**從 CSS 讀**,不留 JS 副本;讀不到才退回預設。
 * ⚠️ 不要拉長 —— 這是要被讀的資料,滾超過 400ms 就從「換了」變成「在表演」。
 */
function readNumberTiming(): {duration: number; easing: string} {
  const root = getComputedStyle(document.documentElement);
  const duration = parseFloat(root.getPropertyValue('--duration-medium'));
  const easing = root.getPropertyValue('--ease-standard').trim();
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 300,
    easing: easing || 'cubic-bezier(0.24, 1, 0.4, 1)',
  };
}
const NUMBER_FORMAT = {useGrouping: false} as const;

/**
 * 高 40px 的迷你折線,跟模板一樣:沒有點、沒有軸、不做進場動畫。
 *
 * ⚠️ **圖 `aria-hidden`,旁邊配一句 sr-only 的文字摘要。**
 *
 * `frontend/.claude/CLAUDE.md` 的規則是「圖一律 aria-hidden + 配一份 sr-only 表格」,
 * 這裡**刻意給摘要而不是表格**:上面那張趨勢圖是這一頁的主資料,它的每一格都要讀得到,
 * 所以配整份表格;sparkline 是「那個大數字最近怎麼走」的補充,而那個大數字本身
 * 已經念得出來了。四張卡各掛一份 24 列的表格,報讀軟體要多聽 96 列才走到下一段,
 * 那不是無障礙,是噪音。
 *
 * 但**不能什麼都不給**:`avg_duration_by_period` / `logins_by_period` 兩條序列
 * 全站沒有第二個出口。摘要給的是這條線真正在表達的幾件事:幾格、最低、最高、最後落在哪。
 */
function Sparkline({
  data,
  label,
  format,
}: {
  data: number[];
  /** 這條線是誰的走勢,念出來要接得上卡片標題 */
  label: string;
  /** 把值念成人看得懂的字(耗時要「12.4 秒」,不是「12400」) */
  format: (value: number) => string;
}) {
  const points = useMemo(() => data.map((v, i) => ({i, v})), [data]);

  if (points.length < 2) {
    /*
     * 一個點畫不出線(recharts 會畫出一片空白)。空著比畫一條假的好 ——
     * 但**高度要留住**,不然同一列的卡片會一張高一張矮。
     */
    return <Stack aria-hidden style={{height: 'var(--spacing-10)'}} />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const last = data[data.length - 1];

  return (
    <>
      <Stack aria-hidden>
        <ResponsiveContainer width="100%" height={40}>
          <LineChart data={points}>
            <Line
              type="linear"
              dataKey="v"
              stroke={CHART_COLORS.blue}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </Stack>
      <VisuallyHidden as="p">
        {`${label}的走勢:共 ${data.length} 格,最低 ${format(min)},最高 ${format(max)},最後 ${format(last)}。`}
      </VisuallyHidden>
    </>
  );
}

type Props = {
  label: string;
  /** 數字會滾;字串(例如「12.4 秒」)直接顯示 */
  value: number | string;
  /** 對照期的同一個量。沒有就不畫漲跌。 */
  previous?: number;
  /** 拿來算漲跌的當期數值。`value` 是字串時一定要給。 */
  current?: number;
  /** 變小才是好事(平均耗時) */
  lowerIsBetter?: boolean;
  /** 卡片底下那一行,例如「較前 7 天的 1,234」 */
  hint: string;
  sparkline: number[];
  /**
   * 把 sparkline 的值念成人看得懂的字,給那句 sr-only 摘要用。
   * 沒給的話走整數 —— 四張卡裡只有「平均耗時」與「每人平均題數」需要自己的格式。
   */
  formatSparkline?: (value: number) => string;
};

/**
 * 變化率算不算「持平」。
 *
 * 不是只有剛好 0:1000 → 1000.4 算出來是 +0.04%,而畫面只留一位小數 ——
 * 不處理的話會畫一顆綠色的上箭頭配「+0.0%」,箭頭說變好了、數字說沒變。
 * 小於顯示精度的一半(0.05% = 0.0005)就是「顯示出來是 0.0」,當持平、不畫箭頭。
 */
const FLAT_EPSILON = 0.0005;
export function isFlatChange(delta: number): boolean {
  return Math.abs(delta) < FLAT_EPSILON;
}

export function MetricCard({
  label,
  value,
  previous,
  current,
  lowerIsBetter = false,
  hint,
  sparkline,
  formatSparkline = (v) => String(Math.round(v)),
}: Props) {
  const timing = useMemo(readNumberTiming, []);

  const now = typeof value === 'number' ? value : current;
  /*
   * 對照期是 0 的時候**不畫百分比**:分母 0 算不出變化率。
   * 這不是邊角 —— 新帳號、剛上線的系統、空的前一週都會走到這裡。
   */
  const delta =
    previous === undefined || now === undefined || previous === 0
      ? undefined
      : (now - previous) / previous;

  const isFlat = delta !== undefined && isFlatChange(delta);
  const isUp = delta !== undefined && !isFlat && delta > 0;
  const isGood = lowerIsBetter ? !isUp : isUp;

  return (
    <Card>
      <VStack gap={2}>
        <Heading level={4}>{label}</Heading>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Heading level={2}>
            {typeof value === 'number' ? (
              <NumberFlow
                value={value}
                format={NUMBER_FORMAT}
                transformTiming={timing}
                spinTiming={timing}
                opacityTiming={timing}
              />
            ) : (
              value
            )}
          </Heading>
          {delta !== undefined && !isFlat ? (
            <HStack gap={1} vAlign="center">
              <Icon
                icon={isUp ? ArrowUp : ArrowDown}
                size="xsm"
                color={isGood ? 'success' : 'error'}
              />
              <Text type="body" color="secondary">
                {`${isUp ? '+' : '−'}${Math.abs(delta * 100).toFixed(1)}%`}
              </Text>
            </HStack>
          ) : null}
        </HStack>
        <Text type="supporting" color="secondary">
          {hint}
        </Text>
        <Sparkline data={sparkline} label={label} format={formatSparkline} />
      </VStack>
    </Card>
  );
}
