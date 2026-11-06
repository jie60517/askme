// @vitest-environment jsdom
/**
 * Word / 簡報 / Excel 預覽(`components/OfficePreview.tsx`)。
 *
 * 重點是**轉不了一律退回純文字**(主機沒裝轉檔程式 503、這份轉不出來 415、斷線),
 * 轉得了才換成 PDF 框 / 表格。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';

import {DocumentPreview, SheetPreview} from '../OfficePreview';
import {lightboxItem} from '../../lib/lightboxItem';

const FALLBACK = <p>純文字預覽</p>;

function respond(status: number, body?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), {status})),
  );
}

beforeEach(() => {
  // LoadingScreen 會問 matchMedia;jsdom 沒有
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DocumentPreview', () => {
  const item = lightboxItem('output', 'sid', '說明.docx');
  const frame = (src: string) => <iframe title="pdf" src={src} />;

  it('轉好了:PDF 框,網址帶「不要縮圖欄、貼齊寬度」', async () => {
    respond(200);
    render(<DocumentPreview item={item} frame={frame} fallback={FALLBACK} />);
    const iframe = await screen.findByTitle('pdf');
    expect(iframe.getAttribute('src')).toBe(`${item.convertUrl}#navpanes=0&view=FitH`);
  });

  it.each([503, 415, 401])('回 %i 就退回純文字', async (status) => {
    respond(status);
    render(<DocumentPreview item={item} frame={frame} fallback={FALLBACK} />);
    expect(await screen.findByText('純文字預覽')).toBeTruthy();
    expect(screen.queryByTitle('pdf')).toBeNull();
  });

  it('斷線也退回純文字', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))));
    render(<DocumentPreview item={item} frame={frame} fallback={FALLBACK} />);
    expect(await screen.findByText('純文字預覽')).toBeTruthy();
  });
});

describe('SheetPreview', () => {
  const item = lightboxItem('output', 'sid', '明細.xlsx');

  it('第一列當表頭、數字加千分位,多張工作表可以切換', async () => {
    respond(200, {
      max_rows: 500,
      sheets: [
        {name: '明細', rows: [['品號', '金額'], ['P1', 12300]], truncated: false},
        {name: '彙總', rows: [['客戶'], ['客戶0']], truncated: true},
      ],
    });
    const {container} = render(<SheetPreview item={item} fallback={FALLBACK} />);
    expect(await screen.findByText('品號')).toBeTruthy();
    expect(screen.getByText((12300).toLocaleString())).toBeTruthy();
    expect(screen.queryByText(/Only the first/)).toBeNull();

    // 分頁的字設計系統畫了兩份(一份隱形的佔粗體的寬),用分頁的值點
    fireEvent.click(container.querySelector('[data-tab-value="1"]') as HTMLElement);
    await waitFor(() => expect(screen.getByText('客戶0')).toBeTruthy());
    expect(screen.getByText(/Only the first 500 rows/)).toBeTruthy();
  });

  it('只有一張工作表就不畫分頁', async () => {
    respond(200, {max_rows: 500, sheets: [{name: '明細', rows: [['品號']], truncated: false}]});
    const {container} = render(<SheetPreview item={item} fallback={FALLBACK} />);
    await screen.findByText('品號');
    expect(container.querySelector('[data-tab-value]')).toBeNull();
  });

  it('讀不出來就退回純文字', async () => {
    respond(415);
    render(<SheetPreview item={item} fallback={FALLBACK} />);
    expect(await screen.findByText('純文字預覽')).toBeTruthy();
  });
});
