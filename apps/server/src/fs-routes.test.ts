import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerFsRoutes } from './fs-routes.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('session file preview', () => {
  it('opens absolute files for the owner while keeping shared sessions inside their workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-preview-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const external = join(root, 'SKILL.md');
    await mkdir(workspace);
    await writeFile(external, '# Skill');
    await writeFile(join(workspace, 'inside.md'), '# Inside');
    await symlink(external, join(workspace, 'linked.md'));
    const app = Fastify();
    app.addHook('onRequest', async request => {
      (request as unknown as { webClaim: { kind: string } }).webClaim = { kind: request.headers['x-test-claim'] === 'session' ? 'session' : 'master' };
    });
    await registerFsRoutes(app, { getSession: async () => ({ cwd: workspace }) } as any);
    try {
      const owner = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(external)}` });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().content).toBe('# Skill');

      const shared = { 'x-test-claim': 'session' };
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=inside.md`, headers: shared })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(join(workspace, 'inside.md'))}`, headers: shared })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(external)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=linked.md`, headers: shared })).statusCode).toBe(400);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/list?path=${encodeURIComponent(root)}`, headers: shared })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
