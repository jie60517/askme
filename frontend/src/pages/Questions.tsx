/**
 * 用量明細(管理員):每一題問了什麼、claude 每一步碰了哪個檔、耗掉多少 token。
 *
 * 這一頁是 `/stats`(總覽:幾題、誰問得多)的下一層。分兩頁不是為了排版 ——
 * 兩邊回答的問題不一樣:總覽回答「多不多」,這一頁回答「為什麼這麼貴」。
 *
 * 版面上的三條規則:
 *
 *  - **問題顯示全文,不截斷。** 這一頁存在的理由就是「他到底問了什麼」;
 *    截成一行的話,看到一題花了 $8 還是不知道他在問什麼,而那正是要判斷的事。
 *  - **時間軸預設「只看動作」。** 完整版照「輪」分組(工具收在發動它的那一輪
 *    底下),因為攤平就看不出「一輪叫了六個工具」跟「六輪各叫一個」的差別,
 *    而那兩件事的成本結構完全不同。但那個版本裡每個動作之間夾著 2~3 列 token,
 *    想回答的若是「它到底查了什麼」就整個被淹掉。所以預設收起 token,要查成本再切過去。
 *  - **重複的標的排在時間軸前面。** 它是整張表最有價值的一格:同一個檔讀了六次
 *    代表它在原地繞,而聊天頁的「參考來源」去重過,那裡永遠只會顯示一次。
 *
 * ⚠️ **`has_steps === false` 要明講「沒有明細」,不要顯示成 0。**
 * 「這題沒查任何檔」跟「這題沒有留下明細」在畫面上都是空白,意思相反。
 */
import {useCallback, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ChevronRight, X} from 'lucide-react';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {DateRangeInput} from '../components/astryx/DateRangeInput';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Divider} from '@astryxdesign/core/Divider';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Layout, LayoutContent, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Pagination} from '@astryxdesign/core/Pagination';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Table, pixel, proportional} from '@astryxdesign/core/Table';
import type {TableColumn} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';
import {TextInput} from '@astryxdesign/core/TextInput';
import * as stylex from '@stylexjs/stylex';

import {AdminPage} from '../components/AdminPage';
import {AsyncSection} from '../components/AsyncSection';
import {LoadingScreen} from '../components/LoadingScreen';
import {TableCard} from '../components/TableCard';
import {useCompactTableSync, useTableKit} from '../components/tableKit';
import {useDialogExit} from '../components/useDialogExit';
import {useTableRowSelect} from '../components/useTableRowSelect';
import {
  QUESTION_PAGE_SIZE,
  askerOf,
  getQuestionDetail,
  getQuestions,
  type QuestionOrder,
  type QuestionUsage,
  type QuestionUsageDetail,
  type RepeatedTarget,
  type UsageStep,
} from '../lib/adminApi';
import {formatAdminTime, formatStepDuration} from '../lib/time';
import {enumParam, isoDateParam, openRangeLabel} from '../lib/urlParams';
import {useSearchParamsPatch} from '../lib/useSearchParamsPatch';
import {useAsyncData} from '../lib/useAsyncData';

const ORDERS: Array<{value: QuestionOrder; label: string}> = [
  {value: 'created_at', label: '最新'},
  {value: 'cost_usd', label: '最貴'},
  // ⚠️ 後端只排「這一頁」(跨頁排序要 join 整張流水帳)。標籤刻意寫「本頁」
  // 而不是「最耗 token」—— 不然翻到第 3 頁看到小數字會以為壞了。
  {value: 'tokens', label: '本頁最耗 token'},
];

const styles = stylex.create({
  /** 問題全文。保留使用者打的換行,不然貼一段 log 進來會變成一坨。 */
  questionText: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  /**
   * 時間軸左邊那條軸線。用 border 不用絕對定位的細長 div ——
   * 後者在展開/收合時會跟內容高度差一格,而 border 永遠跟著內容長。
   */
  turnGroup: {
    borderInlineStartWidth: 'calc(var(--border-width) * 2)',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: 'var(--color-border)',
    paddingInlineStart: 'var(--spacing-3)',
  },
  /** 路徑/指令一律等寬字:對齊之後同一個目錄底下的檔案掃得出來 */
  mono: {
    fontFamily: 'var(--font-family-code)',
    wordBreak: 'break-all',
  },
  /** 數字欄位對齊用。表格裡的數字不對齊,大小差一個位數就看不出來 */
  numeric: {
    fontVariantNumeric: 'tabular-nums',
  },
  /**
   * 表格版右側的詳情面板。捲動時跟著留在畫面上(sticky),內容太長就自己捲,
   * 不然看長時間軸時要捲回最上面才找得到是哪一列。
   */
  detailPanel: {
    // 不能縮:旁邊的表格有最小欄寬,flex 預設會把面板壓成 0 寬
    flexShrink: 0,
    position: 'sticky',
    insetBlockStart: 'var(--spacing-4)',
  },
  /**
   * 面板那張卡片:標題列固定、內容自己捲。
   * ⚠️ 高度上限 = min(表格高度, 視窗高度 − 上下留白)。只用視窗高度的話,面板比表格還長時
   * 整頁會多出一條捲軸、版面往左跳 8px,面板自己又一條 —— 兩條捲軸並排。
   */
  detailCard: (maxHeight: string) => ({
    display: 'flex',
    flexDirection: 'column',
    maxHeight,
  }),
});

