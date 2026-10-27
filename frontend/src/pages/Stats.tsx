/**
 * 用量統計(管理員)。
 *
 * 起訖日期(只有這兩格)→ 趨勢圖 + 四張 KPI 卡 + 組成 + 各帳號的提問數。
 *
 * 版面照 Astryx 的 `dashboard`(Analytics Dashboard)模板:大圖 → KPI 卡 →
 * Divider → 組成 → Divider → 排行。
 *
 * ⚠️ **圖表只用 recharts 一套**(模板用的就是它),不要再引入第二套圖表引擎。
 *
 * ⚠️ 「圖 aria-hidden + 配一份 sr-only 表格」由 `TrendChart.tsx` 自己做。
 * 拿掉等於這一頁對螢幕閱讀器是空白的。
 *
 * ⚠️ 顏色在 `components/dashboardChart.ts`,那是全專案唯一寫死色碼的地方,
 * 理由寫在那個檔的開頭 —— 動它之前先讀。
 *
 * 大數字用 `Heading level={2}` + NumberFlow(模板的字級)。
 *
 * 版面規則:
 *  - **四張 KPI 卡**:提問數 / 登入人數 / 平均耗時 / 每人平均題數。
 *    **不畫「總花費」**:後端的 `total_cost_usd` 還在,只是不畫。
 *  - **「登入人數」不是「有幾個帳號問過問題」**。它查的是 audit_log 的
 *    `login_success`,登入了沒問問題的人也算。`account_count` 還在 API 上,
 *    這一頁不用 —— 那是兩個不同的數字。
 *  - **篩選只有起訖**(一格 DateRangeInput),沒有快捷鈕。統計單位由起訖**算出來**:
 *    起訖同一天走 `hour`(不然折線圖上只有一個點),其餘走 `day`。見 `granularityFor()`。
 *  - **篩選收在一塊 muted 的卡**,跟數字分開:控制項與結果同一片白的話,
 *    掃過去分不出哪些可以動、哪些是算出來的。用 `Card` 不用 `Section`,
 *    不然左右緣跟底下那幾塊對不齊(見那一段的說明)。
 *  - **篩選條件住在網址上**(`useSearchParams`):重新整理留著、上一頁回得去、
 *    網址也貼得給人。放在 `useState` 的話按 F5 區間就歸零。
 *  - **起訖預設「今天」**。昨天以前的題目不在畫面上、排行榜也只算今天問過的人;
 *    有人回報「某人的問題不見了」時,先看起訖選到哪裡。
 *  - **「正在執行」沒人在跑時整區不出現**,不顯示「目前沒有…」。
 *  - **各帳號用排行表不用長條圖**:十幾個帳號的長條要對著 y 軸文字才認得出是誰,
 *    而 dense data = rows(`astryx docs layout`)。表格的欄位形狀照模板的 Engagement
 *    (名稱 | ProgressBar + 數字 | 佔比 | 平均耗時,**沒有名次欄**),段落標題是
 *    「各帳號的提問數」,卡片裡沒有第二層標題與連結。**整列可點**進那個人的明細 ——
 *    見 `components/useTableRowLink.tsx`。
 *    **期間分布留在圖**:那是時間序列,趨勢本來就要用圖看。
 *  - **趨勢圖只畫「總提問數」一條**(範本沒有未登入的提問,拆出「使用者」那條會跟總數重疊)。
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {Card} from '@astryxdesign/core/Card';
import {DateRangeInput} from '../components/astryx/DateRangeInput';
import {Button} from '@astryxdesign/core/Button';
import {Grid} from '@astryxdesign/core/Grid';
import {Item} from '@astryxdesign/core/Item';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {List} from '@astryxdesign/core/List';
import {Link} from '@astryxdesign/core/Link';
import {Divider} from '@astryxdesign/core/Divider';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Table, pixel, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {useTableKit} from '../components/tableKit';
import {Heading, Text} from '@astryxdesign/core/Text';
import * as stylex from '@stylexjs/stylex';

import {AdminPage} from '../components/AdminPage';
import {AsyncSection} from '../components/AsyncSection';
import {GROW_CLOSE_MS, growStyles} from '../components/growShell';
import {MetricCard} from '../components/MetricCard';
import {ShareBarCard, toSlices} from '../components/ShareBarCard';
import {TrendChart, useTrendData} from '../components/TrendChart';
import {useTableRowLink} from '../components/useTableRowLink';
import {
  getRunningQuestions,
  getStats,
  type Granularity,
} from '../lib/adminApi';
import {formatAverageDuration, formatStepDuration} from '../lib/time';
import {isoDateParam, openRangeLabel, todayIso} from '../lib/urlParams';
import {useSearchParamsPatch} from '../lib/useSearchParamsPatch';
import {useAsyncData} from '../lib/useAsyncData';

/**
 * 這一次查詢要用哪個分組粒度。
 *
 * **起訖是同一天 → 一小時一格**(24 格);按日分組的話單日只有一個點,不是趨勢。
 *
 * ⚠️ 不用模板的 15 分鐘一格:模板那張圖畫的是「線上人數」(每一刻都有值、線是連續的),
 * 而這一頁畫的是**提問數**:一天幾十題散在 96 格裡,大部分格子是 0,畫出來是一排
 * 密密麻麻的尖刺,看不出形狀。收成 24 格才讀得出「早上沒人、下午爆量」。
 *
 * 其餘一律按日。畫面上沒有日/月/年的切換,所以這裡是算出來的、不是狀態;
 * API 的 `granularity` 參數還在(後端也支援 `quarter`,只是畫面上沒有入口 ——
 * 見 `routers/stats._GRANULARITY_FORMAT`)。
 */
