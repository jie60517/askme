/**
 * 管理頁(用量明細 / 用量統計 / 安全 / 帳號管理)共用的**頁框**。
 *
 * 各頁若各自把 `<Section>` 直接鋪在主內容區上,寬螢幕上標題、控制列、表格
 * 會全部貼著左邊,右半邊是空的。兩件事收在這裡,各頁才不會各漂各的:
 *  1. **置中的內容欄** —— `Center` + `maxWidth`,寬螢幕上不會攤成一整條。
 *  2. **標題列** —— 標題在左、動作在右,每頁同一個位置。
 *
 * ⚠️ **沒有副標**,不要開 `description` prop 留著等人用。帳號管理頁的
 * 「還在用預設密碼」標在每一列上(見 `Users.tsx` 的密碼欄),不在這裡。
 *
 * ⚠️ **這幾頁的內容是繁體中文**,但**側邊欄那幾條連結是英文** —— 邊界就在這裡,
 * 見 `Sidebar.tsx` 的 `ADMIN_LINKS`。
 */
import {useEffect, type ReactNode} from 'react';

import {Center} from '@astryxdesign/core/Center';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Section} from '@astryxdesign/core/Section';
import {Heading} from '@astryxdesign/core/Text';

/**
 * 內容欄的寬度上限。
 *
 * ⚠️ 兩種寬度是**刻意**的,不要統一成一個數字:
 *  - `reading`:一頁裡有大段文字要讀。840 大約是 75 個字元的行長,
 *    再寬就是「一行讀到底要轉頭」的那種寬度。
 *  - `table`:一頁是表格(安全、帳號管理、用量的圖表)。表格欄位多,
 *    窄了會擠成一團;1160 是四到六欄還能各自呼吸的寬度。
 * 兩個值都不是 token —— 設計系統沒有「一頁多寬」這種 token(頁框的寬度
 * 本來就是產品決定的),所以集中在這裡具名,不要散在各頁。
 */
export const ADMIN_WIDTH = {reading: 840, table: 1160} as const;

type Props = {
  title: string;
  /** 標題列右邊那顆(或那幾顆)動作鈕 */
  actions?: ReactNode;
  /** 內容欄的寬度上限,見 ADMIN_WIDTH */
  width?: number;
  children: ReactNode;
};

/**
 * 置中的內容欄(寬度上限見 ADMIN_WIDTH)。AdminPage 的那一欄;別頁要跟管理頁「同寬、同留白」時也用這個,
 * 不要自己再抄一份 Center + Section。
 */
export function AdminColumn({width = ADMIN_WIDTH.table, children}: {width?: number; children: ReactNode}) {
  /*
   * 捲軸出現 / 消失時內容不要左右跳(例如篩選後結果變少、捲軸消失,整張表會往右跳一個捲軸寬)。
   * 主內容區那一層才是捲動的那層,而它是 AppShell 的,
   * 管理頁碰不到它的樣式 —— 只在管理頁掛著時把捲軸位置留著,離開就還原,問答頁不受影響。
   * 跟 global.css 側邊欄那條 `scrollbar-gutter: stable` 同一個結論:恆定的留白比跳動好忍受。
   */
  useEffect(() => {
    const main = document.getElementById('astryx-app-shell-main');
    if (!main) return;
    const before = main.style.scrollbarGutter;
    main.style.scrollbarGutter = 'stable';
    return () => {
      main.style.scrollbarGutter = before;
    };
  }, []);
  return (
    <Center axis="horizontal">
      {/*
        ⚠️ `width="100%"` 一定要給:`Center` 讓子層縮到內容寬,
        少了它整欄會跟著內容忽寬忽窄(換一個分類、表格少一欄就跳一次)。
        maxWidth 才是那條線,width 只是「先撐滿再被 maxWidth 夾住」。
      */}
      <Section width="100%" maxWidth={width}>
        {children}
      </Section>
    </Center>
  );
}

export function AdminPage({
  title,
  actions,
  width = ADMIN_WIDTH.table,
  children,
}: Props) {
  return (
    <AdminColumn width={width}>
        <VStack gap={5}>
          <HStack gap={3} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              <Heading level={1}>{title}</Heading>
            </StackItem>
            {actions ? <Stack>{actions}</Stack> : null}
          </HStack>
          {children}
        </VStack>
    </AdminColumn>
  );
}
