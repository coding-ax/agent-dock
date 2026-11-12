import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LarkAvatarCredentials } from '../types.js';
import { LarkProtocolClient } from './client.js';
import { decodeCreateReactionRequest, decodePacket, encodePacket } from './proto.js';

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

  it('sends reaction requests with command 1011 and the message fields', async () => {
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
      return new Response(encodePacket({ payloadType: 1, cmd: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new LarkProtocolClient({ credentials, fetcher });

    await client.react('om_123', 'THUMBSUP');

    expect(captured?.headers.get('x-command')).toBe('1011');
    const packet = decodePacket(captured!.body);
    expect(packet.cmd).toBe(1011);
    expect(decodeCreateReactionRequest(packet.payload!)).toMatchObject({ messageId: 'om_123', type: 'THUMBSUP' });
  });
});
