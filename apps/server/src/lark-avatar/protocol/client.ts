import WebSocket from 'ws';
import type { LarkAvatarCredentials } from '../types.js';
import { CookieJar } from './auth.js';
import { generateAccessKey, generateLongRequestId, generateRequestId } from './ids.js';
import {
  decodeBatchCopyMessages,
  decodeChatsResponse,
  decodeChattersResponse,
  decodeFeedCardsResponse,
  decodeFrame,
  decodePacket,
  decodePullMessagesByIdsResponse,
  decodePullMessagesByPositionsResponse,
  decodePullSidsResponse,
  decodePushMessages,
  decodePutMessageResponse,
  encodeAckPacket,
  encodeCreateReactionRequest,
  encodeHeartbeatPacket,
  encodePacket,
  encodePullChatsRequest,
  encodePullChattersRequest,
  encodePullFeedCardsRequest,
  encodePullMessagesByIdsRequest,
  encodePullMessagesByPositionsRequest,
  encodePullSidsRequest,
  encodePutMessageRequest,
  type LarkChatInfo,
  type LarkChatterInfo,
  type LarkIncomingMessage
} from './proto.js';
import { getRegion } from './region.js';

type Fetch = typeof globalThis.fetch;

export interface LarkProtocolStatus {
  state: 'connected' | 'reconnecting' | 'expired';
  error?: string;
}

export interface LarkProtocolLookup {
  chats: Map<string, LarkChatInfo>;
  chatters: Map<string, LarkChatterInfo>;
}

export interface LarkAvailableChat extends LarkChatInfo {
  updateTime: number;
}

export interface LarkProtocolClientHandlers {
  onMessage(message: LarkIncomingMessage, meta?: { backfill?: boolean }): boolean | void | Promise<boolean | void>;
  onStatus(status: LarkProtocolStatus): void;
}

export interface LarkProtocolClientLike {
  start(handlers: LarkProtocolClientHandlers): void;
  stop(): void | Promise<void>;
  reconnect(): void;
  sendText(input: { chatId: string; text: string; rootId?: string; quote?: boolean; threadChat?: boolean }): Promise<{ messageId: string }>;
  react?(messageId: string, type: string): Promise<void>;
  lookup?(chatIds: string[], userIds: string[]): Promise<LarkProtocolLookup>;
  listChats?(): Promise<LarkAvailableChat[]>;
  syncRecent?(sinceMs: number, options?: { backfill?: boolean }): Promise<number>;
  history?(chatId: string, beforePosition: number, limit: number): Promise<LarkIncomingMessage[]>;
}

export class LarkProtocolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LarkProtocolError';
  }
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const CMD_PUT_MESSAGE = 5;
const CMD_PUSH_MESSAGES = 6;
const CMD_PULL_MESSAGES = 8;
const CMD_PULL_MESSAGES_BY_POSITIONS = 43;
const CMD_PULL_CHATS = 64;
const CMD_PULL_CHATTERS = 46;
const CMD_PULL_FEED = 1000;
const CMD_PUSH_BATCH_COPY = 134;
const CMD_PUSH_SID = 6000;
const CMD_PULL_SIDS = 12001;
const CMD_CREATE_REACTION = 1011;
const HEARTBEAT_MS = 30_000;

