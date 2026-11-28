import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  TASK_RECOVERY_ORIGIN,
  type AskUserQuestionSpec,
  type ConfirmActionSpec,
  type OutputPluginDefinition,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { setActiveServerLocaleForTest } from '../locale-service.js';
import { buildLarkCard } from './service.js';
import { classifyTurnSource, formatSyncedTaskName } from './turn-sync.js';
import { renderLarkCardElements } from './listener.js';
import { buildLarkAskUserQuestionAnsweredCard, buildLarkAskUserQuestionCard, parseLarkAskUserQuestionAction } from './ask-user-question-card.js';
import { confirmActionLarkAdapter } from './output-plugins/confirm-action-adapter.js';
import { createDeclarativeLarkAdapter } from './output-plugins/declarative-adapter.js';
import { buildTaskRecoveryConfirmCard, buildTaskRecoveryResolvedCard } from '../task-recovery/lark-card.js';

const CJK_RE = /[\u4e00-\u9fff]/;

afterEach(() => {
  setActiveServerLocaleForTest(undefined);
});

describe('Lark cards & badges bilingual rendering (zh-CN & en-US)', () => {
  it('localizes turn-sync source badges and detail labels in both languages', () => {
    expect(classifyTurnSource({ taskOrigin: 'injected', prompt: '📋 督办 [review] 等待验收', locale: 'zh-CN' }))
      .toMatchObject({ badge: '🐾 小猫督办', detailLabel: '验收督办' });
    expect(classifyTurnSource({ taskOrigin: 'injected', prompt: '📋 督办 [review] 等待验收', locale: 'en-US' }))
      .toMatchObject({ badge: '🐾 Companion', detailLabel: 'Review' });

    expect(classifyTurnSource({ taskOrigin: 'web', locale: 'en-US' }).badge).toBe('💻 Web Sync');
    expect(classifyTurnSource({ taskOrigin: 'schedule', locale: 'en-US' }).badge).toBe('⏰ Schedule');
    expect(classifyTurnSource({ taskOrigin: TASK_RECOVERY_ORIGIN, locale: 'en-US' }).badge).toBe('🔄 Auto-Recovery');
    expect(classifyTurnSource({ taskOrigin: 'maintenance', locale: 'en-US' }).badge).toBe('🧹 Maintenance');
    expect(classifyTurnSource({ taskOrigin: 'handoff', locale: 'en-US' }).badge).toBe('🧹 Handover');
  });

  it('renders Lark Trace card with zero CJK chrome when server locale is en-US', () => {
    setActiveServerLocaleForTest('en-US');
    const elements = renderLarkCardElements(
      [
        { id: '1', sessionId: 'ses_1', taskId: 't1', type: 'thinking', sequence: 1, timestamp: '2026-11-28T05:00:00Z', data: { text: 'Inspecting files' } },
        { id: '2', sessionId: 'ses_1', taskId: 't1', type: 'tool_call', sequence: 2, timestamp: '2026-11-28T05:00:01Z', data: { id: 'tc1', name: 'read_file', input: { path: 'README.md' }, status: 'completed' } },
        { id: '3', sessionId: 'ses_1', taskId: 't1', type: 'text', sequence: 3, timestamp: '2026-11-28T05:00:02Z', data: { role: 'assistant', text: 'All checks passed.' } }
      ],
      { traceLimit: 20 },
      true
    );
    const card = buildLarkCard({
      state: 'completed',
      taskName: 'Build Verification',
      taskId: '42',
      sessionId: 'ses_1',
      webBaseUrl: 'http://127.0.0.1:4310',
      elapsedSeconds: 18,
      sourceBadge: { label: '💻 Web Sync', color: 'blue' },
      elements
    });

    const json = JSON.stringify(card);
    expect(json).toContain('Task #42 · Elapsed 18s');
    expect(json).toContain('View Details');
    expect(json).toContain('1 steps');
    expect(json).toContain('Thinking');
    expect(CJK_RE.test(json), `English Lark Trace card leaked CJK: ${json}`).toBe(false);
  });

  it('renders AskUserQuestion, ConfirmAction, Declarative, and TaskRecovery cards cleanly in en-US and zh-CN', () => {
    const askSpec: AskUserQuestionSpec = {
      id: 'q_db',
      title: 'Storage Choice',
      questions: [{
        id: 'q1',
        prompt: 'Pick a storage engine',
        multi: false,
        allowOther: true,
        options: [
          { value: 'sqlite', label: 'SQLite', recommended: true, description: 'Zero-ops embedded DB' },
          { value: 'pg', label: 'PostgreSQL' }
        ]
      }]
    };
    const askEn = JSON.stringify(buildLarkAskUserQuestionCard({ cardId: 'c1', spec: askSpec, sessionId: 's1', webBaseUrl: 'http://127.0.0.1:4310', locale: 'en-US' }));
    expect(askEn).toContain('Recommended');
    expect(askEn).toContain('Submit Custom Answer');
    expect(askEn).toContain('Open Session in AgentDock');
    expect(CJK_RE.test(askEn), `English AskUserQuestion card leaked CJK: ${askEn}`).toBe(false);

    const askAnsweredEn = JSON.stringify(buildLarkAskUserQuestionAnsweredCard({
      payload: {
        version: 1,
        questionId: 'q_db',
        title: 'Storage Choice',
        source: 'assistant',
        answeredAt: '2026-11-28T05:00:00Z',
        answers: [{ questionId: 'q1', prompt: 'Pick a storage engine', selectedValues: ['sqlite'], selectedLabels: ['SQLite'] }]
      },
      locale: 'en-US'
    }));
    expect(askAnsweredEn).toContain('🐾 Kitten Answered');
    expect(askAnsweredEn).toContain('Answered');
    expect(CJK_RE.test(askAnsweredEn), `English AskUserQuestion answered card leaked CJK: ${askAnsweredEn}`).toBe(false);

    const confirmSpec: ConfirmActionSpec = {
      id: 'act_1',
      title: 'Deploy Production',
      summary: 'Roll out v0.3.30',
      risk: 'high',
      details: [{ label: 'Cluster', value: 'prod-us' }],
      confirmLabel: 'Confirm Deploy',
      cancelLabel: 'Cancel',
      allowComment: true
    };
    const confirmPlugin = { id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID, name: 'ConfirmAction' } as OutputPluginDefinition;
    const confirmEn = JSON.stringify(confirmActionLarkAdapter.buildCard({
      cardId: 'c2',
      plugin: confirmPlugin,
      spec: confirmSpec,
      sessionId: 's1',
      webBaseUrl: 'http://127.0.0.1:4310',
      locale: 'en-US'
    }));
    expect(confirmEn).toContain('High Risk');
    expect(confirmEn).toContain('Submit with Comment');
    expect(CJK_RE.test(confirmEn), `English ConfirmAction card leaked CJK: ${confirmEn}`).toBe(false);

    const declPlugin = {
      id: 'custom:release-check',
      name: 'Release Check',
      capabilities: { web: true, lark: true, interactive: true, streamingPlaceholder: true }
    } as OutputPluginDefinition;
    const declAdapter = createDeclarativeLarkAdapter(declPlugin);
    const declEn = JSON.stringify(declAdapter.buildCard({
      cardId: 'c3',
      plugin: declPlugin,
      spec: {
        id: 'rel_1',
        kind: 'action-card',
        title: 'Release Approval',
        tone: 'sky',
        fields: [{ name: 'ver', label: 'Version', type: 'text', value: '0.3.30', required: false, options: [] }],
        actions: [{ value: 'ship', label: 'Ship It', style: 'primary' }],
        links: [],
        allowNote: true
      },
      locale: 'en-US'
    }));
    expect(declEn).toContain('Submit with Note');
    expect(CJK_RE.test(declEn), `English Declarative card leaked CJK: ${declEn}`).toBe(false);

    const recoveryRecord: TaskRecoveryRecord = {
      id: 'rec_1',
      sessionId: 'ses_1',
      interruptedTaskId: 't_1',
      rootTaskId: 't_1',
      originalPrompt: 'Run integration tests',
      interruptReason: 'daemon_restart',
      interruptedAt: '2026-11-28T05:00:00Z',
      detectedAt: '2026-11-28T05:01:00Z',
      mode: 'confirm',
      status: 'pending_confirm',
      attemptCount: 0,
      createdAt: '2026-11-28T05:01:00Z',
      updatedAt: '2026-11-28T05:01:00Z'
    };
    const recConfirmEn = JSON.stringify(buildTaskRecoveryConfirmCard({
      record: recoveryRecord,
      cardId: 'rc1',
      webBaseUrl: 'http://127.0.0.1:4310',
      locale: 'en-US'
    }));
    expect(recConfirmEn).toContain('Task Interrupted by Restart');
    expect(recConfirmEn).toContain('Resume (Safe Checkpoint Check)');
    expect(CJK_RE.test(recConfirmEn), `English TaskRecovery confirm card leaked CJK: ${recConfirmEn}`).toBe(false);

    const recResolvedEn = JSON.stringify(buildTaskRecoveryResolvedCard({
      record: { ...recoveryRecord, status: 'resumed', decidedSource: 'lark', decidedBy: 'Alice', decidedAt: '2026-11-28T05:02:00Z' },
      webBaseUrl: 'http://127.0.0.1:4310',
      locale: 'en-US'
    }));
    expect(recResolvedEn).toContain('Execution Resumed');
    expect(recResolvedEn).toContain('Lark · Alice');
    expect(CJK_RE.test(recResolvedEn), `English TaskRecovery resolved card leaked CJK: ${recResolvedEn}`).toBe(false);

    // Chinese baseline remains intact
    const recConfirmZh = JSON.stringify(buildTaskRecoveryConfirmCard({
      record: recoveryRecord,
      cardId: 'rc1',
      locale: 'zh-CN'
    }));
    expect(recConfirmZh).toContain('任务因服务重启中断');
    expect(recConfirmZh).toContain('继续执行（断点自检续跑）');

    // Validation error messages & synced task names obey locale
    const invalidAskEn = parseLarkAskUserQuestionAction(askSpec, 'ask_user_question_submit', {}, {}, 'en-US');
    expect(invalidAskEn.ok).toBe(false);
    if (!invalidAskEn.ok) {
      expect(CJK_RE.test(invalidAskEn.error)).toBe(false);
    }
    const webSourceEn = classifyTurnSource({ taskOrigin: undefined, prompt: 'Check build status', locale: 'en-US' });
    const webTaskNameEn = formatSyncedTaskName('Check build status', webSourceEn, undefined, undefined, [], 'en-US');
    expect(webTaskNameEn).toBe('Q: Check build status');
    expect(CJK_RE.test(webTaskNameEn)).toBe(false);
  });
});
