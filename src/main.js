// ClipAI main process
// Implements popup summary bubble, settings/onboarding/help windows, tray menu,
// config persistence & migration, provider-agnostic summarization, global shortcuts,
// selection capture, summary presets, and IPC surface.

const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ------------------------- Constants / Defaults -------------------------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const MAX_TEXT_LEN = 4000; // char limit
// Removed aggressive memory destruction delay constant (feature removed)
const MAX_PRESETS = 5; // user-defined presets
const DEFAULT_SUMMARY_PROMPT = 'Summarize in \u22643 concise sentences. Use Markdown formatting (headers, bold, italic, lists)';

// Provider default models (fallbacks when user leaves blank)
const PROVIDER_DEFAULT_MODELS = {
  openai: 'gpt-5-mini',
  groq: 'llama-3.1-70b-versatile', // still needs a model identifier for Groq's OpenAI-compatible endpoint
  gemini: 'gemini-2.5-flash-lite',
  anthropic: 'claude-3',
  grok: 'grok-4'
};

// ------------------------- In-Memory State -------------------------
let configCache = null; // loaded config
let tray = null;
let popupWindow = null;
let settingsWindow = null;
let onboardingWindow = null;
let shortcutHelpWindow = null;
let popupDestroyTimer = null;
let popupAutoHideTimer = null; // timer for user-configured auto-hide
let popupFading = false;
let lastSelectionText = '';
let lastSummaryInputHash = '';
let summaryInFlight = false; // prevents premature toggle-hide while first summary is still generating
let lastPopupShowTs = 0; // timestamp when popup last shown (for debounce)

// ------------------------- Utility Helpers -------------------------
function hashString(str){
  let h = 0, i = 0, len = str.length;
  while(i < len){ h = ((h << 5) - h + str.charCodeAt(i++)) | 0; }
  return h.toString(36);
}

function ensureDir(p){ try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch(e){} }

function loadConfig(){
  if(configCache) return configCache;
  let raw = null;
  try { raw = fs.readFileSync(CONFIG_PATH,'utf8'); } catch(e) {}
  let cfg = {};
  if(raw){ try { cfg = JSON.parse(raw); } catch(e) { cfg = {}; } }
  // Migration / defaults
  cfg.providers = cfg.providers || {};
  // Ensure provider objects exist with default model placeholder (no key)
  ['openai','anthropic','gemini','groq','grok'].forEach(p=>{
    cfg.providers[p] = cfg.providers[p] || {};
    if(!cfg.providers[p].model) cfg.providers[p].model = PROVIDER_DEFAULT_MODELS[p];
  });
  cfg.active = cfg.active || 'gemini';
  cfg.theme = cfg.theme || 'light';
  // memoryMode removed (was 'normal' | 'aggressive')
  // Auto-hide delay in ms (0 = never). Clamp 0..30000
  if(typeof cfg.autoHideMs !== 'number' || isNaN(cfg.autoHideMs)) cfg.autoHideMs = 0;
  cfg.autoHideMs = Math.min(30000, Math.max(0, cfg.autoHideMs|0));
  // Migrate legacy boolean markdownEnabled -> markdownMode
  if(!cfg.markdownMode){
    if(typeof cfg.markdownEnabled === 'boolean') cfg.markdownMode = cfg.markdownEnabled ? 'full' : 'off';
    else cfg.markdownMode = 'full';
  }
  // Keep legacy flag in memory for backward compatibility (not persisted further)
  cfg.markdownEnabled = (cfg.markdownMode !== 'off');
  // math rendering removed
  cfg.onboarded = cfg.onboarded === true; // default false
  cfg.hotkeys = cfg.hotkeys || { summarize: 'CommandOrControl+Shift+Space' };
  cfg.summaryPresets = Array.isArray(cfg.summaryPresets) ? cfg.summaryPresets.slice(0, MAX_PRESETS) : [];
  // Migrate deprecated providers (mistral, cohere) -> openai default if active
  if(['mistral','cohere'].includes(cfg.active)) cfg.active = 'openai';
  // Add implicit default summary preset if missing explicit one with main hotkey
  if(!cfg.summaryPresets.some(p=> p.isDefault)){ cfg.summaryPresets.unshift({ id: 'default', name: 'Summary', prompt: DEFAULT_SUMMARY_PROMPT, hotkey: cfg.hotkeys.summarize, isDefault: true }); }
  configCache = cfg;
  return cfg;
}

function saveConfig(mutator){
  const cfg = loadConfig();
  const beforeTheme = cfg.theme;
  mutator && mutator(cfg);
  ensureDir(CONFIG_PATH);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  configCache = null; // invalidate
  const newCfg = loadConfig();
  if(beforeTheme !== newCfg.theme){ broadcastTheme(newCfg.theme); }
  return newCfg;
}

