/**
 * 輸入框的附件。
 *
 * `files / fileError / isDropping / dragDepth` 四組狀態加三種來源(迴紋針、
 * 拖放、貼上)全在這裡,`Chat` 只拿結果:要送的檔案、錯誤訊息、拖曳遮罩開關,
 * 與一組掛在輸入框外層的事件 props。
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {isImageFilename} from './filekind';
import {shrinkImage} from './image';
import {NOTICE_EXIT_MS} from './toast';

/**
 * 掛上/移除的回饋:浮在輸入框上方、自己淡出的 Banner。
 *
 * **一則一張、往上疊**:一次多個檔案各彈一張,不是更新原本那張
 * —— 所以是陣列不是單格;每一則自己的計時器到了自己消失,
 * 生命週期整個在 hook 裡,呼叫端只負責畫。`id` 當 key,同名檔連掛兩次也各自一張。
 */
/**
 * `info`:@ 到人的「這則會通知誰」也走同一疊卡 ——
 * 通知的形狀只有這一種,不要另外長一條常駐的橫幅。
 */
export type AttachmentNotice = {
  id: number;
  kind: 'attached' | 'removed' | 'info';
  text: string;
  /** 正在退場(最後那 NOTICE_EXIT_MS):呼叫端掛 `data-leaving` 讓它淡出 */
  isLeaving?: boolean;
};

/** 一則通知活多久(含淡出)。 */
export const NOTICE_TTL_MS = 2000;
// 退場佔尾巴多久(TTL 前這麼久先掛 `isLeaving`)跟全站提示同一個數:`lib/toast.ts` 的 NOTICE_EXIT_MS

let noticeSeq = 0;

export type ComposerAttachments = {
  /** 這一題要一起送出去的附件 */
  files: File[];
  /**
   * 圖片附件的縮圖網址(跟 `files` 同 index;不是圖片就是 null)。
   * 抽屜要畫縮圖不是檔名(只有檔名看不出是哪一張)。
   * object URL 由 hook 管:移除/清空/卸載都會 revoke,呼叫端不要自己 revoke。
   */
  previews: (string | null)[];
  /** 擋下來的附件要講原因 —— 拖進去卻什麼都沒發生是最難查的那種「壞掉」 */
  error: string | null;
  /**
   * 「掛上了 / 移除了」的回饋,一則一張、各自倒數消失(NOTICE_TTL_MS)。
   * 呼叫端畫成輸入框上方浮出的 Banner;送出清空時一併清掉。
   */
  notices: AttachmentNotice[];
  /** 拖曳遮罩(「Drop the files here」)該不該亮 */
  isDropping: boolean;
  /** 藏起來的那顆 `<input type="file">`,迴紋針按鈕去點它 */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** 迴紋針與拖放共用的入口(貼上走 `dropZoneProps` 的 onPaste,自帶改名) */
  addFiles: (incoming: File[]) => Promise<void>;
  /** 抽屜上的 ✕ */
  remove: (index: number) => void;
  /** 送出成功後清空(附件與錯誤一起清) */
  clear: () => void;
  /**
   * 從外面塞一張 info 卡進同一疊通知。
   * 「這則會通知誰」用它 —— @ 的回饋跟附件的回饋是同一種東西,
   * 各長一個通道的話兩邊的動線與壽命遲早分岔。
   */
  notify: (text: string) => void;
  /** 掛在輸入框外層那個 Stack 上的拖放與貼上事件 */
  dropZoneProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
    onPaste: (e: React.ClipboardEvent) => void;
  };
};

/**
 * 貼上來的檔案幾乎都叫 `image.png`(瀏覽器就是這樣命名剪貼簿裡的圖)。
 * 後端是用原檔名存的 —— 不改名的話,同一組對話貼第二張就把第一張蓋掉了。
 */
function renamePasted(file: File): File {
  if (file.name !== 'image.png') return file;
  const ext = file.type.split('/')[1] || 'png';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new File([file], `pasted-${stamp}.${ext}`, {type: file.type});
}

/**
 * @param maxUploadMb 來自 `/api/config`(0 = 不限制);還沒載到就先不擋。
 */