function granularityFor(start?: string, end?: string): Granularity {
  return start && end && start === end ? 'hour' : 'day';
}

/**
 * 一天 24 格的期間鍵(`2026-09-17 00` … `2026-09-17 23`)。
 *
 * ⚠️ 格式要**逐字**跟後端的 `hour` 一致(`routers/stats._period_expr`)——
 * 這兩份是拿字串當鍵對的,少一位零、或分隔符不同,整天的資料就全部對不到,
 * 畫面上是一條貼著 0 的線,不是錯誤。
 */
function hourKeys(day: string): string[] {
  return Array.from({length: 24}, (_, h) => `${day} ${String(h).padStart(2, '0')}`);
}

/** KPI 卡一張最少多寬。四張排一列時 4×220 + 間距塞得進 1160 的內容欄。 */
const KPI_MIN_WIDTH = 220;

/**
 * KPI 外層格子一格(兩張一組)最少多寬,數字照 dashboard 模板。外層兩格、裡面各兩張 ——
 * 四張只會排成一列四張 / 2×2 / 一欄,不會出現「3 張 + 孤零零 1 張」。
 */
const KPI_PAIR_MIN_WIDTH = 320;

/** 排行表點表頭排序的比較方式(一律寫升冪) */
const RANK_COMPARATORS: Partial<Record<string, (a: RankRow, b: RankRow) => number>> = {
  name: (a, b) => a.name.localeCompare(b.name, 'zh-Hant'),
  value: (a, b) => a.value - b.value,
  share: (a, b) => a.share - b.share,
  avgDuration: (a, b) => (a.avgDuration ?? Infinity) - (b.avgDuration ?? Infinity),
};

type RankRow = Record<string, unknown> & {
  id: string;
  /** 名次。**畫面上不顯示**(模板的 Engagement 沒有名次欄),留著是因為它是列的順序本身。 */
  rank: number;
  name: string;
  value: number;
  share: number;
  /** 這個帳號的平均耗時(ms)。後端沒給就是 undefined,那一格顯示「—」。 */
  avgDuration?: number;
};