/**
 * `12345` → `1.2萬`。時間軸上一排數字,寫滿位數會擠掉標的路徑。
 *
 * ⚠️ 單位用**萬/億**不用 k/M。這一頁的讀者不一定是工程師 ——
 * `13.9萬` 一眼有量感,`139.5k` 要先換算。
 * 一萬以下不縮寫,直接補千分位:那個範圍的差別(899 對 1,349)是有意義的。
 */
function compactTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 100_000_000) return `${(n / 10_000).toFixed(1)}萬`;
  return `${(n / 100_000_000).toFixed(2)}億`;
}

function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  return `$${usd.toFixed(2)}`;
}

export default function Questions() {
  /*
   * **每一個篩選條件都住在網址裡**,沒有任何一個放在元件狀態。
   *
   * 總覽頁的排行表點一列會帶著 `user` 與日期區間跳過來;任何一個條件放在
   * useState 的話,那個條件在跳過來的那一刻就**被丟掉** —— 看的是「這個人這段
   * 期間問了幾題」,點進去卻變成他全部的題目。
   */
  const {params, patch, clear} = useSearchParamsPatch();
  const user = params.get('user') ?? '';
  const q = params.get('q') ?? '';
  // 三個都要驗(跟用量統計那頁同一支),理由見 lib/urlParams.ts
  const order = enumParam(
    params.get('order'),
    ORDERS.map((o) => o.value),
    'created_at' as QuestionOrder,
  );
  // 只帶一端的網址照開放區間查,期間格用 placeholder 講出來(見 openRangeLabel)
  const start = isoDateParam(params.get('start'));
  const end = isoDateParam(params.get('end'));
  const page = Math.max(1, Number(params.get('page')) || 1);
  // 表格版點開的那一題(右側面板 / 窄的時候對話框)。換條件、翻頁之後那一題不一定還在這一頁 ——
  // 不在的話 QuestionsTable 找不到它,面板自然不出現
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const fetcher = useCallback(
    () =>
      getQuestions({
        user,
        q,
        order,
        start,
        end,
        offset: (page - 1) * QUESTION_PAGE_SIZE,
      }),
    [user, q, order, start, end, page],
  );
  const {data, loading, failed, reload} = useAsyncData(fetcher);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / QUESTION_PAGE_SIZE));
  const hasFilter = !!(user || q || start || end);

  /**
   * 改篩選條件。
   *
   * ⚠️ **除了翻頁本身,任何改動都要把 `page` 一起清掉** —— 停在第 5 頁而新的
   * 條件只有 2 頁的話,畫面會變成一片空白,看起來像壞了。翻頁直接用 `patch`。
   */
  const filter = (fields: Record<string, string | undefined>) => patch({...fields, page: undefined});

  const summary = useMemo(() => {
    if (!data) return null;
    const withSteps = data.items.filter((i) => i.has_steps);
    return {
      shown: data.items.length,
      total: data.total,
      // 只加總「有明細」的那幾題,不然沒有明細的 0 會把平均拉下來而看不出來
      detailed: withSteps.length,
      tokens: withSteps.reduce((sum, i) => sum + i.input_tokens + i.output_tokens, 0),
    };
  }, [data]);

  return (
    <AdminPage title="用量明細">
      <Card variant="muted">
        <VStack gap={3}>
          <HStack gap={3} vAlign="end" wrap="wrap">
            <TextInput
              label="帳號"
              value={user}
              placeholder="全部"
              onChange={(value: string) => filter({user: value})}
            />
            <TextInput
              label="問題關鍵字"
              value={q}
              placeholder="只搜問題,不搜答案"
              onChange={(value: string) => filter({q: value})}
            />
            {/* 起訖一格(設計系統的 DateRangeInput):雙月曆先點起點再點終點;空著 = 不限,× 清掉 */}
            <DateRangeInput
              label="期間"
              value={start && end ? {start, end} : null}
              placeholder={openRangeLabel(start, end) ?? '不限'}
              onChange={(r) => filter({start: r?.start, end: r?.end})}
            />
            {hasFilter ? (
              <Button
                label="清除篩選"
                variant="secondary"
                size="sm"
                onClick={clear}
              />
            ) : null}
          </HStack>
          <SegmentedControl
            label="排序"
            value={order}
            onChange={(value: string) => filter({order: value})}
          >
            {ORDERS.map((o) => (
              <SegmentedControlItem key={o.value} value={o.value} label={o.label} />
            ))}
          </SegmentedControl>
        </VStack>
      </Card>

      <AsyncSection
        loading={loading}
        failed={failed}
        reload={reload}
        hasData={!!data}
        isEmpty={data?.items.length === 0}
        errorTitle="用量明細載入失敗。"
        loadingLabel="正在載入用量明細"
        emptyText="這個條件下沒有問答紀錄。"
      >
        <VStack gap={4}>
          {summary ? (
            <Text type="supporting" color="secondary">
              共 {summary.total} 題,這一頁 {summary.shown} 題;其中 {summary.detailed} 題有每步明細,
              合計 {compactTokens(summary.tokens)} tokens。
            </Text>
          ) : null}

          {/* 一題一列的表格,不用一題一張卡片(Astryx 規範不允許卡片疊成清單) */}
          <QuestionsTable items={data?.items ?? []} selectedId={selectedId} onSelect={setSelectedId} />

          {totalPages > 1 ? (
            <Pagination
              page={page}
              totalPages={totalPages}
              onChange={(next: number) => patch({page: String(next)})}
            />
          ) : null}
        </VStack>
      </AsyncSection>
    </AdminPage>
  );
}

