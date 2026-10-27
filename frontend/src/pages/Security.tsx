/**
 * 安全(管理員;`/locks` 與 `/audit` 都導到這一頁)。
 *
 * 三塊:目前被鎖住的帳號 / IP(可以手動解開)、允許登入的 IP(地理封鎖的例外)、
 * 最近的稽核事件(篩選 + 分頁)。
 *
 * 版面照設計系統的 `npx @astryxdesign/cli template table-grouped`:
 * 1. 整頁收進置中的內容欄(`AdminPage`),不貼著左邊。
 * 2. 稽核事件照 **table-grouped** 的形:一條工具列(類別 + 搜尋)+ 一張
 *    **照日期收合分組**的表。分組走設計系統的 `useTableGroupedRows`
 *    (範本裡自己拼 `TableRow colSpan` 的那段是示範,正式做法是這個 hook)。
 *    分組維度挑**日期**而不是類別:類別已經是上面那條 SegmentedControl 在做的事
 *    (而且那是**後端**在篩,分頁筆數才會對),同一件事做兩次只會互相打架;
 *    而「這一天發生了什麼」正是看稽核紀錄的人腦子裡的問題。
 * 3. 封鎖清單是**表格的列**,不是一鎖一張 Card。設計系統的原則是
 *    dense data = rows,card soup 是它點名的反例(`astryx docs layout`);
 *    而且封鎖清單通常是空的或一兩筆,卡片把兩行字撐成一個大方塊。
 *
 * ⚠️ **這一頁的內容是繁體中文**,但**側邊欄那條連結是英文**(見 `Sidebar.tsx`)。
 * **事件的 `detail` 照後端原樣顯示** —— 有些事件
 * 只有那一欄看得出原因。
 */
import {useCallback, useMemo, useState} from 'react';

import {Token} from '@astryxdesign/core/Token';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Pagination} from '@astryxdesign/core/Pagination';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {
  Table,
  pixel,
  proportional,
  useTableGroupedRows,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Code} from '@astryxdesign/core/Code';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Search} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import {AdminPage} from '../components/AdminPage';
import {FieldWithMessage} from '../components/FieldMessage';
import {TableCard} from '../components/TableCard';
import {useTableKit} from '../components/tableKit';
import {AsyncSection} from '../components/AsyncSection';
import {
  AUDIT_PAGE_SIZE,
  addGeoAllow,
  getAudit,
  getGeoAllow,
  getLocks,
  removeGeoAllow,
  unlock,
  type AuditCategory,
  type AuditEntry,
  type GeoAllowEntry,
  type LockEntry,
} from '../lib/adminApi';
import {errorMessage} from '../lib/errors';
import {formatAdminDay, formatAdminTime, formatCountdown} from '../lib/time';
import {toastError, toastInfo} from '../lib/toast';
import {useAsyncData} from '../lib/useAsyncData';

const styles = stylex.create({
  /**
   * 「內容」欄的寬度上限。
   * ⚠️ 一定要下在**內層**這一格上,不能下在 `<td>`:auto table-layout 下
   * `<td>` 的 max-width 會被瀏覽器忽略,一則長訊息會把前面幾欄整個擠扁。
   */
  detailCell: {
    /*
     * 用 `ch`(字寬)不是寫死 px:這一欄是**一段文字**,它該有多寬取決於
     * 一行放幾個字讀起來舒服,而不是幾個像素 —— 而且字級一變它會自己跟著。
     * 52 是一般認為好讀的行長(45~75 之間偏短的那一端,因為旁邊還有四欄)。
     */
    maxWidth: '52ch',
    overflowWrap: 'anywhere',
  },
});

/**
 * 事件代號 → 看得懂的一句話。`danger` 的標紅。
 *
 * ⚠️ **查不到的事件要原樣顯示**:後端加新事件時,
 * 這一頁不該變成一排空白 —— 看到代號至少還查得出那是什麼。
 */