function broadcastTheme(theme){
  [popupWindow, settingsWindow, onboardingWindow, shortcutHelpWindow].forEach(w=>{ if(w && !w.isDestroyed()) w.webContents.send('clipai:theme-changed', theme); });
}

function broadcastSettingsOpenChanged(isOpen){
  try { if(popupWindow && !popupWindow.isDestroyed()) popupWindow.webContents.send('clipai:settings-open-changed', !!isOpen); } catch(e){}
}

function normalizeAccelerator(acc){
  if(!acc || typeof acc !== 'string') return '';
  const parts = acc.split('+').map(p=> p.trim()).filter(Boolean);
  const mods = new Set();
  let key = '';
  parts.forEach(p=>{
    const up = p.toLowerCase();
    if(['cmd','command','commandorcontrol'].includes(up)) mods.add('CommandOrControl');
    else if(['ctrl','control'].includes(up)) mods.add('Control');
    else if(['alt','option'].includes(up)) mods.add('Alt');
    else if(['shift'].includes(up)) mods.add('Shift');
    else key = p.length === 1 ? p.toUpperCase() : (p.length ? p[0].toUpperCase()+p.slice(1) : '');
  });
  const order = ['CommandOrControl','Control','Alt','Shift'];
  const ordered = order.filter(m=> mods.has(m));
  if(!key) return '';
  return [...ordered, key].join('+');
}

// ------------------------- Window Creation -------------------------
function createPopupWindow(){
  if(popupWindow && !popupWindow.isDestroyed()) return popupWindow;
  popupWindow = new BrowserWindow({
    width: 420,
    height: 160,
    show: false,
    frame: false,
  // Disable OS-level resizing; only custom handle-driven programmatic resize is allowed
  resizable: false,
    transparent: true,
    alwaysOnTop: true, // keep above normal windows
    skipTaskbar: true,
  // Allow free movement (drag regions defined in renderer)
  movable: true,
    focusable: true,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname,'preload.js'),
      nodeIntegration: false,
      sandbox: true
    }
  });
  popupWindow.loadFile(path.join(__dirname, 'index.html')).catch(()=>{});
  // Keep popup visible even when focus changes; still hide via hotkey toggle/explicit close.
  try {
    // Elevate stacking level for macOS and keep across spaces.
    if(process.platform === 'darwin') popupWindow.setAlwaysOnTop(true, 'screen-saver');
    popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch(e){}
  popupWindow.on('closed', ()=> { popupWindow = null; });
  return popupWindow;
}

function showPopupNearCursor(){
  const win = createPopupWindow();
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const padding = 24;
  const targetW = 480; // initial
  const targetH = 180;
  let x = Math.min(Math.max(point.x - Math.round(targetW/2), display.bounds.x + padding), display.bounds.x + display.workArea.width - targetW - padding);
  let y = Math.min(Math.max(point.y + 24, display.bounds.y + padding), display.bounds.y + display.workArea.height - targetH - padding);
  win.setBounds({ x, y, width: targetW, height: targetH });
  if(!win.isVisible()) win.showInactive();
  win.focus();
}

function createSettingsWindow(){
  if(settingsWindow && !settingsWindow.isDestroyed()){
    try {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      const padding = 24;
      const b = settingsWindow.getBounds();
      const x = Math.min(Math.max(point.x - Math.round(b.width/2), display.bounds.x + padding), display.bounds.x + display.workArea.width - b.width - padding);
      const y = Math.min(Math.max(point.y + 24, display.bounds.y + padding), display.bounds.y + display.workArea.height - b.height - padding);
      settingsWindow.setBounds({ x, y, width: b.width, height: b.height });
    } catch(e){}
    settingsWindow.show(); settingsWindow.focus(); broadcastSettingsOpenChanged(true); return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 880,
    height: 700,
    show: false,
    title: 'ClipAI Settings',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname,'preload.js'), nodeIntegration: false, sandbox: true }
  });
  // Position near cursor before showing
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const padding = 24;
    const targetW = 880, targetH = 700;
    let x = Math.min(Math.max(point.x - Math.round(targetW/2), display.bounds.x + padding), display.bounds.x + display.workArea.width - targetW - padding);
    let y = Math.min(Math.max(point.y + 24, display.bounds.y + padding), display.bounds.y + display.workArea.height - targetH - padding);
    settingsWindow.setBounds({ x, y, width: targetW, height: targetH });
  } catch(e){}
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', ()=> { settingsWindow = null; broadcastSettingsOpenChanged(false); });
  settingsWindow.show();
  settingsWindow.focus();
  broadcastSettingsOpenChanged(true);
  return settingsWindow;
}

function toggleSettingsWindow(){
  if(settingsWindow && !settingsWindow.isDestroyed()){
    if(settingsWindow.isVisible()){
      try { settingsWindow.close(); } catch(e){}
      return settingsWindow;
    }
  }
  return createSettingsWindow();
}