/**
 * 一題。上半是「誰、什麼時候、問了什麼、花了多少」,下半是展開才抓的時間軸。
 *
 * ⚠️ 時間軸**點開才抓**:一頁 20 題,每題幾百步,一次全抓等於把整張流水帳
 * 搬到瀏覽器上,而管理員一次只會看其中一兩題。
 */
function QuestionDetail({item, defaultOpen = false}: {item: QuestionUsage; defaultOpen?: boolean}) {
  const [open, setOpen] = useState(defaultOpen);
  const asker = askerOf(item);

  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="label">{asker}</Text>
        <Text type="supporting" color="secondary">
          {formatAdminTime(item.created_at)}
        </Text>
        {item.knowledge_base ? (
          <Token label={item.knowledge_base} size="sm" />
        ) : null}
        {/*
          「已刪除」:提問的人把這組對話刪掉了。**這一列仍然要在**:成本與 token 是帳,
          不該因為他清掉自己的側邊欄就從統計上消失(見後端 models.QARecord.deleted_at)。
        */}
        {questionStatuses(item).map((st) => (
          <StatusToken key={st} status={st} />
        ))}
      </HStack>

      {/*
        ⚠️ 刪掉的題目**內容已經被清空了**(刪除當下就清了,不是這裡藏起來)。
        直接畫 `item.question` 的話會是一片空白,而空白會被讀成
        「他送出了一題空的問題」—— 那是錯的訊息。所以明講。
      */}
      {item.deleted_at ? (
        <Text type="body" color="secondary">
          內容已隨對話刪除。下面的成本與 token 仍然算數。
        </Text>
      ) : (
        <Text xstyle={styles.questionText}>{item.question}</Text>
      )}

      <HStack gap={4} wrap="wrap">
        <Metric label="成本" value={formatCost(item.cost_usd)} />
        <Metric
          label="耗時"
          value={item.duration_ms === null ? '—' : formatStepDuration(item.duration_ms)}
        />
        {item.has_steps ? (
          <>
            <Metric label="輪數" value={String(item.turns)} />
            <Metric label="工具呼叫" value={String(item.tool_calls)} />
            <Metric label="新讀" value={compactTokens(item.input_tokens)} />
            <Metric label="寫出" value={compactTokens(item.output_tokens)} />
            <Metric label="沿用" value={compactTokens(item.cache_read_tokens)} />
          </>
        ) : null}
      </HStack>

      {item.has_steps ? (
        // 設計系統的 Collapsible。時間軸**打開才抓**(見 QuestionDetail 上面的說明)
        <Collapsible isOpen={open} onOpenChange={setOpen} trigger={<Text type="label">每一步</Text>}>
          {open ? <Timeline id={item.id} /> : null}
        </Collapsible>
      ) : (
        /*
          ⚠️ 這句話一定要在,而且**要分得出三種空**。少了它,三種情況在畫面上
          一模一樣,而它們的意思完全不同:

            過了保留期  明細被清掉了(超過 QA_STEPS_RETENTION_DAYS,預設 90 天)
            沒有記錄    這一題本來就沒有留下每步明細
            真的沒查     它問了但一個檔都沒讀

          日期範圍拉長時一次會列出很多超過保留期的舊題目。不講的話,那一片空白
          會被讀成「數字算錯了」。
          `steps_expired` 由後端算(保留期是後端的設定,見 stats.py)。
        */
        <Text type="supporting" color="secondary">
          {item.steps_expired
            ? '這一題的每步明細已經過了保留期被清掉了(成本與耗時仍然算數)。'
            : '這一題沒有留下每步明細。'}
        </Text>
      )}
    </VStack>
  );
}

/** 各欄最窄多少 px。全部加起來比表格寬就切成精簡版(只留 COMPACT_KEYS),跟流程清單同一套(tableKit) */
const QUESTION_MIN_PX: Record<string, number> = {asker: 96, question: 240, status: 84, cost: 72, duration: 72, turns: 76, act: 88};
/**
 * 表格的最小寬 = 各欄最小寬 + 每欄左右內距(Astryx 的表格會把這個加總設成 `min-width`;
 * 例如 4 欄精簡版要 512 = 384 + 4 × 32)。不算內距的話門檻太低,該切精簡版時沒切。
 */
const CELL_PADDING_PX = 32;
const QUESTION_MIN_TOTAL_PX =
  Object.values(QUESTION_MIN_PX).reduce((a, b) => a + b, 0) + Object.keys(QUESTION_MIN_PX).length * CELL_PADDING_PX;
/** 精簡版:狀態標籤併進問題那一格(見 statusToken 的呼叫處),只留三欄 */
const QUESTION_COMPACT_KEYS = new Set(['asker', 'question', 'act']);

/** 一題身上可能有的狀態。正常完成、沒刪的沒有任何標籤 */
type QuestionStatus = 'running' | 'failed' | 'deleted';

/**
 * 狀態 → 標籤的**唯一一份**對照(表格與右側詳情共用)。
 * 回答中用藍色(資訊),不用黃色(警告):還在跑不是出事。
 */
const STATUS_TOKEN: Record<QuestionStatus, {label: string; color: 'blue' | 'red' | 'gray'}> = {
  running: {label: '回答中', color: 'blue'},
  failed: {label: '失敗', color: 'red'},
  deleted: {label: '已刪除', color: 'gray'},
};

