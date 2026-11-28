import { Globe2 } from 'lucide-react';
import {
  formatOutputPluginInteractionSourceLabel,
  type OutputPluginInteractionSource
} from '@agent-dock/agent-dock-shared';
import { LarkIcon } from '../LarkIcon';

/**
 * 统一的输出插件交互来源徽标（网页端 / 飞书 / 🐾 小猫代答）：
 * 供 AskUserQuestionCard、ConfirmActionCard 与 DeclarativeOutputPluginCard 共用，
 * 保持三种来源风格统一又一眼可辨，同时完整适配亮/暗双主题及 20 套自定义主题。
 */
export function InteractionSourceBadge({
  source,
  actorName,
  responderName,
  dataAttr = 'plugin'
}: {
  source: OutputPluginInteractionSource;
  actorName?: string;
  responderName?: string;
  dataAttr?: 'ask' | 'confirm' | 'plugin';
}) {
  const label = formatOutputPluginInteractionSourceLabel(source, { actorName, responderName });
  const dataProps = dataAttr === 'ask'
    ? { 'data-ask-source': source }
    : dataAttr === 'confirm'
      ? { 'data-confirm-source': source }
      : { 'data-plugin-source': source };

  if (source === 'assistant') {
    return (
      <span
        {...dataProps}
        className="ui-kitten-badge inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4"
      >
        <span aria-hidden="true" className="shrink-0 text-[11px] leading-none">🐾</span>
        <span className="truncate">{label}</span>
      </span>
    );
  }

  const isLark = source === 'lark';
  return (
    <span
      {...dataProps}
      className={`inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${
        isLark
          ? 'border-blue-200 bg-blue-50 text-blue-700 dark:text-blue-300'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
      }`}
    >
      {isLark ? <LarkIcon size={11} className="shrink-0"/> : <Globe2 size={10} className="shrink-0"/>}
      <span className="truncate">{label}</span>
    </span>
  );
}
