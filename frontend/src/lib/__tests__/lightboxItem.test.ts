/**
 * 燈箱模式與網址(`lib/lightboxItem.ts`):
 * Word / 簡報轉成 PDF 看(`document`)、Excel 畫成表格(`sheet`),轉不了退回純文字。
 */
import {describe, expect, it} from 'vitest';

import {lightboxItem} from '../lightboxItem';

describe('lightboxItem', () => {
  it('Word / 簡報走 document:轉 PDF 的網址 + 退回用的純文字網址', () => {
    const item = lightboxItem('output', 'sid', '規格書 #1.docx');
    expect(item.mode).toBe('document');
    // 檔名要編碼(# 之後會被當成 fragment),as 參數接在最後
    expect(item.convertUrl).toBe('/api/preview/files/sid/%E8%A6%8F%E6%A0%BC%E6%9B%B8%20%231.docx?as=pdf');
    expect(item.textUrl).toBe('/api/preview/files/sid/%E8%A6%8F%E6%A0%BC%E6%9B%B8%20%231.docx');
    expect(lightboxItem('upload', 'sid', 'a.pptx').convertUrl).toBe('/api/preview/uploads/sid/a.pptx?as=pdf');
  });

  it('Excel 走 sheet,.xls 也算', () => {
    for (const name of ['a.xlsx', 'a.XLSM', 'a.xls']) {
      const item = lightboxItem('output', 'sid', name);
      expect(item.mode).toBe('sheet');
      expect(item.convertUrl).toBe(`/api/preview/files/sid/${name}?as=sheet`);
      expect(item.textUrl).not.toBeNull();
    }
  });

  it('舊版 .doc / .ppt 轉得了 PDF,但沒有純文字可以退(後端給的是寫給 AI 的說明)', () => {
    const item = lightboxItem('output', 'sid', 'old.doc');
    expect(item.mode).toBe('document');
    expect(item.textUrl).toBeNull();
  });

  it('其他模式沒有 convertUrl', () => {
    expect(lightboxItem('output', 'sid', 'a.pdf')).toMatchObject({mode: 'pdf', convertUrl: null});
    expect(lightboxItem('output', 'sid', 'a.md')).toMatchObject({mode: 'text', convertUrl: null});
    expect(lightboxItem('output', 'sid', 'a.zip')).toMatchObject({mode: 'none', convertUrl: null});
  });
});
