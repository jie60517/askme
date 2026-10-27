// @vitest-environment jsdom
/**
 * 一條終端機連線(`TerminalSession`)的**連線狀態機**:第一次連上走方框那套過場,
 * 終端機已經在畫面上之後的重新連線**不再走一遍**。
 *
 * xterm、檔案欄、AskME、過場都換成假的:這裡只看「什麼時候畫方框、什麼時候畫終端機、
 * 叫了幾次過場、頁面收到什麼」。WebSocket 換成一支記下每一條連線回呼的假 `connectTerminal`。
 */
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {forwardRef, useEffect, useImperativeHandle, useState} from 'react';

import type {TerminalClosed, TerminalStatus} from '../../../lib/terminalApi';

type Handlers = {
  onStatus: (s: TerminalStatus) => void;
  onClosed: (c: TerminalClosed) => void;
  onData: (d: Uint8Array) => void;
  onCwd: (path: string) => void;
};
const conns: {handlers: Handlers; close: ReturnType<typeof vi.fn>}[] = [];
const notices: string[] = [];
let viewMounts = 0;
let viewIds = 0;
/** 檔案欄最後一次拿到的 followPath */
let lastFollow: string | null | undefined;

vi.mock('../../../lib/terminalApi', () => ({
  connectTerminal: (_opts: unknown, handlers: Handlers) => {
    const close = vi.fn();
    conns.push({handlers, close});
    return {sendInput: vi.fn(), resize: vi.fn(), activity: vi.fn(), close};
  },
}));
vi.mock('../morph', () => ({
  morph: vi.fn((update: () => void) => {
    update();
    return Promise.resolve();
  }),
}));
vi.mock('../TerminalView', () => ({
  TerminalView: forwardRef(function FakeView(
    {onReady}: {onReady: (s: {cols: number; rows: number}) => void},
    ref: React.Ref<unknown>,
  ) {
    useState(() => ++viewIds);
    useImperativeHandle(ref, () => ({
      write() {},
      writeNotice: (t: string) => notices.push(t),
      focus() {},
      getViewport: () => '',
    }));
    useEffect(() => {
      viewMounts += 1;
      onReady({cols: 80, rows: 24});
      // 只在掛上時叫一次(真的那顆也是)
    }, []);
    return <pre data-testid="xterm" />;
  }),
}));
vi.mock('../FilePanel', () => ({
  FilePanel: ({followPath}: {followPath: string | null}) => {
    lastFollow = followPath;
    return null;
  },
}));
vi.mock('../AiPanel', () => ({AiPanel: () => null}));
vi.mock('../HostStage', () => ({HostStage: () => null}));
vi.mock('../useAskMe', () => ({useAskMe: () => ({quote: () => {}})}));

const {TerminalSession} = await import('../TerminalSession');
const {morph} = await import('../morph');

const HOST = {id: 'main', label: '主機', sub: 'app-server · deploy', via: ''};
const status = (id: string): TerminalStatus =>
  ({type: 'status', state: 'connected', session_id: id, home: '/home/x', label: 'x@ai', max_upload_mb: 10, max_sessions: 4}) as TerminalStatus;
const closedMsg = (message: string): TerminalClosed => ({type: 'closed', reason: 'network', code: 1006, message}) as TerminalClosed;

