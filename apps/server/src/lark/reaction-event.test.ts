import { describe, expect, it } from 'vitest';
import { parseLarkReactionEvent } from './listener.js';

describe('parseLarkReactionEvent', () => {
  it('keeps message, emoji, operator and action time from a user reaction', () => {
    expect(parseLarkReactionEvent({
      message_id: 'om_1',
      reaction_type: { emoji_type: 'THUMBSUP' },
      operator_type: 'user',
      user_id: { open_id: 'ou_me', union_id: 'on_me' },
      action_time: '1767225600000'
    })).toEqual({
      messageId: 'om_1',
      emojiType: 'THUMBSUP',
      operatorType: 'user',
      operatorId: 'ou_me',
      operatorIdentity: 'open_id',
      actionTime: '1767225600000'
    });
  });

  it('marks events that only carry user_id/union_id so authorization can fail closed', () => {
    expect(parseLarkReactionEvent({
      message_id: 'om_3',
      reaction_type: { emoji_type: 'THUMBSUP' },
      operator_type: 'user',
      user_id: { user_id: '1234567890123456789' }
    })).toMatchObject({ operatorType: 'user', operatorId: '1234567890123456789', operatorIdentity: 'user_id' });
    expect(parseLarkReactionEvent({
      message_id: 'om_4',
      reaction_type: { emoji_type: 'THUMBSUP' },
      operator_type: 'user',
      user_id: { union_id: 'on_abc' }
    })).toMatchObject({ operatorIdentity: 'union_id' });
  });

  it('recognises app reactions and falls back to app_id when there is no user id', () => {
    expect(parseLarkReactionEvent({
      message_id: 'om_2',
      reaction_type: { emoji_type: 'DONE' },
      operator_type: 'app',
      app_id: 'cli_bot'
    })).toMatchObject({ operatorType: 'app', operatorId: 'cli_bot', appId: 'cli_bot' });
  });

  it('normalises unknown operator types and rejects incomplete events', () => {
    expect(parseLarkReactionEvent({
      message_id: 'om_3',
      reaction_type: { emoji_type: 'SMILE' },
      operator_type: 'something-new',
      user_id: { user_id: '123' }
    })).toMatchObject({ operatorType: 'unknown', operatorId: '123' });
    expect(parseLarkReactionEvent({ message_id: 'om_4' })).toBeUndefined();
    expect(parseLarkReactionEvent({ reaction_type: { emoji_type: 'SMILE' } })).toBeUndefined();
    expect(parseLarkReactionEvent(null)).toBeUndefined();
  });
});
