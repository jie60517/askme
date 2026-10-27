import {describe, expect, it} from 'vitest';

import {
  CLOSE_CODE,
  closeMessage,
  crumbsOf,
  formatMtime,
  formatSize,
  joinPath,
  parentPath,
  shortPath,
  terminalWsUrl,
} from '../terminalApi';

describe('closeMessage', () => {
  it('prefers the message the server sent', () => {
    const closed = {
      type: 'closed' as const,
      reason: 'idle' as const,
      code: CLOSE_CODE.idle,
      message: '10 分鐘沒有操作,已自動斷線。',
    };
    expect(closeMessage(CLOSE_CODE.idle, closed)).toBe(closed);
  });

  it('maps every server close code to a Chinese sentence and keeps the code', () => {
    expect(closeMessage(CLOSE_CODE.idle).reason).toBe('idle');
    expect(closeMessage(CLOSE_CODE.tooMany).message).toContain('上限');
    expect(closeMessage(CLOSE_CODE.forbidden).message).toContain('工程師');
    expect(closeMessage(CLOSE_CODE.unreachable).message).toContain('連不上');
    expect(closeMessage(CLOSE_CODE.unreachable).code).toBe(CLOSE_CODE.unreachable);
    expect(closeMessage(1000).reason).toBe('exit');
  });

  it('treats an abnormal close (1006) as a network drop', () => {
    const c = closeMessage(1006);
    expect(c.reason).toBe('network');
    expect(c.message).toContain('連線中斷');
  });
});

describe('paths', () => {
  it('joinPath tolerates a trailing slash on the directory', () => {
    expect(joinPath('/home/deploy', 'a.txt')).toBe('/home/deploy/a.txt');
    expect(joinPath('/home/deploy/', 'a.txt')).toBe('/home/deploy/a.txt');
    expect(joinPath('/', 'a.txt')).toBe('/a.txt');
  });

  it('parentPath walks up and stops at /', () => {
    expect(parentPath('/home/deploy/app')).toBe('/home/deploy');
    expect(parentPath('/home')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(parentPath('/a/b/')).toBe('/a');
  });

  it('crumbsOf starts at ~ under home and at / elsewhere', () => {
    expect(crumbsOf('/home/deploy/app/src', '/home/deploy')).toEqual([
      {label: '~', path: '/home/deploy'},
      {label: 'app', path: '/home/deploy/app'},
      {label: 'src', path: '/home/deploy/app/src'},
    ]);
    expect(crumbsOf('/home/deploy', '/home/deploy')).toEqual([{label: '~', path: '/home/deploy'}]);
    expect(crumbsOf('/srv/data', '/home/deploy')).toEqual([
      {label: '/', path: '/'},
      {label: 'srv', path: '/srv'},
      {label: 'data', path: '/srv/data'},
    ]);
    // chroot 之下家目錄就是 / —— 不能把每一層都當成 ~ 底下
    expect(crumbsOf('/app', '/')).toEqual([
      {label: '/', path: '/'},
      {label: 'app', path: '/app'},
    ]);
  });

  it('shortPath collapses home to ~ but never a prefix that only looks like home', () => {
    expect(shortPath('/home/deploy/x', '/home/deploy')).toBe('~/x');
    expect(shortPath('/home/deploy', '/home/deploy')).toBe('~');
    expect(shortPath('/home/deploy2/x', '/home/deploy')).toBe('/home/deploy2/x');
  });
});

describe('formatting', () => {
  it('formatSize', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(4300)).toBe('4.2 KB');
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatSize(-1)).toBe('');
  });

  it('formatSize 進位之後到了 1024 就升一個單位', () => {
    // 1,048,575 B = 1023.999 KB —— 不能顯示成「1024.0 KB」
    expect(formatSize(1_048_575)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 1024 - 1)).toBe('1.0 GB');
    // 還沒到的照舊:1023.9 是 Size 欄最寬的那個值
    expect(formatSize(1023.9 * 1024 * 1024)).toBe('1023.9 MB');
  });

  it('formatMtime 一律是 YYYY-MM-DD HH:mm(年月日時)', () => {
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    expect(formatMtime(at('2026-09-10T17:06:00'))).toBe('2026-09-10 17:06');
    expect(formatMtime(at('2019-01-02T03:04:00'))).toBe('2019-01-02 03:04');
    expect(formatMtime(0)).toBe('');
  });
});

describe('terminalWsUrl', () => {
  it('follows the page origin when there is no API base', () => {
    expect(terminalWsUrl('', {protocol: 'https:', host: 'askme.example'})).toBe(
      'wss://askme.example/api/terminal/ws',
    );
    expect(terminalWsUrl('', {protocol: 'http:', host: 'localhost:5173'})).toBe(
      'ws://localhost:5173/api/terminal/ws',
    );
  });

  it('turns an explicit http base into ws', () => {
    expect(terminalWsUrl('http://localhost:8123/', {protocol: 'https:', host: 'x'})).toBe(
      'ws://localhost:8123/api/terminal/ws',
    );
  });
});
