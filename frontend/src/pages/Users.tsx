/**
 * 帳號管理(管理員)。
 *
 * 版面照設計系統的 **table-grouped** 範本(`npx @astryxdesign/cli template table-grouped`):
 * 一條工具列(搜尋 + 分組)+ 一張
 * **可收合分組**的表。範本裡那段自己拼 `TableRow colSpan` 的分組標頭沒有照抄
 * —— 設計系統已經有 `useTableGroupedRows`(同一份範本的正式版做法),
 * 它自己會畫「▸ 分組名 (筆數)」那一列、自己管收合,收合狀態由這裡持有。
 * 範本的右側詳情面板也沒有做:這一頁的每一列只有五個欄位,全部都在表上
 * 看得到,開一個面板只是把同樣的東西再抄一次。
 *
 * 分組維度給三個(職務 / 狀態 / 不分組),預設不分組(見 `groupBy`)。
 * 「依職務」那組要留意的是完整權限的人(他們可以在主機上跑指令)。
 *
 * ⚠️ 危險動作(刪除)走確認 Dialog。
 * ⚠️ **這一頁的內容是繁體中文**,但**側邊欄那條連結是英文**(見 `Sidebar.tsx`)。
 * 後端回的 detail 照原樣顯示(它是中文的)。
 */
import {useCallback, useId, useMemo, useState, type ReactNode} from 'react';

import {Token} from '@astryxdesign/core/Token';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {AlertDialog} from '@astryxdesign/core/AlertDialog';
import {HStack, Layout, LayoutContent, LayoutFooter, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {
  Table,
  pixel,
  proportional,
  useTableGroupedRows,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Search, UserPlus} from 'lucide-react';

import {AdminPage} from '../components/AdminPage';
import {FieldWithMessage} from '../components/FieldMessage';
import {IssueMfaDialog} from '../components/IssueMfaDialog';
import {TableCard} from '../components/TableCard';
import {useTableKit} from '../components/tableKit';
import {AsyncSection} from '../components/AsyncSection';
import {
  CONSULTANT_ROLE,
  DEFAULT_USER_ROLE,
  FULL_ACCESS_ROLE,
  USER_ROLES,
  createUser,
  deleteUser,
  getUsers,
  getAdminAccount,
  resetUserPassword,
  roleGrantsFull,
  updateUser,
  type ManagedUser,
} from '../lib/adminApi';
import {errorMessage} from '../lib/errors';
import {formatAdminTime} from '../lib/time';
import {toastError, toastInfo} from '../lib/toast';
import {useAsyncData} from '../lib/useAsyncData';
import {useDialogExit, type DialogExit} from '../components/useDialogExit';

type Row = Record<string, unknown> & {id: string; user: ManagedUser};

/**
 * ⚠️ 分組的 key 叫 `role` **不是 `tools`**:標籤是「依職務」、讀的也是 `role`。
 */
type GroupBy = 'role' | 'status' | 'none';

/** 點表頭排序的比較方式(一律寫升冪) */
const USER_COMPARATORS: Partial<Record<string, (a: Row, b: Row) => number>> = {
  username: (a, b) => (a.user.display_name || a.user.username).localeCompare(b.user.display_name || b.user.username, 'zh-Hant'),
  role: (a, b) => (a.user.role || DEFAULT_USER_ROLE).localeCompare(b.user.role || DEFAULT_USER_ROLE),
  // 使用中在前
  status: (a, b) => Number(a.user.disabled) - Number(b.user.disabled),
  password_changed_at: (a, b) =>
    (a.user.password_changed_at ? Date.parse(a.user.password_changed_at) : Infinity) -
    (b.user.password_changed_at ? Date.parse(b.user.password_changed_at) : Infinity),
};

const GROUP_OPTIONS: Array<{value: GroupBy; label: string}> = [
  // 叫「依職務」不叫「依權限」—— 職稱就是權限,這一頁看的是
  // 「誰是 Software engineer、誰是 Consultant」,不是抽象的「權限」。
  {value: 'none', label: '不分組'},
  {value: 'role', label: '依職務'},
  {value: 'status', label: '依狀態'},
];

/**
 * 分組的固定順序。
 *
 * ⚠️ 不要讓它照「第一次出現」排:那樣同一頁在不同資料下會長出不同的順序,
 * 而這兩組的順序是有意義的 —— **要留意的排前面**(完整權限、已停用),
 * 打開這一頁的人先看到的就該是那幾個。
 */
const GROUP_ORDER: Record<GroupBy, string[]> = {
  // 分組標籤直接用**職稱本身**(完整權限 = Software engineer,唯讀 = Consultant)
  // —— 這一頁不講「權限」。
  role: [FULL_ACCESS_ROLE, CONSULTANT_ROLE],
  status: ['已停用', '使用中'],
  none: ['全部帳號'],
};

function groupKeyOf(row: Row, groupBy: GroupBy): string {
  // ⚠️ 從**職稱**推,不要讀 `tools`(職稱就是權限)。
  // 兩者由後端保證一致,但畫面上只認一個來源,不然哪天不一致時這裡會說謊。
  if (groupBy === 'role') return roleGrantsFull(row.user.role) ? FULL_ACCESS_ROLE : CONSULTANT_ROLE;
  if (groupBy === 'status') return row.user.disabled ? '已停用' : '使用中';
  return '全部帳號';
}

/** 同一顆按鈕的兩種說法。發放與重新發放是同一支 API,只有字不一樣。 */
function mfaButtonLabel(enabled: boolean): string {
  return enabled ? '重新產生 QR code' : '產生 QR code';
}

export default function Users() {
  const {data, loading, failed, reload} = useAsyncData(useCallback(() => getUsers(), []));
  /**
   * 管理員自己那一筆。**他不在上面那份清單裡**(密碼在 .env,不在 users 表),
   * 所以要另外撈 —— 少了它,權限最大的帳號永遠發不到 QR,
   * 而那會讓「全面強制」開不起來。
   */
  const adminAccount = useAsyncData(useCallback(() => getAdminAccount(), []));
  /** 正在忙的那個帳號 —— 只鎖那一列的選單,不要整頁 disabled */
  const [busy, setBusy] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  /**
   * 刪除確認框的退場 —— 它是 `AlertDialog`,沒有 `FormDialog` 那層殼可以借。
   * 回呼不必包 `useCallback`:`useDialogExit` 內部用 `latest` ref 接最新的一份,
   * 回呼的身分不影響任何東西(那支 hook 的註解寫了這件事)。
   */
  const deleteExit = useDialogExit((open: boolean) => {
    if (!open) setPendingDelete(null);
  });
  /** 正在改誰的職稱(null = 對話框收起來)。一個對話框服務所有列,不是每列各掛一個。 */
  const [editingRole, setEditingRole] = useState<ManagedUser | null>(null);
  /** 正在幫誰產生 QR code。null = 對話框關著。 */
  const [issuingMfa, setIssuingMfa] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // 預設**不分組**:多數時候打開這一頁只是要找某一個人,
  // 預設分組反而多一層要收合的東西。
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  /** 收合的分組。**由這一層持有**(hook 的契約),不是 hook 自己記 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  /**
   * 每個操作都走這一條:busy → toast → reload。
   * 各自寫一份的話,遲早有一個忘記關 busy 或忘記重抓。
   */
  const act = useCallback(
    async (username: string, done: string, fallback: string, run: () => Promise<unknown>) => {
      setBusy(username);
      try {
        await run();
        toastInfo(done);
        reload();
      } catch (err) {
        // ⚠️ 不要把 "AxiosError" 顯示給使用者(見 lib/errors.ts)
        toastError(errorMessage(err, fallback));
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const rows: Row[] = useMemo(() => {
    const all = (data ?? []).map((user) => ({id: user.username, user}));
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    // 帳號與顯示名兩邊都找 —— 記得住的是哪一個因人而異
    return all.filter(
      (r) =>
        r.user.username.toLowerCase().includes(needle) ||
        (r.user.display_name || '').toLowerCase().includes(needle),
    );
  }, [data, query]);

  const columns: TableColumn<Row>[] = [
    {
      key: 'username',
      header: '帳號',
      /*
       * 四個內容欄**各佔四分之一**。
       *
       * 任何一欄給 `proportional(1.5)` 或 `pixel(...)`,都會變成「有一欄特別寬」
       * (剩餘空間全被某一欄吃掉)。全部給同一個 `proportional(1)` 才是真的平均,
       * 而且視窗變寬時四欄一起長。
       */
      width: proportional(1),
      renderCell: ({user}) => (
        <HStack gap={2} vAlign="center">
          {/*
            停用與否用 StatusDot 標在**名字旁邊**,不是只靠右邊「狀態」欄那個標籤:
            掃一整欄名字的時候,眼睛停的是這一欄,不會一路看到第三欄去。
          */}
          <StatusDot
            variant={user.disabled ? 'neutral' : 'success'}
            label={user.disabled ? '已停用' : '使用中'}
          />
          <VStack gap={0}>
            <Text type="label">{user.display_name || user.username}</Text>
            {/*
              ⚠️ 顯示名跟帳號**一樣的時候不要印第二行**(常見的情況是
              `display_name === username`,整欄會變成上下兩行同一個字)。
              第二行的用意是「這個人對應到哪個帳號」,兩個字一樣時它不傳達任何東西,
              只把列高變成兩倍。
            */}
            {user.display_name && user.display_name !== user.username ? (
              <Text type="supporting" color="secondary">
                {user.username}
              </Text>
            ) : null}
          </VStack>
        </HStack>
      ),
    },
    {
      key: 'role',
      header: '職稱',
      width: proportional(1),
      renderCell: ({user}) =>
        /*
         * 沒設過的顯示成灰字的預設值,不要留空白格 —— 空白會讓人以為
         * 「這個人沒有職稱」,而實際上他在 @ 選單裡確實會顯示 Consultant。
         */
        /*
         * ⚠️ **只印職稱,不要再掛一顆「完整權限」的標記**。
         * 職稱就是權限,而職稱字串本身已經寫著 `Software engineer` ——
         * 旁邊再放一顆寫「完整權限」的膠囊,是同一件事在同一格裡講兩次。
         * 分組標籤(依職務)用的也是同一組字。
         */
        <HStack gap={2} vAlign="center">
          {user.role ? (
            <Text type="body">{user.role}</Text>
          ) : (
            <Text type="supporting" color="secondary">
              {DEFAULT_USER_ROLE}(預設)
            </Text>
          )}
        </HStack>,
    },
    /*
     * 沒有「權限」欄:權限由職稱推導,兩欄並排等於同一件事講兩次。
     */
    {
      key: 'status',
      header: '狀態',
      width: proportional(1),
      renderCell: ({user}) => (
        <HStack gap={1} vAlign="center" wrap="wrap">
          {user.disabled ? (
            <Token label="已停用" color="red" size="sm" />
          ) : (
            <Token label="使用中" color="green" size="sm" />
          )}
          {/*
            狀態欄不掛「預設密碼」膠囊;「還在用預設密碼」
            標在密碼欄那一格(見下),這裡再標一次是重複。
          */}
        </HStack>
      ),
    },
    {
      key: 'password_changed_at',
      header: '密碼最後修改',
      width: proportional(1),
      renderCell: ({user}) => (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="supporting" color="secondary">
            {/* 絕對時間、中文(見 formatAdminTime) */}
            {user.password_changed_at ? formatAdminTime(user.password_changed_at) : '從未修改'}
          </Text>
          {/*
            「還在用預設密碼」標在**這一欄**,不放在標題底下的副標
            (管理頁不放說明文字)。標在人身上,資訊也從「有 N 個」變成「是這幾個」。

            ⚠️ StatusDot **不能只靠顏色**(設計系統自己的 Do/Don't),
            所以旁邊一定要有看得見的字,`label` 只餵給報讀軟體。
          */}
          {user.is_default_password ? (
            <HStack gap={1} vAlign="center">
              <StatusDot variant="warning" label="這個帳號還在用發下去的預設密碼" />
              <Text type="supporting">預設密碼</Text>
            </HStack>
          ) : null}
        </HStack>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: pixel(64),
      renderCell: ({user}) => (
        <MoreMenu
          label={`${user.username} 的操作`}
          isDisabled={busy === user.username}
          items={[
            {
              // 沒有單獨的「權限」項:改職稱就等於改權限,兩個入口只會互相打架
              label: '修改職稱',
              onClick: () => setEditingRole(user),
            },
            {
              label: user.disabled ? '啟用帳號' : '停用帳號',
              onClick: () =>
                void act(
                  user.username,
                  `${user.username} 已${user.disabled ? '啟用' : '停用'}。`,
                  '狀態改不動。',
                  () => updateUser(user.username, {disabled: !user.disabled}),
                ),
            },
            {
              label: '重設密碼',
              onClick: () =>
                void act(
                  user.username,
                  `${user.username} 已重設回預設密碼。`,
                  '密碼重設失敗。',
                  () => resetUserPassword(user.username),
                ),
            },
            {
              // 發放與重新發放同一顆:手機壞了、換手機、掃失敗都按它。
              // 確認與「舊的會失效」那句警告在對話框裡講(見 IssueMfaDialog)。
              label: mfaButtonLabel(user.mfa_enabled),
              onClick: () => setIssuingMfa(user.username),
            },
            {type: 'divider'},
            {
              label: '刪除帳號',
              variant: 'destructive',
              onClick: () => setPendingDelete(user),
            },
          ]}
        />
      ),
    },
  ];

  // 點表頭排序、拖表頭改欄寬(全站資料表共用,見 components/tableKit.ts)。
  // 排序先做、再分組 —— 排序套在每一組裡面,組的順序照舊
  const table = useTableKit<Row>({
    storageKey: 't100_table_cols:users',
    columns,
    data: rows,
    comparators: USER_COMPARATORS,
    // 沒改過密碼的升降冪都排最後
    emptyLast: {password_changed_at: (r) => !r.user.password_changed_at},
    notSortable: ['actions'],
  });

  /*
   * 分組(table-grouped 的核心)。
   * ⚠️ `data` / `plugin` / `idKey` 三個都要往下傳,少一個分組就不會生效
   * (hook 的文件明講的契約)。
   */
  const grouped = useTableGroupedRows<Row>({
    data: table.data,
    groupBy: (row) => groupKeyOf(row, groupBy),
    groupOrder: GROUP_ORDER[groupBy],
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
    <AdminPage
      title="帳號管理"
      actions={
        <Button
          label="新增帳號"
          /* ⚠️ 圖示要包 `Icon`,不要直接畫 `<UserPlus size={16} />`:
             那條路徑不會套設計系統的尺寸與顏色。 */
          icon={<Icon icon={UserPlus} size="sm" />}
          variant="primary"
          size="sm"
          onClick={() => setIsCreating(true)}
        />
      }
    >
      {/* 工具列:搜尋 + 分組維度。跟表分開一塊,一眼分得出哪邊是可以動的。
          ⚠️ 用 `Card` 不用 `Section`(Section 沒有外框線)—— 三個管理頁的每一塊一律是 Card,
          外框線與左右緣對齊都由它負責,不要混用 Section。 */}
      <Card variant="muted">
        <HStack gap={3} vAlign="end" wrap="wrap">
          <StackItem size="fill">
            <TextInput
              label="搜尋帳號"
              isLabelHidden
              placeholder="搜尋帳號或姓名…"
              value={query}
              onChange={setQuery}
              startIcon={Search}
              hasClear
            />
          </StackItem>
          <SegmentedControl
            label="分組方式"
            value={groupBy}
            onChange={(value: string) => {
              setGroupBy(value as GroupBy);
              // 換維度時把收合狀態清掉:舊的 key 在新維度裡不存在,
              // 留著只會讓下次切回來時莫名其妙有一組是收起來的
              setCollapsed(new Set());
            }}
          >
            {GROUP_OPTIONS.map((g) => (
              <SegmentedControlItem key={g.value} value={g.value} label={g.label} />
            ))}
          </SegmentedControl>
        </HStack>
      </Card>

      {/*
        ⚠️ **管理員自己要另外一塊。** 他不在底下那張表裡(不在 users 表),
        而他同樣需要一組手機驗證碼。做成獨立的卡片而不是硬塞一列進表格:
        停用、刪除、改職稱、重設密碼對他都不適用,混進去只會讓那幾顆按鈕
        看起來可用、按下去卻是 404。
      */}
      {adminAccount.data ? (
        <Card variant="muted">
          <HStack gap={3} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              {/*
                ⚠️ 只留「這是誰、他是管理員」。刻意不顯示手機驗證的狀態,
                也不放說明文字(強制與否、管理員不在清單裡)。
              */}
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="label">{adminAccount.data.username}</Text>
                <Token label="管理員" color="blue" size="sm" />
              </HStack>
            </StackItem>
            <Button
              label={mfaButtonLabel(adminAccount.data.mfa_enabled)}
              variant="secondary"
              size="sm"
              onClick={() => setIssuingMfa(adminAccount.data!.username)}
            />
          </HStack>
        </Card>
      ) : null}

      <AsyncSection
        loading={loading}
        failed={failed}
        reload={reload}
        hasData={!!data}
        isEmpty={rows.length === 0}
        errorTitle="帳號清單載入失敗。"
        loadingLabel="正在載入帳號"
        emptyText={query.trim() ? '沒有符合的帳號。' : '還沒有任何帳號。'}
      >
        <Stack ref={table.wrapRef} {...table.wrapProps}>
          <TableCard>
            <Table<Row>
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
      </AsyncSection>

      {/*
        ⚠️ `onCreated` **只做重抓**,不要在這裡 `setIsCreating(false)` ——
        那是硬關,對話框會在成功的那一幀瞬間消失,而按「取消」反而有 165ms 的淡出。
        關閉交給對話框自己走 `requestClose`,
        真正的 `setIsCreating(false)` 由延後的 `onOpenChange(false)` 帶。
      */}
      <CreateUserDialog isOpen={isCreating} onOpenChange={setIsCreating} onCreated={reload} />

      {/*
        產生 QR code。⚠️ `key` 換人就重新掛載 —— 密鑰是憑證,不能從上一個人的
        狀態殘留下來(那會變成「打開 B 的視窗看到 A 的 QR」,而管理員會照著給 B 掃)。

        ⚠️ **key 一定要帶 `issue-mfa:` 這個前綴。** 它跟底下的 `EditRoleDialog`
        是相鄰的 sibling,而兩邊裝的都是「使用者名稱或 null」:
          - 都沒開的時候(進頁面的預設狀態)兩個 key 都會是 `none`;
          - 同一個人同時被兩邊指到時,兩個 key 又會是同一個名字。
        兩種情況 React 都會警告「two children with the same key」,而重複的 key
        本來就可能讓子元素被複製或省略 —— 這兩個元素**正是靠 key 保證「換人就重新
        掛載」**的,前提被破壞等於上面那個憑證外洩的防護在賭 React 的內部行為。
      */}
      <IssueMfaDialog
        key={`issue-mfa:${issuingMfa ?? 'none'}`}
        username={issuingMfa}
        onOpenChange={(open) => {
          if (!open) setIssuingMfa(null);
        }}
        onIssued={() => {
          // 兩份都要重抓:發給一般同仁動的是表格那份,發給管理員動的是上面那張卡。
          reload();
          void adminAccount.reload();
        }}
      />

      <EditRoleDialog
        /* 換一個人就整個重新掛載 —— 不然上一個人打到一半的字會留在框裡,
           而且 draft 的初始值(現有職稱)只在掛載時取一次。
           ⚠️ `edit-role:` 這個前綴不能拿掉,理由見上面 `IssueMfaDialog` 那段。 */
        key={`edit-role:${editingRole?.username ?? 'none'}`}
        user={editingRole}
        onOpenChange={(open) => {
          if (!open) setEditingRole(null);
        }}
        // 同 `onCreated`:只重抓,關閉走對話框自己的退場
        onSaved={reload}
      />

      {/*
        刪除要講清楚後果:問答紀錄留著、但人進不來了。
        只寫「確定刪除嗎」的話,管理員無從判斷這個動作會不會弄丟資料。
      */}
      {/*
        ⚠️ `AlertDialog` 也要接共用退場(跟同一頁另外兩個框一樣演 165ms 淡出)。
        它內部就是 `Dialog`,`{...rest}` 會把記號傳下去(`AlertDialog.tsx:157`);
        `onOpenChange` 要靠 `dialogProps` 帶進來 —— 它排在 `{...rest}` **後面**,
        直接寫一個同名的 prop 會蓋掉我們包過的那一份。
      */}
      <AlertDialog
        isOpen={pendingDelete !== null}
        {...deleteExit.dialogProps}
        title={`刪除 ${pendingDelete?.username ?? ''}?`}
        description="過去的問答紀錄會留著,但帳號會被移除,這個人以後就登入不了了。"
        actionLabel="刪除帳號"
        // ⚠️ 不用 destructive:佈景把 `.astryx-button.destructive` 的字設成 --color-error(原意是配淡紅底),
        // 但元件自己把底色蓋成深紅 → 紅底紅字看不到
        actionVariant="primary"
        cancelLabel="取消"
        isActionLoading={busy === pendingDelete?.username}
        onAction={() => {
          const user = pendingDelete;
          if (!user) return;
          /*
           * ⚠️ **等 act() 跑完才關對話框**。先關再送的話
           * `isActionLoading={busy === pendingDelete?.username}` 永遠是 false
           * (pendingDelete 當場變 null)—— 那顆鈕的載入中狀態等於死碼,
           * 而刪除是會等後端的動作,沒有回饋的話使用者會連按好幾下。
           */
          void act(user.username, `${user.username} 已刪除。`, '帳號刪不掉。', () =>
            deleteUser(user.username),
          ).then(() => deleteExit.requestClose());
        }}
      />
    </AdminPage>
  );
}

/**
 * 這一頁兩個對話框(新增帳號、修改職稱)共用的**外殼**。
 *
 * 抽出來的只有殼:標題列、內容區、底下「取消 + 主鈕」(主鈕就是表單的送出鈕,Enter 靠它,見下)。
 * 欄位各自從 `children` 傳進來 —— 兩個框的內容差很多(一欄 vs 三欄),
 * 硬要一起通用只會讓這裡長出一堆旗標。
 *
 * ⚠️ **在輸入框按 Enter 一定要能送出**(「打完字按 Enter」是所有人的直覺)。
 * 靠的是主鈕自己 `type="submit" form={formId}`:主鈕畫在 footer、不在 <form> 裡面,用 form 屬性掛回去,
 * 它就是這張表單的預設按鈕,Enter 會按到它。
 *
 * ⚠️ `onOpenChange` **一份管三個出口**(右上角 X、取消鈕、Esc)。
 * 點外面**不會**關(`purpose="form"`—— 打到一半點到背景會丟掉內容)。
 * X 若走沒有 reset 的那份,「打了字 → 按 X → 再開」欄位還留著,
 * 但按 Esc 就清掉了 —— 同一個「關掉」有兩種結果。
 */
function FormDialog({
  isOpen,
  title,
  exit,
  submitLabel,
  busy,
  onSubmit,
  children,
}: {
  isOpen: boolean;
  title: string;
  /**
   * 退場(淡出 + 縮一點點)要演得完,`close()` 就得延後 —— 全站共用同一支。
   * ⚠️ **這支 hook 由呼叫端持有,不在這裡建**:送出成功之後要關的是呼叫端
   * (它才知道「成功了」),而它拿不到這裡的區域變數。建在這裡的話,成功路徑
   * 只能硬關,變成「按取消會淡出、存檔成功反而瞬間消失」。
   */
  exit: DialogExit;
  submitLabel: string;
  busy: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    /*
     * `purpose="form"`:打過字之後點背景**不會關**(Astryx Dialog:「Use purpose="form" for
     * dialogs with inputs so user can't accidentally lose data」)。取消 / × / Esc 照常關。
     */
    <Dialog isOpen={isOpen} {...exit.dialogProps} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={exit.dialogProps.onOpenChange} />}
        content={
          <LayoutContent>
            <form
              id={formId}
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
              }}
            >
              {children}
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            {/* ⚠️ 兩顆鈕要有間距。
                `LayoutFooter` 只負責把內容放到底部那一列,**不會**幫子層加間隔 ——
                裸放兩顆 Button 它們就是貼在一起。包一層 HStack 給 gap。 */}
            {/* 靠右:跟其他對話框一致(Astryx 的對話框 / Card footer 慣例是動作靠右) */}
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="secondary" onClick={exit.requestClose} />
              <Button label={submitLabel} variant="primary" isLoading={busy} type="submit" form={formId} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/**
 * 修改職稱 —— **同時也是改權限**(職稱就是權限)。
 *
 * **兩選一,不是自由輸入**:職稱決定這個人能不能在主機上跑指令,
 * 打錯一個字母(`Software Engineer` 大寫 E)就會靜靜地變成唯讀。
 * 選單只給 `USER_ROLES` 那兩個值,打不錯。
 *
 * 對話框裡不放權限後果的說明;權限的變化記在稽核紀錄裡(`role_changed` 的 detail)。
 */
function EditRoleDialog({
  user,
  onOpenChange,
  onSaved,
}: {
  user: ManagedUser | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  /*
   * ⚠️ 初始值要帶**畫面上看到的那個職稱**,不能是 `user.role ?? ''`。
   *
   * `role` 是 nullable(沒設過職稱的帳號很常見)—— 那些人的 `?? ''` 會落在
   * 空字串,也就是「清掉」。於是:打開對話框、什麼都不改、按儲存,
   * 後端收到 `role: ''` 就把職稱清掉、`tools` 設成 None。
   *
   * 所以退回 `DEFAULT_USER_ROLE`:那正是職稱欄對這些人顯示的字
   * (「Consultant(預設)」),所以「不改就按儲存」= 把畫面上看到的值寫實,
   * 權限不動。這個初始值只在掛載時取一次,所以呼叫端用 `key` 讓換人時重新掛載。
   */
  const [draft, setDraft] = useState(user?.role || DEFAULT_USER_ROLE);
  const [busy, setBusy] = useState(false);
  /** 退場由這裡持有(不是 `FormDialog`)—— 送出成功也要走它,見 `FormDialog` 的 `exit` */
  const exit = useDialogExit(onOpenChange);
  const [error, setError] = useState<string | null>(null);

  const username = user?.username ?? '';

  const submit = async () => {
    if (!user || busy) return;
    /*
     * ⚠️ 空值第二道:選單只給兩個合法值,理論上到不了這裡 ——
     * 但「送出空字串」的後果是清掉職稱兼改權限,而那是靜悄悄發生的。
     * 一道防線擋不住的東西不該只有一道。
     */
    const next = draft.trim();
    if (!next) {
      setError('請選一個職稱。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateUser(user.username, {role: next});
      // 只講「存好了」,不附職稱與權限的說明
      toastInfo(`${user.username} 已儲存。`);
      onSaved();
      // 成功也要演退場(不是硬關)—— 跟按「取消」走同一條路
      exit.requestClose();
    } catch (err) {
      setError(errorMessage(err, '職稱改不動。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      isOpen={user !== null}
      title={`${username} 的職稱`}
      exit={exit}
      submitLabel="儲存"
      busy={busy}
      onSubmit={() => void submit()}
    >
      <VStack gap={2}>
        {/* 錯誤跟登入頁同一個樣子(見 components/FieldMessage.tsx) */}
        <FieldWithMessage error={error}>
          <Selector
            label="職稱"
            options={[...USER_ROLES]}
            value={draft}
            placeholder="選一個職稱"
            onChange={(value: string) => {
              setDraft(value);
              setError(null);
            }}
          />
        </FieldWithMessage>
      </VStack>
    </FormDialog>
  );
}

/** 帳號名稱的規則 —— **照抄後端 `backend/app/ids.py` 的 `NAME`**,兩邊要一起改 */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * 不合格時的說明。**刻意是英文**,是管理頁內容一律中文的例外。
 */
const USERNAME_RULE = 'Use only letters, numbers, underscores (_) and hyphens (-), up to 64 characters.';

/**
 * 新增帳號。
 *
 * 「打完帳號按 Enter 就送出」靠 `FormDialog` 的主鈕(`type="submit" form={formId}`)。
 */
function CreateUserDialog({
  isOpen,
  onOpenChange,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  /** 後端的 detail 顯示在表單裡,不用 toast —— 錯的是這個欄位,話要講在旁邊 */
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUsername('');
    setError(null);
  };

  /*
   * 退場由這裡持有(不是 `FormDialog`)—— 送出成功也要走它。
   * ⚠️ 清欄位掛在**延後的那一側**:`onOpenChange(false)` 是 165ms 之後才跑的,
   * 對話框已經不見了才清,使用者不會看到欄位在淡出途中被清空。
   */
  const exit = useDialogExit((open: boolean) => {
    if (!open) reset();
    onOpenChange(open);
  });

  const submit = async () => {
    const name = username.trim();
    if (!name || busy) return;
    /*
     * 先在這裡擋格式。後端擋得到,但它回的是 pydantic 的原文
     * 「String should match pattern '^[A-Za-z0-9_-]{1,64}$'」—— 正規式直接丟給使用者看。
     * 規則要跟後端那條 pattern 一字不差,改一邊就要改另一邊。
     */
    if (!USERNAME_PATTERN.test(name)) {
      setError(USERNAME_RULE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createUser(name);
      toastInfo(`${name} 已建立,用預設密碼登入。`);
      onCreated();
      /*
       * 成功也要演退場(不是硬關)。
       * ⚠️ `reset()` **不在這裡叫** —— 那會在淡出的 165ms 裡把欄位清空給人看到。
       * 它是「一定要等對話框不見了才能做」的那一類,放在 `exit` 的
       * `onOpenChange(false)` 那一側(見下面建 hook 的地方)。
       */
      exit.requestClose();
    } catch (err) {
      setError(errorMessage(err, '帳號建立失敗。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      isOpen={isOpen}
      title="新增帳號"
      exit={exit}
      submitLabel="建立"
      busy={busy}
      onSubmit={() => void submit()}
    >
      {/*
        ⚠️ **只有帳號名一個欄位**。
        職稱與權限刻意不在這裡給:新帳號一律是預設職稱(唯讀),要給完整權限
        是建完之後另一次「修改職稱」—— 那一步會單獨寫一筆稽核,查得到是誰給的。
        擠在建立表單裡的話,那個決定會混在「建帳號」這件例行公事裡一起被按過去。
      */}
      {/* 錯誤跟登入頁同一個樣子(見 components/FieldMessage.tsx) */}
      <FieldWithMessage error={error}>
        <TextInput
          label="帳號名稱"
          placeholder="例如 ming"
          value={username}
          // 帳號會進網址、當主鍵,後端只收英數/底線/連字號
          description="只能用英數字、底線與連字號。"
          onChange={(value: string) => {
            setUsername(value);
            setError(null);
          }}
          hasAutoFocus
        />
      </FieldWithMessage>
    </FormDialog>
  );
}
