import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  dismissNotice,
  getNotices,
  pauseNotice,
  MAX_NOTICES,
  NOTICE_EXIT_MS,
  resetNoticesForTest,
  resumeNotice,
  setWindowAway,
  showNotice,
  toastError,
  toastInfo,
  toastNotice,
  toastWithAction,
} from '../toast';

beforeEach(() => {
  vi.useFakeTimers();
  resetNoticesForTest();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('全站提示的佇列', () => {
  it('三種顏色:完成綠勾、失敗紅叉、告知藍 i', () => {
    toastInfo('Answer copied.');
    toastError('Could not rename this chat.');
    toastNotice('正在復原…');
    expect(getNotices().map((n) => n.kind)).toEqual(['success', 'error', 'info']);
  });

  it('完成 5 秒後先退場、淡完才拿掉', () => {
    toastInfo('Answer copied.');
    vi.advanceTimersByTime(4999);
    expect(getNotices()[0].isLeaving).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(getNotices()[0].isLeaving).toBe(true);
    vi.advanceTimersByTime(NOTICE_EXIT_MS);
    expect(getNotices()).toHaveLength(0);
  });

  it('失敗不會自己消失,要按 × 才收', () => {
    toastError('Could not rename this chat.');
    vi.advanceTimersByTime(60_000);
    expect(getNotices()).toHaveLength(1);
    expect(getNotices()[0].isPersistent).toBe(true);
    dismissNotice(getNotices()[0].id);
    vi.advanceTimersByTime(NOTICE_EXIT_MS);
    expect(getNotices()).toHaveLength(0);
  });

  it('同一個 uniqueID 是原地換掉,不疊兩則,倒數重來', () => {
    toastWithAction('已改為不參考:3 支程式', {label: '復原', onClick: () => {}}, 'programs');
    const id = getNotices()[0].id;
    vi.advanceTimersByTime(7000);
    toastNotice('正在復原…', 'programs');
    expect(getNotices()).toHaveLength(1);
    expect(getNotices()[0]).toMatchObject({id, kind: 'info', text: '正在復原…', action: undefined});
    vi.advanceTimersByTime(4999);
    expect(getNotices()[0].isLeaving).toBeFalsy();
  });

  it('換成失敗那一則就不再自己消失', () => {
    toastNotice('正在復原…', 'programs');
    toastError('復原失敗', 'programs');
    vi.advanceTimersByTime(60_000);
    expect(getNotices()).toHaveLength(1);
    expect(getNotices()[0].kind).toBe('error');
  });

  it('collision ignore:已經有那一則就不再發(有新版本只講一次)', () => {
    showNotice({text: '有新版本', kind: 'info', autoHideMs: null, uniqueID: 'app-update', collision: 'ignore'});
    showNotice({text: '有新版本', kind: 'info', autoHideMs: null, uniqueID: 'app-update', collision: 'ignore'});
    expect(getNotices()).toHaveLength(1);
  });

  it('指標停在卡上時暫停倒數,離開後接著倒', () => {
    toastWithAction('Deleted "a".', {label: 'Undo', onClick: () => {}}, 'note-deleted-1');
    const id = getNotices()[0].id;
    vi.advanceTimersByTime(3000);
    pauseNotice(id);
    vi.advanceTimersByTime(60_000);
    expect(getNotices()[0].isLeaving).toBeFalsy();
    resumeNotice(id);
    vi.advanceTimersByTime(4999);
    expect(getNotices()[0].isLeaving).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(getNotices()[0].isLeaving).toBe(true);
  });
  it('視窗切走時暫停倒數,回來接著倒(設計系統 Toast 原本的行為)', () => {
    toastInfo('Answer copied.');
    vi.advanceTimersByTime(2000);
    setWindowAway(true);
    vi.advanceTimersByTime(60_000);
    expect(getNotices()[0].isLeaving).toBeFalsy();
    setWindowAway(false);
    vi.advanceTimersByTime(2999);
    expect(getNotices()[0].isLeaving).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(getNotices()[0].isLeaving).toBe(true);
  });

  it('指標停在卡上時被同一個 uniqueID 換掉,照樣暫停,不會在指標底下被收走', () => {
    toastWithAction('已改為不參考:3 支程式', {label: '復原', onClick: () => {}}, 'programs');
    const id = getNotices()[0].id;
    pauseNotice(id);
    toastInfo('已復原', 'programs');
    vi.advanceTimersByTime(60_000);
    expect(getNotices()[0]).toMatchObject({id, text: '已復原'});
    expect(getNotices()[0].isLeaving).toBeFalsy();
    resumeNotice(id);
    vi.advanceTimersByTime(5000);
    expect(getNotices()[0].isLeaving).toBe(true);
  });

  it('最多 5 則:多出來的擠掉最舊的那則會自己消失的,失敗的留著', () => {
    toastError('失敗一');
    for (let i = 1; i <= MAX_NOTICES; i++) toastInfo(`完成${i}`);
    const live = getNotices().filter((n) => !n.isLeaving);
    expect(live).toHaveLength(MAX_NOTICES);
    expect(live.map((n) => n.text)).toEqual(['失敗一', '完成2', '完成3', '完成4', '完成5']);
  });
});
