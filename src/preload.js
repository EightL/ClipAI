// Preload script - exposes a minimal, namespaced API to renderer via contextBridge
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  summarizeSelection: () => ipcRenderer.invoke('clipai:summarize-selection'),
  runPreset: (id) => ipcRenderer.invoke('clipai:run-preset', id),
  saveProviderKey: (provider, key, model) => ipcRenderer.invoke('clipai:save-provider-key', provider, key, model),
  getConfig: () => ipcRenderer.invoke('clipai:get-config'),
  setActiveProvider: (provider) => ipcRenderer.invoke('clipai:set-active-provider', provider),
  setTheme: (theme) => ipcRenderer.invoke('clipai:set-theme', theme),
  setMemoryMode: (mode) => ipcRenderer.invoke('clipai:set-memory-mode', mode),
  setMarkdownEnabled: (enabled) => ipcRenderer.invoke('clipai:set-markdown-enabled', enabled),
  setMarkdownMode: (mode) => ipcRenderer.invoke('clipai:set-markdown-mode', mode),
  // FIX: Added the missing setAutoCopySelection function to the API
  setAutoCopySelection: (enabled) => ipcRenderer.invoke('clipai:set-auto-copy-selection', enabled),
  resize: (w,h) => ipcRenderer.invoke('clipai:resize', w, h),
  getClipboard: () => ipcRenderer.invoke('clipai:get-clipboard'),
  openSettings: () => ipcRenderer.invoke('clipai:open-settings'),
  toggleSettings: () => ipcRenderer.invoke('clipai:toggle-settings'),
  listModels: (provider) => ipcRenderer.invoke('clipai:list-models', provider),
  getSummaryPresets: () => ipcRenderer.invoke('clipai:get-summary-presets'),
  resetConfig: () => ipcRenderer.invoke('clipai:reset-config'),
  resetPreferences: () => ipcRenderer.invoke('clipai:reset-preferences'),
  setSummaryPresets: (data) => ipcRenderer.invoke('clipai:set-summary-presets', data),
  getDocumentSessions: () => ipcRenderer.invoke('clipai:get-document-sessions'),
  setDocumentSessions: (sessions) => ipcRenderer.invoke('clipai:set-document-sessions', sessions),
  setActiveDocumentSession: (session) => ipcRenderer.invoke('clipai:set-active-document-session', session),
  setUnlimitedInput: (enabled) => ipcRenderer.invoke('clipai:set-unlimited-input', enabled),
  setAutoContextBuilding: (enabled) => ipcRenderer.invoke('clipai:set-auto-context-building', enabled),
  setMaxInputChars: (chars) => ipcRenderer.invoke('clipai:set-max-input-chars', chars),
  setSessionContext: (sessionId, insights) => ipcRenderer.invoke('clipai:set-session-context', sessionId, insights),
  hideWindow: () => ipcRenderer.invoke('clipai:hide-window'),
  hideAfterFade: () => ipcRenderer.invoke('clipai:hide-after-fade'),
  setAutoHideMs: (ms) => ipcRenderer.invoke('clipai:set-auto-hide-ms', ms),
  autoHideHover: (state) => ipcRenderer.invoke('clipai:auto-hide-hover', state),
  forceHideNow: () => ipcRenderer.invoke('clipai:force-hide-now'),
  setTextAppearance: (settings) => ipcRenderer.invoke('clipai:set-text-appearance', settings),
  markOnboardingComplete: () => ipcRenderer.invoke('clipai:mark-onboarded'),
  onSummary: (cb) => { ipcRenderer.removeAllListeners('clipai:summary'); ipcRenderer.on('clipai:summary', (_, payload)=> cb && cb(payload)); },
  onThemeChanged: (cb) => { ipcRenderer.removeAllListeners('clipai:theme-changed'); ipcRenderer.on('clipai:theme-changed', (_, theme)=> cb && cb(theme)); },
  onMarkdownChanged: (cb) => { ipcRenderer.removeAllListeners('clipai:markdown-changed'); ipcRenderer.on('clipai:markdown-changed', (_, enabled)=> cb && cb(enabled)); },
  onMarkdownModeChanged: (cb) => { ipcRenderer.removeAllListeners('clipai:markdown-mode-changed'); ipcRenderer.on('clipai:markdown-mode-changed', (_, mode)=> cb && cb(mode)); },
  onSettingsOpenChanged: (cb) => { ipcRenderer.removeAllListeners('clipai:settings-open-changed'); ipcRenderer.on('clipai:settings-open-changed', (_, open)=> cb && cb(open)); }
};

api.onAutoHideMsChanged = (cb)=>{ ipcRenderer.removeAllListeners('clipai:auto-hide-ms'); ipcRenderer.on('clipai:auto-hide-ms', (_, ms)=> cb && cb(ms)); };

api.onTextAppearanceChanged = (cb)=>{ ipcRenderer.removeAllListeners('clipai:text-appearance-changed'); ipcRenderer.on('clipai:text-appearance-changed', (_, settings)=> cb && cb(settings)); };

// Internal event bridge for fade-out
ipcRenderer.on('clipai:start-fade-out', ()=>{
  try { document.dispatchEvent(new CustomEvent('clipai-start-fade-out')); } catch(e){}
});

contextBridge.exposeInMainWorld('clipAI', api);