const EVENT_LABEL: Record<string, {label: string; danger?: boolean}> = {
  login_success: {label: '登入成功'},
  login_failed: {label: '登入失敗', danger: true},
  login_blocked: {label: '登入被鎖', danger: true},
  /* 地理封鎖(GEO_BLOCK_ENABLED):來源不在台灣、或判不出國別而被擋下的登入。
     試跑模式那一筆**不是危險事件** —— 那時候人是進得來的,它只是「如果真的開了會被擋」。 */
  login_blocked_geo: {label: '登入被擋(來源地區)', danger: true},
  login_geo_dryrun: {label: '地區封鎖試跑(未實際擋下)'},
  /* 二階驗證的兩種「密碼對了卻沒進來」。 */
  login_mfa_failed: {label: '驗證碼錯誤', danger: true},
  /*
   * 後端**照記**這一筆(它是「密碼對了卻沒完成第二關」的唯一證據),但 `/api/audit`
   * 預設把它濾掉 —— 它只是中間狀態,每一次正常登入才不會多一列。
   * 對照留著,是給帶 `?include_challenges=1` 查證據的時候用。
   */
  login_mfa_challenged: {label: '送出驗證碼'},
  login_no_mfa_binding: {label: '未綁定驗證器', danger: true},
  /*
   * 兩條「少過了一關」。**都不標 danger** —— 它們是管理員自己開的
   * 設定在生效,不是異常;標紅的話真正的異常會被淹掉。但它們一定要看得見:
   * 這是事後回答「這次登入到底過了幾關」的唯一依據。
   */
  login_geo_allowlisted: {label: '境外白名單放行'},
  login_mfa_skipped_ip: {label: '公司 IP 免驗證碼'},
  /*
   * 白名單**本身被改了**。跟上面那兩條的差別是「設定在生效」與「設定被改變」——
   * 前者每天都會發生(不標紅,免得淹掉真正的異常),後者是有人動了一道門。
   * 標紅的理由跟 `role_changed`(「職稱就是權限」)同一條:權限變更混在一堆
   * 無害事件裡滑過去,就是事後查不出「這個境外來源是誰放進來的」。
   * 刪除是把門關上,不標紅。
   */
  geo_allow_added: {label: '新增境外白名單', danger: true},
  geo_allow_removed: {label: '刪除境外白名單'},
  account_created: {label: '建立帳號'},
  account_deleted: {label: '刪除帳號', danger: true},
  account_disabled: {label: '停用帳號', danger: true},
  account_enabled: {label: '啟用帳號'},
  // 權限是獨立開關時寫下的紀錄才有這個代號。留著才查得到。
  /*
   * ⚠️ **要標 danger**(「職稱就是權限」):改職稱**就是**在給或
   * 收回主機的 Bash 權限,而稽核紀錄是事後唯一查得到「誰給的」的地方。
   * 不標的話,權限變更會混在一堆無害事件裡滑過去。
   */
  role_changed: {label: '職稱/權限變更', danger: true},
  password_reset: {label: '重設密碼'},
  password_changed: {label: '修改密碼'},
  /*
   * SSH 終端機(/ssh)。連線 / 斷線是「誰在什麼時候進了主機」;上傳與刪除是會改主機的
   * 動作,刪除沒有回收桶所以標紅。**沒有**鍵盤輸入與畫面內容的紀錄(那會把 su 密碼
   * 之類的東西一起記進去),也不記下載與列目錄。
   */
  terminal_connect: {label: '終端機連線'},
  terminal_connect_failed: {label: '終端機連不上', danger: true},
  terminal_disconnect: {label: '終端機斷線'},
  terminal_denied: {label: '終端機被拒', danger: true},
  terminal_file_upload: {label: '終端機上傳檔案'},
  terminal_file_delete: {label: '終端機刪除檔案', danger: true},
  // 收線時把這條連線開的程式結束掉
  terminal_end_programs: {label: '終端機收線時結束程式'},
  terminal_ai_ask: {label: '終端機問 AI'},
  // Work Flow:刪除流程會連排程一起停掉,標紅
  workflow_saved: {label: '儲存 Work Flow'},
  workflow_deleted: {label: '刪除 Work Flow', danger: true},
  workflow_run: {label: '執行 Work Flow'},
  workflow_stop: {label: '停止 Work Flow'},
  // 排程到點但負責人已刪除、停用或沒有終端機權限,這次沒跑
  workflow_run_denied: {label: 'Work Flow 排程負責人失效', danger: true},
};

