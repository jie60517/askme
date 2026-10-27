/**
 * 挑選器裡每一格(顏色圓點、圖示)共用的記號 —— `ColorPicker`、`FolderIconPicker`、
 * 筆記提示框的 `IconPicker`(筆記左側清單的右鍵直接用前兩個)。樣式在 global.css 的 `[data-picker-swatch]`。
 *
 * 同一個選單裡的項目是浮起的漂浮框,這排格子要跟它一致,不要用設計系統的 `secondary`
 * (平的灰底方塊)標選中或當滑過的樣子 —— 兩種框混在一起會很雜:
 *  - 每一格都是 ghost(平常沒有底色,「⋯」也是);
 *  - 選中的那一格在圖示 / 圓點**外面畫一圈**(`aria-pressed`,報讀軟體也聽得到);
 *  - 滑過用跟選單項目一樣的漂浮框(`data-hover-lift="pill"`,底色 + 影子,不位移)。
 */
export const PICKER_SWATCH = {
  'data-hover-lift': 'pill',
  'data-picker-swatch': '',
} as const;

