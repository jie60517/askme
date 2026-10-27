/**
 * 匯出成 Markdown。
 *
 * **參考來源一定要一起寫進去** —— 沒有來源的答案沒辦法判斷可不可信,
 * 而匯出的檔案通常是拿去給別人看的那一份。
 * 知識庫版本也要寫、而且寫顯示名稱:同一個問題在不同版本的
 * 程式碼上答案不一樣,只寫 id 的話收到檔案的人看不出那是哪一版。
 */
import {getConversationTurns, parseSources} from './chatApi';

import {describeKnowledgeBase, knowledgeBaseLabels} from './knowledgeBase';
// 「哪些工具算讀取」的唯一來源在 lib/tools.ts ——
// 這裡跟小夥伴那邊各抄一份 Set 的話,後端加工具就會漏
import {isReadTool} from './tools';

/** 檔名不能有這些字(Windows) */
const UNSAFE_FILENAME_CHARS = /[\/:*?"<>|]/g;

export type ExportableConversation = {
  conversation_id: string;
  title: string;
};

export async function exportConversation(c: ExportableConversation): Promise<void> {
  const [turns, labels] = await Promise.all([
    getConversationTurns(c.conversation_id),
    knowledgeBaseLabels(),
  ]);

  const lines = [`# ${c.title}`, ''];
  for (const turn of turns) {
    lines.push(`## ${turn.question}`, '');
    lines.push(`_Answered from: ${describeKnowledgeBase(turn.knowledge_base, labels)}_`, '');
    lines.push(turn.success ? turn.answer : `> ${turn.error ?? 'Query failed.'}`, '');

    /*
     * 匯出的「Sources」只列**讀取類**的步驟(見 lib/tools.ts 的 isReadTool)。
     * record.sources 存的是**全部**執行過程(Write/WebSearch 也在,
     * 不然答完之後畫面上的時間軸會整段消失)—— 但匯出這一節的語意是
     * 「這個回答讀了哪些程式碼」,寫檔與查網頁不是依據,列進來會稀釋。
     */
    const sources = parseSources(turn.sources).filter((s) => isReadTool(s.tool));
    if (sources.length > 0) {
      lines.push('### Sources', '');
      for (const s of sources) lines.push(`- \`${s.tool}\` ${s.target}`);
      lines.push('');
    }
  }

  const blob = new Blob([lines.join('\n')], {type: 'text/markdown;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${c.title.replace(UNSAFE_FILENAME_CHARS, '_')}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