const CATEGORIES: Array<{value: AuditCategory; label: string}> = [
  {value: 'all', label: '全部'},
  {value: 'login', label: '登入'},
  // 沒有帳號、終端機分類:那些事件後端照記,這頁不給單獨的分類
];

export default function Security() {
  return (
    <AdminPage title="安全">
      <LocksPanel />
      <GeoAllowPanel />
      <AuditPanel />
    </AdminPage>
  );
}

// ── 目前封鎖 ───────────────────────────────────────────────────────────────

type LockRow = Record<string, unknown> & {
  id: string;
  kind: '帳號' | 'IP';
  entry: LockEntry;
};

const untilOrder = (retryAfter: number) => (retryAfter === -1 ? Infinity : retryAfter);

function LocksPanel() {
  const {data, loading, failed, reload} = useAsyncData(useCallback(() => getLocks(), []));
  /** 正在解哪一個 key(帳號或 IP);只鎖那一顆鈕 */
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const release = async (entry: LockEntry, kind: 'username' | 'ip') => {
    setBusyKey(entry.key);
    try {
      await unlock({[kind]: entry.key});
      toastInfo(`${entry.key} 已解鎖。`);
      reload();
    } catch (err) {
      toastError(errorMessage(err, '解鎖失敗。'));
    } finally {
      setBusyKey(null);
    }
  };

  const rows: LockRow[] = useMemo(() => {
    const accounts = (data?.accounts ?? []).map(
      (entry): LockRow => ({id: `a-${entry.key}`, kind: '帳號', entry}),
    );
    const ips = (data?.ips ?? []).map(
      (entry): LockRow => ({id: `i-${entry.key}`, kind: 'IP', entry}),
    );
    return [...accounts, ...ips];
  }, [data]);

  const columns: TableColumn<LockRow>[] = [
    {
      key: 'kind',
      header: '類型',
      width: pixel(80),
      renderCell: (row) => <Token label={row.kind} size="sm" />,
    },
    {
      key: 'key',
      header: '被鎖的對象',
      width: proportional(1),
      renderCell: (row) => <Text type="label">{row.entry.key}</Text>,
    },
    {
      key: 'until',
      header: '狀態',
      width: pixel(200),
      renderCell: (row) =>
        // retry_after === -1 是永久鎖(不會自己過期);其餘是還剩幾秒
        row.entry.retry_after === -1 ? (
          <Token label="永久鎖定" color="red" size="sm" />
        ) : (
          <Token
            label={`${formatCountdown(row.entry.retry_after)} 後自動解鎖`}
            color="yellow"
            size="sm"
          />
        ),
    },
    {
      key: 'actions',
      header: '',
      width: pixel(88),
      align: 'end',
      renderCell: (row) => (
        <Button
          label="解鎖"
          variant="secondary"
          size="sm"
          isLoading={busyKey === row.entry.key}
          onClick={() => void release(row.entry, row.kind === '帳號' ? 'username' : 'ip')}
        />
      ),
    },
  ];

  // 點表頭排序、拖表頭改欄寬(全站資料表共用,見 components/tableKit.ts)
  const table = useTableKit<LockRow>({
    storageKey: 't100_table_cols:security_locks',
    columns,
    data: rows,
    comparators: {
      kind: (a, b) => a.kind.localeCompare(b.kind),
      key: (a, b) => a.entry.key.localeCompare(b.entry.key),
      // 永久鎖(-1)排在「最久才解」那一端
      until: (a, b) => untilOrder(a.entry.retry_after) - untilOrder(b.entry.retry_after),
    },
    notSortable: ['actions'],
  });

  return (
    <VStack gap={2}>
      <Heading level={2}>目前被鎖定的</Heading>
      <AsyncSection
        loading={loading}
        failed={failed}
        reload={reload}
        hasData={!!data}
        errorTitle="鎖定清單載入失敗。"
        loadingLabel="正在載入鎖定清單"
      >
        {rows.length === 0 ? (
          /*
           * 沒有東西被鎖是**常態**,不要畫一個大空框 —— 那會讓人以為載入失敗;
           * 一行綠點就夠。⚠️ 這一態刻意**不走 `AsyncSection` 的 emptyText**:
           * 它要的不是一句灰字,是一個「一切正常」的狀態指示。
           *
           * ⚠️ `StatusDot` 的 `label` **不會顯示成文字**(那是給輔助技術的名稱),
           * 所以旁邊那行 `Text` 不能省 —— 省掉只剩一顆孤零零的綠點。
           */
          <Card variant="muted">
            <HStack gap={2} vAlign="center">
              <StatusDot variant="success" label="沒有生效中的鎖定" />
              <Text type="supporting" color="secondary">
                目前沒有任何帳號或 IP 被鎖。
              </Text>
            </HStack>
          </Card>
        ) : (
          <Stack ref={table.wrapRef} {...table.wrapProps}>
            <TableCard>
              <Table<LockRow>
                data={table.data}
                columns={table.columns}
                idKey="id"
                plugins={table.plugins}
                density="balanced"
                dividers="rows"
                hasHover
              />
            </TableCard>
          </Stack>
        )}
      </AsyncSection>
    </VStack>
  );
}