export default function Stats() {
  // 篩選條件**全部住在網址上**(見檔頭)。起、迄、「全部」的記號都走同一支 patch
  // (`lib/useSearchParamsPatch.ts`;為什麼用 replace 不新增瀏覽歷史,寫在那裡)
  const {params, patch: patchParams} = useSearchParamsPatch();

  /*
   * ⚠️ **起訖從網址讀進來都要驗**,認不得的退回預設,不能原樣送出去 ——
   * 網址是使用者改得到的,`?start=abc` 直接丟給後端只會換來一次 422,
   * 而畫面只會顯示「載入失敗」,看不出是網址壞了。
   *
   * 統計單位不從網址讀(由 `granularityFor()` 從起訖算出來)。網址上的
   * `?granularity=month` 會被忽略,不會 422 —— 刻意的,帶著它的連結不該壞掉。
   */
  /*
   * 起訖**預設今天**。
   *
   * ⚠️ 這裡是**算出來的,不要改成用副作用去改網址**(「進來時 setParams 補上今天」):
   *  1. 第一次 render 時 start/end 還是空的,會先送一次**全期間**的查詢,
   *     等網址改完再送第二次 —— 白跑一次最貴的那支 API。
   *  2. 「只補一次」的旗標若是 `useRef`,**活在這次掛載裡**。從
   *     `/stats/questions` 走回來是重新掛載,旗標歸零,使用者剛剛選的「全部」
   *     會被默默改回今天。
   *  3. 補寫用 `replace: true` 的話,連上一頁都回不去那個「全部」。
   *
   * 規則:**網址上有 `range=all` 就是全部,否則沒填就是今天**。
   * 「全部」在網址上留得住記號,重新掛載、重新整理、把網址貼給人都是同一個結果。
   * 畫面上沒有「全部」的入口,但 `range=all` 的連結照樣認得。
   */
  const isAllTime = params.get('range') === 'all';
  const rawStart = isoDateParam(params.get('start'));
  const rawEnd = isoDateParam(params.get('end'));
  const hasExplicitRange = !!rawStart || !!rawEnd;
  // 只帶一端的網址照開放區間查(少一端就不畫漲跌),期間格用 placeholder 講出來(見 openRangeLabel)
  const start = isAllTime || hasExplicitRange ? rawStart : todayIso();
  const end = isAllTime || hasExplicitRange ? rawEnd : todayIso();

  const granularity = granularityFor(start, end);

  const {data, loading, failed, reload} = useAsyncData(
    useCallback(() => getStats(granularity, start, end), [granularity, start, end]),
  );

  /*
   * 這張圖與所有 sparkline 共用的期間軸。
   *
   * ⚠️ **只選一天時要把 24 格全部補齊**(沒人問的那格補 0)。後端只回
   * 「有題目的那幾格」—— 直接畫的話,一天只有三個時段有人問,圖上就是三個點
   * 平均分布在整條軸上,看起來像「這一天只有三個時間單位」。補滿之後才看得出
   * 「早上沒人、下午兩點爆量」這種形狀,而那正是選單日要看的東西。
   *
   * 按日分組時**不補**:區間可能長達一年,補滿等於畫一堆零;而且「沒有人問的
   * 那一格不會出現」本來就是這一頁的規則。
   */
  const periods = useMemo(() => {
    if (granularity === 'hour' && start) return hourKeys(start);
    return Object.keys(data?.by_period ?? {});
  }, [granularity, start, data]);

  /** 照 `periods` 的順序取值,缺的補 0。三條線與三條 sparkline 都走這一支。 */
  const series = useCallback(
    (source: Record<string, number> | undefined) => periods.map((p) => source?.[p] ?? 0),
    [periods],
  );

  /**
   * 「每人平均題數」那張卡的 sparkline:**逐期算比值**,不是題數。
   *
   * ⚠️ 不要直接餵 `by_period_logged_in`(題數)——那條線跟卡片上的數字
   * 不是同一個量:某一天登入的人暴增時,比值往下掉而題數往上衝,
   * 大數字顯示下跌、底下的線卻在上升。
   *
   * 分母是 0 的那一格補 0(那天沒人登入,「每人平均」沒有意義),
   * 跟大數字那邊的 `perUserQuestions` 同一條規則。
   */
  const perUserSeries = useMemo(() => {
    const questions = data?.by_period_logged_in;
    const people = data?.logins_by_period;
    return periods.map((p) => {
      const q = questions?.[p] ?? 0;
      const n = people?.[p] ?? 0;
      return n === 0 ? 0 : q / n;
    });
  }, [periods, data]);

  const trendPoints = useTrendData(periods, data?.by_period);

  /*
   * 各帳號:後端已經照次數由多到少排好,照它的順序畫。
   * ⚠️ 不要在這裡重排 —— 那樣「為什麼這個排在前面」就變成兩個地方在決定。
   * (使用者自己點表頭排序是另一回事:那是他當下要看的順序,再點到第三下就回到這個順序,
   * 見底下的 rankTable。)
   * 佔比的分母是**這份清單的總和**,不是 `total_questions`:兩者多半一樣,
   * 但用清單自己的總和,百分比一定加得起來是 100%。
   */
  const rankRows: RankRow[] = useMemo(() => {
    const entries = Object.entries(data?.by_user ?? {});
    const sum = entries.reduce((acc, [, value]) => acc + value, 0) || 1;
    return entries.map(([name, value], index) => ({
      id: name,
      rank: index + 1,
      name,
      value,
      share: value / sum,
      avgDuration: data?.by_user_avg_duration?.[name],
    }));
  }, [data]);

  /**
   * ProgressBar 的分母。
   *
   * ⚠️ 用**第一名的題數**,不是總和。用總和的話第一名那條也只有二三成滿,
   * 整欄看起來都是短短的一截,而這一欄要回答的是「誰比誰多」——
   * 模板的 Top pages 也是拿 `Math.max(...)`。佔比那一欄才是對總和的比例。
   */
  const rankMax = useMemo(
    () => rankRows.reduce((max, r) => Math.max(max, r.value), 0) || 1,
    [rankRows],
  );

  /**
   * 每人平均題數 = 已登入的題數 ÷ 登入人數。
   *
   * ⚠️ 分母是 0 的時候回 0,不是 NaN —— 沒有人登入的那一天,畫面上要顯示「0.0」,
   * 不是「NaN」。這在只選一天、而那天沒人登入時很容易發生。
   */
  const perUserQuestions = useMemo(() => {
    const ratio = (questions?: number, people?: number) =>
      !questions || !people ? 0 : questions / people;
    return {
      current: ratio(data?.logged_in_questions, data?.login_user_count),
      previous:
        data?.previous?.logged_in_questions === undefined ||
        data?.previous?.login_user_count === undefined
          ? undefined
          : ratio(data.previous.logged_in_questions, data.previous.login_user_count),
    };
  }, [data]);


  /*
   * 點帳號跳去明細,**日期區間要一起帶過去**。
   *
   * 少了它的話:使用者選了「今天」,看到某人今天問了 3 題,點進去卻是他
   * 從上線到現在的全部題目 —— 而畫面上沒有任何地方會說「區間被丟掉了」。
   * 明細頁的每一個篩選條件都住在網址上,就是為了讓這條連結完整。
   */
  const detailHref = useCallback(
    (name: string) => {
      const params = new URLSearchParams({user: name});
      if (start) params.set('start', start);
      if (end) params.set('end', end);
      return `/stats/questions?${params.toString()}`;
    },
    [start, end],
  );

  // 整列可點 → 那個人的題目明細(不是只有帳號名稱可點)
  const rowLink = useTableRowLink<RankRow>({
    href: (row) => detailHref(row.name),
  });

  /*
   * 排行表的欄位。**照模板 Engagement 的 Top pages 排**:
   *
   *   名稱(固定寬) | 量(佔滿,ProgressBar + 底下一行數字) | 其他指標(固定寬) …
   *
   *  1. **沒有名次欄**。列本來就照多到少排,再放一欄 1/2/3 是同一件事講兩次。
   *  2. **佔比條用 Astryx 的 `ProgressBar`**,不要自刻 div:它自己處理了無障礙
   *     (`isLabelHidden` 仍然留 aria-label)。
   *  3. **數字在長條底下**,不是右邊另一欄(模板是 `VStack gap={1}`):
   *     長條給形狀、底下那行給精確值。
   */
  const rankColumns: TableColumn<RankRow>[] = [
    {
      key: 'name',
      header: '帳號',
      width: pixel(160),
      renderCell: (row) => (
          /*
            ⚠️ **這個 `Link` 不能拿掉。**

            整列都可以點(見底下的 `rowLink`),但那是**滑鼠**的路 —— 它掛的是
            `onClick`,tab 不到、報讀軟體也念不出來。鍵盤與報讀軟體走的就是這個
            連結。拿掉之後這張表對他們就沒有出口了。
            也不要把列做成 `role="link"` 來省掉它:整列的表格語意會被蓋掉,
            欄位標題與值的對應關係消失 —— 見 `useTableRowLink.tsx` 的說明。
          */
          <Link href={detailHref(row.name)}>{row.name}</Link>
        ),
    },
    {
      key: 'value',
      header: '提問數',
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={1}>
          <ProgressBar
            value={row.value}
            max={rankMax}
            label={`${row.name} 的提問數`}
            isLabelHidden
          />
          <Text type="supporting">{row.value} 題</Text>
        </VStack>
      ),
    },
    {
      key: 'share',
      header: '佔比',
      width: pixel(96),
      renderCell: (row) => (
        <Text type="supporting" color="secondary">
          {(row.share * 100).toFixed(1)}%
        </Text>
      ),
    },
    {
      key: 'avgDuration',
      header: '平均耗時',
      width: pixel(112),
      renderCell: (row) => (
        <Text type="supporting" color="secondary">
          {row.avgDuration === undefined ? '—' : formatAverageDuration(row.avgDuration)}
        </Text>
      ),
    },
  ];

  // 點表頭排序、拖表頭改欄寬(全站資料表共用,見 components/tableKit.ts)
  const rankTable = useTableKit<RankRow>({
    storageKey: 't100_table_cols:stats_rank',
    columns: rankColumns,
    data: rankRows,
    comparators: RANK_COMPARATORS,
    // 沒有平均耗時的升降冪都排最後
    emptyLast: {avgDuration: (r) => r.avgDuration === undefined},
  });

  // 標題底下不放說明句。
  return (
    <AdminPage title="用量統計">
      {/*
        篩選自成一塊(muted):跟底下那些「結果」分開,
        掃過去一眼看得出哪邊是可以動的、哪邊是算出來的。

        ⚠️ **用 `Card` 不用 `Section`**。`Section variant="muted" padding={3}` 配底下的
        `Card`(padding 預設 4)—— 兩種元件的內距與邊界本來就不同,並排時
        左右緣對不齊,看起來就像這一塊比較窄。
        同一種元件、同一組預設值,對齊問題自然消失,順帶也有了外框線。
      */}
      <RunningPanel />

      <Card variant="muted">
        <HStack gap={3} vAlign="end" wrap="wrap">
          {/*
            ⚠️ **只有起訖**:沒有統計單位切換、沒有快捷鈕(見檔頭)。
            起訖一格:設計系統的 DateRangeInput,雙月曆,先點起點再點終點,
            選不出「開始晚於結束」的組合。沒有 ×:用量頁一定要有一段期間;「全部」時顯示 placeholder。
          */}
          <DateRangeInput
            label="期間"
            value={start && end ? {start, end} : null}
            placeholder={openRangeLabel(start, end) ?? '全部期間'}
            hasClear={false}
            // 動日期就不是「全部」了,range 記號要一起清掉(不清的話會被 range=all 蓋掉)
            onChange={(r) => patchParams({start: r?.start, end: r?.end, range: undefined})}
          />
        </HStack>
      </Card>

      <AsyncSection
        loading={loading}
        failed={failed}
        reload={reload}
        hasData={!!data}
        errorTitle="用量資料載入失敗。"
        loadingLabel="正在載入用量"
      >
        <VStack gap={6}>
          {/*
            ── 段落一:趨勢 ──
            模板的節奏是「大圖在最上面、KPI 卡接在它下面」:先看形狀,再看數字。
            段落標題右邊掛一顆動作鈕(模板的 Reload),這裡就是重新抓資料。
          */}
          <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
            <Heading level={3}>提問趨勢</Heading>
            <Button label="重新整理" variant="secondary" size="md" onClick={reload} />
          </HStack>

          {/* 不包 Card:模板的大圖就是直接放在頁面上 */}
          <TrendChart
            data={trendPoints}
            /* 小時粒度:每 6 格 = 6 小時一個標籤(模板本身是每 8 小時)。
               其他粒度交給 recharts 自己算。 */
            tickEvery={granularity === 'hour' ? 6 : undefined}
          />

          {/*
            KPI 卡四張:提問數 / 平均耗時 / 登入人數 / 每人平均題數。
            不畫「總花費」(`total_cost_usd` 仍然在 API 上)。
            兩層 Grid(照 dashboard 模板),理由見 KPI_PAIR_MIN_WIDTH。
          */}
          <Grid columns={{minWidth: KPI_PAIR_MIN_WIDTH, repeat: 'fit'}} gap={4}>
            <Grid columns={{minWidth: KPI_MIN_WIDTH, repeat: 'fit'}} gap={4}>
              <MetricCard
                label="提問數"
                value={data?.total_questions ?? 0}
                previous={data?.previous?.total_questions}
                hint={comparisonHint(data?.previous?.total_questions, '題')}
                sparkline={series(data?.by_period)}
              />
              <MetricCard
                label="平均耗時"
                value={formatAverageDuration(data?.avg_duration_ms ?? 0)}
                current={data?.avg_duration_ms}
                previous={data?.previous?.avg_duration_ms}
                /* 耗時變短是好事 —— 模板寫死「上=綠、下=紅」,這張要反過來 */
                lowerIsBetter
                hint={
                  data?.previous
                    ? `較對照期的 ${formatAverageDuration(data.previous.avg_duration_ms)}`
                    : '從送出到答完的平均'
                }
                sparkline={series(data?.avg_duration_by_period)}
                formatSparkline={formatAverageDuration}
              />
            </Grid>
            <Grid columns={{minWidth: KPI_MIN_WIDTH, repeat: 'fit'}} gap={4}>
              {/*
                ⚠️ 「登入人數」是「有幾個人登入成功過」(後端查 audit_log,重複登入不重複計),
                不是「有幾個帳號問過問題」(by_user)。登入了卻沒問問題的人也算 ——
                不要改用 by_user 算。
              */}
              <MetricCard
                label="登入人數"
                value={data?.login_user_count ?? 0}
                previous={data?.previous?.login_user_count}
                hint={
                  data?.previous?.login_user_count === undefined
                    ? '這段期間登入過的人數,重複登入不重複計'
                    : `較對照期的 ${data.previous.login_user_count} 人`
                }
                sparkline={series(data?.logins_by_period)}
              />
              {/*
                「每人平均題數」:前三張各回答一個面向 —— 量(提問數)、
                廣度(登入人數)、效率(平均耗時),缺的是**深度**:進來的人用得多不多。
                它也是唯一一個「登入人數變多但題數沒跟上」時會往下掉的指標。

                ⚠️ 分子是 `logged_in_questions` **不是** `total_questions`:分母是登入人數,
                分子也只算登入的人問的題。
              */}
              <MetricCard
                label="每人平均題數"
                value={perUserQuestions.current.toFixed(1)}
                current={perUserQuestions.current}
                previous={perUserQuestions.previous}
                hint={
                  perUserQuestions.previous === undefined
                    ? '每位登入者問了幾題'
                    : `較對照期的 ${perUserQuestions.previous.toFixed(1)}`
                }
                sparkline={perUserSeries}
                formatSparkline={(v) => v.toFixed(1)}
              />
            </Grid>
          </Grid>

          <Divider />

          {/* ── 段落二:這一堆題目怎麼分 ── */}
          <Heading level={3}>組成</Heading>
          <Grid columns={{minWidth: 320, repeat: 'fit'}} gap={4}>
            <ShareBarCard title="專案" data={toSlices(data?.by_knowledge_base)} />
            {/*
              畫耗時分布、不畫題目狀態:狀態幾乎永遠是一條 100% 的「已完成」(running
              只在那幾秒內存在)。耗時分布回答的是**平均耗時回答不了**的那件事:
              平均會被少數跑很久的題目拉高,而看的人真正想知道的是「有幾題慢到讓人等不下去」。
              後端的 `by_status` 欄位還在,只是不畫。
            */}
            <ShareBarCard title="耗時分布" data={durationSlices(data?.by_duration_bucket)} />
          </Grid>

          <Divider />

          {/*
            ── 段落三:誰問的 ──

            標題是「各帳號的提問數」,不用模板的「Engagement」。
            卡片裡**沒有**第二層標題與「看全部題目」的連結 ——
            段落標題已經講過一次,卡裡再寫一次是同一句話講兩遍。
          */}
          <Heading level={3}>各帳號的提問數</Heading>
          <Card>
            {rankRows.length === 0 ? (
              <Text type="supporting" color="secondary">
                這段期間沒有資料。
              </Text>
            ) : (
              <Stack ref={rankTable.wrapRef} {...rankTable.wrapProps}>
                <Table<RankRow>
                  data={rankTable.data}
                  columns={rankTable.columns}
                  idKey="id"
                  density="compact"
                  dividers="rows"
                  hasHover
                  /* 整列可點 → 那個人的題目明細 */
                  plugins={{...rankTable.plugins, rowLink}}
                />
              </Stack>
            )}
          </Card>
        </VStack>
      </AsyncSection>
    </AdminPage>
  );
}

