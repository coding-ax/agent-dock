import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  decodeChatsResponse,
  decodeChattersResponse,
  decodeMessageContent,
  decodePacket,
  decodePushMessages,
  decodePutMessageResponse,
  encodeFrame,
  encodePacket,
  encodePutMessageRequest
} from './proto.js';

const root = protobuf.parse(
  readFileSync(new URL('./lark.proto', import.meta.url), 'utf8'),
  { keepCase: true }
).root;

const encode = (name: string, value: Record<string, unknown>): Buffer =>
  Buffer.from(root.lookupType(`lark.${name}`).encode(root.lookupType(`lark.${name}`).fromObject(value)).finish());

describe('Lark protocol protobuf', () => {
  it('round-trips WS frames and packets', () => {
    const packet = encodePacket({ payloadType: 1, cmd: 4, cid: 'request-1', payload: Buffer.from([1, 2, 3]) });
    expect(decodePacket(packet)).toMatchObject({ payloadType: 1, cmd: 4, cid: 'request-1' });

    const frame = encodeFrame({ payloadType: 1, cmd: 4, payload: Buffer.from([4, 5]) });
    expect(decodeFrame(frame)).toMatchObject({
      packet: { payloadType: 1, cmd: 4, payload: Buffer.from([4, 5]) }
    });
  });

  it('decodes rich text from a message push', () => {
    const richText = {
      elementIds: ['root'],
      innerText: '你好，世界',
      elements: {
        dictionary: {
          root: {
            tag: 22,
            childIds: ['paragraph']
          },
          paragraph: {
            tag: 3,
            childIds: ['text-1']
          },
          'text-1': {
            tag: 1,
            property: encode('entities.RichTextElement.TextProperty', { content: '你好，世界' })
          }
        }
      }
    };
    const textContent = encode('messages.TextContent', { richText });
    const push = encode('messages.PushMessagesRequest', {
      messages: {
        om_1: {
          id: 'om_1',
          type: 4,
          fromId: '100',
          chatId: 'oc_1',
          chatType: 1,
          createTime: 1767225600000,
          position: 3,
          content: textContent
        }
      }
    });
    expect(decodePushMessages(push)).toMatchObject([{
      messageId: 'om_1',
      fromId: '100',
      chatId: 'oc_1',
      chatType: 1,
      content: '你好，世界'
    }]);
    expect(decodeMessageContent(4, textContent)).toBe('你好，世界');
  });

  it('builds a text message request and reads the response id', () => {
    const request = encodePutMessageRequest({ chatId: 'oc_1', text: '回复内容' });
    expect(request.length).toBeGreaterThan(20);

    const response = encode('messages.PutMessageResponse', {
      message: { id: 'om_sent', type: 4, chatId: 'oc_1' }
    });
    expect(decodePutMessageResponse(response)).toBe('om_sent');
  });

  it('distinguishes topic, quote and direct message targets', () => {
    const decode = (value: Buffer) =>
      root.lookupType('lark.messages.PutMessageRequest').decode(value) as unknown as Record<string, unknown>;

    expect(decode(encodePutMessageRequest({ chatId: 'oc_1', text: '直接发送' }))).toMatchObject({
      rootId: '',
      isReplyInThread: false
    });
    expect(decode(encodePutMessageRequest({ chatId: 'oc_1', text: '新话题', rootId: 'om_1' }))).toMatchObject({
      rootId: 'om_1',
      isReplyInThread: true
    });
    expect(decode(encodePutMessageRequest({ chatId: 'oc_1', text: '引用', rootId: 'om_1', quote: true }))).toMatchObject({
      rootId: 'om_1',
      isReplyInThread: false
    });
    expect(decode(encodePutMessageRequest({ chatId: 'oc_1', text: '话题内', rootId: 'om_1', threadChat: true }))).toMatchObject({
      rootId: 'om_1',
      isReplyInThread: false
    });
  });

  it('reads chat and chatter avatars from lookup responses', () => {
    const chats = encode('chats.PullChatsByIdsResponse', {
      chats: {
        oc_1: {
          id: 'oc_1',
          name: '测试群',
          type: 2,
          lastMessagePosition: 10,
          avatar: { urls: ['https://example.com/chat.png'] }
        },
        oc_2: {
          id: 'oc_2',
          name: '海外群',
          type: 2,
          avatar: { secureUrls: ['https://p1.pstatp.com/origin/v3_0016s_group_avatar'] }
        }
      }
    });
    const decodedChats = decodeChatsResponse(chats);
    expect(decodedChats.find(chat => chat.id === 'oc_1')).toMatchObject({
      name: '测试群',
      avatarUrl: 'https://example.com/chat.png'
    });
    expect(decodedChats.find(chat => chat.id === 'oc_2')).toMatchObject({
      avatarUrl: 'https://s1-imfile.feishucdn.com/static-resource/v1/v3_0016s_group_avatar~?image_size=noop&cut_type=&quality=&format=image&sticker_format=.webp'
    });

    const chatters = encode('chatters.PullChattersByIdsResponse', {
      chatters: {
        '42': {
          id: '42',
          name: '张三',
          avatarImage: { urls: ['https://example.com/user.png'] }
        }
      }
    });
    expect(decodeChattersResponse(chatters)[0]).toMatchObject({
      id: '42',
      name: '张三',
      avatarUrl: 'https://example.com/user.png'
    });
  });
});
