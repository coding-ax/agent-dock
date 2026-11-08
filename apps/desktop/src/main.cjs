'use strict';

/**
 * AgentDock desktop shell.
 *
 * The renderer is the exact same web UI the daemon serves; this process only
 * owns lifecycle: pick a stable local port, start the bundled daemon with a
 * database under the app's userData directory, wait for /health, then load the
 * page. Closing the shell stops the daemon (and every agent process below it).
 *
 * Deliberately Electron rather than Tauri: the server ships a Node/TypeScript
 * bundle with native modules (better-sqlite3, node-pty) and spawns agent CLIs;
 * bundling a Node runtime is table stakes here, while Tauri would still need a
 * sidecar Node and an extra IPC layer. Electron also gives us cross-platform
 * installers and code-signing hooks in electron-builder with no extra work.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, screen } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createUpdaterController } = require('./updater.cjs');

const APP_NAME = 'AgentDock';
const APP_ID = 'com.agentdock.desktop';
const DEFAULT_PORT = 4310;
const FALLBACK_PORTS = [4321, 4311, 4312, 4337];
const STARTUP_TIMEOUT_MS = 45_000;
const SHUTDOWN_GRACE_MS = 5_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Test/smoke runs need an isolated profile: the installed AgentDock is usually
// running, and Electron's single-instance lock and SQLite database are scoped
// to userData. Set it before requestSingleInstanceLock() below.
if (process.env.AGENTDOCK_DESKTOP_USER_DATA?.trim()) {
  app.setPath('userData', path.resolve(process.env.AGENTDOCK_DESKTOP_USER_DATA.trim()));
}

const state = {
  window: null,
  child: null,
  baseUrl: null,
  port: null,
  logStream: null,
  logPath: null,
  dataDir: null,
  quitting: false,
  restarting: false,
  starting: null,
  installingUpdate: false,
  updater: null,
  recentLog: []
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); } catch { /* non-fatal */ }
}

/** GUI-launched apps get a minimal PATH; agents live in Homebrew / nvm / Volta / ~/.local/bin. */
function shellPath() {
  const parts = [];
  const push = value => {
    for (const entry of String(value ?? '').split(path.delimiter)) {
      if (entry && !parts.includes(entry)) parts.push(entry);
    }
  };
  push(process.env.PATH);
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    // -i is intentional: nvm/volta are usually wired in .zshrc, which a
    // non-interactive login shell does not read. A timeout keeps a broken rc
    // file from blocking startup.
    const result = spawnSync(shell, ['-ilc', 'printf "__AGENTDOCK_PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 4_000 });
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const match = text.match(/__AGENTDOCK_PATH__([^\n]*)/);
    if (match) push(match[1]);
  } catch { /* keep the inherited PATH */ }
  const home = app.getPath('home');
  push([
    path.join(home, '.local', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].join(path.delimiter));
  return parts.join(path.delimiter);
}

const PATH = shellPath();

function nodeExecutableName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function runtimeRoot() {
  return path.join(process.resourcesPath, 'agentdock');
}

function resolveServerPaths() {
  if (app.isPackaged) {
    return {
      cli: path.join(runtimeRoot(), 'dist', 'cli.js'),
      node: path.join(process.resourcesPath, 'node-runtime', nodeExecutableName())
    };
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cli = process.env.AGENTDOCK_DESKTOP_CLI || path.join(repoRoot, 'apps', 'server', 'dist', 'cli.js');
  return { cli, node: process.env.AGENTDOCK_DESKTOP_NODE || findSystemNode() };
}

function findSystemNode() {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', env: { ...process.env, PATH } });
    const first = (result.stdout ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (first) return first;
  } catch { /* fall through */ }
  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.local', 'bin', 'node')
  ];
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const version of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, version, 'bin', 'node'));
  } catch { /* no nvm */ }
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return 'node';
}

function checkedBinary(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  state.recentLog.push(entry);
  if (state.recentLog.length > 120) state.recentLog.shift();
  try { state.logStream?.write(`${entry}\n`); } catch { /* logging must never crash the shell */ }
  if (!app.isPackaged) console.log(entry);
}

