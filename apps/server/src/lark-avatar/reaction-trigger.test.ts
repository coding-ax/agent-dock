import { describe, expect, it } from 'vitest';
import { larkReactionEmojiOptions } from '@agent-dock/agent-dock-shared';
import {
  buildReactionPrompt,
  evaluateReactionTrigger,
  isReactionTriggerId,
  normalizeReactionEmoji,
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
});

describe('routeFromUnknown', () => {
  it('accepts only supported reaction routes and rejects removed private_chat', () => {
    expect(routeFromUnknown('ask')).toBe('ask');
    expect(routeFromUnknown('main')).toBe('main');
    expect(routeFromUnknown('independent')).toBe('independent');
    expect(routeFromUnknown('private_chat')).toBeUndefined();
    expect(routeFromUnknown('nope')).toBeUndefined();
  });
});
