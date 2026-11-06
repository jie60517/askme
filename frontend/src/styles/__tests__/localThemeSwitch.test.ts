/**
 * `styles/global.css` 那條「局部 Theme 的深淺色開關」認的是 Lightning CSS 降級
 * `light-dark()` 時自己發明的兩個變數 `--lightningcss-light` / `--lightningcss-dark`。
 * 那不是公開介面 —— 建置工具升版改了名字,Settings 的深色預覽卡會在正式 build 裡又畫成淺的
 * (dev 用原生 light-dark,看不出來)。這一檔就是那條線上的警報。
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {transform} from 'lightningcss';
import {describe, expect, it} from 'vitest';

/** Chrome 110 還沒有原生 light-dark(),Lightning CSS 一定會降級 */
const OLD_CHROME = {chrome: 110 << 16};

describe('局部 Theme 的深淺色開關(global.css)', () => {
  it('Lightning CSS 降級 light-dark() 用的還是這兩個變數名', () => {
    const out = transform({
      filename: 'probe.css',
      code: Buffer.from('.a{color:light-dark(red,blue)}.b{color-scheme:dark}'),
      targets: OLD_CHROME,
    }).code.toString();
    expect(out).toContain('var(--lightningcss-light');
    expect(out).toContain('var(--lightningcss-dark');
    // color-scheme: dark 時兩個開關的值,global.css 照抄的就是這一組
    expect(out).toMatch(/--lightningcss-light:\s*;/);
    expect(out).toMatch(/--lightningcss-dark:\s*initial/);
  });

  it('global.css 的兩條規則還在', () => {
    const css = readFileSync(join(__dirname, '../global.css'), 'utf8');
    expect(css).toMatch(/\[data-astryx-theme\]\[data-theme='dark'\]\s*\{\s*--lightningcss-light:\s*;\s*--lightningcss-dark:\s*initial;/);
    expect(css).toMatch(/\[data-astryx-theme\]\[data-theme='light'\]\s*\{\s*--lightningcss-light:\s*initial;\s*--lightningcss-dark:\s*;/);
  });
});
