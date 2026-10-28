import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager } from './terminal-manager.js';
import { registerTerminalWebSockets } from './terminal-ws.js';

const servers: ReturnType<typeof createServer>[] = [];

async function startServer(getSession: (id: string) => Promise<unknown>) {
  const server = createServer((_request, response) => response.end());
  servers.push(server);
  registerTerminalWebSockets(server, { getSession } as unknown as AgentDockRuntime);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function connect(url: string): Promise<{ status?: number; code?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume();
      resolve({ status });
    });
    ws.once('close', code => resolve({ code }));
    ws.once('error', reject);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('terminal WebSocket upgrade failures', () => {
  it('rejects a malformed session ID before accessing the runtime', async () => {
    const getSession = vi.fn();
    const base = await startServer(getSession);
    expect(await connect(`${base}/api/sessions/%/terminal`)).toEqual({ status: 400 });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('rejects a failed session lookup without an unhandled rejection', async () => {
    const base = await startServer(async () => { throw new Error('storage unavailable'); });
    expect(await connect(`${base}/api/sessions/ses_1/terminal`)).toEqual({ status: 500 });
  });

  it('closes the upgraded socket when the terminal cannot start', async () => {
    vi.spyOn(TerminalManager.prototype, 'attach').mockImplementation(() => { throw new Error('pty spawn failed'); });
    const base = await startServer(async () => ({ cwd: '/missing' }));
    expect(await connect(`${base}/api/sessions/ses_1/terminal`)).toEqual({ code: 1011 });
  });
});
