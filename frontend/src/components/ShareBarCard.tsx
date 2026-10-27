/**
 * 一條堆疊橫條 + 圖例(Astryx `dashboard` 模板的 `StackedBarCard`)。
 *
 * 用在「這一堆題目怎麼分」:專案、耗時分布。回答的是**佔比**,
 * 不是精確數字 —— 精確數字在底下的排行表裡。
 *
 * ⚠️ 條本身 `aria-hidden`:每一段的名稱、題數、百分比在底下的圖例裡都是文字,
 * 報讀軟體讀圖例就夠了,不必再聽一次同樣的東西。
 */
import {useMemo} from 'react';

import {Card} from '@astryxdesign/core/Card';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';

import {colorAt} from './dashboardChart';

export type ShareSlice = {label: string; value: number};

/**
 * 最多畫幾段,其餘併成「其他」。
 *
 * 超過這個數字之後每一段都會窄到看不出來,而且圖例會排成兩三行 ——
 * 這張卡要回答的是「前幾名佔多少」,尾巴本來就該被讀成「其他」。
 */
const MAX_SLICES = 5;

export function ShareBarCard({title, data}: {title: string; data: ShareSlice[]}) {
  const slices = useMemo(() => {
    // 後端已經照題數由多到少排好,照它的順序;這裡不重排(跟排行表同一條規則)。
    if (data.length <= MAX_SLICES) return data;
    const head = data.slice(0, MAX_SLICES - 1);
    const rest = data.slice(MAX_SLICES - 1);
    return [...head, {label: '其他', value: rest.reduce((a, s) => a + s.value, 0)}];
  }, [data]);

  const total = slices.reduce((a, s) => a + s.value, 0);

  return (
    <Card>
      <VStack gap={4}>
        <Heading level={4}>{title}</Heading>

        {total === 0 ? (
          <Text type="supporting" color="secondary">
            這段期間沒有資料。
          </Text>
        ) : (
          <>
            {/*
              一條橫的堆疊條。模板用 recharts 畫,這裡用一排 Stack ——
              一條長方形不值得開一張 SVG(跟排行表那條佔比條同一個判斷),
              而且 recharts 的 vertical BarChart 要為了單一資料列繞一圈
              `Object.fromEntries` 的轉換。圓角、高度、底色全吃 token。
            */}
            {/*
              ⚠️ **分段之間沒有間隙,色塊是黏在一起的**。所以這裡**不要加 `gap`** ——
              整條讀起來要像一條被切成幾段的量尺,不是幾根分開的棒子。
            */}
            <Stack
              aria-hidden
              style={{
                display: 'flex',
                flexDirection: 'row',
                width: '100%',
                height: 'var(--spacing-6)',
                borderRadius: 'var(--radius-inner)',
                overflow: 'hidden',
              }}
            >
              {/*
                **0 的分段不畫**(只留在下面的圖例)。

                一個寬度 0 的節點畫出來沒有任何意義;而且哪天有人加了 `gap`,
                gap 是照**子元素個數**算的,不管那個子元素寬不寬 —— 一個 `width: 0%` 的分段
                照樣吃掉一格 gap,有 0 分段的那張卡右緣就會短一截,兩張並排就沒對齊
                (那種 2px 的差在淺色下看不出來,只有深色才顯形)。

                ⚠️ 顏色是照 `slices` 的索引取的,而索引在這裡**沒有變**
                (過濾只發生在畫的時候,圖例仍然走完整的 `slices`)——
                所以不會出現「少一段、後面的顏色就位移」。
              */}
              {slices.map((s, i) =>
                s.value === 0 ? null : (
                  <Stack
                    key={s.label}
                    style={{
                      // 寬度是資料,只能走 inline style(StyleX 只吃靜態值)
                      width: `${(s.value / total) * 100}%`,
                      backgroundColor: colorAt(i),
                    }}
                  />
                ),
              )}
            </Stack>

            <HStack gap={4} wrap="wrap">
              {slices.map((s, i) => (
                <VStack key={s.label} gap={0}>
                  <HStack gap={2} vAlign="center">
                    <Stack
                      aria-hidden
                      style={{
                        width: 'var(--spacing-2)',
                        height: 'var(--spacing-2)',
                        borderRadius: 'var(--radius-inner)',
                        backgroundColor: colorAt(i),
                        flexShrink: 0,
                      }}
                    />
                    <Text type="supporting">{s.label}</Text>
                  </HStack>
                  <Text type="supporting" color="secondary">
                    {s.value} · {((s.value / total) * 100).toFixed(1)}%
                  </Text>
                </VStack>
              ))}
            </HStack>
          </>
        )}
      </VStack>
    </Card>
  );
}

/** `Record<string, number>` → 圖例要的陣列。後端的順序照留。 */
export function toSlices(source: Record<string, number> | undefined): ShareSlice[] {
  return Object.entries(source ?? {}).map(([label, value]) => ({label, value}));
}
