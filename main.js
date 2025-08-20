/**
 * ClipAI – Lightweight selection summarizer / explainer
 * ----------------------------------------------------
 * Main process bootstrap.
 * Responsibilities:
 *  - Manage a single ephemeral popup window (the "bubble") and a settings window.
 *  - Register global hotkeys and capture the current text selection (best‑effort, no native deps).
 *  - Persist user configuration (providers, models, prompts, theme, memory mode) in userData/config.json.
 *  - Provide a narrow IPC surface consumed by `preload.js` (context‑isolated renderer).
 *  - Fan out model requests to multiple provider APIs with a unified chat interface.
 *  - Lightweight markdown enable/disable flag (actual rendering done in renderer).
 *
 * Design goals:
 *  - Keep startup + resident memory low (window destroyed in aggressive memory mode when hidden).
 *  - Minimise UI latency: selection -> popup appears -> plain text -> (async) markdown upgrade.
 *  - Zero external runtime dependencies besides Electron & fetch.
 *
 * NOTE: No API keys are ever transmitted anywhere except directly to each vendor's HTTPS endpoint.
 */
const {app, globalShortcut, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage} = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Primary popup window (lazy created, may be destroyed in aggressive memory mode)
let win;
const CFG_PATH = path.join(app.getPath('userData'), 'config.json');
let cfgCache = null;
let lastFullText = ''; // track last processed full selection for toggle behavior
let lastModeUsed = ''; // 'summary' | 'explain'
let registeredSummary = null;
let registeredExplain = null;
let tray = null;
let destroyTimer = null; // for low memory mode deferred destroy
let settingsWin = null; // separate settings window

// ---------------------------------------------------------------------------
// Prompt preset definitions (summary & explanation)
// Each preset is a compact system prompt tuned for short responses; we keep
// them *very* concise to control model verbosity and latency.
// ---------------------------------------------------------------------------
const PROMPT_PRESETS = {
  summary: {
    core_one_liner: {
      title: 'Core One-Liner',
      prompt: 'Return ONE sentence (<=25 words) capturing the core claim or result. No preamble, no extras.'
    },
    key_points_tight: {
      title: 'Key Points (2–3 bullets)',
  prompt: 'Provide 2–3 markdown bullet points (each line starts with * ), each <=12 words, covering problem, approach, outcome. No filler.'
    },
    metrics_focus: {
      title: 'Metrics Focus',
      prompt: 'In <=30 words highlight objective, method, and any numeric performance or scale indicators. Preserve numbers/symbols.'
    },
    contrast_summary: {
      title: 'Contrast Summary',
      prompt: 'Summarize and add 1 clause contrasting with a typical alternative approach (<=30 words total).'
    }
  },
  explain: {
    concise_clarifier: {
      title: 'Concise Clarifier',
      prompt: 'Explain in <=2 crisp sentences what this text means and why it matters. Preserve technical terms; no intro phrases.'
    },
    layperson_simplify: {
      title: 'Layperson Simplify',
      prompt: 'Rewrite for an educated non-expert in <=3 short sentences; replace jargon with plain language; keep essential quantities/symbols.'
    },
    step_reasoning: {
      title: 'Step Reasoning',
  prompt: 'List 3–4 numbered mini-steps showing underlying mechanism or logic flow; each step <=15 words. No introduction.'
    },
    analogy_mode: {
      title: 'Analogy Mode',
      prompt: 'Explain using a concrete analogy, then one literal sentence. Total <=45 words.'
    }
  }
};

// Provider default model suggestions (fallback if user does not specify)
const PROVIDER_DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash-lite',
  anthropic: 'claude-3-5-sonnet-latest',
  mistral: 'mistral-small-latest',
  groq: 'llama-3.1-8b-instant',
  cohere: 'command-r-plus'
};

/**
 * Fetch a lightweight model list for a provider (best effort; silently returns []) on error.
 */
