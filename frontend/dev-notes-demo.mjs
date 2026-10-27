// 個人筆記的示範前端:跟 dev-demo.mjs 一樣,只是 /api 轉到 backend-notes-demo(8126)、自己開在 5176。
// 不共用 5174:SSH 示範可能同時開著。
process.env.API_TARGET = process.env.API_TARGET || 'http://localhost:8126';
process.env.PORT = process.env.PORT || '5176';
await import('./dev-demo.mjs');
