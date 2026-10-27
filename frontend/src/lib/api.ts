/**
 * API 客戶端。
 *
 * baseURL 來自 VITE_API_BASE,通常留空走相對路徑:正式部署時前後端同一個 uvicorn,
 * 開發時由 vite 的 proxy 轉 `/api`(見 vite.config.ts)。
 */
import axios from 'axios';

import {clearToken, getToken} from './auth';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '',
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * /api/login 的 401 是「帳號密碼錯」,不是「token 過期」。
 * 讓攔截器清 token 的話,登入失敗會順手把上一個 session 洗掉。
 *
 * `/api/login/mfa` 同理:那裡的 401 是「驗證碼打錯」或「這次登入逾時」,
 * 兩種都跟現有的 token 無關。漏掉它的話,在別的分頁登著的人只要在這一頁
 * 打錯一次驗證碼,那邊就被登出了。
 */
function isLoginRequest(url?: string): boolean {
  const path = url?.replace(/\?.*$/, '');
  return !!path && (path.endsWith('/api/login') || path.endsWith('/api/login/mfa'));
}

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error.response?.status;
    if (status === 401 && !isLoginRequest(error.config?.url)) clearToken();
    return Promise.reject(error);
  },
);
