/**
 * 答案的上半段:就是一個 `<Markdown>`。
 *
 * 從 Chat.tsx 抽出來的:那個檔案很大,而且元件測試不能 import 它(見 frontend/.claude/CLAUDE.md)。
 */
import {Markdown} from '@astryxdesign/core/Markdown';

export function AnswerMarkdown({text, isStreaming = false}: {text: string; isStreaming?: boolean}) {
  return <Markdown isStreaming={isStreaming}>{text}</Markdown>;
}
