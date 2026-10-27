/**
 * loading / failed / data 三態。
 * catch 不清空既有資料 —— 重抓失敗時畫面上原本讀到一半的東西不該消失。
 * fetcher 一定要用 useCallback 包,否則每次重繪都重抓。
 */
import {useCallback, useEffect, useState} from 'react';

export type AsyncData<T> = {
  data: T | undefined;
  loading: boolean;
  failed: boolean;
  /** 最近一次失敗丟出來的東西(成功就清掉)。要把原因顯示給人看的頁面用 errorMessage() 讀它 */
  error: unknown;
  reload: () => void;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
};

export function useAsyncData<T>(fetcher: () => Promise<T>): AsyncData<T> {
  const [data, setDataState] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetcher().then(
      (value) => {
        if (!alive) return;
        setDataState(value);
        setFailed(false);
        setError(undefined);
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        // 失敗不清 data:重抓失敗時畫面不該整個變空。
        setFailed(true);
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [fetcher, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (updater: T | ((prev: T | undefined) => T)) =>
      setDataState((prev) =>
        typeof updater === 'function' ? (updater as (p: T | undefined) => T)(prev) : updater,
      ),
    [],
  );

  return {data, loading, failed, error, reload, setData};
}