/** 這一題身上有哪些狀態,照優先序排(回答中的不算失敗)。正常完成、沒刪的是空陣列 */
function questionStatuses(it: QuestionUsage): QuestionStatus[] {
  const out: QuestionStatus[] = [];
  if (it.status === 'running') out.push('running');
  else if (!it.success) out.push('failed');
  if (it.deleted_at) out.push('deleted');
  return out;
}

function StatusToken({status}: {status: QuestionStatus}) {
  return <Token size="sm" color={STATUS_TOKEN[status].color} label={STATUS_TOKEN[status].label} />;
}

/** 表格那一格的狀態標籤(Token,不是 Badge:這是狀態不是計數)。只放**最優先的一個**;詳情的標題列才全部列出來 */
function statusToken(it: QuestionUsage) {
  const [first] = questionStatuses(it);
  return first ? <StatusToken status={first} /> : null;
}
/** 右側詳情面板的寬;外框比「面板 + 精簡版表格」還窄時,詳情改成跳對話框 */
const DETAIL_PANEL_PX = 440;
// 面板 + 間距 + 面板開著時的兩欄表格最少要多寬(提問人 96、問題 160、內距、卡片外框,合計 384)
const SIDE_PANEL_MIN_OUTER_PX = DETAIL_PANEL_PX + 16 + 384;

