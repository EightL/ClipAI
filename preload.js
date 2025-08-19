const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipAI', {
  summarizeSelection: () => ipcRenderer.invoke('clipai:summarize-selection'),
  onSummary: (cb) => ipcRenderer.on('clipai:summary', (_e, data) => cb(data)),
  saveKey: (k) => ipcRenderer.invoke('clipai:save-key', k), // legacy single-key
  getKeyStatus: () => ipcRenderer.invoke('clipai:key-status'),
  // Multi-provider config
  getConfig: () => ipcRenderer.invoke('clipai:get-config'),
  saveProviderKey: (provider, key, model) => ipcRenderer.invoke('clipai:save-provider-key', {provider, key, model}),
  setActiveProvider: (provider) => ipcRenderer.invoke('clipai:set-active-provider', provider),
  setTheme: (theme) => ipcRenderer.invoke('clipai:set-theme', theme),
  setMemoryMode: (mode) => ipcRenderer.invoke('clipai:set-memory-mode', mode),
  processText: (text, mode='summary') => ipcRenderer.invoke('clipai:process-text', {text, mode}),
  resize: (width,height) => ipcRenderer.invoke('clipai:resize', {width,height}),
  getClipboard: () => ipcRenderer.invoke('clipai:get-clipboard'),
  setHotkeys: (summarize, explain) => ipcRenderer.invoke('clipai:set-hotkeys', {summarize, explain})
});
