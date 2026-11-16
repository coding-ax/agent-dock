import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LarkAvatarCredentials } from '../types.js';
import { LarkProtocolClient } from './client.js';
import { decodePacket, decodePutReactionRequest, encodePacket, encodePutReactionResponse } from './proto.js';

describe('LarkProtocolClient websocket auth', () => {
  it('uses the device_id returned by the ticket endpoint for device_id and access_key', async () => {
    const credentials: LarkAvatarCredentials = {
      region: 'feishu',
      cookies: { session: 'session-1' },
      savedAt: 0,
      deviceId: 'local-device',
      appKey: 'app-key',
      userId: 'user-1',
      csrfToken: 'csrf',
      webAppId: '161471'
    };
    const fetcher = (async () => new Response(JSON.stringify({ ticket: 'ticket-1', device_id: 'server-device' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;
    const client = new LarkProtocolClient({ credentials, fetcher });
    const url = new URL(await (client as unknown as { buildWsUrl(): Promise<string> }).buildWsUrl());
    expect(url.searchParams.get('ticket')).toBe('ticket-1');
    expect(url.searchParams.get('device_id')).toBe('server-device');
    expect(url.searchParams.get('access_key')).toBe(createHash('md5').update('2app-keyserver-devicef8a69f1719916z', 'utf8').digest('hex'));
  });

  it('sends reaction requests with the web client command 25 and reactionType field', async () => {
    const credentials: LarkAvatarCredentials = {
      region: 'feishu',
      cookies: { session: 'session-1' },
      savedAt: 0,
      deviceId: 'local-device',
      appKey: 'app-key',
      userId: 'user-1',
      csrfToken: 'csrf',
      webAppId: '161471'
    };
    let captured: { headers: Headers; body: Buffer } | undefined;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        headers: new Headers(init?.headers as HeadersInit),
        body: Buffer.from(init?.body as Uint8Array)
      };
      return new Response(encodePacket({ payloadType: 1, cmd: 25, payload: encodePutReactionResponse(1) }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new LarkProtocolClient({ credentials, fetcher });

    // Web 网关的 message.id 是数字串（不是 om_*）；reaction 请求要原样带上它。
    await expect(client.react('7707449809967303948', 'THUMBSUP')).resolves.toEqual({ count: 1 });

    expect(captured?.headers.get('x-command')).toBe('25');
    const packet = decodePacket(captured!.body);
    expect(packet.cmd).toBe(25);
    expect(decodePutReactionRequest(packet.payload!)).toMatchObject({
      messageId: '7707449809967303948',
      reactionType: 'THUMBSUP'
    });
  });

  it('surfaces the gateway error reason instead of only the HTTP status', async () => {
    const credentials: LarkAvatarCredentials = {
      region: 'feishu',
      cookies: { session: 'session-1' },
      savedAt: 0,
      deviceId: 'local-device',
      appKey: 'app-key',
      userId: 'user-1',
      csrfToken: 'csrf',
      webAppId: '161471'
    };
    const fetcher = (async () => new Response(
      encodePacket({ payloadType: 1, cmd: 25, sid: 'message not found' }),
      { status: 400 }
    )) as unknown as typeof fetch;
    const client = new LarkProtocolClient({ credentials, fetcher });

    await expect(client.react('0', 'THUMBSUP'))
      .rejects.toThrow('飞书网关请求失败：HTTP 400：message not found');
  });

  it('treats a 200 response with count=0 or an empty payload as a failed reaction', async () => {
    const credentials: LarkAvatarCredentials = {
      region: 'feishu',
      cookies: { session: 'session-1' },
      savedAt: 0,
      deviceId: 'local-device',
      appKey: 'app-key',
      userId: 'user-1',
      csrfToken: 'csrf',
      webAppId: '161471'
    };
    // 旧 bug 就是 HTTP 200 但没产生表情；调用方不能把 fulfilled 当成功。
    const zero = (async () => new Response(encodePacket({ payloadType: 1, cmd: 25, payload: encodePutReactionResponse(0) }), { status: 200 })) as unknown as typeof fetch;
    await expect(new LarkProtocolClient({ credentials, fetcher: zero }).react('1', 'THUMBSUP'))
      .rejects.toMatchObject({ code: 'LARK_REACTION_NOT_APPLIED' });

    const empty = (async () => new Response(encodePacket({ payloadType: 1, cmd: 25 }), { status: 200 })) as unknown as typeof fetch;
    await expect(new LarkProtocolClient({ credentials, fetcher: empty }).react('1', 'THUMBSUP'))
      .rejects.toMatchObject({ code: 'LARK_REACTION_NOT_APPLIED' });
  });

  it('rejects a 200 packet whose business status is non-zero', async () => {
    const credentials: LarkAvatarCredentials = {
      region: 'feishu',
      cookies: { session: 'session-1' },
      savedAt: 0,
      deviceId: 'local-device',
      appKey: 'app-key',
      userId: 'user-1',
      csrfToken: 'csrf',
      webAppId: '161471'
    };
    const fetcher = (async () => new Response(
      encodePacket({ payloadType: 1, cmd: 25, status: 7, sid: 'stale message' }),
      { status: 200 }
    )) as unknown as typeof fetch;
    await expect(new LarkProtocolClient({ credentials, fetcher }).react('1', 'THUMBSUP'))
      .rejects.toMatchObject({ code: 'LARK_GATEWAY_STATUS' });
  });
});
