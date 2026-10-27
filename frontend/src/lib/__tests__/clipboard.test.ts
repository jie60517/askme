// @vitest-environment jsdom
/**
 * 剪貼簿的**備援**那條路(`lib/clipboard.ts`)。
 *
 * 這一組測的是用內網 http 部署的情況:非安全內容 = `navigator.clipboard` 整個不存在。
 * 終端機的「右鍵貼上」靠的就是這條備援,所以規則要用測試釘住。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {copyText, readClipboardText} from '../clipboard';

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', {value, configurable: true});
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  setClipboard(undefined);
});

describe('copyText', () => {
  it('有 navigator.clipboard 就用它', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({writeText});
    expect(await copyText('ls -l')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('ls -l');
  });

  it('沒有 navigator.clipboard(內網 http)就走 execCommand', async () => {
    setClipboard(undefined);
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as {execCommand: unknown}).execCommand = exec;
    expect(await copyText('fglcomp')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    // 備援用的 textarea 是借過就還,不能留在 body 裡
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('writeText 被拒絕(沒授權 / 分頁沒有焦點)一樣掉到備援', async () => {
    setClipboard({writeText: vi.fn().mockRejectedValue(new Error('denied'))});
    (document as unknown as {execCommand: unknown}).execCommand = vi.fn().mockReturnValue(true);
    expect(await copyText('x')).toBe(true);
  });
});

describe('readClipboardText', () => {
  it('讀得到就回剪貼簿裡的東西', async () => {
    setClipboard({readText: vi.fn().mockResolvedValue('從別的地方複製來的')});
    expect(await readClipboardText()).toBe('從別的地方複製來的');
  });

  it('讀不到就回這個分頁自己複製的最後一段 —— 右鍵貼上靠的就是這條', async () => {
    setClipboard(undefined);
    (document as unknown as {execCommand: unknown}).execCommand = vi.fn().mockReturnValue(true);
    await copyText('invoice_report.py');
    expect(await readClipboardText()).toBe('invoice_report.py');
  });

  it('readText 被拒絕也退回自己那一份', async () => {
    (document as unknown as {execCommand: unknown}).execCommand = vi.fn().mockReturnValue(true);
    setClipboard({writeText: vi.fn().mockResolvedValue(undefined)});
    await copyText('記住這一段');
    setClipboard({readText: vi.fn().mockRejectedValue(new Error('denied'))});
    expect(await readClipboardText()).toBe('記住這一段');
  });
});
