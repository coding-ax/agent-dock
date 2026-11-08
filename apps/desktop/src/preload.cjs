'use strict';

/**
 * Bridge between the desktop shell and the web UI.
 *
 * The renderer is the same build the daemon serves to browsers, so the updater
 * surface is exposed only when the shell is present. Everything stays inside
 * contextIsolation: no Node APIs, only the small update contract.
 */

const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'agentdock:desktop-update:state';
const listeners = new Map();
let nextListenerId = 1;

ipcRenderer.on(STATE_CHANNEL, (_event, state) => {
  for (const listener of listeners.values()) {
    try {
      listener(state);
    } catch {
      // A renderer listener must never break the bridge for the others.
    }
  }
});

const update = {
  getState: () => ipcRenderer.invoke('agentdock:desktop-update:get'),
  check: () => ipcRenderer.invoke('agentdock:desktop-update:check'),
  download: () => ipcRenderer.invoke('agentdock:desktop-update:download'),
  install: () => ipcRenderer.invoke('agentdock:desktop-update:install'),
  subscribe: listener => {
    const id = nextListenerId++;
    listeners.set(id, listener);
    return id;
  },
  unsubscribe: id => {
    listeners.delete(id);
  }
};

const network = {
  getState: () => ipcRenderer.invoke('agentdock:desktop-network:get'),
  // Toggling restarts the bundled daemon and reloads this window.
  setLanAccess: enabled => ipcRenderer.invoke('agentdock:desktop-network:set-lan-access', enabled)
};

contextBridge.exposeInMainWorld('agentdockDesktop', { update, network });
