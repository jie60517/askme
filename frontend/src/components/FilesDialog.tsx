/**
 * 檔案區。
 *
 * 版面照設計系統的 **table-page 範本**:搜尋框 + `Table`
 * (proportional/pixel 欄寬、dividers="rows"、hasHover),不是「一組對話
 * 一張卡」的清單。哪一題的檔案由「From」欄講,點那一格會跳到訊息串裡的那一則。
 *
 * 「依檔名分組」翻成「依第幾個對話分組」那一步在 `lib/conversationFiles.ts`
 * —— 它算出來的 `strip`(餵給燈箱的那一條)訊息串裡的附件也要用,
 * 兩邊必須是同一份,不然索引對不起來。
 *
 * 這個彈窗要解決的事:**同名檔案的舊版被誤下載** ——
 * 舊版整列調淡 + 標籤 + 指出新版在第幾題。
 */
import {useMemo, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Download, File, FileCode2, FileImage, FileSpreadsheet, FileText, Presentation, Search} from 'lucide-react';

import {Button} from '@astryxdesign/core/Button';
import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Layout, LayoutContent, Stack, VStack} from '@astryxdesign/core/Layout';
import {Link} from '@astryxdesign/core/Link';
import {Table, pixel, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {useTableKit} from './tableKit';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Text} from '@astryxdesign/core/Text';
import {Thumbnail} from '@astryxdesign/core/Thumbnail';
import {Timestamp} from '@astryxdesign/core/Timestamp';
import {Token} from '@astryxdesign/core/Token';
import {Tooltip} from '@astryxdesign/core/Tooltip';

import type {FileRow, FileView} from '../lib/conversationFiles';
import {formatBytes} from '../lib/files';
import type {LightboxItem} from '../lib/lightboxItem';
import {codeLanguage} from '../lib/filekind';
import {parseServerTime} from '../lib/time';
import {fromZhuyin} from '../lib/zhuyin';
import {useMe} from '../lib/useIdentity';
import {useDialogExit} from './useDialogExit';
import {usePinnedDialogTop} from './usePinnedDialogTop';

const styles = stylex.create({
  /**
   * 舊版本整列調淡。
   * ⚠️ **只調淡不夠**,另外還有「Older」標籤與「新版在第 N 題」——
   * 淡一階在一排檔案裡看不出來,而誤下載正是這個功能要解決的事。
   */
  dimmed: {
    opacity: 0.62,
  },
  /**
   * 長檔名要能在格子裡斷行:`年度報告_v11_final_reviewed.docx`
   * 這種用底線串起來的名字**沒有任何斷行點**,不處理的話整串撐出去壓到隔壁的 From 欄。
   * - 檔名那顆字 `overflowWrap: 'anywhere'` —— 跟 `break-word` 不同,它會算進最小寬度
   *   (min-content),flex 項目才縮得進來;
   * - 外層那個直排 `minWidth: 0` —— flex 項目預設的最小寬度是內容寬,不放掉的話裡面怎麼斷都沒用。
   */
  nameBox: {minWidth: 0},
  nameText: {overflowWrap: 'anywhere'},
  /**
   * 縮圖尺寸的**唯一來源**,圖片與檔案縮圖要一樣大。
   * 類型色塊(可點的是 ClickableCard、開不了的是 Stack)與圖片縮圖都疊這一格:56px、同一個圓角 —— 各用各的尺寸
   * (Thumbnail 預設 61、色塊另一個數)一排掃過去會高低不齊。
   * ⚠️ 兩種縮圖各自的樣式**只補自己獨有的那一條**,尺寸不要再寫一次
   * (寫兩份就會有一天只改到一邊)。
   */
  tile: {
    width: 56,
    height: 56,
    borderRadius: 'var(--radius-element)',
    flexShrink: 0,
  },
  /** 圖片縮圖:尺寸疊 `tile`,自己只多一條裁切(Thumbnail 沒有 size prop) */
  imageTile: {
    overflow: 'hidden',
  },
  /** 色塊裡的圖示 + 副檔名,撐滿整塊置中 */
  tileFace: {
    width: '100%',
    height: '100%',
  },
  typeTileExt: {
    fontSize: 10,
    lineHeight: '11px',
    color: 'inherit',
  },
  /**
   * From 那一格的按鈕外殼:整格可點。
   * 只是把 <button> 的預設長相歸零 —— 底色、圓角、浮起由 data-hover-lift 管。
   * 內距一小圈:漂浮框貼著字的邊緣會像框錯了東西。
   */
  fromCell: {
    appearance: 'none',
    borderWidth: 0,
    backgroundColor: 'transparent',
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    paddingInline: 'var(--spacing-2)',
    paddingBlock: 'var(--spacing-1)',
    marginInline: 'calc(var(--spacing-2) * -1)',
    outline: {
      default: 'none',
      ':focus-visible':
        'var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)',
    },
    outlineOffset: 'var(--focus-outline-offset)',
  },
});

