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

export function taskRecoveryModeShortLabel(mode?: TaskRecoveryMode): string {
  switch (mode) {
    case 'confirm': return '确认卡';
    case 'off': return '已关闭';
    case 'auto':
    default:
      return '自动续跑';
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
    title: '自动安全断点续跑',
    badge: '默认推荐',
    description: '服务重启后对满足护栏的普通会话任务错峰自动拉起断点自检续跑，并实时同步到绑定飞书群/私聊。'
  },
  {
    value: 'confirm',
    title: '先发交互确认卡，点击后再续跑',
    description: '不直接驱动 Agent，在 Web 时间线与绑定飞书群/私聊投放确认卡，任一端点击「继续执行」即双端锁定并续跑。'
  },
  {
    value: 'off',
    title: '关闭自动恢复',
    description: '仅将受影响任务标记为「服务重启中断」，不自动续跑，也不发送确认卡。'
  }
];

const WINDOW_PRESETS = [
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '60 分钟' }
] as const;

const MAX_ATTEMPTS_OPTIONS = [
  { value: 1, label: '1 次（推荐）' },
  { value: 2, label: '2 次' },
  { value: 3, label: '3 次' }
] as const;

const STAGGER_PRESETS = [
  { value: 0, label: '不延迟' },
  { value: 3, label: '3 秒' },
  { value: 5, label: '5 秒' },
  { value: 10, label: '10 秒' }
] as const;

