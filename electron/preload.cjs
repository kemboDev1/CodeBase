'use strict';

/**
 * Preload bridge. The renderer runs with contextIsolation + sandbox and no Node
 * integration; everything it needs comes through `window.codebase`.
 */

const { contextBridge, ipcRenderer } = require('electron');

function argValue(prefix) {
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const port = Number(argValue('--codebase-port=')) || 0;
const token = argValue('--codebase-token=');
const version = argValue('--codebase-version=') || '1.0.0';

contextBridge.exposeInMainWorld('codebase', {
  ready: true,
  version,
  port,
  token,
  platform: process.platform,
  apiBase: port ? `http://127.0.0.1:${port}/api` : '',

  pickFolder: () => ipcRenderer.invoke('codebase:pick-folder'),
  openPath: (target) => ipcRenderer.invoke('codebase:open-path', target),
  showInFolder: (target) => ipcRenderer.invoke('codebase:show-in-folder', target),
  openExternal: (url) => ipcRenderer.invoke('codebase:open-external', url),
  systemInfo: () => ipcRenderer.invoke('codebase:system-info'),
  backendLogs: () => ipcRenderer.invoke('codebase:backend-logs'),
  restartBackend: () => ipcRenderer.invoke('codebase:backend-restart'),

  ollamaStatus: () => ipcRenderer.invoke('codebase:ollama-status'),
  startOllama: () => ipcRenderer.invoke('codebase:ollama-start'),
  stopOllama: () => ipcRenderer.invoke('codebase:ollama-stop'),
  getOllamaAutostart: () => ipcRenderer.invoke('codebase:ollama-autostart-get'),
  setOllamaAutostart: (enabled) => ipcRenderer.invoke('codebase:ollama-autostart-set', enabled),

  onStatus: (callback) => {
    const handler = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        /* ignore renderer errors */
      }
    };
    ipcRenderer.on('codebase:status', handler);
    return () => ipcRenderer.removeListener('codebase:status', handler);
  }
});
