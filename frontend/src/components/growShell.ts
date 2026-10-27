import * as stylex from '@stylexjs/stylex';

/**
 * 「長出來 / 收回去」的殼 —— 版面上會一格跳過去的那幾塊共用。
 *
 * 用的地方:對話頁的附件抽屜、分類卡、「會通知」藍條,用量頁的「正在跑」,Work Flow 的執行紀錄面板。
 * 時間只定義在這裡,改時間不用每一處各改一次。
 *
 * 用法(三層):
 * ```tsx
 * <Stack xstyle={[growStyles.shell, isOpen && growStyles.open]}>
 *   <Stack xstyle={growStyles.clip} inert={!isOpen}>
 *     …內容(間距放在這一層裡面,見下面 clip 的說明)
 * ```
 *
 * - 展開 225ms + `--ease-panel`(大面積的那一階,同 `AutoHeight`);收起 165ms + `--ease-standard`
 *   —— 收起是系統回應,要乾脆。reduce:不補間,直接到位。
 * - 收起之後要拔掉內容的話,等 `GROW_CLOSE_MS` 再拔(用量頁的「正在跑」)。
 * - 各自的變化(負邊距、框的上限一起補間、reduce 時延後收起)疊在自己的樣式上,寫在 xstyle 後面。
 */

/*
 * 手感跟個人設定的 OK / Cancel 那一列同一套(`AccountSettingsDialog` 的 `actionsRow`,
 * 曲線是 `global.css` 的 `--ease-panel` / `--ease-overshoot`):「往下長出來」。
 *
 * ⚠️ 這裡**刻意 animate 版面屬性**(`grid-template-rows`),違反「只動 transform
 * 與 opacity」那條通則 —— 要的就是「底下真的長出一塊」,而那件事 transform
 * 假裝不了(假裝的話卡片會蓋在別的東西上,不是把版面推開)。`0fr → 1fr` 是
 * 這件事唯一補得了幀的寫法(兩端都要是明確的 track 大小)。
 *
 * ⚠️ 殼**不能過衝**:`fr` 超過 1 會被內容高度夾住,過衝等於卡在頂點。
 * 會過衝的是內容的 `scale`(見 `Chat.tsx` 的 `suggestionsFadeShown`),那個安全。
 * ⚠️ 收起來是 165ms、不延遲、不過衝 —— 那是系統回應,不留戀。
 *
 * ⚠️ **開場是 225ms(`--duration-medium-min`),不是 `actionsRowOpen` 的 420ms**:
 * 那邊長出來的是**一列兩顆鈕**,這邊可能是**四張卡的格子**,同樣的時間換到大得多的
 * 面積上就變成「拖」。時間跟設定對話框裡的 `modelRow` 同一階(它也是
 * `--duration-medium-min` + `--ease-panel`),⚠️ **但理由不一樣,不要把兩者寫成同一件事**:
 * 那邊是「不是使用者按出來的,是網路慢才看得到的補救,快一點比較不擾人」;
 * 這邊是使用者自己按的,慢純粹就是慢。
 * **不要為了「跟設定對話框一致」把它改成 420。**
 *
 * ⚠️ 「會通知誰」的藍條與附件抽屜另外把 `margin-block-end` 綁進同一組 transition(見 `Chat.tsx` 的
 * `tuckShell`),改時間要連那邊的數一起改。
 */

/** 收起演多久(毫秒)= `--duration-fast-max`。⚠️ 要跟下面 `shell` 的 transition 一致 */
export const GROW_CLOSE_MS = 165;

export const growStyles = stylex.create({
  shell: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transition: {
      default: 'grid-template-rows var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  open: {
    gridTemplateRows: '1fr',
    transition: {
      default: 'grid-template-rows var(--duration-medium-min) var(--ease-panel)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  /**
   * 被夾住的那一層。⚠️ 不能有 padding / 框線:`min-height: 0` 夾不掉它們(收起來還會留那一截),
   * 間距與框線都放在**這一層裡面**的內容上(見 `Chat.tsx` 的 `suggestionsFade`)。
   */
  clip: {
    overflow: 'hidden',
    minHeight: 0,
  },
  /**
   * 這一次的變化**直接到位、不演**(例如按 Enter 送出時清空的附件抽屜:鍵盤上的高頻動作)。
   * 放在 xstyle 陣列的**最後**,蓋掉前面每一層的 `transition`。
   */
  snap: {
    transition: 'none',
  },
});
