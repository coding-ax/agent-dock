import type { Locale } from '@agent-dock/agent-dock-shared';
import { bi, getCurrentLocale } from '../i18n';

export interface SupervisionSystemRoundCopy {
  title: string;
  badge: string;
  description: string;
}

/** 网页上的系统轮次标识文案。抽成纯函数，避免组件改动时悄悄改掉用户看到的解释。 */
export function supervisionSystemRoundCopy(locale: Locale = getCurrentLocale()): SupervisionSystemRoundCopy {
  return {
    title: bi('系统自动开了一轮 · 督办', 'Auto System Turn · Supervision', locale),
    badge: bi('系统轮次', 'System Turn', locale),
    description: bi(
      'daemon 在侧边会话完成后自动注入，不是用户消息',
      'Automatically injected by the daemon after a side session finishes — not a user message',
      locale
    )
  };
}
