// @vitest-environment jsdom
/**
 * 點主機卡片之後長成的方框(`HostLogin`)。測**畫面上的行為**:三格唯讀欄位的內容、連上那一下的按鈕、logo 載不到的退路。
 */
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';

import {HostLogin} from '../HostLogin';
import type {TerminalHost} from '../../../lib/terminalApi';

const MAIN: TerminalHost = {id: 'main', label: '主機', sub: 'app-server · deploy', via: ''};

beforeAll(() => {
  // jsdom 沒有 matchMedia;按鈕轉圈的 Spinner 要用(佈景的 useMediaQuery)
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const box = (name: string) => screen.queryByRole('textbox', {name}) ?? screen.queryByLabelText(name);

describe('HostLogin', () => {
  it('三格唯讀欄位(副標拆出主機與帳號);連上那一下按鈕變成「已連線」', () => {
    const {rerender} = render(<HostLogin host={MAIN} isConnected={false} />);
    expect((box('主機') as HTMLInputElement).value).toBe('app-server');
    expect((box('帳號') as HTMLInputElement).value).toBe('deploy');
    for (const name of ['主機', '帳號', '密碼']) expect((box(name) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', {name: '已連線'})).toBeNull();

    rerender(<HostLogin host={MAIN} isConnected />);
    expect(screen.getByRole('button', {name: '已連線'})).toBeTruthy();
  });

  it('窄版那張 logo 載不到也退回字母頭像,不露破圖', () => {
    const {container} = render(<HostLogin host={MAIN} isConnected={false} />);
    const narrow = Array.from(container.querySelectorAll('img')).find((i) => i.getAttribute('src') === '/host-logos/main.jpg');
    expect(narrow).toBeTruthy();
    fireEvent.error(narrow!);
    expect(container.querySelectorAll('img[src^="/host-logos/"]')).toHaveLength(0);
  });
});
