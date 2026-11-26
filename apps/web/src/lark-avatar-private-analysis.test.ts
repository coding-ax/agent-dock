import { describe, expect, it } from 'vitest';
import {
  PRIVATE_ANALYSIS_DELIVERIES,
  PRIVATE_ANALYSIS_MODES,
  REACTION_INTENT_OPTIONS,
  REACTION_ROUTE_OPTIONS,
  privateAnalysisSuccessMessage,
  validatePrivateAnalysisSubmission
} from './lark-avatar-private-analysis';

describe('lark-avatar private analysis helpers', () => {
  it('validates custom prompts and prevents forwarding to the same group', () => {
    expect(validatePrivateAnalysisSubmission({
      chatId: '',
      mode: 'summary',
      prompt: '',
      delivery: 'main',
      privateReplyChatId: ''
    })).toContain('选择要分析的会话');

    expect(validatePrivateAnalysisSubmission({
      chatId: 'oc_boss',
      mode: 'custom',
      prompt: '   ',
      delivery: 'main',
      privateReplyChatId: ''
    })).toContain('输入想私密问 AI 的问题');

    expect(validatePrivateAnalysisSubmission({
      chatId: 'oc_boss',
      mode: 'summary',
      prompt: '',
      delivery: 'private_chat',
      privateReplyChatId: ''
    })).toContain('私密接收会话');

    expect(validatePrivateAnalysisSubmission({
      chatId: 'oc_boss',
      mode: 'analyze',
      prompt: '',
      delivery: 'private_chat',
      privateReplyChatId: 'oc_boss'
    })).toContain('已拦截发送');

    expect(validatePrivateAnalysisSubmission({
      chatId: 'oc_boss',
      mode: 'summary',
      prompt: '',
      delivery: 'main',
      privateReplyChatId: ''
    })).toBeNull();

    expect(validatePrivateAnalysisSubmission({
      chatId: 'oc_boss',
      mode: 'analyze',
      prompt: '重点看排期',
      delivery: 'private_chat',
      privateReplyChatId: 'oc_self'
    })).toBeNull();
  });

  it('formats user-facing success copy without leaking to the target group', () => {
    expect(privateAnalysisSuccessMessage({ delivery: 'main', contextCount: 25 }))
      .toContain('最近 25 条消息');
    expect(privateAnalysisSuccessMessage({ delivery: 'independent', contextCount: 0 }))
      .toContain('独立私密会话');
    expect(privateAnalysisSuccessMessage({ delivery: 'private_chat', contextCount: 12, targetChatName: '文件传输助手' }))
      .toContain('文件传输助手');
  });

  it('exposes complete mode, delivery, route and intent option sets', () => {
    expect(PRIVATE_ANALYSIS_MODES.map(item => item.value)).toEqual(['summary', 'analyze', 'custom']);
    expect(PRIVATE_ANALYSIS_DELIVERIES.map(item => item.value)).toEqual(['main', 'independent', 'private_chat']);
    expect(REACTION_ROUTE_OPTIONS.map(item => item.value)).toEqual(['main', 'independent', 'private_chat', 'ask']);
    expect(REACTION_INTENT_OPTIONS.map(item => item.value)).toEqual(['auto', 'summary', 'analyze']);
  });
});