/** 「較對照期的 N 題」。沒有對照期時改顯示一句說明。 */
function comparisonHint(previous: number | undefined, unit: string): string {
  return previous === undefined ? '這段期間送出的題數' : `較對照期的 ${previous} ${unit}`;
}

/**
 * 耗時分布 → 圖例。
 *
 * 後端回的鍵固定是 fast / medium / slow 三個(沒有那一段也會是 0),
 * 界線在 `routers/stats.py` 的 `_FAST_MS` / `_SLOW_MS`。
 * ⚠️ 中文字與界線是**兩個地方各寫一次**的同一件事 —— 改界線的話這裡的字要跟著改。
 */
const DURATION_LABEL: Record<string, string> = {
  fast: '10 秒內',
  medium: '10–30 秒',
  slow: '超過 30 秒',
};

function durationSlices(source: Record<string, number> | undefined) {
  return toSlices(source).map((s) => ({...s, label: DURATION_LABEL[s.label] ?? s.label}));
}

/**
 * **現在**有誰在問問題,全站一覽。
 *
 * `/api/ask/runs` 刻意只回自己的(它的用途是把自己問到一半的對話接回來),
 * 管理員也不例外;這一區走的是另一支端點。
 *
 * ⚠️ **沒有人在跑的時候整區不渲染,連標題一起收掉**:空標題才真的看起來像壞了,
 * 而整區不見的時候,看的人不會去想它為什麼是空的。有人在跑的那一刻它自己會出現
 * (每 5 秒輪詢)。**不要**加 `emptyText` 或任何「目前沒有…」的句子。
 *
 * **出現 / 消失要長出來、收回去**:這一區在頁面**最上面**,瞬間掛上 / 拔掉的話,
 * 底下的篩選、趨勢圖、KPI 整頁跟著跳 —— 而觸發它的是背景輪詢,不是使用者自己的動作。
 * 殼是 `grid-template-rows: 0fr → 1fr`(同 `Chat.tsx` 的 `growShell`:要的就是
 * 「真的把版面推開」,transform 假裝不了)+ 淡入。收回去演完(`GROW_CLOSE_MS`)
 * 就整個拔掉,演的那 165ms 裡掛 `inert`。
 */