function createOnboardingWindow(){
  if(onboardingWindow && !onboardingWindow.isDestroyed()) return onboardingWindow;
  onboardingWindow = new BrowserWindow({
    width: 640,
    height: 500,
    modal: false,
    title: 'Welcome to ClipAI',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname,'preload.js'), nodeIntegration: false, sandbox: true }
  });
  const theme = loadConfig().theme;
  const html = `<!doctype html><html><head><meta charset='utf-8'><title>Welcome</title>
  <style>body{font:15px system-ui;margin:0;background:#101418;color:#f5f7fa;padding:30px;line-height:1.4}
  h1{margin:0 0 12px;font-size:26px;font-weight:600}
  .card{background:#182028;border:1px solid #27323a;border-radius:18px;padding:24px;max-width:560px;margin:0 auto;box-shadow:0 10px 34px -16px #0008}
  button{background:#4f9cff;color:#fff;border:none;font:600 14px system-ui;padding:10px 20px;border-radius:10px;cursor:pointer;margin-top:12px}
  ul{padding-left:18px;margin:10px 0}
  li{margin:4px 0}
  .hotkey{font-weight:600;background:#24313b;padding:2px 8px;border-radius:8px;font-size:12px}
  .setup{margin-top:14px;padding:14px;border:1px solid #27323a;border-radius:14px;background:#141b21}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .control{display:flex;flex-direction:column;gap:6px}
  .control>label{font-size:12px;font-weight:600;opacity:.85}
  .control>input,.control>select{background:#0f151c;color:#f5f7fa;border:1px solid #2a3741;padding:9px 10px;border-radius:10px;font:13px system-ui}
  .control>input:focus,.control>select:focus{outline:none;border-color:#4f9cff;box-shadow:0 0 0 1px #4f9cff}
  .status{font-size:12px;min-height:16px;opacity:.9;margin-top:6px}
  </style></head><body class='${theme}'>
  <div class='card'>
   <h1>Welcome to ClipAI</h1>
   <p>Instant summaries & explanations for any selected text. Your keys stay local.</p>
   <ul>
     <li>Select text anywhere.</li>
     <li>Press <span class='hotkey'>${process.platform==='darwin'?'⌘':'Ctrl'}+Shift+Space</span>.</li>
     <li>Popup shows immediately.</li>
     <li>Add custom presets & hotkeys in Settings.</li>
   </ul>
   <div class='setup'>
     <div style='font-weight:600;margin-bottom:8px'>Quick Setup</div>
     <div class='row'>
       <div class='control'>
         <label for='ob_provider'>Provider</label>
         <select id='ob_provider'>
           <option value='openai'>OpenAI</option>
           <option value='anthropic'>Anthropic</option>
           <option value='gemini'>Gemini</option>
           <option value='groq'>Groq</option>
           <option value='grok'>Grok (OpenRouter)</option>
         </select>
       </div>
       <div class='control'>
         <label for='ob_model'>Model</label>
         <select id='ob_model'></select>
       </div>
     </div>
     <div class='control' style='margin-top:12px'>
       <label for='ob_key'>API Key</label>
       <input id='ob_key' type='password' placeholder='...'>
     </div>
     <div style='display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:10px'>
       <div id='ob_status' class='status'></div>
       <button id='ob_save'>Save</button>
     </div>
   </div>
   <p style='opacity:.85'>You can change these later in <strong>Settings</strong>. Keys are stored only on your machine.</p>
   <button id='start'>Get Started</button>
  </div>
  <script>
    const providerSel = document.getElementById('ob_provider');
    const keyInput = document.getElementById('ob_key');
    const modelSel = document.getElementById('ob_model');
    const status = document.getElementById('ob_status');
    const saveBtn = document.getElementById('ob_save');
    async function refreshModelsFor(provider){
      const current=modelSel.value; modelSel.innerHTML='';
      try{ const models=await window.clipAI.listModels(provider); models.forEach(m=>{ const opt=document.createElement('option'); opt.value=m; opt.textContent=m; modelSel.appendChild(opt); }); if(current && models.includes(current)) modelSel.value=current; }catch(e){}
    }
    async function loadProviderConfig(provider){
      const cfg=await window.clipAI.getConfig(); const pCfg=(cfg.providers&&cfg.providers[provider])||{}; keyInput.type='text'; keyInput.value=pCfg.key||''; if(keyInput.value) keyInput.type='password'; await refreshModelsFor(provider); if(pCfg.model && [...modelSel.options].every(o=>o.value!==pCfg.model)){ const opt=document.createElement('option'); opt.value=pCfg.model; opt.textContent=pCfg.model; modelSel.insertBefore(opt, modelSel.firstChild); } if(pCfg.model) modelSel.value=pCfg.model;
    }
    saveBtn.onclick=async()=>{ const prov=providerSel.value; const key=keyInput.value.trim(); const model=modelSel.value.trim(); if(!key){ status.textContent='API Key cannot be empty.'; return; } await window.clipAI.saveProviderKey(prov,key,model||undefined); await window.clipAI.setActiveProvider(prov); status.textContent='Saved!'; setTimeout(()=> status.textContent='',1800); };
    providerSel.addEventListener('change', async()=>{ await window.clipAI.setActiveProvider(providerSel.value); await loadProviderConfig(providerSel.value); });
    keyInput.addEventListener('focus',()=> keyInput.type='text'); keyInput.addEventListener('blur',()=>{ if(keyInput.value) keyInput.type='password'; });
    (async()=>{ const cfg=await window.clipAI.getConfig(); providerSel.value=cfg.active; await loadProviderConfig(cfg.active); })();
    start.onclick=()=>{ window.clipAI.markOnboardingComplete&&window.clipAI.markOnboardingComplete(); };
  </script>
  </body></html>`;
  onboardingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  onboardingWindow.on('closed', ()=> onboardingWindow = null);
  return onboardingWindow;
}

