/**
 * 讓 `Table` 的**整列**都可以點來「選這一列」(打開它的詳情 / 對話框),選到的那一列有底色。
 *
 * 跟 `useTableRowLink` 是兄弟:那支是點了換頁,這支是點了把 id 交給呼叫端。
 * 用量明細(`Questions.tsx`)在用;別的表要「點列開詳情」時也用這支,不要再抄一份。
 *
 * 跟 `useTableRowLink` 同一套規矩(理由寫在那支):
 *  - 只給滑鼠;列保持 `role="row"`,鍵盤走欄位裡那顆真正的按鈕 —— **那顆不能拿掉**。
 *  - 事件從按鈕、連結、輸入框來的不插手;正在選取文字時也不插手(要複製問題的人不會被打開詳情)。
 */
import {useMemo, useRef} from 'react';

import type {TablePlugin} from '@astryxdesign/core/Table';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  clickable: {cursor: 'pointer'},
  selected: {backgroundColor: 'var(--color-overlay-pressed)'},
});

export function useTableRowSelect<T extends {id: number}>(
  selectedId: number | null,
  onSelect: (id: number) => void,
): TablePlugin<T> {
  // onSelect 可能是呼叫端每次 render 新建的;用 ref 接住,plugin 只在「選到的列換了」時重建
  const latest = useRef(onSelect);
  latest.current = onSelect;

  return useMemo<TablePlugin<T>>(
    () => ({
      transformBodyRow: (props, item) => ({
        ...props,
        xstyle: [...props.xstyle, styles.clickable, item.id === selectedId && styles.selected],
        htmlProps: {
          ...props.htmlProps,
          onClick: (event: React.MouseEvent) => {
            if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return;
            if (window.getSelection()?.toString()) return;
            latest.current(item.id);
          },
        },
      }),
    }),
    // selectedId 要在 deps 裡:選到的列換了,列的底色要跟著重畫
    [selectedId],
  );
}
