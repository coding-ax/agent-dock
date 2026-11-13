import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ value: 0 }));

vi.mock('./ids.js', () => ({
  generateRequestCid: () => `c${String(++counter.value).padStart(9, '0')}`,
  generateRequestId: () => `r${String(++counter.value).padStart(9, '0')}`
}));

const { encodePutMessageRequest } = await import('./proto.js');

const root = protobuf.parse(
  readFileSync(new URL('./lark.proto', import.meta.url), 'utf8'),
  { keepCase: true }
).root;

const ZHANG = '\u5f20\u4e09';
const LI = '\u674e\u56db';
const WANG = '\u738b\u4e94';

interface DecodedElement {
  tag?: number;
  property?: Buffer;
}

interface DecodedRequest {
  atUserIdList?: string[];
  content?: {
    richText?: {
      elementIds?: string[];
      innerText?: string;
      elements?: { dictionary?: Record<string, DecodedElement> };
    };
  };
}

const decodeRequest = (bytes: Buffer): DecodedRequest => {
  const messageType = root.lookupType('lark.messages.PutMessageRequest');
  return messageType.toObject(messageType.decode(bytes), {
    longs: String,
    enums: Number,
    bytes: Buffer,
    defaults: false,
    arrays: true,
    objects: true
  }) as DecodedRequest;
};

const decodeProperty = (name: string, bytes: Buffer): Record<string, unknown> => {
  const messageType = root.lookupType(`lark.${name}`);
  return messageType.toObject(messageType.decode(bytes), { defaults: false }) as Record<string, unknown>;
};

const richTextOf = (request: DecodedRequest) => {
  const rich = request.content?.richText;
  if (!rich?.elementIds || !rich.elements?.dictionary) throw new Error('request has no rich text');
  const dictionary = rich.elements.dictionary;
  return {
    innerText: rich.innerText,
    elements: rich.elementIds.map(id => {
      const element = dictionary[id];
      if (!element) throw new Error(`missing element ${id}`);
      return element;
    })
  };
};