function statusBadgeMeta(record: TaskRecoveryRecord): { label: string; cls: string } {
  switch (record.status) {
    case 'pending_confirm':
      return { label: '待确认', cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:text-amber-300' };
    case 'scheduled':
      return { label: '排队续跑', cls: 'border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300' };
    case 'resumed':
      return { label: '已续跑', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300' };
    case 'dismissed':
      return { label: '已放弃', cls: 'border-zinc-200 bg-zinc-100 text-zinc-600' };
    case 'skipped':
    default: {
      const reasonMap: Record<string, string> = {
        stale: '超时跳过',
        max_attempts: '达上限跳过',
        mode_off: '关闭跳过',
        user_stopped: '用户停止',
        assistant_managed: '小猫接管',
        superseded: '已有新消息'
      };
      return {
        label: (record.skipReason && reasonMap[record.skipReason]) || '已跳过',
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
  onOpenSession
}: {
  onClose(): void;
  onOpenSession?(sessionId: string): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  useModalFocusTrap({
    panel: dialogRef,
    initial: dialogRef,
    dismissible: true,
    onDismiss: onClose
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-5"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-recovery-dialog-title"
        data-testid="task-recovery-settings-dialog"
        className="flex max-h-[90dvh] w-full max-w-[580px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-[rgb(var(--surface))] shadow-[0_24px_60px_rgba(12,13,16,.24)]"
      >
        <header className="flex items-start gap-3 border-b border-zinc-200 px-4 py-3.5 sm:px-5">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300">
            <RotateCcw size={16}/>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="task-recovery-dialog-title" className="text-[15px] font-semibold text-zinc-900">
                普通会话中断自动恢复
              </h2>
              {saveMutation.isPending && (
                <span className="inline-flex items-center gap-1 text-[11.5px] text-zinc-500">
                  <Spinner size={11} label="正在保存" className="text-zinc-500"/>
                  保存中…
                </span>
              )}
              {justSaved && !saveMutation.isPending && (
                <span data-testid="task-recovery-saved-badge" className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 size={11}/>
                  已保存
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] leading-5 text-zinc-500">
              覆盖 Web 端、飞书群聊/私聊、普通托管群及非小猫定时任务；守护进程重启导致被动中断时按护栏安全恢复。
            </p>
          </div>
          <IconButton label="关闭中断恢复设置" onClick={onClose}>
            <X size={16}/>
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          {saveMutation.isError && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              保存失败：{saveMutation.error instanceof Error ? saveMutation.error.message : '未知错误'}
            </div>
          )}

          {/* 1. 三档恢复策略 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-zinc-900">恢复策略</h3>
              <span className="text-[11.5px] text-zinc-400">修改立即生效，重启后生效于新检测到的中断任务</span>
            </div>
            <div role="radiogroup" aria-label="中断恢复模式" className="space-y-2">
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
              <h3 className="text-[13px] font-semibold text-zinc-900">安全护栏</h3>
              <span className="ml-auto text-[11px] text-zinc-400">防重启风暴 · 防重复副作用</span>
            </div>

            <div className="divide-y divide-zinc-100">
              {/* 时间窗口 */}
              <div className="space-y-2 px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-zinc-900">有效时间窗口</div>
                    <div className="text-[11.5px] text-zinc-500">仅恢复距离中断未超过该时长的任务，避免陈旧任务突然自启。</div>
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
                      aria-label="自定义恢复时间窗口（分钟）"
                      disabled={disabledGuardrails || saveMutation.isPending}
                      value={customWindowDraft}
                      onChange={event => setCustomWindowDraft(event.target.value)}
                      onBlur={commitCustomWindow}
                      onKeyDown={event => { if (event.key === 'Enter') commitCustomWindow(); }}
                      className="ui-field h-7 w-16 rounded-lg border border-zinc-200 bg-white px-2 text-center text-[12px] tabular-nums text-zinc-900 disabled:opacity-50"
                    />
                    <span className="text-[12px] text-zinc-500">分钟</span>
                  </div>
                </div>
              </div>

              {/* 最大自动恢复次数 */}
              <div className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-zinc-900">单任务最大自动恢复次数</div>
                  <div className="text-[11.5px] text-zinc-500">默认 1 次，达到上限后强制暂停自动续跑，杜绝崩溃死循环。</div>
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
                    <div className="text-[13px] font-medium text-zinc-900">多任务错峰启动间隔</div>
                    <div className="text-[11.5px] text-zinc-500">同时中断多个普通会话时按间隔排队拉起，防止并发打爆。</div>
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
              <span>内置硬性排除与防重复副作用机制</span>
            </div>
            <ul className="mt-1.5 space-y-1 text-[11.5px] leading-5 text-zinc-600">
              <li>• 严格排除「用户手动停止」（user_stopped）与已完成任务，绝不擅自重启用户取消的工作。</li>
              <li>• 严格排除主小猫自身及小猫督办（assistant_tasks）接管的侧边任务，避免双重恢复冲突。</li>
              <li>• 续跑轮次自动注入断点自检 Prompt，要求先核对工作区状态，严禁重复发消息/发版/删除等外部副作用操作。</li>
            </ul>
          </section>

          {/* 4. 最近审计与恢复记录 */}
          <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-2.5">
              <Clock size={14} className="shrink-0 text-zinc-500"/>
              <h3 className="text-[13px] font-semibold text-zinc-900">最近恢复审计记录</h3>
              <span className="ml-auto text-[11px] tabular-nums text-zinc-400">{records.length} 条</span>
            </div>
            {recordsQuery.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-5 text-[12px] text-zinc-400">
                <Spinner size={13} label="加载恢复记录" className="text-zinc-400"/>
                加载中…
              </div>
            ) : records.length === 0 ? (
              <div className="flex items-center gap-2 px-3.5 py-4 text-[12px] text-zinc-500">
                <Sparkles size={13} className="shrink-0 text-zinc-400"/>
                <span>暂无因服务重启触发的普通会话恢复记录。</span>
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
                          <span>中断于 {formatRecordTime(item.interruptedAt)}</span>
                          <span>·</span>
                          <span>策略：{taskRecoveryModeShortLabel(item.mode)}</span>
                        </div>
                      </div>
                      {onOpenSession && (
                        <button
                          type="button"
                          onClick={() => { onClose(); onOpenSession(item.sessionId); }}
                          className="ui-press inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
                        >
                          <span>查看</span>
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
    </div>
  );
}