function logTail(limit = 20) {
  return state.recentLog.slice(-limit).join('\n');
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const unsupportedUpdateState = () => ({
  phase: 'unsupported',
  currentVersion: app.getVersion(),
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: '当前构建不支持应用内更新'
});

function broadcastUpdateState(next) {
  const win = state.window;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('agentdock:desktop-update:state', next);
  } catch {
    // The window can close between the check and the send; the next snapshot
    // is fetched by the renderer on load.
  }
}

/**
 * Wire electron-updater.
 *
 * Packaged builds read app-update.yml generated by electron-builder (GitHub
 * provider). Dev builds only enable the updater when AGENTDOCK_DESKTOP_UPDATE_URL
 * points at a mock generic feed, which is how the smoke tests exercise the real
 * download/progress path without publishing a release.
 */
function setUpdater() {
  const feedUrl = process.env.AGENTDOCK_DESKTOP_UPDATE_URL?.trim();
  if (!app.isPackaged && !feedUrl) {
    state.updater = createUpdaterController({ app, updater: null, log });
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: message => log(`[updater] ${message}`),
    warn: message => log(`[updater:warn] ${message}`),
    error: message => log(`[updater:error] ${message}`),
    debug: message => {
      if (process.env.AGENTDOCK_DESKTOP_UPDATE_DEBUG === '1') return log(`[updater:debug] ${message}`);
      return undefined;
    }
  };
  if (!app.isPackaged) {
    // electron-updater refuses to check in dev unless forced; the update config
    // is dev-app-update.yml in the app directory (created by the smoke script).
    autoUpdater.forceDevUpdateConfig = true;
    if (feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  }

  state.updater = createUpdaterController({
    app,
    updater: autoUpdater,
    log,
    emit: broadcastUpdateState,
    autoDownloadOnAvailable: process.env.AGENTDOCK_DESKTOP_UPDATE_AUTO_DOWNLOAD === '1',
    firstCheckDelayMs: numberEnv('AGENTDOCK_DESKTOP_UPDATE_CHECK_DELAY_MS', 20_000),
    beforeInstall: async () => {
      // Mark first: stopDaemon() makes the child exit, and handleDaemonExit()
      // must not show the "service stopped" dialog during an update install.
      state.installingUpdate = true;
      await stopDaemon();
    },
    onInstallError: () => {
      state.installingUpdate = false;
    }
  });
  state.updater.start();
}

function registerUpdateIpc() {
  ipcMain.handle('agentdock:desktop-update:get', () => state.updater?.snapshot() ?? unsupportedUpdateState());
  ipcMain.handle('agentdock:desktop-update:check', () => state.updater?.check() ?? unsupportedUpdateState());
  ipcMain.handle('agentdock:desktop-update:download', () => state.updater?.download() ?? unsupportedUpdateState());
  ipcMain.handle('agentdock:desktop-update:install', () => {
    if (!state.updater) return Promise.reject(new Error('当前构建不支持应用内更新'));
    return state.updater.install();
  });
}

/** 手机扫码要连到这台电脑，服务就不能只绑回环；默认关闭，由用户在「在手机上打开」里显式开启。 */
function lanAccessEnabled() {
  return readJson(userDataPath('settings.json'), {}).lanAccess === true;
}

function networkState() {
  return { lanAccess: lanAccessEnabled(), ...(state.port ? { port: state.port } : {}) };
}

function registerNetworkIpc() {
  ipcMain.handle('agentdock:desktop-network:get', () => networkState());
  ipcMain.handle('agentdock:desktop-network:set-lan-access', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
    const saved = readJson(userDataPath('settings.json'), {});
    const changed = (saved.lanAccess === true) !== enabled;
    writeJson(userDataPath('settings.json'), { ...saved, lanAccess: enabled, updatedAt: new Date().toISOString() });
    // 先让 IPC 回复送达渲染进程（界面能显示「正在重启」），再重启子进程并重新加载窗口。
    if (changed) setTimeout(() => { void restartService(); }, 300);
    return { lanAccess: enabled, ...(state.port ? { port: state.port } : {}) };
  });
}

