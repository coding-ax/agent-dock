import { memo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Globe2,
  MessageSquarePlus,
  Send,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  X,
  XCircle
} from 'lucide-react';
import type {
  ConfirmActionDecision,
  ConfirmActionInteractionPayload,
  ConfirmActionRisk,
  ConfirmActionSpec
} from '@agent-dock/agent-dock-shared';
import { Disclosure } from '../Disclosure';
import { Spinner } from '../Loaders';
import { UserMessageTime } from '../SendTimeHint';

export interface ConfirmActionInteractInput {
  decision: ConfirmActionDecision;
  decisionLabel: string;
  risk: ConfirmActionRisk;
  comment?: string;
}

const riskConfig: Record<ConfirmActionRisk, {
  label: string;
  iconBox: string;
  badge: string;
  border: string;
  headerBg: string;
  confirmBtn: string;
}> = {
  high: {
    label: '高风险',
    iconBox: 'border-red-200/80 bg-red-50 text-red-700 dark:text-red-300',
    badge: 'border-red-200 bg-red-50 text-red-700 dark:text-red-300',
    border: 'border-red-200/90',
    headerBg: 'bg-red-50/55',
    confirmBtn: 'bg-red-600 text-[#ffffff] hover:bg-red-700'
  },
  medium: {
    label: '需确认',
    iconBox: 'border-amber-200/80 bg-amber-50 text-amber-700 dark:text-amber-300',
    badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300',
    border: 'border-zinc-200',
    headerBg: 'bg-amber-50/45',
    confirmBtn: 'bg-accent text-accent-fg hover:opacity-90'
  },
  low: {
    label: '常规确认',
    iconBox: 'border-sky-200/80 bg-sky-50 text-sky-700 dark:text-sky-300',
    badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300',
    border: 'border-zinc-200',
    headerBg: 'bg-zinc-50/75',
    confirmBtn: 'bg-accent text-accent-fg hover:opacity-90'
  }
};

