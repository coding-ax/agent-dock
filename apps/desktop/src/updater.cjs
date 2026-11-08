'use strict';

/**
 * Desktop auto-update state machine.
 *
 * electron-updater (Squirrel.Mac on macOS, NSIS on Windows) performs the actual
 * check / download / install. This module owns the state the renderer renders,
 * broadcasts every transition over IPC, and guards the actions: download only
 * after a check found an update, install only after the download finished.
 *
 * The updater is injected instead of required here so the shell and vitest can
 * drive the same transitions without Electron.
 */

const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const messageOf = error => (error instanceof Error ? error.message : String(error ?? '未知错误'));

const notesText = notes => {
  if (!notes) return undefined;
  const text = Array.isArray(notes)
    ? notes.map(item => (item && typeof item.note === 'string' ? item.note : '')).join('\n')
    : String(notes);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 4_000) : undefined;
};

function createUpdaterController(options) {
  const {
    app,
    updater,
    log = () => {},
    emit = () => {},
    beforeInstall = async () => {},
    onInstallError = () => {},
    firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
    checkIntervalMs = CHECK_INTERVAL_MS,
    autoDownloadOnAvailable = false
  } = options;

  const state = {
    phase: updater ? 'idle' : 'unsupported',
    currentVersion: app.getVersion(),
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    ...(updater ? {} : { error: '当前构建不支持应用内更新' })
  };
  let checkPromise = null;
  let downloadPromise = null;
  let installPromise = null;
  let firstTimer;
  let intervalTimer;

  const snapshot = () => ({ ...state });
  const publish = patch => {
    Object.assign(state, patch);
    const progress = state.phase === 'downloading' ? ` ${Math.round(state.percent)}%` : '';
    log(`[update] ${state.phase}${state.latestVersion ? ` target=${state.latestVersion}` : ''}${progress}${state.error ? ` error=${state.error}` : ''}`);
    try {
      emit(snapshot());
    } catch (error) {
      log(`[update] emit failed: ${messageOf(error)}`);
    }
  };
  const fail = error => {
    publish({ phase: 'error', error: messageOf(error), percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
  };

  if (updater) {
    // The shell drives both steps: opening the sidebar must not silently
    // download tens of MB, and quitting the app must not install an update the
    // user has not confirmed.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;

    updater.on('checking-for-update', () => publish({ phase: 'checking', error: undefined }));
    updater.on('update-available', info => {
      publish({
        phase: 'available',
        latestVersion: info?.version,
        releaseNotes: notesText(info?.releaseNotes),
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
        error: undefined,
        checkedAt: Date.now()
      });
      if (autoDownloadOnAvailable) void download();
    });
    updater.on('update-not-available', () => {
      publish({
        phase: 'idle',
        latestVersion: undefined,
        releaseNotes: undefined,
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
        error: undefined,
        checkedAt: Date.now()
      });
    });
    updater.on('download-progress', progress => {
      publish({
        phase: 'downloading',
        percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
        transferred: progress?.transferred ?? 0,
        total: progress?.total ?? 0,
        bytesPerSecond: progress?.bytesPerSecond ?? 0
      });
    });
    updater.on('update-downloaded', info => {
      publish({
        phase: 'downloaded',
        latestVersion: info?.version ?? state.latestVersion,
        percent: 100,
        bytesPerSecond: 0,
        error: undefined
      });
    });
    updater.on('error', error => fail(error));
  }

  async function check() {
    if (!updater) return snapshot();
    if (checkPromise) return checkPromise;
    if (!['idle', 'available', 'error', 'checking'].includes(state.phase)) return snapshot();
    publish({ phase: 'checking', error: undefined });
    checkPromise = (async () => {
      try {
        await updater.checkForUpdates();
        // The events above normally settle the phase; only fall back when the
        // updater resolved without emitting either outcome.
        if (state.phase === 'checking') publish({ phase: 'idle', checkedAt: Date.now() });
      } catch (error) {
        fail(error);
      } finally {
        checkPromise = null;
      }
      return snapshot();
    })();
    return checkPromise;
  }

  async function download() {
    if (!updater) return snapshot();
    if (downloadPromise) return downloadPromise;
    if (state.phase !== 'available') return snapshot();
    publish({ phase: 'downloading', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, error: undefined });
    downloadPromise = (async () => {
      try {
        await updater.downloadUpdate();
        if (state.phase === 'downloading') publish({ phase: 'downloaded', percent: 100, bytesPerSecond: 0 });
      } catch (error) {
        fail(error);
      } finally {
        downloadPromise = null;
      }
      return snapshot();
    })();
    return downloadPromise;
  }

  async function install() {
    if (!updater) throw new Error('当前构建不支持应用内更新');
    if (state.phase !== 'downloaded') throw new Error('更新包尚未下载完成');
    if (installPromise) return installPromise;
    publish({ phase: 'installing' });
    installPromise = (async () => {
      try {
        // Stop the bundled daemon and every agent process first: the updater
        // replaces the app bundle and restarts the shell, and a child holding
        // the loopback port would otherwise keep running against stale code.
        await beforeInstall();
        updater.quitAndInstall(false, true);
      } catch (error) {
        onInstallError();
        fail(error);
        installPromise = null;
        throw error;
      }
      return snapshot();
    })();
    return installPromise;
  }

  function start() {
    if (!updater) return;
    firstTimer = setTimeout(() => { void check(); }, firstCheckDelayMs);
    intervalTimer = setInterval(() => { void check(); }, checkIntervalMs);
    firstTimer.unref?.();
    intervalTimer.unref?.();
  }

  function stop() {
    if (firstTimer) clearTimeout(firstTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    firstTimer = undefined;
    intervalTimer = undefined;
  }

  return { snapshot, check, download, install, start, stop };
}

module.exports = { createUpdaterController, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS };
