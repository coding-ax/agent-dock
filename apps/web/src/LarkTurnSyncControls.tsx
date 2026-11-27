import { Switch } from 'antd';
import { Info } from 'lucide-react';
import type { LarkTurnSyncConfig, LarkTurnSyncSources } from './api';
import { Disclosure } from './Disclosure';

interface LarkTurnSyncSourceOption {
  key: keyof LarkTurnSyncSources;
  title: string;
  badge: string;
  badgeClass: string;
  description: string;
}

export type LarkTurnSyncTargetKind = 'settings' | 'handover' | 'lark-group' | 'lark-p2p';

const SOURCE_OPTIONS: readonly LarkTurnSyncSourceOption[] = [
  {
    key: 'supervision',
    title: '系统督办轮次',
    badge: '小猫督办',
    badgeClass: 'border-amber-200 bg-amber-50 text-amber-700',
    description: '主会话的侧边会话完工验收、打回返工、计划待确认与卡死/失败预警。'
  },
  {
    key: 'web',
    title: 'Web 端对话轮次',
    badge: '网页同步',
    badgeClass: 'border-blue-200 bg-blue-50 text-blue-700',
    description: '在网页或桌面端发出的对话及看板联动回复，实现双端同屏。'
  },
  {
    key: 'schedule',
    title: '定时任务轮次',
    badge: '定时任务',
    badgeClass: 'border-orange-200 bg-orange-50 text-orange-700',
    description: '追加到绑定会话的定时任务触发产出。'
  },
  {
    key: 'maintenance',
    title: '整理维护轮次',
    badge: '整理维护',
    badgeClass: 'border-zinc-200 bg-zinc-100 text-zinc-600',
    description: '自动整理归档便签与换代交接说明（默认关闭，避免长篇维护日志刷屏）。'
  }
] as const;

const TARGET_COPY: Record<LarkTurnSyncTargetKind, { title: string; description: string; footer: string }> = {
  settings: {
    title: '同步非飞书触发轮次到飞书',
    description: '实时将托管群、普通飞书群聊与飞书私聊绑定会话中的非飞书轮次同步回对应飞书（群聊直发主线程，私聊直发对话）；同轮已通过 group send 主动发过消息时自动跳过，避免双倍刷屏。',
    footer: '复用机器人既有 Trace 卡片 / 静默回复策略；群聊始终直发主线程不建话题，私聊直发对话，并自动屏蔽机器人自激循环。'
  },
  handover: {
    title: '同步非飞书触发轮次到当前托管群',
    description: '实时将当前会话的非飞书轮次直发至托管群主线程；同轮已通过 group send 主动发过群消息时自动跳过，避免双倍刷屏。',
    footer: '复用机器人既有 Trace 卡片 / 静默回复策略；始终直发群主线程不建话题，并自动屏蔽机器人自激循环。'
  },
  'lark-group': {
    title: '同步非飞书触发轮次到当前飞书群',
    description: '实时将网页对话、定时任务等非飞书轮次直发至原飞书群主线程；同轮已通过 group send 主动发过群消息时自动跳过，避免双倍刷屏。',
    footer: '复用机器人既有 Trace 卡片 / 静默回复策略；始终直发群主线程不建话题，并自动屏蔽机器人自激循环。'
  },
  'lark-p2p': {
    title: '同步非飞书触发轮次到当前飞书私聊',
    description: '实时将网页对话、定时任务等非飞书触发轮次直发至当前飞书私聊，实现 Web 与飞书双端同屏；自动去重并避免刷屏。',
    footer: '复用机器人既有 Trace 卡片 / 静默回复策略；始终直发当前私聊并自动屏蔽机器人自激循环。'
  }
};

export function summarizeLarkTurnSync(config: LarkTurnSyncConfig): string {
  if (!config.enabled) return '已关闭';
  const labels = SOURCE_OPTIONS.filter(item => config.sources[item.key]).map(item => item.badge);
  return labels.length ? `已开启（${labels.join(' / ')}）` : '已开启（未勾选来源）';
}

export function LarkTurnSyncControls({
  value,
  onChange,
  variant = 'settings',
  targetKind = 'settings',
  disabled = false
}: {
  value: LarkTurnSyncConfig;
  onChange: (next: LarkTurnSyncConfig) => void;
  variant?: 'settings' | 'compact';
  targetKind?: LarkTurnSyncTargetKind;
  disabled?: boolean;
}) {
  const compact = variant === 'compact';
  const padX = compact ? 'px-3' : 'px-4';
  const padY = compact ? 'py-2.5' : 'py-3';
  const copy = TARGET_COPY[targetKind];

  const setEnabled = (enabled: boolean) => {
    onChange({ ...value, enabled });
  };

  const setSource = (key: keyof LarkTurnSyncSources, checked: boolean) => {
    onChange({
      ...value,
      sources: {
        ...value.sources,
        [key]: checked
      }
    });
  };

  const setFilterSilentSchedule = (checked: boolean) => {
    onChange({ ...value, filterSilentSchedule: checked });
  };

  return (
    <div data-testid="lark-turn-sync-controls" className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className={`flex items-start justify-between gap-3 ${padX} ${padY}`}>
        <div className="min-w-0 flex-1">
          <div className={`${compact ? 'text-[13px]' : 'text-[14px]'} font-medium text-zinc-900`}>
            {copy.title}
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-zinc-500">
            {copy.description}
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          <Switch
            size="small"
            aria-label={copy.title}
            checked={value.enabled}
            disabled={disabled}
            onChange={setEnabled}
          />
        </div>
      </div>

      <Disclosure open={value.enabled}>
        <div className="border-t border-zinc-100 bg-zinc-50/50">
          {SOURCE_OPTIONS.map((item, idx) => (
            <div key={item.key} className={idx > 0 ? 'border-t border-zinc-100' : ''}>
              <div className={`flex items-start justify-between gap-3 ${padX} py-2.5`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12.5px] font-medium text-zinc-800">{item.title}</span>
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${item.badgeClass}`}>
                      {item.badge}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-4 text-zinc-500">{item.description}</p>
                </div>
                <div className="shrink-0 pt-0.5">
                  <Switch
                    size="small"
                    aria-label={item.title}
                    checked={value.sources[item.key]}
                    disabled={disabled}
                    onChange={checked => setSource(item.key, checked)}
                  />
                </div>
              </div>

              {item.key === 'schedule' && (
                <Disclosure open={value.sources.schedule}>
                  <div className="mx-3 mb-2.5 flex items-start justify-between gap-3 rounded-lg border border-zinc-200/80 bg-white px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-zinc-700">过滤静默/无动作定时轮次</div>
                      <p className="mt-0.5 text-[11.5px] leading-4 text-zinc-500">
                        仅输出「无异常/无变化/HEARTBEAT_OK」等无动作结果时自动跳过，失败与实质汇报始终推送。
                      </p>
                    </div>
                    <div className="shrink-0 pt-0.5">
                      <Switch
                        size="small"
                        aria-label="过滤静默或无动作定时轮次"
                        checked={value.filterSilentSchedule}
                        disabled={disabled}
                        onChange={setFilterSilentSchedule}
                      />
                    </div>
                  </div>
                </Disclosure>
              )}
            </div>
          ))}

          <div className={`flex items-start gap-1.5 border-t border-zinc-100 ${padX} py-2.5 text-[11.5px] leading-4 text-zinc-500`}>
            <Info size={13} className="mt-0.5 shrink-0 text-zinc-400"/>
            <span>{copy.footer}</span>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