async function checkUpdatesFromMenu() {
  if (!state.updater) return;
  const next = await state.updater.check();
  if (next.phase === 'available') {
    // The sidebar banner is the progress surface; keep the menu action quiet.
    const result = await dialog.showMessageBox({
      type: 'info',
      title: `${APP_NAME} 发现新版本`,
      message: `新版本 ${next.latestVersion} 可用`,
      detail: '可在设置菜单里下载并安装。',
      buttons: ['好'],
      defaultId: 0
    });
    void result;
    return;
  }
  if (next.phase === 'idle') {
    await dialog.showMessageBox({
      type: 'info',
      title: `${APP_NAME} 已是最新版本`,
      message: `当前版本 ${next.currentVersion}`,
      buttons: ['好'],
      defaultId: 0
    });
    return;
  }
  if (next.phase === 'error') {
    await dialog.showMessageBox({
      type: 'error',
      title: `${APP_NAME} 检查更新失败`,
      message: next.error ?? '未知错误',
      buttons: ['好'],
      defaultId: 0
    });
  }
}

function prepareLog() {
  const file = userDataPath('logs', 'daemon.log');
  state.logPath = file;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* first run */ }
    state.logStream = fs.createWriteStream(file, { flags: 'a' });
  } catch { state.logStream = null; }
}

function tryListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(undefined));
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address()?.port;
      server.close(() => resolve(typeof actual === 'number' ? actual : undefined));
    });
  });
}

/**
 * A bind test alone is not enough on macOS: a daemon listening on `*:4310`
 * (IPv6 wildcard) can coexist with a socket bound to `127.0.0.1:4310`, and the
 * kernel may still route loopback clients to the wildcard listener. Probe with
 * a real connect first, so we never pick a port that something already serves.
 */
function portHasListener(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function choosePort(exclude = new Set()) {
  const saved = readJson(userDataPath('settings.json'), {});
  const candidates = [...new Set([Number(saved.port), DEFAULT_PORT, ...FALLBACK_PORTS].filter(port => Number.isInteger(port) && port > 0 && port < 65536 && !exclude.has(port)))];
  for (const candidate of candidates) {
    if (await portHasListener(candidate)) continue;
    const free = await tryListen(candidate);
    if (free !== undefined) return free;
  }
  return await tryListen(0) ?? DEFAULT_PORT;
}

function instanceCheck(port, token, timeoutMs = 1_200) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/desktop/instance', timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 4_096) body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(response.statusCode === 200 && parsed.token === token);
        } catch { resolve(false); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function waitForInstance(port, token, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.quitting) return false;
    if (child && child.exitCode !== null) return false;
    if (await instanceCheck(port, token)) return true;
    await sleep(150);
  }
  return false;
}

function baseUrlFor(port) {
  return `http://127.0.0.1:${port}`;
}