async function listModelsForProvider(provider, key){
  try {
    switch(provider){
      case 'openai': {
        const r = await fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${key}`}});
        if(!r.ok) return [];
        const j = await r.json();
        return (j.data||[]).map(m=>m.id).filter(id=>/gpt|o-mini|o-/.test(id));
      }
      case 'gemini': {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        if(!r.ok) return [];
        const j = await r.json();
        return (j.models||[]).map(m=>m.name.split('/').pop());
      }
      case 'anthropic': {
        const r = await fetch('https://api.anthropic.com/v1/models',{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}});
        if(!r.ok) return [];
        const j = await r.json();
        return (j.data||[]).map(m=>m.id||m.name).filter(Boolean);
      }
      case 'mistral': {
        const r = await fetch('https://api.mistral.ai/v1/models',{headers:{Authorization:`Bearer ${key}`}});
        if(!r.ok) return [];
        const j = await r.json();
        return (j.data||[]).map(m=>m.id||m.name).filter(Boolean);
      }
      case 'groq': {
        const r = await fetch('https://api.groq.com/openai/v1/models',{headers:{Authorization:`Bearer ${key}`}});
        if(!r.ok) return [];
        const j = await r.json();
        return (j.data||[]).map(m=>m.id).filter(Boolean);
      }
      case 'cohere': {
        const r = await fetch('https://api.cohere.com/v1/models',{headers:{Authorization:`Bearer ${key}`}});
        if(!r.ok) return [];
        const j = await r.json();
        return (j?.models||[]).map(m=>m.name||m.id).filter(Boolean);
      }
      default: return [];
    }
  } catch(e){ return []; }
}

/**
 * Normalised chat call across all supported providers.
 * Only the subset of parameters we care about (system + user, low temperature).
 */
async function runChat(provider, model, systemPrompt, userText){
  switch(provider){
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${currentProvider().key}`},body:JSON.stringify({model, messages:[{role:'system',content:systemPrompt},{role:'user',content:userText}], temperature:0.2, max_tokens:160})});
      if(!res.ok) throw new Error(`OpenAI ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim()||'';
    }
    case 'groq': { // OpenAI compatible
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${currentProvider().key}`},body:JSON.stringify({model, messages:[{role:'system',content:systemPrompt},{role:'user',content:userText}], temperature:0.2, max_tokens:160})});
      if(!res.ok) throw new Error(`Groq ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim()||'';
    }
    case 'mistral': {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${currentProvider().key}`},body:JSON.stringify({model, messages:[{role:'system',content:systemPrompt},{role:'user',content:userText}], temperature:0.2, max_tokens:160})});
      if(!res.ok) throw new Error(`Mistral ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim()||'';
    }
    case 'gemini': {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentProvider().key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:`${systemPrompt}\n\n${userText}` }]}]})});
      if(!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.map(p=>p.text).join('').trim()||'';
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':currentProvider().key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model,system:systemPrompt,messages:[{role:'user',content:userText}],max_tokens:400,temperature:0.2})});
      if(!res.ok) throw new Error(`Anthropic ${res.status}`);
      const data = await res.json();
      const c = data.content && data.content[0] && (data.content[0].text || (data.content[0].type==='text'? data.content[0].text:''));
      return (c||'').trim();
    }
    case 'cohere': {
      const res = await fetch('https://api.cohere.com/v1/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${currentProvider().key}`},body:JSON.stringify({model, preamble:systemPrompt, messages:[{role:'user',content:userText}],temperature:0.2})});
      if(!res.ok) throw new Error(`Cohere ${res.status}`);
      const data = await res.json();
      return (data.text || data.message || data.output_text || '').trim();
    }
    default: throw new Error('Unsupported provider');
  }
}
// ---------- Configuration helpers ----------
function loadCfg(){
  if(cfgCache) return cfgCache;
  try { cfgCache = JSON.parse(fs.readFileSync(CFG_PATH,'utf8')); } catch(_) { cfgCache = { providers:{}, active:'openai', theme:'dark', hotkeys:{ summarize:'CommandOrControl+Shift+Space', explain:'' }, memoryMode:'normal', markdownEnabled:true, promptSelections:{ summary:'core_one_liner', explain:'concise_clarifier' }, customPrompts:{ summary:'', explain:'' } }; }
  if(!cfgCache.hotkeys) cfgCache.hotkeys = { summarize:'CommandOrControl+Shift+Space', explain:'' };
  if(!cfgCache.providers) cfgCache.providers = {};
  if(!cfgCache.active) cfgCache.active = 'openai';
  if(!cfgCache.theme) cfgCache.theme = 'dark';
  if(!cfgCache.memoryMode) cfgCache.memoryMode = 'normal';
  if(typeof cfgCache.markdownEnabled !== 'boolean') cfgCache.markdownEnabled = true;
  if(!cfgCache.promptSelections) cfgCache.promptSelections = { summary:'core_one_liner', explain:'concise_clarifier' };
  if(!cfgCache.customPrompts) cfgCache.customPrompts = { summary:'', explain:'' };
  return cfgCache;
}
function saveCfg(){ try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfgCache,null,2)); } catch(e){ console.error('Save config failed', e); } }
function saveProviderKey(provider, key, model){ const cfg = loadCfg(); if(!cfg.providers[provider]) cfg.providers[provider]={}; cfg.providers[provider].key = key; if(model) cfg.providers[provider].model = model; saveCfg(); }
function setActiveProvider(p){ const cfg = loadCfg(); cfg.active = p; saveCfg(); }
function currentProvider(){ const cfg = loadCfg(); return { name: cfg.active, ...cfg.providers[cfg.active] }; }
// Broadcast the theme class name to all renderers (popup + settings)
function broadcastTheme(theme){
  try {
    const { BrowserWindow } = require('electron');
    for(const w of BrowserWindow.getAllWindows()){
      try { w.webContents.send('clipai:theme-changed',{theme}); } catch(_){ }
    }
  } catch(_){ }
}
const ALLOWED_THEMES = ['dark','light','midnight','forest','rose','amber','contrast'];
function setTheme(theme){
  const cfg = loadCfg();
  if(!ALLOWED_THEMES.includes(theme)) theme = 'dark';
  cfg.theme = theme;
  saveCfg();
  broadcastTheme(cfg.theme);
}
function setMemoryMode(mode){ const cfg = loadCfg(); cfg.memoryMode = (mode==='aggressive')?'aggressive':'normal'; saveCfg(); }
function setMarkdownEnabled(enabled){ const cfg = loadCfg(); cfg.markdownEnabled = !!enabled; saveCfg(); }

