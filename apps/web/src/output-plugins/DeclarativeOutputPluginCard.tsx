import { memo, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  Globe2,
  Send
} from 'lucide-react';
import type {
  DeclarativeInteractionField,
  DeclarativeOutputPluginInteractionPayload,
  DeclarativeOutputPluginSpec,
  OutputPluginAccentTone,
  OutputPluginMetadata
} from '@agent-dock/agent-dock-shared';
import { Spinner } from '../Loaders';
import { UserMessageTime } from '../SendTimeHint';
import { PluginIcon } from './PluginIcon';

export interface DeclarativeCardInteractPayload {
  actionValue?: string;
  actionLabel?: string;
  fields?: DeclarativeInteractionField[];
  note?: string;
}

const toneIconBox: Record<OutputPluginAccentTone, string> = {
  sky: 'border-sky-200/80 bg-sky-50 text-sky-700 dark:text-sky-300',
  emerald: 'border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:text-emerald-300',
  amber: 'border-amber-200/80 bg-amber-50 text-amber-700 dark:text-amber-300',
  rose: 'border-red-200/80 bg-red-50 text-red-700 dark:text-red-300',
  violet: 'border-blue-200/80 bg-blue-50 text-blue-700 dark:text-blue-300',
  zinc: 'border-zinc-200 bg-zinc-100 text-zinc-700'
};

const toneBadge: Record<OutputPluginAccentTone, string> = {
  sky: 'border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300',
  amber: 'border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300',
  rose: 'border-red-200 bg-red-50 text-red-700 dark:text-red-300',
  violet: 'border-blue-200 bg-blue-50 text-blue-700 dark:text-blue-300',
  zinc: 'border-zinc-200 bg-zinc-100 text-zinc-600'
};

