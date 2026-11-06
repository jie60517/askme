/**
 * 個人設定的「卡片 + 列」—— 照 Astryx 0.7.8 settings-dialog 範本的 `SettingsCard` / `SettingsRow`。
 * `AccountSettingsDialog` 與 `CompanionLook` 共用。
 *
 * 跟範本不一樣的只有一件:**沒有 description**(畫面上不放說明文字)。
 * 每一列一定有圖示(範本的理由:有的有、有的沒有,名稱就不在同一條線上)。
 * 圖示用 Lucide(佈景內建那套,範本示範用的是 heroicons)。
 */
import {Children, isValidElement, type ReactNode} from 'react';

import {Card} from '@astryxdesign/core/Card';
import {Divider} from '@astryxdesign/core/Divider';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import * as stylex from '@stylexjs/stylex';
import type {LucideIcon} from 'lucide-react';

/** 列量寬度的那一欄(container query 的名字) */
const PANEL_CONTAINER = 'settings-panel';
/**
 * 整區所有列在同一個寬度一起從兩欄變一欄(範本:一列一列各自換行看起來像壞掉)。
 * 量的是**內容欄**的寬,不是視窗 —— 手機寬時左欄不見了,內容欄反而比較寬。
 */
const ROW_STACK = `@container ${PANEL_CONTAINER} (max-width: 480px)`;
/** 這塊表面唯一的內距:spacing 4 = 16px */
export const ROW_PADDING = 4;
/** 一列裡的拉桿 / 輸入框都用這個寬,控制項才排成一直欄 */
export const CONTROL_WIDTH = 192;

const rowStyles = stylex.create({
  /** 內容欄:列靠它量寬度(見 `ROW_STACK`)。掛在每一區內容的最外層 */
  panel: {containerType: 'inline-size', containerName: PANEL_CONTAINER},
  line: {
    display: 'flex',
    flexDirection: {default: 'row', [ROW_STACK]: 'column'},
    alignItems: {default: 'center', [ROW_STACK]: 'stretch'},
    gap: {default: 'var(--spacing-3)', [ROW_STACK]: 'var(--spacing-2)'},
  },
  /**
   * 控制項不縮(會縮的話 SegmentedControl 把最長的字擠成兩行);
   * 疊成一欄時維持自己的寬度,開關、按鈕不會被拉滿整列。
   */
  control: {flexShrink: 0, alignItems: 'flex-start'},
});

export const settingsPanelStyle = rowStyles.panel;

/** 一組設定:灰底圓角卡片,列與列之間一條淡線。`title` 是卡片上面那行小字(可省) */
export function SettingsCard({title, children}: {title?: string; children: ReactNode}) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <VStack gap={1.5}>
      {title != null && (
        <Text type="supporting" weight="semibold" color="secondary">
          {title}
        </Text>
      )}
      <Card padding={0} width="100%" variant="muted">
        <VStack as="ul" role="list" gap={0}>
          {/* key 用 Children.toArray 給的(照原本的位置,前面有一列沒畫也不會讓後面整列重掛) */}
          {rows.map((r, i) => (
            <VStack key={isValidElement(r) && r.key != null ? r.key : i} as="li" gap={0}>
              {i > 0 && <Divider variant="subtle" />}
              {r}
            </VStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}

/**
 * 一個設定:圖示 + 名稱在左、控制項在右;內容欄窄的時候控制項排到名稱底下。
 * 控制項要給 `isLabelHidden` —— 這一列就是它看得見的標籤,不藏的話名稱畫兩次。
 * `detail` 是放不進右邊的東西(預覽、展開的表單),畫在這一列自己的框裡。
 */
export function SettingsRow({
  title,
  icon,
  control,
  detail,
}: {
  title: string;
  icon: LucideIcon;
  control?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <VStack padding={ROW_PADDING} gap={2}>
      <Stack xstyle={rowStyles.line}>
        <StackItem size="fill">
          <HStack gap={2} align="start">
            {/* 往下 2px:字的大寫高度在行框裡偏低,框對框對齊會讓圖示看起來偏高(範本的註解) */}
            <VStack paddingBlockStart={0.5}>
              <Icon icon={icon} size="sm" color="secondary" />
            </VStack>
            {/* 範本這裡還有一行說明(所以包一層、限寬 420);我們不放說明,只剩名稱 */}
            <Text type="label">{title}</Text>
          </HStack>
        </StackItem>
        {control != null && <VStack xstyle={rowStyles.control}>{control}</VStack>}
      </Stack>
      {detail}
    </VStack>
  );
}
