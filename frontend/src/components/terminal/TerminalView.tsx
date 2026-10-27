/**
 * 終端機畫面本體:xterm.js。
 *
 * 這個元件只管「畫」跟「鍵盤 / 滑鼠」:
 *   - 上面給 `onInput` / `onResize`,它把使用者打的字與視窗尺寸往上送;
 *   - 上面拿 `write()` 把 sshd 吐的位元組灌進來(ref)。**`onReady` 之前的 write 會被丟掉**,
 *     暫存是上一層(`TerminalSession` 的 pendingRef)的事 —— 只有一份暫存,不在兩層各放一份;
 *   - 跟 PuTTY 一樣的複製貼上:**選取即複製**、右鍵貼上、Shift+Insert 貼上、Ctrl+Shift+C/V。
 *     複製貼上一律走 `lib/clipboard`,**不要直接碰 `navigator.clipboard`** ——
 *     非 https 的頁面(例如內網 http)整個 `navigator.clipboard` 不存在,右鍵會貼不出來。
 *
 * **顏色整組寫死在 `ansi-palette.ts`**(底色、前景、游標、16 色 ANSI 盤):終端機在兩種
 * 佈景下都是深的(淺色模式也是黑底),那是一個不會翻的決定,不該用一個會翻的 token 去表達。外框的其他部分
 * (分頁列、檔案欄、AskME)照樣走 token,深色由 `pages/Terminal.tsx` 的外框負責。
 * 中文字寬靠 unicode11 addon(全形字佔兩格,游標才不會偏)。
 */
