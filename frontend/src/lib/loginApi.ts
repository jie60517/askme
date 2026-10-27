/**
 * 登入 / 登出 / 改密碼。
 */
import axios from 'axios';

import {api} from './api';
import {clearToken} from './auth';
import type {ShapeId} from '../pet/bloub/skins';
import type {BlobColor, Companion} from './companionPref';
import {resetConversationsCache} from './conversationsApi';
import {resetPeopleDirectory} from './peopleDirectory';
import {clearDrafts} from './noteDraft';

export type LoginResponse = {
  token: string;
  username: string;
  display_name?: string;
  is_admin: boolean;
  password_is_default: boolean;
  theme?: 'light' | 'dark' | null;
};

/**
 * 密碼過了,但這個帳號還要第二道關卡。
 *
 * ⚠️ **`mfa_token` 不是 token**,它只能拿去 `/api/login/mfa` 換一張真的。
 * 欄位名字刻意跟 `LoginResponse.token` 不同,`isChallenge` 也在型別層把兩者分開
 * —— 混用等於整道關卡被繞過,而畫面上完全看不出來。
 */
export type LoginChallenge = {
  mfa_required: true;
  mfa_token: string;
  username: string;
};

export type LoginResult = LoginResponse | LoginChallenge;

/** 這次登入還沒完 —— 要再輸入一組驗證碼。 */
export function isChallenge(result: LoginResult): result is LoginChallenge {
  return (result as LoginChallenge).mfa_required === true;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const res = await api.post<LoginResult>('/api/login', {username, password});
  return res.data;
}

/** 登入第二關。`code` 是手機驗證器 App 上那組 6 位數。 */
export async function verifyMfa(mfaToken: string, code: string): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>('/api/login/mfa', {
    mfa_token: mfaToken,
    code,
  });
  return res.data;
}

export async function changePassword(current: string, next: string): Promise<void> {
  await api.post('/api/password', {current_password: current, new_password: next});
}

/**
 * 存字級與對比。**在放開拉桿時呼叫,不要在拖的過程中呼叫** ——
 * 拖一次會觸發幾十個事件,每個都送等於對伺服器連打。
 * 畫面本身在拖的當下就已經跟著動了(`setDisplayPrefs` 直接套本機)。
 */
export async function saveDisplayPrefs(fontScale: number, contrast: number): Promise<void> {
  await api.put('/api/me/prefs', {font_scale: fontScale, contrast});
}

/**
 * 存常用模型。跟字級走**同一支 API**(同一張 `user_prefs`),只是分開兩支函式 ——
 * 拉桿那支一秒會被呼叫好幾次,把模型併進去等於每拉一下就重寫一次模型欄位。
 *
 * 失敗靜默(同步偏好是加值功能)。本機那份在按下去的當下
 * 就已經生效了(`setPreferredModel`),沒存到伺服器只影響「換一台電腦」。
 */
export async function savePreferredModel(model: string): Promise<void> {
  try {
    await api.put('/api/me/prefs', {preferred_model: model});
  } catch {
    // 忽略
  }
}

/**
 * 存吉祥物。同一支 API、分開一支函式,理由同 `savePreferredModel`;失敗一樣靜默 ——
 * 本機那份按下去就生效了(`setCompanion`),沒存到只影響「換一台電腦」。
 */
export async function saveCompanion(companion: Companion): Promise<void> {
  try {
    await api.put('/api/me/prefs', {companion});
  } catch {
    // 忽略
  }
}

/** Bloub 的型態 / 顏色。只帶有變的那一項;失敗靜默,理由同 `saveCompanion`。 */
export async function saveBlobLook(look: {shape?: ShapeId; color?: BlobColor}): Promise<void> {
  try {
    await api.put('/api/me/prefs', {companion_shape: look.shape, companion_color: look.color});
  } catch {
    // 忽略
  }
}

/**
 * 換頭像。`null` = 拿掉,回到名字縮寫。
 *
 * ⚠️ 這一支的錯誤**要讓呼叫端看得到**(不像主題/字級那兩支是靜默的):
 * 使用者剛挑了一張圖,默默失敗會讓他以為換好了,下次登入才發現沒有。
 */
export async function saveAvatar(dataUri: string | null): Promise<void> {
  await api.put('/api/me/avatar', {avatar: dataUri});
}

export async function logout(): Promise<void> {
  await api.post('/api/logout');
}

/**
 * 登出:打 API,然後**不論成功失敗都清掉本地 token**。
 *
 * 失敗也要清:不清的話,連不到伺服器的人就永遠登不出去
 * (強制改密碼那一頁更嚴重 —— 他會卡在那一頁出不來)。
 */
export async function signOut(): Promise<void> {
  try {
    await logout();
  } catch {
    // 伺服器那端的 token 撤銷失敗,只能等它自己過期
  }
  clearToken();
  /*
   * ⚠️ 名冊與對話清單都放在**模組層**,而登出不重新整理頁面 —— 不清的話,同一個
   * 分頁換一個人登入時看到的是**上一個人的**名冊 / 對話標題
   * (見 `resetPeopleDirectory`、`resetConversationsCache`;個人筆記的草稿 `clearDrafts`)。
   * 清 token 跟清這些快取是同一件事的幾半,要放在一起,不要分開。
   * **之後再加任何模組層的個人資料,這裡也要跟著加一行。**
   */
  resetPeopleDirectory();
  resetConversationsCache();
  clearDrafts();
}

/**
 * 錯誤訊息要分得出原因。
 *
 * 一律顯示「帳號或密碼錯誤」會讓拿著正確密碼的人一直重打 ——
 * 連不到伺服器跟打錯密碼是兩件完全不同的事,使用者的下一步也不一樣。
 */
export function describeLoginError(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'Sign-in failed. Please try again.';

  const response = error.response;
  if (!response) return 'Cannot reach the server. Check your connection and try again.';
  if (response.status === 401) return 'Wrong username or password.';
  // 429 的訊息是後端算好的(還要等多久),直接用它的。
  if (response.status === 429) {
    return detailOf(response) ?? 'Too many attempts. Please wait a moment and try again.';
  }
  return `The server responded with ${response.status}.`;
}

/**
 * 改密碼的錯誤跟登入的錯誤**不是同一組**。
 *
 * 這裡沒有「帳號打錯」這種事(人已經登入了),400 才是「目前的密碼不正確」、
 * 「新密碼太短」、「不能用預設密碼」。沿用 describeLoginError 的話,
 * 打錯目前密碼會顯示「Wrong username or password.」—— 他會去懷疑自己的帳號。
 * 後端那幾條訊息都寫得比前端猜的準,有 detail 就直接用它的。
 */
export function describePasswordError(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'Could not change your password. Please try again.';

  const response = error.response;
  if (!response) return 'Cannot reach the server. Check your connection and try again.';

  const detail = detailOf(response);
  if (detail) return detail;
  if (response.status === 400) return 'Your current password is not correct.';
  if (response.status === 401) return 'Your session expired. Sign in again.';
  return `The server responded with ${response.status}.`;
}

function detailOf(response: {data?: unknown}): string | undefined {
  const detail = (response.data as {detail?: unknown} | undefined)?.detail;
  return typeof detail === 'string' && detail ? detail : undefined;
}