export function RunningPanel() {
  // loading / failed 不取:這一區沒有載入中與錯誤畫面(見上面的說明),
  // 讀不到就等於「現在沒有人在跑」,整區不出現。
  const {data, reload} = useAsyncData(useCallback(() => getRunningQuestions(), []));

  /*
   * 每 5 秒自己更新一次。這一區的價值就是「即時」——
   * 要使用者自己按重新整理才看得到現況的話,它跟歷史清單沒有差別。
   *
   * 5 秒是取捨:一題動輒跑十幾分鐘,更快沒有意義;更慢的話「他剛送出」
   * 到「畫面上出現」之間的空窗會長到讓人以為沒送出去。
   */
  useEffect(() => {
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [reload]);

  /*
   * 沒有人在跑(或還沒讀到)就整區不渲染 —— 包含標題。
   *
   * ⚠️ 也包含**第一次還在載入**的那幾百毫秒:這一區是加值資訊,
   * 為它閃一個 spinner 只會讓頁面在開的時候多跳一次。
   */
  const hasRuns = !!data && data.length > 0;
  /** 收回去那 165ms 裡 `data` 已經是空的 —— 留住最後一份,不要先變成空殼再收 */
  const lastRuns = useRef(data);
  if (hasRuns) lastRuns.current = data;
  /** 有沒有掛著(收回去演完才拔)/ 是不是展開的(掛上時先收著畫一幀,下一幀才打開) */
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    if (hasRuns) {
      setIsMounted(true);
      /*
       * 兩個 rAF:先讓「收著(0fr、透明)」的樣子真的畫出一幀,再切到打開 ——
       * 一掛上就是 1fr 的話沒有起點可以補間。收到一半又有人送出時已經掛著,
       * 直接打開,transition 從當下那一幀反向接回去。
       */
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setIsOpen(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setIsOpen(false);
    const timer = window.setTimeout(() => setIsMounted(false), GROW_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [hasRuns]);

  const runs = lastRuns.current;
  if (!isMounted || !runs || runs.length === 0) return null;

  return (
    <Stack xstyle={[growStyles.shell, runningStyles.shell, isOpen && growStyles.open]}>
      <Stack xstyle={growStyles.clip} inert={!isOpen}>
    <VStack gap={2} xstyle={[runningStyles.content, isOpen && runningStyles.contentShown]}>
      {/*
        ⚠️ 這一區**要有標題**。它跟底下那些數字的時間尺度完全不同
        (「此刻」vs「一段期間的累計」),沒有標題的話會被讀成統計的一部分,
        而那會讓人以為那幾張 KPI 卡也是即時的。
      */}
      <Heading level={3}>正在執行</Heading>
      {/*
        ⚠️ **這裡不包 `AsyncSection`**。它有三種畫面:載入中、
        錯誤、空 —— 而這一區三種都不要:上面那個 early return 已經把「沒資料」
        (含還在載、含讀失敗)全部收掉了,到得了這裡就一定有東西可畫。

        ⚠️ **不要因為「其他區塊都有包」就加上去。** 每 5 秒輪詢一次的區塊配
        `AsyncSection` 的話,網路抖一下整塊就換成錯誤卡片,下一次輪詢
        又回來,畫面在閃。讀失敗就當作「現在沒人在跑」,安靜地不出現。

        ⚠️ **一列一列的資料用 `Item`,不要一列包一張 `Card`。**
        設計系統的規則是「Dense data = rows (Table, List/Item), never
        Card-wrapped list items;Card is for standalone widgets」
        (frontend/.claude/CLAUDE.md)—— 這一頁的排行榜也是照這條用表格。
      */}
      {(
        <List>
          {runs.map((run) => (
            <Item
              key={run.run_id}
              as="li"
              align="start"
              label={run.question}
              labelLines={2}
              description={
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Text type="supporting">{run.owner ?? '—'}</Text>
                  <Text type="supporting" color="secondary">
                    已經跑了 {formatStepDuration(run.elapsed_ms)}
                  </Text>
                  {run.knowledge_base ? (
                    <Text type="supporting" color="secondary">
                      {run.knowledge_base}
                    </Text>
                  ) : null}
                </HStack>
              }
            />
          ))}
        </List>
      )}
    </VStack>
      </Stack>
    </Stack>
  );
}

const runningStyles = stylex.create({
  /**
   * 殼:收著是 0fr。
   * ⚠️ `marginBlockEnd` 抵掉 `AdminPage` 那一層 `VStack gap={5}`:gap 不管子項是不是零高,
   * 收著(剛掛上那一幀、收回去那 165ms)時那 20px 還在 —— 一掛上就先跳 20px,等於白做。
   * 那段間距改由被夾住的內容自己帶(`content` 的 `paddingBlockEnd`),跟著殼一起收
   *(理由同 `Chat.tsx` 的 `suggestionsFade`:`min-height: 0` 夾不掉 padding,放在殼上收不乾淨)。
   * ⚠️ 改 `AdminPage` 的 gap 要一起改這兩個值。
   *
   * 收起:165ms、`--ease-standard`、不延遲 —— 那是系統回應,不留戀(同 `growShell`)。
   * ⚠️ 演完就拔掉的計時器用 `GROW_CLOSE_MS`(共用殼的收起時間,`components/growShell.ts`)。
   * reduce:高度不補間,**等淡出演完才一次收掉**(`0s` 的 transition 加延遲),
   * 不然高度當場歸零,淡出根本看不到。
   */
  /** 疊在共用的 `growStyles.shell` 上:抵掉 gap 的負邊距,與 reduce 時「等淡出演完才收」 */
  shell: {
    marginBlockEnd: 'calc(-1 * var(--spacing-5))',
    transition: {
      default: 'grid-template-rows var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'grid-template-rows 0s linear var(--duration-fast)',
    },
  },
  /** 內容淡入淡出 —— reduce 時留下的就是這一半(淡入是有助理解的那一半,位移才是要拿掉的) */
  content: {
    paddingBlockEnd: 'var(--spacing-5)',
    opacity: 0,
    transition: 'opacity var(--duration-fast) var(--ease-standard)',
  },
  contentShown: {
    opacity: 1,
  },
});
