// @vitest-environment jsdom
/**
 * 用量頁最上面的「正在執行」(pages/Stats.tsx 的 RunningPanel)。
 *
 * 它會長出來、收回去(不是瞬間掛上 / 拔掉,底下整頁才不會跟著跳)。
 * 這裡釘住的是**「沒人跑整區不渲染」** —— 收回去的那 165ms 裡還掛著(inert),
 * 演完就整個拔掉,不是收成一個零高的空殼留在頁面上。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';

const getRunningQuestions = vi.fn();
vi.mock('../../lib/adminApi', async () => {
  const actual = await vi.importActual<typeof import('../../lib/adminApi')>('../../lib/adminApi');
  return {...actual, getRunningQuestions: () => getRunningQuestions()};
});

const {RunningPanel} = await import('../Stats');

const RUN = {
  run_id: 'r1',
  conversation_id: 'c1',
  question: '登入流程的 token 是在哪裡刷新的?',
  owner: 'alice',
  knowledge_base: null,
  elapsed_ms: 12_000,
};

/** 推進假時鐘,順便把中間的 promise 與 React 的更新都清掉 */
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  getRunningQuestions.mockReset();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('正在執行', () => {
  it('沒人跑不渲染;有人跑長出來;跑完先收回去(inert)再整個拔掉', async () => {
    getRunningQuestions.mockResolvedValue([]);
    const {container} = render(<RunningPanel />);
    await advance(50);
    expect(container.innerHTML).toBe('');

    // 有人送出:下一次輪詢讀到 → 掛上,先收著(inert)畫一幀,下一幀才打開
    getRunningQuestions.mockResolvedValue([RUN]);
    await advance(5_000);
    const question = screen.getByText(RUN.question);
    await advance(50);
    expect(question.closest('[inert]')).toBeNull();

    // 跑完:收回去那段時間內容還在(留住最後一份),但鍵盤 / 讀屏進不去
    getRunningQuestions.mockResolvedValue([]);
    await advance(5_000);
    expect(screen.getByText(RUN.question).closest('[inert]')).not.toBeNull();

    // 演完就整區拔掉 —— 「沒人跑整區不渲染」
    await advance(200);
    expect(container.innerHTML).toBe('');
  }, 30_000);
});
