import { describe, expect, it } from 'vitest';
import { larkReactionEmojiOptions } from '@agent-dock/agent-dock-shared';
import {
  buildPrivateAnalysisPrompt,
  buildReactionPrompt,
  evaluateReactionTrigger,
  formatPrivateForwardMessage,
  intentFromUnknown,
  isReactionTriggerId,
  normalizeReactionEmoji,
  privateAnalysisDeliveryFromUnknown,
  privateAnalysisModeFromUnknown,
  reactionSummary,
  reactionTriggerKey,
  routeFromUnknown
} from './reaction-trigger.js';

const settings = {
  enabled: true,
  emoji: 'THUMBSUP',
  route: 'ask' as const,
  ignoreBots: true
};

const event = {
  messageId: 'om_1',
  emojiType: 'THUMBSUP',
  operatorId: 'ou_me',
  operatorType: 'user' as const
};

describe('normalizeReactionEmoji', () => {
  it('accepts Feishu emoji codes in several spellings', () => {
    expect(normalizeReactionEmoji('thumbsup')).toBe('THUMBSUP');
    expect(normalizeReactionEmoji(':DONE:')).toBe('DONE');
    expect(normalizeReactionEmoji(' 👍 ')).toBe('THUMBSUP');
    expect(normalizeReactionEmoji('❤️')).toBe('HEART');
    // 官方代码区分大小写：Fire / Trophy / Music 不能变成 FIRE / TROPHY / MUSIC。
    expect(normalizeReactionEmoji('fire')).toBe('Fire');
    expect(normalizeReactionEmoji('FIRE')).toBe('Fire');
    expect(normalizeReactionEmoji('Trophy')).toBe('Trophy');
    expect(normalizeReactionEmoji('2022')).toBe('2022');
    expect(normalizeReactionEmoji('2026')).toBe('2026');
    // 历史自定义值只要仍是代码形态就原样保留。
    expect(normalizeReactionEmoji('Legacy_Code')).toBe('Legacy_Code');
  });

  it('keeps every curated option canonical', () => {
    for (const option of larkReactionEmojiOptions) {
      expect(normalizeReactionEmoji(option.code), option.code).toBe(option.code);
    }
  });

  it('treats empty as disabled and rejects text or multiple emoji', () => {
    expect(normalizeReactionEmoji('')).toBe('');
    expect(normalizeReactionEmoji(undefined)).toBe('');
    expect(normalizeReactionEmoji('你好')).toBeUndefined();
    expect(normalizeReactionEmoji('👍👍')).toBeUndefined();
    expect(normalizeReactionEmoji('THUMB SUP')).toBeUndefined();
  });
});

describe('evaluateReactionTrigger', () => {
  it('ignores when disabled, emoji unset or emoji does not match', () => {
    expect(evaluateReactionTrigger({ settings: { ...settings, enabled: false }, event }).action).toBe('ignore');
    expect(evaluateReactionTrigger({ settings: { ...settings, enabled: false }, event })).toMatchObject({ reason: 'disabled' });
    expect(evaluateReactionTrigger({ settings: { ...settings, emoji: '' }, event })).toMatchObject({ reason: 'emoji_not_configured' });
    expect(evaluateReactionTrigger({ settings, event: { ...event, emojiType: 'SMILE' } })).toMatchObject({ reason: 'emoji_mismatch' });
  });

  it('excludes reactions the avatar added itself', () => {
    expect(evaluateReactionTrigger({ settings, event, selfReaction: true })).toMatchObject({ reason: 'self_reaction' });
  });

  it('checks bot events before the self-reaction token so bot echoes cannot consume it', () => {
    expect(evaluateReactionTrigger({
      settings,
      event: { ...event, operatorType: 'bot' },
      selfReaction: true
    })).toMatchObject({ reason: 'bot_reaction' });
  });

  it('excludes bot/app reactions by default and can be turned off', () => {
    expect(evaluateReactionTrigger({ settings, event: { ...event, operatorType: 'bot' } })).toMatchObject({ reason: 'bot_reaction' });
    expect(evaluateReactionTrigger({ settings, event: { ...event, operatorType: 'app' } })).toMatchObject({ reason: 'bot_reaction' });
    expect(evaluateReactionTrigger({
      settings: { ...settings, ignoreBots: false },
      event: { ...event, operatorType: 'bot' }
    })).toMatchObject({ action: 'trigger' });
  });

  it('returns the configured route and a stable dedupe key', () => {
    const decision = evaluateReactionTrigger({ settings: { ...settings, route: 'main' }, event });
    expect(decision).toMatchObject({ action: 'trigger', route: 'main', emoji: 'THUMBSUP' });
    if (decision.action !== 'trigger') throw new Error('expected trigger');
    expect(decision.key).toBe(reactionTriggerKey({ messageId: 'om_1', operatorId: 'ou_me', emoji: 'THUMBSUP' }));
    // 卡片 uuid / trigger_id 直接用这个 key：必须短、无 NUL、可安全放进 50 字符的飞书限制。
    expect(decision.key).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(decision.key).not.toContain('\u0000');
    expect(decision.key.length).toBeLessThanOrEqual(32);
    expect(isReactionTriggerId(decision.key)).toBe(true);
    // 同一输入稳定，不同 emoji/操作人必须不同。
    expect(reactionTriggerKey({ messageId: 'om_1', operatorId: 'ou_me', emoji: 'THUMBSUP' })).toBe(decision.key);
    expect(reactionTriggerKey({ messageId: 'om_1', operatorId: 'ou_me', emoji: 'OK' })).not.toBe(decision.key);
    expect(reactionTriggerKey({ messageId: 'om_1', operatorId: 'ou_other', emoji: 'THUMBSUP' })).not.toBe(decision.key);
  });
});

