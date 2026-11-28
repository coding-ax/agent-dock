import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  buildRecoveryAgentPrompt,
  TASK_RECOVERY_ORIGIN,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { shouldRenderRecoveryCard, TaskRecoveryConfirmCard, TaskRecoveryNotice } from './TaskRecoveryTimeline';
import { TaskRecoverySettingsDialog, taskRecoveryModeShortLabel } from './TaskRecoverySettingsDialog';
import { TimelineItem } from './TimelineItems';
import { TooltipProvider } from './HoverTooltip';
import type { TimelineEvent } from './timeline';

function makeRecord(overrides: Partial<TaskRecoveryRecord> = {}): TaskRecoveryRecord {
  return {
    id: 'rec_ui_1',
    sessionId: 'ses_ui_1',
    interruptedTaskId: 'task_ui_1',
    rootTaskId: 'task_ui_1',
    originalPrompt: '重构账单导出接口并验证单测',
    originalOrigin: null,
    interruptReason: 'daemon_restart',
    interruptedAt: '2026-11-28T06:58:00.000Z',
    detectedAt: '2026-11-28T07:00:00.000Z',
    mode: 'confirm',
    status: 'pending_confirm',
    skipReason: null,
    attemptCount: 0,
    recoveryTaskId: null,
    decidedSource: null,
    decidedBy: null,
    decidedAt: null,
    larkAppId: null,
    larkChatId: null,
    larkMessageId: null,
    larkCardId: null,
    createdAt: '2026-11-28T07:00:00.000Z',
    updatedAt: '2026-11-28T07:00:00.000Z',
    ...overrides
  };
}

