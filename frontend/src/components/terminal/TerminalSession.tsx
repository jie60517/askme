/**
 * **一條**終端機連線。頁面(`pages/Terminal.tsx`)可以同時掛好幾個 —— 那就是頁籤。
 *
 * 這一層擁有的東西:一條 WebSocket、一顆 xterm、它自己的檔案欄與 AskME、連線動畫。
 * 狀態機是四格:
 *
 *   connecting ──status──▶ settling ──最後一發訊號跑完──▶ connected ──closed──▶ closed ──重新連線──▶ connecting
 *
 * **例外:終端機已經在畫面上之後的重新連線**不回到 connecting:
 * `phase` 留在 closed、舊的終端機暗著留在原地(`isRedialing`),status 一來直接 connected、換一顆新的 xterm ——
 * 不走「換回方框 → 打勾停 450ms → 620ms 長滿」。見 `isRedialingRef` 的說明。
 *
 * ⚠️ **不在畫面上的頁籤也要留著掛在 DOM 裡**(頁面用 `hidden` 藏,不是 unmount):
 * unmount 就等於斷線,那樣切個頁籤回來就要重連,分頁就沒有意義了。
 * 藏起來的時候 xterm 量到的寬高是 0,`TerminalView` 的 ResizeObserver 有擋。
 *
 * 字級是**整頁共用**的(從上面傳進來),檔案欄 / AI 欄的開關則是**每個頁籤自己的**。
 */
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {useEntryAnimation} from '@astryxdesign/core/hooks';
import {ResizeHandle, useResizable} from '@astryxdesign/core/Resizable';
import {Text} from '@astryxdesign/core/Text';

import {AiPanel} from './AiPanel';
import {FilePanel} from './FilePanel';
import {HostStage} from './HostStage';
import {morph} from './morph';
import {TerminalView, type TerminalViewHandle} from './TerminalView';
import {PANEL_DEFAULT_PX} from './fileColumns';
import {useAskMe} from './useAskMe';
import {
  connectTerminal,
  type TerminalClosed,
  type TerminalConnection,
  type TerminalDirChange,
  type TerminalHost,
  type TerminalStatus,
} from '../../lib/terminalApi';

/** 並排時檔案欄的寬度上限。 */
const SPLIT_FILES_PX = 220;

/**
 * 方框那條路連上之後,按鈕的打勾停多久才開始長成終端機(登入後先有過渡、再慢慢變成黑底,
 * 不是一下子切掉)。短到不拖時間、長到看得出「對了」。
 * 這段時間**頁面還不知道連上了**(`onConnected` / `onLiveChange` 停完才叫)—— 不然視窗會在打勾那一刻先整片翻黑。
 */
const SUCCESS_BEAT_MS = 450;
/**
 * 重連中再按一次(Enter / 鈕)時,多久之內當成「手滑連按」不理。
 * 過了這段就是「等太久了、再撥一次」:把撥到一半的那條收掉、重新撥。
 * ⚠️ 不能永遠不理:`connectTerminal` 沒有撥號逾時,socket 開了卻 status、close 都不來的話,
 * 鈕會轉到天荒地老,而 Enter / 鈕全被吃掉 —— 只剩關掉頁籤一條路。
 */
const REDIAL_REPEAT_MS = 500;

