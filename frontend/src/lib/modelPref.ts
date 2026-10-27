/**
 * 常用模型(個人設定裡的 Default model;沒設過是 Sonnet)。
 *
 * 跟 `theme.ts` / `displayPrefs.ts` 同一套分工:
 *   localStorage 負責「這台電腦開新對話就是這個模型」——
 *   `Chat` 掛載時同步讀得到,不必等 `/api/me` 回來才換掉輸入框上那顆鈕;
 *   伺服器那份負責「換一台電腦也一樣」,登入後 `adoptServerModel()` 採用一次。
 *
 * ⚠️ **不併進 `displayPrefs`**,雖然存的是同一張表、走的是同一支 API:
 * 那個模組的 `apply()` 會把值寫進 CSS(根字級、對比變數),而模型不是畫面設定。
 * 併進去等於每次拉字級拉桿都要跳過一個跟畫面無關的欄位,遲早有人寫錯。
 *
 * ⚠️ **這裡不知道有哪些模型可以選** —— 合法清單是後端 `/api/config` 的
 * `allowed_models`(環境變數決定的)。所以這一支只負責記住字串,
 * 「這個值現在還能不能用」由呼叫端對著 `allowed_models` 判(見 `pickModel`)。
 */
import {useSyncExternalStore} from 'react';

import {readJson, readString, writeJson, writeString} from './safeStorage';

const KEY = 't100_preferred_model';

/**
 * 「這組對話用哪個模型」的表(`conversation_id` → 模型名)。
 *
 * ⚠️ 跟 `t100_preferred_model` **是兩件事**,不要合併:那個是「我習慣用的」,
 * 這個是「這一組我當初特地換過」:對話裡手動切過的模型,重新整理之後還是它;
 * 開新對話才用個人常用。
 *
 * ⚠️ 存本機不存伺服器,跟對話的顏色標記同一條(`components/sidebar-colors.ts`):
 * 後端沒有這個欄位。代價是換一台電腦就回到個人預設 —— 跟顏色標記一樣的代價。
 * 同樣跟顏色標記一樣:**刪掉對話不會清掉這裡的那一筆**(id 不重複,留著不會害到誰)。
 */
const CONVERSATION_KEY = 't100_conversation_models';

/**
 * 沒設過的人用哪一個。
 *
 * ⚠️ **這個預設(sonnet)不是後端的 `default_model`。**
 * 兩者不一樣是刻意的:後端那個是「這台伺服器的預設」,這個是「我個人習慣用的」。
 */
export const PREFERRED_MODEL_DEFAULT = 'sonnet';

let current: string = readString(KEY) || PREFERRED_MODEL_DEFAULT;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/**
 * 顯示用:`sonnet` → `Sonnet`。只動第一個字元,別的大小寫是人家自己的。
 *
 * ⚠️ 放這裡而不是各畫面自己寫一份:個人設定那排 SegmentedControl 與輸入框上
 * 那顆模型鈕印的是**同一組字串**,兩份實作遲早會長得不一樣。
 */
export function modelLabel(model: string): string {
  return model ? model[0].toUpperCase() + model.slice(1) : model;
}

function readConversationModels(): Record<string, string> {
  return (
    readJson<Record<string, string>>(CONVERSATION_KEY, (v) =>
      v && typeof v === 'object' ? (v as Record<string, string>) : null,
    ) ?? {}
  );
}

/** 這組對話當初特地選過的模型。沒選過回 `null` —— 那時候走個人常用。 */
export function conversationModelOf(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  return readConversationModels()[conversationId] ?? null;
}

/**
 * 記下「這組對話用這個」。
 *
 * ⚠️ **新開的對話要等 id 生出來才記得起來** —— 送出前它還沒有 id
 * (`Chat` 在送出的當下才 `newConversationId()`)。所以呼叫端有兩處:
 * 換模型的當下(已經有 id 的話)、以及送出那一刻(補記新對話的)。
 * 少了後者,「開新對話 → 換模型 → 送出 → 重新整理」就會掉回個人預設。
 */
export function rememberConversationModel(conversationId: string, model: string): void {
  writeJson(CONVERSATION_KEY, {...readConversationModels(), [conversationId]: model});
}

/** 使用者在個人設定裡改了。只套本機 —— 送伺服器是呼叫端的事。 */
export function setPreferredModel(model: string): void {
  current = model;
  writeString(KEY, model);
  emit();
}

/**
 * 目前的常用模型,**而且值一變就重畫**。
 *
 * ⚠️ 問答頁一定要走這一支,不要再 export 一支讀 `current` 的 getter:
 * 它是模組層的變數,改它不會讓任何元件重繪 —— 症狀是在個人設定裡把預設模型換掉、
 * 回到問答頁,輸入框上那顆鈕還印著舊的那一個。
 */
export function usePreferredModel(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/**
 * 採用伺服器上那份(`/api/me` 回來時)。
 *
 * ⚠️ **不會再寫回伺服器**,跟 `adoptServerTheme` / `adoptServerPrefs` 同一個坑:
 * 採用之後馬上又 PUT 同一個值回去,每開一次頁面就多一次沒必要的寫入。
 * `null`(沒設過)就不要動本機那份 —— 那表示他從來沒調過。
 */
export function adoptServerModel(model?: string | null): void {
  if (!model || model === current) return;
  current = model;
  writeString(KEY, model);
  emit();
}

/**
 * 這一次要送給後端的模型名字。**純函式**,參數具名、欄位順序就是優先序 —— `preferred` 由呼叫端用
 * `usePreferredModel()` 傳進來,這樣值一變畫面就會跟著重畫。
 *
 * 優先序:**這組對話裡手動選的**(含重新整理之後從 `conversationModelOf()` 讀回來的)
 * → **這個環境的預設**(`knowledge_bases.json` 的 `default_model`,選填)
 * → 個人常用 → 後端的預設。
 *
 * 環境預設排在個人常用**前面**是刻意的:某個環境可以指定比較適合它的模型(例如較快的那一個),
 * 個人常用設成別的模型的人不該因此每次切過去都要手動換。手動換過的對話仍然最優先。
 * 每一階都要通過 `allowed` 白名單才算數 —— 常用模型是存在使用者那邊的字串,
 * 而 `allowed_models` 由伺服器的環境變數決定:模型被下架、或換一台伺服器,
 * localStorage 裡那個值就會變成一個沒有人認得的名字。不過濾的話輸入框上會
 * 印出一個選不到的選項,送出時後端再默默退回預設 —— 使用者看到的跟實際跑的不一樣。
 *
 * 三階都落空(例如 `/api/config` 還沒回來)就回 `null`,呼叫端不送 `model`,
 * 由後端用它自己的預設。
 */
export function pickModel({
  chosen,
  kbDefault,
  preferred,
  serverDefault,
  allowed,
}: {
  /** 這組對話裡手動選的 */
  chosen: string | null;
  /** 這個環境的預設(選填) */
  kbDefault?: string | null;
  /** 個人常用 */
  preferred: string | null | undefined;
  /** 後端的預設 */
  serverDefault: string | undefined;
  /** 白名單(`/api/config` 還沒回來時是 undefined = 不擋) */
  allowed: readonly string[] | undefined;
}): string | null {
  const ok = (m: string | null | undefined): m is string =>
    !!m && (allowed === undefined || allowed.includes(m));
  if (ok(chosen)) return chosen;
  if (ok(kbDefault)) return kbDefault;
  if (ok(preferred)) return preferred;
  if (ok(serverDefault)) return serverDefault;
  return null;
}