export function useComposerAttachments(maxUploadMb: number): ComposerAttachments {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<AttachmentNotice[]>([]);

  /**
   * 每一則通知自己的倒數:先掛上「退場中」讓它淡出,到點再把自己從陣列裡拿掉
   * (呼叫端不用管計時,只要照 `isLeaving` 掛屬性)。
   */
  const pushNotice = useCallback((kind: AttachmentNotice['kind'], text: string) => {
    const item: AttachmentNotice = {id: ++noticeSeq, kind, text};
    setNotices((list) => [...list, item]);
    setTimeout(() => {
      setNotices((list) => list.map((n) => (n.id === item.id ? {...n, isLeaving: true} : n)));
    }, NOTICE_TTL_MS - NOTICE_EXIT_MS);
    setTimeout(() => {
      setNotices((list) => list.filter((n) => n.id !== item.id));
    }, NOTICE_TTL_MS);
  }, []);

  /*
   * ⚠️ object URL 的釋放走這一個 ref,不追 state:revoke 的時機
   * (移除、清空、整個元件卸載)跟重繪無關,而卸載那一刻讀 state 是舊值。
   */
  const urlsRef = useRef<string[]>([]);
  const makePreview = useCallback((file: File): string | null => {
    if (!isImageFilename(file.name)) return null;
    const url = URL.createObjectURL(file);
    urlsRef.current.push(url);
    return url;
  }, []);
  const revoke = useCallback((url: string | null) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urlsRef.current = urlsRef.current.filter((u) => u !== url);
  }, []);
  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
    },
    [],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * 拖曳遮罩用**計數**不能用 boolean:拖過子元素的邊界時
   * dragleave 會在 dragenter 之前發生,用旗標的話遮罩會一直閃。
   */
  const dragDepth = useRef(0);
  const [isDropping, setIsDropping] = useState(false);

  /**
   * 加附件。迴紋針、拖放、貼上三種來源全部走這一條。
   *
   * 順序有意義:**先縮圖再量大小** —— 一張 5MB 的截圖縮完常常只剩幾百 KB,
   * 先擋的話會把本來傳得上去的東西擋掉。
   */
  const addFiles = useCallback(
    async (incoming: File[]) => {
      if (incoming.length === 0) return;
      const shrunk = await Promise.all(incoming.map(shrinkImage));
      const tooBig =
        maxUploadMb > 0 ? shrunk.filter((f) => f.size > maxUploadMb * 1024 * 1024) : [];
      const ok = shrunk.filter((f) => !tooBig.includes(f));
      if (ok.length > 0) {
        setFiles((list) => [...list, ...ok]);
        setPreviews((list) => [...list, ...ok.map(makePreview)]);
        // 成功要講:拖進去之後有沒有真的掛上,不該用猜的。
        // 一次拖三個檔就是三張 banner 往上疊,不是一句「3 files」。
        for (const file of ok) pushNotice('attached', `Attached ${file.name}.`);
      }
      setError(
        tooBig.length > 0
          ? `${tooBig.map((f) => f.name).join(', ')} — over the ${maxUploadMb} MB limit.`
          : null,
      );
    },
    [maxUploadMb, makePreview],
  );

  const remove = useCallback(
    (index: number) => {
      const name = files[index].name;
      revoke(previews[index] ?? null);
      setFiles((list) => list.filter((_, x) => x !== index));
      setPreviews((list) => list.filter((_, x) => x !== index));
      if (name) pushNotice('removed', `Removed ${name}.`);
    },
    [files, previews, revoke, pushNotice],
  );

  /** 送出成功後的清空 —— **不留通知**:送出本身就是回饋,再講「移除了」是誤導 */
  const clear = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
    setFiles([]);
    setPreviews([]);
    setError(null);
    setNotices([]);
  }, []);

  /** 「這則會通知誰」的 info 卡(見型別上的說明) */
  const notify = useCallback((text: string) => pushNotice('info', text), [pushNotice]);

  return {
    files,
    previews,
    error,
    notices,
    isDropping,
    inputRef,
    addFiles,
    remove,
    clear,
    notify,
    dropZoneProps: {
      onDragEnter: (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current += 1;
        setIsDropping(true);
      },
      onDragOver: (e) => {
        // 不擋掉的話瀏覽器會直接開啟那個檔案,整頁被取代
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      },
      onDragLeave: () => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setIsDropping(false);
      },
      onDrop: (e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setIsDropping(false);
        void addFiles([...e.dataTransfer.files]);
      },
      onPaste: (e) => {
        const pasted = [...e.clipboardData.files];
        if (pasted.length === 0) return;
        // 有檔案才擋:純文字的貼上要照常進輸入框
        e.preventDefault();
        void addFiles(pasted.map(renamePasted));
      },
    },
  };
}
