/**
 * 右側的檔案預覽側欄。
 *
 * 這是設計系統 `ai-chat` 範本的 artifact 面板:聊天欄留在左邊繼續看得到,
 * 產出的檔案在右邊一塊可以拉寬的欄位裡打開 —— 對照著問下一題的時候,
 * 全螢幕的燈箱會把上下文整個蓋掉,而這正是「產出一份文件」那類問題的常態。
 *
 * ⚠️ 內容本身共用 `FileLightbox` 匯出的 `Preview`(圖片 / PDF / Office 抽文字 /
 * 純文字四種模式)。兩邊各刻一份的話,PDF 的框、文字的截斷、
 * 二進位的保險一定會分岔。
 *
 * ⚠️ 手機不走這條:寬度不夠再切一欄。呼叫端在斷點以下改開全螢幕的燈箱
 * ——範本自己也是這樣分的(`openArtifact` 量 root 寬度決定開側欄還是 Dialog)。
 */
import {useCallback, useState} from 'react';
import {ChevronLeft, ChevronRight, Download, X} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {Toolbar} from '@astryxdesign/core/Toolbar';
import {Icon} from '@astryxdesign/core/Icon';

import {ModeIcon, Preview} from './FileLightbox';
import {useDialogExit} from './useDialogExit';
import type {LightboxItem} from '../lib/lightboxItem';

/**
 * 預設寬度用**百分比**:固定 px 在窄一點的視窗上會把聊天欄壓扁
 * (1014 寬的視窗配固定 520,聊天欄只剩 188px),而這個面板的重點
 * 正是「聊天欄還看得到」。
 */
export const PANEL_DEFAULT_WIDTH = '45%';
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 900;

/**
 * 比這個窄就不切兩欄,改開全螢幕燈箱。
 * ⚠️ 這不是「手機斷點」—— 側邊欄本身就吃掉 305px,所以門檻要比 768 高得多。
 */
export const PANEL_BREAKPOINT = '(max-width: 1099px)';

/**
 * 從右緣滑進來。`100%` 是面板自己的寬度 —— 面板寬度是使用者拉出來的,
 * 寫死 px 在任何一個寬度上都會錯。
 * 時間取 `--duration-medium`(300ms):抽屜類的動畫落在 200–500ms,
 * 而左邊側邊欄的開合正好也是這個值 —— 同一份版面的兩端要一致。
 *
 * ⚠️ 進場用 `animation` **不是 `transition`**(同 `global.css` 手機抽屜那段):
 * 從 `display: none` 底下現身的元素 transition 補不了幀(`@starting-style` 也無效)。
 */
const PANEL_IN = stylex.keyframes({
  from: {opacity: 0, transform: 'translateX(100%)'},
  to: {opacity: 1, transform: 'translateX(0)'},
});

const PANEL_IN_REDUCED = stylex.keyframes({
  from: {opacity: 0},
  to: {opacity: 1},
});

