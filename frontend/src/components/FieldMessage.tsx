/**
 * 欄位底下的訊息框 —— **從 INPUT 框往下長出來的那個樣式**(錯誤 / 提示共用)。
 *
 * 樣子跟登入頁一致,**不要改成 detached 的浮動框**。登入、修改密碼、強制改密碼共用這一份,
 * 各處的錯誤顯示才會長得一樣。
 *
 * 幾何逐項抄設計系統 `FieldStatus` 的 **attached** 變體:負的 marginTop 讓框鑽到欄位**底下**
 * (欄位的 `.astryx-text-input` 自己有 `z-index: 1`,壓在上面),paddingTop 再把字推回可見區,
 * 圓角只留下面兩個 —— 看起來就是「從欄位長出來」。
 *
 * 為什麼不直接用 TextInput 的 `status.message`(它畫的就是 attached):這裡要**最左邊那顆圖示**
 * (✕ / ⓘ),而 `FieldStatus` 的 attached **刻意不畫前導圖示**。所以框自己畫,紅框仍由欄位的
 * `status={{type: 'error'}}` 管(**只給 type 不給 message**,不然設計系統會畫出第二個框)。
 *
 * 用法 —— **一般欄位直接用下面的 `FieldWithMessage`**:
 * ```tsx
 * <FieldWithMessage error={error}>
 *   <TextInput label="IP 位址或網段" … />
 * </FieldWithMessage>
 * ```
 * 自己組(只有登入頁,理由見下面 FieldWithMessage 的說明)時要守兩件事:跟欄位包在**同一個沒有 gap 的 Stack** 裡
 * (外層 VStack 的 gap 會吃掉負的 marginTop,框就接不上欄位),而且那個 Stack 掛 `data-has-field-message`
 * (欄位裡設計系統自己那顆 ⓧ 才會藏掉,不然看到兩顆;規則在 global.css)。
 */
import {cloneElement, type ReactElement, type ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Icon} from '@astryxdesign/core/Icon';
import {HStack, Stack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';

const styles = stylex.create({
  box: {
    marginBlockStart: 'calc(-1 * var(--spacing-1-5))',
    paddingBlockStart: 'calc(var(--spacing-1-5) + var(--spacing-2))',
    paddingBlockEnd: 'var(--spacing-2)',
    paddingInline: 'var(--spacing-2)',
    borderEndStartRadius: 'var(--radius-element)',
    borderEndEndRadius: 'var(--radius-element)',
    fontSize: 'var(--text-supporting-size)',
    lineHeight: 'var(--text-supporting-leading)',
  },
  // 顏色照語意分;兩組 token 分別跟 FieldStatus 的 error 與佈景的 info 同源
  error: {
    backgroundColor: 'var(--color-error-muted)',
    color: 'var(--color-text-red)',
  },
  info: {
    backgroundColor: 'var(--color-background-blue)',
    color: 'var(--color-text-blue)',
  },
  icon: {
    // 圖示對齊第一行的行高中央(照 FieldStatus 的 detachedIcon 的做法)
    display: 'inline-flex',
    alignItems: 'center',
    height: 'calc(var(--text-supporting-size) * var(--text-supporting-leading))',
    flexShrink: 0,
  },
});

/**
 * 「欄位 + 從底下長出來的錯誤框」整組 —— **一般表單欄位一律用這個**,不要再手寫那四樣東西
 * (沒有 gap 的 Stack、記號、欄位的紅框、FieldMessage)。
 *
 * 只吃一個欄位(TextInput / Selector 這種收 `status` 的元件):有錯時幫它加上 `status={{type: 'error'}}`
 * (只給 type 不給 message,理由見上面 FieldMessage 的說明),底下長出錯誤框;欄位裡設計系統自己那顆 ⓧ
 * 由外層的 `data-has-field-message` 藏掉(規則在 global.css)。
 *
 * `role`:送出後才出現的錯誤用預設的 `alert`;打字當下就跳的檢查(太短、兩次不一致)傳 `status`。
 * ⚠️ 它會**蓋掉**子欄位自己給的 `status`(沒錯時寫回 undefined)—— 要 warning 之類別的狀態就不要用這個包。
 *
 * 登入頁那兩格**不用這個**:密碼欄旁邊還有眼睛鈕與 Caps Lock 提示,版面是它自己的;驗證碼那格的錯誤框
 * **不能給 role**(頁尾那個 VisuallyHidden 的 alert 已經在播同一句,給了會唸兩次),而這裡一定會給。
 */
export function FieldWithMessage({
  error,
  role = 'alert',
  children,
}: {
  error: ReactNode;
  role?: 'alert' | 'status';
  children: ReactElement<{status?: {type: 'error'}}>;
}) {
  const hasError = error !== null && error !== undefined && error !== false && error !== '';
  return (
    <Stack {...{'data-has-field-message': ''}}>
      {cloneElement(children, {status: hasError ? {type: 'error'} : undefined})}
      {hasError ? (
        <FieldMessage tone="error" role={role}>
          {error}
        </FieldMessage>
      ) : null}
    </Stack>
  );
}

export function FieldMessage({
  tone,
  role,
  children,
}: {
  tone: 'error' | 'info';
  /**
   * 報讀:送出後的錯誤給 `alert`;打字當下就跳的檢查(太短、兩次不一致)與提示給 `status`,不打斷輸入。
   * **除了下面那個例外,一定要給其中一個** —— 欄位只拿到 `status={{type}}`,設計系統不會把這行字關聯到欄位,
   * 沒有 role 就唸不到原因。
   * ⚠️ 頁面上已經有別的地方在播同一句(登入頁頁尾那個 VisuallyHidden 的 alert)就不要給,不然唸兩次。
   */
  role?: 'alert' | 'status';
  children: ReactNode;
}) {
  return (
    <HStack
      gap={1}
      vAlign="start"
      role={role}
      // 給 global.css 認的記號:欄位聚焦時框要跟著外擴的聚焦框一起變寬(見那條規則)
      {...{'data-field-message': ''}}
      xstyle={[styles.box, tone === 'error' ? styles.error : styles.info]}
    >
      <Stack xstyle={styles.icon}>
        {/* 最左邊圈起來的 ✕ / ⓘ;裝飾用 —— 旁邊的字已把狀態講成文字 */}
        <Icon icon={tone === 'error' ? 'error' : 'info'} size="sm" color="inherit" aria-hidden />
      </Stack>
      <Text type="supporting" color="inherit">
        {children}
      </Text>
    </HStack>
  );
}
