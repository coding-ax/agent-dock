import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { isLocalOwnerRequest, issueMasterToken, parseCookieHeader, sessionTokenAllows, verifyWebToken, webAccessCookieName, webAccessSessionCookieName } from './web-access.js';
import { TerminalManager, encodeFrame, parseTerminalFrame, type TerminalFrame } from './terminal-manager.js';

const TERMINAL_PATH = /^\/api\/sessions\/([^/]+)\/terminal$/;

export interface TerminalWsOptions {
  /** 访问门关闭时（本地裸跑）不传 secret，upgrade 一律放行。 */
  webAuth?: { enabled?: boolean; secret?: string };
  idleTtlMs?: number;
}

function reject(socket: Duplex, status: number, message: string): void {
  const statusText: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' };
  socket.write(`HTTP/1.1 ${status} ${statusText[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  socket.destroy();
}

/**
 * 挂终端 WebSocket：Fastify onRequest 不覆盖 HTTP upgrade，鉴权在这里手工完成，
 * 语义与 web-access 门一致——master 全放行；session token 只允许本会话子树
 * （/api/sessions/:sid/terminal 天然落在 sessionTokenAllows 白名单内）。
 */
export function registerTerminalWebSockets(server: Server, runtime: AgentDockRuntime, options: TerminalWsOptions = {}): TerminalManager {
  const manager = new TerminalManager({ idleTtlMs: options.idleTtlMs });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://agent-dock.local'); }
      catch { return reject(socket, 400, '{"error":{"code":"INVALID_PATH","message":"Invalid URL"}}'); }
      const match = url.pathname.match(TERMINAL_PATH);
      if (!match) return; // 非终端路径：不接管，交给其他 upgrade 处理方
      let sessionId: string;
      try { sessionId = decodeURIComponent(match[1]!); }
      catch { return reject(socket, 400, '{"error":{"code":"INVALID_PATH","message":"Invalid session ID"}}'); }

      if (options.webAuth?.enabled === true && options.webAuth.secret) {
        const secret = options.webAuth.secret;
        // 与 HTTP 访问门同一条规则：?t= → master cookie → session cookie，再兜「本机直连」。
        // 终端是 pty，最后一条尤其不能只看源地址：DNS rebinding 下任意网页的源地址也是回环，
        // 必须同时要求回环 Host 头且非跨站发起（详见 isLocalOwnerRequest）。
        const queryClaim = verifyWebToken(url.searchParams.get('t') ?? undefined, secret);
        const presented = queryClaim
          ?? verifyWebToken(parseCookieHeader(request.headers.cookie, webAccessCookieName), secret)
          ?? verifyWebToken(parseCookieHeader(request.headers.cookie, webAccessSessionCookieName), secret);
        const localOwner = isLocalOwnerRequest({ address: request.socket.remoteAddress, host: request.headers.host, fetchSite: request.headers['sec-fetch-site'] });
        // 显式验签通过的链接按其自身作用域生效（会话链接只能进本会话终端），本机直连补发不覆盖。
        const claim = !queryClaim && localOwner && presented?.kind !== 'master' ? verifyWebToken(issueMasterToken(secret), secret) : presented;
        if (!claim) return reject(socket, 401, '{"error":{"code":"UNAUTHORIZED","message":"访问凭证缺失或已过期。"}}');
        if (claim.kind === 'session' && !sessionTokenAllows('GET', url.pathname, claim.sessionId!)) {
          return reject(socket, 403, '{"error":{"code":"FORBIDDEN","message":"该链接仅可访问对应会话的资源。"}}');
        }
      }

      const session = await runtime.getSession(sessionId);
      if (!session) return reject(socket, 404, '{"error":{"code":"SESSION_NOT_FOUND","message":"Session not found"}}');

      wss.handleUpgrade(request, socket, head, ws => {
        const client = {
          alive: true,
          send(frame: TerminalFrame) { if (ws.readyState === ws.OPEN) ws.send(encodeFrame(frame)); }
        };
        let handle: ReturnType<TerminalManager['attach']>;
        try { handle = manager.attach(sessionId, session.cwd, client); }
        catch {
          ws.close(1011, '终端启动失败');
          return;
        }
        // 后加入者从干净屏幕开始，不回补 scrollback（v1 接受）。
        ws.send(encodeFrame({ type: 'output', data: manager.resetSequence() }));
        ws.on('message', raw => {
          const frame = parseTerminalFrame(raw.toString('utf8'));
          if (!frame) return;
          if (frame.type === 'input') handle.write(frame.data!);
          else if (frame.type === 'resize') handle.resize(frame.cols!, frame.rows!);
        });
        const cleanup = () => { client.alive = false; handle.close(); };
        ws.on('close', cleanup);
        ws.on('error', cleanup);
      });
    })().catch(() => {
      if (!socket.destroyed) reject(socket, 500, '{"error":{"code":"TERMINAL_ERROR","message":"终端连接失败"}}');
    });
  });

  return manager;
}
