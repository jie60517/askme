/**
 * 編輯器裡的東西要跟「筆記頁」講話的那幾件事:看大圖、子頁的標題與打開、新增子頁 / 資料庫、
 * 上傳圖片、唯讀。用 context 傳給節點外觀(Tiptap 的節點外觀是 portal 畫在 EditorContent 底下的,context 傳得到),
 * 「/」選單與區塊選單在 Tiptap 擴充裡、拿不到 context,所以同一份也掛在 `editor.storage.noteHost`。
 */
import {createContext, useContext} from 'react';
import type {Editor} from '@tiptap/core';

export type PageInfo = {id: number; title: string; icon: string | null};

export type NoteHost = {
  /** 這頁是不是唯讀(沒有分享功能,只有主人看得到自己的頁,所以實際上不會是唯讀;機制保留) */
  readOnly: boolean;
  /** 看大圖(燈箱畫在編輯器 DOM 外面:它是原生 <dialog>,放在裡面點擊會落進編輯器) */
  showImage: (image: {src: string; alt: string}) => void;
  /** 子頁連結要顯示的標題與圖示(那一頁改名,連結跟著變) */
  page: (id: number) => PageInfo | undefined;
  /** 看得到的所有頁(「@」「[[」選單列頁面用) */
  pages: () => PageInfo[];
  /** edit:剛建的那一頁,游標直接停在標題(照 Notion) */
  openPage: (id: number, opts?: {edit?: boolean}) => void;
  /** 「/頁面」、資料庫的一列:在這頁底下開一頁新的(可以先給標題),回傳它 */
  newSubpage: (title?: string) => Promise<PageInfo | null>;
  /** 上傳一張圖,回傳後端給的那一段(`![](notebook-image:<id>)`);失敗回 null */
  uploadImage: (file: File) => Promise<string | null>;
  /** 「/」選單選了「圖片」:開檔案選擇 */
  pickImage: () => void;
};

const noop = async () => null;

export const DEFAULT_HOST: NoteHost = {
  readOnly: false,
  showImage: () => {},
  page: () => undefined,
  pages: () => [],
  openPage: () => {},
  newSubpage: noop,
  uploadImage: noop,
  pickImage: () => {},
};

export const NoteHostContext = createContext<NoteHost>(DEFAULT_HOST);

export function useNoteHost(): NoteHost {
  return useContext(NoteHostContext);
}

/** 擴充裡拿 host(拿不到 context 的那幾個地方) */
export function hostOf(editor: Editor): NoteHost {
  return ((editor.storage as unknown as Record<string, unknown>).noteHost as NoteHost | undefined) ?? DEFAULT_HOST;
}

export function setHost(editor: Editor, host: NoteHost) {
  (editor.storage as unknown as Record<string, unknown>).noteHost = host;
}
