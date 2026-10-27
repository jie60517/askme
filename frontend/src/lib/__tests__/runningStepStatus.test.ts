/**
 * 進行中那一題,執行過程每一步的狀態(lib/runs.ts 的 runningStepStatus)。
 *
 * 後端會送工具真正的耗時(source_duration)。釘的是:平行呼叫時,
 * 結果還沒回來的那一步不能因為「後面有下一步」就先標成完成;沒有 toolUseId 的舊紀錄照舊推斷。
 */
import {describe, expect, it} from 'vitest';

import {runningStepStatus} from '../runs';

describe('runningStepStatus', () => {
  it('結果回來了就是完成,不管是不是最後一步', () => {
    expect(runningStepStatus({toolUseId: 't1', durationMs: 280}, false)).toBe('complete');
    expect(runningStepStatus({toolUseId: 't1', durationMs: 280}, true)).toBe('complete');
  });

  it('新後端:結果還沒回來就是還在跑,後面有下一步也一樣(平行呼叫)', () => {
    expect(runningStepStatus({toolUseId: 't1'}, false)).toBe('running');
    expect(runningStepStatus({toolUseId: 't1'}, true)).toBe('running');
  });

  it('舊後端(沒有 toolUseId):照舊用「後面有下一步」推斷', () => {
    expect(runningStepStatus({toolUseId: null}, false)).toBe('complete');
    expect(runningStepStatus({toolUseId: null}, true)).toBe('running');
  });

  it('整題失敗:最後一步是失敗的那一步,沒回來的其他步不留轉圈', () => {
    expect(runningStepStatus({toolUseId: 't2'}, true, '逾時')).toBe('error');
    expect(runningStepStatus({toolUseId: 't1'}, false, '逾時')).toBe('complete');
  });
});
