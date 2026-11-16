import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { larkReactionEmojiOptions, normalizeLarkReactionEmoji } from '@agent-dock/agent-dock-shared';
import { ReactionEmojiOptionList } from './ReactionEmojiPicker';
import {
  reactionEmojiIsCustom,
  reactionEmojiPayload,
  reactionEmojiRows,
  reactionEmojiSelection
} from './lark-avatar-emoji';

describe('reaction emoji options', () => {
  it('renders every curated emoji with a preview, label and real Feishu code', () => {
    const rows = reactionEmojiRows('');
    expect(rows.length).toBeGreaterThan(20);
    expect(new Set(rows.map(row => row.code)).size).toBe(rows.length);
    expect(rows.every(row => row.emoji && row.label && row.code)).toBe(true);
    for (const row of rows) expect(row.custom).toBe(false);

    const codes = rows.map(row => row.code);
    expect(codes).toEqual(expect.arrayContaining([
      'THUMBSUP', 'OK', 'DONE', 'HEART', 'SMILE', 'LAUGH', 'Fire', 'PARTY', 'GLANCE', 'CLAP'
    ]));
    // 混合大小写是飞书官方代码的一部分，不能被统一转大写。
    expect(codes).toContain('Fire');
    expect(codes).not.toContain('FIRE');
    expect(codes).not.toContain('EYES');

    const markup = renderToStaticMarkup(createElement(ReactionEmojiOptionList, { value: 'DONE', onPick: () => undefined }));
    expect(markup).toContain('👍');
    expect(markup).toContain('点赞');
    expect(markup).toContain('THUMBSUP');
    expect(markup).toContain('🔥');
    expect(markup).toContain('Fire');
    expect(markup).toContain('data-emoji-code="DONE"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup.match(/role="option"/g)?.length).toBe(rows.length + 1);
  });

  it('keeps every curated code canonical through the shared normalizer', () => {
    for (const option of larkReactionEmojiOptions) {
      expect(normalizeLarkReactionEmoji(option.code), option.code).toBe(option.code);
    }
  });

  it('echoes the selected option in the trigger button', () => {
    expect(reactionEmojiSelection('DONE')).toEqual({ code: 'DONE', emoji: '✅', label: '完成', custom: false });
    expect(reactionEmojiSelection('Fire')).toMatchObject({ code: 'Fire', emoji: '🔥', custom: false });
    expect(reactionEmojiSelection('')).toBeUndefined();
  });

  it('keeps a historical custom value instead of clearing it', () => {
    const rows = reactionEmojiRows('Legacy_Code');
    expect(rows[0]).toEqual({
      code: 'Legacy_Code',
      emoji: '•',
      label: '当前配置（不在常用集合）',
      custom: true
    });
    expect(reactionEmojiSelection('Legacy_Code')).toMatchObject({ code: 'Legacy_Code', label: '当前值', custom: true });
    expect(reactionEmojiIsCustom('Legacy_Code')).toBe(true);
    expect(reactionEmojiIsCustom('DONE')).toBe(false);

    const markup = renderToStaticMarkup(createElement(ReactionEmojiOptionList, { value: 'Legacy_Code', onPick: () => undefined }));
    expect(markup).toContain('Legacy_Code');
    expect(markup).toContain('当前配置（不在常用集合）');
    expect(markup).toContain('不在常用集合，仍会保留');
  });

  it('writes the selected value back as reactionTriggerEmoji', () => {
    expect(reactionEmojiPayload('THUMBSUP')).toEqual({ reactionTriggerEmoji: 'THUMBSUP' });
    expect(reactionEmojiPayload('Fire')).toEqual({ reactionTriggerEmoji: 'Fire' });
    expect(reactionEmojiPayload(' Legacy_Code ')).toEqual({ reactionTriggerEmoji: 'Legacy_Code' });
    expect(reactionEmojiPayload('')).toEqual({ reactionTriggerEmoji: '' });
  });
});
