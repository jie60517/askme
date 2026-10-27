/**
 * 檔案欄每一列前面那顆圖示:**長什麼樣、什麼顏色**。
 *
 * 資料夾一種顏色、檔案依副檔名分,一整欄掃下來才分得出哪個是程式、哪個是壓縮檔。
 *
 * ⚠️ **顏色只回一個「色調」名字,不回色碼** —— 對應到哪個 token 是畫面那一層的事
 * (`FilePanel` 的 `toneStyles`,走 `--color-icon-*`)。這個檔案是純函式,有測試。
 * ⚠️ 副檔名照**主機上真的會看到的**排,不是完整的程式副檔名清單 —— 要加就加你真的會在主機上看到的那幾種。
 */
import {
  Database,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileTerminal,
  Folder,
  type LucideIcon,
} from 'lucide-react';

import type {FileEntry} from '../../lib/terminalApi';

/** 色調。對到哪個 token 在 `FilePanel` 的 `toneStyles`。 */
export type FileTone =
  | 'folder'
  | 'code'
  | 'sql'
  | 'script'
  | 'data'
  | 'doc'
  | 'archive'
  | 'image'
  | 'plain';

export type FileLook = {icon: LucideIcon; tone: FileTone};

/** 副檔名 → 長相。key 一律小寫、不含點。 */
const BY_EXTENSION: Record<string, FileLook> = {};
const put = (look: FileLook, ...extensions: string[]) => {
  for (const ext of extensions) BY_EXTENSION[ext] = look;
};

// 原始碼
put({icon: FileCode, tone: 'code'}, 'c', 'h', 'py', 'js', 'ts', 'tsx', 'java', 'go', 'pl');
put({icon: Database, tone: 'sql'}, 'sql', 'db', 'sqlite', 'unl');
put({icon: FileTerminal, tone: 'script'}, 'sh', 'bash', 'ksh', 'csh', 'bat');
put({icon: FileJson, tone: 'data'}, 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'env', 'properties');
put({icon: FileText, tone: 'doc'}, 'md', 'txt', 'log', 'csv', 'out', 'err');
put({icon: FileArchive, tone: 'archive'}, 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'z', 'rar', '7z');
put({icon: FileImage, tone: 'image'}, 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico', 'webp');

/**
 * 這一列該畫什麼圖示、什麼色調。
 *
 * 規則只有三條:資料夾一律是資料夾;認得的副檔名照表;其他都是一張白紙。
 * ⚠️ 看的是**最後一個點後面**那一段,而且要小寫:主機上 `MAIN.C` 跟
 * `main.c` 一樣多。開頭就是點的(`.bashrc`)**沒有副檔名** —— 那是隱藏檔不是 rc 類型,
 * 照一般檔案畫。
 */
export function fileLook(entry: Pick<FileEntry, 'name' | 'is_dir'>): FileLook {
  if (entry.is_dir) return {icon: Folder, tone: 'folder'};
  const dot = entry.name.lastIndexOf('.');
  if (dot > 0) {
    const found = BY_EXTENSION[entry.name.slice(dot + 1).toLowerCase()];
    if (found) return found;
  }
  return {icon: FileIcon, tone: 'plain'};
}
