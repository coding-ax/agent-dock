import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  MessageSquare,
  PowerOff,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react';
import {
  DEFAULT_TASK_RECOVERY_CONFIG,
  stripRecoveryVisiblePrefix,
  TASK_RECOVERY_MAX_WINDOW_MINUTES,
  TASK_RECOVERY_MIN_WINDOW_MINUTES,
  type TaskRecoveryConfig,
  type TaskRecoveryConfigInput,
  type TaskRecoveryMode,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { api } from './api';
import { Spinner } from './Loaders';
import { IconButton } from './ui-controls';
import { useModalFocusTrap } from './useModalFocusTrap';
import { bi, useBi } from './i18n';

export function taskRecoveryModeShortLabel(mode?: TaskRecoveryMode): string {
  switch (mode) {
    case 'confirm': return bi("确认卡", "Confirm Card");
    case 'off': return bi("已关闭", "Disabled");
    case 'auto':
    default:
      return bi("自动续跑", "Auto-Resume");
  }
}

const MODE_OPTIONS: ReadonlyArray<{
  value: TaskRecoveryMode;
  title: string;
  badge?: string;
  description: string;
}> = [
  {
    value: 'auto',
    get title() { return bi("自动安全断点续跑", "Automatic Safe Checkpoint Resume"); },
    get badge() { return bi("默认推荐", "Recommended"); },
    get description() { return bi("服务重启后对满足护栏的普通会话任务错峰自动拉起断点自检续跑，并实时同步到绑定飞书群/私聊。", "Automatically resumes eligible interrupted tasks with staggered delays after restart and syncs to bound Lark chats."); }
  },
  {
    value: 'confirm',
    get title() { return bi("先发交互确认卡，点击后再续跑", "Send Confirmation Card First"); },
    get description() { return bi("不直接驱动 Agent，在 Web 时间线与绑定飞书群/私聊投放确认卡，任一端点击「继续执行」即双端锁定并续跑。", "Places a confirmation card in Web and bound Lark chats; clicking Resume on either side locks both and continues."); }
  },
  {
    value: 'off',
    get title() { return bi("关闭自动恢复", "Disable Auto-Recovery"); },
    get description() { return bi("仅将受影响任务标记为「服务重启中断」，不自动续跑，也不发送确认卡。", "Marks interrupted tasks without resuming or sending confirmation cards."); }
  }
];

const WINDOW_PRESETS = [
  { value: 5, get label() { return bi("5 分钟", "5 min"); } },
  { value: 15, get label() { return bi("15 分钟", "15 min"); } },
  { value: 30, get label() { return bi("30 分钟", "30 min"); } },
  { value: 60, get label() { return bi("60 分钟", "60 min"); } }
] as const;

const MAX_ATTEMPTS_OPTIONS = [
  { value: 1, get label() { return bi("1 次（推荐）", "1x (Recommended)"); } },
  { value: 2, get label() { return bi("2 次", "2x"); } },
  { value: 3, get label() { return bi("3 次", "3x"); } }
] as const;

const STAGGER_PRESETS = [
  { value: 0, get label() { return bi("不延迟", "No delay"); } },
  { value: 3, get label() { return bi("3 秒", "3s"); } },
  { value: 5, get label() { return bi("5 秒", "5s"); } },
  { value: 10, get label() { return bi("10 秒", "10s"); } }
] as const;

function statusBadgeMeta(record: TaskRecoveryRecord): { label: string; cls: string } {
  switch (record.status) {
    case 'pending_confirm':
      return { label: bi("待确认", "Pending"), cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:text-amber-300' };
    case 'scheduled':
      return { label: bi("排队续跑", "Queued"), cls: 'border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300' };
    case 'resumed':
      return { label: bi("已续跑", "Resumed"), cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300' };
    case 'dismissed':
      return { label: bi("已放弃", "Dismissed"), cls: 'border-zinc-200 bg-zinc-100 text-zinc-600' };
    case 'skipped':
    default: {
      const reasonMap: Record<string, string> = {
        stale: bi("超时跳过", "Expired"),
        max_attempts: bi("达上限跳过", "Max Reached"),
        mode_off: bi("关闭跳过", "Disabled"),
        user_stopped: bi("用户停止", "User Stopped"),
        assistant_managed: bi("小猫接管", "Companion Managed"),
        superseded: bi("已有新消息", "Newer Message")
      };
      return {
        label: (record.skipReason && reasonMap[record.skipReason]) || bi("已跳过", "Skipped"),
        cls: 'border-zinc-200 bg-zinc-50 text-zinc-500'
      };
    }
  }
}

function formatRecordTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TaskRecoverySettingsDialog({
  onClose,
  onOpenSession,
  embedded = false
}: {
  onClose(): void;
  onOpenSession?(sessionId: string): void;
  embedded?: boolean;
}) {
  const L = useBi();
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  useModalFocusTrap({
    panel: dialogRef,
    initial: dialogRef,
    dismissible: true,
    onDismiss: onClose,
    enabled: !embedded
  });

  const configQuery = useQuery({
    queryKey: ['task-recovery-config'],
    queryFn: () => api.taskRecoveryConfig(),
    refetchOnWindowFocus: false
  });
  const recordsQuery = useQuery({
    queryKey: ['task-recovery-records'],
    queryFn: () => api.taskRecoveryRecords({ limit: 8 }),
    refetchOnWindowFocus: false
  });

  const config: TaskRecoveryConfig = configQuery.data?.config ?? DEFAULT_TASK_RECOVERY_CONFIG;
  const [customWindowDraft, setCustomWindowDraft] = useState(String(config.windowMinutes));
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setCustomWindowDraft(String(config.windowMinutes));
  }, [config.windowMinutes]);

  const saveMutation = useMutation({
    mutationFn: (patch: TaskRecoveryConfigInput) => api.saveTaskRecoveryConfig(patch),
    onSuccess: data => {
      queryClient.setQueryData(['task-recovery-config'], data);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1800);
    }
  });

  const updateConfig = (patch: TaskRecoveryConfigInput) => {
    saveMutation.mutate(patch);
  };

  const commitCustomWindow = () => {
    const parsed = Math.round(Number(customWindowDraft));
    if (!Number.isFinite(parsed)) {
      setCustomWindowDraft(String(config.windowMinutes));
      return;
    }
    const clamped = Math.min(TASK_RECOVERY_MAX_WINDOW_MINUTES, Math.max(TASK_RECOVERY_MIN_WINDOW_MINUTES, parsed));
    setCustomWindowDraft(String(clamped));
    if (clamped !== config.windowMinutes) updateConfig({ windowMinutes: clamped });
  };

  const disabledGuardrails = config.mode === 'off';
  const records = recordsQuery.data?.items ?? [];

  const inner = (
    <div
      ref={dialogRef}
      tabIndex={embedded ? undefined : -1}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : 'true'}
      aria-labelledby={embedded ? undefined : 'task-recovery-dialog-title'}
      data-testid="task-recovery-settings-dialog"
      className={embedded
        ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
        : 'flex max-h-[90dvh] w-full max-w-[580px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-[rgb(var(--surface))] shadow-[0_24px_60px_rgba(12,13,16,.24)]'}
    >
      <header className={`flex items-start gap-3 border-b ${embedded ? 'border-zinc-100 px-4 py-3 sm:px-5' : 'border-zinc-200 px-4 py-3.5 sm:px-5'}`}>
        {!embedded && (
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300">
            <RotateCcw size={16}/>
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={embedded ? undefined : 'task-recovery-dialog-title'} className={embedded ? 'text-[14px] font-semibold text-zinc-900' : 'text-[15px] font-semibold text-zinc-900'}>
              
              {L("普通会话中断自动恢复", "Interrupted Task Auto-Recovery")}
            </h2>
            {saveMutation.isPending && (
              <span className="inline-flex items-center gap-1 text-[11.5px] text-zinc-500">
                <Spinner size={11} label={L("正在保存", "Saving")} className="text-zinc-500"/>
                
                {L("保存中…", "Saving…")}
              </span>
            )}
            {justSaved && !saveMutation.isPending && (
              <span data-testid="task-recovery-saved-badge" className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 size={11}/>
                
                {L("已保存", "Saved")}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-zinc-500">
            
            {L("覆盖 Web 端、飞书群聊/私聊、普通托管群及非小猫定时任务；守护进程重启导致被动中断时按护栏安全恢复。", "Covers Web, Lark group/DM, hosted groups, and non-companion schedules when passively interrupted by daemon restarts.")}
          </p>
        </div>
        {!embedded && (
          <IconButton label={L("关闭中断恢复设置", "Close recovery settings")} onClick={onClose}>
            <X size={16}/>
          </IconButton>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          {saveMutation.isError && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              
              {L("保存失败：", "Save failed: ")}{saveMutation.error instanceof Error ? saveMutation.error.message : L("未知错误", "Unknown error")}
            </div>
          )}

          {/* 1. 三档恢复策略 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-zinc-900">{L("恢复策略", "Recovery Policy")}</h3>
              <span className="text-[11.5px] text-zinc-400">{L("修改立即生效，重启后生效于新检测到的中断任务", "Changes apply immediately to newly detected interrupted tasks")}</span>
            </div>
            <div role="radiogroup" aria-label={L("中断恢复模式", "Recovery Mode")} className="space-y-2">
              {MODE_OPTIONS.map(option => {
                const selected = config.mode === option.value;
                const Icon = option.value === 'auto' ? RefreshCw : option.value === 'confirm' ? MessageSquare : PowerOff;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`task-recovery-mode-${option.value}`}
                    disabled={saveMutation.isPending}
                    onClick={() => { if (!selected) updateConfig({ mode: option.value }); }}
                    className={`ui-press flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                      selected
                        ? 'border-sky-300 bg-sky-50/55 ring-1 ring-sky-200/80'
                        : 'border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50/70'
                    }`}
                  >
                    <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${
                      selected
                        ? 'border-sky-200 bg-white text-sky-700 dark:text-sky-300'
                        : 'border-zinc-200 bg-zinc-50 text-zinc-500'
                    }`}>
                      <Icon size={14}/>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13.5px] font-semibold text-zinc-900">{option.title}</span>
                        {option.badge && (
                          <span className="rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px text-[10.5px] font-medium text-sky-700 dark:text-sky-300">
                            {option.badge}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] leading-5 text-zinc-500">{option.description}</p>
                    </div>
                    <span className={`mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                      selected
                        ? 'border-sky-600 bg-sky-600 text-[#ffffff]'
                        : 'border-zinc-300 bg-white'
                    }`}>
                      {selected && <Check size={10} strokeWidth={3}/>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 2. 安全护栏 */}
          <section className={`overflow-hidden rounded-xl border border-zinc-200 bg-white transition-opacity ${disabledGuardrails ? 'opacity-55' : ''}`}>
            <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-2.5">
              <ShieldCheck size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400"/>
              <h3 className="text-[13px] font-semibold text-zinc-900">{L("安全护栏", "Safety Guardrails")}</h3>
              <span className="ml-auto text-[11px] text-zinc-400">{L("防重启风暴 · 防重复副作用", "Anti-loop · Idempotency guard")}</span>
            </div>

            <div className="divide-y divide-zinc-100">
              {/* 时间窗口 */}
              <div className="space-y-2 px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-zinc-900">{L("有效时间窗口", "Valid Time Window")}</div>
                    <div className="text-[11.5px] text-zinc-500">{L("仅恢复距离中断未超过该时长的任务，避免陈旧任务突然自启。", "Only recover tasks interrupted within this window to avoid stale restarts.")}</div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {WINDOW_PRESETS.map(preset => {
                    const active = config.windowMinutes === preset.value;
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        disabled={disabledGuardrails || saveMutation.isPending}
                        data-testid={`task-recovery-window-${preset.value}`}
                        onClick={() => updateConfig({ windowMinutes: preset.value })}
                        className={`h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                          active
                            ? 'border-sky-300 bg-sky-50 text-sky-800 dark:text-sky-200'
                            : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                  <div className="flex items-center gap-1.5 pl-0.5">
                    <input
                      type="number"
                      min={TASK_RECOVERY_MIN_WINDOW_MINUTES}
                      max={TASK_RECOVERY_MAX_WINDOW_MINUTES}
                      aria-label={L("自定义恢复时间窗口（分钟）", "Custom recovery window (minutes)")}
                      disabled={disabledGuardrails || saveMutation.isPending}
                      value={customWindowDraft}
                      onChange={event => setCustomWindowDraft(event.target.value)}
                      onBlur={commitCustomWindow}
                      onKeyDown={event => { if (event.key === 'Enter') commitCustomWindow(); }}
                      className="ui-field h-7 w-16 rounded-lg border border-zinc-200 bg-white px-2 text-center text-[12px] tabular-nums text-zinc-900 disabled:opacity-50"
                    />
                    <span className="text-[12px] text-zinc-500">{L("分钟", "min")}</span>
                  </div>
                </div>
              </div>

              {/* 最大自动恢复次数 */}
              <div className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-zinc-900">{L("单任务最大自动恢复次数", "Max Auto-Recoveries per Task")}</div>
                  <div className="text-[11.5px] text-zinc-500">{L("默认 1 次，达到上限后强制暂停自动续跑，杜绝崩溃死循环。", "Default 1; pauses auto-resume after reaching the limit to prevent crash loops.")}</div>
                </div>
                <div className="inline-flex shrink-0 flex-wrap items-center gap-1">
                  {MAX_ATTEMPTS_OPTIONS.map(opt => {
                    const active = config.maxAutoAttempts === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={disabledGuardrails || saveMutation.isPending}
                        data-testid={`task-recovery-attempts-${opt.value}`}
                        onClick={() => updateConfig({ maxAutoAttempts: opt.value })}
                        className={`h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                          active
                            ? 'border-sky-300 bg-sky-50 text-sky-800 dark:text-sky-200'
                            : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 错峰启动间隔 */}
              {config.mode === 'auto' && (
                <div className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-zinc-900">{L("多任务错峰启动间隔", "Staggered Launch Interval")}</div>
                    <div className="text-[11.5px] text-zinc-500">{L("同时中断多个普通会话时按间隔排队拉起，防止并发打爆。", "Launches multiple interrupted sessions with staggered delays to prevent concurrency spikes.")}</div>
                  </div>
                  <div className="inline-flex shrink-0 flex-wrap items-center gap-1">
                    {STAGGER_PRESETS.map(opt => {
                      const active = config.staggerSeconds === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={saveMutation.isPending}
                          onClick={() => updateConfig({ staggerSeconds: opt.value })}
                          className={`h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                            active
                              ? 'border-sky-300 bg-sky-50 text-sky-800 dark:text-sky-200'
                              : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 3. 内置保护原则 */}
          <section className="rounded-xl border border-zinc-200/85 bg-zinc-50/75 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-800">
              <ShieldAlert size={13} className="shrink-0 text-amber-600 dark:text-amber-400"/>
              <span>{L("内置硬性排除与防重复副作用机制", "Built-in Exclusions & Side-Effect Guards")}</span>
            </div>
            <ul className="mt-1.5 space-y-1 text-[11.5px] leading-5 text-zinc-600">
              <li>{L("• 严格排除「用户手动停止」（user_stopped）与已完成任务，绝不擅自重启用户取消的工作。", "• Strictly excludes user-stopped and completed tasks — never restarts cancelled work.")}</li>
              <li>{L("• 严格排除主小猫自身及小猫督办（assistant_tasks）接管的侧边任务，避免双重恢复冲突。", "• Excludes the companion and companion-supervised side tasks to prevent double recovery.")}</li>
              <li>{L("• 续跑轮次自动注入断点自检 Prompt，要求先核对工作区状态，严禁重复发消息/发版/删除等外部副作用操作。", "• Injects a checkpoint verification prompt so the Agent inspects workspace state and never repeats side-effect actions.")}</li>
            </ul>
          </section>

          {/* 4. 最近审计与恢复记录 */}
          <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-2.5">
              <Clock size={14} className="shrink-0 text-zinc-500"/>
              <h3 className="text-[13px] font-semibold text-zinc-900">{L("最近恢复审计记录", "Recent Recovery Audit Log")}</h3>
              <span className="ml-auto text-[11px] tabular-nums text-zinc-400">{records.length}  {L("条", " entries")}</span>
            </div>
            {recordsQuery.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-5 text-[12px] text-zinc-400">
                <Spinner size={13} label={L("加载恢复记录", "Loading recovery records")} className="text-zinc-400"/>
                
                {L("加载中…", "Loading…")}
              </div>
            ) : records.length === 0 ? (
              <div className="flex items-center gap-2 px-3.5 py-4 text-[12px] text-zinc-500">
                <Sparkles size={13} className="shrink-0 text-zinc-400"/>
                <span>{L("暂无因服务重启触发的普通会话恢复记录。", "No restart-triggered recovery records yet.")}</span>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {records.map(item => {
                  const badge = statusBadgeMeta(item);
                  const title = stripRecoveryVisiblePrefix(item.originalPrompt) || item.interruptedTaskId;
                  return (
                    <div key={item.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10.5px] font-medium ${badge.cls}`}>
                            {badge.label}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-zinc-800">{title}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] tabular-nums text-zinc-400">
                          <span>{L("中断于", "Interrupted at ")} {formatRecordTime(item.interruptedAt)}</span>
                          <span>·</span>
                          <span>{L("策略：", "Policy: ")}{taskRecoveryModeShortLabel(item.mode)}</span>
                        </div>
                      </div>
                      {onOpenSession && (
                        <button
                          type="button"
                          onClick={() => { onClose(); onOpenSession(item.sessionId); }}
                          className="ui-press inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
                        >
                          <span>{L("查看", "View")}</span>
                          <ExternalLink size={11}/>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
  );

  if (embedded) return inner;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-5"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      {inner}
    </div>
  );
}