function createShortcutHelpWindow(){
  if(shortcutHelpWindow && !shortcutHelpWindow.isDestroyed()){ shortcutHelpWindow.show(); shortcutHelpWindow.focus(); return shortcutHelpWindow; }
  shortcutHelpWindow = new BrowserWindow({
    width: 420,
    height: 300,
    title: 'ClipAI Shortcuts',
    resizable: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname,'preload.js'), nodeIntegration: false, sandbox: true }
  });
  const cfg = loadConfig();
  const rows = cfg.summaryPresets.map(p=> `<tr><td style='padding:4px 8px;border-bottom:1px solid #2a3741;'>${p.name}</td><td style='padding:4px 8px;border-bottom:1px solid #2a3741;'>${p.hotkey||''}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset='utf-8'><title>Shortcuts</title><style>
    body{font:14px system-ui;margin:0;background:#101418;color:#f5f7fa;padding:24px}
    h2{margin:0 0 14px;font-size:18px}
    table{border-collapse:collapse;width:100%;font-size:13px}
    th{text-align:left;padding:4px 8px;border-bottom:2px solid #2a3741;font-weight:600}
  </style></head><body>
    <h2>Shortcut Help</h2>
    <table><thead><tr><th>Preset</th><th>Hotkey</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`;
  shortcutHelpWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  shortcutHelpWindow.on('closed', ()=> shortcutHelpWindow = null);
  return shortcutHelpWindow;
}

function scheduleHidePopup(){
  if(!popupWindow || popupWindow.isDestroyed()) return;
  if(popupFading) return; // already in fade sequence
  try { popupWindow.webContents.send('clipai:start-fade-out'); popupFading = true; } catch(e){
    // fallback immediate hide
    finalizeHidePopup();
  }
}

function finalizeHidePopup(){
  if(!popupWindow || popupWindow.isDestroyed()) return;
  popupWindow.hide();
  popupFading = false;
  // Still proactively close settings window (memory saving preference) when popup hides
  try { if(settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close(); } catch(e){}
  clearTimeout(popupAutoHideTimer); popupAutoHideTimer = null;
}

function startAutoHideTimer(){
  clearTimeout(popupAutoHideTimer);
  const cfg = loadConfig();
  if(!cfg.autoHideMs) return; // 0 == disabled
  if(!popupWindow || popupWindow.isDestroyed()) return;
  popupAutoHideTimer = setTimeout(()=>{ scheduleHidePopup(); }, cfg.autoHideMs);
}

// ------------------------- Tray -------------------------
function createTray(){
  if(tray) return tray;
  let iconPath = path.join(__dirname,'..','icons','icon.png');
  let image = nativeImage.createFromPath(iconPath);
  if(process.platform === 'darwin'){
    try {
      const { width, height } = image.getSize();
      const bitmap = image.getBitmap();
      let grayish = 0, total = width*height;
      for(let i=0;i<bitmap.length;i+=4){
        const r=bitmap[i],g=bitmap[i+1],b=bitmap[i+2];
        const max=Math.max(r,g,b),min=Math.min(r,g,b);
        if(max - min < 18) grayish++;
      }
      if(grayish/total > 0.65){ image.setTemplateImage(true); }
    } catch(e){}
  }
  tray = new Tray(image);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Popup', click: ()=> { showPopupNearCursor(); } },
    { label: 'Preferences…', click: ()=> createSettingsWindow() },
    { label: 'Shortcut Help', click: ()=> createShortcutHelpWindow() },
    { type: 'separator' },
    { label: 'Quit ClipAI', click: ()=> { app.quit(); } }
  ]);
  tray.setToolTip('ClipAI');
  tray.setContextMenu(contextMenu);
  return tray;
}