describe('buildReactionPrompt', () => {
  const message = {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatName: '测试群',
    chatType: 'group',
    senderId: 'ou_a',
    senderName: '张三',
    content: '把发布说明整理一下',
    messageType: 'text',
    createTime: '1700000000000'
  };

  it('marks the reacted message and keeps chat identity', () => {
    const prompt = buildReactionPrompt({
      emoji: 'THUMBSUP',
      route: 'main',
      target: message,
      context: [message],
      userId: 'ou_me',
      accountName: '我'
    });
    expect(prompt).toContain('添加了「THUMBSUP」表情');
    expect(prompt).toContain('← 表情触发目标');
    expect(prompt).toContain('名称：测试群');
    expect(prompt).toContain('Chat ID：oc_1');
    expect(prompt).toContain('不要向飞书发送消息');
  });

  it('falls back to the target when context is empty and summarises safely', () => {
    const prompt = buildReactionPrompt({ emoji: 'DONE', route: 'independent', target: message, context: [] });
    expect(prompt).toContain('最近 1 条消息');
    expect(reactionSummary(message)).toBe('张三：把发布说明整理一下');
  });

  it('includes intent guidance and private_chat forwarding boundary', () => {
    const summaryPrompt = buildReactionPrompt({
      emoji: 'THUMBSUP',
      route: 'private_chat',
      intent: 'summary',
      target: message,
      context: [message]
    });
    expect(summaryPrompt).toContain('任务意图（私密总结）');
    expect(summaryPrompt).toContain('私密转发到用户指定的私密飞书会话');
    expect(summaryPrompt).toContain('严禁向原飞书群发送任何消息');

    const analyzePrompt = buildReactionPrompt({
      emoji: 'THUMBSUP',
      route: 'main',
      intent: 'analyze',
      target: message,
      context: [message]
    });
    expect(analyzePrompt).toContain('任务意图（私密分析）');
  });
});

describe('buildPrivateAnalysisPrompt', () => {
  const sample = [{
    messageId: 'om_1',
    chatId: 'oc_boss_group',
    chatName: '产研核心群',
    chatType: 'group',
    senderId: 'ou_boss',
    senderName: '老板',
    content: '这周把发布节奏再收紧一下',
    messageType: 'text',
    createTime: '1700000000000'
  }];

  it('frames summary, analyze and custom modes with strict no-group-reply boundary', () => {
    const summary = buildPrivateAnalysisPrompt({
      mode: 'summary',
      delivery: 'main',
      chatId: 'oc_boss_group',
      chatName: '产研核心群',
      chatType: 'group',
      context: sample
    });
    expect(summary).toContain('私密群聊分析');
    expect(summary).toContain('产研核心群');
    expect(summary).toContain('老板: 这周把发布节奏再收紧一下');
    expect(summary).toContain('严禁向原飞书群发送任何消息');

    const analyze = buildPrivateAnalysisPrompt({
      mode: 'analyze',
      delivery: 'private_chat',
      chatId: 'oc_boss_group',
      chatName: '产研核心群',
      chatType: 'group',
      prompt: '重点看排期风险',
      context: sample
    });
    expect(analyze).toContain('拆解核心痛点/诉求');
    expect(analyze).toContain('重点看排期风险');
    expect(analyze).toContain('飞书私密接收会话');

    const custom = buildPrivateAnalysisPrompt({
      mode: 'custom',
      delivery: 'independent',
      chatId: 'oc_boss_group',
      prompt: '帮我起草一份不卑不亢的回复',
      context: []
    });
    expect(custom).toContain('帮我起草一份不卑不亢的回复');
    expect(custom).toContain('当前未拉取到文字消息');
  });

  it('formats forwarded private message with source group label', () => {
    expect(formatPrivateForwardMessage({
      chatId: 'oc_boss_group',
      chatName: '产研核心群',
      modeLabel: '总结群消息',
      body: '1. 结论 A\n2. 待办 B'
    })).toBe('【总结群消息 · 产研核心群】\n1. 结论 A\n2. 待办 B');
  });
});

describe('routeFromUnknown and intent/mode helpers', () => {
  it('accepts only known routes, intents, modes and deliveries', () => {
    expect(routeFromUnknown('ask')).toBe('ask');
    expect(routeFromUnknown('main')).toBe('main');
    expect(routeFromUnknown('independent')).toBe('independent');
    expect(routeFromUnknown('private_chat')).toBe('private_chat');
    expect(routeFromUnknown('nope')).toBeUndefined();

    expect(intentFromUnknown('auto')).toBe('auto');
    expect(intentFromUnknown('summary')).toBe('summary');
    expect(intentFromUnknown('analyze')).toBe('analyze');
    expect(intentFromUnknown('other')).toBeUndefined();

    expect(privateAnalysisModeFromUnknown('summary')).toBe('summary');
    expect(privateAnalysisModeFromUnknown('analyze')).toBe('analyze');
    expect(privateAnalysisModeFromUnknown('custom')).toBe('custom');
    expect(privateAnalysisModeFromUnknown('x')).toBeUndefined();

    expect(privateAnalysisDeliveryFromUnknown('main')).toBe('main');
    expect(privateAnalysisDeliveryFromUnknown('independent')).toBe('independent');
    expect(privateAnalysisDeliveryFromUnknown('private_chat')).toBe('private_chat');
    expect(privateAnalysisDeliveryFromUnknown('ask')).toBeUndefined();
  });
});
