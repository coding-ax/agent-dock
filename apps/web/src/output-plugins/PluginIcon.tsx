import {
  BarChart3,
  Bell,
  CheckSquare,
  ClipboardList,
  Download,
  FileDiff,
  FileText,
  MessageCircleQuestion,
  Puzzle,
  ShieldCheck,
  Sparkles,
  Terminal
} from 'lucide-react';
import type { OutputPluginIconName } from '@agent-dock/agent-dock-shared';

/** 将插件元数据声明的语义图标键映射为统一的 Lucide 线性图标。 */
export function PluginIcon({
  name,
  size = 14,
  className
}: {
  name?: OutputPluginIconName;
  size?: number;
  className?: string;
}) {
  switch ((name ?? '').trim().toLowerCase()) {
    case 'message-circle-question':
      return <MessageCircleQuestion size={size} className={className}/>;
    case 'shield-check':
      return <ShieldCheck size={size} className={className}/>;
    case 'check-square':
      return <CheckSquare size={size} className={className}/>;
    case 'clipboard-list':
      return <ClipboardList size={size} className={className}/>;
    case 'file-text':
      return <FileText size={size} className={className}/>;
    case 'sparkles':
      return <Sparkles size={size} className={className}/>;
    case 'bell':
      return <Bell size={size} className={className}/>;
    case 'terminal':
      return <Terminal size={size} className={className}/>;
    case 'git-diff':
      return <FileDiff size={size} className={className}/>;
    case 'download':
      return <Download size={size} className={className}/>;
    case 'bar-chart':
      return <BarChart3 size={size} className={className}/>;
    case 'puzzle':
    default:
      return <Puzzle size={size} className={className}/>;
  }
}
