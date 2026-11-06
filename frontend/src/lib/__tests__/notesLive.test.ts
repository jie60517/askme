/**
 * 對話頁的即時推送線(`lib/notesLive.ts`)。
 *
 * 要守的:
 *  - 連上先送 auth;`ready` 與 `notes` 都要叫 onChange(`ready` 補斷線期間錯過的推送)。
 *  - 斷線就重連,間隔一次比一次長;`ready` 之後重新從最短的算。
 *  - 4401 / 4403 / 4404 不重連(重連也只會再被關一次,白白每 30 秒打一次伺服器)。
 *  - 收掉之後不再重連。
 */
import {describe, expect, it, vi} from 'vitest';

import {RETRY_MS, watchConversationNotes} from '../notesLive';

type Listener = (e: unknown) => void;

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closedWith: number | null = null;
  private listeners: Record<string, Listener[]> = {};
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code: number) {
    this.closedWith = code;
  }
  emit(type: string, e: unknown = {}) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
}

function setup() {
  FakeSocket.all = [];
  const timers: Array<{fn: () => void; ms: number}> = [];
  const onChange = vi.fn();
  const stop = watchConversationNotes('abc', onChange, {
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    url: (path) => `ws://host${path}`,
    token: () => 'tok',
    setTimeout: (fn, ms) => {
      timers.push({fn, ms});
      return timers.length;
    },
    clearTimeout: () => {},
  });
  const last = () => FakeSocket.all[FakeSocket.all.length - 1];
  return {onChange, stop, timers, last};
}

describe('watchConversationNotes', () => {
  it('authenticates on open and refetches on ready and on notes', () => {
    const {onChange, last} = setup();
    expect(last().url).toBe('ws://host/api/conversations/abc/live');
    last().emit('open');
    expect(JSON.parse(last().sent[0])).toEqual({type: 'auth', token: 'tok'});
    last().emit('message', {data: '{"type":"ready"}'});
    last().emit('message', {data: '{"type":"ping"}'});
    last().emit('message', {data: '{"type":"notes"}'});
    last().emit('message', {data: 'not json'});
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reconnects with growing delays and resets after ready', () => {
    const {timers, last} = setup();
    last().emit('close', {code: 1006});
    last().emit('close', {code: 1006});
    expect(timers.map((t) => t.ms)).toEqual([RETRY_MS[0], RETRY_MS[1]]);

    timers[1].fn();
    expect(FakeSocket.all).toHaveLength(2);
    last().emit('message', {data: '{"type":"ready"}'});
    last().emit('close', {code: 1006});
    expect(timers[2].ms).toBe(RETRY_MS[0]);
  });

  it.each([4401, 4403, 4404])('does not reconnect after close code %i', (code) => {
    const {timers, last} = setup();
    last().emit('close', {code});
    expect(timers).toHaveLength(0);
  });

  it('stops for good when the page closes the watch', () => {
    const {stop, timers, last} = setup();
    const sock = last();
    stop();
    expect(sock.closedWith).toBe(1000);
    sock.emit('close', {code: 1000});
    expect(timers).toHaveLength(0);
  });
});
