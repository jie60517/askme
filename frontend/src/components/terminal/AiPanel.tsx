/**
 * **AskME**:終端機右邊的那一欄。**畫面上只有對話**。
 *
 * ⚠️ 它叫 **AskME**,不叫「AI 助手」—— 標題、工具列那顆鈕、
 * 終端機裡浮出來的那顆鈕,三處是同一個名字。
 *
 * ⚠️ 沒有範圍選擇器、沒有空狀態說明、沒有輸入框下面的提示、沒有「清掉這一串」的鈕。
 * 要調範圍就改 `readContext` 送什麼,不要在畫面上長出設定。
 *
 * 輸入區就是**對話頁那一顆** `ChatComposer`(介面跟一般問答對話一樣),
 * 只是**不掛附件、@、/ 指令、模型下拉那些**:這裡只問問題。
 *
 * ⚠️ **這一串的狀態不在這個元件裡**,在 `useAskMe.ts`,而那支 hook 是
 * `TerminalSession` 拿著的 —— 面板關掉的時候這個元件會被卸載,狀態放在裡面就跟著沒了。
 * 掛在連線那一層,問到一半把面板收起來去看終端機、再打開,**回答還在,而且還在跑**。
 *
 * 兩個前提:
 *   - **只讀不寫**:它沒有工具,不會把任何東西送進終端機、也不會改主機上的檔案。
 *   - **不留紀錄**:這一串只活在這條連線的記憶體裡(換一條連線就是新的一串);
 *     後端只記「誰在幾點問了一次」。
 *
 * 送出去的是**終端機畫面上看得到的那一段**;在終端機選字之後按那顆浮出來的 AskME,
 * 選取的內容會以引用的樣子填進輸入框(`useAskMe` 的 `quote`)。
 */
import {useEffect, useRef} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {
  ChatComposer,
  ChatComposerInput,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  useChatStreamScroll,
  type ChatComposerInputHandle,
} from '@astryxdesign/core/Chat';
import {useEntryAnimation} from '@astryxdesign/core/hooks';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Markdown} from '@astryxdesign/core/Markdown';
import {Text} from '@astryxdesign/core/Text';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Toolbar} from '@astryxdesign/core/Toolbar';
import {Copy, X} from 'lucide-react';

import {Landing} from '../Landing';
import {copyText} from '../../lib/clipboard';
import type {AskMeThread} from './useAskMe';

const styles = stylex.create({
  panel: {
    position: 'relative',
    height: '100%',
    minHeight: 0,
    borderInlineStartWidth: 'var(--border-width)',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: 'var(--color-border)',
    color: 'var(--color-text-primary)',
    /*
     * 斷線時整欄變半透明(`panelOff`)要有過場。
     *
     * 斷線是**非使用者發起**的事件(後端閒置上限、網路斷、對面關掉)——
     * 畫面自己變樣的時候要看得出「發生了一件事」,而不是「畫面壞了」。
     *
     * 300ms 是 UI 過場的上限,這裡刻意用滿:它不是回應誰的操作,
     * 慢一點才讀得出是「狀態變了」。動的只有 opacity,成本為零。
     * ⚠️ `pointerEvents` **不要**列進 `transition-property` —— 它是離散屬性,
     *    要的就是立刻不能按。
     * ⚠️ reduced-motion **不必**開例外:減少的是位移,透明度與顏色的過場保留,
     *    而這裡從頭到尾只有透明度。
     * ⚠️ 過場下在**基底**這一塊,變暗與變回來兩個方向自動都有。
     * ⚠️ 同一頁 `TerminalSession.tsx` 的 `termHost` 是**同一種淡暗、同一個時間**
     *(`opacity` / `--duration-medium` / `--ease-standard` 三行一模一樣)——
     *    **時間要跟著一起改**。但**不是同一件事**:那邊是 `0.7` 且
     *    **不加** `pointerEvents: none`(斷線後還要能往回捲、能複製);這裡是 `0.5` 而且
     *    要擋住滑鼠(斷線時問不了問題)。**兩處的值刻意不同,不要去對齊。**
     */
    transitionProperty: 'opacity',
    transitionDuration: 'var(--duration-medium)',
    transitionTimingFunction: 'var(--ease-standard)',
  },
  panelOff: {opacity: 0.5, pointerEvents: 'none'},
  thread: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: 'var(--spacing-3)',
    scrollbarWidth: 'thin',
  },
  /** 問題保留換行與縮排 —— 引用進來的是一整段終端機輸出,折成一行就看不出是引用了。 */
  questionText: {whiteSpace: 'pre-wrap'},
  // ⚠️ **沒有上框線**:輸入框是對話頁那顆 ChatComposer,它自己就是一塊浮起來的圓角
  // (陰影 + 圓角),上面再壓一條分隔線會變成「框裡有框」。對話頁也沒有那條線。
  foot: {
    flex: 'none',
    paddingBlock: 'var(--spacing-2)',
    paddingInline: 'var(--spacing-2)',
  },
  /** 空狀態的招呼:貼著輸入框上面,不置中 —— 對話頁的 landing 也是靠左的 */
  greeting: {flex: '1 1 0', justifyContent: 'flex-end', paddingBlock: 'var(--spacing-2)'},
});

