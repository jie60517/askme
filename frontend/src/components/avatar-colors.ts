/**
 * 每位同事一個固定的頭像顏色。
 *
 * 頭像全用同一塊灰(`--color-neutral`)的話,三個人的名單就是三顆一樣的圓,
 * 只能靠字首分辨。給每個人一個顏色之後,同一個人在
 * 共用名單、分享對話框、別人的提問旁邊都是同一色,掃一眼就認得出來。
 *
 * **顏色由名字決定,不是隨機、也不存**:同一個帳號在任何一台電腦、任何一次
 * 重整都是同一色。存起來反而會出問題 —— 換一台電腦就變一個人。
 *
 * **實心的底 + 反白的字**,不是淡底深字:淡底(`--color-background-*`)
 * 一排粉彩圓圈看起來像貼紙,不夠專業。
 *
 * `--color-icon-*` 配 `--color-on-accent` 是一組**剛好互為反面**的 token:
 *   - 淺色佈景:底是深的(#00458c),`--color-on-accent` 是白 → 白字壓深底
 *   - 深色佈景:底翻成淺的(#9eb7ff),`--color-on-accent` 跟著翻成近黑 → 深字壓淺底
 * 兩邊的對比都是佈景自己保證的,不必自己算。自己挑色碼就只有一邊會對。
 *
 * 顏色是走自訂屬性傳的,不是直接下 style —— `Avatar` 把底色畫在**內層**那顆
 * `.astryx-avatar-fallback` 上(它自己的文件說那是公開的 theming 目標),
 * 外面下 `xstyle` 只會蓋到不畫底色的外框。自訂屬性會繼承,設在外面一定到得了。
 * 對應的規則在 `styles/global.css`。
 */
import type {CSSProperties} from 'react';

import {rosterIndexOf} from '../lib/peopleDirectory';

/**
 * 十個色相 —— 每一個都有 `--color-icon-*`,而那一組在兩種佈景剛好互為明暗。
 *
 * ⚠️ **設計系統只有這十個可用**(`--color-icon-accent/primary/secondary/disabled`
 * 是語意色,不能拿來當人的識別色)。所以**超過十個人一定會重複**
 * —— 那是調色盤的上限,不是配色演算法的問題。見 `avatarTint` 的說明。
 */
const HUES = [
  'blue',
  'green',
  'purple',
  'orange',
  'teal',
  'pink',
  'cyan',
  'red',
  'yellow',
  'gray',
] as const;

/**
 * 名字 → 固定的色相。
 *
 * djb2:短字串夠散,而且**逐字元算**所以不吃 `hashCode` 那種
 * 只看前幾個字的毛病 —— 這裡的帳號很多是同前綴的(ming / ming2 / mingchen)。
 * 大小寫正規化:後端有些地方回帳號、有些地方回顯示名稱,
 * 大小寫不同不該變成兩個人。
 */
function hueFor(name: string): (typeof HUES)[number] {
  const key = name.trim().toLowerCase();
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
  }
  return HUES[hash % HUES.length];
}

/**
 * 掛在 `<Avatar style={...}>` 上。沒有名字就回空物件 ——
 * 那時候該長成設計系統預設的灰色,不要硬給一個顏色。
 *
 * **配色優先照名冊位置分**,讓預設頭像盡量不跟別人撞色。
 *
 * 為什麼不用純雜湊:雜湊是**隨機落點**,十幾個人丟進 10 個桶,很容易出現
 * 「三四個人擠同一色、有些色沒人用」。照排序後的位置分則是**平均攤開**——
 * 前 10 個人保證各不相同,第 11 個才開始跟第 1 個共用。
 *
 * ⚠️ **10 個人以上一定還是會重複**,那是設計系統只給 10 個色相的硬限制。
 * 真的要每個人都不一樣,得靠大家上傳自己的照片(有照片就不看這個顏色了)。
 *
 * 名冊還沒載完時退回雜湊(`hueFor`)。
 *
 * ⚠️ **這時候顏色確實會在名冊載完的那一刻跳一次** —— 雜湊色相跟位置色相
 * 是兩套算法,對同一個人不保證算出同一個色。
 *
 * 為什麼還是留著雜湊當退路:名冊在模組層只抓一次、而且是登入後就開始抓,
 * 多數畫面掛上來的時候已經有了,跳色的窗口很短;而沒有退路的話,那個窗口裡
 * 一整排頭像會是同一塊灰,那比跳一次難看。真的要完全不跳,得讓名冊載完之前
 * 不畫頭像 —— 那是拿一個閃爍換另一個閃爍。
 */
export function avatarTint(name: string | null | undefined): CSSProperties {
  if (!name) return {};
  const index = rosterIndexOf(name);
  const hue = index === undefined ? hueFor(name) : HUES[index % HUES.length];
  return {
    '--avatar-tint': `var(--color-icon-${hue})`,
    // 「壓在強調色上的字」—— 佈景已經幫這兩個配好正反面,見檔頭
    '--avatar-ink': 'var(--color-on-accent)',
  } as CSSProperties;
}
