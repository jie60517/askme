import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import '@astryxdesign/core/reset.css';
// 佈景指定 Figtree,但 Astryx 的套件裡一個字型檔都沒有(@font-face 數量是 0)——
// 官網好看是因為它自己另外載了 Figtree。不補這幾行,整站會退回系統字型
// (Windows 上是 Segoe UI),跟官網長得完全不一樣。
// 自架不走 CDN:內網開站不該依賴外部連線。
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@astryxdesign/theme-neutral/theme.css';
import './styles/global.css';
// 小夥伴(pet-companion-kit):動畫本體 + Tailwind 墊片(kit 的類名在這裡實作)
import './styles/pet.css';
import './styles/pet-shim.css';
// 個人筆記編輯器的內文樣式(components/notes/NoteEditor.tsx)。
// ⚠️ 一定要在這裡匯入,**不能**放在筆記頁那一包(lazy)裡:放在那裡,正式 build 會把
// 全站 StyleX 的樣式一起搬進 Notes-*.css,首頁那包一條都不剩 —— 沒開過筆記頁的人整站沒有樣式。dev 看不出來。
import './styles/note-editor.css';

import {resetRestoredSessionToNewChat, serveSessionHandoff} from './lib/auth';
import {initDisplayPrefs} from './lib/displayPrefs';

import {App} from './App';

// 字級與對比:index.html 已經先套過一次(避免閃動),這裡把模組內的狀態
// 對上同一份值,之後拉桿與伺服器設定才有共同的起點。
initDisplayPrefs();

/*
 * 跨分頁交接。token 現在存 sessionStorage(關掉瀏覽器就要重新登入),而那是
 * 每個分頁各自一份 —— 沒有這一行的話,「在新分頁開啟連結」一律變成未登入。
 *
 * 掛在這裡而不是某個元件裡:它必須在整個分頁的生命週期都在聽,
 * 掛在畫面裡的話,那個畫面沒顯示的時候就交接不了。
 * 回傳的解除函式用不到 —— 這一層永遠不會卸載。
 */
serveSessionHandoff();

// 回復上次工作階段時退回新對話(理由與判斷條件見 auth.ts 那支)。
// 要在 render 之前:網址得在 Router 讀到它之前改好。
resetRestoredSessionToNewChat();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
