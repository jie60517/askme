/**
 * 顏色挑選器,長在右鍵選單裡(資料夾是在圖示挑選器的下面)。
 * 資料夾、Personal / Shared、對話列共用同一個;筆記頁左側清單的右鍵也用它,色票、調色盤都一樣
 * (顏色存在筆記的 icon 欄位,見 notes/pageIcons.tsx)。
 * `colors` / `allowCustom` 兩個參數目前沒有人改,預設就是側邊欄那組 + 調色盤。
 *
 * 跟圖示挑選器同一種結構:收合時一排 5 個 + 一顆「⋯」,展開後是完整的格子,
 * 最後一格是調色盤(自己挑一個系統色盤裡沒有的顏色;`allowCustom={false}` 就沒有這一格)。
 * 一排圓點不寫名字 —— 挑顏色的人是用看的。
 */
import {useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Grid} from '@astryxdesign/core/Grid';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {useDropdownMenuContext} from '@astryxdesign/core/DropdownMenu';
import {Ban, Circle, MoreHorizontal, Pipette} from 'lucide-react';

import {
  QUICK_COLOR_COUNT,
  SIDEBAR_COLORS,
  isCustomColor,
  type SidebarColor,
} from './sidebar-colors';
import {PICKER_SWATCH} from './pickerSwatch';

const styles = stylex.create({
  /**
   * 調色盤那一格。
   *
   * `<input type="color">` 是唯一能叫出系統選色器的東西(設計系統沒有這個元件),
   * 但它自己長得很醜 —— 所以把它壓成透明的一層**墊在按鈕底下**:看得到、按得到的是那顆按鈕,
   * 按鈕再叫 `showPicker()` 把系統的調色盤叫出來。
   *
   * ⚠️ 不要把這層**蓋在按鈕上面**接點擊:滑鼠會永遠落在透明的 input 上,
   * 按鈕本身的 hover 底色與按下去的 `scale(0.98)` 都不會發生。
   * input 是 `pointerEvents: 'none'`,事件都落在按鈕上,回饋就是設計系統原本那一套
   * (hover 有沒有包 `(hover: hover) and (pointer: fine)` 跟同一排其他按鈕一致,由設計系統與 global.css 決定)。
   * 還留著整塊大小與位置,是因為系統選色器**跟著 input 的位置**彈出來。
   */
  customWrap: {position: 'relative', display: 'inline-flex'},
  customInput: {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    pointerEvents: 'none',
    // Safari 會給它一個最小尺寸,壓到跟按鈕一樣大
    width: '100%',
    height: '100%',
    padding: 0,
    border: 'none',
  },
});

/**
 * 系統調色盤打開時,還沒挑過顏色的人要從哪一格開始。
 *
 * ⚠️ 寫死色碼是平台逼的:`<input type="color">` 的 `value` **只收 `#rrggbb`**
 * —— 給它 `var(--color-…)` 或 `rgb(…)` 都會被瀏覽器丟掉、退回預設的黑色。
 * 所以這裡不能走 token(專案規則見 `.claude/CLAUDE.md`)。
 *
 * 挑一個中性灰:它不是設計決策,只是「調色盤的起點」——
 * 使用者一動就被自己的選擇取代了。
 *
 * 同類的字面色碼例外還有 `lib/rainbow.ts` 的七個彩虹色與 `favicon.svg`,
 * 各自在原地有理由。
 */
const CUSTOM_PICKER_FALLBACK = '#808080';

type Props = {
  /** 目前選的 key(token 的 key,或 `#rrggbb`) */
  value: string | undefined;
  onPick: (key: string) => void;
  /** 色票,前 `QUICK_COLOR_COUNT` 個是收合時那一排;`value: 'transparent'` 那一格畫禁止符號。預設是側邊欄那一組 */
  colors?: readonly SidebarColor[];
  /** 最後一格的調色盤(自己挑色碼)。預設有 */
  allowCustom?: boolean;
};

function Swatch({
  color,
  label,
  isSelected,
  onPick,
}: {
  color: string;
  label: string;
  isSelected: boolean;
  onPick: () => void;
}) {
  /**
   * 「不指定顏色」那一格畫禁止符號,不是一顆透明的圓:
   * 拿 `transparent` 去填的話那一格看起來是**空的**,
   * 跟「還沒載入」分不出來,更看不出按下去會把顏色拿掉。
   */
  const isNone = color === 'transparent';
  return (
    <IconButton
      label={label}
      icon={
        isNone ? (
          <Icon icon={Ban} size="sm" color="secondary" />
        ) : (
          // 顏色一律走值:`color` 給描邊、`fill` 給填色,兩個指同一個
          <Icon icon={Circle} size="sm" style={{color}} fill={color} />
        )
      }
      size="sm"
      // 選中是圓點外面一圈,不是底色(見 pickerSwatch.ts);aria-pressed 同時給報讀軟體
      // 與 global.css 的外圈
      variant="ghost"
      aria-pressed={isSelected}
      onClick={onPick}
      {...PICKER_SWATCH}
    />
  );
}

