/**
 * 資料夾圖示挑選器,長在右鍵選單裡。
 *
 * 收合時只有一排 5 個 + 一顆「⋯」,不寫名字 —— 名字佔的寬度是圖示的好幾倍,
 * 而且要挑圖示的人是用看的不是用讀的。展開後是完整的格子。
 *
 * ContextMenu 只在「點到選單外面」或 Esc 時關閉(看過它的原始碼),
 * 所以在這裡面按「⋯」展開不會把選單收掉。
 *
 * 筆記頁左側清單的右鍵也用這一個(`icons` 換成筆記的圖示),圖示與顏色的按鈕跟主側欄一樣。
 */
import {useState} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Grid} from '@astryxdesign/core/Grid';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {useDropdownMenuContext} from '@astryxdesign/core/DropdownMenu';
import {MoreHorizontal, type LucideIcon} from 'lucide-react';

import {FOLDER_ICONS, QUICK_ICON_COUNT} from './folder-icons';
import {PICKER_SWATCH} from './pickerSwatch';

const styles = stylex.create({
  /**
   * 展開後的圖示格子最高多少。
   * 這是「大概五排」量出來的高度,設計系統沒有對應的 token;
   * Stack 也只開放 minHeight,所以走 xstyle。
   */
  iconScroll: {maxHeight: 220},
});

/** 一個可以挑的圖示。`label` 是報讀程式念的名字,沒給就念 key */
export type PickerIcon = {key: string; icon: LucideIcon; label?: string};

type Props = {
  /** 目前選的 key */
  value: string | undefined;
  onPick: (key: string) => void;
  /** 可以挑的圖示,前 `QUICK_ICON_COUNT` 個是收合時那一排。預設是資料夾那一組 */
  icons?: readonly PickerIcon[];
};

export function FolderIconPicker({value, onPick, icons = FOLDER_ICONS}: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const quick = icons.slice(0, QUICK_ICON_COUNT);
  /**
   * 挑完就把選單關掉。
   *
   * 不要用**合成一發 Escape** 來關 —— 那是在賭選單有在 document 上聽 Escape,
   * 而且會把整頁其他聽 Escape 的東西一起打到。走設計系統公開的出口
   *(`ContextMenu` 與 `DropdownMenu` 都會把這個 context 傳下來)。
   *
   * ⚠️ 只有「挑了一個圖示」才關。按「⋯」展開更多圖示**不能**關。
   */
  const closeMenu = useDropdownMenuContext()?.closeMenu;

  const pick = (key: string) => {
    onPick(key);
    closeMenu?.();
  };

  return (
    <VStack gap={1}>
      <HStack gap={0.5} vAlign="center">
        {quick.map(({key, icon: Glyph, label}) => (
          <IconButton
            key={key}
            label={label ?? key}
            icon={<Icon icon={Glyph} size="sm" />}
            size="sm"
            // 選中是圖示外面一圈,不是底色(見 pickerSwatch.ts)
            variant="ghost"
            aria-pressed={value === key}
            onClick={() => pick(key)}
            {...PICKER_SWATCH}
          />
        ))}
        <IconButton
          label={isExpanded ? 'Fewer icons' : 'More icons'}
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
          <Text type="supporting">{`${icons.length} icons`}</Text>
          {/* 高度夾住並自己捲動 —— 130 個圖示不夾的話選單會長到畫面外。
              data-icon-grid 給 global.css 認:展開時要把**選單面板**的 300px
              上限放寬,不然面板自己也長出一條捲軸,
              右側多出一條 10px 的死區,漂浮框看起來就是「右邊沒填滿」。 */}
          <Stack isScrollable xstyle={styles.iconScroll} {...{'data-icon-grid': ''}}>
            <Grid columns={8} gap={0.5}>
              {icons.map(({key, icon: Glyph, label}) => (
                <IconButton
                  key={key}
                  label={label ?? key}
                  icon={<Icon icon={Glyph} size="sm" />}
                  size="sm"
                  variant="ghost"
                  aria-pressed={value === key}
                  onClick={() => pick(key)}
                  {...PICKER_SWATCH}
                />
              ))}
            </Grid>
          </Stack>
        </VStack>
      ) : null}
    </VStack>
  );
}
