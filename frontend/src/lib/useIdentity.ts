/**
 * 目前登入的人。
 *
 * 一定要跟伺服器確認,不能只看本地有沒有 token:token 會過期、服務重啟時全部失效。
 * 只看本地的話畫面顯示「已登入」,問題其實進了公開池。
 */
import {createContext, useCallback, useContext, useEffect, useState} from 'react';

import {api} from './api';
import {
  dropTokenSilently,
  getToken,
  IDENTITY_CHANGED,
  requestSessionHandoff,
} from './auth';

export type Me = {
  username: string;
  display_name?: string;
  is_admin: boolean;
  password_is_default: boolean;
  theme?: 'light' | 'dark' | null;
  // ── 個人顯示設定。null/undefined 一律是「沒設過」 ──
  /** 頭像的 data URI。沒設過就顯示名字縮寫 */
  avatar?: string | null;
  font_scale?: number | null;
  contrast?: number | null;
  /** 常用模型。沒設過就用 `lib/modelPref.ts` 的預設(sonnet) */
  preferred_model?: string | null;
  /** 右下角的吉祥物('classic' / 'blob')。沒設過就是 classic,見 `lib/companionPref.ts` */
  companion?: string | null;
  /** Bloub 的型態 / 顏色。沒設過是圓形 + auto,見 `lib/companionPref.ts` */
  companion_shape?: string | null;
  companion_color?: string | null;
  /** 工程師 / 管理員,而且 SSH 終端機有開(後端 `can_use_terminal`)。Work Flow 能不能用看它;真正的擋在後端。 */
  can_terminal?: boolean;
  /**
   * Work Flow 開了沒(後端 `workflows.available`):部署的人放了 `workflow_actions.json`,而且 SSH 終端機有開。
   * 關著:側邊欄沒有 Work Flow、`/workflow` 是 NotFound、`/api/workflows` 一律 404。
   */
  workflow_enabled?: boolean;
  /**
   * `/ssh` 能不能用(後端 `auth.ssh_mode`):`full` = 工程師 / 管理員,而且功能有開。
   * 空字串 / 沒給 = 側邊欄沒有 SSH Server。真正的擋在後端。
   */
  ssh_mode?: '' | 'full';
  /**
   * 個人筆記開了沒(後端 `NOTEBOOK_ENABLED`,預設開)。
   * 關著:側邊欄沒有 Notes、`/notes` 回首頁、對話裡沒有存筆記的鈕。後端那組 API 也是 404。
   */
  can_notebook?: boolean;
};

export function useIdentity() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      /*
       * 本地沒有 token **不代表沒登入**:token 現在存 sessionStorage(關掉瀏覽器
       * 就要重新登入,見 auth.ts),而 sessionStorage 是每個分頁各自一份 ——
       * 「在新分頁開啟連結」一開始一定是空的。
       *
       * 所以先跟還開著的分頁要一份,**要不到才算沒登入**。
       * 少了這個 await,每次開新分頁都會先閃一下登入頁。
       */
      const handedOver = await requestSessionHandoff();
      if (!handedOver) {
        setMe(null);
        setLoading(false);
        return;
      }
    }
    try {
      const res = await api.get<Me>('/api/me');
      /*
       * ⚠️ **`/api/me` 對沒登入的人回的是 200 加 `username: null`,不是 401**
       * (它刻意不擋 —— 擋了登入頁自己也會 401,繞不出來)。
       *
       * 所以「token 失效」這件事**不會走到下面的 catch**。只看 catch 的話,
       * 手上那張失效的 token 永遠不會被丟掉:每次重新整理都再送一次、
       * 每次都拿到 username null,而跨分頁交接還會把它傳給新分頁。
       */
      if (!res.data.username) {
        dropTokenSilently();
        setMe(null);
        return;
      }
      setMe(res.data);
    } catch {
      // 連不到、或真的 401 → 直接移除,不走 clearToken(避免多一次廣播)。
      dropTokenSilently();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const on = () => {
      setLoading(true);
      void refresh();
    };
    window.addEventListener(IDENTITY_CHANGED, on);
    return () => window.removeEventListener(IDENTITY_CHANGED, on);
  }, [refresh]);

  return {me, loading, refresh};
}

const MeContext = createContext<Me | null>(null);

/** 已登入那一層(`App.tsx` 的 Chrome)掛一次,底下的畫面用 `useMe()` 拿,不必再打一次 `/api/me`。 */
export const MeProvider = MeContext.Provider;

/**
 * 目前登入的人。**只能在 Chrome 底下用** —— App 只在 `me` 非 null 時才掛 Chrome,
 * 所以這裡拿到的一定有值;拿不到就是掛錯層,直接丟錯比回 null 讓每個呼叫端都 `?.` 好。
 */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe() must be used under <MeProvider>');
  return me;
}