beforeAll(() => {
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
beforeEach(() => {
  vi.useFakeTimers();
  conns.length = 0;
  notices.length = 0;
  viewMounts = 0;
  viewIds = 0;
  lastFollow = undefined;
  vi.mocked(morph).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(extra: {isFilesOpen?: boolean} = {}) {
  const onConnected = vi.fn();
  const onLiveChange = vi.fn();
  const renderConnecting = vi.fn((isConnected: boolean) => <p data-testid="box">{isConnected ? '打勾' : '轉圈'}</p>);
  render(
    <TerminalSession
      host={HOST}
      hosts={[HOST]}
      userName="me"
      fontSize={14}
      isAiOpen={false}
      onCloseAi={() => {}}
      onOpenAi={() => {}}
      onConnected={onConnected}
      onLiveChange={onLiveChange}
      renderConnecting={renderConnecting}
      isFilesOpen={false}
      {...extra}
    />,
  );
  return {onConnected, onLiveChange, renderConnecting};
}

/** 第一次連上:方框打勾 → 停一下 → 過場 → 終端機 */
function arrive() {
  act(() => conns[0].handlers.onStatus(status('s1')));
  expect(screen.getByTestId('box').textContent).toBe('打勾');
  act(() => vi.advanceTimersByTime(450));
  expect(screen.queryByTestId('box')).toBeNull();
  expect(screen.getByTestId('xterm')).toBeTruthy();
}

describe('TerminalSession 重新連線', () => {
  it('第一次連上走方框那套過場;斷線後重連**不再換回方框、不打勾、不過場**,status 一來直接換上新的終端機', () => {
    const {onConnected, onLiveChange} = setup();
    expect(screen.getByTestId('box').textContent).toBe('轉圈');
    arrive();
    expect(morph).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenLastCalledWith(status('s1'));
    expect(viewMounts).toBe(1);

    act(() => conns[0].handlers.onClosed(closedMsg('網路斷了')));
    expect(onLiveChange).toHaveBeenLastCalledWith(false);
    const oldView = screen.getByTestId('xterm');

    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));
    expect(conns).toHaveLength(2);
    // 撥號中:舊的終端機留在原地(暗著),方框沒有回來
    expect(screen.queryByTestId('box')).toBeNull();
    expect(screen.getByTestId('xterm')).toBe(oldView);

    act(() => conns[1].handlers.onStatus(status('s2')));
    // 沒有 450ms 的停頓,也沒有第二次過場
    expect(morph).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('box')).toBeNull();
    expect(onConnected).toHaveBeenLastCalledWith(status('s2'));
    expect(onLiveChange).toHaveBeenLastCalledWith(true);
    // 新的一條換一顆新的 xterm
    expect(viewMounts).toBe(2);
    expect(screen.queryByRole('button', {name: '重新連線'})).toBeNull();
  });

  it('重連中再按一次 Enter / 鈕不會把撥到一半的那條掐掉重來;重連失敗原因印在舊的終端機上', () => {
    setup();
    arrive();
    act(() => conns[0].handlers.onClosed(closedMsg('網路斷了')));
    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));
    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));
    expect(conns).toHaveLength(2);
    expect(conns[1].close).not.toHaveBeenCalled();

    act(() => conns[1].handlers.onClosed(closedMsg('主機沒有回應')));
    expect(notices.at(-1)).toContain('主機沒有回應');
    expect(screen.queryByTestId('box')).toBeNull();
    // 失敗之後可以再按
    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));
    expect(conns).toHaveLength(3);
  });

  it('從沒掛起終端機就斷的,重連照舊走第一次那套(方框 → 打勾 → 過場)', () => {
    setup();
    act(() => conns[0].handlers.onClosed(closedMsg('連不上')));
    expect(screen.getByText('連不上')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));
    expect(screen.getByTestId('box').textContent).toBe('轉圈');
    act(() => conns[1].handlers.onStatus(status('s1')));
    expect(screen.getByTestId('box').textContent).toBe('打勾');
    act(() => vi.advanceTimersByTime(450));
    expect(morph).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('xterm')).toBeTruthy();
  });

  it('重連撥太久(status、close 都不來):過了連按的那一下再按就重撥 —— 撥到一半那條收掉,它晚到的訊息不理', () => {
    const {onConnected} = setup();
    arrive();
    act(() => conns[0].handlers.onClosed(closedMsg('網路斷了')));
    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));
    expect(conns).toHaveLength(2);

    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));
    expect(conns).toHaveLength(3);
    expect(conns[1].close).toHaveBeenCalled();

    // 被放棄的那一條晚到的 status / close:碰不到畫面
    act(() => conns[1].handlers.onStatus(status('late')));
    act(() => conns[1].handlers.onClosed(closedMsg('晚到的斷線')));
    expect(onConnected).not.toHaveBeenCalledWith(status('late'));
    expect(notices.join('\n')).not.toContain('晚到的斷線');
    expect(viewMounts).toBe(1);

    act(() => conns[2].handlers.onStatus(status('s3')));
    expect(onConnected).toHaveBeenLastCalledWith(status('s3'));
    expect(viewMounts).toBe(2);
  });

  it('重連中、新連線的 status 之前先到的 cwd:不套在舊的那組上,換上新的檔案欄之後才交出去', () => {
    setup({isFilesOpen: true});
    arrive();
    act(() => conns[0].handlers.onCwd('/old'));
    expect(lastFollow).toBe('/old');
    act(() => conns[0].handlers.onClosed(closedMsg('網路斷了')));
    fireEvent.click(screen.getByRole('button', {name: '重新連線'}));

    act(() => conns[1].handlers.onCwd('/new'));
    // 舊的檔案欄沒有跟著跳
    expect(lastFollow).toBe('/old');

    act(() => conns[1].handlers.onStatus(status('s2')));
    expect(lastFollow).toBe('/new');
  });
});
