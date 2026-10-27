/**
 * 終端機的 16 色 ANSI 盤。
 *
 * ⚠️ **這是全站唯一一組寫死的色碼,而且是刻意的**。理由:
 *
 * - ANSI 的 16 色是**終端機協定**的一部分(`ls` 的藍色資料夾、`git` 的紅綠、
 *   vim 的語法上色),不是這個網站的設計語彙 —— 佈景裡沒有、也不該有對應的 token。
 * - 不能拿 `--color-text-red/green/blue/...` 去湊。那幾個 token 是給**文字標記**用的
 *   粉彩色(深色佈景下 blue = `#c7d3ff`),彼此明度幾乎一樣:資料夾、可執行檔、
 *   壓縮檔在畫面上分不出來,`git status` 的紅綠也糊在一起。
 *
 * 這一組取自 GitHub Dark 的終端機盤。在外框的深底(`--color-background-body` 深色 = `#1b1b1b`)
 * 上量過的對比度:六個彩色 6.8:1 起跳(bright 版 8.8 起)、`white` 8.8、`brightWhite` 15.8。
 * **兩個例外是刻意的**:`black` 2.1:1 與 `brightBlack` 3.8:1 —— ANSI 的這兩格本來就是拿來
 * 「壓下去」的(註解、次要輸出),要它們跟正文一樣清楚等於取消它們的作用;
 * `brightBlack` 仍在非文字對比的 3:1 之上。**改這一組之前先把數字重量一次**,不要憑感覺調。
 * 底色、前景、游標見底下的 `ANSI_BACKGROUND` / `ANSI_FOREGROUND` ——
 * 它們也是寫死的(理由寫在那裡),這個檔案就是「終端機的顏色」那一整組。
 *
 * 換佈景不會影響這一組,那正是要的:終端機兩種佈景下都是深的。
 */
export const ANSI_PALETTE = {
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
} as const;

/**
 * 終端機的底色、前景與游標。**跟佈景無關,兩種模式下都是這一組**(淺色模式的 shell 也是黑底)。
 *
 * ⚠️ 不要改成用 `resolveCssColor` 去解 `--color-background-body` / `--color-text-primary`、
 * 靠外框把它們翻成深色:那條路**多轉了一手**,而且在正式 build 上會斷
 * (Lightning CSS 把 `light-dark()` 降級成只認 `<html>` 的開關,細節寫在 `pages/Terminal.tsx`
 * 的 `styles.window`)—— 斷掉時整個 shell 變成白底白字。終端機兩種佈景下都是深的,
 * 那就**直接寫死**,不要用一個會翻的變數去表達一個不會翻的值。
 * (外框的分頁列、檔案欄、AskME 仍走佈景變數,這裡只管 xterm 畫布。)
 *
 * 值就是深色佈景那兩個(`#1b1b1b` = 深色的 `--color-background-body`,
 * `#ebebeb` = 深色的 `--color-text-primary`)——
 * 上面那 16 色的對比度也是對著 `#1b1b1b` 量的,換底色之前要重量。
 */
export const ANSI_BACKGROUND = '#1b1b1b';
export const ANSI_FOREGROUND = '#ebebeb';

/**
 * 選取的底色。不用 `--color-overlay-pressed`(白 10%)—— 淡到看不出選了哪一段,
 * 而這一頁的「選取即複製」全靠它給回饋。用藍色半透明:蓋在字上還看得見原本的顏色,
 * 所以**不設** `selectionForeground`。疊在深底上約 3.1:1,過得了非文字對比那條線。
 */
export const ANSI_SELECTION = 'rgba(88, 166, 255, 0.35)';