type Props = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已經翻成畫面順序的清單(`lib/conversationFiles.ts` 算的) */
  view: FileView;
  /**
   * 「From」那一格被點:呼叫端要**先關掉這個彈窗**再捲到那個 DOM id
   * —— 彈窗開著的時候背景是鎖住捲動的,捲了也看不到。
   */
  onJump: (jumpId: string) => void;
  /**
   * 點縮圖 / 可預覽的圖示:開燈箱。
   * `strip` 是**整組對話**所有看得了的檔案照畫面順序攤平的一條,
   * 左右切換才走得遍,不是只有這一題的。
   */
  onPreview: (strip: LightboxItem[], index: number) => void;
};

/** 類型色塊的色相;同時是 ClickableCard 的 variant 名稱(兩邊的色名剛好一致) */
type FileHue = 'red' | 'blue' | 'green' | 'orange' | 'teal' | 'purple' | 'yellow' | 'gray';

/**
 * 檔案類型的「縮圖」:圖片有真縮圖,其他格式給一塊
 * **依類型上色的方塊**(圖示 + 副檔名)—— 一排全是同一顆灰圖示的話,
 * 掃過去分不出誰是誰。顏色走佈景配好的 `--color-background-*` /
 * `--color-text-*` 那幾組(跟頭像同一個做法),深色模式自己翻面。
 */
