import {
  Bell,
  Building2,
  Clock,
  Database,
  FileCode,
  GitBranch,
  RefreshCw,
  Server,
  ShieldCheck,
  Unplug,
  type LucideIcon,
} from 'lucide-react';

import type {NodeType} from '../../lib/workflowApi';

/** 每種拼圖的圖示。拼圖盒、畫布、設定面板、執行紀錄共用這一份。 */
export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  start: Server,
  vpn: ShieldCheck,
  ssh: Building2,
  vpnoff: Unplug,
  sync: RefreshCw,
  script: FileCode,
  backup: Database,
  cond: GitBranch,
  wait: Clock,
  notify: Bell,
};
