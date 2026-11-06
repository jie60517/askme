/**
 * 一般模式 `/general`:這一題**不帶任何專案**,當一般的 Claude Code 用
 *(顧問或工程師不一定每次都要看專案的東西)。
 *
 * 打 `/general` 進模式,專案那一格換成「一般模式」Token,✕ 離開(`lib/composerMode.ts`)。所有人都能用,能做什麼照角色。
 *
 * 環境代號 `general` 是後端的保留字(`config.GENERAL_KB_ID`),送出時當成 kb 帶過去;
 * 紀錄裡記的也是它,所以從歷史打開一般模式的對話,模式自己就開著(`isGeneralConversation`)。
 */

/** 後端 `config.GENERAL_KB_ID` */
export const GENERAL_KB_ID = 'general';

/** `/` 選單裡的 `/general`(網站內建,不靠伺服器上的 skill) */
export const GENERAL_COMMAND = {name: 'general', summary: '一般模式:不看專案,當一般 Claude Code 用'};

/** 「Answered from …」那行的名字(英文介面) */
export const GENERAL_LABEL = 'General';

/** 輸入框送出的這句是不是 `/general`:開頭是它,後面是空白或結束(`/generalx` 不算)。帶的字就是這一題 */
export function parseGeneralCommand(text: string): {pending: string} | null {
  const m = /^\/general(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? {pending: (m[1] ?? '').trim()} : null;
}

/** 這組對話是不是一般模式的:看最後一題記的環境(同 Chat.tsx 的 conversationKb) */
export function isGeneralConversation(turns: readonly {knowledge_base?: string | null}[]): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const kb = turns[i].knowledge_base;
    if (kb) return kb === GENERAL_KB_ID;
  }
  return false;
}

/**
 * 一般模式開不開:這組對話自己選過的(進 / ✕)優先,沒選過就跟著這組對話上一題。
 */
export function generalActive({
  choice,
  conversationIsGeneral,
}: {
  choice: boolean | null;
  conversationIsGeneral: boolean;
}): boolean {
  return choice ?? conversationIsGeneral;
}

/**
 * 空白頁送出第一句會導到新的對話、整個對話頁重掛:
 * 新掛上來的那一份在第一題的紀錄回來之前,不知道這組是一般模式 —— Token 會先閃回專案再跳回來。
 */
let carried: string | null = null;

export function carryGeneral(to: string): void {
  carried = to;
}

/**
 * 新掛上來的對話頁問一聲(useState 的初始值)。**不在這裡清**:StrictMode 會把初始值函式跑兩次,
 * 第一次清掉的話第二次就拿不到 —— 清在掛上之後(`clearCarriedGeneral`)。
 */
export function isCarriedGeneral(key: string): boolean {
  return carried === key;
}

export function clearCarriedGeneral(key: string): void {
  if (carried === key) carried = null;
}
