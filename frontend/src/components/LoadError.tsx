/**
 * 「載不到,再試一次」—— 管理頁共用。
 *
 * ⚠️ **載入失敗不能跟「沒有紀錄」混在一起**。rejection 沒人接的話,
 * 後端沒開的時候畫面就是一個空清單 —— 看起來像「今天沒有紀錄」,
 * 而實際上是整條 API 掛了。兩者要長得完全不一樣:一個是空狀態、一個是錯誤 + 重試。
 */
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';

type Props = {
  /** 講清楚是「什麼」載不到 —— 一頁上可能有兩三塊各自失敗 */
  title: string;
  onRetry: () => void;
};

export function LoadError({title, onRetry}: Props) {
  return (
    /* ⚠️ 整段中文:這個殼只有管理頁在用,而那幾頁的**內容**是中文。
       側邊欄那幾條連結仍然是英文,見 Sidebar.tsx 的 ADMIN_LINKS。
       重試鈕放在 Banner 自己的 endContent:窄的時候它會自己換到下一行。 */
    <Banner
      status="error"
      title={title}
      description="伺服器沒有回應。這跟「沒有任何紀錄」不是同一件事。"
      endContent={<Button label="重試" variant="secondary" size="sm" onClick={onRetry} />}
    />
  );
}
