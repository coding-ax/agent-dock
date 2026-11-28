import { memo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Globe2,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  X
} from 'lucide-react';
import {
  parseRecoveryTriggerSourceFromPrompt,
  stripRecoveryVisiblePrefix,
  type TaskRecoveryDecisionSource,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { Disclosure } from './Disclosure';
import { Spinner } from './Loaders';
import { useBi } from './i18n';

function formatShortTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function RecoverySourcePill({ source, decidedBy }: { source?: TaskRecoveryDecisionSource | null; decidedBy?: string | null }) {
  const L = useBi();
  if (source === 'lark') {
    return (
      <span
        data-recovery-source="lark"
        className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium leading-4 text-blue-700 dark:text-blue-300"
      >
        <Send size={10} className="shrink-0"/>
        <span className="truncate">{decidedBy?.trim() ? L(`飞书 · ${decidedBy.trim()}`, `Lark · ${decidedBy.trim()}`) : L("飞书确认", "Confirmed in Lark")}</span>
      </span>
    );
  }
  if (source === 'web') {
    return (
      <span
        data-recovery-source="web"
        className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium leading-4 text-emerald-700 dark:text-emerald-300"
      >
        <Globe2 size={10} className="shrink-0"/>
        <span className="truncate">{decidedBy?.trim() ? L(`网页端 · ${decidedBy.trim()}`, `Web · ${decidedBy.trim()}`) : L("网页端确认", "Confirmed in Web")}</span>
      </span>
    );
  }
  return (
    <span
      data-recovery-source="auto"
      className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium leading-4 text-sky-700 dark:text-sky-300"
    >
      <RefreshCw size={10} className="shrink-0"/>
      <span className="truncate">{L("自动恢复", "Auto-Recovery")}</span>
    </span>
  );
}

/**
 * 决定一条中断恢复记录是否应该在时间线上渲染独立卡片/提示：
 * - `pending_confirm`：始终渲染可交互确认卡；
 * - `scheduled`：错峰排队倒计时提示；
 * - `dismissed`：锁定态已放弃确认卡；
 * - `resumed`：仅 confirm 模式渲染「已确认继续执行」锁定卡（auto 模式已有下方的 TaskRecoveryNotice 轮次卡，避免重复）；
 * - `skipped`：仅护栏触发（max_attempts / stale）时展示轻巧说明条。
 */
export function shouldRenderRecoveryCard(record: TaskRecoveryRecord): boolean {
  if (record.status === 'pending_confirm' || record.status === 'scheduled' || record.status === 'dismissed') return true;
  if (record.status === 'resumed') return record.mode === 'confirm';
  if (record.status === 'skipped') return record.skipReason === 'max_attempts' || record.skipReason === 'stale';
  return false;
}

/**
 * 时间线上的断点续跑轮次卡片（`origin === 'recovery'`）：
 * 不画成普通用户气泡，而是清晰标注「断点续跑」来源、触发方式、安全护栏说明，并支持展开完整断点自检指令。
 */
export const TaskRecoveryNotice = memo(function TaskRecoveryNotice({
  text,
  detail,
  timestamp,
  recoveryRecord
}: {
  text?: string;
  detail: string;
  timestamp?: string;
  recoveryRecord?: TaskRecoveryRecord;
}) {
  const L = useBi();
  const [open, setOpen] = useState(false);
  const summary = stripRecoveryVisiblePrefix(text || recoveryRecord?.originalPrompt || '') || L("续接因服务重启中断的任务", "Resuming task interrupted by restart");
  const triggerSource = recoveryRecord?.decidedSource ?? parseRecoveryTriggerSourceFromPrompt(detail) ?? 'auto';
  const time = formatShortTime(timestamp);

  return (
    <aside
      role="note"
      aria-label={L("断点续跑轮次", "Checkpoint Resume Turn")}
      data-task-recovery-turn=""
      data-recovery-trigger={triggerSource}
      className="ui-timeline-item my-5 overflow-hidden rounded-2xl border border-sky-200/85 bg-sky-50/45 shadow-[0_1px_2px_rgba(12,13,16,.03)]"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-sky-200/65 bg-sky-50/75 px-3.5 py-2.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-sky-200 bg-white text-sky-700 dark:text-sky-300">
          <RotateCcw size={13}/>
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-white px-2 py-0.5 text-[11.5px] font-semibold text-sky-800 dark:text-sky-200">
          <span>{L("断点续跑", "Checkpoint Resume")}</span>
        </span>
        <RecoverySourcePill source={triggerSource} decidedBy={recoveryRecord?.decidedBy}/>
        {time && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-400">{time}</span>}
      </div>

      <div className="space-y-2 px-3.5 py-3">
        <p className="text-[13px] font-medium leading-5 text-zinc-900 [overflow-wrap:anywhere]">
          {summary}
        </p>
        <div className="flex items-start gap-1.5 text-[11.5px] leading-4 text-zinc-500">
          <ShieldCheck size={12} className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400"/>
          <span className="min-w-0 flex-1">{L("已注入断点自检护栏：先核对当前工作区与已完成进度，严禁重复已完成的外部副作用操作。", "Checkpoint guardrail injected: verify workspace progress first and avoid repeating side-effect operations.")}</span>
        </div>

        {detail && (
          <div>
            <button
              type="button"
              data-timeline-disclosure
              aria-expanded={open}
              onClick={() => setOpen(value => !value)}
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100/80 hover:text-zinc-900"
            >
              <span>{open ? L("收起完整续跑指令", "Hide full resume prompt") : L("查看完整续跑指令", "View full resume prompt")}</span>
              <ChevronDown size={11} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}/>
            </button>
            <Disclosure open={open}>
              <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200/80 bg-[rgb(var(--surface))] p-2.5 font-sans text-[12px] leading-5 text-zinc-600">
                {detail}
              </pre>
            </Disclosure>
          </div>
        )}
      </div>
    </aside>
  );
});

/**
 * 普通会话任务中断恢复交互确认卡 / 状态卡：
 * - `pending_confirm`：提供「继续执行」与「放弃 / 取消」一键按钮（与飞书 Schema 2.0 卡片双端幂等锁定）；
 * - `scheduled`：展示错峰自动恢复排队状态；
 * - `resumed` / `dismissed`：展示锁定态摘要与操作来源（网页端 / 飞书）；
 * - `skipped`（`max_attempts` / `stale`）：展示护栏拦截原因。
 */
export const TaskRecoveryConfirmCard = memo(function TaskRecoveryConfirmCard({
  record,
  disabled = false,
  disabledReason,
  submittingDecision,
  error,
  onDecide
}: {
  record: TaskRecoveryRecord;
  disabled?: boolean;
  disabledReason?: string;
  submittingDecision?: 'resume' | 'dismiss' | null;
  error?: string;
  onDecide?(recoveryId: string, decision: 'resume' | 'dismiss'): void | Promise<void>;
}) {
  const L = useBi();
  const excerpt = stripRecoveryVisiblePrefix(record.originalPrompt) || L("未记录原始请求文本", "Original request not recorded");
  const interruptedTime = formatShortTime(record.interruptedAt);
  const decidedTime = formatShortTime(record.decidedAt ?? record.updatedAt);

  if (record.status === 'scheduled') {
    return (
      <section
        role="status"
        aria-label={L("即将自动断点续跑", "Auto-resuming shortly")}
        data-task-recovery-card="scheduled"
        data-task-recovery-id={record.id}
        className="ui-timeline-item my-4 flex items-start gap-2.5 rounded-2xl border border-sky-200/85 bg-sky-50/55 px-3.5 py-3 text-[12.5px] leading-5 text-sky-900 dark:text-sky-200"
      >
        <Spinner size={14} label={L("正在排队自动续跑", "Queued for auto-resume")} className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400"/>
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <div className="font-medium">{L("检测到任务因服务重启中断，正在错峰排队自动断点续跑…", "Detected task interrupted by service restart; queued for safe staggered resume…")}</div>
          <div className="mt-0.5 text-[12px] text-zinc-600">{L("原请求：", "Original request: ")}{excerpt}</div>
        </div>
      </section>
    );
  }

  if (record.status === 'skipped') {
    const isMaxAttempts = record.skipReason === 'max_attempts';
    return (
      <section
        role="status"
        aria-label={isMaxAttempts ? L("已达自动续跑上限", "Auto-resume limit reached") : L("中断任务超出恢复时间窗口", "Interrupted task exceeded recovery window")}
        data-task-recovery-card="skipped"
        data-task-recovery-skip-reason={record.skipReason ?? ''}
        data-task-recovery-id={record.id}
        className="ui-timeline-item my-4 flex items-start gap-2.5 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3.5 py-2.5 text-[12px] leading-5 text-zinc-600"
      >
        {isMaxAttempts
          ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"/>
          : <Clock size={14} className="mt-0.5 shrink-0 text-zinc-500"/>}
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="font-medium text-zinc-800">
            {isMaxAttempts
              ? L("已触发防重启循环护栏，暂停自动续跑", "Crash-loop guardrail triggered; auto-resume paused")
              : L("中断任务已超过恢复时间窗口，已跳过自动续跑", "Task exceeded the recovery window; auto-resume skipped")}
          </span>
          <span className="ml-1.5 text-zinc-500">
            {isMaxAttempts
              ? L(`该任务已自动恢复过 ${Math.max(1, record.attemptCount)} 次，如需继续请核对现状后手动发送消息。`, `This task has already auto-recovered ${Math.max(1, record.attemptCount)} time(s). Verify state and send a message manually to continue.`)
              : L("如需继续处理，可直接发送新消息让 Agent 核对当前工作区进度。", "To continue, send a new message asking the Agent to verify current workspace progress.")}
          </span>
        </div>
      </section>
    );
  }

  if (record.status === 'resumed' || record.status === 'dismissed') {
    const resumed = record.status === 'resumed';
    return (
      <section
        aria-label={resumed ? L("已确认继续执行", "Resumed") : L("已放弃本次续跑", "Dismissed")}
        data-task-recovery-card={record.status}
        data-task-recovery-id={record.id}
        className={`ui-timeline-item my-4 overflow-hidden rounded-2xl border bg-[rgb(var(--surface))] ${
          resumed ? 'border-emerald-200/85' : 'border-zinc-200'
        }`}
      >
        <div className={`flex flex-wrap items-center gap-2 border-b border-zinc-200/75 px-3.5 py-2.5 ${
          resumed ? 'bg-emerald-50/55' : 'bg-zinc-50/80'
        }`}>
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg border ${
            resumed
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
              : 'border-zinc-200 bg-zinc-100 text-zinc-600'
          }`}>
            {resumed ? <Check size={13} className="ui-icon-pop"/> : <X size={13} className="ui-icon-pop"/>}
          </span>
          <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-900">
            {resumed ? L("已确认继续执行", "Resumed") : L("已放弃本次断点续跑", "Recovery dismissed")}
          </span>
          <span className={`rounded-full border px-1.5 py-px text-[11px] font-medium ${
            resumed
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
              : 'border-zinc-200 bg-zinc-100 text-zinc-600'
          }`}>
            {resumed ? L("已锁定 · 已触发续跑", "Locked · Resumed") : L("已归档锁定", "Archived & Locked")}
          </span>
          <RecoverySourcePill source={record.decidedSource} decidedBy={record.decidedBy}/>
          {decidedTime && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-400">{decidedTime}</span>}
        </div>
        <div className="px-3.5 py-2.5 text-[12px] leading-5 text-zinc-600 [overflow-wrap:anywhere]">
          <span className="text-zinc-400">{L("中断任务：", "Interrupted task: ")}</span>
          <span>{excerpt}</span>
        </div>
      </section>
    );
  }

  // status === 'pending_confirm'
  const busy = Boolean(submittingDecision);
  const actionsDisabled = disabled || busy;

  return (
    <section
      role="region"
      aria-label={L("任务因服务重启中断，是否继续执行？", "Task interrupted by service restart — resume execution?")}
      data-task-recovery-card="pending_confirm"
      data-task-recovery-id={record.id}
      className="ui-timeline-item my-4 overflow-hidden rounded-2xl border border-amber-200/90 bg-[rgb(var(--surface))] shadow-[0_2px_10px_rgba(12,13,16,.05)]"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-200/75 bg-amber-50/55 px-3.5 py-2.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300">
          <RotateCcw size={13}/>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-zinc-900">{L("任务因服务重启中断，是否继续执行？", "Task interrupted by service restart — resume execution?")}</span>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-800 dark:text-amber-300">
              
              {L("待确认", "Pending")}
            </span>
          </div>
        </div>
        {interruptedTime && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-zinc-500">
            <Clock size={11}/>
            <span>{L("中断于", "Interrupted ")} {interruptedTime}</span>
          </span>
        )}
      </div>

      <div className="space-y-2.5 px-3.5 py-3">
        <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/75 px-3 py-2 text-[12.5px] leading-5 text-zinc-800 [overflow-wrap:anywhere]">
          <div className="mb-0.5 text-[11px] font-medium text-zinc-500">{L("中断前的请求", "Request before interruption")}</div>
          <div>{excerpt}</div>
        </div>

        <div className="flex items-start gap-1.5 text-[11.5px] leading-4 text-zinc-500">
          <ShieldCheck size={13} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"/>
          <span>
            
            {L("点击「继续执行」后，Agent 会先核对工作区和已完成进度，严禁重复已完成的发消息、发版或删文件等副作用操作。", "After clicking Resume, the Agent verifies workspace state first and avoids repeating messaging, publishing, or destructive operations.")}
            {record.larkMessageId ? L("（该确认卡已同步至绑定飞书，任一端操作即双端锁定）", " (Synced to bound Lark chat — acting on either side locks both)") : ''}
          </span>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700">
            {error}
          </div>
        )}

        {disabled && disabledReason && (
          <div className="text-[12px] text-zinc-500">{disabledReason}</div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button
            type="button"
            disabled={actionsDisabled}
            data-task-recovery-action="resume"
            onClick={() => void onDecide?.(record.id, 'resume')}
            className="ui-press inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submittingDecision === 'resume'
              ? <Spinner size={12} label={L("正在发起续跑", "Starting resume")} className="text-accent-fg"/>
              : <Play size={12}/>}
            <span>{submittingDecision === 'resume' ? L("正在续跑…", "Resuming…") : L("继续执行", "Resume")}</span>
          </button>
          <button
            type="button"
            disabled={actionsDisabled}
            data-task-recovery-action="dismiss"
            onClick={() => void onDecide?.(record.id, 'dismiss')}
            className="ui-press inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12.5px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submittingDecision === 'dismiss'
              ? <Spinner size={12} label={L("正在放弃", "Dismissing")} className="text-zinc-500"/>
              : <X size={12}/>}
            <span>{submittingDecision === 'dismiss' ? L("处理中…", "Processing…") : L("放弃 / 取消", "Dismiss / Cancel")}</span>
          </button>
        </div>
      </div>
    </section>
  );
});
