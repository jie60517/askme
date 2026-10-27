/** 檔名分類的單一事實來源與 codeLanguage。 */
import {describe, expect, it} from 'vitest';

import {
  codeLanguage,
  isImageFilename,
  isOfficeFilename,
  isTextFilename,
} from '../filekind';

describe('分類', () => {
  it('圖片', () => {
    expect(isImageFilename('shot.PNG')).toBe(true);
    expect(isImageFilename('shot.webp')).toBe(true);
    expect(isImageFilename('shot.txt')).toBe(false);
  });

  it('Office 只認 OOXML(.doc 抽不了字,列進來只會 415)', () => {
    expect(isOfficeFilename('報價單.xlsx')).toBe(true);
    expect(isOfficeFilename('舊文件.doc')).toBe(false);
  });

  it('文字用排除法:沒見過的副檔名 / 沒副檔名的都算文字', () => {
    expect(isTextFilename('report.tmp1')).toBe(true);
    expect(isTextFilename('Makefile')).toBe(true);
    expect(isTextFilename('bundle.zip')).toBe(false);
  });
});

describe('codeLanguage(程式檔的 IDE 樣式)', () => {
  it('python / typescript 有對應語言', () => {
    expect(codeLanguage('hello.py')).toBe('python');
    expect(codeLanguage('app.tsx')).toBe('typescript');
  });

  it('一般文字檔不是程式檔(維持 <pre>)', () => {
    expect(codeLanguage('trace.log')).toBeNull();
    expect(codeLanguage('notes.txt')).toBeNull();
  });
});
