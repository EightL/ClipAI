// Preload (context isolated)
// Exposes a minimal, audited API surface into the renderer. Keep this file *small*.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipAI', {
  // --- Core actions ---
  summarizeSelection: () => ipcRenderer.invoke('clipai:summarize-selection'),
  onSummary: (cb) => ipcRenderer.on('clipai:summary', (_e, data) => cb(data)),
  // --- Legacy single provider key helpers (kept for backwards compat) ---
  saveKey: (k) => ipcRenderer.invoke('clipai:save-key', k), // legacy single-key
  getKeyStatus: () => ipcRenderer.invoke('clipai:key-status'),
  // Multi-provider config
  getConfig: () => ipcRenderer.invoke('clipai:get-config'),
  saveProviderKey: (provider, key, model) => ipcRenderer.invoke('clipai:save-provider-key', {provider, key, model}),
  setActiveProvider: (provider) => ipcRenderer.invoke('clipai:set-active-provider', provider),
  setTheme: (theme) => ipcRenderer.invoke('clipai:set-theme', theme),
    setMemoryMode: (mode) => ipcRenderer.invoke('clipai:set-memory-mode', mode),
    setMarkdownEnabled: (enabled) => ipcRenderer.invoke('clipai:set-markdown-enabled', enabled),
  processText: (text, mode='summary') => ipcRenderer.invoke('clipai:process-text', {text, mode}),
  resize: (width,height) => ipcRenderer.invoke('clipai:resize', {width,height}),
  getClipboard: () => ipcRenderer.invoke('clipai:get-clipboard'),
  setHotkeys: (summarize, explain) => ipcRenderer.invoke('clipai:set-hotkeys', {summarize, explain})
  ,openSettings: ()=> ipcRenderer.invoke('clipai:open-settings')
  ,getPrompts: () => ipcRenderer.invoke('clipai:get-prompts')
  ,setPromptSelection: (summary, explain) => ipcRenderer.invoke('clipai:set-prompt-selection', {summary, explain})
  ,setCustomPrompt: (summary, explain) => ipcRenderer.invoke('clipai:set-custom-prompt', {summary, explain})
  ,listModels: (provider)=> ipcRenderer.invoke('clipai:list-models',{provider})
  ,onThemeChanged: (cb)=> ipcRenderer.on('clipai:theme-changed', (_e,d)=> cb(d.theme))
  ,hideWindow: ()=> ipcRenderer.invoke('clipai:hide-window')
});