describe('TaskRecoveryTimeline components', () => {
  it('filters which recovery records render cards without duplicating auto-resumed turns', () => {
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'pending_confirm' }))).toBe(true);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'scheduled', mode: 'auto' }))).toBe(true);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'dismissed' }))).toBe(true);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'resumed', mode: 'confirm' }))).toBe(true);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'resumed', mode: 'auto' }))).toBe(false);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'skipped', skipReason: 'max_attempts' }))).toBe(true);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'skipped', skipReason: 'stale' }))).toBe(true);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'skipped', skipReason: 'mode_off' }))).toBe(false);
    expect(shouldRenderRecoveryCard(makeRecord({ status: 'skipped', skipReason: 'user_stopped' }))).toBe(false);
  });

  it('renders TaskRecoveryNotice for recovery origin turns inside TimelineItem instead of a raw user bubble', () => {
    const detail = buildRecoveryAgentPrompt({
      interruptedTaskId: 'task_ui_1',
      interruptedAt: '2026-11-28T06:58:00.000Z',
      originalPrompt: '重构账单导出接口并验证单测',
      triggerSource: 'auto',
      attemptNumber: 1,
      maxAutoAttempts: 1
    });
    const event: TimelineEvent = {
      id: 'evt_rec_1',
      sequence: 5,
      type: 'text',
      timestamp: '2026-11-28T07:00:10.000Z',
      data: {
        role: 'user',
        origin: TASK_RECOVERY_ORIGIN,
        text: '🔄 断点续跑：重构账单导出接口并验证单测',
        detail,
        taskId: 'task_rec_1'
      }
    };
    const html = renderToStaticMarkup(createElement(TimelineItem, { event, sessionId: 'ses_ui_1' }));
    expect(html).toContain('data-task-recovery-turn');
    expect(html).toContain('断点续跑');
    expect(html).toContain('自动恢复');
    expect(html).toContain('重构账单导出接口并验证单测');
    expect(html).toContain('查看完整续跑指令');
    expect(html).not.toContain('ui-user-bubble');
  });

  it('renders TaskRecoveryNotice with Lark confirmation source badge when resumed from Feishu', () => {
    const html = renderToStaticMarkup(createElement(TaskRecoveryNotice, {
      text: '🔄 断点续跑：检查发布流水线',
      detail: '[AgentDock 系统断点续跑指令]\n用户在飞书确认卡点击「继续执行」',
      timestamp: '2026-11-28T07:01:00.000Z',
      recoveryRecord: makeRecord({ status: 'resumed', decidedSource: 'lark', decidedBy: '暮雪离歌' })
    }));
    expect(html).toContain('data-recovery-source="lark"');
    expect(html).toContain('飞书 · 暮雪离歌');
  });

  it('renders pending, scheduled, locked-resumed, locked-dismissed, and guardrail-skipped states on TaskRecoveryConfirmCard', () => {
    const pendingHtml = renderToStaticMarkup(createElement(TaskRecoveryConfirmCard, {
      record: makeRecord({ larkMessageId: 'om_lark_1' }),
      onDecide: vi.fn()
    }));
    expect(pendingHtml).toContain('data-task-recovery-card="pending_confirm"');
    expect(pendingHtml).toContain('任务因服务重启中断，是否继续执行？');
    expect(pendingHtml).toContain('继续执行');
    expect(pendingHtml).toContain('放弃 / 取消');
    expect(pendingHtml).toContain('已同步至绑定飞书');

    const scheduledHtml = renderToStaticMarkup(createElement(TaskRecoveryConfirmCard, {
      record: makeRecord({ status: 'scheduled', mode: 'auto' })
    }));
    expect(scheduledHtml).toContain('data-task-recovery-card="scheduled"');
    expect(scheduledHtml).toContain('错峰排队自动断点续跑');

    const resumedHtml = renderToStaticMarkup(createElement(TaskRecoveryConfirmCard, {
      record: makeRecord({ status: 'resumed', decidedSource: 'web', decidedAt: '2026-11-28T07:02:00.000Z' })
    }));
    expect(resumedHtml).toContain('data-task-recovery-card="resumed"');
    expect(resumedHtml).toContain('已确认继续执行');
    expect(resumedHtml).toContain('网页端确认');
    expect(resumedHtml).not.toContain('data-task-recovery-action="resume"');

    const dismissedHtml = renderToStaticMarkup(createElement(TaskRecoveryConfirmCard, {
      record: makeRecord({ status: 'dismissed', decidedSource: 'lark', decidedBy: '暮雪离歌', decidedAt: '2026-11-28T07:02:00.000Z' })
    }));
    expect(dismissedHtml).toContain('data-task-recovery-card="dismissed"');
    expect(dismissedHtml).toContain('已放弃本次断点续跑');
    expect(dismissedHtml).toContain('飞书 · 暮雪离歌');

    const maxAttemptsHtml = renderToStaticMarkup(createElement(TaskRecoveryConfirmCard, {
      record: makeRecord({ status: 'skipped', skipReason: 'max_attempts', attemptCount: 1 })
    }));
    expect(maxAttemptsHtml).toContain('防重启循环护栏');

    const staleHtml = renderToStaticMarkup(createElement(TaskRecoveryConfirmCard, {
      record: makeRecord({ status: 'skipped', skipReason: 'stale' })
    }));
    expect(staleHtml).toContain('超过恢复时间窗口');
  });
});

describe('TaskRecoverySettingsDialog', () => {
  it('formats short mode labels cleanly', () => {
    expect(taskRecoveryModeShortLabel('auto')).toBe('自动续跑');
    expect(taskRecoveryModeShortLabel('confirm')).toBe('确认卡');
    expect(taskRecoveryModeShortLabel('off')).toBe('已关闭');
  });

  it('renders all three recovery strategies, guardrails, and recent records cleanly', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    queryClient.setQueryData(['task-recovery-config'], {
      config: { mode: 'auto', windowMinutes: 15, maxAutoAttempts: 1, staggerSeconds: 3 }
    });
    queryClient.setQueryData(['task-recovery-records'], {
      items: [makeRecord({ status: 'pending_confirm' })]
    });

    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient },
        createElement(TooltipProvider, null,
          createElement(TaskRecoverySettingsDialog, { onClose: vi.fn(), onOpenSession: vi.fn() })
        )
      )
    );
    expect(html).toContain('普通会话中断自动恢复');
    expect(html).toContain('task-recovery-mode-auto');
    expect(html).toContain('task-recovery-mode-confirm');
    expect(html).toContain('task-recovery-mode-off');
    expect(html).toContain('有效时间窗口');
    expect(html).toContain('单任务最大自动恢复次数');
    expect(html).toContain('多任务错峰启动间隔');
    expect(html).toContain('重构账单导出接口并验证单测');
  });
});