// ── 允許登入的 IP ─────────────────────────────────────────────────────────

type GeoRow = Record<string, unknown> & {id: string; entry: GeoAllowEntry};

/**
 * 允許登入的 IP(地理封鎖的例外,例如出差時的來源),新增 / 刪除都即時生效、不用重啟。
 *
 * ⚠️ **這一塊刻意只有 IP 一欄**:不放「給誰用的」「誰加的」、
 * 不放 `GEO_BLOCK_MODE` 的狀態卡,空清單時也不畫任何東西。
 *
 * ⚠️ 顯示的 `cidr` 一律用後端回的值,不是使用者打的字:`1.2.3.4` 會變成
 * `1.2.3.4/32`、`1.2.3.4/24` 會變成 `1.2.3.0/24` —— 後者實際放行的範圍比他
 * 以為的大 256 倍,清單上看得到才有機會發現。
 */
function GeoAllowPanel() {
  const {data, loading, failed, reload} = useAsyncData(useCallback(() => getGeoAllow(), []));
  const [ip, setIp] = useState('');
  /** 後端回的 400(網段太大、內網位址…)。**貼在輸入框上**,不用 toast —— 要改的就是那一格。 */
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** 正在刪哪一條;只鎖那一顆鈕(跟解鎖同一個作法)。 */
  const [busyCidr, setBusyCidr] = useState<string | null>(null);

  const submit = async () => {
    setAdding(true);
    try {
      const added = await addGeoAllow(ip.trim());
      // 講的是**後端存下來的那個值**,不是他打的字 —— 兩者可能不一樣(見上面)。
      toastInfo(`${added.cidr} 已經可以登入了。`);
      setIp('');
      setError(null);
      reload();
    } catch (err) {
      setError(errorMessage(err, '加不進去。'));
    } finally {
      setAdding(false);
    }
  };

  const drop = async (entry: GeoAllowEntry) => {
    setBusyCidr(entry.cidr);
    try {
      await removeGeoAllow(entry.cidr);
      toastInfo(`${entry.cidr} 已經不能登入了。`);
      reload();
    } catch (err) {
      toastError(errorMessage(err, '刪不掉。'));
      // 多半是 404(別人已經刪了)—— 重載一次讓畫面回到真的狀態
      reload();
    } finally {
      setBusyCidr(null);
    }
  };

  const rows: GeoRow[] = useMemo(
    () => (data ?? []).map((entry): GeoRow => ({id: entry.cidr, entry})),
    [data],
  );

  const columns: TableColumn<GeoRow>[] = [
    {
      key: 'cidr',
      header: 'IP',
      width: proportional(1),
      renderCell: (row) => <Code>{row.entry.cidr}</Code>,
    },
    {
      key: 'actions',
      header: '',
      width: pixel(88),
      align: 'end',
      renderCell: (row) => (
        <Button
          label="刪除"
          variant="secondary"
          size="sm"
          isLoading={busyCidr === row.entry.cidr}
          onClick={() => void drop(row.entry)}
        />
      ),
    },
  ];

  // 點表頭排序(全站資料表共用,見 components/tableKit.ts)。
  // 只有 IP 一欄內容,拖欄寬沒有東西可以讓 —— 不開
  const table = useTableKit<GeoRow>({
    storageKey: 't100_table_cols:security_geo',
    columns,
    data: rows,
    comparators: {cidr: (a, b) => a.entry.cidr.localeCompare(b.entry.cidr, undefined, {numeric: true})},
    notSortable: ['actions'],
    isResizable: false,
  });

  return (
    <VStack gap={2}>
      <Heading level={2}>允許登入的 IP</Heading>

      {/* 三個管理頁的每一塊一律 Card(見 AuditPanel 那段註解) */}
      <Card variant="muted">
        {/*
          靠上對齊:錯誤框掛在欄位底下會把這一格撐高,靠下的話「新增」會被推到錯誤框旁邊。
          標籤是隱藏的,欄位頂端就是這一格的頂端,靠上剛好跟按鈕齊。
        */}
        <HStack gap={3} vAlign="start" wrap="wrap">
          <StackItem size="fill">
            {/* 錯誤跟登入頁同一個樣子(見 components/FieldMessage.tsx) */}
            <FieldWithMessage error={error}>
              <TextInput
                label="IP 位址或網段"
                isLabelHidden
                placeholder="例如 1.2.3.4"
                value={ip}
                onChange={(value: string) => {
                  setIp(value);
                  setError(null);
                }}
              />
            </FieldWithMessage>
          </StackItem>
          <Button
            label="新增"
            variant="primary"
            isLoading={adding}
            isDisabled={!ip.trim()}
            onClick={() => void submit()}
          />
        </HStack>
      </Card>

      <AsyncSection
        loading={loading}
        failed={failed}
        reload={reload}
        hasData={!!data}
        errorTitle="白名單載入失敗。"
        loadingLabel="正在載入白名單"
      >
        {/* 空的時候**什麼都不畫** —— 上面那張新增卡片已經說明了這一區是什麼 */}
        {rows.length === 0 ? null : (
          <Stack ref={table.wrapRef} {...table.wrapProps}>
            <TableCard>
              <Table<GeoRow>
                data={table.data}
                columns={table.columns}
                idKey="id"
                plugins={table.plugins}
                density="balanced"
                dividers="rows"
                hasHover
              />
            </TableCard>
          </Stack>
        )}
      </AsyncSection>
    </VStack>
  );
}