export function ColorPicker({value, onPick, colors = SIDEBAR_COLORS, allowCustom = true}: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const quick = colors.slice(0, QUICK_COLOR_COUNT);
  const custom = isCustomColor(value) ? value : CUSTOM_PICKER_FALLBACK;
  /**
   * 挑完就把選單關掉。
   *
   * `ContextMenu` 與 `DropdownMenu` 都會把這個 context 傳下來,所以同一段
   * 在右鍵選單與「⋯」裡都成立。不要靠**合成一發 Escape** 來關 ——
   * 那是在賭選單有在 document 上聽 Escape,而且會把整頁其他聽 Escape 的
   * 東西一起打到。這是設計系統公開的出口(`useDropdownMenuContext`)。
   *
   * ⚠️ 只有「挑了一個顏色」才關。按「⋯」展開更多顏色**不能**關 ——
   * 那是還在挑,不是挑完了。
   */
  const closeMenu = useDropdownMenuContext()?.closeMenu;

  const pick = (key: string) => {
    onPick(key);
    closeMenu?.();
  };

  /** 墊在按鈕底下的那顆 `<input type="color">`(見 `styles.customInput`) */
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * 按鈕 → 系統選色器。
   *
   * 先把焦點交給 input 再開:底下那個「選色器關掉、焦點離開才關選單」的 `onBlur`
   * 靠的是焦點在 input 身上 —— 不先 focus 的話它永遠不會發。
   * `showPicker()` 各家都有了(Chrome 99、Safari 16、Firefox 101),沒有或被擋下來
   * (例如在跨來源 iframe 裡會丟 NotAllowedError)就退回 `click()`,效果一樣是叫出選色器。
   */
  const openPicker = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({preventScroll: true});
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch {
      // 落到下面的 click()
    }
    input.click();
  };

  const customSwatch = (
    <Stack xstyle={styles.customWrap}>
      <IconButton
        label="Custom colour"
        icon={
          // 挑了自訂色就用那個顏色(動態值,Icon 的 color 只收語意色,所以走 style)
          <Icon
            icon={Pipette}
            size="sm"
            color={isCustomColor(value) ? undefined : 'secondary'}
            style={isCustomColor(value) ? {color: value} : undefined}
          />
        }
        size="sm"
        variant="ghost"
        aria-pressed={isCustomColor(value)}
        onClick={openPicker}
        {...PICKER_SWATCH}
      />
      <input
        ref={inputRef}
        type="color"
        aria-label="Custom colour"
        // 按鈕才是那個控制項;input 只是被叫出來的系統選色器,不要再多一個 Tab 停點
        tabIndex={-1}
        value={custom}
        // ⚠️ 這裡**不能**順手關選單:系統選色器是拖著挑的,onChange 在拖曳中
        // 會連續發 —— 一發就關的話,第一次滑到的顏色就被當成答案了。
        // 挑完離開(選色器關掉、焦點回來)才關。
        onChange={(e) => onPick(e.target.value)}
        onBlur={() => closeMenu?.()}
        {...stylex.props(styles.customInput)}
      />
    </Stack>
  );

  return (
    <VStack gap={1}>
      <HStack gap={0.5} vAlign="center">
        {quick.map((c) => (
          <Swatch
            key={c.key}
            color={c.value}
            label={c.label}
            isSelected={value === c.key}
            onPick={() => pick(c.key)}
          />
        ))}
        <IconButton
          label={isExpanded ? 'Fewer colours' : 'More colours'}
          icon={<Icon icon={MoreHorizontal} size="sm" />}
          size="sm"
          // ghost:平常沒有底色(灰底跟選單的漂浮框會變成兩種框)。
          // 展開時 aria-expanded 讓它維持浮起(global.css 的 data-hover-lift 那條)。
          variant="ghost"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((v) => !v)}
          {...PICKER_SWATCH}
        />
      </HStack>

      {isExpanded ? (
        // 展開的那一格從上緣長出來(global.css 的 `[data-picker-more]`);收合直接消失
        <VStack gap={0.5} {...{'data-picker-more': ''}}>
          <Text type="supporting">{`${colors.length} colours`}</Text>
          <Grid columns={5} gap={0.5}>
            {colors.map((c) => (
              <Swatch
                key={c.key}
                color={c.value}
                label={c.label}
                isSelected={value === c.key}
                onPick={() => pick(c.key)}
              />
            ))}
            {/* 最後一格:自己挑 */}
            {allowCustom ? customSwatch : null}
          </Grid>
        </VStack>
      ) : null}
    </VStack>
  );
}
