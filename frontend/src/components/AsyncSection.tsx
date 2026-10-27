/**
 * 「載入中 / 載不到 / 沒東西 / 內容」這四態的**同一份**寫法。
 *
 * 管理頁不要各寫一次同樣的三元運算鏈。
 * 收成一份不只是少打字 —— 這四態的**優先序**是有講究的,而且很容易寫錯:
 *
 * 1. `failed` 排最前面:**載不到不能跟「沒有紀錄」混在一起**。
 *    後端沒開的時候顯示一個空清單,看起來會像「今天沒有紀錄」。
 * 2. `loading && !data`:重抓時**不要**退回骨架 —— 畫面上原本讀到一半的東西
 *    不該消失(`useAsyncData` 的 catch 也是同一個原則)。所以是 `&& !data`。
 * 3. 空狀態的字每一頁不一樣(「沒有紀錄」跟「還沒有帳號」不是同一句話),
 *    所以是 prop 不是寫死的。
 */
import type {ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';

import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Stack} from '@astryxdesign/core/Layout';

import {LoadError} from './LoadError';
import {LoadingScreen} from './LoadingScreen';

/**
 * 四態交接的淡入。時間刻意短:這是「載完了」的回應,不是演出。
 * 只有 opacity —— 內容高度差很多(載入中那陣風約 230 高 vs 整頁),
 * 補間高度會讓捲軸在載入期間抖動,比硬切更糟。
 */
const STATE_IN = stylex.keyframes({
  from: {opacity: 0},
  to: {opacity: 1},
});

const styles = stylex.create({
  state: {
    /*
     * reduced-motion 下**不另外處理**:這支 keyframes 只動 opacity,
     * 沒有位移可砍,原樣留著就是對的(減少動態的原則是留 opacity、砍位移)。
     */
    animationName: STATE_IN,
    animationDuration: 'var(--duration-fast)',
    animationTimingFunction: 'var(--ease-standard)',
  },
});

type Props = {
  /** `useAsyncData` 回的那三個 */
  loading: boolean;
  failed: boolean;
  reload: () => void;
  /** 有沒有拿到資料(用來決定要不要畫骨架) */
  hasData: boolean;
  /** 拿到了但是空的 */
  isEmpty?: boolean;
  /** 講清楚是「什麼」載不到 —— 一頁上可能有兩三塊各自失敗 */
  errorTitle: string;
  loadingLabel: string;
  /** 空狀態要講的那一句 */
  emptyText?: string;
  children: ReactNode;
};

export function AsyncSection({
  loading,
  failed,
  reload,
  hasData,
  isEmpty = false,
  errorTitle,
  loadingLabel,
  emptyText,
  children,
}: Props) {
  /*
   * ⚠️ 判斷條件與**優先序**見檔頭那幾條。
   * **一次**就把「是哪一態」跟「畫什麼」一起決定 —— 分成兩條同形狀的三元鏈
   * 會在同一個型別上連續分支兩次,改了一條忘了另一條就會靜默錯配。
   */
  const {state, body} = failed
    ? {state: 'failed', body: <LoadError title={errorTitle} onRetry={reload} />}
    : loading && !hasData
      ? {state: 'loading', body: <LoadingScreen isCompact label={loadingLabel} />}
      : isEmpty && emptyText
        ? {
            state: 'empty',
            // 設計系統的空狀態;isCompact:這裡是頁面裡的一塊,不是整頁
            body: <EmptyState title={emptyText} isCompact />,
          }
        : {state: 'content', body: children};

  /*
   * `key={state}` 讓每次換態都重新掛載、動畫從頭播一次。
   *
   * ⚠️ **`content` 態也包進來是安全的**,理由是這四態彼此互斥:進到 content 之前
   * children 在另外三態底下**本來就沒有被 render**(failed 走 LoadError、
   * `loading && !hasData` 走風(LoadingScreen)、空狀態走 EmptyState),所以進 content 的那一次
   * 本來就是全新掛載,`key` 不會多造成一次重建 —— 圖表不會被重畫兩次。
   * 而重抓(content → content)時 `state` 字串不變,`key` 也不變,子樹原地留著,
   * 所以 `/stats` 那一區每 5 秒輪詢不會閃。
   *
   * 容器用 `Stack`(預設直排、無 gap 無內距),不是裸 `<div>` —— 版面一律走設計系統。
   */
  return (
    <Stack key={state} xstyle={styles.state}>
      {body}
    </Stack>
  );
}
