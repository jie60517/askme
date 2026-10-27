/**
 * 管理頁的表格外框。
 *
 * 沒有它整張表是浮在頁面上的、沒有外框線,跟上面那塊工具列對不起來。三張表(帳號管理一張、安全兩張)
 * 共用這一份,不要各自寫 `<Card padding={0}><Table …/></Card>`。
 *
 * ⚠️ `padding={0}` 是這個元件存在的理由之一,不要拿掉:表格自己有列距,
 * 再加一圈 Card 的內距會變成雙重留白,而那件事只有並排比較才看得出來
 * —— 三個地方各寫一次就會有一個忘記加。
 */
import type {ReactNode} from 'react';

import {Card} from '@astryxdesign/core/Card';

export function TableCard({children}: {children: ReactNode}) {
  return <Card padding={0}>{children}</Card>;
}
