import {useRef} from 'react';

/**
 * 永遠指向最新一次 render 的值的 ref。給 rAF 迴圈、原生事件監聽、包了 memo 的子元件要用的固定函式 ——
 * 它們拿到的是當初那一次的閉包,直接讀 props / state 會讀到舊的。
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
