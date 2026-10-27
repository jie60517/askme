import {describe, expect, it} from 'vitest';

import {describeDictationError, describeDictationStartError} from '../dictationErrors';

describe('describeDictationError', () => {
  it('stays quiet when the user stopped it themselves', () => {
    expect(describeDictationError('aborted', true)).toBeNull();
  });

  it('blames the missing https before blaming the permission', () => {
    // 用內網 http 開的網站:瀏覽器根本不會問,直接 not-allowed
    expect(describeDictationError('not-allowed', false)).toMatch(/https/);
    expect(describeDictationError('not-allowed', true)).toMatch(/Allow the microphone/);
    expect(describeDictationError('service-not-allowed', false)).toMatch(/https/);
  });

  it('names the other known causes', () => {
    expect(describeDictationError('audio-capture', true)).toMatch(/No microphone/);
    expect(describeDictationError('network', true)).toMatch(/network/);
    expect(describeDictationError('no-speech', true)).toMatch(/No speech/);
  });

  it('never swallows an unknown code', () => {
    expect(describeDictationError('something-new', true)).toContain('something-new');
  });
});

describe('describeDictationStartError', () => {
  it('explains the double-tap case in words a user can act on', () => {
    const again = new DOMException('already started', 'InvalidStateError');
    expect(describeDictationStartError(again)).toMatch(/tap the microphone again/);
  });

  it('names an unexpected DOMException instead of staying silent', () => {
    expect(describeDictationStartError(new DOMException('nope', 'NotFoundError'))).toContain(
      'NotFoundError',
    );
  });

  it('still says something when the thrown value is not a DOMException', () => {
    // 丟出來的東西不保證是 DOMException(可能是字串、或設計系統自己的錯)——
    // 這條路徑的重點是「不能沒有反應」,所以一律要有一句話
    expect(describeDictationStartError('boom')).toBe('Voice input could not start.');
    expect(describeDictationStartError(undefined)).toBe('Voice input could not start.');
  });
});
