/**
 * 發現新版之後要做什麼(`lib/appVersion.ts` 只負責發現)。
 *
 * 四段,從最無感到最打擾 —— 順序是刻意的,絕大多數人停在第一段,
 * 從頭到尾不知道站上更新過:
 *
 *   ① 他自己點連結換頁時換掉 → `App.tsx` 的 `AppLink`。已知是舊版之後,全站連結
 *      從前端跳轉變回真正的 `<a>`,他點側邊欄那一下順便就走到新版了。
 *   ② 真的閒著才自動重整 → 這支。分頁在背景、沒有問答在跑、沒有打到一半的字,
 *      三個條件同時成立才做。
 *   ③ **不能動他**的時候才出聲 → 這支。問答跑到一半、或字打了還沒送,
 *      常駐 toast(不自動消失),按不按由他決定。
 *   ④ 程式化導覽的兜底 → 這支。站上有十幾處 `navigate(...)`(命令面板、New chat、
 *      Chat 內部跳轉)**不經過 `AppLink`**,①管不到它們;路徑變了就在這裡補一次重載。
 *
 * ⚠️ **前景、而且沒有東西會弄丟時,這裡刻意什麼都不做。** 不是漏寫:那種情況他
 * 只要有任何一個換頁動作就會走①或④,為此跳一個框打斷他並不划算。
 *
 * ⚠️ **②③ 的判斷會重複跑,不是只判一次。** 使用者的狀態一直在變(答完了、
 * 把草稿送出了、切走了),所以變成舊版之後要持續等一個安全的時機。
 */
import {useEffect, useRef} from 'react';
import {useLocation} from 'react-router-dom';

import {isStale, startVersionWatch, subscribeStale} from '../lib/appVersion';
import {showNotice} from '../lib/toast';
import {wouldLoseWork} from '../lib/unsavedWork';

/** 變成舊版之後,每隔這麼久回頭看一次「現在可以動他了嗎」。 */
const RECHECK_MS = 10 * 1000;

/**
 * 提示卡上那顆「重新整理」。
 *
 * 按下去到新的 HTML 回來之間是一整趟重載,沒有回饋的話使用者會再按一次
 * —— `showsLoading`:按下去立刻轉圈並停用(`NoticeCard`),
 * 順便擋掉連按。不用設計系統的 `clickAction`:它的 spinner 延後 225ms 才出現,
 * 而且 `window.location.reload()` 不回 promise。
 *
 * ⚠️ **文案一個字都不要改。** 對話頁那一側唯一一則中文提示(`.claude/CLAUDE.md` 例外清單第 4 條)。
 * 畫成跟附件卡同一張(`components/NoticeCard.tsx`),藍 i —— 它是告知,不是誰做完了什麼。
 */
const RELOAD_ACTION = {
  label: '重新整理',
  showsLoading: true,
  onClick: () => window.location.reload(),
};

export function UpdateWatcher() {
  const {pathname} = useLocation();

  useEffect(() => {
    const stopWatch = startVersionWatch();

    let timer: number | undefined;
    let announced = false;

    const stopRechecking = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const act = () => {
      if (!isStale()) return;

      // 一次判斷只問一次:它要掃過整份 DOM,而下面兩條分支問的是同一件事。
      const busy = wouldLoseWork();

      // ② 分頁在背景、又沒有東西會被弄丟 —— 最好的時機,直接換掉。
      if (document.hidden && !busy) {
        window.location.reload();
        return;
      }

      // ③ 不能動他,而且還沒講過。講完就不必再回頭看了 —— 之後要換版由他按那顆鈕,
      //    或是等他切走時的 visibilitychange 再走一次 ②。
      if (busy && !announced) {
        announced = true;
        stopRechecking();
        // ⚠️ **這兩句是中文,而且是刻意的** —— 介面語言本來是英文
        // (`.claude/CLAUDE.md`),旁邊的 toast 都是 'Answer copied.' 那種。
        // 這則刻意用中文,記在 CLAUDE.md 的例外清單第 4 條。不要「順手」改回英文。
        showNotice({
          text: '有新版本',
          kind: 'info',
          autoHideMs: null,
          uniqueID: 'app-update',
          collision: 'ignore',
          action: RELOAD_ACTION,
        });
      }
    };

    const onStale = () => {
      act();
      if (timer === undefined && !announced) timer = window.setInterval(act, RECHECK_MS);
    };

    const onVisibility = () => {
      // 切走的那一瞬間就是 ② 最可能成立的時候,不要等下一次 tick。
      if (document.hidden) act();
    };

    const unsubscribe = subscribeStale(onStale);
    document.addEventListener('visibilitychange', onVisibility);
    if (isStale()) onStale();

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      stopWatch();
      stopRechecking();
    };
  }, []);

  /*
   * ④ 程式化導覽的兜底。
   *
   * ① 蓋的是「連結」—— 全站的 `<a>` 都經過 `AppLink`,所以那條最順(一次請求就到新版)。
   * 但命令面板、側邊欄的 New chat、Chat 內部那十幾處 `navigate(...)` 是**程式化跳轉**,
   * 不經過任何連結元件,①攔不到。那些人換了頁卻還在舊版,接下來要是點到一個
   * 已經不存在的分包,就得靠 `lib/lazyChunk.ts` 重載 —— 那比在這裡直接換掉難看。
   *
   * ⚠️ **這裡一定要問 `wouldLoseWork()`,跟 ②③ 同一個判斷。**
   * 最危險的那條路徑是**送出新對話**:`pages/Chat.tsx` 的送出流程是
   * `startStream(...)` → 清空輸入框 → `navigate('/c/…')` —— 也就是說「導頁」
   * 正好發生在那一題剛送出、串流才剛開始的那一瞬間。少了這個判斷,
   * 使用者按下送出的當下整頁就被重載:POST(連同附件上傳)被中斷、
   * 輸入框已經清空、而伺服器可能從頭到尾沒收到那一題。
   * 擋下來不會有損失 —— `stale` 還在,②③ 會在安全的時機接手。
   *
   * ⚠️ 用「上一個 pathname」比對,不要用「是不是第一次 render」:
   * `main.tsx` 開著 `StrictMode`,effect 會掛載兩次,而 ref 不會跟著重置 ——
   * 第二次掛載時「第一次」的旗標已經是 false,那道護欄等於沒有。
   */
  const lastPathname = useRef(pathname);
  useEffect(() => {
    const changed = lastPathname.current !== pathname;
    lastPathname.current = pathname;
    if (!changed || !isStale() || wouldLoseWork()) return;
    window.location.reload();
  }, [pathname]);

  return null;
}
