import {useCallback} from 'react';
import {useSearchParams} from 'react-router-dom';

/**
 * 網址參數 + 一次改一格或好幾格的 `patch`。`undefined` / 空字串 = 把那格拿掉(不留 `?q=` 這種空殼)。
 * 用量統計與題目明細兩頁共用,不要各寫一份 URLSearchParams 的 set / delete。
 *
 * ⚠️ `replace: true`:改一次條件就多一筆瀏覽歷史的話,使用者按上一頁會在自己剛試過的幾個條件之間倒著走,
 * 而他要的是「回到上一頁」。
 */
export function useSearchParamsPatch() {
  const [params, setParams] = useSearchParams();
  const patch = useCallback(
    (fields: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(fields)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      setParams(next, {replace: true});
    },
    [params, setParams],
  );
  /** 全部清掉(題目明細的「清除篩選」) */
  const clear = useCallback(() => setParams(new URLSearchParams(), {replace: true}), [setParams]);
  return {params, patch, clear};
}
