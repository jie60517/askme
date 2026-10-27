/**
 * 版本(知識庫)id → 顯示名稱。
 *
 * 目前只有匯出的 Markdown(`exportConversation`)在用。名稱與「這個版本已經被移除了」
 * 的標法集中在這裡,之後別處要顯示版本名稱就呼叫這裡,不要另寫一份。
 *
 * ⚠️ **不快取**。快取沒有失效機制的話,知識庫改名之後,
 * 整個 session 看到的都會是舊名稱。取名字的場合都是使用者
 * 手動觸發、一天沒幾次的動作,省那一次請求換來一個會過期的名字不划算。
 */
import {getConfig, type AppConfig} from './chatApi';

export type KnowledgeBaseLabels = Map<string, string>;

/** 從 `/api/config` 建一份 id → 顯示名稱。抓不到就回空表,不要讓整件事失敗。 */
export async function knowledgeBaseLabels(): Promise<KnowledgeBaseLabels> {
  try {
    return buildKnowledgeBaseLabels(await getConfig());
  } catch {
    return new Map();
  }
}

/** 從手上的 config 建 id → 顯示名稱(`knowledgeBaseLabels` 抓完 `/api/config` 之後用它)。 */
export function buildKnowledgeBaseLabels(config: AppConfig): KnowledgeBaseLabels {
  return new Map(config.knowledge_bases.map((kb) => [kb.id, kb.label]));
}

/**
 * 這一題是問哪個版本的。
 *
 * 查不到就照實標 `(removed)` —— 版本被移除時假裝它還在,
 * 會讓人拿著一個早就不存在的版本去對答案。
 */
export function describeKnowledgeBase(
  id: string | null | undefined,
  labels: KnowledgeBaseLabels,
): string {
  if (!id) return 'not recorded';
  return labels.get(id) ?? `${id} (removed)`;
}