const asBuffer = (data: WebSocket.RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const toMillis = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

export class LarkProtocolClient implements LarkProtocolClientLike {
  private readonly credentials: LarkAvatarCredentials;
  private readonly fetcher: Fetch;
  private readonly jar: CookieJar;
  private readonly region;
  private handlers?: LarkProtocolClientHandlers;
  private ws?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private running = false;
  private retryDelay = 2_000;
  private lastStatus?: string;

  constructor(input: { credentials: LarkAvatarCredentials; fetcher?: Fetch }) {
    this.credentials = input.credentials;
    this.fetcher = input.fetcher ?? fetch;
    this.jar = new CookieJar(input.credentials.cookies);
    this.region = getRegion(input.credentials.region);
  }

  start(handlers: LarkProtocolClientHandlers): void {
    if (this.running) return;
    this.handlers = handlers;
    this.running = true;
    void this.runLoop();
  }

  stop(): void {
    this.running = false;
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
      try { ws.terminate(); } catch { /* already terminated */ }
    }
  }

  reconnect(): void {
    this.retryDelay = 2_000;
    const ws = this.ws;
    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  private status(state: LarkProtocolStatus['state'], error?: string): void {
    const signature = `${state}:${error ?? ''}`;
    if (signature === this.lastStatus) return;
    this.lastStatus = signature;
    this.handlers?.onStatus({ state, ...(error ? { error } : {}) });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const ws = await this.connectOnce();
        if (!this.running) {
          ws.close();
          break;
        }
        await this.waitForClose(ws);
        if (!this.running) break;
        this.status('reconnecting', 'WebSocket 已断开');
        this.retryDelay = 10_000;
      } catch (error) {
        if (!this.running) break;
        const message = errorMessage(error);
        if (error instanceof LarkProtocolError && error.code === 'LARK_TICKET_FAILED') {
          this.running = false;
          this.status('expired', message);
          break;
        }
        this.status('reconnecting', message);
      }
      await this.sleep(this.retryDelay);
      this.retryDelay = 10_000;
    }
  }

  private async connectOnce(): Promise<WebSocket> {
    const url = await this.buildWsUrl();
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { 'user-agent': USER_AGENT },
        handshakeTimeout: 15_000
      });
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      ws.once('open', () => {
        if (settled) return;
        settled = true;
        this.ws = ws;
        this.retryDelay = 10_000;
        this.status('connected');
        ws.on('message', data => {
          void this.handleRawFrame(asBuffer(data));
        });
        ws.on('error', error => {
          if (this.ws === ws) this.status('reconnecting', error.message);
        });
        ws.on('close', () => {
          if (this.ws === ws) this.ws = undefined;
          this.clearHeartbeat();
        });
        this.startHeartbeat(ws);
        resolve(ws);
      });
      ws.once('error', error => fail(error));
      ws.once('close', () => fail(new Error('WebSocket closed before open')));
    });
  }

  private waitForClose(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => {
      ws.once('close', () => resolve());
    });
  }

  private async sleep(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(encodeHeartbeatPacket()); } catch { /* reconnect loop will handle it */ }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async handleRawFrame(raw: Buffer): Promise<void> {
    let decoded;
    try {
      decoded = decodeFrame(raw);
    } catch {
      return;
    }
    if (!decoded.packet) return;
    const packet = decoded.packet;
    if (packet.sid) {
      const ws = this.ws;
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(encodeAckPacket(packet.sid)); } catch { /* ignore */ }
      }
    }
    const cmd = Number(packet.cmd ?? 0);
    try {
      if (cmd === CMD_PUSH_MESSAGES) {
        for (const message of decodePushMessages(packet.payload ?? Buffer.alloc(0))) {
          await this.handlers?.onMessage(message);
        }
      } else if (cmd === CMD_PUSH_SID) {
        const sids = [packet.sid, ...(packet.compactedSids ?? []).map(String)]
          .filter((sid): sid is string => Boolean(sid));
        if (sids.length) await this.pullSids([...new Set(sids)]);
      } else if (cmd === CMD_PUSH_BATCH_COPY) {
        await this.handleBatchCopy(packet.payload ?? Buffer.alloc(0));
      }
    } catch {
      // 单条推送解析失败不能打断长连接；下一条消息继续处理。
    }
  }

  private async handleBatchCopy(payload: Buffer): Promise<void> {
    const batch = decodeBatchCopyMessages(payload);
    const have = new Set(batch.messages.map(message => message.messageId));
    const missing = batch.ids.filter(id => !have.has(id));
    const pulled = missing.length ? await this.pullMessagesByIds(missing) : [];
    const messages = [...batch.messages, ...pulled]
      .filter(message => message.fromId)
      .sort((left, right) => left.position - right.position);
    for (const message of messages) await this.handlers?.onMessage(message);
  }

  private async pullSids(sids: string[]): Promise<void> {
    const payload = await this.gatewayRequest(CMD_PULL_SIDS, encodePullSidsRequest(sids));
    for (const packet of decodePullSidsResponse(payload)) {
      if (Number(packet.cmd ?? 0) !== CMD_PUSH_MESSAGES || !packet.payload?.length) continue;
      for (const message of decodePushMessages(packet.payload)) {
        await this.handlers?.onMessage(message);
      }
    }
  }

  private async pullMessagesByIds(messageIds: string[]): Promise<LarkIncomingMessage[]> {
    const payload = await this.gatewayRequest(CMD_PULL_MESSAGES, encodePullMessagesByIdsRequest(messageIds));
    return decodePullMessagesByIdsResponse(payload);
  }

  async lookup(chatIds: string[], userIds: string[]): Promise<LarkProtocolLookup> {
    const [chats, chatters] = await Promise.all([
      chatIds.length
        ? this.gatewayRequest(CMD_PULL_CHATS, encodePullChatsRequest(chatIds))
          .then(decodeChatsResponse)
          .catch(() => [])
        : Promise.resolve([]),
      userIds.length
        ? this.gatewayRequest(CMD_PULL_CHATTERS, encodePullChattersRequest(userIds))
          .then(decodeChattersResponse)
          .catch(() => [])
        : Promise.resolve([])
    ]);
    return {
      chats: new Map(chats.map(chat => [chat.id, chat])),
      chatters: new Map(chatters.map(chatter => [chatter.id, chatter]))
    };
  }

  async syncRecent(sinceMs: number, options: { backfill?: boolean } = {}): Promise<number> {
    const cardsPayload = await this.gatewayRequest(CMD_PULL_FEED, encodePullFeedCardsRequest());
    const chatIds = [...new Set(
      decodeFeedCardsResponse(cardsPayload)
        .filter(card => card.type === 1 && card.id && (!sinceMs || !card.updateTime || toMillis(card.updateTime) >= sinceMs))
        .map(card => card.id)
    )].slice(0, 50);
    if (!chatIds.length) return 0;

    const chatsPayload = await this.gatewayRequest(CMD_PULL_CHATS, encodePullChatsRequest(chatIds));
    const chats = decodeChatsResponse(chatsPayload).filter(chat => chat.lastMessagePosition > 0).slice(0, 30);
    let delivered = 0;
    for (const chat of chats) {
      const last = chat.lastMessagePosition;
      const start = Math.max(1, last - 19);
      const positions = Array.from({ length: last - start + 1 }, (_, index) => start + index);
      if (!positions.length) continue;
      const payload = await this.gatewayRequest(
        CMD_PULL_MESSAGES_BY_POSITIONS,
        encodePullMessagesByPositionsRequest(chat.id, positions)
      );
      for (const message of decodePullMessagesByPositionsResponse(payload)) {
        const createdAt = toMillis(message.createTime);
        if (sinceMs > 0 && (!createdAt || createdAt < sinceMs)) continue;
        const created = await this.handlers?.onMessage(message, { backfill: options.backfill ?? true });
        if (created !== false) delivered++;
      }
    }
    return delivered;
  }

  async listChats(): Promise<LarkAvailableChat[]> {
    const cardsPayload = await this.gatewayRequest(CMD_PULL_FEED, encodePullFeedCardsRequest());
    const cards = decodeFeedCardsResponse(cardsPayload)
      .filter(card => card.type === 1 && card.id)
      .slice(0, 100);
    if (!cards.length) return [];
    const updateTimes = new Map(cards.map(card => [card.id, card.updateTime]));
    const chatsPayload = await this.gatewayRequest(
      CMD_PULL_CHATS,
      encodePullChatsRequest([...new Set(cards.map(card => card.id))])
    );
    return decodeChatsResponse(chatsPayload)
      .map(chat => ({ ...chat, updateTime: updateTimes.get(chat.id) ?? 0 }))
      .sort((left, right) => right.updateTime - left.updateTime);
  }

  async history(chatId: string, beforePosition: number, limit: number): Promise<LarkIncomingMessage[]> {
    const end = Math.max(0, Math.floor(beforePosition));
    const count = Math.min(50, Math.max(1, Math.floor(limit)));
    if (!chatId || end <= 0) return [];
    const start = Math.max(1, end - count + 1);
    const positions = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    const payload = await this.gatewayRequest(
      CMD_PULL_MESSAGES_BY_POSITIONS,
      encodePullMessagesByPositionsRequest(chatId, positions)
    );
    return decodePullMessagesByPositionsResponse(payload)
      .sort((left, right) => left.position - right.position);
  }

  async sendText(input: { chatId: string; text: string; rootId?: string; quote?: boolean; threadChat?: boolean }): Promise<{ messageId: string }> {
    const payload = encodePutMessageRequest(input);
    const content = await this.gatewayRequest(CMD_PUT_MESSAGE, payload);
    const messageId = decodePutMessageResponse(content);
    if (!messageId || messageId.startsWith('-')) {
      throw new LarkProtocolError('LARK_SEND_REJECTED', '飞书网关没有返回有效消息 ID，消息可能未发出');
    }
    return { messageId };
  }

  async react(messageId: string, type: string): Promise<void> {
    if (!messageId || !type) return;
    await this.gatewayRequest(CMD_CREATE_REACTION, encodeCreateReactionRequest(messageId, type));
  }

  private async gatewayRequest(cmd: number, payload: Buffer): Promise<Buffer> {
    const packet = {
      payloadType: 1,
      cmd,
      cid: generateLongRequestId(),
      payload
    };
    const response = await this.fetcher(this.region.gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        accept: '*/*',
        origin: this.region.webOrigin,
        referer: `${this.region.webOrigin}/`,
        'user-agent': USER_AGENT,
        'x-appid': this.credentials.webAppId || this.region.webAppId,
        'x-command': String(cmd),
        'x-command-version': '5.7.0',
        'x-lgw-os-type': '1',
        'x-lgw-terminal-type': '2',
        'x-source': 'web',
        'x-web-version': '3.9.32',
        'x-request-id': generateLongRequestId(),
        cookie: this.jar.header()
      },
      body: new Uint8Array(encodePacket(packet)),
      signal: AbortSignal.timeout(15_000)
    });
    this.jar.absorb(response.headers);
    if (!response.ok) {
      throw new LarkProtocolError('LARK_GATEWAY_HTTP', `飞书网关请求失败：HTTP ${response.status}`);
    }
    const raw = Buffer.from(await response.arrayBuffer());
    const decoded = decodePacket(raw);
    return decoded.payload ?? Buffer.alloc(0);
  }

  private async buildWsUrl(): Promise<string> {
    const { ticket, deviceId } = await this.getTicket();
    // ticket 接口会返回服务端分配的 device_id；它和本地保存的 deviceId 可能不同。
    // WS 网关要求 device_id 参数与 access_key 使用同一个（服务端）ID，否则 401。
    const accessKey = generateAccessKey(`2${this.credentials.appKey}${deviceId}f8a69f1719916z`);
    const params = new URLSearchParams({
      accept_encoding: 'gzip',
      sdk_version: '7.72.8',
      version_code: '7.72.8',
      type: 'sdk_main',
      platform: '',
      terminal_type: '2',
      device_model: '',
      lark_version: '7.72.0',
      net_status: '5',
      lark_env: 'online',
      request_id: generateRequestId(),
      aid: '1',
      fpid: '2',
      device_id: deviceId,
      access_key: accessKey,
      ticket
    });
    return `${this.region.wsUrl}?${params.toString()}`;
  }

  private async getTicket(): Promise<{ ticket: string; deviceId: string }> {
    const response = await this.fetcher(
      `${this.region.ticketUrl}?local_device_id=${encodeURIComponent(this.credentials.deviceId)}`,
      {
        headers: {
          'user-agent': USER_AGENT,
          cookie: this.jar.header()
        },
        signal: AbortSignal.timeout(10_000)
      }
    );
    this.jar.absorb(response.headers);
    let payload: Record<string, unknown> = {};
    try {
      payload = await response.json() as Record<string, unknown>;
    } catch {
      throw new LarkProtocolError('LARK_TICKET_FAILED', `获取 WebSocket ticket 失败：HTTP ${response.status}`);
    }
    const ticket = typeof payload.ticket === 'string' ? payload.ticket : '';
    if (!ticket) {
      const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
      throw new LarkProtocolError('LARK_TICKET_FAILED', `飞书会话已失效：${message}`);
    }
    const deviceId = typeof payload.device_id === 'string' && payload.device_id ? payload.device_id : this.credentials.deviceId;
    return { ticket, deviceId };
  }
}