const styles = stylex.create({
  root: {flex: '1 1 0', minHeight: 0},
  body: {position: 'relative', flex: '1 1 0', minHeight: 0},
  /**
   * 側邊那兩塊(檔案欄、AI 面板)**共用同一份**:桌機是分寬度的一欄,
   * 手機是蓋在終端機上面的抽屜。
   *
   * ⚠️ 寬度用自訂屬性 `--panel-width` 轉一手,呼叫端各自把它指到
   * `--files-width` / `--ai-width` —— 兩份只差一個變數名的時候,抄第二份
   * 的代價是之後改手機那幾條(position / inset / zIndex)只會改到其中一邊。
   */
  panel: {
    flex: 'none',
    minHeight: 0,
    width: {default: 'var(--panel-width)', '@media (max-width: 768px)': '100%'},
    position: {default: 'static', '@media (max-width: 768px)': 'absolute'},
    inset: {default: 'auto', '@media (max-width: 768px)': 0},
    zIndex: {default: 'auto', '@media (max-width: 768px)': 2},
    backgroundColor: 'var(--color-background-body)',
  },
  handle: {display: {default: 'flex', '@media (max-width: 768px)': 'none'}},
  /** 終端機那一塊。浮在右下角那顆「重新連線」錨在這一層,所以要 relative。 */
  termArea: {position: 'relative', flex: '1 1 0', minWidth: 0, minHeight: 0},
  /*
   * 斷線時整塊終端機淡到 `dimmed` 的 0.7,不是一幀切。
   * `--duration-medium`(300ms):`isClosed` 是**後端推的**,使用者沒有預期 ——
   * 一整塊終端機無聲無息掉一階,慢到讀得出「剛剛那裡變了」比快更重要。
   *
   * 過場寫在 base 而不是 `dimmed` 裡,兩個方向才都有它。
   * transition 取的是 **after-change style**,寫在 `dimmed` 裡暗下去照樣會跑
   * (就像只寫在 `:hover` 裡的 transition:進得去、出不來);差別只在**回程**:
   * 終端機已經在畫面上時按「重新連線」不會整塊 unmount(見 `isRedialingRef`),這一層一路掛著,
   * 新連線的 status 一來 `dimmed` 拿掉,就靠寫在 base 的這條從 0.7 淡回 1。
   *
   * reduced-motion **不關掉**:動的只有 opacity,沒有位移
   *(`global.css` 的 `--row-float` 那段:減少的是位移,顏色與影子的過場留著)。
   */
  termHost: {
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    transitionProperty: 'opacity',
    transitionDuration: 'var(--duration-medium)',
    transitionTimingFunction: 'var(--ease-standard)',
  },
  /** 斷線時浮在終端機右下角的「重新連線」。不在上面,也不蓋住最後幾行輸出。 */
  reconnect: {
    position: 'absolute',
    insetBlockEnd: 'var(--spacing-3)',
    insetInlineEnd: 'var(--spacing-3)',
    zIndex: 3,
  },
  /**
   * 已中斷:**只調暗,不擋滑鼠**。斷線之後最常做的兩件事是往回捲看
   * 發生什麼、以及把最後那段訊息複製走 —— `pointerEvents: none` 會把這兩件事一起擋掉。
   * 鍵盤送不出去的問題在 `TerminalView` 的 `isClosed` 那裡處理(按鍵吃掉,Enter 重連)。
   */
  dimmed: {opacity: 0.7},
  center: {flex: '1 1 0', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-4)'},
});

type Phase = 'connecting' | 'settling' | 'connected' | 'closed';

type Props = {
  /** 這一條連的是哪一台(選主機畫面上點的那一台) */
  host: TerminalHost;
  /** 全部的主機 —— 連線中的畫面(`HostStage`)畫的是同一份卡片 */
  hosts: readonly TerminalHost[];
  /** 顯示用的人名(連線動畫上那顆節點) */
  userName: string;
  fontSize: number;
  isFilesOpen: boolean;
  /**
   * 這一塊是不是**並排的其中一半**。
   *
   * 唯一的差別是檔案欄要瘦下來(壓到 `SPLIT_FILES_PX`):並排時每一半只有一半的寬,
   * 檔案欄照原本拖出來的寬度會把終端機整個擠光,兩半都只剩檔案清單。
   */
  isSplitPane?: boolean;
  isAiOpen: boolean;
  onCloseAi: () => void;
  /** 在終端機選了字、按了那顆「問 AskME」—— 面板關著的話要先幫他打開 */
  onOpenAi: () => void;
  /** 連上時把 status 往上報:頁籤要顯示標題,頁面要知道上限(max_sessions)與 AskME 在不在 */
  onConnected: (status: TerminalStatus) => void;
  /**
   * 這條連線**現在活著沒**。
   *
   * ⚠️ 螢幕保護要靠它決定主機清單上哪張卡片是亮的 —— 只看「這個頁籤選過主機沒」是不夠的:
   * 後端十分鐘到了把它斷掉之後,那台主機還會呼吸發亮、看起來像還連著,點下去才看到斷線。
   */
  onLiveChange: (isLive: boolean) => void;
  /**
   * 使用者**動了**(打字、貼上、在檔案欄操作)。頁面拿它重算閒置 ——
   * 3 分鐘沒有任何一條連線有動作就蓋上螢幕保護(見 pages/Terminal.tsx)。
   * ⚠️ 跟送給後端的那一則 activity 是同一個時機,但**兩件事**:後端那邊管的是 10 分鐘的斷線。
   */
  onActivity?: () => void;
  /**
   * 「使用者回來了」的訊號(時間戳,變了就送一則 activity 給後端)。
   *
   * 從螢幕保護點回來的時候頁面會改這個值 —— 那一下沒有鍵盤輸入也沒有檔案操作,
   * 後端的十分鐘不會自己重算,而使用者明明就在看著它。
   */
  pingAt?: number;
  /**
   * 連線中要畫什麼(有給就取代主機卡片):點卡片長出來的那個方框,按鈕轉圈;`isConnected` 是打勾那一下。
   * 有給的話連上不是直接換畫面,而是打勾停一下(`SUCCESS_BEAT_MS`)再讓方框長滿、整片暗成終端機(`morph`)。
   */
  renderConnecting?: (isConnected: boolean) => ReactNode;
};