// ── 最近事件 ───────────────────────────────────────────────────────────────

type AuditRow = Record<string, unknown> & {id: string; entry: AuditEntry};

function AuditPanel() {
  const [category, setCategory] = useState<AuditCategory>('all');
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  /** 收合的日期分組。由這一層持有(`useTableGroupedRows` 的契約) */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const {data, loading, failed, reload} = useAsyncData(
    useCallback(() => getAudit(category, page * AUDIT_PAGE_SIZE), [category, page]),
  );

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  /*
   * ⚠️ 搜尋是**這一頁之內**的過濾,不是後端查詢。
   * 講清楚很重要:分頁的筆數來自後端(`total`),過濾之後畫面上剩幾列跟
   * 那個數字對不起來是正常的 —— 所以底下的提示句會把「這一頁」講出來。
   * 不支援全庫搜尋(後端沒有對應參數)。
   */
  const rows: AuditRow[] = useMemo(() => {
    const all = (data?.items ?? []).map((entry) => ({id: String(entry.id), entry}));
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((r) => {
      const known = EVENT_LABEL[r.entry.event];
      return [known?.label, r.entry.event, r.entry.actor, r.entry.ip, r.entry.detail]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [data, query]);

  const columns: TableColumn<AuditRow>[] = [
    {
      key: 'created_at',
      header: '時間',
      width: pixel(130),
      renderCell: ({entry}) => (
        <Text type="supporting" color="secondary">
          {/* 絕對時間、中文(見 formatAdminTime)—— 對稽核紀錄要的是時刻,不是「幾小時前」 */}
          {formatAdminTime(entry.created_at)}
        </Text>
      ),
    },
    {
      key: 'event',
      header: '事件',
      width: pixel(170),
      renderCell: ({entry}) => {
        const known = EVENT_LABEL[entry.event];
        return (
          <HStack gap={2} vAlign="center">
            {/*
              「這是壞事」用 StatusDot 標,不是把字染紅:`Text` 的 color
              沒有 error 這一階(查過 TextColorMap),而且只靠顏色傳訊息
              對色覺障礙是無效的 —— 一顆有 aria-label 的點兩邊都成立。
            */}
            {known?.danger ? <StatusDot variant="error" label="安全相關" /> : null}
            {/* 查不到就原樣顯示代號 —— 新事件不會變成空白 */}
            <Text type="label">{known?.label ?? entry.event}</Text>
          </HStack>
        );
      },
    },
    {
      key: 'actor',
      header: '帳號',
      width: pixel(120),
      renderCell: ({entry}) => <Text type="body">{entry.actor || '—'}</Text>,
    },
    {
      key: 'ip',
      header: '來源 IP',
      width: pixel(130),
      renderCell: ({entry}) => (
        <Text type="supporting" color="secondary">
          {entry.ip || '—'}
        </Text>
      ),
    },
    {
      key: 'detail',
      header: '內容',
      width: proportional(1.5),
      renderCell: ({entry}) => (
        // 寬度上限在這一層,不是 <td>(見 styles.detailCell)
        <Stack xstyle={styles.detailCell}>
          <Text type="supporting" color="secondary">
            {entry.detail || '—'}
          </Text>
        </Stack>
      ),
    },
  ];

  /*
   * 照**日期**分組。`created_at` 直接當分組鍵會變成一筆一組
   *(它精確到微秒),所以走 `formatAdminDay`(見那個函式的說明)。
   * ⚠️ `data` / `plugin` / `idKey` 三個都要往下傳,少一個分組就不會生效。
   */
  // 點表頭排序、拖表頭改欄寬(全站資料表共用,見 components/tableKit.ts)。
  // 排序先做、再分組 —— 排序套在每一天裡面,日期的順序照舊
  const table = useTableKit<AuditRow>({
    storageKey: 't100_table_cols:security_audit',
    columns,
    data: rows,
    comparators: {
      created_at: (a, b) => Date.parse(a.entry.created_at) - Date.parse(b.entry.created_at),
      event: (a, b) =>
        (EVENT_LABEL[a.entry.event]?.label ?? a.entry.event).localeCompare(EVENT_LABEL[b.entry.event]?.label ?? b.entry.event, 'zh-Hant'),
      actor: (a, b) => (a.entry.actor || '').localeCompare(b.entry.actor || ''),
      ip: (a, b) => (a.entry.ip || '').localeCompare(b.entry.ip || '', undefined, {numeric: true}),
      detail: (a, b) => (a.entry.detail || '').localeCompare(b.entry.detail || '', 'zh-Hant'),
    },
  });

  const grouped = useTableGroupedRows<AuditRow>({
    data: table.data,
    groupBy: (row) => formatAdminDay(row.entry.created_at),
    collapsedGroups: collapsed,
    onToggleGroup: (key) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    getRowKey: (row) => row.id,
  });

  return (
    <VStack gap={2}>
      <Heading level={2}>最近的事件</Heading>

      {/* ⚠️ 三個管理頁的每一塊一律 `Card`,不要混用 `Section`(Section 沒有外框線) */}
      <Card variant="muted">
        <HStack gap={3} vAlign="end" wrap="wrap">
          <SegmentedControl
            label="事件類別"
            value={category}
            onChange={(value: string) => {
              setCategory(value as AuditCategory);
              /*
               * ⚠️ 換篩選一定要回第一頁。
               * 停在第 5 頁換到一個只有 3 頁的分類,offset 會超出範圍、
               * 後端回一個空陣列 —— 畫面看起來像「資料不見了」。
               */
              setPage(0);
              setCollapsed(new Set());
            }}
          >
            {CATEGORIES.map((c) => (
              <SegmentedControlItem key={c.value} value={c.value} label={c.label} />
            ))}
          </SegmentedControl>
          <StackItem size="fill">
            <TextInput
              label="搜尋這一頁"
              isLabelHidden
              placeholder="搜尋這一頁的事件、帳號、IP、內容…"
              value={query}
              onChange={setQuery}
              startIcon={Search}
              hasClear
              // 講清楚範圍:分頁的總筆數是後端算的,這個框只過濾眼前這 20 筆
              description="只過濾目前這一頁,不是整份紀錄。"
            />
          </StackItem>
        </HStack>
      </Card>

      <AsyncSection
        loading={loading}
        failed={failed}
        reload={reload}
        hasData={!!data}
        isEmpty={rows.length === 0}
        errorTitle="事件載入失敗。"
        loadingLabel="正在載入事件"
        emptyText={query.trim() ? '這一頁沒有符合的事件。' : '這個類別還沒有事件。'}
      >
        <VStack gap={3}>
          <Stack ref={table.wrapRef} {...table.wrapProps}>
            <TableCard>
              <Table<AuditRow>
                data={grouped.data}
                columns={table.columns}
                idKey={grouped.idKey}
                plugins={{...table.plugins, grouped: grouped.plugin}}
                density="balanced"
                dividers="rows"
                hasHover
              />
            </TableCard>
          </Stack>
          {/* 只有一頁時整條分頁列不要出現 —— 那是純噪音 */}
          {totalPages > 1 ? (
            <Pagination
              page={page + 1}
              totalPages={totalPages}
              totalItems={total}
              pageSize={AUDIT_PAGE_SIZE}
              onChange={(next: number) => {
                setPage(next - 1);
                setCollapsed(new Set());
              }}
            />
          ) : null}
        </VStack>
      </AsyncSection>

      <EscapeHatch />
    </VStack>
  );
}

/**
 * 「連自己都被鎖在外面時怎麼辦」。
 *
 * ⚠️ **管理員沒有豁免** —— 帳號層與 IP 層的鎖定對他一樣有效,那是刻意的
 * (管理員帳號是最有價值的目標,開後門等於讓那道門可以被無限次嘗試)。
 * 所以真的鎖到進不來時,唯一的路是重啟服務把記憶體裡的鎖清掉。
 * **這段文字不要刪**:需要用到它的時候,人是打不開這一頁的。
 */
function EscapeHatch() {
  return (
    // 設計系統的 Collapsible,預設收著
    <Collapsible
      defaultIsOpen={false}
      trigger={
        <Text type="supporting" color="secondary">
          連管理員自己都被鎖在外面了?
        </Text>
      }
    >
      <VStack gap={1}>
        <Text type="supporting" color="secondary">
          鎖定只存在記憶體裡,重啟服務就會全部清掉:
        </Text>
        <Code>docker compose restart askme</Code>
      </VStack>
    </Collapsible>
  );
}