/** 打字時多久回報一次活動(見 `typedAt`)。閒置的門檻是分鐘級的,這個數量級綽綽有餘。 */
const TYPING_ACTIVITY_MS = 30_000;


type Props = {
  /** 招呼語要叫得出名字(跟 new chat 那句 `Hi, {name}` 同一套) */
  userName: string;
  /** 已中斷:整欄變淡、不能問 */
  isDisabled: boolean;
  onClose: () => void;
  /** 問了一題 / 打字 —— 這也算「人在用」(閒置計時要重算,兩邊都是) */
  onActivity?: () => void;
  /** 這一串對話(狀態在 `TerminalSession`,見 `useAskMe`) */
  thread: AskMeThread;
};

/**
 * 把游標移到一顆 contenteditable 的最後面。
 *
 * ⚠️ **設計系統的 handle 做不到這件事**:`ChatComposerInputHandle` 只有
 * `focus` / `getValue` / `insertText`(查過型別),而 `focus()` 會把游標放回它記得的位置 ——
 * 多半是最前面,於是引用填進去之後使用者打的字會插在引用**上面**。
 * 抽成一支有名字的函式,是為了讓「這裡刻意繞過 handle」這件事看得見。
 */
function moveCaretToEnd(box: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(box);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * 一則回答的內容區(等待動畫 / Markdown / 複製鈕)。
 *
 * ⚠️ **抽出來的理由是 hook 不能寫在 `map` 裡** —— 每一則要有自己的一份 `useEntryAnimation`。
 * 型別直接從 `AskMeThread` 取(`useAskMe.ts` 的 `Turn` 沒有匯出)。
 */
function AnswerBody({turn}: {turn: AskMeThread['turns'][number]}) {
  /**
   * 第一個 token 抵達那一幀,轉圈 +「想一下⋯⋯」整列消失、Markdown 頂上來。
   * 轉圈是畫面上唯一在動的東西,它憑空不見的位置正好是使用者在盯的地方。
   * 回答淡進來,讓那個交接有一格可看。
   *
   * ⚠️ **轉圈那一列不做退場。** 要讓它淡出就得在第一個 token 到了之後繼續掛著它 165ms,
   *    等於把回答的第一個字延後 165ms 才給 —— 那是拿使用者等待的時間換一個過場,方向是反的
   *    (使用者的刻意動作可以慢、系統的回應要快)。
   */
  const answerEntry = useEntryAnimation('fadeIn');
  /**
   * 「複製回答」是在使用者正在讀最後一行的時候冒出來的,而且它連同自己的高度
   * 一起把下面推開。單純淡入就夠 —— 位移會讓已經讀到的那一行再動一次。
   */
  const copyEntry = useEntryAnimation('fadeIn');

  return (
    <VStack gap={1}>
      {/*
        回答走**對話頁那顆 `Markdown`**:模型回的本來就是 markdown(標題、表格、`code`、清單),
        用純文字顯示的話看到的會是 `###` 跟一排 `|`。字級用正文:那是回答,不是註腳。
        `isStreaming` 跟對話頁同一個用法(還在長的時候不要把沒收尾的語法當錯誤處理)。
      */}
      {turn.answer ? (
        <Markdown isStreaming={!turn.isDone} xstyle={answerEntry}>
          {turn.answer}
        </Markdown>
      ) : (
        /*
          還沒有半個字的時候**要會動**,不然看起來像當機。
          跟對話頁同一顆現成的 `Spinner`,不自己刻三顆點。
        */
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" />
          <Text type="supporting" color="secondary">
            想一下⋯⋯
          </Text>
        </HStack>
      )}
      {turn.isDone && turn.answer ? (
        <HStack xstyle={copyEntry}>
          <Button
            label="複製回答"
            size="sm"
            variant="ghost"
            onClick={() => void copyText(turn.answer)}
            endContent={<Icon icon={Copy} size="sm" />}
          />
        </HStack>
      ) : null}
    </VStack>
  );
}

export function AiPanel({userName, isDisabled, onClose, onActivity, thread}: Props) {
  const {turns, question, setQuestion, busy, send, stop, quoteSeq} = thread;
  /**
   * 上一次因為「正在打字」而回報活動的時間。
   *
   * ⚠️ **要節流**:`onActivity` 會往後端送一個控制訊框,
   * 每一個按鍵送一次是純粹多出來的流量。閒置的門檻是分鐘級的,30 秒一次就夠。
   */
  const typedAt = useRef(0);
  const threadRef = useRef<HTMLElement>(null);
  /** 整欄的根。引用進來時要從這裡找到輸入框那顆 contenteditable(見底下那支 effect)。 */
  const panelRef = useRef<HTMLElement>(null);
  // ⚠️ 輸入框**不是 `<textarea>`** —— `ChatComposerInput` 是一顆 contenteditable,
  // 要聚焦只能走它的 handle(跟對話頁同一條路,見 Chat.tsx 的 composerInputRef)。
  const composerRef = useRef<ChatComposerInputHandle>(null);

  /** 上一次看到的則數,用來分辨「多了一則」與「同一則在長字」。 */
  const turnCountRef = useRef(0);

  /**
   * 串流時的黏底,**走設計系統那一支**(`ChatLayout` 內部用的也是它,見 `Chat.tsx` 的註解)。
   *
   * ⚠️ 不要自己用 `scroll` 事件量距離重寫一份:
   * 內容一變高 Chrome 會自己發一個 `scroll` 事件,自己量的話會把那個假事件
   * 當成「使用者捲回底部了」,於是又黏回去 —— 這支 hook 是比對捲動**方向**
   * 加上 scrollHeight/offsetHeight 的變化來濾掉它的。往上捲解鎖、回到底
   * `scrollend` 重新鎖、`prefers-reduced-motion` 自動退回瞬間跳位,都在裡面。
   *
   * 兩邊共用同一支的另一個理由:AskME 跟對話頁是同一種互動,各寫一份會慢慢分岔。
   */
  const {lock, scrollIfLocked} = useChatStreamScroll({scrollRef: threadRef});
  /**
   * 第一則問題出現時的進場。招呼語是**貼著輸入框上緣**的(`styles.greeting`),
   * 而第一則問題也出現在差不多的位置 —— 兩塊在同一幀互換,整欄會抽動一下。
   *
   * 用 `slideUp`(從下方 8px 淡入上來)而不是純 `fadeIn`:內容是從輸入框那一邊長出來的,
   * 位移方向要跟它一致,不然看起來像從別的地方飛過來。
   *
   * ⚠️ 退場**不做** —— 招呼語是被使用者自己的動作換掉的,讓他多等 165ms 才看到
   *    自己剛送出的問題是倒過來的。
   * ⚠️ 只動 `transform` 與 `opacity`,**不碰任何排版屬性** —— 上面那支
   *    `useChatStreamScroll` 是靠內容高度的變化在判斷要不要黏底的,
   *    任何在 165ms 內連續改高度的進場都會讓它誤判。
   */
  const listEntry = useEntryAnimation('slideUp');

  // 有新字就跟著捲 —— 串流的時候使用者要看的是最新那一行。
  // 但**只在他還跟著底部的時候**:他自己往上翻看前一段時 hook 會解鎖,
  // `scrollIfLocked()` 就不動他,不然回答長一點整段串流期間都讀不了上文。
  useEffect(() => {
    // 送出新問題(多了一則)時重新鎖定並捲到底:那是使用者自己的動作,他要看新的那一則。
    if (turns.length !== turnCountRef.current) {
      turnCountRef.current = turns.length;
      lock();
      return;
    }
    scrollIfLocked();
  }, [turns, lock, scrollIfLocked]);

  /**
   * 終端機那邊按了「問 AskME」:引用已經填進去了(`useAskMe.quote`),這裡把**游標接到最後面**。
   *
   * ⚠️ 只 `focus()` 不夠 —— 聚焦一顆 contenteditable 時游標會落在它記得的位置(多半是最前面),使用者接著打的字
   * 就插在引用的**上面**。這裡自己把選取範圍收到內容末端,再把輸入框捲到底;
   * 引用本身尾巴帶一個換行(見 `useAskMe.quote`),所以游標會停在引用底下那一行空的。
   *
   * ⚠️ **不要排 rAF**:分頁沒在畫的時候 rAF 被節流,那一下就整個不跑
   * (跟路徑輸入框那個 `hasAutoFocus` 同一個坑)。`quote()` 的兩個 setState 是同一次 commit,
   * 所以這支 effect 跑的時候 DOM 裡已經是新的內容,直接做就對了。
   */
  useEffect(() => {
    if (!quoteSeq) return;
    const composer = composerRef.current;
    composer?.focus();
    const box = panelRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!box) return;
    moveCaretToEnd(box);
    /*
      ⚠️ **游標到了最後面還不夠,要在引用底下真的空出一行**。引用的字串尾巴本來就帶一個 `\n`,
      但輸入框序列化的時候會把最後那個換行吃掉 —— 所以這裡問它**現在的值**,照它的結尾補足
      (`insertText` 插在游標處,而游標剛剛才收到最後面)。
      ⚠️ **不要寫成 `while` 迴圈**:輸入框序列化時會把結尾的換行吃掉,
      `getValue()` 可能永遠不會以換行結尾 —— 那個迴圈會當場把分頁轉死。一次補完就好。
    */
    const typed = composer?.getValue() ?? '';
    if (!typed.endsWith('\n\n')) composer?.insertText(typed.endsWith('\n') ? '\n' : '\n\n');
    box.scrollTop = box.scrollHeight;
  }, [quoteSeq]);

  return (
    <VStack ref={panelRef} xstyle={[styles.panel, isDisabled && styles.panelOff]} aria-label="AskME">
      <Toolbar
        label="AskME"
        size="sm"
        dividers={['bottom']}
        startContent={
          <Text type="supporting" weight="semibold">
            AskME
          </Text>
        }
        endContent={
          <IconButton
            label="關閉 AskME"
            variant="ghost"
            icon={<Icon icon={X} size="sm" />}
            onClick={onClose}
          />
        }
      />

      {/*
        還沒問過的時候:跟 new chat 一樣的招呼(Hi, <名字> / Where should we start?)。
        ⚠️ **只有招呼,沒有說明** —— 不要長出「問它畫面上的東西」那種教學字。
      */}
      <VStack ref={threadRef} xstyle={styles.thread} gap={3}>
        {!turns.length ? (
          // 跟對話頁的 new chat **同一份**(`components/Landing.tsx`)
          <VStack xstyle={styles.greeting}>
            <Landing name={userName} />
          </VStack>
        ) : null}
        {/*
          ⚠️ **對話用設計系統那三顆**(`ChatMessageList` / `ChatMessage` / `ChatMessageBubble`),
          跟對話頁同一套,不要自己拿 `Stack` + `Text` 拼泡泡(換行會被折掉、也沒有等待動畫)。

          ⚠️ **`ChatMessageList` 的 `isStreaming` 不是動畫**(它只設 `aria-busy`)。
          會動的有兩個,都不在這顆清單上:回答的淡入在 `Markdown` 的 `isStreaming`(底下那顆),
          還沒有半個字的時候則是**一顆轉圈的 `Spinner`** —— 跟對話頁一樣,不然看起來像當機。
          `isStreaming` 仍然要傳:報讀軟體靠 `aria-busy` 知道還在長。

          ⚠️ **沒有對話就不掛這顆清單**(跟對話頁同一個決定,見 `Chat.tsx` 那段註解):
          它自己是 `flex: 1` 又帶內距,空的時候會跟招呼那塊搶空間。
        */}
        {turns.length ? (
          <ChatMessageList isStreaming={busy} xstyle={listEntry}>
            {turns.map((turn) => (
              <VStack key={turn.id} gap={2}>
                {/*
                  自己問的那句:靠右、有底的泡泡 —— 跟對話頁的提問同一顆元件。
                  ⚠️ **裡面那顆 `Text` 要 `pre-wrap`**(量到泡泡自己是 `white-space: normal`):
                  從終端機引用進來的問題是**一整段多行的 `>`**,沒有 pre-wrap 的話整段會被折成
                  一行,縮排也一起沒了。
                */}
                <ChatMessage sender="user">
                  <ChatMessageBubble>
                    <Text xstyle={styles.questionText}>{turn.question}</Text>
                    </ChatMessageBubble>
                </ChatMessage>
                {turn.error ? (
                  <Text type="supporting" color="secondary">
                    {turn.error}
                  </Text>
                ) : (
                  <ChatMessage sender="assistant">
                  <ChatMessageBubble variant="ghost" width="100%">
                  <AnswerBody turn={turn} />
                  </ChatMessageBubble>
                  </ChatMessage>
                )}
              </VStack>
            ))}
          </ChatMessageList>
        ) : null}
      </VStack>

      {/*
        跟對話頁同一顆輸入框,**但什麼都不掛**:沒有附件、沒有 @、沒有 / 指令、
        沒有模型下拉 —— 這一欄只問問題。
        送出與 Enter 都是 ChatComposer 自己在管,所以這裡不畫送出鈕、也不寫鍵盤提示。
      */}
      <VStack xstyle={styles.foot} gap={2}>
        <ChatComposer
          density="compact"
          value={question}
          // 打字**就算**在用(不是送出才算):問一題想三分鐘的話,螢幕保護不該蓋上來。
          // 節流見 typedAt —— 每個按鍵都送一則會白白多出一堆控制訊框。
          onChange={(value: string) => {
            setQuestion(value);
            const now = Date.now();
            if (now - typedAt.current > TYPING_ACTIVITY_MS) {
              typedAt.current = now;
              onActivity?.();
            }
          }}
          onSubmit={send}
          isStopShown={busy}
          onStop={stop}
          placeholder="問點什麼⋯⋯"
          // 自己掛 input 才拿得到 handleRef(引用填進來時要聚焦,見 composerRef)
          input={<ChatComposerInput handleRef={composerRef} />}
        />
      </VStack>
    </VStack>
  );
}
