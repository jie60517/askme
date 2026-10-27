import {describe, expect, it} from 'vitest';

import {fileLook} from '../fileIcon';

const file = (name: string) => fileLook({name, is_dir: false});

describe('fileLook', () => {
  it('資料夾一律是資料夾,不看名字', () => {
    expect(fileLook({name: 'src', is_dir: true}).tone).toBe('folder');
    expect(fileLook({name: 'backup.zip', is_dir: true}).tone).toBe('folder');
  });

  it('原始碼是 code', () => {
    expect(file('main.c').tone).toBe('code');
    expect(file('app.py').tone).toBe('code');
  });

  it('副檔名**不分大小寫** —— 主機上大寫檔名一樣多', () => {
    expect(file('MAIN.C').tone).toBe('code');
    expect(file('README.MD').tone).toBe('doc');
  });

  it('依類型分色:sql / 腳本 / 設定 / 文件 / 壓縮 / 圖片', () => {
    expect(file('level.sql').tone).toBe('sql');
    expect(file('fr_fix.sh').tone).toBe('script');
    expect(file('terminal_hosts.json').tone).toBe('data');
    expect(file('import_full.log').tone).toBe('doc');
    expect(file('web_app.tar.gz').tone).toBe('archive');
    expect(file('logo.png').tone).toBe('image');
  });

  it('認不得的副檔名就是一張白紙', () => {
    expect(file('afiedt.buf').tone).toBe('plain');
    expect(file('NOEXT').tone).toBe('plain');
  });

  it('**開頭就是點的不算副檔名**(`.bashrc` 是隱藏檔,不是 rc 類型)', () => {
    expect(file('.bashrc').tone).toBe('plain');
    expect(file('.env').tone).toBe('plain');
  });
});
