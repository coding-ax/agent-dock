import { deflateRawSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { BUILTIN_DARK_THEME_ID, BUILTIN_LIGHT_THEME_ID, contrastRatio } from '@agent-dock/agent-dock-shared';
import { buildApp } from '../app.js';
import { LlmEndpointService } from '../llm/service.js';
import { createCliProgram } from '../cli-program.js';
import { buildInitialSystemPrompt } from '../initial-system-prompt.js';
import { buildMainSystemPrompt } from '../assistant/service.js';
import { ThemeService } from './service.js';
import {
  mapVsCodeThemeToAgentDock,
  parseJsonc,
  parseMarketplaceReference,
  parseVsCodeThemeSource,
  parseVsixBuffer
} from './vscode-importer.js';
import {
  runThemeApply,
  runThemeCreate,
  runThemeDelete,
  runThemeExport,
  runThemeImportVsCode,
  runThemeList,
  runThemeReset
} from './cli.js';

/** 构造真实标准 ZIP / .vsix 归档（支持 Stored=0 与 Deflate=8 混合，校验 CRC32 与 EOCD）。 */
function buildRealZip(entries: Array<{ name: string; content: string | Buffer; deflate?: boolean }>): Buffer {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8');
    const raw = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content, 'utf8');
    const method = item.deflate ? 8 : 0;
    const data = item.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centralParts.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function makeSampleMultiVariantVsix(): Buffer {
  return buildRealZip([
    {
      name: 'extension/package.json',
      deflate: true,
      content: JSON.stringify({
        name: 'sakura-night-theme',
        displayName: '%ext.displayName%',
        publisher: 'acmelab',
        version: '1.2.0',
        description: 'Sakura Night & Dawn theme pack',
        contributes: {
          themes: [
            { label: 'Sakura Night', uiTheme: 'vs-dark', path: './themes/sakura-night.jsonc' },
            { label: 'Sakura Dawn', uiTheme: 'vs', path: './themes/sakura-dawn.json' }
          ]
        }
      })
    },
    {
      name: 'extension/package.nls.json',
      content: JSON.stringify({ 'ext.displayName': 'Sakura Studio Theme Pack' })
    },
    {
      name: 'extension/themes/base-dark.json',
      deflate: true,
      content: JSON.stringify({
        type: 'dark',
        colors: {
          'editor.background': '#1b1724',
          'sideBar.background': '#14111c',
          'editor.foreground': '#ece4f7',
          'descriptionForeground': '#9e92b5',
          'panel.border': '#2e2740',
          'terminal.ansiGreen': '#88e3a8',
          'terminal.ansiYellow': '#f5cb78',
          'terminal.ansiRed': '#f27999',
          'terminal.ansiBlue': '#7bb5ff'
        }
      })
    },
    {
      name: 'extension/themes/sakura-night.jsonc',
      deflate: true,
      content: `{
        // 含注释、字符串里的 URL 与尾逗号
        "name": "Sakura Night",
        "include": "./base-dark.json",
        /* 强调色与按钮 */
        "colors": {
          "button.background": "#f48fb1",
          "button.foreground": "#1b1020",
          "editorWidget.background": "#231e30",
          "list.activeSelectionBackground": "#f48fb133", // 带 alpha 合成
          "textLink.foreground": "#f48fb1",
        },
        "homepage": "https://example.com/sakura-night",
      }`
    },
    {
      name: 'extension/themes/sakura-dawn.json',
      deflate: false,
      content: JSON.stringify({
        name: 'Sakura Dawn',
        type: 'light',
        colors: {
          'editor.background': '#fdf8f7',
          'sideBar.background': '#f6ecea',
          'editorWidget.background': '#ffffff',
          'editor.foreground': '#2d232b',
          'descriptionForeground': '#746371',
          'button.background': '#c8507a',
          'button.foreground': '#ffffff',
          'panel.border': '#e8d7dc'
        }
      })
    }
  ]);
}

describe('themes subsystem: VS Code importer, REST API, SSE & CLI', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('parses JSONC comments and trailing commas without corrupting URLs inside strings', () => {
    const parsed = parseJsonc<{ url: string; colors: Record<string, string> }>(`{
      // top comment
      "url": "https://marketplace.visualstudio.com/items?itemName=a.b",
      /* block comment */
      "colors": {
        "editor.background": "#1a1b26",
      },
    }`);
    expect(parsed.url).toBe('https://marketplace.visualstudio.com/items?itemName=a.b');
    expect(parsed.colors['editor.background']).toBe('#1a1b26');
  });

  it('extracts multi-variant .vsix archive with deflate, package.nls.json, and relative include inheritance', async () => {
    const vsix = makeSampleMultiVariantVsix();
    const bundle = await parseVsixBuffer(vsix, { sourceLabel: 'sakura.vsix' });

    expect(bundle.extensionId).toBe('acmelab.sakura-night-theme');
    expect(bundle.extensionName).toBe('Sakura Studio Theme Pack');
    expect(bundle.version).toBe('1.2.0');
    expect(bundle.variants).toHaveLength(2);

    const night = bundle.variants[0]!;
    expect(night.label).toBe('Sakura Night');
    expect(night.theme.mode).toBe('dark');
    // 继承自 base-dark.json 的背景 + 子文件覆盖的 accent
    expect(night.theme.tokens.bgCanvas).toBe('#1b1724');
    expect(night.theme.tokens.bgSidebar).toBe('#14111c');
    expect(night.theme.tokens.accent).toBe('#f48fb1');
    expect(night.report.allPassed).toBe(true);

    const dawn = bundle.variants[1]!;
    expect(dawn.label).toBe('Sakura Dawn');
    expect(dawn.theme.mode).toBe('light');
    expect(dawn.theme.tokens.bgCanvas).toBe('#fdf8f7');
    // #c8507a 在白字下仅 4.30:1，对比度守护应保留玫瑰色相并微调加深以保住 #ffffff 按钮字通过 WCAG AA
    expect(dawn.theme.tokens.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(dawn.theme.tokens.accentForeground).toBe('#ffffff');
    expect(dawn.report.accentForegroundOnAccent.ratio).toBeGreaterThanOrEqual(4.5);
    expect(dawn.report.allPassed).toBe(true);
  });

  it('parses local extension directory and local .jsonc with relative include', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentdock-vsc-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await mkdir(join(dir, 'themes'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'local-nord',
      publisher: 'me',
      version: '0.1.0',
      contributes: {
        themes: [{ label: 'Local Nord', uiTheme: 'vs-dark', path: './themes/nord.jsonc' }]
      }
    }));
    await writeFile(join(dir, 'themes', 'base.json'), JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#2e3440', 'editor.foreground': '#eceff4' }
    }));
    await writeFile(join(dir, 'themes', 'nord.jsonc'), `{
      // extends base
      "include": "./base.json",
      "colors": { "button.background": "#88c0d0", },
    }`);

    const dirBundle = await parseVsCodeThemeSource({ source: dir });
    expect(dirBundle.variants).toHaveLength(1);
    expect(dirBundle.variants[0]!.theme.tokens.bgCanvas).toBe('#2e3440');
    expect(dirBundle.variants[0]!.theme.tokens.accent).toBe('#88c0d0');

    const fileBundle = await parseVsCodeThemeSource({ source: join(dir, 'themes', 'nord.jsonc') });
    expect(fileBundle.variants).toHaveLength(1);
    expect(fileBundle.variants[0]!.theme.tokens.bgCanvas).toBe('#2e3440');
  });

  it('parses Marketplace URL and publisher.extension ID and downloads via fetcher', async () => {
    expect(parseMarketplaceReference('https://marketplace.visualstudio.com/items?itemName=enkia.tokyo-night'))
      .toMatchObject({ publisher: 'enkia', extensionName: 'tokyo-night', extensionId: 'enkia.tokyo-night' });
    expect(parseMarketplaceReference('Catppuccin.catppuccin-vsc'))
      .toMatchObject({ publisher: 'Catppuccin', extensionName: 'catppuccin-vsc' });
    expect(parseMarketplaceReference('./local/theme.vsix')).toBeNull();
    expect(parseMarketplaceReference('https://evil.example.com/theme.vsix')).toBeNull();

    const vsix = makeSampleMultiVariantVsix();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('acmelab.gallery.vsassets.io');
      return new Response(new Uint8Array(vsix), { status: 200 });
    });

    const bundle = await parseVsCodeThemeSource({
      source: 'https://marketplace.visualstudio.com/items?itemName=acmelab.sakura-night-theme',
      fetcher: fetcher as typeof fetch
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(bundle.variants).toHaveLength(2);
    expect(bundle.marketplaceUrl).toContain('acmelab.sakura-night-theme');
  });

  it('heals unreadable low-contrast VS Code themes through WCAG contrast guard', () => {
    const mapped = mapVsCodeThemeToAgentDock({
      name: 'Blinding Low Contrast',
      type: 'dark',
      colors: {
        'editor.background': '#101218',
        'editor.foreground': '#1a1d26',
        'button.background': '#f8fafc',
        'button.foreground': '#ffffff'
      }
    });
    expect(mapped.report.allPassed).toBe(true);
    expect(contrastRatio(mapped.theme.tokens.textPrimary, mapped.theme.tokens.bgCanvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mapped.theme.tokens.accentForeground, mapped.theme.tokens.accent)).toBeGreaterThanOrEqual(4.5);
    expect(mapped.adjustments.length).toBeGreaterThan(0);
  });

  it('supports REST CRUD, active switching, AI generation, VS Code import, and SSE broadcast', async () => {
    const repos = createRepositories(':memory:');
    cleanups.push(() => repos.close());

    const mockLlmRun = vi.fn(async () => ({
      format: 'openai-chat' as const,
      model: 'gpt-theme-mock',
      baseUrl: 'https://mock.local/v1',
      text: JSON.stringify({
        name: '雨夜赛博靛蓝',
        description: '低眩光霓虹夜雨工作台',
        mode: 'dark',
        tokens: {
          bgCanvas: '#111625',
          bgSidebar: '#0c101b',
          bgSurface: '#181f33',
          bgSurfaceHover: '#222b45',
          bgElevated: '#1d253d',
          bgBubbleUser: '#212b4a',
          bgCode: '#0a0e18',
          textPrimary: '#e2ecff',
          textSecondary: '#9fb2d8',
          textMuted: '#7285ab',
          textInverse: '#0c101b',
          borderSubtle: '#263252',
          borderStrong: '#384873',
          accent: '#38bdf8',
          accentSoft: '#16324d',
          accentForeground: '#081321',
          success: '#34d399',
          warning: '#fbbf24',
          danger: '#f87171',
          info: '#60a5fa'
        }
      })
    }));
    const llm = new LlmEndpointService({ config: repos.config });
    vi.spyOn(llm, 'run').mockImplementation(mockLlmRun);

    const themes = new ThemeService({ config: repos.config, llm });
    cleanups.push(() => themes.close());
    const app = await buildApp({} as any, { themes });
    cleanups.push(() => app.close());

    const receivedEvents: any[] = [];
    const unsub = themes.subscribe(event => receivedEvents.push(event));
    cleanups.push(unsub);

    // 1. GET /api/themes 返回内置预设
    const initial = await app.inject({ method: 'GET', url: '/api/themes' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().themes.length).toBeGreaterThanOrEqual(8);
    expect(initial.json().preferences.activeThemeId).toBe(BUILTIN_LIGHT_THEME_ID);

    // 2. POST /api/themes 创建并激活
    const created = await app.inject({
      method: 'POST',
      url: '/api/themes',
      payload: {
        name: '暮雪青岚',
        mode: 'light',
        source: 'custom',
        tokens: { bgCanvas: '#f5f9f8', accent: '#0f766e' },
        apply: true
      }
    });
    expect(created.statusCode).toBe(201);
    const createdId = created.json().theme.id as string;
    expect(created.json().state.preferences.activeThemeId).toBe(createdId);
    expect(created.json().state.preferences.activeLightThemeId).toBe(createdId);
    expect(receivedEvents.at(-1)?.activeThemeId).toBe(createdId);

    // 3. PATCH /api/themes/:id 修改色板与名称
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/themes/${encodeURIComponent(createdId)}`,
      payload: { name: '暮雪青岚 Pro', tokens: { accent: '#115e59' } }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().theme.name).toBe('暮雪青岚 Pro');

    // 4. POST /api/themes/generate AI 生成主题
    const generated = await app.inject({
      method: 'POST',
      url: '/api/themes/generate',
      payload: { prompt: '雨夜东京赛博蓝', mode: 'dark', save: true, apply: true }
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().theme.name).toBe('雨夜赛博靛蓝');
    expect(generated.json().theme.source).toBe('ai');
    expect(generated.json().applied).toBe(true);
    expect(generated.json().state.preferences.activeDarkThemeId).toBe(generated.json().theme.id);

    // 5. POST /api/themes/import-vscode（base64 .vsix 预览 + 全量导入并应用）
    const vsixB64 = makeSampleMultiVariantVsix().toString('base64');
    const preview = await app.inject({
      method: 'POST',
      url: '/api/themes/import-vscode',
      payload: { fileBase64: vsixB64, fileName: 'sakura.vsix', previewOnly: true }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().variants).toHaveLength(2);
    expect(preview.json().imported).toHaveLength(0);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/themes/import-vscode',
      payload: { fileBase64: vsixB64, fileName: 'sakura.vsix', all: true, variant: 'Sakura Dawn', apply: true }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().imported).toHaveLength(2);
    expect(imported.json().appliedTheme.name).toBe('Sakura Dawn');

    // 6. DELETE 自定义主题后自动回落内置默认，且禁止删除内置主题
    const delBuiltin = await app.inject({ method: 'DELETE', url: `/api/themes/${BUILTIN_DARK_THEME_ID}` });
    expect(delBuiltin.statusCode).toBe(400);

    const delApplied = await app.inject({ method: 'DELETE', url: `/api/themes/${encodeURIComponent(imported.json().appliedTheme.id)}` });
    expect(delApplied.statusCode).toBe(200);
    expect(delApplied.json().state.preferences.activeLightThemeId).toBe(BUILTIN_LIGHT_THEME_ID);
  });

  it('preserves .vsix and .jsonc extensions when uploaded to session uploads endpoint', async () => {
    const uploadRuntime = {
      listAgents: async () => [],
      listSessions: async () => [],
      getSession: async (id: string) => ({ id, agentId: 'mock', state: 'idle', cwd: '/tmp', runId: 'run', createdAt: '', updatedAt: '' })
    } as any;
    const app = await buildApp(uploadRuntime);
    cleanups.push(() => app.close());
    const uploadDir = join(homedir(), '.agentdock', 'uploads', 'ses_theme_up');
    cleanups.push(() => rm(uploadDir, { recursive: true, force: true }));

    const vsixRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_theme_up/uploads',
      headers: { 'content-type': 'application/octet-stream', 'x-upload-filename': encodeURIComponent('tokyo-night.vsix') },
      payload: makeSampleMultiVariantVsix()
    });
    expect(vsixRes.statusCode).toBe(201);
    expect(vsixRes.json().filename.endsWith('.vsix')).toBe(true);
    expect(vsixRes.json().originalName).toBe('tokyo-night.vsix');
    expect(existsSync(vsixRes.json().path)).toBe(true);

    const jsoncRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_theme_up/uploads',
      headers: { 'content-type': 'text/plain', 'x-upload-filename': encodeURIComponent('my-theme.jsonc') },
      payload: Buffer.from('{ /* comment */ "colors": { "editor.background": "#1a1b26" } }')
    });
    expect(jsoncRes.statusCode).toBe(201);
    expect(jsoncRes.json().filename.endsWith('.jsonc')).toBe(true);
  });

  it('supports live SSE stream and end-to-end CLI theme commands against running daemon', async () => {
    const repos = createRepositories(':memory:');
    cleanups.push(() => repos.close());
    const themes = new ThemeService({ config: repos.config });
    cleanups.push(() => themes.close());
    const app = await buildApp({} as any, { themes });
    cleanups.push(() => app.close());

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const daemonDir = await mkdtemp(join(tmpdir(), 'agentdock-theme-cli-'));
    cleanups.push(() => rm(daemonDir, { recursive: true, force: true }));
    await writeFile(join(daemonDir, 'agentdock.pid'), `${process.pid}\n`);
    await writeFile(join(daemonDir, 'agentdock.state.json'), JSON.stringify({
      pid: process.pid,
      ready: true,
      startedAt: new Date().toISOString(),
      cwd: daemonDir,
      address,
      database: ':memory:'
    }));

    // 开启真实 SSE 连接监听主题热推送
    const sseController = new AbortController();
    cleanups.push(() => sseController.abort());
    const sseRes = await fetch(`${address}/api/themes/stream`, { signal: sseController.signal });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const waitForSse = async (needle: string) => {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if (sseBuffer.includes(needle)) return sseBuffer;
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
      }
      return sseBuffer;
    };

    // CLI: create --apply -> 应实时推到 SSE
    const createOut = await runThemeCreate({
      daemonDir,
      name: '小猫星夜',
      mode: 'dark',
      source: 'ai',
      tokens: JSON.stringify({ bgCanvas: '#131624', accent: '#60a5fa' }),
      apply: true,
      json: true
    });
    const created = JSON.parse(createOut);
    expect(created.ok).toBe(true);
    expect(created.theme.name).toBe('小猫星夜');
    const sseText = await waitForSse(created.theme.id);
    expect(sseText).toContain('event: theme.updated');
    expect(sseText).toContain(created.theme.id);

    // CLI: list
    const listOut = await runThemeList({ daemonDir });
    expect(listOut).toContain('小猫星夜');
    expect(listOut).toContain(created.theme.id);

    // CLI: import-vscode (.vsix 本地文件) --apply
    const vsixPath = join(daemonDir, 'sakura.vsix');
    await writeFile(vsixPath, makeSampleMultiVariantVsix());
    const importOut = await runThemeImportVsCode(vsixPath, { daemonDir, variant: 'Sakura Night', apply: true, json: true });
    const imported = JSON.parse(importOut);
    expect(imported.ok).toBe(true);
    expect(imported.appliedTheme.name).toBe('Sakura Night');

    // CLI: export
    const exportPath = join(daemonDir, 'exported.json');
    await runThemeExport(created.theme.id, { daemonDir, output: exportPath });
    const exportedJson = JSON.parse(await readFile(exportPath, 'utf8'));
    expect(exportedJson.id).toBe(created.theme.id);

    // CLI: apply / reset / delete
    const applyOut = await runThemeApply('Tokyo Night', { daemonDir });
    expect(applyOut).toContain('Tokyo Night');
    const resetOut = await runThemeReset({ daemonDir });
    expect(resetOut).toContain('默认');
    const deleteOut = await runThemeDelete(created.theme.id, { daemonDir });
    expect(deleteOut).toContain(created.theme.id);
  });

  it('wires Commander `agent-dock theme` subcommands and injects concise theme guidance into prompts', async () => {
    const themeList = vi.fn();
    const themeCreate = vi.fn();
    const themeImportVsCode = vi.fn();
    const themeApply = vi.fn();
    const themeReset = vi.fn();
    const themeDelete = vi.fn();
    const themeExport = vi.fn();

    const program = createCliProgram('0.3.27', {
      themeList, themeCreate, themeImportVsCode, themeApply, themeReset, themeDelete, themeExport
    });
    await program.parseAsync(['node', 'agent-dock', 'theme', 'list', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'theme', 'create', '--name', 'Night', '--mode', 'dark', '--tokens', '{}', '--source', 'ai', '--apply']);
    await program.parseAsync(['node', 'agent-dock', 'theme', 'import-vscode', '/tmp/a.vsix', '--all', '--apply']);
    await program.parseAsync(['node', 'agent-dock', 'theme', 'apply', 'Tokyo Night']);
    await program.parseAsync(['node', 'agent-dock', 'theme', 'reset']);
    await program.parseAsync(['node', 'agent-dock', 'theme', 'delete', 'theme_1']);
    await program.parseAsync(['node', 'agent-dock', 'theme', 'export', 'builtin-tokyo-night', '--output', '/tmp/t.json']);

    expect(themeList).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
    expect(themeCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Night', mode: 'dark', source: 'ai', apply: true }));
    expect(themeImportVsCode).toHaveBeenCalledWith('/tmp/a.vsix', expect.objectContaining({ all: true, apply: true }));
    expect(themeApply).toHaveBeenCalledWith('Tokyo Night', expect.any(Object));
    expect(themeReset).toHaveBeenCalledOnce();
    expect(themeDelete).toHaveBeenCalledWith('theme_1', expect.any(Object));
    expect(themeExport).toHaveBeenCalledWith('builtin-tokyo-night', expect.objectContaining({ output: '/tmp/t.json' }));

    expect(buildInitialSystemPrompt({ id: 'ses_1' })).toContain('agent-dock theme');
    expect(buildMainSystemPrompt()).toContain('agent-dock theme import-vscode');
    expect(buildMainSystemPrompt()).toContain('agent-dock theme create');
  });
});