describe('Lark rich text mentions', () => {
  beforeEach(() => {
    counter.value = 0;
  });

  it('keeps plain text messages on the single TextProperty path', () => {
    const request = decodeRequest(encodePutMessageRequest({ chatId: 'oc_1', text: 'plain' }));
    const rich = richTextOf(request);

    expect(rich.innerText).toBe('plain');
    expect(rich.elements).toHaveLength(1);
    expect(rich.elements[0]!.tag).toBe(1);
    expect(decodeProperty('entities.RichTextElement.TextProperty', rich.elements[0]!.property!)).toEqual({
      content: 'plain'
    });
    expect(request.atUserIdList ?? []).toEqual([]);
  });

  it('encodes empty plain text without adding mention fields', () => {
    const request = decodeRequest(encodePutMessageRequest({ chatId: 'oc_1', text: '' }));
    const rich = richTextOf(request);

    expect(rich.innerText ?? '').toBe('');
    expect(rich.elements).toHaveLength(1);
    expect(rich.elements[0]!.tag).toBe(1);
    expect(decodeProperty(
      'entities.RichTextElement.TextProperty',
      rich.elements[0]!.property ?? Buffer.alloc(0)
    )).toEqual({});
    expect(request.atUserIdList ?? []).toEqual([]);
  });

  it('splits mixed text and mentions in body order', () => {
    const text = `\u4f60\u597d @${ZHANG}\uff0c\u548c @${LI} \u770b\u4e00\u4e0b`;
    const request = decodeRequest(encodePutMessageRequest({
      chatId: 'oc_1',
      text,
      mentions: [
        { userId: '42', content: ZHANG },
        { userId: 43, content: LI }
      ]
    }));
    const rich = richTextOf(request);

    expect(rich.innerText).toBe(text);
    expect(rich.elements.map(element => element.tag)).toEqual([1, 5, 1, 5, 1]);
    expect(rich.elements.map(element => element.tag === 1
      ? decodeProperty('entities.RichTextElement.TextProperty', element.property!)
      : decodeProperty('entities.RichTextElement.AtProperty', element.property!)
    )).toEqual([
      { content: '\u4f60\u597d ' },
      { userId: '42', content: ZHANG },
      { content: '\uff0c\u548c ' },
      { userId: '43', content: LI },
      { content: ' \u770b\u4e00\u4e0b' }
    ]);
    expect(request.atUserIdList).toEqual(['42', '43']);
  });

  it('encodes a mention-only body without an empty text element', () => {
    const request = decodeRequest(encodePutMessageRequest({
      chatId: 'oc_1',
      text: `@${ZHANG}`,
      mentions: [{ userId: '42', content: ZHANG }]
    }));
    const rich = richTextOf(request);

    expect(rich.innerText).toBe(`@${ZHANG}`);
    expect(rich.elements).toHaveLength(1);
    expect(rich.elements[0]!.tag).toBe(5);
    expect(decodeProperty('entities.RichTextElement.AtProperty', rich.elements[0]!.property!)).toEqual({
      userId: '42',
      content: ZHANG
    });
    expect(request.atUserIdList).toEqual(['42']);
  });

  it('preserves repeated AT elements and dedupes the notification list', () => {
    const text = `@${ZHANG} @${ZHANG} @${LI}`;
    const request = decodeRequest(encodePutMessageRequest({
      chatId: 'oc_1',
      text,
      mentions: [
        { userId: '42', content: ZHANG },
        { userId: '42', content: ZHANG },
        { userId: '43', content: LI }
      ]
    }));
    const rich = richTextOf(request);

    expect(rich.elements.map(element => element.tag)).toEqual([5, 1, 5, 1, 5]);
    expect(rich.elements
      .filter(element => element.tag === 5)
      .map(element => decodeProperty('entities.RichTextElement.AtProperty', element.property!).userId)
    ).toEqual(['42', '42', '43']);
    expect(request.atUserIdList).toEqual(['42', '43']);
  });

  it('honors explicit UTF-16 offsets and a leading @ in content', () => {
    const text = `\u{1f642}@${ZHANG} ok`;
    const request = decodeRequest(encodePutMessageRequest({
      chatId: 'oc_1',
      text,
      mentions: [{ userId: '42', content: `@${ZHANG}`, offset: 2 }]
    }));
    const rich = richTextOf(request);

    expect(rich.elements.map(element => element.tag)).toEqual([1, 5, 1]);
    expect(decodeProperty('entities.RichTextElement.TextProperty', rich.elements[0]!.property!)).toEqual({
      content: '\u{1f642}'
    });
    expect(decodeProperty('entities.RichTextElement.AtProperty', rich.elements[1]!.property!)).toEqual({
      userId: '42',
      content: ZHANG
    });
    expect(decodeProperty('entities.RichTextElement.TextProperty', rich.elements[2]!.property!)).toEqual({
      content: ' ok'
    });
  });

  it('keeps int64 user ids exact beyond the JS safe integer range', () => {
    const userId = '9007199254740993';
    const request = decodeRequest(encodePutMessageRequest({
      chatId: 'oc_1',
      text: `@${ZHANG}`,
      mentions: [{ userId, content: ZHANG }]
    }));
    const rich = richTextOf(request);

    expect(request.atUserIdList).toEqual([userId]);
    expect(decodeProperty('entities.RichTextElement.AtProperty', rich.elements[0]!.property!)).toEqual({
      userId,
      content: ZHANG
    });
  });

  it('rejects open_id instead of silently sending it as text', () => {
    expect(() => encodePutMessageRequest({
      chatId: 'oc_1',
      text: `@${ZHANG}`,
      mentions: [{ userId: 'ou_abc123', content: ZHANG }]
    })).toThrow(/open_id/);
  });

  it('rejects non-numeric, out-of-range and misplaced mention input', () => {
    const encode = (mentions: Parameters<typeof encodePutMessageRequest>[0]['mentions'], text = `@${ZHANG}`) =>
      encodePutMessageRequest({ chatId: 'oc_1', text, mentions });

    expect(() => encode([{ userId: 'abc', content: ZHANG }])).toThrow(/\u5341\u8fdb\u5236\u6570\u5b57/);
    expect(() => encode([{ userId: '0', content: ZHANG }])).toThrow(/int64/);
    expect(() => encode([{ userId: '9223372036854775808', content: ZHANG }])).toThrow(/int64/);
    expect(() => encode([{ userId: '42', content: ZHANG, offset: 1 }])).toThrow(/\u4e0d\u5339\u914d/);
    expect(() => encode([{ userId: '42', content: WANG }])).toThrow(/\u672a\u5728\u6b63\u6587\u4e2d\u627e\u5230/);
    expect(() => encode([
      { userId: '42', content: ZHANG, offset: 0 },
      { userId: '43', content: ZHANG, offset: 0 }
    ])).toThrow(/\u91cd\u53e0\u6216\u4e71\u5e8f/);
  });

  it('emits the expected wire bytes for an AT element and atUserIdList', () => {
    const request = encodePutMessageRequest({
      chatId: 'oc_1',
      text: `@${ZHANG}`,
      mentions: [{ userId: '42', content: ZHANG }]
    });

    expect(request.toString('hex')).toBe(
      '0804123972370a0a63303030303030303031120740e5bca0e4b8891a200a1e0a0a63303030303030303031121008051a0c0a0234321206e5bca0e4b8891a046f635f31320a633030303030303030323801480172012a'
    );
  });
});
