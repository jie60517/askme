/**
 * **AskME 那一串對話**的狀態機。畫面在 `AiPanel.tsx`,規則在這裡。
 *
 * ⚠️ 這支 hook 是 **`TerminalSession` 拿著的**,不是面板 —— 面板是可以關的,而關掉面板
 * 不該把問過的東西丟掉,更不該把正在跑的那一題砍掉。狀態掛在連線那一層,收起來再打開,
 * 回答還在、而且還在跑。
 *
 * 抽成自己的檔案是這個專案的慣例(`selection.ts` / `fileSort.ts` 同一類):
 * 面板只負責畫,規則自己一個模組。
 *
 * 兩個前提:**只讀不寫**(它沒有工具,不會把任何東西送進終端機、也不會改主機上的檔案);
 * **不留紀錄**(這一串只活在這條連線的記憶體裡,換一條連線就是新的一串;後端只記「誰在幾點問了一次」)。
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {askTerminalAi} from '../../lib/terminalAi';

type Turn = {id: string; question: string; answer: string; error?: string; isDone: boolean};

/** 一串 AskME 對話對外的樣子(狀態機是 `useAskMe`,面板只是畫它)。 */
export type AskMeThread = {
  turns: Turn[];
  question: string;
  setQuestion: (value: string) => void;
  busy: boolean;
  send: (value: string) => void;
  stop: () => void;
  /** 在終端機選了字、按那顆 AskME —— 以引用的樣子填進輸入框 */
  quote: (text: string) => void;
  /**
   * 引用過幾次(只增不減)。面板看到它變了就把游標放回輸入框 ——
   * ⚠️ 這是**一個事件的次數**,不是時間戳:沒有人在乎「什麼時候引用的」。
   */
  quoteSeq: number;
};

/**
 * 這一串對話的狀態機。**掛在連線那一層**(`TerminalSession`),不在面板裡 ——
 * 面板是可以關的,而關掉面板不該把問過的東西丟掉,更不該把正在跑的那一題砍掉。
 *
 * `sessionId` / `readContext` 用 ref 讀**當下**那一份:重新連線會換一個 session_id,
 * 而這一串是跨得過重連的(問過的東西還看得到),送出時當然要用新的那一條。
 */
export function useAskMe({
  sessionId,
  readContext,
  onActivity,
}: {
  sessionId: string;
  /** 送出時要附上的畫面內容(終端機畫面上看得到的那一段) */
  readContext: () => string;
  /** 問了一題 / 打字 —— 這也算「人在用」(閒置計時要重算,兩邊都是) */
  onActivity?: () => void;
}): AskMeThread {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoteSeq, setQuoteSeq] = useState(0);
  const running = useRef<{cancel: () => void} | null>(null);
  const live = useRef({sessionId, readContext, onActivity});
  live.current = {sessionId, readContext, onActivity};

  // 這條連線收掉(關頁籤 / 離開這一頁)才把還在跑的那一次收掉,後端會跟著把子行程殺掉。
  // ⚠️ **不是關面板的時候** —— 那樣會把正在跑的那一題砍掉。
  useEffect(() => () => running.current?.cancel(), []);

  const send = useCallback((value: string) => {
    const text = value.trim();
    if (!text || running.current) return;
    live.current.onActivity?.();
    const context = live.current.readContext();
    const id = `${Date.now()}`;
    setTurns((rows) => [...rows, {id, question: text, answer: '', isDone: false}]);
    setBusy(true);

    const patch = (patchTurn: (turn: Turn) => Turn) =>
      setTurns((rows) => rows.map((r) => (r.id === id ? patchTurn(r) : r)));

    const run = askTerminalAi(
      {sessionId: live.current.sessionId, question: text, context},
      (event) => {
        if (event.type === 'delta') patch((t) => ({...t, answer: t.answer + event.text}));
        else if (event.type === 'error') patch((t) => ({...t, error: event.message, isDone: true}));
        else patch((t) => ({...t, isDone: true}));
      },
    );
    running.current = run;
    void run.done.finally(() => {
      running.current = null;
      setBusy(false);
      patch((t) => ({...t, isDone: true}));
    });
  }, []);

  const stop = useCallback(() => {
    running.current?.cancel();
    running.current = null;
    setBusy(false);
  }, []);

  const quote = useCallback((text: string) => {
    setQuestion((current) => {
      const quoted = text
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return current ? `${current}\n\n${quoted}\n` : `${quoted}\n`;
    });
    setQuoteSeq((n) => n + 1);
  }, []);

  return {turns, question, setQuestion, busy, send, stop, quote, quoteSeq};
}