// ------------------------- Selection Capture -------------------------
async function captureSelectionText(){
  const before = clipboard.readText();
  let selection = '';
  try {
    if(process.platform === 'darwin'){
      await new Promise((resolve)=>{
        const osa = spawn('osascript', ['-e','tell application "System Events" to keystroke "c" using {command down}']);
        osa.on('exit', ()=> resolve());
      });
      await new Promise(r=> setTimeout(r, 140));
      selection = clipboard.readText();
    } else if(process.platform === 'win32') {
      selection = before; // simplified fallback
    } else {
      selection = before;
    }
  } catch(e){ selection = before; }
  if(!selection || selection === before){ selection = before; }
  setTimeout(()=>{ try { clipboard.writeText(before); } catch(e){} }, 30);
  return selection.trim();
}

// ------------------------- Provider Calls -------------------------
async function summarizeWithProvider(provider, key, model, systemPrompt, userText){
  const headers = { 'Content-Type':'application/json' };
  let body = null, url = '';
  const trimmed = userText.slice(0, MAX_TEXT_LEN);
  let finalSystem = systemPrompt || DEFAULT_SUMMARY_PROMPT;
  switch(provider){
  case 'openai':
  case 'groq': {
      if(!key) throw new Error('Missing API key');
      if(provider==='openai'){ url = 'https://api.openai.com/v1/chat/completions'; headers['Authorization'] = `Bearer ${key}`; }
      if(provider==='groq'){ url = 'https://api.groq.com/openai/v1/chat/completions'; headers['Authorization'] = `Bearer ${key}`; }
      body = JSON.stringify({ model: model || PROVIDER_DEFAULT_MODELS[provider], messages:[ { role:'system', content: finalSystem }, { role:'user', content: trimmed } ], temperature: 0.4, max_tokens: 600 });
      break;
    }
    case 'anthropic': {
      if(!key) throw new Error('Missing API key');
      url = 'https://api.anthropic.com/v1/messages';
      headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
      body = JSON.stringify({ model: model || PROVIDER_DEFAULT_MODELS[provider], system: finalSystem, max_tokens: 600, messages:[ { role:'user', content: trimmed } ] });
      break;
    }
    case 'gemini': {
      if(!key) throw new Error('Missing API key');
      const m = (model || PROVIDER_DEFAULT_MODELS[provider]).replace(/:generateContent$/,'');
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${key}`;
      body = JSON.stringify({ contents:[{ role:'user', parts:[ { text: `${finalSystem}\n\nINPUT:\n${trimmed}` } ] }], generationConfig:{ temperature:0.4, maxOutputTokens:600 } });
      break;
    }
    case 'grok': {
      // Grok via OpenRouter (assumes user supplies OpenRouter API key)
      if(!key) throw new Error('Missing API key');
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers['Authorization'] = `Bearer ${key}`;
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ model: model || PROVIDER_DEFAULT_MODELS[provider], messages:[ { role:'system', content: finalSystem }, { role:'user', content: trimmed } ] , temperature:0.4, max_tokens:600 });
      break;
    }
    default:
      throw new Error('Unsupported provider');
  }
  let res = await fetch(url,{ method:'POST', headers, body });
  if(!res.ok){
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0,160)}`);
  }
  const data = await res.json();
  let txt = '';
  if(provider==='openai' || provider==='groq' || provider==='grok') txt = data.choices?.[0]?.message?.content || '';
  else if(provider==='anthropic') txt = (data.content && data.content[0] && data.content[0].text) || '';
  else if(provider==='gemini') txt = data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('\n') || '';
  else if(provider==='cohere') txt = data.text || data.reply || data.generations?.[0]?.text || '';
  return (txt || '').trim();
}