// Validate accelerator: must include at least one non-modifier key
function normalizeAccel(acc){
  if(!acc || typeof acc!=='string') return '';
  acc = acc.trim();
  if(!acc) return '';
  const parts = acc.split('+').filter(Boolean);
  const mods = new Set(['Command','Cmd','Control','Ctrl','Alt','Option','Shift','CommandOrControl']);
  const hasNonMod = parts.some(p=> !mods.has(p));
  if(!hasNonMod) return '';
  // Deduplicate preserving order
  const seen = new Set();
  const cleaned = parts.filter(p=>{ if(seen.has(p)) return false; seen.add(p); return true; });
  return cleaned.join('+');
}

function resolveAsset(names){
  for(const n of names){ const p = path.join(__dirname, n); if(fs.existsSync(p)) return p; }
  return null;
}
// Create (or recreate) the popup window
function create() {
  const iconPath = resolveAsset(['icons/icon.png','icon.png']);
  win = new BrowserWindow({
    width:500,height:150,show:false,alwaysOnTop:true,frame:false,transparent:true,useContentSize:true,
    // Remove native window shadow so only the bubble's CSS shadow (with matching 28px radius) is visible.
    hasShadow:false,
    backgroundColor:'#00000000',
    icon: iconPath || undefined,
    webPreferences:{preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false}
  });
  win.loadFile('index.html');
  win.on('hide', ()=> scheduleDestroyIfNeeded());
}

// Create / toggle the settings window (single instance)
function openSettingsWindow(){
  // Toggle behavior: if already open & visible, close it; if hidden/minimized show it.
  if(settingsWin){
    try {
      if(!settingsWin.isDestroyed()){
        if(settingsWin.isVisible()){
          settingsWin.close();
          return;
        } else {
          settingsWin.show();
          settingsWin.focus();
          return;
        }
      }
    } catch(_){ /* fallback to recreate */ }
  }
  const iconPath = resolveAsset(['icons/icon.png','icon.png']);
  settingsWin = new BrowserWindow({
    width:380, height:520, resizable:true, minimizable:true, maximizable:false, show:true, alwaysOnTop:false, frame:true,
    title:'ClipAI Settings', icon: iconPath || undefined,
    webPreferences:{preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false}
  });
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', ()=>{ settingsWin = null; });
}

// In aggressive mode we destroy the hidden popup window after a short delay
function scheduleDestroyIfNeeded(){
  const cfg = loadCfg();
  if(cfg.memoryMode !== 'aggressive') return;
  if(destroyTimer) clearTimeout(destroyTimer);
  destroyTimer = setTimeout(()=>{
    if(win && !win.isVisible()){
      try { win.destroy(); } catch(_){}
      win = null;
    }
  }, 4000); // destroy after 4s hidden
}

function ensureWindow(){ if(!win){ create(); } }

