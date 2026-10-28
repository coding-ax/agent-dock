import { describe, expect, it } from 'vitest';
import { formatRawEvent } from './RawLogPanel';
import type { DockEvent } from './api';

const event = (raw?: string): DockEvent => ({ id: 'one', sequence: 4, type: 'text', timestamp: '2026-09-23T00:00:00Z', data: { text: 'hello' }, raw });

describe('原始日志', () => {
  it('有原文时展示原文，否则展示结构化事件', () => {
    expect(formatRawEvent(event('CLI line'))).toContain('CLI line');
    expect(formatRawEvent(event('CLI line'))).not.toContain('"text"');
    expect(formatRawEvent(event())).toContain('"text": "hello"');
  });
});