const _modelCache = {}; // key: provider+key => { ts, list }
async function listModels(provider){
  const cfg = loadConfig();
  const prov = provider || cfg.active;
  const keyObj = cfg.providers[prov] || {};
  const apiKey = keyObj.key;
  const cacheKey = prov + '|' + (apiKey? apiKey.slice(0,8):'');
  const now = Date.now();
  const TTL = 10 * 60 * 1000; // 10 minutes
  if(_modelCache[cacheKey] && (now - _modelCache[cacheKey].ts) < TTL){
    return _modelCache[cacheKey].list;
  }
  if(prov === 'anthropic'){
    const list = ['claude-3','claude-instant','claude-classic'];
    _modelCache[cacheKey] = { ts: now, list }; return list;
  }
  if(prov === 'grok'){
    // OpenRouter listing
    if(!apiKey){ const list = [PROVIDER_DEFAULT_MODELS.grok]; _modelCache[cacheKey] = { ts: now, list }; return list; }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models',{ headers:{ Authorization:`Bearer ${apiKey}` } });
      if(!res.ok) throw new Error('non-ok');
      const data = await res.json();
      const raw = (data.data||[]).map(m=> m.id).filter(id=> /grok/i.test(id));
      const list = raw.length? raw : [PROVIDER_DEFAULT_MODELS.grok];
      _modelCache[cacheKey] = { ts: now, list }; return list;
    } catch(e){ const list=[PROVIDER_DEFAULT_MODELS.grok]; _modelCache[cacheKey]={ts:now,list}; return list; }
  }
  if(!apiKey){
    const list = [PROVIDER_DEFAULT_MODELS[prov]].filter(Boolean); _modelCache[cacheKey]={ts:now,list}; return list;
  }
  try {
    let url=''; let headers={};
    switch(prov){
      case 'openai': url='https://api.openai.com/v1/models'; headers.Authorization=`Bearer ${apiKey}`; break;
      case 'groq': url='https://api.groq.com/openai/v1/models'; headers.Authorization=`Bearer ${apiKey}`; break;
      case 'gemini': url='https://generativelanguage.googleapis.com/v1beta/models?key='+apiKey; break;
      default: return [PROVIDER_DEFAULT_MODELS[prov]].filter(Boolean);
    }
    const res = await fetch(url,{ headers }); if(!res.ok) throw new Error('non-ok');
    const data = await res.json();
    let raw=[];
    if(prov==='openai' || prov==='groq') raw = (data.data||[]).map(m=>m.id);
    else if(prov==='gemini') raw = (data.models||[]).map(m=>m.name);
  // Normalise Gemini names by removing leading 'models/' prefix
  if(prov==='gemini') raw = raw.map(n=> n.replace(/^models\//,'') );
  const allowRe = /(gpt-5|gpt-4|grok|llama|gemini|claude)/i; // broad allow list
    const denyRe = /(embed|embedding|moderation|audio|image|vision|whisper)/i;
  // Keep all allowed; if nothing passes allow list, fall back to raw list
  let filtered = raw.filter(m=> allowRe.test(m) && !denyRe.test(m));
  if(filtered.length === 0) filtered = raw.slice();
    const seen=new Set(); const out=[]; for(const id of filtered){ if(!seen.has(id)){ seen.add(id); out.push(id); if(out.length>=150) break; } }
    const list = out.length? out : [PROVIDER_DEFAULT_MODELS[prov]].filter(Boolean);
    _modelCache[cacheKey]={ts:now,list}; return list;
  } catch(e){ const list=[PROVIDER_DEFAULT_MODELS[prov]].filter(Boolean); _modelCache[cacheKey]={ts:now,list}; return list; }
}

// ------------------------- Summarization Flow -------------------------
async function runSummary(preset){
  const cfg = loadConfig();
  const active = cfg.active;
  const keyPresent = !!(cfg.providers && cfg.providers[active] && cfg.providers[active].key);
  if(!keyPresent){
    // Ensure popup is visible near cursor and show guidance
    if(!popupWindow || popupWindow.isDestroyed() || !popupWindow.isVisible()){
      showPopupNearCursor();
      lastPopupShowTs = Date.now();
    } else {
      try { popupWindow.showInactive(); popupWindow.focus(); } catch(e){}
    }
    popupWindow?.webContents.send('clipai:summary', { summary: 'No API key. Go to Preferences → fill in API key for your provider.', inputPreview: '' });
    return;
  }
  let selection = await captureSelectionText();
  if(!selection) selection = '(No selection)';
  const newHash = hashString(selection + '|' + (preset?.id||'default'));
  if(popupWindow && popupWindow.isVisible() && newHash === lastSummaryInputHash){
    // Only treat identical repeat invocation as a toggle IF
    // 1) not currently generating (summary finished), OR
    // 2) sufficient time has elapsed since showing (debounce against key auto-repeat)
    const elapsed = Date.now() - lastPopupShowTs;
    if(!summaryInFlight || elapsed > 800){
      scheduleHidePopup();
      return;
    }
    // Otherwise ignore the spurious repeat trigger
  }
  lastSummaryInputHash = newHash;
  lastSelectionText = selection;
  // Reposition only if the popup is not currently visible (new invocation). If already visible, keep its current location.
  if(!popupWindow || popupWindow.isDestroyed() || !popupWindow.isVisible()){
    showPopupNearCursor();
    lastPopupShowTs = Date.now();
  } else {
    // Ensure it stays above other windows and focused without moving.
    try { popupWindow.showInactive(); popupWindow.focus(); } catch(e){}
  }
  summaryInFlight = true;
  popupWindow.webContents.send('clipai:summary', { summary: 'Working…', inputPreview: selection.slice(0,160) });
  const pCfg = cfg.providers[active] || {};
  try {
    const summary = await summarizeWithProvider(active, pCfg.key, pCfg.model, preset?.prompt || DEFAULT_SUMMARY_PROMPT, selection);
    if(popupWindow && !popupWindow.isDestroyed()){
  popupWindow.webContents.send('clipai:summary', { summary, fullText: selection });
    }
    summaryInFlight = false;
  } catch(e){
    if(popupWindow && !popupWindow.isDestroyed()){
  popupWindow.webContents.send('clipai:summary', { error: e.message || String(e) });
    }
    summaryInFlight = false;
  }
}

// ------------------------- Shortcut Registration -------------------------
function clearShortcuts(){ try { globalShortcut.unregisterAll(); } catch(e){} }
function registerShortcuts(){
  clearShortcuts();
  const cfg = loadConfig();
  cfg.summaryPresets.forEach(p=>{
    const acc = normalizeAccelerator(p.hotkey);
    if(!acc) return;
    try { globalShortcut.register(acc, ()=> runSummary(p)); } catch(e){}
  });
}

// ------------------------- IPC Handlers -------------------------
ipcMain.handle('clipai:summarize-selection', async ()=>{ const preset = loadConfig().summaryPresets[0]; runSummary(preset); return { ok:true }; });
ipcMain.handle('clipai:run-preset', async (_, id)=>{ const preset = loadConfig().summaryPresets.find(p=>p.id===id); if(preset) runSummary(preset); return { ok: !!preset }; });
ipcMain.handle('clipai:save-provider-key', (_, provider, key, model)=>{ saveConfig(cfg=>{ cfg.providers[provider] = cfg.providers[provider] || {}; cfg.providers[provider].key = key; if(model) cfg.providers[provider].model = model; }); return { ok:true }; });
ipcMain.handle('clipai:get-config', ()=> loadConfig());
ipcMain.handle('clipai:set-active-provider',(_,provider)=>{ saveConfig(cfg=>{ cfg.active = provider; }); return { ok:true }; });
ipcMain.handle('clipai:set-theme',(_,theme)=>{ saveConfig(cfg=>{ cfg.theme = theme; }); return { ok:true }; });
// memory mode removed; legacy calls ignored
ipcMain.handle('clipai:set-memory-mode',()=> ({ ok:false, removed:true }));
ipcMain.handle('clipai:set-markdown-enabled',(_,enabled)=>{ // legacy support
  const newCfg = saveConfig(cfg=>{ cfg.markdownMode = enabled ? 'full' : 'off'; });
  [popupWindow, settingsWindow, onboardingWindow, shortcutHelpWindow].forEach(w=>{ if(w && !w.isDestroyed()) w.webContents.send('clipai:markdown-mode-changed', newCfg.markdownMode); });
  return { ok:true }; 
});
ipcMain.handle('clipai:set-markdown-mode',(_,mode)=>{ 
  const allowed = ['off','light','full'];
  if(!allowed.includes(mode)) mode = 'full';
  const newCfg = saveConfig(cfg=>{ cfg.markdownMode = mode; });
  [popupWindow, settingsWindow, onboardingWindow, shortcutHelpWindow].forEach(w=>{ if(w && !w.isDestroyed()) w.webContents.send('clipai:markdown-mode-changed', newCfg.markdownMode); });
  return { ok:true, mode: newCfg.markdownMode };
});
// math rendering removed: legacy calls ignored
ipcMain.handle('clipai:set-math-enabled',()=> ({ ok:false, removed:true }));
ipcMain.handle('clipai:get-clipboard',()=> clipboard.readText());
ipcMain.handle('clipai:resize',(_,w,h)=>{ if(popupWindow && !popupWindow.isDestroyed()){ const b = popupWindow.getBounds(); popupWindow.setBounds({ x:b.x, y:b.y, width: Math.round(w), height: Math.round(h) }); } return { ok:true }; });
ipcMain.handle('clipai:open-settings',()=>{ createSettingsWindow(); return { ok:true }; });
ipcMain.handle('clipai:toggle-settings',()=>{ toggleSettingsWindow(); return { ok:true }; });
ipcMain.handle('clipai:list-models',(_,provider)=> listModels(provider));
ipcMain.handle('clipai:get-summary-presets',()=>{ const cfg = loadConfig(); return { presets: cfg.summaryPresets }; });
ipcMain.handle('clipai:reset-config', async ()=>{
  try { if(fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH); } catch(e){}
  // Reset in-memory state and reinitialize defaults
  configCache = null;
  const cfg = loadConfig();
  registerShortcuts();
  broadcastTheme(cfg.theme);
  // Notify windows of dependent settings
  try { if(popupWindow && !popupWindow.isDestroyed()) popupWindow.webContents.send('clipai:auto-hide-ms', cfg.autoHideMs); } catch(e){}
  try { if([settingsWindow, onboardingWindow, shortcutHelpWindow].some(w=> w && !w.isDestroyed())){
    [settingsWindow, onboardingWindow, shortcutHelpWindow].forEach(w=>{ if(w && !w.isDestroyed()) w.webContents.send('clipai:markdown-mode-changed', cfg.markdownMode); });
  } } catch(e){}
  return { ok:true, config: cfg };
});
ipcMain.handle('clipai:set-summary-presets',(_, { presets })=>{
  const normalized = Array.isArray(presets) ? presets.slice(0,MAX_PRESETS).map(p=>({ id: p.id || ('p_'+Date.now()+Math.random().toString(36).slice(2,6)), name: p.name?.slice(0,48) || 'Preset', prompt: (p.prompt||DEFAULT_SUMMARY_PROMPT).slice(0,1200), hotkey: normalizeAccelerator(p.hotkey||''), isDefault: p.isDefault===true && p.id==='default' })) : [];
  const cfg = loadConfig();
  const def = cfg.summaryPresets.find(p=>p.isDefault) || { id:'default', name:'Summary', prompt:DEFAULT_SUMMARY_PROMPT, hotkey: cfg.hotkeys.summarize, isDefault:true };
  if(!normalized.some(p=> p.isDefault)) normalized.unshift(def);
  const seen = new Map();
  const conflicts = [];
  normalized.forEach(p=>{ if(p.hotkey){ if(seen.has(p.hotkey)){ conflicts.push({ hotkey: p.hotkey, a: seen.get(p.hotkey), b: p.id }); } else { seen.set(p.hotkey, p.id); } } });
  saveConfig(cfg2=>{ cfg2.summaryPresets = normalized; });
  registerShortcuts();
  return { ok:true, conflicts };
});
ipcMain.handle('clipai:mark-onboarded',()=>{ saveConfig(cfg=> { cfg.onboarded = true; }); if(onboardingWindow) { onboardingWindow.close(); } return { ok:true }; });
ipcMain.handle('clipai:hide-window',()=>{ scheduleHidePopup(); return { ok:true }; });
ipcMain.handle('clipai:hide-after-fade',()=>{ finalizeHidePopup(); return { ok:true }; });
ipcMain.handle('clipai:set-auto-hide-ms',(_,ms)=>{ 
  const newCfg = saveConfig(cfg=>{ cfg.autoHideMs = Math.min(30000, Math.max(0, (ms|0))); });
  [popupWindow, settingsWindow, onboardingWindow, shortcutHelpWindow].forEach(w=>{ if(w && !w.isDestroyed()) w.webContents.send('clipai:auto-hide-ms', newCfg.autoHideMs); });
  return { ok:true, ms: newCfg.autoHideMs }; 
});
ipcMain.handle('clipai:auto-hide-hover',(_,state)=>{ if(state==='enter'){ clearTimeout(popupAutoHideTimer); popupAutoHideTimer=null; } else if(state==='leave'){ startAutoHideTimer(); } return { ok:true }; });
ipcMain.handle('clipai:force-hide-now',()=>{ finalizeHidePopup(); return { ok:true }; });

// ------------------------- App Lifecycle -------------------------
app.whenReady().then(()=>{
  // Run primarily as a background/tray process (macOS: hide dock icon)
  if(process.platform === 'darwin' && app.dock){ try { app.dock.hide(); } catch(e){} }
  loadConfig();
  registerShortcuts();
  createTray();
  if(!loadConfig().onboarded) createOnboardingWindow();
  // Application menu with standard Edit actions to enable copy/paste in inputs
  if(process.platform === 'darwin'){
    const template = [
      { label: app.name, submenu: [ { role:'about' }, { type:'separator' }, { label:'Preferences…', accelerator:'Command+,', click: ()=> createSettingsWindow() }, { type:'separator' }, { role:'hide' }, { role:'hideOthers' }, { role:'unhide' }, { type:'separator' }, { role:'quit' } ] },
      { label: 'Edit', submenu: [ { role:'undo' }, { role:'redo' }, { type:'separator' }, { role:'cut' }, { role:'copy' }, { role:'paste' }, { role:'pasteAndMatchStyle' }, { role:'delete' }, { role:'selectAll' } ] },
      { label: 'Window', submenu: [ { role:'minimize' }, { role:'close' } ] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    const template = [
      { label: 'File', submenu: [ { role:'quit' } ] },
      { label: 'Edit', submenu: [ { role:'undo' }, { role:'redo' }, { type:'separator' }, { role:'cut' }, { role:'copy' }, { role:'paste' }, { role:'delete' }, { role:'selectAll' } ] },
      { label: 'Window', submenu: [ { role:'minimize' }, { role:'close' } ] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
});
app.on('will-quit', ()=>{ clearShortcuts(); });
app.on('window-all-closed', (e)=>{ e.preventDefault(); });
process.on('unhandledRejection', (reason)=>{ console.error('[unhandledRejection]', reason); });
process.on('uncaughtException', (err)=>{ console.error('[uncaughtException]', err); });
module.exports = { loadConfig, saveConfig, registerShortcuts, summarizeWithProvider };
