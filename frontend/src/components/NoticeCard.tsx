/**
 * 提示卡:附件通知(輸入框右邊)與全站提示(視窗右下,`NoticeStack`)**共用這一張**。
 *
 * 長相:白卡、浮起陰影、左邊圖示、灰字。全站提示也用這一張,不要再長出第二種提示的樣子。
 *
 * 右邊的動作鈕(Undo / Open / 復原 / 重新整理)跟 × 都**壓到跟左邊的字同一級**
 * —— 設計系統的小按鈕是 14px 中粗,左邊是 12px 的 supporting,不壓的話字型大小差太多;
 * 卡片也不因為多一顆鈕而變高。
 */
import {useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, StackItem} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {CheckCircle2, Info, X, XCircle} from 'lucide-react';

import type {NoticeAction, NoticeKind} from '../lib/toast';

const styles = stylex.create({
  /**
   * 動作鈕:字跟左邊同一級(`--text-supporting-size` / weight),顏色維持按鈕自己的 primary
   * (比左邊的灰深一階 —— 看得出可以按,但不搶字)。
   * 高度收成一行字高、上下負邊距吃回去:卡片的高度跟沒有鈕的那幾張一樣。
   */
  action: {
    fontSize: 'var(--text-supporting-size)',
    fontWeight: 'var(--text-supporting-weight)',
    lineHeight: 'var(--text-supporting-leading)',
    height: 'auto',
    paddingBlock: 'var(--spacing-0-5)',
    paddingInline: 'var(--spacing-2)',
    marginBlock: 'calc(var(--spacing-0-5) * -1)',
    flexShrink: 0,
  },
  close: {
    width: 'var(--spacing-6)',
    height: 'var(--spacing-6)',
    marginBlock: 'calc(var(--spacing-0-5) * -1)',
    flexShrink: 0,
  },
});

function KindIcon({kind}: {kind: NoticeKind}) {
  if (kind === 'success') return <Icon icon={CheckCircle2} size="sm" color="success" />;
  if (kind === 'error') return <Icon icon={XCircle} size="sm" color="error" />;
  // 藍用 @ token 那組(附件卡「這則會通知誰」最早就是這個藍)
  return <Icon icon={Info} size="sm" style={{color: 'var(--color-text-blue)'}} />;
}

function ActionButton({action}: {action: NoticeAction}) {
  const [isLoading, setIsLoading] = useState(false);
  return (
    <Button
      label={action.label}
      size="sm"
      variant="ghost"
      isLoading={isLoading}
      xstyle={styles.action}
      onClick={() => {
        if (action.showsLoading) setIsLoading(true);
        action.onClick();
      }}
    />
  );
}

export function NoticeCard({
  kind,
  text,
  action,
  onClose,
}: {
  kind: NoticeKind;
  text: string;
  action?: NoticeAction;
  /** 給了才畫 ×(不會自己消失的那幾則) */
  onClose?: () => void;
}) {
  return (
    <Card padding={2} elevation="med">
      <HStack gap={2} vAlign="center">
        <KindIcon kind={kind} />
        <StackItem size="fill">
          <Text type="supporting">{text}</Text>
        </StackItem>
        {/* key = 字:同一個 uniqueID 原地換成別的鈕時重新掛載,轉圈狀態不會帶過去 */}
        {action ? <ActionButton key={action.label} action={action} /> : null}
        {onClose ? (
          <IconButton
            label="Dismiss"
            icon={<Icon icon={X} size="xsm" color="secondary" />}
            size="sm"
            variant="ghost"
            xstyle={styles.close}
            onClick={onClose}
          />
        ) : null}
      </HStack>
    </Card>
  );
}
