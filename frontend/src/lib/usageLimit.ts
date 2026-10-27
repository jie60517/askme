/**
 * Claude 訂閱額度的快照。
 *
 * 「回答完成」之後,小夥伴要再講一句「本次耗用幾 %、剩餘幾 %、幾分鐘後重置」。
 * 資料來源是後端的 `/api/usage-limit`,它自己去問 claude CLI 的 `/usage`
 *(整條的取捨與剖法寫在 `backend/app/usage_limit.py` 的檔頭)。
 *
 * ⚠️ **讀不到是正常的一種結果,不是錯誤。** CLI 升版就可能換掉那段輸出的格式,
 * 後端剖不出來會回 `available: false` —— 那時候這裡回 null,小夥伴就只講
 * 「回答完成」、不講用量。所以這支**不 toast、不丟例外**:
 * 一句附加的話沒講成,不值得在畫面上留一條紅字。
 *
 * ⚠️ `describeUsage` 那句是**小夥伴的台詞**,所以是中文 —— 這是
 * `.claude/CLAUDE.md`「畫面字串一律英文」的例外(小夥伴台詞),那條例外
 * 已經把這個檔列進去了。要改措辭去改那裡的規則,不要在這裡翻成英文。
 */
import {api} from './api';

export type UsageLimit = {
  /** 這個視窗已經用掉幾 %(0~100) */
  used_percent: number;
  /** 還剩幾 %。後端算好的,前端不要自己 100 減 —— 只有一個地方在定義它 */
  remaining_percent: number;
  /** 幾分鐘後重置。CLI 沒講(或講的是絕對時刻)就是 null */
  resets_in_minutes: number | null;
};

type UsageLimitResponse = ({available: true} & UsageLimit) | {available: false};

/**
 * `fresh`:答完那一次要的是**現在**的水位,叫後端不要吃它的 60 秒快取 ——
 * 一題常在 60 秒內答完,送出與答完兩次讀到同一份的話「本次耗用」永遠是 0。
 * 送出那一次不帶(吃快取就好,那只是基準)。
 */
export async function getUsageLimit(options: {fresh?: boolean} = {}): Promise<UsageLimit | null> {
  try {
    const res = await api.get<UsageLimitResponse>('/api/usage-limit', {
      params: options.fresh ? {fresh: 1} : undefined,
    });
    if (!res.data.available) return null;
    const {used_percent, remaining_percent, resets_in_minutes} = res.data;
    return {used_percent, remaining_percent, resets_in_minutes};
  } catch {
    return null;
  }
}

/**
 * 「這一題用了幾 %」= 答完時的用量減送出時的用量。
 *
 * ⚠️ **兩份快照都是前端拿的**(`lib/petSetup.tsx`):只有前端知道每一題的
 * 送出與答完是哪兩個時刻。後端那支只回當下的事實。
 *
 * 回 null 的三種情況,都是「不知道」而不是 0:
 *   - 沒有送出時的基準(那時候讀不到)
 *   - 答完時的用量**比送出時少** —— 5 小時視窗在這一題進行中重置了,
 *     差值是負的,而負的耗用不是一個可以唸的數字
 *   - 兩份都是同一份快取(差 0)是**照講 0**:那是事實(這一題很小),
 *     不是不知道
 */
export function usageDelta(before: number | null, after: number): number | null {
  if (before === null) return null;
  if (after < before) return null;
  return after - before;
}

/**
 * 唸給人聽的那一句。
 *
 * 拆出來是為了測得到(`__tests__/usageLimit.test.ts`),也為了讓「哪一半沒有資料
 * 就少講哪一半」這條規則只有一份:三段各自可能缺,缺了就不要硬湊一個 0 或
 * 「未知」上去 —— 那看起來像數字,但其實是我們不知道。
 *
 * 標點用全形,跟 kit 其餘的台詞(「完成了!」「已停止」)同一套。
 */
export function describeUsage(usage: UsageLimit, deltaPercent: number | null): string {
  const parts: string[] = [];
  if (deltaPercent !== null) parts.push(`本次耗用 ${deltaPercent}%`);
  parts.push(`剩餘 ${usage.remaining_percent}%`);
  if (usage.resets_in_minutes !== null) {
    parts.push(`${formatResetIn(usage.resets_in_minutes)}後重置`);
  }
  return `${parts.join('，')}！`;
}

/** 幾分鐘 → 「45 分鐘」/「2 小時 15 分」。超過一小時只講分鐘會讓人要自己心算。 */
export function formatResetIn(minutes: number): string {
  if (minutes < 60) return `${minutes} 分鐘`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}
