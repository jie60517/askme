/**
 * 最後一道防線(常駐在最外層)。
 *
 * 沒有它的話,任何一個渲染錯誤都會讓 React 把整棵樹卸載 —— 使用者看到的是
 * **全白的畫面**,連「重新整理」都不知道要按哪裡,而且會以為資料不見了
 * (其實只是這一頁畫不出來)。
 *
 * 只擋渲染期間的錯誤:事件處理器與 async 裡丟的例外 React 攔不到,
 * 那些要各自 catch + toast。
 */
import {Component, type ErrorInfo, type ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Center} from '@astryxdesign/core/Center';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';

type Props = {
  children: ReactNode;
};

const styles = stylex.create({
  /*
   * display-1 的大標收一點字距:設計系統給的是 0,
   * 那個字級下英文字母之間看起來是散的。用 `em` 才會跟著字級走,不寫死 px。
   */
  title: {
    letterSpacing: '-0.02em',
  },
});

type State = {
  message: string | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = {message: null};

  static getDerivedStateFromError(error: unknown): State {
    return {message: error instanceof Error ? error.message : String(error)};
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 主控台留一份完整的:畫面上只給人看得懂的那句,堆疊要留給開發者
    console.error('Render failed', error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;

    return (
      <Center axis="both" padding={6}>
        <Card padding={8} width="100%" maxWidth={480}>
          <VStack gap={4} hAlign="stretch">
            <VStack gap={1}>
              <Text type="display-1" as="h1" xstyle={styles.title}>
                This page stopped working
              </Text>
              <Text type="body" color="secondary" size="sm">
                Nothing was lost — your chats are on the server. Reloading usually fixes it.
              </Text>
            </VStack>

            {/* 原始訊息照實給:內部工具的使用者旁邊就坐著會修的人,
                「發生未知錯誤」對他們一點用都沒有 */}
            <Text type="supporting" color="secondary">
              {this.state.message}
            </Text>

            <HStack gap={2} hAlign="end">
              <Button
                label="Try again"
                variant="ghost"
                onClick={() => this.setState({message: null})}
              />
              <Button
                label="Reload"
                variant="primary"
                onClick={() => window.location.reload()}
              />
            </HStack>
          </VStack>
        </Card>
      </Center>
    );
  }
}
