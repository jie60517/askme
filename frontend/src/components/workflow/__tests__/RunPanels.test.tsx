// @vitest-environment jsdom
/**
 * Work Flow 底部紀錄區(`RunLog` / `RunOutput`)的收合與進場。
 * 測**結構**:收起時內容還掛著(補間才有東西可以縮)、收起的那一層 `inert`(Tab 不會走進看不到的紀錄);
 * `hasEnter={false}`(紀錄 ↔ 輸出互換)不掛進場動畫的 class。動畫本身(時間、曲線、42% 上限)jsdom 量不到,要實機看。
 */
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';

import {RunLog, RunOutput} from '../RunPanels';
import type {RunView} from '../../../lib/workflowApi';

const RUN = {
  id: 7,
  workflow_id: 1,
  status: 'running',
  trigger: 'manual',
  triggered_by: 'amy',
  started_at: '2026-10-07T01:00:00Z',
  finished_at: null,
  stopped_at: '',
  steps: [],
  path: [],
  graph: {nodes: [], edges: []},
  events: [{t: '09:00:01', label: '起點', msg: '開始執行', level: 'info'}],
  events_total: 1,
} as unknown as RunView;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const noop = () => {};
/** 那一行紀錄往上找到第一個 inert 的祖先(沒有 = 看得到、走得進去) */
const inertAncestor = (el: HTMLElement) => el.closest('[inert]');

describe('RunLog 收合', () => {
  it('展開時紀錄不在 inert 裡', () => {
    render(<RunLog run={RUN} reach={1} isCollapsed={false} onToggle={noop} now={Date.now()} />);
    expect(inertAncestor(screen.getByText('開始執行'))).toBeNull();
  });

  it('收起時紀錄仍掛著(不是 display:none 拿掉),但整層 inert', () => {
    render(<RunLog run={RUN} reach={1} isCollapsed onToggle={noop} now={Date.now()} />);
    const line = screen.getByText('開始執行');
    expect(inertAncestor(line)).not.toBeNull();
    // 標題列不在被收起的那一層裡:收合鈕要按得到
    expect(inertAncestor(screen.getByRole('button', {name: '展開執行紀錄'}))).toBeNull();
  });

  it('還沒有要看的那一次:一律收著(inert),即使 isCollapsed 是 false', () => {
    const {container} = render(<RunLog run={null} reach={1} isCollapsed={false} onToggle={noop} now={Date.now()} />);
    expect(container.querySelector('[inert]')).not.toBeNull();
  });
});

describe('RunOutput 收合', () => {
  it('收起 inert、展開不 inert;回到紀錄鈕在標題列,永遠按得到', () => {
    const {rerender} = render(<RunOutput detail={RUN} onBack={noop} isCollapsed onToggle={noop} />);
    const region = screen.getByRole('region', {name: '每一步的輸出'});
    expect(region.querySelector('[inert]')).not.toBeNull();
    expect(inertAncestor(screen.getByRole('button', {name: '回到紀錄'}))).toBeNull();
    rerender(<RunOutput detail={RUN} onBack={noop} isCollapsed={false} onToggle={noop} />);
    expect(screen.getByRole('region', {name: '每一步的輸出'}).querySelector('[inert]')).toBeNull();
  });
});

describe('進場只在第一次出現時播', () => {
  it('hasEnter={false} 的外框 class 跟有進場的不一樣(少了 panelMotion.enter)', () => {
    const {unmount} = render(<RunLog run={RUN} reach={1} isCollapsed={false} onToggle={noop} now={0} />);
    const withEnter = screen.getByRole('region', {name: '執行紀錄'}).className;
    unmount();
    render(<RunLog run={RUN} reach={1} isCollapsed={false} onToggle={noop} now={0} hasEnter={false} />);
    const without = screen.getByRole('region', {name: '執行紀錄'}).className;
    expect(without).not.toBe(withEnter);
    // 少的是 class,不是多:沒有進場的那一份是有進場那一份的子集合
    const all = new Set(withEnter.split(/\s+/));
    expect(without.split(/\s+/).every((c) => all.has(c))).toBe(true);
  });
});
