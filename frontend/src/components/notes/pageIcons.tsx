/**
 * 頁面圖示與提示框的圖示。不用 emoji。
 * 只用設計系統那套線條圖示(Astryx 的圖示就是 Lucide),一律次要文字色。
 *
 * 存的是圖示的名字(`user_notes.icon`,後端上限 32 字;下面每個名字都在 16 字內),可以帶顏色記號:`名字:顏色`(`Star:blue-soft`,顏色是主側欄的 key,見下面 parseIcon 那段)。
 * 不在這張表裡的值(例如 emoji)→ 當作沒選,畫預設的頁面圖示。
 */
import {useState, type ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Grid} from '@astryxdesign/core/Grid';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Stack} from '@astryxdesign/core/Layout';
import {Popover} from '@astryxdesign/core/Popover';
import {
  Archive,
  BookOpen,
  Bookmark,
  Bug,
  Building2,
  CalendarDays,
  ChartColumn,
  CircleCheck,
  CircleDollarSign,
  ClipboardList,
  Clock,
  CodeXml,
  Database,
  Factory,
  FileText,
  Flag,
  Folder,
  Globe,
  GraduationCap,
  Info,
  Key,
  Lightbulb,
  Link,
  ListChecks,
  Lock,
  Mail,
  MapPin,
  MessageSquare,
  Package,
  Phone,
  Receipt,
  Rocket,
  Server,
  Settings,
  ShoppingCart,
  Star,
  Target,
  Terminal,
  TriangleAlert,
  Truck,
  User,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type {PickerIcon} from '../FolderIconPicker';
import {PICKER_SWATCH} from '../pickerSwatch';
import {hasColor, isCustomColor} from '../sidebar-colors';

/**
 * 可以選的圖示:元件、中文名(頁面裡提示框的選圖示面板,筆記頁內容是中文)、英文名(左側清單右鍵那一排,左側清單是英文)。
 * 名字是報讀程式念的、滑過的提示。**加一個圖示只改這一張。**
 */
export const PAGE_ICONS: Record<string, {icon: LucideIcon; label: string; labelEn: string}> = {
  FileText: {icon: FileText, label: '文件', labelEn: 'Document'},
  Folder: {icon: Folder, label: '資料夾', labelEn: 'Folder'},
  BookOpen: {icon: BookOpen, label: '書', labelEn: 'Book'},
  ClipboardList: {icon: ClipboardList, label: '清單板', labelEn: 'Clipboard'},
  ListChecks: {icon: ListChecks, label: '待辦', labelEn: 'Checklist'},
  CircleCheck: {icon: CircleCheck, label: '完成', labelEn: 'Done'},
  CalendarDays: {icon: CalendarDays, label: '日曆', labelEn: 'Calendar'},
  Clock: {icon: Clock, label: '時鐘', labelEn: 'Clock'},
  Flag: {icon: Flag, label: '旗子', labelEn: 'Flag'},
  Star: {icon: Star, label: '星星', labelEn: 'Star'},
  Bookmark: {icon: Bookmark, label: '書籤', labelEn: 'Bookmark'},
  Target: {icon: Target, label: '目標', labelEn: 'Target'},
  Lightbulb: {icon: Lightbulb, label: '燈泡', labelEn: 'Idea'},
  Info: {icon: Info, label: '資訊', labelEn: 'Info'},
  TriangleAlert: {icon: TriangleAlert, label: '警告', labelEn: 'Warning'},
  Bug: {icon: Bug, label: '問題', labelEn: 'Bug'},
  Wrench: {icon: Wrench, label: '扳手', labelEn: 'Wrench'},
  Settings: {icon: Settings, label: '設定', labelEn: 'Settings'},
  Rocket: {icon: Rocket, label: '火箭', labelEn: 'Rocket'},
  Zap: {icon: Zap, label: '閃電', labelEn: 'Lightning'},
  ChartColumn: {icon: ChartColumn, label: '圖表', labelEn: 'Chart'},
  Database: {icon: Database, label: '資料庫', labelEn: 'Database'},
  Server: {icon: Server, label: '主機', labelEn: 'Server'},
  Terminal: {icon: Terminal, label: '終端機', labelEn: 'Terminal'},
  CodeXml: {icon: CodeXml, label: '程式碼', labelEn: 'Code'},
  Users: {icon: Users, label: '團隊', labelEn: 'Team'},
  User: {icon: User, label: '個人', labelEn: 'Person'},
  Building2: {icon: Building2, label: '公司', labelEn: 'Company'},
  Factory: {icon: Factory, label: '工廠', labelEn: 'Factory'},
  Truck: {icon: Truck, label: '物流', labelEn: 'Shipping'},
  Package: {icon: Package, label: '包裹', labelEn: 'Package'},
  ShoppingCart: {icon: ShoppingCart, label: '採購', labelEn: 'Purchasing'},
  Receipt: {icon: Receipt, label: '單據', labelEn: 'Receipt'},
  CircleDollarSign: {icon: CircleDollarSign, label: '金額', labelEn: 'Amount'},
  Mail: {icon: Mail, label: '信件', labelEn: 'Mail'},
  MessageSquare: {icon: MessageSquare, label: '對話', labelEn: 'Chat'},
  Phone: {icon: Phone, label: '電話', labelEn: 'Phone'},
  Link: {icon: Link, label: '連結', labelEn: 'Link'},
  Lock: {icon: Lock, label: '鎖', labelEn: 'Lock'},
  Key: {icon: Key, label: '鑰匙', labelEn: 'Key'},
  Globe: {icon: Globe, label: '網路', labelEn: 'Web'},
  MapPin: {icon: MapPin, label: '地點', labelEn: 'Location'},
  GraduationCap: {icon: GraduationCap, label: '教育訓練', labelEn: 'Training'},
  Archive: {icon: Archive, label: '封存', labelEn: 'Archive'},
};

/**
 * 顏色**是記號,不是圖示的顏色**:色票、挑法、畫法都跟主側欄的對話列一樣 ——
 * `sidebar-colors.ts` 那一組(19 格 + 調色盤),選了就在那一列最右邊畫一顆點(`ColorTag`),圖示維持次要文字色。
 *
 * 存的是主側欄的顏色 key(`red-soft`、`blue`…)或自訂色碼(`#rrggbb`)。
 * 也可能是文字色票的名字(`red` / `blue` / `gray`…,較早的資料):除了 `gray` 都剛好是主側欄「深色那一階」的 key,
 * 照樣有效;`gray` 主側欄沒有,當作沒選(不用遷移)。
 *
 * 存的那一格 → 名字、顏色 key(`Star:blue-soft`;只選了顏色是 `:blue-soft`);不認得的顏色當作沒選。
 * 自訂色只認完整的 `#rrggbb`(調色盤只會給這種)—— 主側欄的 `hasColor` 只看開頭是不是 `#`。
 */
export function parseIcon(value: string | null | undefined): {name: string | null; color: string | null} {
  if (!value) return {name: null, color: null};
  const [name, color] = value.split(':');
  const ok = isCustomColor(color) ? /^#[0-9a-f]{6}$/i.test(color) : hasColor(color);
  return {name: name || null, color: ok ? (color as string) : null};
}

/** 名字、顏色 → 存的那一格;只有顏色沒有圖示也存(`:blue-soft`:清單上畫點、頁面裡不畫大圖示) */
export function formatIcon(name: string | null, color: string | null): string | null {
  if (!name && !color) return null;
  return color ? `${name ?? ''}:${color}` : name;
}

/** 存的名字 → 圖示;沒選、只有顏色、或是不認得的值(例如 emoji)→ null */
export function iconOf(value: string | null | undefined): LucideIcon | null {
  const {name} = parseIcon(value);
  return (name && Object.prototype.hasOwnProperty.call(PAGE_ICONS, name) && PAGE_ICONS[name].icon) || null;
}

/** 清單、麵包屑、子頁連結那個小圖示:選了就畫那個,沒選就是頁面圖示;一律次要文字色(顏色畫在列右邊的點上) */
export function PageIcon({icon}: {icon: string | null | undefined}) {
  return <Icon icon={iconOf(icon) ?? FileText} size="sm" color="secondary" />;
}

const styles = stylex.create({
  pad: {padding: 'var(--spacing-2)'},
});

/**
 * 左側清單右鍵選單裡那兩排(圖示、顏色)—— 元件跟主側欄資料夾的右鍵**同一套**
 * (`FolderIconPicker` / `ColorPicker`:收合一排 5 個 + 「⋯」展開完整格子,選中外面一圈)。
 * 顏色那一排直接用 ColorPicker 的預設色票(主側欄那組)。
 */
/** 第一格(預設的頁面圖示):選它 = 沒有圖示,見 NoteTree 的 NoteAppearancePickers */
export const NO_ICON_KEY = 'FileText';
export const NOTE_PICKER_ICONS: PickerIcon[] = Object.entries(PAGE_ICONS).map(([key, {icon, labelEn}]) => ({key, icon, label: labelEn}));

/** 選一個圖示(提示框;頁面圖示改在左側清單的右鍵選,見 NOTE_PICKER_ICONS):Popover + 一格一格的 ghost 鈕 */
export function IconPicker({
  children,
  label,
  onPick,
  onRemove,
  isOpen,
  onOpenChange,
}: {
  /** 觸發的那顆鈕(要含 <button>) */
  children: ReactNode;
  label: string;
  onPick: (name: string) => void;
  /** 有的話最下面多一顆「移除」 */
  onRemove?: () => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const open = isOpen ?? inner;
  const setOpen = onOpenChange ?? setInner;
  return (
    <Popover
      label={label}
      isOpen={open}
      onOpenChange={setOpen}
      width={9 * 36 + 16}
      content={
        <Stack xstyle={styles.pad} gap={2}>
          <Grid columns={9} gap={0}>
            {Object.entries(PAGE_ICONS).map(([name, {icon, label}]) => (
              <IconButton
                key={name}
                label={label}
                size="sm"
                variant="ghost"
                icon={<Icon icon={icon} size="sm" color="secondary" />}
                onClick={() => {
                  onPick(name);
                  setOpen(false);
                }}
                {...PICKER_SWATCH}
              />
            ))}
          </Grid>
          {onRemove ? (
            <Button
              label="移除"
              size="sm"
              variant="ghost"
              onClick={() => {
                onRemove();
                setOpen(false);
              }}
            />
          ) : null}
        </Stack>
      }
    >
      {children}
    </Popover>
  );
}
