// @vitest-environment jsdom
/**
 * wouldLoseWork:現在重整的話,會不會弄丟使用者的東西。
 *
 * 這支的判斷直接決定「趁他不在的時候自動換到新版」那一段做不做得成,
 * 而它錯的方式很安靜 —— 多抓一個欄位不會報錯,只會讓所有人每次上版都看到一個框。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/** `lib/runs` 連著整組 API 與串流狀態,這裡只需要「有幾條在跑」。 */
const streams = vi.hoisted(() => ({active: [] as unknown[]}));
vi.mock('../runs', () => ({
  getActiveStreams: () => streams.active,
}));

const {wouldLoseWork, registerBusySource} = await import('../unsavedWork');

/** 每條測試自己解除登記的來源,不然會漏到下一條。 */
let unregister: (() => void) | null = null;

beforeEach(() => {
  streams.active = [];
  document.body.innerHTML = '';
  history.pushState({}, '', '/');
});

afterEach(() => {
  document.body.innerHTML = '';
  unregister?.();
  unregister = null;
});

describe('wouldLoseWork', () => {
  it('什麼都沒有的時候可以動他', () => {
    expect(wouldLoseWork()).toBe(false);
  });

  it('問答還在跑就不能動', () => {
    streams.active = [{conversationId: 'c1'}];
    expect(wouldLoseWork()).toBe(true);
  });

  it('輸入框打了字就不能動', () => {
    // 輸入框是 contenteditable 的 div,不是 textarea(見 pages/Chat.tsx 的警告)
    document.body.innerHTML = '<div contenteditable="true">打到一半的問題</div>';
    expect(wouldLoseWork()).toBe(true);
  });

  it('輸入框只有空白不算', () => {
    document.body.innerHTML = '<div contenteditable="true">   \n  </div>';
    expect(wouldLoseWork()).toBe(false);
  });

  it('一般文字欄位有字也不能動', () => {
    document.body.innerHTML = '<input type="text" value="改到一半的資料夾名稱">';
    expect(wouldLoseWork()).toBe(true);

    document.body.innerHTML = '<textarea>寫到一半的便條</textarea>';
    expect(wouldLoseWork()).toBe(true);
  });

  it('關掉或唯讀的欄位不算', () => {
    document.body.innerHTML = '<input type="text" value="x" disabled>';
    expect(wouldLoseWork()).toBe(false);

    document.body.innerHTML = '<input type="text" value="x" readonly>';
    expect(wouldLoseWork()).toBe(false);
  });

  /*
   * ⚠️ **這一組是這支存在的理由。**
   *
   * 如果寫成「只要 input 的 value 非空就算有草稿」,站上的
   * `components/ColorPicker.tsx` 用的是 `<input type="color">` —— 它的 value
   * **永遠**是 `#rrggbb`(那個元件自己的註解就寫著「只收 #rrggbb」)。
   * 於是只要選色器還在 DOM 裡,這支就永遠回 true:
   * 「分頁在背景就自動換到新版」永遠不成立,而 toast 變成每次上版必跳。
   * 三段式會安靜地退化成一段,沒有任何錯誤訊息。
   */
  it('選色器不是草稿', () => {
    document.body.innerHTML = '<input type="color" value="#ff8800">';
    expect(wouldLoseWork()).toBe(false);
  });

  it('checkbox 與 radio 不是草稿', () => {
    // 沒寫 value 的 checkbox,DOM 給的預設值是 'on'
    document.body.innerHTML = '<input type="checkbox" checked><input type="radio" checked>';
    expect(wouldLoseWork()).toBe(false);
  });

  it('檔案欄位不是草稿', () => {
    document.body.innerHTML = '<input type="file">';
    expect(wouldLoseWork()).toBe(false);
  });

  it('選色器跟真的草稿同時在的時候,還是看得到草稿', () => {
    document.body.innerHTML =
      '<input type="color" value="#ff8800"><div contenteditable="true">真的打了字</div>';
    expect(wouldLoseWork()).toBe(true);
  });

  /*
   * ⚠️ SSH 終端機那一頁**整頁**都不能自動重整:那裡進行中的是一條 WebSocket,
   * 重整就是把連線砍掉,而終端機裡跑到一半的指令不會因為重新連上就回來。
   * xterm 的輸入讀的是一個隱藏 textarea 而且即時清空,上面掃 DOM 那幾條
   * 完全看不到他打了什麼 —— 所以只能用整頁的粒度擋。
   */
  it('人在 SSH 終端機頁就一律不能動', () => {
    history.pushState({}, '', '/ssh');
    expect(wouldLoseWork()).toBe(true);
  });

  it('其他頁不受影響', () => {
    history.pushState({}, '', '/stats');
    expect(wouldLoseWork()).toBe(false);
  });
});

/*
 * 登記制:那些狀態只活在 React 元件裡、DOM 上看不出來的東西。
 * 目前的用戶是「挑好還沒送出的附件」(`pages/Chat.tsx`)—— `<input type="file">`
 * 的 value 在那種情況下是空的,掃 DOM 抓不到。
 */
describe('registerBusySource', () => {
  it('登記的來源說在忙就不能動', () => {
    unregister = registerBusySource(() => true);
    expect(wouldLoseWork()).toBe(true);
  });

  it('說不忙就不算', () => {
    unregister = registerBusySource(() => false);
    expect(wouldLoseWork()).toBe(false);
  });

  it('解除登記之後就不再問它', () => {
    const stop = registerBusySource(() => true);
    expect(wouldLoseWork()).toBe(true);
    stop();
    expect(wouldLoseWork()).toBe(false);
  });

  /*
   * 查詢函式自己壞掉時,不能當成「不忙」—— 我們不知道它本來要回什麼,
   * 而猜錯的代價是把人家的東西弄不見。往不敢動那邊倒。
   */
  it('查詢函式丟例外要當成在忙', () => {
    unregister = registerBusySource(() => {
      throw new Error('boom');
    });
    expect(wouldLoseWork()).toBe(true);
  });
});