function SourceBadge({ source, decidedBy }: { source: 'web' | 'lark'; decidedBy?: string }) {
  const isLark = source === 'lark';
  const label = isLark
    ? (decidedBy?.trim() ? `飞书 · ${decidedBy.trim()}` : '飞书')
    : (decidedBy?.trim() ? `网页端 · ${decidedBy.trim()}` : '网页端');
  return (
    <span
      data-confirm-source={source}
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

/** 流式输出阶段末尾出现未闭合 `<agentdock-confirm-action` 时的轻盈占位，彻底隐藏裸 XML 源码。 */
export const ConfirmActionStreamingPlaceholder = memo(function ConfirmActionStreamingPlaceholder({
  title
}: {
  title?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-confirm-streaming-placeholder=""
      className="ui-timeline-item my-3 flex max-w-[78ch] items-center gap-2.5 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3.5 py-2.5 text-[13px] text-zinc-600"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500 ui-live-dot"/>
      <ShieldCheck size={15} className="shrink-0 text-amber-600 dark:text-amber-400"/>
      <span className="ui-shimmer-text min-w-0 truncate font-medium">
        {title ? `正在生成「${title}」操作确认卡…` : '正在生成操作确认卡…'}
      </span>
    </div>
  );
});

/**
 * 内置插件 #2（`builtin:confirm-action`）助手轮次末尾的交互确认卡片：
 * - 支持风险等级（low / medium / high）差异化视觉强调；
 * - 展示摘要、关键维度列表与可选待执行命令块；
 * - 支持一键「确认执行 / 取消」以及可选的「补充意见」；
 * - 响应完成后优雅锁定为只读摘要卡，Web 与飞书双端一致。
 */
export const ConfirmActionCard = memo(function ConfirmActionCard({
  spec,
  answered,
  disabled = false,
  disabledReason,
  submitting = false,
  error,
  onInteract
}: {
  spec: ConfirmActionSpec;
  answered?: ConfirmActionInteractionPayload;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  error?: string;
  onInteract?(input: ConfirmActionInteractInput): void | Promise<void>;
}) {
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [pendingDecision, setPendingDecision] = useState<ConfirmActionDecision | null>(null);
  const meta = riskConfig[spec.risk];

  if (answered) {
    const confirmed = answered.decision === 'confirm';
    return (
      <section
        aria-label={`${spec.title}（${confirmed ? '已确认执行' : '已取消操作'}）`}
        data-confirm-card=""
        data-confirm-card-id={spec.id}
        data-confirm-card-state="answered"
        data-confirm-decision={answered.decision}
        className={`ui-timeline-item my-3 max-w-[78ch] overflow-hidden rounded-2xl border bg-[rgb(var(--surface))] ${
          confirmed ? 'border-emerald-200/80' : 'border-zinc-200'
        }`}
      >
        <div
          className={`flex flex-wrap items-center gap-2 border-b border-zinc-200/75 px-3.5 py-2.5 ${
            confirmed ? 'bg-emerald-50/55' : 'bg-zinc-50/80'
          }`}
        >
          <span
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg border ${
              confirmed
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
                : 'border-zinc-200 bg-zinc-100 text-zinc-600'
            }`}
          >
            {confirmed ? <Check size={13} className="ui-icon-pop"/> : <X size={13} className="ui-icon-pop"/>}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-zinc-900">
                {spec.title}
              </span>
              <span
                className={`rounded-full border px-1.5 py-px text-[11px] font-medium ${
                  confirmed
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
                    : 'border-zinc-200 bg-zinc-100 text-zinc-600'
                }`}
              >
                {confirmed ? '已确认执行' : '已取消操作'}
              </span>
            </div>
          </div>
          <SourceBadge source={answered.source} decidedBy={answered.decidedBy}/>
        </div>

        <div className="space-y-2 px-3.5 py-2.5 text-[12.5px] leading-5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-zinc-500">最终决定：</span>
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] font-medium ${
                confirmed
                  ? 'border-emerald-200/80 bg-emerald-50/70 text-emerald-800 dark:text-emerald-300'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-700'
              }`}
            >
              {confirmed ? <Check size={11}/> : <X size={11}/>}
              <span>{answered.decisionLabel}</span>
            </span>
          </div>
          {answered.comment?.trim() && (
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/80 px-2.5 py-1.5 text-[12.5px] leading-5 text-zinc-700 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span className="mr-1.5 inline-block rounded bg-zinc-200/70 px-1 py-px text-[10px] font-medium text-zinc-600">
                补充意见
              </span>
              {answered.comment}
            </div>
          )}
        </div>
      </section>
    );
  }

  const handleDecide = (decision: ConfirmActionDecision) => {
    if (disabled || submitting || !onInteract) return;
    setPendingDecision(decision);
    const trimmed = comment.trim();
    void onInteract({
      decision,
      decisionLabel: decision === 'confirm' ? spec.confirmLabel : spec.cancelLabel,
      risk: spec.risk,
      ...(trimmed ? { comment: trimmed } : {})
    });
  };

  return (
    <section
      aria-label={spec.title}
      data-confirm-card=""
      data-confirm-card-id={spec.id}
      data-confirm-card-state="pending"
      data-confirm-risk={spec.risk}
      className={`ui-timeline-item my-3 max-w-[78ch] overflow-hidden rounded-2xl border bg-[rgb(var(--surface))] shadow-[0_2px_12px_rgba(24,24,27,0.04)] ${meta.border}`}
    >
      <header className={`flex flex-wrap items-start gap-2.5 border-b border-zinc-200/80 px-4 py-3 ${meta.headerBg}`}>
        <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl border ${meta.iconBox}`}>
          {spec.risk === 'high' ? <ShieldAlert size={15}/> : <ShieldCheck size={15}/>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[14px] font-semibold leading-5 text-zinc-900 [overflow-wrap:anywhere]">
              {spec.title}
            </h3>
            <span className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badge}`}>
              {meta.label}
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
        {spec.details.length > 0 && (
          <dl className="m-0 grid grid-cols-1 gap-1.5 rounded-xl border border-zinc-200/75 bg-zinc-50/60 px-3 py-2.5 sm:grid-cols-2">
            {spec.details.map((item, idx) => (
              <div key={`${item.label}-${idx}`} className="min-w-0">
                <dt className="text-[11px] font-medium text-zinc-500">{item.label}</dt>
                <dd className="m-0 mt-0.5 text-[12.5px] font-medium text-zinc-900 [overflow-wrap:anywhere]">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {spec.command && (
          <div className="overflow-hidden rounded-xl border border-zinc-200/85 bg-[rgb(var(--bg))]">
            <div className="flex items-center gap-1.5 border-b border-zinc-200/70 bg-zinc-50/60 px-3 py-1.5 text-[11px] font-medium text-zinc-500">
              <Terminal size={12} className="shrink-0"/>
              <span>待执行命令</span>
            </div>
            <pre className="m-0 overflow-x-auto px-3 py-2 font-mono text-[12px] leading-5 text-zinc-800">
              <code>{spec.command}</code>
            </pre>
          </div>
        )}

        {spec.allowComment && (
          <div>
            {!commentOpen && !comment ? (
              <button
                type="button"
                disabled={disabled || submitting}
                data-confirm-comment-toggle=""
                onClick={() => setCommentOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-2.5 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MessageSquarePlus size={13}/>
                <span>添加补充意见（可选）</span>
              </button>
            ) : (
              <Disclosure open={commentOpen || Boolean(comment)} unmountOnClose>
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-zinc-600">
                    补充意见（可选，点击确认或取消时一并回传）
                  </label>
                  <textarea
                    rows={2}
                    disabled={disabled || submitting}
                    value={comment}
                    onChange={event => setComment(event.target.value)}
                    aria-label={`${spec.title} - 补充意见`}
                    placeholder={spec.commentPlaceholder || '例如：请先在灰度环境验证，或缩小变更范围…'}
                    className="ui-field w-full resize-y rounded-xl border border-zinc-200 bg-[rgb(var(--bg))] px-3 py-2 text-[13px] leading-5 text-zinc-900 placeholder:text-zinc-400 disabled:opacity-60"
                  />
                </div>
              </Disclosure>
            )}
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

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/80 bg-zinc-50/55 px-4 py-2.5">
        <span className="min-w-0 text-[12px] text-zinc-500">
          {disabledReason || (spec.risk === 'high' ? '高风险操作，请仔细核对后再拍板' : '请确认是否继续执行')}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || submitting || !onInteract}
            data-confirm-cancel=""
            onClick={() => handleDecide('cancel')}
            className="ui-press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-zinc-300 bg-[rgb(var(--surface))] px-3.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting && pendingDecision === 'cancel' ? <Spinner size={13} label="正在提交"/> : <X size={14}/>}
            <span>{spec.cancelLabel}</span>
          </button>
          <button
            type="button"
            disabled={disabled || submitting || !onInteract}
            data-confirm-submit=""
            onClick={() => handleDecide('confirm')}
            className={`ui-press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-4 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-45 ${meta.confirmBtn}`}
          >
            {submitting && pendingDecision === 'confirm' ? <Spinner size={13} label="正在提交"/> : <Check size={14}/>}
            <span>{submitting && pendingDecision === 'confirm' ? '提交中…' : spec.confirmLabel}</span>
          </button>
        </div>
      </footer>
    </section>
  );
});

/**
 * 操作确认卡的专属交互回显轮次（右对齐精致卡，区别于普通用户气泡）：
 * 明确标识「已确认执行」或「已取消操作」、风险来源徽标与补充意见。
 */
export const ConfirmActionInteractionCard = memo(function ConfirmActionInteractionCard({
  payload,
  timestamp
}: {
  payload: ConfirmActionInteractionPayload;
  timestamp: string;
}) {
  const confirmed = payload.decision === 'confirm';
  return (
    <div
      data-confirm-interaction-card=""
      data-confirm-interaction-action-id={payload.actionId}
      data-confirm-interaction-decision={payload.decision}
      data-confirm-interaction-source={payload.source}
      className="ui-user-send-time-row group/msg ui-timeline-item relative my-6 flex flex-col items-end"
    >
      <div
        className={`w-full max-w-[min(100%,540px)] overflow-hidden rounded-2xl border bg-[rgb(var(--surface))] text-left shadow-[0_2px_12px_rgba(24,24,27,0.05)] ${
          confirmed ? 'border-emerald-200/90' : 'border-zinc-200'
        }`}
      >
        <div
          className={`flex flex-wrap items-center gap-2 border-b border-zinc-200/75 px-3.5 py-2 ${
            confirmed ? 'bg-emerald-50/65' : 'bg-zinc-50/80'
          }`}
        >
          {confirmed
            ? <CheckCircle2 size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400"/>
            : <XCircle size={14} className="shrink-0 text-zinc-500"/>}
          <span className="shrink-0 text-[12px] font-semibold text-zinc-900">
            {confirmed ? '已确认执行' : '已取消操作'}
          </span>
          {payload.title && (
            <span className="min-w-0 truncate text-[12px] text-zinc-500">· {payload.title}</span>
          )}
          <div className="ml-auto flex max-w-full shrink-0 items-center">
            <SourceBadge source={payload.source} decidedBy={payload.decidedBy}/>
          </div>
        </div>

        <div className="space-y-2 px-3.5 py-2.5 text-[13px] leading-5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-0.5 text-[12.5px] font-medium ${
                confirmed
                  ? 'border-emerald-200/90 bg-emerald-50/80 text-emerald-900 dark:text-emerald-300'
                  : 'border-zinc-200 bg-zinc-100/90 text-zinc-800'
              }`}
            >
              {confirmed ? <Check size={12}/> : <X size={12}/>}
              <span>{payload.decisionLabel}</span>
            </span>
          </div>
          {payload.comment?.trim() && (
            <div className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2.5 py-1.5 text-[13px] leading-5 text-zinc-800 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span className="mr-1.5 inline-block rounded bg-zinc-200/80 px-1 py-px text-[10px] font-medium text-zinc-600">
                补充意见
              </span>
              {payload.comment}
            </div>
          )}
        </div>
      </div>

      <div className="ui-user-send-time-slot mt-1 flex max-w-[min(100%,540px)] items-center justify-end gap-2">
        <UserMessageTime timestamp={timestamp}/>
      </div>
    </div>
  );
});