function createTray(){
  try {
    if(tray) return tray;
    let iconPath = resolveAsset(['icons/iconTemplate.png','icons/icon.png','iconTemplate.png','icon.png']);
    let image = iconPath? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    if(!iconPath){ console.warn('[Tray] No icon file found; using empty image'); }
    // Auto-generate smaller tray variant from large icon when no template provided
    if(iconPath && /icon\.png$/i.test(iconPath) && !/iconTemplate\.png$/i.test(iconPath)){
      try { image = image.resize({width: process.platform==='darwin'? 18:16, height: process.platform==='darwin'? 18:16}); } catch(e){ /* ignore */ }
    }
    if(process.platform==='darwin'){
      // Mark as template if mostly monochrome (quick heuristic on average color)
      try {
        const avg = image.getBitmap(); // raw BGRA buffer
        let sum=0,count=0; for(let i=0;i<avg.length;i+=4){ const r=avg[i+2],g=avg[i+1],b=avg[i]; const max=Math.max(r,g,b); const min=Math.min(r,g,b); if(max<15) continue; if((max-min)<20) { sum+= (r+g+b)/3; count++; } }
        if(count>0){ image.setTemplateImage(true); }
      } catch(_){}
    }
    tray = new Tray(image);
    const menu = Menu.buildFromTemplate([
      { label:'Show / Focus', click:()=>{ if(win){ win.show(); win.focus(); } } },
      { label:'Hide', click:()=> win && win.hide() },
      { type:'separator' },
      { label:'Quit ClipAI', click:()=> app.quit() }
    ]);
    tray.setToolTip('ClipAI');
    tray.setContextMenu(menu);
  } catch(e){ console.warn('[Tray] Failed to create tray:', e.message); }
}

/**
 * Summarize path (separate from generic processText to allow distinct prompt selection & future metrics)
 */
async function summarize(text){
  const prov = currentProvider();
  if(!prov.key) return {error:`No API key set for ${prov.name}`};
  text = (text||'').trim();
  if(!text) return {error:'Empty selection'};
  const maxChars = 4000; if(text.length>maxChars) text = text.slice(0,maxChars)+'...';
  const cfg = loadCfg();
  let sel = cfg.promptSelections?.summary || 'core_one_liner';
  let sysPrompt;
  if(sel==='custom' && cfg.customPrompts && cfg.customPrompts.summary){
    sysPrompt = cfg.customPrompts.summary;
  } else {
    sysPrompt = (PROMPT_PRESETS.summary[sel]||PROMPT_PRESETS.summary.core_one_liner).prompt;
  }
  try {
  const model = prov.model || PROVIDER_DEFAULT_MODELS[prov.name] || 'gpt-4o-mini';
  const summary = await runChat(prov.name, model, sysPrompt, text);
  return {summary, provider:prov.name, model};
  } catch(e){ return {error:e.message}; }
}

/**
 * Attempt a non‑intrusive copy of the current selection without clobbering user clipboard state.
 * macOS: uses AppleScript; Windows: PowerShell SendKeys. Fallback returns existing clipboard.
 */
async function captureSelectionSmart(){
  // Attempt instant selection capture without forcing user to manually copy.
  // Strategy per platform: simulate copy, read clipboard, restore previous.
  const prev = clipboard.readText();
  const restore = ()=> { try { clipboard.writeText(prev); } catch(_){} };
  try {
    if(process.platform === 'darwin'){
        async function macCopy(delayMs){
          const script = `set _prev to the clipboard\n`+
            `tell application "System Events" to keystroke "c" using {command down}\n`+
            `delay ${(delayMs/1000).toFixed(2)}\n`+
            `set _sel to the clipboard\n`+
            `set the clipboard to _prev\n`+
            `return _sel`;
          return new Promise(res=> exec(`osascript -e ${JSON.stringify(script)}`,(e,out)=> res(e? '' : String(out).trim())));
        }
        let sel = await macCopy(50);
        if(!sel) sel = await macCopy(90); // retry with longer delay
        if(sel) return sel;
    } else if(process.platform === 'win32'){
      // Lightweight best-effort: send Ctrl+C via PowerShell, restore previous clipboard.
      // This avoids native deps; may require accessibility permissions in some contexts.
      const ps = `Add-Type -AssemblyName System.Windows.Forms;`+
        `[System.Windows.Forms.SendKeys]::SendWait('^c');`+
        `Start-Sleep -Milliseconds 70;`+
        `$t = Get-Clipboard -Raw; echo $t`;
      const sel = await new Promise(res=> exec(`powershell -NoProfile -Command ${JSON.stringify(ps)}`,(e,out)=> res(e? '' : String(out))));
      if(sel && sel.trim()) { restore(); return sel.trim(); }
    }
  } catch(e){ /* ignore and fallback */ }
  restore();
  // Fallback: whatever is currently in clipboard (user may have copied manually)
  return prev;
}

