/**
 * 讓 `Table` 的**整列**都可以點進去,不是只有欄位裡那個連結本身可點。
 *
 * ⚠️ **Astryx 的 `Table` 沒有 `onRowClick` 這種 prop**(見 `Table.doc.mjs` 的
 * prop 清單)。能碰到 `<tr>` 的官方入口只有 plugin 的 `transformBodyRow`,
 * 所以這支寫成 plugin,而不是在外面包一層 `onClick` 再用 `closest('tr')` 反推。
 *
 * ## 為什麼列上**不放** `role="link"` / `tabIndex`
 *
 * 那樣寫「整列可點」確實會成立 —— 但 `role="link"` 會把 `<tr>`
 * 原本的 `role="row"` **蓋掉**,於是那一列在報讀軟體眼中不再是表格的一列:
 * 欄位標題與值的對應關係整個消失,聽到的只剩一個 aria-label。
 * 一張四欄的資料表,那等於把它降級成一串連結。
 *
 * 分工:
 *  - **滑鼠**走這個 plugin 的 `onClick`(整列都可點,游標也變成手指)。
 *  - **鍵盤與報讀軟體**走欄位裡那個真正的 `Link`(它本來就在,tab 得到、
 *    念得出來),而列保持 `role="row"`。
 *
 * ⚠️ 所以**欄位裡那個 `Link` 不能拿掉** —— 拿掉之後這張表對鍵盤使用者就沒有出口了。
 * 而 `onClick` 會先看事件是不是從 `<a>` 來的:是的話就讓連結自己處理,
 * 不然點在名字上會導覽兩次。
 *
 * `href` 回 `null` 的列**完全不動**(不給游標、不給 onClick)—— 給沒有明細頁可以去的列用。
 */
import {useCallback, useMemo, useRef} from 'react';
import {useNavigate} from 'react-router-dom';

import type {TablePlugin} from '@astryxdesign/core/Table';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  clickable: {
    cursor: 'pointer',
  },
});

export function useTableRowLink<T extends Record<string, unknown>>(options: {
  /** 這一列要連到哪裡。回 `null` = 這一列不可點。 */
  href: (item: T) => string | null;
}): TablePlugin<T> {
  const navigate = useNavigate();

  /*
   * ⚠️ `href` 幾乎一定是呼叫端每次 render 新建的函式。放進 deps 會讓這個 plugin
   * 每次都是新物件,而 `Table` 拿它去比對要不要重畫每一列 —— 等於關掉列的 memo。
   * 用 ref 接住最新的那一份,plugin 本身保持穩定。
   */
  const latest = useRef(options);
  latest.current = options;

  const go = useCallback(
    (to: string, event: React.MouseEvent) => {
      /*
       * 事件從連結(或其他可互動的東西)來的話就不要插手 —— 那個元素自己會處理。
       * 少了這一行,點在帳號名上會導覽兩次(連結一次、這裡一次)。
       */
      if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return;
      // 選字的時候不要跳走:拖曳選取結束時也會放出一個 click。
      if (window.getSelection()?.toString()) return;
      navigate(to);
    },
    [navigate],
  );

  return useMemo(
    () => ({
      transformBodyRow: (props, item) => {
        const to = latest.current.href(item);
        if (!to) return props;
        return {
          ...props,
          xstyle: [...props.xstyle, styles.clickable],
          htmlProps: {
            ...props.htmlProps,
            onClick: (event) => go(to, event),
          },
        };
      },
    }),
    [go],
  );
}