function fileTypeStyle(name: string): {hue: FileHue; Icon: typeof File} {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') return {hue: 'red', Icon: FileText};
  if (ext === 'doc' || ext === 'docx') return {hue: 'blue', Icon: FileText};
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return {hue: 'green', Icon: FileSpreadsheet};
  if (ext === 'ppt' || ext === 'pptx') return {hue: 'orange', Icon: Presentation};
  if (/^(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(ext)) return {hue: 'teal', Icon: FileImage};
  if (codeLanguage(name) !== null) return {hue: 'purple', Icon: FileCode2};
  if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return {hue: 'yellow', Icon: File};
  return {hue: 'gray', Icon: FileText};
}

/**
 * 類型色塊。可以預覽的 = 設計系統的 `ClickableCard`:底色(variant)、hover / pressed 疊色、焦點框都是它的;
 * 開不了的(壓縮檔、不在了)是一塊純標示。尺寸與圓角兩條路徑都疊 `styles.tile`(唯一來源)。
 * ⚠️ 不要把 56px 的色塊塞進 `Button` 的 `icon` 插槽 —— 那個插槽是 16×16,會變形。
 */
function FileTypeTile({
  name,
  onOpen,
}: {
  name: string;
  /** 可以預覽就給;不能預覽(壓縮檔、不在了)就是 undefined,畫成純標示 */
  onOpen?: () => void;
}) {
  const {hue, Icon: Glyph} = fileTypeStyle(name);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '';
  const face = (
    <VStack gap={0} hAlign="center" vAlign="center" xstyle={styles.tileFace} style={{color: `var(--color-text-${hue})`}}>
      <Icon icon={Glyph} size="md" />
      {ext ? <Text type="supporting" size="xsm" xstyle={styles.typeTileExt}>{ext.slice(0, 4)}</Text> : null}
    </VStack>
  );
  // 可以預覽的色塊 = 設計系統的 ClickableCard(底色、hover / pressed、焦點框都是它的);開不了的就是一塊純標示
  return onOpen ? (
    <ClickableCard label={`Preview ${name}`} onClick={onOpen} variant={hue} padding={0} xstyle={styles.tile}>
      {face}
    </ClickableCard>
  ) : (
    <Stack xstyle={styles.tile} style={{backgroundColor: `var(--color-background-${hue})`}}>
      {face}
    </Stack>
  );
}

/** 點表頭排序的比較方式(一律寫升冪)。數字照數字比:「Question 10」排在「Question 9」後面 */
const FILE_COMPARATORS: Partial<Record<string, (a: FileTableRow, b: FileTableRow) => number>> = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}),
  from: (a, b) => a.from.localeCompare(b.from, undefined, {numeric: true}),
  who: (a, b) => a.who.localeCompare(b.who),
  size: (a, b) => (a.row.file.size ?? 0) - (b.row.file.size ?? 0),
  date: (a, b) => parseServerTime(a.row.file.created_at).getTime() - parseServerTime(b.row.file.created_at).getTime(),
};

/** Table 的一列。PowerSearch 的 applyFilters 吃扁平的 Record 欄位。 */
type FileTableRow = Record<string, unknown> & {
  id: string;
  /** 檔名(搜尋欄位) */
  name: string;
  /** 這一題的標題(搜尋欄位) */
  question: string;
  /** 誰的:You / 顯示名稱 / AI(搜尋欄位) */
  who: string;
  from: string;
  /**
   * 搜尋用的日期字串。
   * 兩種寫法一起放:ISO(`2026-08-21`)與本地格式(`2026/8/21`)——
   * 畫面上那格顯示的是相對時間(「58 minutes ago」),使用者搜的
   * 多半是「哪一天」,兩種都認才搜得中。
   */
  date: string;
  /**
   * 點「第幾題」跳去哪。**逐列決定,不是分組的 anchorId**:
   * 同一題的上傳檔跳提問、AI 產出的檔跳答案。
   */
  jumpId: string;
  row: FileRow;
};

