import {describe, expect, it} from 'vitest';
import {composerMode} from '../composerMode';

describe('composerMode', () => {
  it('不在模式裡:專案選單照舊,送選的專案', () => {
    expect(composerMode({generalActive: false, projectKb: 'kb-main'})).toEqual({
      key: 'project',
      token: null,
      showProject: true,
      kb: 'kb-main',
    });
  });

  it('一般模式:Token「一般模式」,專案拿掉,送保留代號 general', () => {
    expect(composerMode({generalActive: true, projectKb: 'kb-main'})).toEqual({
      key: 'general',
      token: '一般模式',
      showProject: false,
      kb: 'general',
    });
  });

  it('進出模式 key 不同(才會演過場)', () => {
    const a = composerMode({generalActive: false, projectKb: 'x'}).key;
    const b = composerMode({generalActive: true, projectKb: 'x'}).key;
    expect(a).not.toBe(b);
  });
});
