/**
 * xterm.js 與兩個 addon 的動態載入:不開終端機的人用不到,這 300 多 KB 不進主 bundle。
 * CSS 也在這裡一起載 —— 它只有這一頁要。
 */
export async function loadXterm() {
  const [xterm, fit, unicode11] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-unicode11'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  return {Terminal: xterm.Terminal, FitAddon: fit.FitAddon, Unicode11Addon: unicode11.Unicode11Addon};
}
