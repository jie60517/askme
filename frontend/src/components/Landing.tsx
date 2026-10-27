/**
 * 「Hi, X / Where should we start?」那塊招呼(new chat 的起手式)。
 *
 * ⚠️ **兩個地方共用同一份**:對話頁的空白狀態,與終端機右邊的 AskME。
 * 各寫一份的話很快就會長得不一樣,看起來像兩個不同的產品。
 *
 * 抽出來放這裡而不是從 `pages/Chat.tsx` 匯出:那個檔案很大,
 * 誰 import 它誰就把整組對話頁一起拉進來(見 frontend/.claude/CLAUDE.md —— 連測試都不能碰)。
 */
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';

import {Logo} from './Logo';
import {personName} from '../lib/people';

/** 招呼語旁邊那顆 logo 的大小(px)。 */
const LOGO_PX = 20;

type Props = {
  /** 顯示用的人名;沒有就只寫 `Hi` */
  name?: string;
  /**
   * 最大寬度。對話頁給 `LANDING_WIDTH`(720);AskME 那一欄只有 ~380px,
   * 不給就是跟著欄寬走(`display-2` 會自己折行,跟對話頁在窄視窗時一樣)。
   */
  maxWidth?: number;
};

export function Landing({name, maxWidth}: Props) {
  return (
    <VStack gap={6} width="100%" maxWidth={maxWidth}>
      <VStack gap={1}>
        <HStack gap={2} vAlign="center">
          <Logo size={LOGO_PX} />
          <Text type="large" as="h2">
            {name ? `Hi, ${personName(name)}` : 'Hi'}
          </Text>
        </HStack>
        <Text type="display-2" as="h1">
          Where should we start?
        </Text>
      </VStack>
    </VStack>
  );
}