async function startDaemon() {
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const { cli, node } = resolveServerPaths();
    if (!fs.existsSync(cli)) throw new Error(`找不到服务端入口：${cli}\n请先运行 pnpm build。`);
    if (!checkedBinary(node)) throw new Error(`Node 运行时不可用：${node}`);

    const dataDir = state.dataDir ?? userDataPath('data');
    const database = path.join(dataDir, 'agentdock.db');
    const cwd = process.env.AGENTDOCK_DESKTOP_CWD || app.getPath('home');
    fs.mkdirSync(dataDir, { recursive: true });
    log(`数据目录：${dataDir}`);

    const tried = new Set();
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (state.quitting) throw new Error('应用正在退出');
      const port = await choosePort(tried);
      tried.add(port);
      const instanceToken = crypto.randomUUID();
      const lanAccess = lanAccessEnabled();
      // 默认只监听回环，但访问防护始终开启：本机窗口来自回环，会被自动补发 master
      // 凭证，不出现登录框；同时这层门也挡住了本机浏览器里其他网页借回环发起的
      // CSRF/DNS-rebinding 请求。开启「局域网访问」只改变监听面（--host 0.0.0.0），
      // 不改变鉴权；手机扫码拿到的是会话级令牌，局域网匿名请求一律 401。
      const args = lanAccess
        ? [cli, '--host', '0.0.0.0', '--port', String(port), '--database', database, '--cwd', cwd]
        : [cli, '--local-only', '--port', String(port), '--database', database, '--cwd', cwd];
      log(`启动服务（第 ${attempt} 次，端口 ${port}，局域网访问${lanAccess ? '开启' : '关闭'}）：${node} ${args.map(arg => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);

      const child = spawn(node, args, {
        cwd: app.isPackaged ? dataDir : path.dirname(cli),
        env: {
          ...process.env,
          PATH,
          // Always on: loopback clients pass as the machine owner, while a
          // rebound domain or a cross-site page cannot. Public QR links also
          // need a signing secret even when the shell stays on loopback.
          AGENTDOCK_WEB_AUTH: 'on',
          // Ownership proof: /health from some other daemon on the same port
          // must not be mistaken for our child becoming ready.
          AGENTDOCK_DESKTOP_INSTANCE: instanceToken
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group on Unix so quit can terminate the server *and* the
        // agent CLIs it spawned with one signal.
        detached: process.platform !== 'win32'
      });
      state.child = child;
      state.port = port;
      state.baseUrl = baseUrlFor(port);

      child.stdout?.on('data', chunk => {
        for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) log(`[server] ${line}`);
      });
      child.stderr?.on('data', chunk => {
        for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) log(`[server:err] ${line}`);
      });
      child.once('error', error => log(`服务进程错误：${error.message}`));
      child.once('exit', (code, signal) => {
        log(`服务进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        if (state.child === child) state.child = null;
        // During startup the boot/restart path owns the error dialog; showing one
        // here as well would stack two dialogs for the same exit.
        if (state.quitting || state.restarting || state.starting || state.installingUpdate) return;
        void handleDaemonExit(code, signal);
      });

      const ready = await waitForInstance(port, instanceToken, child, STARTUP_TIMEOUT_MS);
      if (ready) {
        writeJson(userDataPath('settings.json'), { ...readJson(userDataPath('settings.json'), {}), port, updatedAt: new Date().toISOString() });
        log(`服务就绪：${state.baseUrl}`);
        return state.baseUrl;
      }

      lastError = `端口 ${port} 未等到本次启动的服务实例（进程${child.exitCode === null ? '仍在运行但端口不接受请求' : `已退出，code=${child.exitCode}`}）`;
      log(`${lastError}，重试`);
      await stopDaemon({ forRestart: true });
    }
    throw new Error(`本地服务在 ${Math.round(STARTUP_TIMEOUT_MS / 1000)} 秒内未就绪。\n${lastError}\n\n最近的日志：\n${logTail(14)}`);
  })().finally(() => { state.starting = null; });
  return state.starting;
}

function killChildTree(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

async function stopDaemon({ forRestart = false } = {}) {
  if (forRestart) state.restarting = true;
  const child = state.child;
  state.child = null;
  if (!child || child.exitCode !== null) {
    if (forRestart) state.restarting = false;
    return;
  }
  const exited = new Promise(resolve => {
    if (child.exitCode !== null) return resolve(true);
    child.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS).unref?.();
  });
  killChildTree(child, 'SIGTERM');
  if (!(await exited)) killChildTree(child, 'SIGKILL');
  if (forRestart) state.restarting = false;
}

async function handleDaemonExit(code, signal) {
  if (state.quitting) return;
  const result = await dialog.showMessageBox({
    type: 'error',
    title: `${APP_NAME} 服务已停止`,
    message: '本地 AgentDock 服务意外退出。',
    detail: `code=${code ?? 'null'} signal=${signal ?? 'null'}\n日志：${state.logPath}\n\n${logTail(8)}`,
    buttons: ['重启服务', '退出'],
    defaultId: 0,
    cancelId: 1
  });
  if (result.response === 0) void restartService();
  else app.quit();
}

