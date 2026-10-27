/**
 * 把後端那份檔案清單翻成「畫面上看到的樣子」。
 *
 * 後端給的是**依檔名**分組(`convfiles.py` —— 它要算的是版次),
 * 而畫面要的是**依「第幾個對話」**分組:人記得的不是檔名,是
 * 「我那次問完之後它給了我什麼」。這裡就是那一次翻譯。
 *
 * ⚠️ 這段邏輯**不放在 `FilesDialog` 裡**:那條餵給燈箱的清單(`strip`)
 * 訊息串裡的附件也要用 —— 點回答底下的檔案要開的是**同一條**,
 * 左右切換才走得遍整組對話。兩邊各算一份的話,索引會對不起來。
 */

import type {ConversationFileGroup, ConversationFileVersion} from './chatApi';
import {lightboxItem, type LightboxItem} from './lightboxItem';

export type FileRow = {
  key: string;
  name: string;
  file: ConversationFileVersion;
  isCurrent: boolean;
  /** 這個檔名總共有幾版。只有一版時不畫版次標籤(那是噪音) */
  totalVersions: number;
  /** 這是舊版時,目前版本在第幾題 */
  newerTurn: number | null;
  item: LightboxItem;
  /** 在燈箱那條裡的位置;null = 這個檔案看不了(或已經不在了) */
  stripIndex: number | null;
  /**
   * 點「第幾題」要跳到**哪一個** DOM 節點。
   *
   * ⚠️ 跟分組用的 `anchorId` **不是同一個**:分組是「這是第幾題的檔案」
   * (一題一組),而跳轉要落在**那個檔案真正出現的地方** ——
   * AI 產出的檔案掛在答案底下,跳到提問等於還要自己再往下找一次。
   *   upload → `turn-{qaId}`(提問那一則)
   *   output → `answer-{qaId}`(答案那一則)
   *   便條附件 → `note-{noteId}`
   */
  jumpId: string;
};

export type FileGroupView = {
  key: string;
  /** 捲過去的落點:`turn-{qaId}` 或 `note-{noteId}`(兩個 id 都已經掛在畫面上了) */
  anchorId: string;
  isNote: boolean;
  turn: number;
  noteId: number;
  title: string;
  who: string | null;
  rows: FileRow[];
};

export type FileView = {
  /** 由新到舊的分組 */
  list: FileGroupView[];
  /** 所有看得了的檔案,照畫面上的順序攤平的一條(餵給燈箱) */
  strip: LightboxItem[];
};

/** 排序用:同一個錨點上,便條比那一題**晚**發生,所以排在它上面。 */
function groupRank(group: FileGroupView): number {
  return group.isNote ? 1 : 0;
}

export function buildFileView(groups: ConversationFileGroup[]): FileView {
  const byAnchor = new Map<string, FileGroupView>();

  for (const group of groups) {
    const latest = group.versions[0];
    for (const file of group.versions) {
      const isNote = file.qa_id === null;
      const noteId = file.note_id ?? 0;
      const anchorId = isNote ? `note-${noteId}` : `turn-${file.qa_id}`;

      let bucket = byAnchor.get(anchorId);
      if (!bucket) {
        bucket = {
          key: anchorId,
          anchorId,
          isNote,
          turn: file.turn,
          noteId,
          title: file.question,
          who: file.asked_by,
          rows: [],
        };
        byAnchor.set(anchorId, bucket);
      }

      bucket.rows.push({
        key: `${anchorId}-${file.kind}-${group.name}-${file.version}`,
        name: group.name,
        file,
        // 分組照題號,跳轉照「這個檔案出現在哪」(見 FileRow.jumpId)
        jumpId: isNote
          ? anchorId
          : file.kind === 'output'
            ? `answer-${file.qa_id}`
            : anchorId,
        isCurrent: file.version === latest.version,
        totalVersions: group.versions.length,
        newerTurn: file.version === latest.version ? null : latest.turn,
        item: lightboxItem(file.kind, file.session_id, group.name),
        stripIndex: null,
      });
    }
  }

  const list = [...byAnchor.values()].sort(
    (a, b) => b.turn - a.turn || groupRank(b) - groupRank(a) || b.noteId - a.noteId,
  );

  // 燈箱那條照**畫面上的順序**編號,左右切換才跟眼睛看到的一致。
  // ⚠️ 要在排序完之後才走一遍,不然索引對應到的是後端的分組順序。
  const strip: LightboxItem[] = [];
  for (const group of list) {
    group.rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const row of group.rows) {
      // 檔案不在了就不要放進燈箱:切到它只會是一片抓不到的空白
      if (row.file.missing || row.item.mode === 'none') continue;
      row.stripIndex = strip.length;
      strip.push(row.item);
    }
  }

  return {list, strip};
}

/** 給呼叫端算「檔案區按鈕要不要出現」用(只在 `fileCount > 0` 時出現)。 */
export function countFiles(groups: ConversationFileGroup[]): number {
  return groups.reduce((total, group) => total + group.versions.length, 0);
}

/**
 * 訊息串裡的某個附件在燈箱那條的第幾個;**找不到就是 -1**。
 *
 * 比對的是 `previewUrl`(kind + session_id + 檔名三者組出來的),不是檔名 ——
 * 同一組對話裡同名檔案很常見(那正是版次存在的理由),比檔名會開到別題的那一份。
 *
 * ⚠️ **-1 是正常狀態**,不是錯誤:檔案清單還沒抓回來、這個檔案看不了
 * (壓縮檔、執行檔)、或它已經不在磁碟上,都會落在這裡。呼叫端要留一條
 * 「照舊下載」的路,不要因為開不了燈箱就讓那顆按鈕沒反應。
 */
export function stripIndexOf(
  strip: LightboxItem[],
  kind: 'upload' | 'output',
  sessionId: string,
  name: string,
): number {
  const {previewUrl} = lightboxItem(kind, sessionId, name);
  return strip.findIndex((item) => item.previewUrl === previewUrl);
}