export function TerminalSession({
  host,
  hosts,
  userName,
  fontSize,
  isFilesOpen,
  isSplitPane = false,
  isAiOpen,
  onCloseAi,
  onOpenAi,
  onConnected,
  onLiveChange,
  onActivity,
  pingAt = 0,
  renderConnecting,
}: Props) {
  const renderConnectingRef = useRef(renderConnecting);
  renderConnectingRef.current = renderConnecting;
  /** 打勾停一下的計時器,與這段時間收到的最新狀態(停完才交給頁面) */
  const beatRef = useRef(0);
  const beatStatusRef = useRef<TerminalStatus | null>(null);
  /**
   * 打勾到「長成終端機」之間還沒交出去(計時器在跑,**或計時到了、過場的 update 還沒跑**)。
   * 這段時間斷線的話 update 不能再把頁籤標成連線中。
   */
  const beatPendingRef = useRef(false);
  /**
   * 方框長成終端機那一段:終端機那一塊暫時掛上 `host-card` 的名字(平常不掛:並排時兩塊同名會讓過場整個失效)。
   * ⚠️ 剩一個沒擋的情況:這一塊不是作用中的那一塊、而作用中那一塊剛好停在方框上 —— 兩個同名,這一次過場被跳過(畫面照換)。
   */
  const [isArriving, setIsArriving] = useState(false);
  /**
   * 重新連線中、而**終端機已經在畫面上**。
   *
   * 「連上 → 打勾停一下 → 長成終端機」那一套(`SUCCESS_BEAT_MS` + `morph`)可以慢一點,是因為第一次連上只有一次。
   * 但斷線之後在終端機按 Enter 重連是**重複的鍵盤動作**,
   * 每次都換回方框、打勾停 450ms、再長 620ms,等於每重連一次多等一秒多,還跳回一個早就填完的方框。
   * 所以這種時候 `connect` 不把畫面收回連線中:舊的終端機**暗著留在原地**(`phase` 仍是 closed,
   * 按鍵照樣被吃、檔案欄 / AskME 照樣停用),「重新連線」鈕轉圈;status 一來直接 connected、
   * 換一顆新的 xterm(`generation`),暗掉的那一層淡回來(`termHost` 的 opacity 過場)。
   * 重連失敗就在舊的終端機最後印一行原因,跟一般斷線一樣。
   *
   * ⚠️ 判斷看「**終端機是不是正在畫面上**」(`showBodyRef`),不是另外記一個「連上過沒」:
   * 打勾那 450ms 裡斷線的那種(status 有了、過場沒跑),畫面上也是暗掉的終端機,一樣不該跳回方框。
   * 從沒掛起終端機就斷的(中間那塊「重新連線」)照舊走完整的第一次連線。
   * 回呼裡讀 ref(`connect` 的相依要保持空的,理由見 `onConnectedRef`),畫面讀 state。
   */
  const isRedialingRef = useRef(false);
  /** 這一次重連是什麼時候開始撥的(`REDIAL_REPEAT_MS` 用) */
  const redialStartedRef = useRef(0);
  /**
   * 重連中、新連線的 status 還沒來之前先到的 cwd。
   * 那時畫面上還是**舊的**終端機與檔案欄:cwd 直接 setCwd 的話,檔案欄會先跟著新連線的路徑跳,
   * 接著 status 一來(`setCwd(null)` 換新的一組)又被清掉 —— 新連線的起點路徑就這樣丟了。
   * 先記著,status 那一下才交出去。
   */
  const redialCwdRef = useRef<string | null>(null);
  /**
   * 第幾次撥(每次 `connect` 加一)。每一條連線的回呼都先比對自己是不是最新的一次,不是就什麼都不做 ——
   * 重連中再撥一次時,被放棄的那一條就算還有晚到的訊息(socket 關掉前已經在路上的),也碰不到畫面。
   * 卸載時也加一。
   */
  const attemptRef = useRef(0);
  const [isRedialing, setIsRedialing] = useState(false);
  const showBodyRef = useRef(false);
  /** 這一次連線收過狀態沒(第一則 status 才走「打勾 → 過場」那一套) */
  const gotStatusRef = useRef(false);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [closed, setClosed] = useState<TerminalClosed | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  /** 後端說「這個目錄變了」的最後一則。每則都是新物件 —— 同一個目錄連變兩次,檔案欄也要重列兩次 */
  const [dirChange, setDirChange] = useState<TerminalDirChange | null>(null);
  const [generation, setGeneration] = useState(0);
  const connRef = useRef<TerminalConnection | null>(null);
  const termRef = useRef<TerminalViewHandle | null>(null);
  // sshd 一連上就吐東西,而 xterm 要等連線動畫收尾才掛好 —— 這中間的輸出存在這裡,
  // `onReady` 時一次灌進去。**只有這一份**暫存(TerminalView 在 ready 之前的 write 會丟掉)。
  const readyRef = useRef(false);
  const pendingRef = useRef<Uint8Array[]>([]);
  // ⚠️ 上面傳進來的 callback 放 ref:它是行內箭頭函式,每次 render 都是新的一個。
  // 直接寫進 `connect` 的相依裡的話,`connect` 每次 render 都換一顆 → 底下那個
  // 「掛上去就連、拿掉就斷」的 effect 每次都重跑 → **連上就斷、斷了又連的無限迴圈**
  // (畫面永遠停在連線中)。
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  // 同一個理由放 ref:connect 的相依要保持空的,不然「掛上去就連」會變成無限迴圈。
  // 這一條連的主機在它的生命週期裡不會變(換主機 = 換一個頁籤 = 重新掛載)。
  const hostIdRef = useRef(host.id);
  hostIdRef.current = host.id;
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;
  /**
   * 檔案欄的寬度。預設值**從欄寬算出來**(`PANEL_DEFAULT_PX`,剛好放得下 Name + Size),
   * 不佔太多畫面。
   *
   * ⚠️ **不要在這裡寫一個數字**:寫死的值跟欄寬對不上時,第三欄會露出一截被切在邊緣;
   * 兩邊各寫一份的話,以後改欄寬又會分岔。
   * ⚠️ `autoSaveId` **每次改預設值都要跟著改版號**:`useResizable` 會把**預設值本身**也寫進
   * `astryx-resizable:<autoSaveId>`(沒拖過的人也有),不換版號的話預設值改了對用過的人完全沒有效果。
   * ⚠️ `minSizePx` **不能大於預設值**,不然一開頁就停在一個拖不回去的寬度。
   * 200 只是「比預設再窄一點、Name 還看得到」。預設值的組成改了要回來重看它。
   */
  const files = useResizable({
    defaultSize: PANEL_DEFAULT_PX,
    minSizePx: 200,
    maxSizePx: 900,
    autoSaveId: 't100_terminal_files_v5',
  });
  const aiPane = useResizable({
    defaultSize: 380,
    minSizePx: 300,
    maxSizePx: 640,
    autoSaveId: 't100_terminal_ai',
  });

  const connect = useCallback(() => {
    connRef.current?.close();
    const attempt = ++attemptRef.current;
    /** 這一條是不是還是最新的那一次(見 `attemptRef`) */
    const isCurrent = () => attempt === attemptRef.current;
    readyRef.current = false;
    pendingRef.current = [];
    redialCwdRef.current = null;
    // 終端機已經在畫面上 → 重連時留著它(見 `isRedialingRef`);新連線的輸出先存在 pendingRef,
    // 等 status 來、換上新的 xterm 才灌進去(舊的那顆不會再 onReady,所以不會被寫到)
    const isRedial = showBodyRef.current;
    isRedialingRef.current = isRedial;
    setIsRedialing(isRedial);
    if (isRedial) redialStartedRef.current = Date.now();
    if (!isRedial) {
      setClosed(null);
      setStatus(null);
      setCwd(null);
      setDirChange(null);
      setPhase('connecting');
      setGeneration((g) => g + 1);
    }
    gotStatusRef.current = false;
    window.clearTimeout(beatRef.current);
    beatRef.current = 0;
    beatPendingRef.current = false;
    connRef.current = connectTerminal(
      {
        cols: 120,
        rows: 30,
        hostId: hostIdRef.current,
      },
      {
        onStatus: (s) => {
          if (!isCurrent()) return;
          const isFirst = !gotStatusRef.current;
          gotStatusRef.current = true;
          setStatus(s);
          if (isFirst && isRedialingRef.current) {
            // 重新連線(終端機本來就在畫面上):不打勾、不過場,直接換上新的終端機
            isRedialingRef.current = false;
            setIsRedialing(false);
            setClosed(null);
            // status 之前先到的 cwd(見 `redialCwdRef`)
            setCwd(redialCwdRef.current);
            redialCwdRef.current = null;
            setGeneration((g) => g + 1);
            setPhase('connected');
            onConnectedRef.current(s);
            onLiveChangeRef.current(true);
            return;
          }
          if (beatPendingRef.current) {
            // 還在打勾停一下:記著,停完一起交出去
            beatStatusRef.current = s;
            return;
          }
          if (isFirst && renderConnectingRef.current) {
            // 方框那條路:按鈕打勾 → 停一下 → 方框長滿、整片慢慢暗成終端機
            setPhase('settling');
            beatStatusRef.current = s;
            beatPendingRef.current = true;
            beatRef.current = window.setTimeout(() => {
              beatRef.current = 0;
              void morph(() => {
                if (!beatPendingRef.current) return; // 這中間斷線了(`onClosed` 已經交出去、畫面已是斷線)
                beatPendingRef.current = false;
                const latest = beatStatusRef.current ?? s;
                setPhase((p) => (p === 'settling' ? 'connected' : p));
                setIsArriving(true);
                onConnectedRef.current(latest);
                onLiveChangeRef.current(true);
              }, 'vt-terminal').then(() => setIsArriving(false));
            }, SUCCESS_BEAT_MS);
            return;
          }
          // 已經掛著終端機時又來一則 status:不能把畫面拉回連線動畫,使用者正在看
          setPhase((p) => (p === 'connecting' ? 'settling' : p));
          onConnectedRef.current(s);
          onLiveChangeRef.current(true);
        },
        onData: (data) => {
          if (!isCurrent()) return;
          if (readyRef.current) termRef.current?.write(data);
          else pendingRef.current.push(data);
        },
        onCwd: (path) => {
          if (!isCurrent()) return;
          // 重連中、status 還沒來:畫面上是舊的檔案欄,先記著(見 `redialCwdRef`)
          if (isRedialingRef.current) redialCwdRef.current = path;
          else setCwd(path);
        },
        onDirChange: (change) => {
          // 重連中:畫面上是舊連線的檔案欄,新的那一個掛上時本來就會列一次
          if (!isCurrent() || isRedialingRef.current) return;
          setDirChange(change);
        },
        onClosed: (c) => {
          if (!isCurrent()) return;
          // 重連沒連上:鈕不再轉圈,下面照一般斷線走(原因印在還留著的那顆舊終端機最後一行)
          isRedialingRef.current = false;
          setIsRedialing(false);
          if (beatPendingRef.current) {
            // 打勾停一下的時候就斷了:先把「連上過」交給頁面(頁籤、視窗顏色才對得上),再照一般斷線走
            window.clearTimeout(beatRef.current);
            beatRef.current = 0;
            beatPendingRef.current = false;
            if (beatStatusRef.current) onConnectedRef.current(beatStatusRef.current);
          }
          setClosed(c);
          setPhase('closed');
          onLiveChangeRef.current(false);
          /*
            斷線的原因**印在終端機裡**,不是壓在上面的 Banner。
            ⚠️ 這一行**只寫狀態,不寫怎麼操作**(畫面上不放操作說明,只留狀態訊息)。
            重新連線由底下那顆浮鈕負責(鍵盤的 Enter 照樣可以)。
            印在裡面的好處不只是位置:它跟著上面那些輸出一起捲、一起選、一起複製,
            而且使用者的視線本來就在最後一行。連線還沒掛起來就斷的那種沒有終端機可以印,
            那條路留在底下的 `isClosed && !status`(原因寫在畫面中間那塊)。
          */
          termRef.current?.writeNotice(`── 連線已中斷:${c.message}`);
        },
      },
    );
  }, []);

  /** 使用者按的重新連線(鈕或 Enter)。 */
  const reconnect = useCallback(() => {
    // 已經在重連了:剛按下去那一下之內的連按不理(手滑);再晚就是「再撥一次」——
    // `connect` 會把撥到一半的那條關掉、換一條新的(見 `REDIAL_REPEAT_MS`、`attemptRef`)
    if (isRedialingRef.current && Date.now() - redialStartedRef.current < REDIAL_REPEAT_MS) return;
    connect();
  }, [connect]);

  // 掛上去就連;拿掉就斷。**頁籤切走不會走到這裡**(頁面是用 hidden 藏,不是 unmount)。
  useEffect(() => {
    connect();
    return () => {
      attemptRef.current += 1; // 卸載之後還在路上的訊息一律不理
      window.clearTimeout(beatRef.current);
      beatRef.current = 0;
      connRef.current?.close();
      connRef.current = null;
    };
  }, [connect]);

  // 被叫醒(從螢幕保護點回來):跟打一個字一樣,讓後端的閒置計時重算
  useEffect(() => {
    if (pingAt) connRef.current?.activity();
  }, [pingAt]);

  const activity = useCallback(() => {
    // 兩個收件人:後端(10 分鐘的閒置斷線)與頁面(3 分鐘的螢幕保護)
    connRef.current?.activity();
    onActivityRef.current?.();
  }, []);
  const readContext = useCallback(() => termRef.current?.getViewport() ?? '', []);
  /**
   * AskME 那一串:**掛在這一層**,不在面板裡(見 `useAskMe` 的說明)——
   * 面板收起來再打開,問過的東西還在,還在跑的那一題也還在跑。
   */
  const askMe = useAskMe({sessionId: status?.session_id ?? '', readContext, onActivity: activity});
  const openAi = useRef(onOpenAi);
  openAi.current = onOpenAi;
  const askMeQuote = askMe.quote;
  const quoteToAi = useCallback(
    (text: string) => {
      openAi.current();
      askMeQuote(text);
    },
    [askMeQuote],
  );

  const isClosed = phase === 'closed';
  const showBody = (phase === 'connected' || isClosed) && status !== null;
  showBodyRef.current = showBody;

  /*
   * 鈕是「斷線」那一刻才掛上來的,沒有進場就是憑空出現。
   * ⚠️ **用設計系統的 hook,不要自己寫 keyframes**(`@astryxdesign/core/hooks` 的
   * `useEntryAnimation`):它只在首次 paint 之後才動(重整頁面時不會整批演)、
   * reduced-motion 下自己變成 `none`、時間與曲線走佈景 token —— 三件事都不必我們維護。
   * `scaleIn` = opacity 0→1 + scale(0.95)→1,`--duration-fast-max`(165ms)。
   * ⚠️ hook 要**無條件**呼叫,不能塞進 `if (isClosed)` 裡。
   *
   * ⚠️ 它那個「首次 paint 之後才動」的旗標是在 **`TerminalSession` 第一次 render**
   *    取的,不是鈕掛上來的時候(`useState(() => initialPaintComplete)`)。
   *    這裡永遠是 true —— 一條 session 只在使用者**選了主機之後**才掛上來
   *    (`pages/Terminal.tsx`:「`TerminalSession` 這時才掛上去、才連」),
   *    而分頁也不從 storage 還原,所以不可能存在於首次 paint。
   */
  const reconnectEntry = useEntryAnimation('scaleIn');

  /**
   * 側欄(檔案欄 / AskME)插進來時的淡入 —— 同樣走設計系統那支,
   * `--duration-fast-max`(165ms)+ `--ease-standard`。
   *
   * ⚠️ **桌機只做淡入,不要動寬度**:寬度一動,`TerminalView` 的 ResizeObserver
   * 就會在過場的每一幀觸發 `fit.fit()`,xterm 每幀重折行一次,而且會連續送十幾則
   * resize 給後端。開關側欄是一天幾十次的動作,只給最低限度。
   *
   * ⚠️ **手機上這一份照樣掛著,不要在這裡用媒體查詢把它關掉。**
   * 手機那半是蓋滿容器的抽屜,要從自己那一側滑進來(`global.css` 的 `[data-term-panel]`,
   * 設計系統四個 preset 都沒有水平滑入),而「兩邊各用一套」的協調是在 **CSS** 做的:
   * 那條規則會把這支動畫的 duration 蓋成跟滑入同一個 300ms,兩者同進同出。
   *
   * 🚨 不要寫成 `isMobilePanel ? null : panelEntry`:面板開著時把視窗跨過 768px 拉寬,
   *    **opacity 會掉到 0 再淡回來** —— 進場動畫是「掛載時跑一次」的東西,把它綁在一個
   *    **元素活著時會變**的值上,class 一被加上去就從頭重演(`animationFillMode: 'backwards'`)。
   *    所以判斷要放在 CSS 的媒體查詢裡(它跟版面同一幀切換),不是放在 React 的狀態裡。
   */
  const panelEntry = useEntryAnimation('fadeIn');

  return (
    <VStack
      xstyle={styles.root}
      gap={0}
      style={
        {
          // 並排時檔案欄壓到 SPLIT_FILES_PX(理由見 `isSplitPane`);
          // 用 min 不是直接指定 —— 使用者本來就拖得比它窄的話,不該反而被撐寬。
          '--files-width': `${isSplitPane ? Math.min(files.size, SPLIT_FILES_PX) : files.size}px`,
          '--ai-width': `${aiPane.size}px`,
        } as React.CSSProperties
      }
    >
      {(phase === 'connecting' || phase === 'settling') && renderConnecting ? renderConnecting(phase === 'settling') : null}
      {(phase === 'connecting' || phase === 'settling') && !renderConnecting ? (
        <HostStage
          mode={phase === 'settling' ? 'connected' : 'connecting'}
          hosts={[...hosts]}
          targetId={host.id}
          // 連線中的卡片點不了(HostStage 的 cardState:只有 map / lock 能點),這支不會被叫到
          onPick={() => {}}
          onSettled={() => setPhase((p) => (p === 'settling' ? 'connected' : p))}
        />
      ) : null}

      {showBody ? (
        <HStack gap={0} xstyle={styles.body} style={isArriving ? {viewTransitionName: 'host-card'} : undefined}>
          {isFilesOpen ? (
            <>
              <Stack
                xstyle={[styles.panel, panelEntry]}
                style={{'--panel-width': 'var(--files-width)'} as React.CSSProperties}
                // 手機那一半的滑入在 global.css 的 `[data-term-panel]`(值是它在哪一側)
                {...{'data-term-panel': 'start'}}
              >
                <FilePanel
                  key={`${generation}-${status.session_id}`}
                  sessionId={status.session_id}
                  home={status.home}
                  maxUploadMb={status.max_upload_mb}
                  isDisabled={isClosed}
                  onActivity={activity}
                  followPath={cwd}
                  dirChange={dirChange}
                />
              </Stack>
              <ResizeHandle
                direction="horizontal"
                label="調整檔案欄寬度"
                isAlwaysVisible={false}
                resizable={files.props}
                xstyle={styles.handle}
              />
            </>
          ) : null}
          <Stack xstyle={styles.termArea}>
          <Stack xstyle={[styles.termHost, isClosed && styles.dimmed]}>
            <TerminalView
              key={generation}
              ref={termRef}
              fontSize={fontSize}
              // 斷線之後鍵盤只剩 Enter =重新連線(訊息就印在終端機的最後一行)
              isClosed={isClosed}
              onReconnect={reconnect}
              // ⚠️ 斷線時不往外送:重連中 `connRef` 已經是**新的**那條,
              // 而暗著的舊終端機還會冒出輸入(右鍵貼上、xterm 自己回的控制序列)與 resize ——
              // 不擋的話會灌進一條還沒換上新終端機的連線。斷線而沒在重連時,舊連線本來就送不出去,擋了也一樣。
              onInput={(data) => {
                if (!isClosed) connRef.current?.sendInput(data);
              }}
              onResize={(cols, rows) => {
                if (!isClosed) connRef.current?.resize(cols, rows);
              }}
              onReady={({cols, rows}) => {
                connRef.current?.resize(cols, rows);
                readyRef.current = true;
                for (const chunk of pendingRef.current) termRef.current?.write(chunk);
                pendingRef.current = [];
                termRef.current?.focus();
              }}
              onActivity={activity}
              onQuote={quoteToAi}
            />
          </Stack>
          {/*
            ⚠️ **斷線之後滑鼠也要有得按**,不能只剩鍵盤 Enter。
            浮在終端機右下角:不在上面,也不蓋住最後那幾行輸出。
            ⚠️ 放在 `dimmed` 那一層**外面** —— 在裡面的話它會跟著變淡,看起來像不能按。
          */}
          {isClosed ? (
            <Stack xstyle={[styles.reconnect, reconnectEntry]}>
              {/* `isInterruptible`:轉圈時照樣按得到 —— 撥太久可以再撥一次(`REDIAL_REPEAT_MS`),不然只能關頁籤 */}
              <Button
                label="重新連線"
                variant="primary"
                size="sm"
                isLoading={isRedialing}
                isInterruptible
                onClick={reconnect}
              />
            </Stack>
          ) : null}
          </Stack>
          {isAiOpen ? (
            <>
              <ResizeHandle
                direction="horizontal"
                // 把手在面板**左邊**(檔案欄那個在右邊),不反過來的話往左拖會變窄
                isReversed
                label="調整 AskME 寬度"
                isAlwaysVisible={false}
                resizable={aiPane.props}
                xstyle={styles.handle}
              />
              <Stack
                xstyle={[styles.panel, panelEntry]}
                style={{'--panel-width': 'var(--ai-width)'} as React.CSSProperties}
                {...{'data-term-panel': 'end'}}
              >
                <AiPanel
                  userName={userName}
                  // 在 AskME 打字也是「人在用」:少了這個,問一題問三分鐘會被螢幕保護蓋掉
                  // (後端那邊 /ask 本來就有 touch(),兩邊要一致)
                  onActivity={activity}
                  isDisabled={isClosed}
                  thread={askMe}
                  onClose={onCloseAi}
                />
              </Stack>
            </>
          ) : null}
        </HStack>
      ) : null}

      {/*
        **還沒掛起終端機就斷了**(連不上主機、被拒絕、開太多條)——
        那時候沒有地方印那一行字,所以原因與「重新連線」留在畫面中間這塊。
        沒有原因可寫時只留一句狀態,不寫操作說明。
        ⚠️ 這是唯一還會用到 `closed.message` 的地方;連得上的那條路印在終端機裡。
      */}
      {isClosed && !status ? (
        <VStack xstyle={styles.center} gap={3} hAlign="center">
          <Text color="secondary">{closed?.message ?? '已斷線'}</Text>
          <Button label="重新連線" variant="primary" size="sm" onClick={reconnect} />
        </VStack>
      ) : null}
    </VStack>
  );
}