// Hotkey handler (summary / explain). Implements toggle logic: repeat same hotkey with same text hides bubble.
function handleModeHotkey(mode){
  if(!win) return;
  // ensure window exists (may have been destroyed in aggressive mode)
  ensureWindow();
  const processMode = (text)=>{
    const trimmed = (text||'').trim();
    if(!trimmed){ win.hide(); return; }
    const sameText = trimmed === lastFullText;
    if(win.isVisible()){
      if(sameText){
        if(mode === lastModeUsed){
          // Same text & same mode -> close
          win.hide();
          return;
        }
        // Same text but different mode -> reuse lastFullText without updating
      } else {
        lastFullText = trimmed;
      }
    } else { 
      // Opening anew
      lastFullText = trimmed;
    }
    lastModeUsed = mode;
    if(mode==='summary'){
      summarize(text).then(result=> win.webContents.send('clipai:summary', {inputPreview: text.slice(0,140), fullText:text, mode:'summary', ...result}));
    } else {
      processText(text,'explain').then(result=> win.webContents.send('clipai:summary', {inputPreview: text.slice(0,140), fullText:text, mode:'explain', summary: result.output, error: result.error}));
    }
  };
  if(win.isVisible()){
    captureSelectionSmart().then(processMode);
  } else {
    captureSelectionSmart().then(text=>{ win.show(); processMode(text); });
  }
}

// (Re)register global shortcuts based on current config
function applyHotkeys(){
  const hk = loadCfg().hotkeys;
  // Unregister previous
  if(registeredSummary){ globalShortcut.unregister(registeredSummary); registeredSummary=null; }
  if(registeredExplain){ globalShortcut.unregister(registeredExplain); registeredExplain=null; }
  const sum = normalizeAccel(hk.summarize);
  if(sum){
    try {
      const ok = globalShortcut.register(sum, ()=> handleModeHotkey('summary'));
      if(ok) registeredSummary = sum; else console.log('[HK] Failed summarize', sum);
    } catch(e){ console.warn('[HK] Error registering summarize', sum, e.message); }
  } else if(hk.summarize){
    console.log('[HK] Ignored invalid summarize accel', hk.summarize);
  }
  const exp = normalizeAccel(hk.explain);
  if(exp){
    try {
      const ok2 = globalShortcut.register(exp, ()=> handleModeHotkey('explain'));
      if(ok2) registeredExplain = exp; else console.log('[HK] Failed explain', exp);
    } catch(e){ console.warn('[HK] Error registering explain', exp, e.message); }
  } else if(hk.explain){
    console.log('[HK] Ignored invalid explain accel', hk.explain);
  }
}

// Generic short processing (summary / explain) reused by renderer advanced modes
// Generic short processing (summary / explain) reused by renderer advanced modes
async function processText(text, mode){
  const prov = currentProvider();
  if(!prov.key) return {error:`No API key set for ${prov.name}`};
  text = (text||'').trim();
  if(!text) return {error:'Empty text'};
  const base = text.length>5000? text.slice(0,5000)+'...': text;
  const cfg = loadCfg();
  let sel = (mode==='explain'? cfg.promptSelections?.explain: cfg.promptSelections?.summary) || (mode==='explain'?'concise_clarifier':'core_one_liner');
  let purpose;
  if(sel==='custom' && cfg.customPrompts){
    purpose = (mode==='explain'? cfg.customPrompts.explain : cfg.customPrompts.summary) || (mode==='explain'? PROMPT_PRESETS.explain.concise_clarifier.prompt : PROMPT_PRESETS.summary.core_one_liner.prompt);
  } else {
    const presetGroup = mode==='explain'? PROMPT_PRESETS.explain : PROMPT_PRESETS.summary;
    purpose = (presetGroup[sel] || (mode==='explain'? PROMPT_PRESETS.explain.concise_clarifier : PROMPT_PRESETS.summary.core_one_liner)).prompt;
  }
  try {
  const model = prov.model || PROVIDER_DEFAULT_MODELS[prov.name] || 'gpt-4o-mini';
  const out = await runChat(prov.name, model, purpose, base);
  return {output: out};
  } catch(e){ return {error:e.message}; }
}

