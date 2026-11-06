/**
 * 權限清單:角色設定框與「某某的職稱」框共用。
 *
 * 側邊欄那幾項在上、不在側邊欄的功能在下,中間一條線;每一項是帶圖示的勾選框(圖示跟側邊欄同一組)。
 * SSH Server 底下是 Work Flow:縮排,上層沒勾就是灰的。
 *
 * `base` 有給(個人框)時,跟它(角色的值)不同的那幾項旁邊標「個人」。
 * `limit` 有給(有 Users 權限的一般帳號在操作)時,自己沒有的那幾項是灰的(給不出自己沒有的權限)。
 *
 * ⚠️ 不放說明文字(使用者:畫面上不要放說明);「個人」是狀態,不是說明。
 */
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Token} from '@astryxdesign/core/Token';
import {
  BarChart3,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Users as UsersIcon,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import {parentAllows, pinPerms, type PermFlag, type Perms} from '../lib/adminApi';

type Flag = {key: PermFlag; label: string; icon: LucideIcon};

const SSH: Flag = {key: 'ssh', label: 'SSH Server', icon: SquareTerminal};
/** SSH Server 底下(要 SSH Server 才能勾,`parentAllows`) */
const SSH_CHILDREN: Flag[] = [{key: 'workflow', label: 'Work Flow', icon: Workflow}];
/** 管理頁:名字、圖示、順序都照側邊欄 */
const ADMIN_FLAGS: Flag[] = [
  {key: 'usage', label: 'Usage', icon: BarChart3},
  {key: 'security', label: 'Security', icon: ShieldCheck},
  {key: 'users', label: 'Users', icon: UsersIcon},
];
/** 不在側邊欄、但有分人的功能 */
const FEATURE_FLAGS: Flag[] = [{key: 'ai_exec', label: 'AI 可執行指令', icon: Terminal}];

/** 稽核 / 提示用的名字(跟這份清單同一組字) */
export const PERM_LABELS: Record<PermFlag, string> = Object.fromEntries(
  [SSH, ...SSH_CHILDREN, ...ADMIN_FLAGS, ...FEATURE_FLAGS].map((f) => [f.key, f.label]),
) as Record<PermFlag, string>;

/** 個人加減的一行摘要:「+ Usage、− AI 可執行指令」(帳號表上「個人」的提示) */
export function describeOwn(own: Partial<Perms>): string {
  return (Object.keys(own) as PermFlag[]).map((k) => `${own[k] ? '+' : '−'} ${PERM_LABELS[k]}`).join('、');
}

export function PermList({
  value,
  onChange,
  base,
  limit,
}: {
  value: Perms;
  onChange: (next: Perms) => void;
  base?: Perms;
  limit?: Perms;
}) {
  const own = (k: PermFlag) => (base && base[k] !== value[k] ? <Token label="個人" size="sm" /> : null);
  // 有 limit 時(有 Users 權限的一般帳號):自己沒有的權限一律鎖住 —— 後端連「收回」都擋
  // (一個權限小的人不能動權限比他大的人),畫面上留著能勾只會送出才 403
  const locked = (k: PermFlag) => !!limit && !limit[k];
  const set = (next: Perms) => onChange(pinPerms(next));
  const flag = (f: Flag) => (
    <HStack key={f.key} gap={2} vAlign="center">
      <CheckboxInput
        label={f.label}
        labelIcon={f.icon}
        size="sm"
        value={value[f.key]}
        isDisabled={!parentAllows(f.key, value) || locked(f.key)}
        onChange={(checked) => set({...value, [f.key]: checked})}
      />
      {own(f.key)}
    </HStack>
  );
  return (
    <VStack gap={2}>
      {flag(SSH)}
      <VStack gap={2} paddingInline={6}>
        {SSH_CHILDREN.map(flag)}
      </VStack>
      {ADMIN_FLAGS.map(flag)}
      <Divider />
      {FEATURE_FLAGS.map(flag)}
    </VStack>
  );
}