function splashHtml() {
  return `<!doctype html><meta charset="utf-8"><title>${APP_NAME}</title>
<style>
:root{color-scheme:light dark}html,body{height:100%;margin:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){html,body{background:#09090b;color:#e4e4e7}.sub{color:#a1a1aa!important}.spinner{border-color:#3f3f46!important;border-top-color:#a78bfa!important}}
body{display:grid;place-items:center}.box{display:flex;flex-direction:column;align-items:center;gap:18px}
.logo{width:72px;height:72px;border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.18)}
.title{font-size:15px;font-weight:600;letter-spacing:.01em}.sub{font-size:12px;color:#71717a;display:flex;align-items:center;gap:8px}
.spinner{width:12px;height:12px;border-radius:50%;border:2px solid #e4e4e7;border-top-color:#7c3aed;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
<div class="box">
<svg class="logo" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="8" y1="5" x2="57" y2="61" gradientUnits="userSpaceOnUse"><stop stop-color="#292b31"/><stop offset="1" stop-color="#090a0d"/></linearGradient><linearGradient id="beam" x1="18" y1="45" x2="48" y2="17" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="#b8b9c2"/></linearGradient><linearGradient id="pulse" x1="38" y1="20" x2="50" y2="31" gradientUnits="userSpaceOnUse"><stop stop-color="#c4b5fd"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#bg)"/><path d="M42 17H29c-8.3 0-15 6.7-15 15s6.7 15 15 15h13" fill="none" stroke="url(#beam)" stroke-width="5" stroke-linecap="round"/><path d="M42 25H30a7 7 0 0 0 0 14h12" fill="none" stroke="#71717a" stroke-width="4" stroke-linecap="round"/><circle cx="45" cy="25" r="5" fill="url(#pulse)" stroke="#ddd6fe" stroke-width="1.5"/><circle cx="45" cy="39" r="3" fill="#f4f4f5"/></svg>
<div class="title">${APP_NAME}</div>
<div class="sub"><span class="spinner"></span>正在启动本地服务…</div>
</div>`;
}

function restoreBounds() {
  const saved = readJson(userDataPath('window-state.json'), {});
  const width = Math.max(900, Math.min(Number(saved.width) || 1280, 3000));
  const height = Math.max(600, Math.min(Number(saved.height) || 860, 2000));
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const visible = screen.getAllDisplays().some(display => {
      const area = display.workArea;
      return saved.x < area.x + area.width - 80 && saved.x + width > area.x + 80 && saved.y >= area.y - 20 && saved.y < area.y + area.height - 80;
    });
    if (visible) return { x: saved.x, y: saved.y, width, height };
  }
  return { width, height };
}

function saveBounds(win) {
  try {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    const bounds = win.getBounds();
    writeJson(userDataPath('window-state.json'), bounds);
  } catch { /* non-fatal */ }
}