/** 量一個元素的寬高(callback ref,跟 tableKit 同一個理由:元素可能晚一點才掛上來) */
function useElementSize(): [{width: number; height: number}, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({width: 0, height: 0});
  useLayoutEffect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({width: r.width, height: r.height});
    const ro = new ResizeObserver(([entry]) =>
      setSize({width: entry.contentRect.width, height: entry.contentRect.height}),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [size, setEl];
}

/**
 * 題目清單(照 Astryx 官方樣板):
 *  - Searchable Table:一題一列、欄位對齊,數字欄 tabular-nums;
 *  - Grouped Table:點一列 → 右側開詳情面板(QuestionDetail,時間軸預設展開)。
 *
 * 跟全站其他資料表同一套 `useTableKit`(卡片外框、拖欄寬、窄了切精簡版)。**不開表頭排序**:
 * 這一頁的排序是後端跨頁排的(上面的「最新 / 最貴」),表頭排序只排得到這一頁,兩個並存會讓人誤會。
 *
 * 整列可點只給滑鼠;鍵盤走最後一欄的「看每一步」(理由同 useTableRowLink:列要保持 role="row")。
 * 精簡版那一欄換成只有箭頭的小鈕,鍵盤一樣進得去。
 *
 * 寬度不夠的三段:
 *  1. 欄位放不下 → 精簡版(提問人 / 問題 / 狀態 / 箭頭鈕),數字全在詳情裡;
 *  2. 詳情開著 → 表格一律精簡版;
 *  3. 外框連「面板 + 精簡版表格」都放不下 → 詳情改成對話框,不擠在旁邊。
 * 問題文字截斷時**不冒全文提示框**(`hasTruncateTooltip={false}`):那個框會蓋住上一列,全文點開詳情就有。
 */
function QuestionsTable({
  items,
  selectedId,
  onSelect,
}: {
  items: QuestionUsage[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const latest = useRef({selectedId, onSelect});
  latest.current = {selectedId, onSelect};
  const [{width: outerWidth}, outerRef] = useElementSize();
  // 表格那一欄的高度:面板的高度上限要跟它對齊(見 styles.detailCard)
  const [{height: tableHeight}, tableBoxRef] = useElementSize();
  // 0 = 還沒量到:先當成寬的(大多數螢幕),量到之後才決定
  const usesSidePanel = outerWidth === 0 || outerWidth >= SIDE_PANEL_MIN_OUTER_PX;
  const [isCompact, setIsCompact] = useState(false);

  const rowSelect = useTableRowSelect<QuestionUsage>(selectedId, onSelect);
  /**
   * 窄版明細對話框的退場(不接的話吃設計系統預設的 400ms 進場、往焦點方向偏 16px、
   * 關掉硬切)。清選取放延後那側 —— 淡出的 165ms 裡內容還要在。
   */
  const detailExit = useDialogExit((open: boolean) => {
    // 淡出那 165ms 裡剛好轉向、換成側邊面板的話,一樣清掉 —— 使用者剛剛明確關掉了這一題,
    // 換個版面又冒出來反而奇怪
    if (!open) onSelect(null);
  });

  const columns = useMemo<TableColumn<QuestionUsage>[]>(() => {
    const cols: TableColumn<QuestionUsage>[] = [
      {
        key: 'asker',
        header: '提問人',
        width: proportional(2, {minWidth: QUESTION_MIN_PX.asker}),
        renderCell: (it) => (
          <VStack gap={0}>
            <Text type="body">{askerOf(it)}</Text>
            <Text type="supporting" color="secondary">
              {formatAdminTime(it.created_at)}
            </Text>
          </VStack>
        ),
      },
      {
        key: 'question',
        header: '問題',
        width: proportional(6, {minWidth: (selected && usesSidePanel) || isCompact ? 160 : QUESTION_MIN_PX.question}),
        renderCell: (it) => (
          <VStack gap={0}>
            {it.deleted_at ? (
              <Text type="body" color="secondary">
                內容已隨對話刪除
              </Text>
            ) : (
              <Text type="body" maxLines={2} hasTruncateTooltip={false}>
                {it.question}
              </Text>
            )}
            {/* 精簡版沒有「狀態」欄:失敗 / 已刪除的標籤改放在專案名稱那一行 */}
            {it.knowledge_base || (isCompact && statusToken(it)) ? (
              <HStack gap={2} vAlign="center" wrap="wrap">
                {it.knowledge_base ? (
                  <Text type="supporting" color="secondary">
                    {it.knowledge_base}
                  </Text>
                ) : null}
                {isCompact ? statusToken(it) : null}
              </HStack>
            ) : null}
          </VStack>
        ),
      },
      {
        key: 'status',
        header: '狀態',
        width: pixel(84),
        renderCell: (it) => statusToken(it),
      },
      {
        key: 'cost',
        header: '成本',
        width: pixel(72),
        renderCell: (it) => <Text type="body" xstyle={styles.numeric}>{formatCost(it.cost_usd)}</Text>,
      },
      {
        key: 'duration',
        header: '耗時',
        width: pixel(72),
        renderCell: (it) => (
          <Text type="body" xstyle={styles.numeric}>
            {it.duration_ms === null ? '—' : formatStepDuration(it.duration_ms)}
          </Text>
        ),
      },
    ];
    /*
     * 右側面板開著時表格只剩「提問人 / 問題」(主從式:左邊挑、右邊看;失敗 / 已刪除面板上有標籤),
     * 數字全在面板裡 —— 1100 寬的視窗扣掉側邊欄與面板只剩三百多 px,塞不下其他欄。
     */
    if (selected && usesSidePanel) return cols.slice(0, 2);
    // token 三個數字不放表格(放了之後 1100 寬的視窗就得橫向捲動),點開詳情看
    cols.push({
      key: 'turns',
      header: '輪/工具',
      width: pixel(76),
      renderCell: (it) => (
        <Text type="body" xstyle={styles.numeric}>
          {it.has_steps ? `${it.turns} / ${it.tool_calls}` : '—'}
        </Text>
      ),
    });
    cols.push({
      key: 'act',
      header: '',
      // 精簡版換成只有箭頭的小鈕(仍有 label 給報讀與鍵盤;不加 tooltip)
      width: pixel(isCompact ? 44 : 88),
      renderCell: (it) =>
        isCompact ? (
          <IconButton
            label="看每一步"
            icon={<Icon icon={ChevronRight} size="sm" />}
            variant="ghost"
            size="sm"
            onClick={() => latest.current.onSelect(it.id)}
          />
        ) : (
          <Button label="看每一步" variant="ghost" size="sm" onClick={() => latest.current.onSelect(it.id)} />
        ),
    });
    return isCompact ? cols.filter((c) => QUESTION_COMPACT_KEYS.has(c.key)) : cols;
  }, [selected, usesSidePanel, isCompact]);

  const table = useTableKit<QuestionUsage>({
    storageKey: 't100_table_cols:questions',
    columns,
    data: items,
    notSortable: Object.keys(QUESTION_MIN_PX),
    isResizable: !isCompact && !(selected && usesSidePanel),
  });
  useCompactTableSync(setIsCompact, false, table.tableWidth, QUESTION_MIN_TOTAL_PX);

  const detail = selected ? (
    <QuestionDetail key={selected.id} item={selected} defaultOpen={selected.has_steps} />
  ) : null;

  return (
    <Stack ref={outerRef}>
      <HStack gap={4} vAlign="start">
        <StackItem size="fill">
          <Stack ref={tableBoxRef}>
            <Stack ref={table.wrapRef} {...table.wrapProps}>
              <TableCard>
                <Table<QuestionUsage>
                  data={table.data}
                  columns={table.columns}
                  idKey="id"
                  density="balanced"
                  dividers="rows"
                  hasHover
                  plugins={{...table.plugins, rowSelect}}
                />
              </TableCard>
            </Stack>
          </Stack>
        </StackItem>
        {selected && usesSidePanel ? (
          <Stack width={DETAIL_PANEL_PX} xstyle={styles.detailPanel}>
            <Card
              padding={0}
              xstyle={styles.detailCard(
                tableHeight > 0
                  ? `min(${Math.round(tableHeight)}px, calc(100dvh - var(--spacing-8)))`
                  : 'calc(100dvh - var(--spacing-8))',
              )}
            >
              <HStack gap={2} vAlign="center" paddingBlock={2} paddingInline={4}>
                <StackItem size="fill">
                  <Text type="label">這一題的明細</Text>
                </StackItem>
                <IconButton
                  label="關閉"
                  icon={<Icon icon={X} size="sm" />}
                  variant="ghost"
                  size="sm"
                  onClick={() => onSelect(null)}
                />
              </HStack>
              <Divider />
              <StackItem size="fill" isScrollable>
                <Stack padding={4}>{detail}</Stack>
              </StackItem>
            </Card>
          </Stack>
        ) : null}
      </HStack>
      {/* 外框太窄放不下側邊面板:同一份詳情改用對話框(purpose=info:沒有輸入框,點外面就關) */}
      <Dialog
        isOpen={!!selected && !usesSidePanel}
        {...detailExit.dialogProps}
        purpose="info"
        width="min(560px, calc(100vw - var(--spacing-8)))"
      >
        <Layout
          header={<DialogHeader title="這一題的明細" onOpenChange={detailExit.dialogProps.onOpenChange} />}
          content={<LayoutContent>{!usesSidePanel && selected ? <QuestionDetail key={selected.id} item={selected} defaultOpen={selected.has_steps} /> : null}</LayoutContent>}
        />
      </Dialog>
    </Stack>
  );
}

function Metric({label, value}: {label: string; value: string}) {
  return (
    <VStack gap={0}>
      <Text type="supporting" color="secondary">
        {label}
      </Text>
      <Text type="label" xstyle={styles.numeric}>
        {value}
      </Text>
    </VStack>
  );
}

/** 一題的時間軸。展開時才抓。 */
function Timeline({id}: {id: number}) {
  const fetcher = useCallback(() => getQuestionDetail(id), [id]);
  const {data, loading, failed, reload} = useAsyncData<QuestionUsageDetail>(fetcher);
  /* 預設「只看動作」—— 見檔頭第二條規則。查成本的人才需要切到含用量那邊。 */
  const [view, setView] = useState<'actions' | 'all'>('actions');

  /** 只留工具列。這就是「它到底做了什麼」那份清單。 */
  const toolSteps = useMemo(
    () => (data ? data.steps.filter((s) => s.kind === 'tool') : []),
    [data],
  );

  /*
   * 頂上那一行彙總。**分類照「使用者關心的動作」而不是工具名** ——
   * Grep 跟 Glob 對他來說都是「搜尋」,Write 跟 Edit 都是「產出」。
   * 認不得的工具歸到「其他」而不是丟掉:漏掉一個動作比多一個分類糟。
   */
  const summary = useMemo(() => {
    let read = 0;
    let search = 0;
    let command = 0;
    let write = 0;
    let other = 0;
    for (const step of toolSteps) {
      const tool = step.tool ?? '';
      if (tool === 'Read') read += 1;
      else if (tool === 'Grep' || tool === 'Glob') search += 1;
      else if (tool === 'Bash') command += 1;
      else if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') write += 1;
      else other += 1;
    }
    const parts = [`${toolSteps.length} 個動作`];
    if (read) parts.push(`讀 ${read}`);
    if (search) parts.push(`搜尋 ${search}`);
    if (command) parts.push(`指令 ${command}`);
    if (write) parts.push(`產出 ${write}`);
    if (other) parts.push(`其他 ${other}`);
    return parts.join(' · ');
  }, [toolSteps]);

  /*
   * 照 turn 分組,並在走的過程中把「記著」與「多了/少了」算出來。
   *
   * ⚠️ 用 seq 的順序建組,不要用 turn 當索引直接塞 —— 子代理(subturn)跟主線
   * 共用 turn 編號,照索引塞會互相蓋掉。
   *
   * 這兩個值要在這裡算而不是在後端:它們是**畫面的順序**決定的。後端算好送
   * 過來的話,前端一改排序它就錯了,而且錯得看不出來。
   *
   * ⚠️ 不要算「累計」= 輸入+輸出 一路加總 ——
   * 那個數字在快取生效的題目上小到沒有意義(整題累計可能只有一百多,而它實際上
   * 讀了十幾萬)。這裡算的是「記著」= 這一輪腦中的
   * 總量(輸入+沿用+存起來),那才是會一路長大、看得出哪一輪開始失控的量。
   */
  const groups = useMemo(() => {
    if (!data) return [];
    const out: Array<{
      turn: number;
      steps: Array<{step: UsageStep; context: number | null; delta: number | null}>;
    }> = [];
    /*
     * 上一輪「讀進去的總量」(輸入 + 命中快取 + 寫入快取)。下一輪減掉它,
     * 就是**上面那幾個工具往脈絡裡塞了多少** —— 也就是「那個動作貴不貴」。
     *
     * ⚠️ 三個欄位要一起加。只看「輸入」會嚴重低估:同樣讀一份 20k 的檔,
     * 第一次是「寫入快取」、第二次之後變「命中快取」,而「輸入」兩次都很小。
     *
     * ⚠️ **只在主線的輪之間相減。** 子代理有自己的脈絡,拿它跟主線比會得到
     * 一個很大的正數再一個很大的負數,兩邊都不是真的。
     *
     * 認不得的欄位是 null 而不是 0(後端刻意的),所以整輪三個都是 null 時
     * 留 null 不要算 —— 算出來會是「這一輪比上一輪少讀了 158k」那種假訊號。
     */
    let prevContext: number | null = null;
    for (const step of data.steps) {
      let context: number | null = null;
      let delta: number | null = null;

      const known =
        step.input_tokens !== null ||
        step.cache_read_tokens !== null ||
        step.cache_creation_tokens !== null;
      if (known) {
        context =
          (step.input_tokens ?? 0) +
          (step.cache_read_tokens ?? 0) +
          (step.cache_creation_tokens ?? 0);
        // 相減只在主線的輪之間做,理由見上面
        if (step.kind === 'turn') {
          if (prevContext !== null) delta = context - prevContext;
          prevContext = context;
        }
      }

      const entry = {step, context, delta};
      const last = out[out.length - 1];
      if (last && last.turn === step.turn) last.steps.push(entry);
      else out.push({turn: step.turn, steps: [entry]});
    }
    return out;
  }, [data]);

  if (failed) {
    return (
      <HStack gap={2} vAlign="center">
        <Text type="supporting" color="secondary">
          這一題的每步明細載入失敗。
        </Text>
        <Button label="重試" variant="secondary" size="sm" onClick={reload} />
      </HStack>
    );
  }
  if (loading && !data) return <LoadingScreen isCompact label="正在載入每一步" />;
  if (!data) return null;

  return (
    <VStack gap={3}>
      <Divider />

      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <Text type="supporting" color="secondary">
            {summary}
          </Text>
        </StackItem>
        <SegmentedControl
          label="時間軸內容"
          value={view}
          onChange={(value: string) => setView(value === 'all' ? 'all' : 'actions')}
        >
          <SegmentedControlItem value="actions" label="只看動作" />
          <SegmentedControlItem value="all" label="含用量" />
        </SegmentedControl>
      </HStack>

      {/*
        名詞對照。**只在「含用量」那邊出現** —— 只看動作的人不需要,
        常駐一行會讓本來就密的版面更擠。

        放在這裡而不是做成八個問號圖示:這是「第一次看需要、之後就不用」的
        東西,而問號要滑過去才出現,等於第一次看的人根本不知道可以問。
      */}
      {view === 'all' ? (
        <Text type="supporting" color="secondary">
          新讀 = 這一輪重新讀進去的(最貴) · 沿用 = 之前讀過直接用(約十分之一價) ·
          存起來 = 這次存進快取,之後可沿用 · 記著 = 它這一輪腦中的總量
        </Text>
      ) : null}

      {data.repeats.length > 0 ? (
        <VStack gap={1}>
          <Text type="label">重複碰到的標的</Text>
          <Text type="supporting" color="secondary">
            同一個檔被讀不只一次,代表它在原地繞。聊天頁的「參考來源」去重過,只會顯示一次。
          </Text>
          <RepeatTable repeats={data.repeats} />
        </VStack>
      ) : null}

      {view === 'actions' ? (
        toolSteps.length === 0 ? (
          /* ⚠️ 「沒叫工具」跟「沒有明細」不一樣,話要講死 —— 兩者畫面上都是空的。 */
          <Text type="supporting" color="secondary">
            這一題沒有叫任何工具,是憑既有知識回答的。
          </Text>
        ) : (
          <ToolTable steps={toolSteps} />
        )
      ) : (
        <VStack gap={3}>
          {groups.map((group, i) => (
            <VStack key={`${group.turn}-${i}`} gap={1} xstyle={styles.turnGroup}>
              {group.steps.map(({step, context, delta}) =>
                step.kind === 'tool' ? (
                  <ToolRow key={step.seq} step={step} />
                ) : (
                  <TurnRow key={step.seq} step={step} context={context} delta={delta} />
                ),
              )}
            </VStack>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

/*
 * 「只看動作」與「重複碰到的標的」用設計系統的 Table:
 * 這兩個是單純的清單,用表格有欄位標題、欄位對得齊,而且不太增加長度。
 * ⚠️ 「含用量」**刻意用**自己排的時間軸(底下的 ToolRow / TurnRow + 左邊那條線):
 * 那是一輪一輪的,套表格每輪都要重複表頭,長度多出兩成以上,還會失去那條軸線。
 * 欄寬:時間與耗時是窄的數字欄,標的吃剩下的寬度。
 */
const TOOL_COLUMNS: Array<TableColumn<UsageStep & Record<string, unknown>>> = [
  {
    key: 'at_ms',
    header: '時間',
    width: pixel(72),
    // 帶 `+` 是「距離開題第幾秒」,不是耗時(理由見 ToolRow)
    renderCell: (s) => (
      <Text type="supporting" color="secondary" xstyle={styles.numeric}>
        {s.at_ms === null ? '' : `+${formatStepDuration(s.at_ms)}`}
      </Text>
    ),
  },
  {key: 'tool', header: '工具', width: pixel(88), renderCell: (s) => <Text type="supporting">{s.tool}</Text>},
  {
    key: 'target',
    header: '標的',
    width: proportional(1),
    renderCell: (s) => (
      <VStack gap={0}>
        <Text type="supporting" xstyle={styles.mono}>
          {s.target_full ?? s.target}
        </Text>
        {s.detail ? (
          <Text type="supporting" color="secondary" xstyle={styles.mono}>
            {s.detail}
          </Text>
        ) : null}
      </VStack>
    ),
  },
  {
    key: 'duration_ms',
    header: '耗時',
    width: pixel(72),
    align: 'end',
    // 沒等到結果就留白,不要寫 0(理由見 ToolRow)
    renderCell: (s) => (
      <Text type="supporting" xstyle={styles.numeric}>
        {s.duration_ms === null ? '' : formatStepDuration(s.duration_ms)}
      </Text>
    ),
  },
];

function ToolTable({steps}: {steps: UsageStep[]}) {
  return (
    <Table
      density="compact"
      verticalAlign="top"
      idKey="seq"
      data={steps as Array<UsageStep & Record<string, unknown>>}
      columns={TOOL_COLUMNS}
    />
  );
}

const REPEAT_COLUMNS: Array<TableColumn<RepeatedTarget & Record<string, unknown>>> = [
  {
    key: 'count',
    header: '次數',
    width: pixel(64),
    renderCell: (r) => (
      <Text type="supporting" color="secondary" xstyle={styles.numeric}>
        {r.count}×
      </Text>
    ),
  },
  {key: 'tool', header: '工具', width: pixel(88), renderCell: (r) => <Text type="supporting">{r.tool}</Text>},
  {
    key: 'target',
    header: '標的',
    width: proportional(1),
    renderCell: (r) => (
      <Text type="supporting" xstyle={styles.mono}>
        {r.target}
      </Text>
    ),
  },
];

function RepeatTable({repeats}: {repeats: RepeatedTarget[]}) {
  return (
    <Table
      density="compact"
      idKey={(r) => `${r.tool}:${r.target}`}
      data={repeats as Array<RepeatedTarget & Record<string, unknown>>}
      columns={REPEAT_COLUMNS}
    />
  );
}

/**
 * 工具呼叫:第幾秒發生、什麼工具、碰了哪個標的、花了多久。
 *
 * ⚠️ **前面那個數字帶 `+` 是刻意的:它是「距離開題第幾秒」,不是耗時。**
 * 不要把 `at_ms` 直接餵給 `formatStepDuration`(那個 helper 的註解寫著
 * 「這一步花多久」),畫面上會變成一排看起來像耗時、其實是時間戳的數字 ——
 * 而且愈後面的步驟看起來愈慢,完全是誤導。真正的耗時是右邊那個。
 */
function ToolRow({step}: {step: UsageStep}) {
  return (
    <HStack gap={2} vAlign="start" wrap="nowrap">
      <Text type="supporting" color="secondary" xstyle={styles.numeric}>
        {step.at_ms === null ? '' : `+${formatStepDuration(step.at_ms)}`}
      </Text>
      <Text type="supporting">{step.tool}</Text>
      <StackItem size="fill">
        <VStack gap={0}>
          {/* 完整那份優先。沒有 target_full 的資料退回縮短版而不是留白。 */}
          <Text type="supporting" xstyle={styles.mono}>
            {step.target_full ?? step.target}
          </Text>
          {step.detail ? (
            <Text type="supporting" color="secondary" xstyle={styles.mono}>
              {step.detail}
            </Text>
          ) : null}
        </VStack>
      </StackItem>
      {/*
        沒等到 tool_result 就沒有耗時(被停止、逾時)。**留白,不要寫 0** ——
        0 會被讀成「這一步是瞬間完成的」,而事實是我們不知道。
      */}
      {step.duration_ms === null ? null : (
        <Text type="supporting" xstyle={styles.numeric}>
          {formatStepDuration(step.duration_ms)}
        </Text>
      )}
    </HStack>
  );
}

/**
 * 一次模型呼叫。**帳算在這種列上** —— 一輪可能同時發出好幾個工具呼叫,
 * 沒有辦法誠實地把 token 拆給個別工具(見後端 models.QAStep 的說明)。
 *
 * 欄位名稱刻意**不用 API 的原名**(input / output / cache_read /
 * cache_creation):「輸入」直覺是「它讀了多少」,而那一欄其實只是
 * 「沒被快取蓋到的那一小段」。對照:
 *
 *   新讀    input           這一輪重新讀進去的。最貴,越小越好。
 *   寫出    output          它這一輪吐出來的字。
 *   沿用    cache_read      之前讀過、這次直接用。約十分之一價,越大越好。
 *   存起來  cache_creation  這次新存進快取的,之後可以沿用。
 *   記著    上面三個相加     它這一輪腦中的總量。看「哪一輪開始失控」靠它。
 */
function TurnRow({
  step,
  context,
  delta,
}: {
  step: UsageStep;
  context: number | null;
  delta: number | null;
}) {
  const isSub = step.kind === 'subturn';
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Token label={isSub ? '子代理' : `第 ${step.turn + 1} 輪`} color={isSub ? 'purple' : 'blue'} size="sm" />
      {step.model ? (
        <Text type="supporting" color="secondary">
          {step.model}
        </Text>
      ) : null}
      <Text type="supporting" xstyle={styles.numeric}>
        新讀 {compactTokens(step.input_tokens)}
      </Text>
      <Text type="supporting" xstyle={styles.numeric}>
        寫出 {compactTokens(step.output_tokens)}
      </Text>
      <Text type="supporting" color="secondary" xstyle={styles.numeric}>
        沿用 {compactTokens(step.cache_read_tokens)}
      </Text>
      {step.cache_creation_tokens ? (
        <Text type="supporting" color="secondary" xstyle={styles.numeric}>
          存起來 {compactTokens(step.cache_creation_tokens)}
        </Text>
      ) : null}
      {/*
        這一輪比上一輪多讀進去多少 = 上面那幾個工具塞了多少東西進來。
        「哪個動作最貴」直接看這一欄,不用自己相減。

        ⚠️ 負數要照實顯示,不要當成 0 —— 脈絡縮水(快取過期、被壓縮)是真的
        會發生的事,而把它藏起來會讓後面幾輪的數字看起來莫名其妙。
        第一輪沒有上一輪可比,留白。
      */}
      {delta === null ? null : (
        <Text
          type="supporting"
          color={delta > 0 ? 'primary' : 'secondary'}
          xstyle={styles.numeric}
        >
          {delta > 0 ? '多了 ' : '少了 '}
          {compactTokens(Math.abs(delta))}
        </Text>
      )}
      {/* 這一輪腦中的總量。一路長大,所以看得出哪一輪開始失控 */}
      {context === null ? null : (
        <Text type="supporting" color="secondary" xstyle={styles.numeric}>
          記著 {compactTokens(context)}
        </Text>
      )}
    </HStack>
  );
}