const styles = stylex.create({
  panel: {
    animationName: {
      default: PANEL_IN,
      '@media (prefers-reduced-motion: reduce)': PANEL_IN_REDUCED,
    },
    animationDuration: 'var(--duration-medium)',
    animationTimingFunction: 'var(--ease-standard)',
    /*
     * 退場(見 `panelLeaving`)的 transition 也要寫在**平常的樣子**上:
     * 退場演到一半又被叫回來(`cancelClose`)時,用的是「新樣式」的 transition ——
     * 這裡沒寫的話會一格跳回原位,寫了才會從當下那一幀反向滑回來。
     * 平常沒有任何東西在動 opacity / transform,所以它只在退場前後起作用。
     */
    transition: {
      default:
        'opacity var(--duration-fast-max) var(--ease-standard), transform var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'opacity var(--duration-fast-max) var(--ease-standard)',
    },
  },
  /**
   * 退場:滑回右緣 + 淡出(不能進場有動畫、關掉卻硬切)。
   *
   * ⚠️ 時間是 `--duration-fast-max`(165ms)= `DIALOG_EXIT_MS`,**要跟那個數一致** ——
   * 這邊是「關掉之前畫什麼」,`useDialogExit` 是「什麼時候真的卸載」,對不上就會中途被切斷。
   * 比進場的 300ms 短:收掉是系統回應,不留戀(同 `growShell` 收起那一半)。
   *
   * ⚠️ 退場用 **transition 不是 keyframes**:進場的 `animation-name` 不能換掉
   * (換掉再換回來會重播一次進場),而 transition 疊在 animation 上面 ——
   * 進場演到一半就關,也是從當下那一幀開始退,不會先跳回定位。
   * reduced-motion 只淡出,不位移(跟 `PANEL_IN_REDUCED` 一樣)。
   */
  panelLeaving: {
    opacity: 0,
    transform: {
      default: 'translateX(100%)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    // 退場那 165ms 裡不再接受點擊(關閉鈕連點、點到正在滑走的上一張 / 下一張)
    pointerEvents: 'none',
    /*
     * ⚠️ **欄寬也要一起收到 0**:只滑走面板的話,它那一欄
     * (整整一個面板寬)還留在版面裡變成一塊空白,卸載那一格聊天欄再一口氣變寬 ——
     * 硬切只是從開頭搬到結尾。寬度本身由呼叫端改成 0(見 `style`),這裡給它過場。
     *
     * ⚠️ 這裡**刻意 tween 版面屬性**(`width`),違反「只動 transform 與 opacity」那條通則:
     * 要的就是聊天欄**真的**跟著變寬,transform 假裝不了(同 `Chat.tsx` 的 `growShell`)。
     * 關預覽是偶爾才做的一下,每幀重排 165ms 可以接受;拖寬度的過程**不能**有這條
     * transition(會拖泥帶水地跟在游標後面),所以它只寫在退場這一層,不寫在 `panel` 上。
     * 代價:退場演到一半被叫回來時,寬度一格跳回原寬(透明度與位移仍然從當下反向)。
     *
     * reduced-motion:不位移,寬度在淡出演完那一刻才收(`0s` + 延遲 165ms)——
     * 一開始就收的話,淡出根本看不到。
     */
    minWidth: 0,
    overflow: 'hidden',
    transition: {
      default:
        'opacity var(--duration-fast-max) var(--ease-standard), transform var(--duration-fast-max) var(--ease-standard), width var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)':
        'opacity var(--duration-fast-max) var(--ease-standard), width 0s linear var(--duration-fast-max)',
    },
  },
});

export type PanelState = {items: LightboxItem[]; index: number};

/**
 * 面板的開 / 關 / 換頁,**連同退場**。
 *
 * 關掉不是當場 `setPanel(null)`:先掛 `isLeaving` 讓面板演 165ms 的退場,
 * 演完才真的卸載。計時與競態直接借 `useDialogExit` —— 它處理過的坑
 * (連按兩下關閉排出兩顆計時器、StrictMode 讓 updater 跑兩次、卸載時收計時器)
 * 這裡一樣會踩,不要自己再刻一份。
 *
 * ⚠️ **退場演到一半又點了一個檔案**:`open` 先 `cancelClose()` 再換內容 ——
 * 不取消的話,那顆計時器會在新內容剛出現時把面板整個關掉。
 * 取消之後 `isLeaving` 當場拿掉,面板從當下那一幀滑回來(見 `styles.panel` 的 transition),
 * 不重播進場(面板沒有卸載過)。
 */
export function useFilePreviewPanel() {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const exit = useDialogExit((open) => {
    if (!open) setPanel(null);
  });
  const {cancelClose, requestClose} = exit;

  const open = useCallback(
    (items: LightboxItem[], index: number) => {
      cancelClose();
      setPanel({items, index});
    },
    [cancelClose],
  );

  const setIndex = useCallback(
    (index: number) => setPanel((prev) => (prev ? {...prev, index} : prev)),
    [],
  );

  return {panel, isLeaving: exit.isLeaving, open, close: requestClose, setIndex};
}

type Props = {
  items: LightboxItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** `useResizable` 給的目前寬度 */
  width: number | string;
  /** 正在演退場(`useFilePreviewPanel` 給的) */
  isLeaving?: boolean;
};

export function FilePreviewPanel({
  items,
  index,
  onIndexChange,
  onClose,
  width,
  isLeaving = false,
}: Props) {
  const item = items[index];

  const step = (delta: number) => onIndexChange((index + delta + items.length) % items.length);

  return (
    <Card
      variant="transparent"
      height="100%"
      /*
       * 進場。切換檔案(`onIndexChange`)與拖寬度都只是重繪,`animation-name`
       * 沒變,所以不會誤觸重播 —— 只有掛載才播。退場是另一條(見 `panelLeaving`)。
       */
      xstyle={[styles.panel, isLeaving && styles.panelLeaving]}
      /*
       * 寬度由 `useResizable` 管;高度撐滿那一欄,內容自己捲。
       * 退場時畫成 0(見 `panelLeaving`)—— 只改**畫出來的**寬,不呼叫 `resize()`:
       * 使用者拉過的寬度留在 `useResizable` 的 state 與 `t100_file_panel` 裡,
       * 下一次打開照舊是那個寬(它不量 DOM,不會把 0 記回去)。
       */
      style={{
        width: isLeaving ? 0 : typeof width === 'number' ? `${width}px` : width,
        flexShrink: 0,
      }}
    >
      <Toolbar
        label="File preview"
        dividers={['bottom']}
        startContent={
          <HStack gap={2} vAlign="center">
            <ModeIcon mode={item.mode} />
            <VStack gap={0}>
              <Text type="label">{item.name}</Text>
              {items.length > 1 ? (
                <Text type="supporting" color="secondary">
                  {index + 1} of {items.length}
                </Text>
              ) : null}
            </VStack>
          </HStack>
        }
        endContent={
          <HStack gap={1} vAlign="center">
            {items.length > 1 ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<Icon icon={ChevronLeft} size="sm" />}
                  label="Previous file"
                  onClick={() => step(-1)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<Icon icon={ChevronRight} size="sm" />}
                  label="Next file"
                  onClick={() => step(1)}
                />
              </>
            ) : null}
            {/* 下載是獨立一顆:看得到不等於拿得到 */}
            <Button
              href={item.downloadUrl}
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<Icon icon={Download} size="sm" />}
              label={`Download ${item.name}`}
              tooltip="Download"
            />
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<Icon icon={X} size="sm" />}
              label="Close preview"
              onClick={onClose}
            />
          </HStack>
        }
      />
      <VStack width="100%" height="100%" isScrollable>
        <Preview item={item} />
      </VStack>
    </Card>
  );
}