function InteractionSourceBadge({ source, actedBy }: { source: 'web' | 'lark'; actedBy?: string }) {
  const isLark = source === 'lark';
  const label = isLark
    ? (actedBy?.trim() ? `飞书 · ${actedBy.trim()}` : '飞书')
    : (actedBy?.trim() ? `网页端 · ${actedBy.trim()}` : '网页端');
  return (
    <span
      data-plugin-source={source}
      className={`inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${
        isLark
          ? 'border-blue-200 bg-blue-50 text-blue-700 dark:text-blue-300'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
      }`}
    >
      {isLark ? <Send size={10} className="shrink-0"/> : <Globe2 size={10} className="shrink-0"/>}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** 声明式插件流式未闭合占位条（彻底隐藏裸 XML 源码）。 */
export const DeclarativeOutputPluginStreamingPlaceholder = memo(function DeclarativeOutputPluginStreamingPlaceholder({
  plugin,
  title
}: {
  plugin: OutputPluginMetadata;
  title?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-output-plugin-placeholder={plugin.id}
      className="ui-timeline-item my-3 flex max-w-[78ch] items-center gap-2.5 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3.5 py-2.5 text-[13px] text-zinc-600"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500 ui-live-dot"/>
      <PluginIcon name={plugin.icon} size={15} className="shrink-0 text-sky-600 dark:text-sky-400"/>
      <span className="ui-shimmer-text min-w-0 truncate font-medium">
        {title ? `正在生成「${title}」卡片…` : `正在生成「${plugin.name}」卡片…`}
      </span>
    </div>
  );
});

/**
 * 声明式纯 XML 交互插件通用卡片渲染器：
 * - `info-card`：结构化信息与安全外链只读卡；
 * - `action-card`：审批/确认/多按钮操作卡（可选备注输入）；
 * - `form-card`：多字段表单收集卡（支持 text / textarea / select 与必填校验）；
 * - 响应完成后优雅锁定为绿色只读摘要卡。
 */
export const DeclarativeOutputPluginCard = memo(function DeclarativeOutputPluginCard({
  plugin,
  spec,
  answered,
  disabled = false,
  disabledReason,
  submitting = false,
  error,
  onInteract
}: {
  plugin: OutputPluginMetadata;
  spec: DeclarativeOutputPluginSpec;
  answered?: DeclarativeOutputPluginInteractionPayload;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  error?: string;
  onInteract?(input: DeclarativeCardInteractPayload): void | Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [formValues, setFormValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of spec.fields) {
      initial[field.name] = field.value ?? '';
    }
    return initial;
  });

  const formReady = useMemo(() => {
    if (spec.kind !== 'form-card') return true;
    const allRequiredFilled = spec.fields.every(field => !field.required || Boolean(formValues[field.name]?.trim()));
    const hasAnyValue = spec.fields.some(field => Boolean(formValues[field.name]?.trim()));
    return allRequiredFilled && hasAnyValue;
  }, [spec.kind, spec.fields, formValues]);

  if (answered) {
    return (
      <section
        aria-label={`${spec.title || plugin.name}（已响应）`}
        data-output-plugin-card={plugin.id}
        data-output-plugin-instance={spec.id}
        data-output-plugin-state="answered"
        className="ui-timeline-item my-3 max-w-[78ch] overflow-hidden rounded-2xl border border-emerald-200/80 bg-[rgb(var(--surface))]"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/75 bg-emerald-50/55 px-3.5 py-2.5">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300">
            <Check size={13} className="ui-icon-pop"/>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-zinc-900">
                {spec.title || plugin.name}
              </span>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                已响应
              </span>
            </div>
          </div>
          <InteractionSourceBadge source={answered.source} actedBy={answered.actedBy}/>
        </div>
        <div className="space-y-1.5 px-3.5 py-2.5 text-[12.5px] leading-5 text-zinc-700">
          {(answered.actionLabel || answered.actionValue) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-500">操作：</span>
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200/80 bg-emerald-50/75 px-2 py-0.5 text-[12px] font-medium text-emerald-800 dark:text-emerald-300">
                <Check size={11} className="shrink-0"/>
                <span>{answered.actionLabel || answered.actionValue}</span>
              </span>
            </div>
          )}
          {answered.fields.map((field, idx) => (
            <div key={`${field.name}-${idx}`} className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-zinc-500">{field.label}：</span>
              <span className="font-medium text-zinc-900 [overflow-wrap:anywhere]">{field.displayValue || field.value}</span>
            </div>
          ))}
          {answered.note?.trim() && (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[12px] text-zinc-700 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {answered.note}
            </div>
          )}
        </div>
      </section>
    );
  }

  const handleActionClick = (actionValue: string, actionLabel: string) => {
    if (disabled || submitting || !onInteract) return;
    const trimmedNote = spec.allowNote ? note.trim() : '';
    void onInteract({
      actionValue,
      actionLabel,
      ...(trimmedNote ? { note: trimmedNote } : {})
    });
  };

  const handleFormSubmit = () => {
    if (disabled || submitting || !formReady || !onInteract) return;
    const fields: DeclarativeInteractionField[] = [];
    for (const field of spec.fields) {
      const value = (formValues[field.name] ?? '').trim();
      if (!value) continue;
      const matchedOpt = field.options.find(opt => opt.value === value);
      fields.push({
        name: field.name,
        label: field.label,
        value,
        ...(matchedOpt && matchedOpt.label !== value ? { displayValue: matchedOpt.label } : {})
      });
    }
    void onInteract({
      actionValue: 'submit',
      actionLabel: spec.submitLabel || '提交',
      fields
    });
  };

  return (
    <section
      aria-label={spec.title || plugin.name}
      data-output-plugin-card={plugin.id}
      data-output-plugin-instance={spec.id}
      data-output-plugin-kind={spec.kind}
      data-output-plugin-state={spec.kind === 'info-card' ? 'readonly' : 'pending'}
      className="ui-timeline-item my-3 max-w-[78ch] overflow-hidden rounded-2xl border border-zinc-200 bg-[rgb(var(--surface))] shadow-[0_2px_12px_rgba(24,24,27,0.04)]"
    >
      <header className="flex flex-wrap items-start gap-2.5 border-b border-zinc-200/80 bg-zinc-50/75 px-4 py-3">
        <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl border ${toneIconBox[spec.tone]}`}>
          <PluginIcon name={plugin.icon} size={15}/>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[14px] font-semibold leading-5 text-zinc-900 [overflow-wrap:anywhere]">
              {spec.title || plugin.name}
            </h3>
            {spec.status && (
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneBadge[spec.tone]}`}>
                {spec.status}
              </span>
            )}
            <span className="ml-auto shrink-0 rounded-full border border-zinc-200 bg-[rgb(var(--surface))] px-2 py-0.5 text-[11px] font-medium text-zinc-500">
              {plugin.name}
            </span>
          </div>
          {spec.summary && (
            <p className="mb-0 mt-1 text-[12.5px] leading-5 text-zinc-600 [overflow-wrap:anywhere]">
              {spec.summary}
            </p>
          )}
        </div>
      </header>

      <div className="space-y-3 px-4 py-3.5">
        {spec.kind !== 'form-card' && spec.fields.length > 0 && (
          <dl className="m-0 grid gap-2 rounded-xl border border-zinc-200/80 bg-zinc-50/55 px-3 py-2.5 text-[12.5px] sm:grid-cols-2">
            {spec.fields.map((field, idx) => (
              <div key={`${field.name}-${idx}`} className="min-w-0">
                <dt className="text-[11px] font-medium text-zinc-500">{field.label}</dt>
                <dd className="m-0 mt-0.5 font-medium text-zinc-900 [overflow-wrap:anywhere]">
                  {field.value || '—'}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {spec.links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {spec.links.map((link, idx) => (
              <a
                key={`${link.href}-${idx}`}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[12px] font-medium text-link hover:border-zinc-300 hover:bg-zinc-100"
              >
                <span className="truncate">{link.label}</span>
                <ExternalLink size={11} className="shrink-0"/>
              </a>
            ))}
          </div>
        )}

        {spec.kind === 'action-card' && spec.allowNote && (
          <textarea
            rows={2}
            disabled={disabled || submitting}
            value={note}
            onChange={event => setNote(event.target.value)}
            aria-label={`${spec.title || plugin.name} - 补充说明`}
            placeholder={spec.notePlaceholder || '可选：输入补充说明或审批备注…'}
            className="ui-field w-full resize-y rounded-xl border border-zinc-200 bg-[rgb(var(--bg))] px-3 py-2 text-[13px] leading-5 text-zinc-900 placeholder:text-zinc-400 disabled:opacity-60"
          />
        )}

        {spec.kind === 'form-card' && (
          <div className="space-y-3">
            {spec.fields.map(field => (
              <div key={field.name} className="space-y-1">
                <label className="block text-[12px] font-medium text-zinc-700">
                  <span>{field.label}</span>
                  {field.required && <span className="ml-1 text-red-500">*</span>}
                </label>
                {field.type === 'select' && field.options.length > 0 ? (
                  <select
                    disabled={disabled || submitting}
                    value={formValues[field.name] ?? ''}
                    onChange={event => setFormValues(prev => ({ ...prev, [field.name]: event.target.value }))}
                    className="ui-field h-9 w-full rounded-xl border border-zinc-200 bg-[rgb(var(--bg))] px-3 text-[13px] text-zinc-900 disabled:opacity-60"
                  >
                    <option value="">{field.placeholder || `请选择${field.label}`}</option>
                    {field.options.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : field.type === 'textarea' ? (
                  <textarea
                    rows={3}
                    disabled={disabled || submitting}
                    value={formValues[field.name] ?? ''}
                    onChange={event => setFormValues(prev => ({ ...prev, [field.name]: event.target.value }))}
                    placeholder={field.placeholder || `请输入${field.label}`}
                    className="ui-field w-full resize-y rounded-xl border border-zinc-200 bg-[rgb(var(--bg))] px-3 py-2 text-[13px] leading-5 text-zinc-900 placeholder:text-zinc-400 disabled:opacity-60"
                  />
                ) : (
                  <input
                    type="text"
                    disabled={disabled || submitting}
                    value={formValues[field.name] ?? ''}
                    onChange={event => setFormValues(prev => ({ ...prev, [field.name]: event.target.value }))}
                    placeholder={field.placeholder || `请输入${field.label}`}
                    className="ui-field h-9 w-full rounded-xl border border-zinc-200 bg-[rgb(var(--bg))] px-3 text-[13px] text-zinc-900 placeholder:text-zinc-400 disabled:opacity-60"
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="ui-status-banner-in flex items-start gap-2 border-t border-red-200 bg-red-50/75 px-4 py-2 text-[12px] leading-5 text-red-700 dark:text-red-300"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0"/>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span>
        </div>
      )}

      {spec.kind === 'action-card' && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/80 bg-zinc-50/55 px-4 py-2.5">
          {disabledReason && (
            <span className="min-w-0 text-[12px] text-zinc-500">{disabledReason}</span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {spec.actions.map(action => (
              <button
                key={action.value}
                type="button"
                disabled={disabled || submitting || !onInteract}
                data-plugin-action={action.value}
                onClick={() => handleActionClick(action.value, action.label)}
                className={`ui-press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  action.style === 'primary'
                    ? 'bg-accent text-accent-fg hover:opacity-90'
                    : action.style === 'danger'
                      ? 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:text-red-300'
                      : 'border border-zinc-200 bg-[rgb(var(--surface))] text-zinc-800 hover:border-zinc-300 hover:bg-zinc-100'
                }`}
              >
                {submitting && <Spinner size={12} label="提交中"/>}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </footer>
      )}

      {spec.kind === 'form-card' && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/80 bg-zinc-50/55 px-4 py-2.5">
          <span className="min-w-0 text-[12px] text-zinc-500">
            {disabledReason || (formReady ? '填写完成，点击提交继续对话' : '请完善必填项后提交')}
          </span>
          <button
            type="button"
            disabled={disabled || submitting || !formReady || !onInteract}
            data-plugin-form-submit=""
            onClick={handleFormSubmit}
            className="ui-press ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? <Spinner size={13} label="正在提交"/> : <Check size={14}/>}
            <span>{submitting ? '提交中…' : (spec.submitLabel || '提交')}</span>
          </button>
        </footer>
      )}
    </section>
  );
});

/** 声明式插件交互回传轮次的专属回显卡片。 */
export const DeclarativeOutputPluginInteractionCard = memo(function DeclarativeOutputPluginInteractionCard({
  plugin,
  payload,
  timestamp
}: {
  plugin: OutputPluginMetadata;
  payload: DeclarativeOutputPluginInteractionPayload;
  timestamp: string;
}) {
  return (
    <div
      data-output-plugin-interaction-card={plugin.id}
      data-output-plugin-instance={payload.instanceId}
      data-output-plugin-source={payload.source}
      className="ui-user-send-time-row group/msg ui-timeline-item relative my-6 flex flex-col items-end"
    >
      <div className="w-full max-w-[min(100%,560px)] overflow-hidden rounded-2xl border border-sky-200/90 bg-[rgb(var(--surface))] text-left shadow-[0_2px_12px_rgba(14,165,233,0.06)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/75 bg-sky-50/65 px-3.5 py-2">
          <CheckCircle2 size={14} className="shrink-0 text-sky-600 dark:text-sky-400"/>
          <span className="shrink-0 text-[12px] font-semibold text-zinc-900">
            {payload.pluginName || plugin.name}
          </span>
          {payload.title && (
            <span className="min-w-0 truncate text-[12px] text-zinc-500">· {payload.title}</span>
          )}
          <div className="ml-auto flex max-w-full shrink-0 items-center">
            <InteractionSourceBadge source={payload.source} actedBy={payload.actedBy}/>
          </div>
        </div>
        <div className="space-y-2 px-3.5 py-2.5 text-[13px] leading-5">
          {(payload.actionLabel || payload.actionValue) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-lg border border-sky-200/90 bg-sky-50/85 px-2.5 py-0.5 font-medium text-sky-900 dark:text-sky-200">
                <Check size={12} className="shrink-0 text-sky-600 dark:text-sky-400"/>
                <span>{payload.actionLabel || payload.actionValue}</span>
              </span>
            </div>
          )}
          {payload.fields.length > 0 && (
            <div className="space-y-1">
              {payload.fields.map((field, idx) => (
                <div key={`${field.name}-${idx}`} className="flex flex-wrap items-baseline gap-1.5 text-[12.5px]">
                  <span className="text-zinc-500">{field.label}：</span>
                  <span className="font-medium text-zinc-900 [overflow-wrap:anywhere]">{field.displayValue || field.value}</span>
                </div>
              ))}
            </div>
          )}
          {payload.note?.trim() && (
            <div className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2.5 py-1.5 text-[12.5px] text-zinc-800 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {payload.note}
            </div>
          )}
        </div>
      </div>

      <div className="ui-user-send-time-slot mt-1 flex max-w-[min(100%,560px)] items-center justify-end gap-2">
        <UserMessageTime timestamp={timestamp}/>
      </div>
    </div>
  );
});