import {forwardRef, useEffect, useImperativeHandle, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import type {FitAddon} from '@xterm/addon-fit';
import type {Terminal} from '@xterm/xterm';

import {Button} from '@astryxdesign/core/Button';
import {Stack} from '@astryxdesign/core/Layout';

import {Logo} from '../Logo';
import {copyText, readClipboardText} from '../../lib/clipboard';
import {ANSI_BACKGROUND, ANSI_FOREGROUND, ANSI_PALETTE, ANSI_SELECTION} from './ansi-palette';
import {loadXterm} from './xterm-loader';

export type TerminalViewHandle = {
  write: (data: Uint8Array) => void;
  /**
   * 把一行**我們自己的**狀態寫進終端機(斷線原因就走這裡)。
   * 跟 `write` 分開是為了讀得出來:`write` 是 sshd 吐的位元組,這一支是本站印的字。
   */
  writeNotice: (text: string) => void;
  focus: () => void;
  getSelection: () => string;
  /** 現在畫面上看得到的那幾行(AI 助手送出時附上的就是這一段) */
  getViewport: () => string;
};

type Props = {
  fontSize: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** xterm 掛好、量完尺寸之後叫一次;在這之前 write() 沒有作用 */
  onReady: (size: {cols: number; rows: number}) => void;
  /** 任何鍵盤 / 貼上動作(閒置計時用) */
  onActivity?: () => void;
  /**
   * 這條連線已經斷了。斷掉之後終端機還留在畫面上(可以往回看、可以複製),
   * 但鍵盤**送不出去任何東西** —— 所以這裡把按鍵全部吃掉,只留 Enter 當「重新連線」
   * (斷線訊息印在終端機裡,重新連線也跟著留在這裡,
   * 跟 MobaXterm 那種「Press Return to restart」是同一個習慣)。
   */
  isClosed?: boolean;
  /** 斷線狀態下按了 Enter */
  onReconnect?: () => void;
  /**
   * 選好一段文字之後,旁邊會浮出一顆 AskME logo;按下去就把那一段丟給 AI 助手。
   * 沒給這個 callback 就不畫那顆鈕。
   */
  onQuote?: (text: string) => void;
};

/**
 * 浮鈕離游標多遠(px):貼著游標會蓋到剛選好的最後一個字。
 * `QUOTE_LOGO_PX` 是鈕裡那顆 logo 的大小,跟 sm 按鈕的圖示同高。
 */
const QUOTE_OFFSET_PX = 10;
const QUOTE_LOGO_PX = 16;

const styles = stylex.create({
  // 選好文字之後浮在旁邊的那顆 AskME:Astryx Button,這裡只管「浮在上面」——
  // 位置是滑鼠放開的地方,所以座標只能用行內 style 給
  quote: {
    position: 'absolute',
    zIndex: 4,
    boxShadow: 'var(--shadow-med)',
  },
  /**
   * 留白在**外面這一層**,不在 render host 上。
   *
   * ⚠️ **不要把內距搬到 host 上**。
   * FitAddon 量可用寬度時,讀的是 host 的 `getComputedStyle(...).width`,而且**只扣
   * `.xterm` 自己的內距、不扣 host 的** —— 全站是 `box-sizing: border-box`,那個值
   * 含 host 的左右內距。內距放在 host 上的話它會多算那段內距,
   * 於是 cols 多兩格:內容比可視區寬,選取的藍底蓋過捲軸還溢出去。
   */
  frame: {
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    paddingBlock: 'var(--spacing-2)',
    paddingInline: 'var(--spacing-3)',
    backgroundColor: 'var(--color-background-body)',
    overflow: 'hidden',
  },
  host: {
    flex: '1 1 0',
    width: '100%',
    minWidth: 0,
    minHeight: 0,
    // xterm 自己的 .xterm 需要一個有高度的容器;fit addon 量的就是這一層
    // (所以它**不能有內距**,見上面 frame 的說明);浮鈕也錨在這裡
    position: 'relative',
  },
});

/**
 * 從 xterm 的緩衝區讀出純文字。`translateToString(true)` 會把右邊的空白吃掉;
 * 一行被自動折行的話 xterm 會存成兩行,這裡照原樣讀 —— AI 看得懂,而且比自己重組安全。
 */
function readLines(term: Terminal, from: number, count: number): string {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let i = from; i < from + count; i += 1) {
    out.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  // 尾巴的空行去掉:提示字元後面那一大片空白對回答一點幫助都沒有,還佔字數
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

export const TerminalView = forwardRef<TerminalViewHandle, Props>(function TerminalView(
  {fontSize, onInput, onResize, onReady, onActivity, onQuote, isClosed, onReconnect},
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** 選好文字之後那顆浮鈕的位置(相對於這一層);沒有選取就是 null。 */
  const [quoteAt, setQuoteAt] = useState<{x: number; y: number} | null>(null);
  // callbacks 放 ref:xterm 只掛一次,不因為上層 re-render 換 handler 就重建
  const cb = useRef({onInput, onResize, onReady, onActivity, onQuote, isClosed, onReconnect});
  cb.current = {onInput, onResize, onReady, onActivity, onQuote, isClosed, onReconnect};

  useImperativeHandle(
    ref,
    () => ({
      write(data) {
        termRef.current?.write(data);
      },
      writeNotice(text) {
        // 換行 + 黃字 + 回到預設色。用 ANSI 而不是另外畫一塊 DOM:這是終端機裡的訊息,
        // 它要跟著上面那些輸出一起被捲動、一起被選取複製。
        termRef.current?.write(`
[33m${text}[0m
`);
      },
      focus() {
        termRef.current?.focus();
      },
      getSelection() {
        return termRef.current?.getSelection() ?? '';
      },
      getViewport() {
        const term = termRef.current;
        if (!term) return '';
        // viewportY 是捲軸現在停在哪一行(不是游標),所以捲上去看歷史時拿到的是「你正在看的」
        return readLines(term, term.buffer.active.viewportY, term.rows);
      },
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void loadXterm().then(({Terminal: XTerm, FitAddon: Fit, Unicode11Addon}) => {
      if (cancelled) return;
      const term = new XTerm({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize,
        fontFamily: getComputedStyle(host).getPropertyValue('--font-family-code').trim() || 'monospace',
        lineHeight: 1.2,
        scrollback: 5000,
        allowProposedApi: true,
        theme: {
          // 整組都寫死(ansi-palette.ts):終端機在兩種佈景下都是深的,
          // 底色不該經過一個會翻的變數
          background: ANSI_BACKGROUND,
          foreground: ANSI_FOREGROUND,
          cursor: ANSI_FOREGROUND,
          cursorAccent: ANSI_BACKGROUND,
          selectionBackground: ANSI_SELECTION,
          ...ANSI_PALETTE,
        },
      });
      const fit = new Fit();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;
      if (import.meta.env.DEV) {
        // 只在開發模式:DevTools 裡拿得到 xterm 實例。分頁在背景時 xterm 不畫 DOM,
        // 要驗內容讀 `__t100Term.buffer.active`,不要看 .xterm-rows。
        // ⚠️ 自動化打字時,合成的 Enter 鍵事件**進不去** xterm(它讀的是隱藏 textarea):
        // 送指令要用 `__t100Term.paste("ls\r")`,那條路跟真的鍵盤一樣會走 onData → sendInput。
        (window as unknown as {__t100Term?: Terminal}).__t100Term = term;
      }

      // 滑鼠最後停在哪(相對於這一層):選好字之後那顆「問 AskME」要浮在這裡
      let lastPointer = {x: 0, y: 0};
      const paste = async () => {
        const text = await readClipboardText();
        if (!text) return; // 讀不到也沒有自己複製過的:什麼都別做,不要吃掉這一次右鍵
        term.paste(text);
        cb.current.onActivity?.();
      };
      const copy = () => {
        const sel = term.getSelection();
        if (sel) void copyText(sel);
      };

      // 選取即複製(PuTTY 的習慣);順便決定要不要浮出那顆 AskME
      const selDisposable = term.onSelectionChange(() => {
        if (term.hasSelection()) {
          copy();
          // 位置用滑鼠最後停的地方:xterm 沒有「選取範圍的螢幕座標」這種 API,
          // 而使用者的視線本來就在放開滑鼠的那一點。
          setQuoteAt(cb.current.onQuote ? {...lastPointer} : null);
        } else {
          setQuoteAt(null);
        }
      });
      const onPointerMove = (e: MouseEvent) => {
        const box = host.getBoundingClientRect();
        lastPointer = {x: e.clientX - box.left + QUOTE_OFFSET_PX, y: e.clientY - box.top + QUOTE_OFFSET_PX};
      };
      host.addEventListener('mousemove', onPointerMove);
      const dataDisposable = term.onData((data) => {
        cb.current.onInput(data);
      });
      /**
       * 「人還在」只認**真的鍵盤**(`onKey`)與貼上,**不認 `onData`**。
       *
       * ⚠️ `onData` 裡不是只有使用者打的字:主機上的程式問終端機問題(游標在哪、
       * 支援什麼、焦點回報 —— vim / top / 有些 PS1 都會問)時,xterm **自己回**的那串
       * 控制序列也走同一條路。拿 `onData` 當「人在用」的話,那種程式一開著,
       * 3 分鐘的螢幕保護與後端 10 分鐘的閒置斷線就都被機器自己的回覆一直續命。
       * `onKey` 只在真的有鍵盤事件時才叫。
       */
      const keyDisposable = term.onKey(() => cb.current.onActivity?.());
      const binaryDisposable = term.onBinary((data) => {
        // 二進位貼上(少見):xterm 給的是 binary string,一個字元一個 byte。
        // 貼上是人做的,所以這條算活動(上面 `paste()` 那條路也各自算過)
        cb.current.onInput(data);
        cb.current.onActivity?.();
      });
      // Shift+Insert 貼上、Ctrl+Shift+C/V:回 false 表示 xterm 不要再處理
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        if (cb.current.isClosed) {
          /*
            斷線之後鍵盤只剩兩件事:**複製**(Ctrl+Shift+C)與 **Enter = 重新連線**;
            其餘吃掉 —— 不吃的話使用者會以為自己在打字,而那些字哪裡都沒去。
            ⚠️ 複製那條要**排在前面**,不然連 Ctrl+Shift+C 也被吃掉 ——
            斷線之後最常做的事就是把最後那段錯誤訊息複製走。
          */
          if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
            copy();
            return false;
          }
          if (ev.key === 'Enter') cb.current.onReconnect?.();
          return false;
        }
        if (ev.key === 'Insert' && ev.shiftKey) {
          void paste();
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
          void paste();
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
          copy();
          return false;
        }
        return true;
      });
      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        void paste();
      };
      host.addEventListener('contextmenu', onContextMenu);

      // 先量一次,把尺寸告訴上面;之後容器變了就 fit + 回報
      fit.fit();
      let lastCols = term.cols;
      let lastRows = term.rows;
      cb.current.onReady({cols: term.cols, rows: term.rows});

      let rafId = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (!host.clientWidth || !host.clientHeight) return;
          fit.fit();
          if (term.cols !== lastCols || term.rows !== lastRows) {
            lastCols = term.cols;
            lastRows = term.rows;
            cb.current.onResize(term.cols, term.rows);
          }
        });
      });
      ro.observe(host);

      cleanup = () => {
        cancelAnimationFrame(rafId);
        ro.disconnect();
        host.removeEventListener('contextmenu', onContextMenu);
        host.removeEventListener('mousemove', onPointerMove);
        selDisposable.dispose();
        dataDisposable.dispose();
        keyDisposable.dispose();
        binaryDisposable.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // fontSize 由下面那個 effect 處理,不重建整個 xterm
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
    cb.current.onResize(term.cols, term.rows);
  }, [fontSize]);

  // 留白那一層是 Stack;裡面那個 div 是 xterm 的 render host(它自己往裡面塞 DOM),
  // 跟 LoginScene 的 canvas host 同一類,是刻意的例外,不是版面用的 div。
  // ⚠️ 兩層要分開,原因在 styles.frame 上(內距放 host 上會讓 fit 多算兩格)。
  return (
    <Stack xstyle={styles.frame}>
      <div ref={hostRef} {...stylex.props(styles.host)}>
        {quoteAt && onQuote ? (
          <Button
            label="問 AskME"
            size="sm"
            // ⚠️ **實心**:secondary 在深色終端機上只有一圈細框,而它浮在剛選好的那段
            // 反白文字旁邊,那是畫面上最花的位置,不填滿看不出來。
            variant="primary"
            icon={<Logo size={QUOTE_LOGO_PX} />}
            xstyle={styles.quote}
            style={{insetInlineStart: quoteAt.x, insetBlockStart: quoteAt.y}}
            // mousedown 會先讓 xterm 清掉選取,所以在那之前就把文字撈走
            onMouseDown={(e: React.MouseEvent) => {
              e.preventDefault();
              const text = termRef.current?.getSelection() ?? '';
              setQuoteAt(null);
              if (text) onQuote(text);
            }}
          />
        ) : null}
      </div>
    </Stack>
  );
});