export function FilesDialog({isOpen, onOpenChange, view, onJump, onPreview}: Props) {
  // 退場(淡出 + 縮一點點)要演得完,`close()` 就得延後 —— 全站共用同一支
  const exit = useDialogExit(onOpenChange);
  /*
   * 上緣釘住、只讓下緣伸縮:打字把清單篩短時,置中的對話框會上下
   * 一起收,正在打字的搜尋框每打一個字往下跳一次。理由與作法見 `usePinnedDialogTop`。
   */
  const pin = usePinnedDialogTop(isOpen);
  const {list, strip} = view;
  /*
   * 「這個檔案是誰的」要對照自己(是我、同事、還是 AI)。
   * 後端給的 asked_by 是**顯示名稱**(display_names() 查好的),
   * 所以拿自己的顯示名稱比;查不到 display_name 的帳號後端會原樣回帳號名。
   */
  const me = useMe();
  const myName = me.display_name || me.username;

  /*
   * 純文字全域搜尋(不用 PowerSearch 的過濾器,那套要打 `欄位:值` 才好用)。
   * 一個字串同時比檔名 / 誰的 / 問題 / 來源;注音照樣還原。
   */
  const [query, setQuery] = useState('');

  const rows = useMemo<FileTableRow[]>(
    () =>
      list.flatMap((group) =>
        group.rows.map((row) => ({
          id: row.key,
          name: row.name,
          question: group.title,
          who:
            row.file.kind === 'upload'
              ? row.file.asked_by
                ? row.file.asked_by === myName
                  ? 'You'
                  : row.file.asked_by
                : '—'
              : 'AI',
          from: group.isNote
            ? `Note${group.who ? ` from ${group.who}` : ''}`
            : `Question ${group.turn}`,
          date: (() => {
            const d = parseServerTime(row.file.created_at);
            return `${d.toISOString().slice(0, 10)} ${d.toLocaleDateString()}`;
          })(),
          jumpId: row.jumpId,
          row,
        })),
      ),
    [list, myName],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    /*
     * 注音的還原**在比對這一步做,不在 onChange**。
     *
     * ⚠️ `onChange` 裡改寫值會把**輸入法的組字整個打斷** ——
     * 打「台中」的過程中欄位裡是「ㄊㄞ」,還沒選字就被換成 `w9`,
     * 於是這個框永遠打不出中文。組字中的字串照樣進 state、照樣拿去比對,
     * 比不中就是比不中(那本來就還不是一個詞),選完字自然就對了。
     * 想搜 jacky 卻忘了切輸入法的那條路也通:
     * 兩種寫法都比一次,中一個就算中。
     */
    const keys = [...new Set([q, fromZhuyin(q)])];
    return rows.filter((r) =>
      // 日期也搜得到:r.date 是「ISO + 本地格式」兩種寫法的字串
      [r.name, r.who, r.question, r.from, r.date].some((v) => {
        const text = v.toLowerCase();
        return keys.some((key) => text.includes(key));
      }),
    );
  }, [query, rows]);

  const columns = useMemo<TableColumn<FileTableRow>[]>(
    () => [
      /*
       * ⚠️ 欄寬的總最小值要小於彈窗內寬:`proportional(n)` 的**最小寬是 n×120px**,
       * 比例給太大(例如 name=3/from=2/who=1 光比例欄就 720px 起跳)
       * 加上三個 pixel 欄會把表撐過彈窗、出現橫向捲軸。
       */
      {
        key: 'name',
        header: 'File',
        /*
         * 1.5 不是 2:File 欄讓出一段寬度,From 欄才不會太靠右。
         * proportional 的最小寬 = n×120,1.5 → 180,總最小仍小於彈窗內寬。
         */
        width: proportional(1.5),
        renderCell: (item) => <FileCell item={item} onPreview={(i) => onPreview(strip, i)} />,
      },
      {
        key: 'from',
        header: 'From',
        width: proportional(1),
        renderCell: (item) => (
          /*
           * 整格都可以點:漂浮框罩的是**整塊**,
           * 只有第一行能點的話,看起來可以按的區域跟真的可以按的區域對不上。
           * 所以這一格自己就是按鈕(`as="button"`,跟類型色塊同一招),
           * 「Question N」不是獨立的可點元素(按鈕裡包按鈕是違規巢狀),
           * 長相是一般的 label —— 可點的暗示由整格的漂浮框與游標扛。
           * hAlign="start":問題那一行要靠左。
           */
          <VStack
            gap={0}
            hAlign="start"
            as="button"
            {...{type: 'button', 'data-hover-lift': 'pill', 'data-pressable': ''}}
            aria-label={`Jump to ${item.from}`}
            onClick={() => onJump(item.jumpId)}
            xstyle={styles.fromCell}
          >
            {/* ⚠️ 這裡不能再放 Link:沒有 href 的 Link 一律畫成 <button>
                (as 只管有 href 的那條路),按鈕裡包按鈕是巢狀違規(React
                會警告 hydration error)。可點的暗示由整格的漂浮框+游標扛。 */}
            <Text type="label">{item.from}</Text>
            {/*
              問題**放到兩行**再截,而且截掉的部分要拿得回來。
              ⚠️ 不能完全不截:這一格是表格裡的一欄,一則長問題不設限
              會把整列撐成五六行,旁邊四欄跟著拉開,整張表就散了
              (跟 Security 那邊「說明」欄設 52ch 是同一個取捨)。
              兩行是「一眼看得出是哪一題」跟「列高還穩得住」的中間值;
              真的想看全文就停在上面 —— Tooltip 掛在文字上,而整格本身
              是按鈕,鍵盤聚焦時也會浮出來。
            */}
            <Tooltip content={item.question} delay={400}>
              <Text type="supporting" color="secondary" maxLines={2}>
                {item.question}
              </Text>
            </Tooltip>
          </VStack>
        ),
      },
      {
        key: 'who',
        header: 'By',
        width: pixel(96),
        renderCell: (item) => <CellText item={item} text={item.who} />,
      },
      {
        key: 'size',
        header: 'Size',
        width: pixel(84),
        renderCell: (item) => (
          <CellText item={item} text={formatBytes(item.row.file.size) || '—'} />
        ),
      },
      {
        key: 'date',
        header: 'Date',
        width: pixel(120),
        renderCell: (item) => (
          <Text type="supporting" color="secondary">
            <Timestamp value={parseServerTime(item.row.file.created_at).toISOString()} />
          </Text>
        ),
      },
      {
        key: 'actions',
        header: '',
        width: pixel(64),
        renderCell: (item) =>
          item.row.file.missing ? (
            /* 不給下載連結,但要講原因 —— 悄悄消失會讓人以為系統把檔案吃了 */
            <Tooltip content="No longer on the server" delay={0}>
              <Text type="supporting" color="secondary">
                —
              </Text>
            </Tooltip>
          ) : (
            <Button
              href={item.row.item.downloadUrl}
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<Icon icon={Download} size="sm" />}
              label={`Download ${item.name}`}
              tooltip="Download"
            />
          ),
      },
    ],
    [onJump, onPreview, strip],
  );

  // 點表頭排序(全站資料表共用,見 components/tableKit.ts)。
  // ⚠️ 這裡**不開拖欄寬**:拖寬一欄後面整排往右推,表格就比彈窗寬 —— 跟底下
  // 「不能出現左右捲軸」那條正面衝突
  const table = useTableKit<FileTableRow>({
    storageKey: 't100_table_cols:files_dialog',
    columns,
    data: filtered,
    comparators: FILE_COMPARATORS,
    notSortable: ['actions'],
    isResizable: false,
  });

  return (
    /*
     * 寬一點、而且**不能出現左右捲軸**。
     * ⚠️ 912 不是隨便挑的:設計系統 Dialog 的**外殼上限是 57rem(=912px)**,
     * width 給再大外殼也停在那裡,但**內層**仍照 width 的字面值排版
     * (給 960 的話內容比外殼寬,恆溢出、長出橫向捲軸)。給 912 內外才對得上。
     * 另外表格欄的最小寬總和(724)也要小於內容寬(proportional(n) 的
     * 最小寬是 n×120,見 columns 那段註解)。
     */
    <Dialog
      isOpen={isOpen}
      {...exit.dialogProps}
      /*
       * ⚠️ 還要自己夾視窗:外殼會被 Dialog 用 ~94vw 夾住,但**內層照 width 的
       * 字面值排**(窄視窗時內容會比外殼寬 → 恆溢出)。
       * 所以視窗窄的時候要自己把數字算小,不能指望它幫忙夾。
       */
      width={Math.min(912, Math.floor(window.innerWidth * 0.9))}
      purpose="info"
      ref={pin.ref}
      style={pin.style}
    >
      {/*
        ⚠️ 一定要走 `Layout` + `LayoutContent`(設計系統 `DialogScrollingContent`
        那份範本的形狀):內容直接塞進 `Dialog` 的話,面板內層是 `overflow: hidden`
        —— 檔案一多就**看不到也捲不到**。
      */}
      <Layout
        header={
          <DialogHeader title="Files in this chat" onOpenChange={exit.dialogProps.onOpenChange} />
        }
        content={
          <LayoutContent>
            {rows.length === 0 ? (
              <Text type="supporting" color="secondary">
                Nothing has been attached to or produced by this chat yet.
              </Text>
            ) : (
              <VStack gap={3}>
                <TextInput
                  label="Search files"
                  isLabelHidden
                  placeholder="Search files…"
                  value={query}
                  // ⚠️ 原樣進 state,**不要在這裡改寫**(輸入法會被打斷,見 filtered)
                  onChange={setQuery}
                  startIcon={Search}
                  hasClear
                />
                <Stack ref={table.wrapRef} {...table.wrapProps}>
                  <Table<FileTableRow>
                    data={table.data}
                    columns={table.columns}
                    idKey="id"
                    plugins={table.plugins}
                    density="balanced"
                    dividers="rows"
                    hasHover
                  />
                </Stack>
              </VStack>
            )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

/** 舊版/不在了的列,文字要跟著整列一起調淡 —— 只淡圖示看不出來。 */
function CellText({item, text}: {item: FileTableRow; text: string}) {
  return (
    <Text
      type="body"
      xstyle={item.row.isCurrent && !item.row.file.missing ? undefined : styles.dimmed}
    >
      {text}
    </Text>
  );
}

function FileCell({item, onPreview}: {item: FileTableRow; onPreview: (index: number) => void}) {
  const {row} = item;
  const canPreview = row.stripIndex !== null;
  const dim = row.isCurrent && !row.file.missing ? undefined : styles.dimmed;
  const open = canPreview ? () => onPreview(row.stripIndex as number) : undefined;

  return (
    <HStack gap={2} vAlign="center" xstyle={dim}>
      {row.item.mode === 'image' && canPreview ? (
        /*
         * ⚠️ 縮圖上**不掛任何浮層** —— 檔名就寫在它右邊 20px 的地方,滑到縮圖再彈一次是同一件事講兩遍。
         * `label` 也不能給:Thumbnail 有了 label 會自己包一層 tooltip。
         * 尺寸與圓角跟類型色塊統一(見 styles.imageTile)。
         */
        <Thumbnail
          src={row.item.previewUrl}
          alt={row.name}
          onClick={open}
          xstyle={[styles.tile, styles.imageTile]}
        />
      ) : (
        // 其他格式:類型色塊當縮圖;開不了的畫成純標示
        <FileTypeTile name={row.name} onOpen={open} />
      )}
      {/* 滑到檔名要浮起一塊(見 global.css 的 data-hover-lift) */}
      <VStack gap={0} xstyle={styles.nameBox} {...{'data-hover-lift': 'pill'}}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          {/* 縮圖與檔名都點得開預覽 */}
          {open ? (
            <Link onClick={open} color="primary">
              <Text type="label" xstyle={styles.nameText}>
                {row.name}
              </Text>
            </Link>
          ) : (
            <Text type="label" xstyle={styles.nameText}>
              {row.name}
            </Text>
          )}
          {/* 只有一版時不畫版次 ——「v1 · Current」對沒有第二版的檔案是噪音 */}
          {row.totalVersions > 1 ? (
            <Token
              label={row.isCurrent ? `v${row.file.version} · Current` : `v${row.file.version} · Older`}
              color={row.isCurrent ? 'green' : 'default'}
              size="sm"
            />
          ) : null}
          {row.file.missing ? <Token label="Unavailable" color="yellow" size="sm" /> : null}
        </HStack>
        {/*
          舊版**一定要指出新版在哪** —— 只寫「舊版本」等於要使用者
          自己去翻整張表。
        */}
        {row.newerTurn !== null ? (
          <Text type="supporting" color="secondary">
            Newer version in question {row.newerTurn}
          </Text>
        ) : null}
      </VStack>
    </HStack>
  );
}
