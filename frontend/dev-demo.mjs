// 跟 `npm run dev` 同一份 vite.config.ts,只是 /api 轉到 backend-demo(8124)。
// 為什麼要一支 wrapper:.claude/launch.json 不能設環境變數,而 vite.config.ts 是讀 API_TARGET 決定代理目標。
// 路徑一律 fileURLToPath:專案路徑可能含非 ASCII 字元(URL 裡是 %XX 編碼),自己剝前綴會壞掉。
import {fileURLToPath} from 'node:url';

const frontendDir = fileURLToPath(new URL('.', import.meta.url));
// ⚠️ 一定要先 chdir:launch.json 是從 repo 根目錄起的,而 astryx 的 vite 外掛用 cwd 找
// node_modules,cwd 不對的話所有 @astryxdesign/core/* 都會「Failed to resolve import」。
process.chdir(frontendDir);
process.env.API_TARGET = process.env.API_TARGET || 'http://localhost:8124';
const port = Number(process.env.PORT) || 5174;

const {createServer} = await import('vite');
const server = await createServer({
  root: frontendDir,
  configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
  server: {port, strictPort: false},
});
await server.listen();
server.printUrls();