function createWindow() {
  const bounds = restoreBounds();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: '#09090b',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  state.window = win;

  win.once('ready-to-show', () => win.show());
  // The renderer subscribes on mount, but the periodic check may have already
  // produced a state before that; push the current snapshot once the page is in.
  win.webContents.on('did-finish-load', () => {
    broadcastUpdateState(state.updater?.snapshot() ?? unsupportedUpdateState());
  });
  win.on('close', () => saveBounds(win));
  win.on('closed', () => { if (state.window === win) state.window = null; });

  const openExternal = url => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (state.baseUrl && url.startsWith(state.baseUrl)) return;
    event.preventDefault();
    openExternal(url);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log(`页面加载失败：${code} ${description} ${url}`);
    if (state.quitting) return;
    void dialog.showMessageBox(win, {
      type: 'error',
      title: `${APP_NAME} 无法打开界面`,
      message: '本地服务没有响应。',
      detail: `${description}\n${url}\n日志：${state.logPath}`,
      buttons: ['重试', '重启服务', '退出'],
      defaultId: 0,
      cancelId: 2
    }).then(result => {
      if (result.response === 0 && state.baseUrl) void win.loadURL(state.baseUrl);
      else if (result.response === 1) void restartService();
      else app.quit();
    });
  });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml())}`);
  return win;
}

function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '重启本地服务',
          click: () => void restartService()
        },
        {
          label: '检查更新…',
          click: () => void checkUpdatesFromMenu()
        },
        {
          label: '在浏览器中打开',
          click: () => { if (state.baseUrl) void shell.openExternal(state.baseUrl); }
        },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => { void shell.openPath(state.dataDir ?? userDataPath('data')); }
        },
        {
          label: '打开日志',
          click: () => { if (state.logPath) void shell.openPath(state.logPath); }
        },
        { type: 'separator' },
        ...(process.platform === 'darwin' ? [] : [{ role: 'quit', label: '退出' }])
      ]
    },
    {
      label: '编辑',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function restartService() {
  if (state.restarting) return;
  const win = state.window;
  try {
    await stopDaemon({ forRestart: true });
    const url = await startDaemon();
    if (win && !win.isDestroyed() && url) await win.loadURL(url);
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: `${APP_NAME} 重启失败`,
      message: '本地服务重启失败。',
      detail: `${error instanceof Error ? error.message : String(error)}\n\n${logTail(12)}`,
      buttons: ['退出'],
      defaultId: 0
    });
    app.quit();
  }
}

async function boot() {
  state.dataDir = userDataPath('data');
  prepareLog();
  log(`${APP_NAME} ${app.getVersion()} 启动 (${process.platform}/${process.arch})`);
  installMenu();
  registerUpdateIpc();
  registerNetworkIpc();
  setUpdater();
  const win = createWindow();
  try {
    const url = await startDaemon();
    if (state.quitting) return;
    await win.loadURL(url);
    // Headless-ish smoke test hook: render the real UI to a PNG and exit.
    // Used by the self-test and available to CI without a display server.
    const capture = process.env.AGENTDOCK_DESKTOP_CAPTURE;
    if (capture) {
      await sleep(numberEnv('AGENTDOCK_DESKTOP_CAPTURE_DELAY_MS', 2_500));
      log(`截图前更新状态：${JSON.stringify(state.updater?.snapshot() ?? unsupportedUpdateState())}`);
      // Smoke-test hook: the update entry lives inside the settings popup, so a
      // plain window capture would only show the "有新版本" dot. Test-only.
      if (process.env.AGENTDOCK_DESKTOP_CAPTURE_OPEN_SETTINGS === '1') {
        await win.webContents.executeJavaScript(`(() => { const buttons = document.querySelectorAll('[aria-haspopup="menu"]'); const last = buttons[buttons.length - 1]; if (last instanceof HTMLElement) { last.click(); return true; } return false; })()`);
        await sleep(500);
      }
      const image = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(capture), { recursive: true });
      fs.writeFileSync(capture, image.toPNG());
      log(`截图已保存：${capture}`);
      if (process.env.AGENTDOCK_DESKTOP_CAPTURE_QUIT !== '0') app.quit();
    }
  } catch (error) {
    log(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    await dialog.showMessageBox({
      type: 'error',
      title: `${APP_NAME} 启动失败`,
      message: '本地服务没有启动起来。',
      detail: `${error instanceof Error ? error.message : String(error)}\n\n日志：${state.logPath}`,
      buttons: ['重试', '退出'],
      defaultId: 0,
      cancelId: 1
    }).then(result => {
      if (result.response === 0) void restartService();
      else app.quit();
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = state.window;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox(`${APP_NAME} 启动失败`, error instanceof Error ? error.stack ?? error.message : String(error));
    app.quit();
  });

  app.on('activate', () => {
    if (state.window) {
      state.window.show();
      state.window.focus();
      return;
    }
    if (state.baseUrl) createWindow()?.loadURL(state.baseUrl);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', event => {
    if (state.quitting) return;
    // The install path stopped the daemon already; let Squirrel/NSIS replace
    // the bundle instead of re-running the normal quit teardown.
    if (state.installingUpdate) {
      state.quitting = true;
      return;
    }
    event.preventDefault();
    state.quitting = true;
    log('退出：停止本地服务');
    void stopDaemon().finally(() => {
      try { state.logStream?.end(); } catch { /* ignore */ }
      app.exit(0);
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => app.quit());
  }
}