app.whenReady().then(()=>{
  create();
  if(process.platform==='darwin' && app.dock) {
    try { app.dock.hide(); } catch(_){}
  }
  createTray();
  applyHotkeys();
  app.on('activate', ()=> BrowserWindow.getAllWindows().length===0 && create());
});
app.on('will-quit', ()=> globalShortcut.unregisterAll());

ipcMain.handle('clipai:summarize-selection', async ()=>{
  const text = await captureSelectionSmart();
  lastFullText = (text||'').trim();
  return summarize(text);
});
ipcMain.handle('clipai:save-key', (_e,k)=>{ // legacy single openai key
  const cfg = loadCfg(); if(!cfg.providers.openai) cfg.providers.openai={}; cfg.providers.openai.key = k; saveCfg(); return {ok:true};
});
ipcMain.handle('clipai:key-status', ()=> { const cfg = loadCfg(); return {hasKey: !!(cfg.providers.openai&&cfg.providers.openai.key)}; });
ipcMain.handle('clipai:get-config', ()=> loadCfg());
ipcMain.handle('clipai:save-provider-key', (_e,{provider,key,model})=>{ saveProviderKey(provider,key,model); return {ok:true}; });
ipcMain.handle('clipai:set-active-provider', (_e,p)=>{ setActiveProvider(p); return {ok:true}; });
ipcMain.handle('clipai:set-theme', (_e,theme)=>{ setTheme(theme); return {ok:true, theme: loadCfg().theme}; });
ipcMain.handle('clipai:set-memory-mode', (_e,mode)=>{ setMemoryMode(mode); if(mode==='aggressive') scheduleDestroyIfNeeded(); return {ok:true, memoryMode: loadCfg().memoryMode}; });
ipcMain.handle('clipai:set-markdown-enabled', (_e,enabled)=>{ setMarkdownEnabled(enabled); return {ok:true, markdownEnabled: loadCfg().markdownEnabled}; });
ipcMain.handle('clipai:process-text', (_e,{text,mode})=> processText(text, mode));
ipcMain.handle('clipai:resize', (_e,{width,height})=>{ if(win){ win.setSize(Math.round(width), Math.round(height), true); } return {ok:true}; });
ipcMain.handle('clipai:get-clipboard', ()=> clipboard.readText());
ipcMain.handle('clipai:set-hotkeys', (_e,{summarize, explain})=>{
  const cfg = loadCfg();
  if(typeof summarize==='string') cfg.hotkeys.summarize = summarize;
  if(typeof explain==='string') cfg.hotkeys.explain = explain;
  saveCfg();
  applyHotkeys();
  return {ok:true, hotkeys: { summarize: normalizeAccel(cfg.hotkeys.summarize), explain: normalizeAccel(cfg.hotkeys.explain) }};
});
ipcMain.handle('clipai:open-settings', ()=> { openSettingsWindow(); return {ok:true}; });
ipcMain.handle('clipai:get-prompts', ()=>{
  const cfg = loadCfg();
  return {presets: PROMPT_PRESETS, selections: cfg.promptSelections, custom: cfg.customPrompts};
});
ipcMain.handle('clipai:set-prompt-selection', (_e,{summary, explain})=>{
  const cfg = loadCfg();
  if(summary){ if(summary==='custom' || PROMPT_PRESETS.summary[summary]) cfg.promptSelections.summary = summary; }
  if(explain){ if(explain==='custom' || PROMPT_PRESETS.explain[explain]) cfg.promptSelections.explain = explain; }
  saveCfg();
  return {ok:true, selections: cfg.promptSelections};
});
ipcMain.handle('clipai:set-custom-prompt', (_e,{summary, explain})=>{
  const cfg = loadCfg();
  if(summary!==undefined) cfg.customPrompts.summary = String(summary||'');
  if(explain!==undefined) cfg.customPrompts.explain = String(explain||'');
  saveCfg();
  return {ok:true, custom: cfg.customPrompts};
});
ipcMain.handle('clipai:hide-window', ()=>{ try { if(win) win.hide(); } catch(_){} return {ok:true}; });
ipcMain.handle('clipai:list-models', async (_e,{provider})=>{
  const cfg = loadCfg();
  const provName = provider || cfg.active;
  const prov = cfg.providers[provName];
  if(!prov || !prov.key) return {models:[], error:'No key'};
  const models = await listModelsForProvider(provName, prov.key);
  return {models};
});

// Minimal noise: surface unhandled promise rejections for debugging
process.on('unhandledRejection', err=> console.warn('[UNHANDLED REJECTION]', err));
 