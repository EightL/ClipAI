const {app, globalShortcut, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage} = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

let win;
const CFG_PATH = path.join(app.getPath('userData'), 'config.json');
let cfgCache = null;
let lastFullText = ''; // track last processed full selection for toggle behavior
let lastModeUsed = ''; // 'summary' | 'explain'
let registeredSummary = null;
let registeredExplain = null;
let tray = null;
let destroyTimer = null; // for low memory mode deferred destroy
function loadCfg(){
  if(cfgCache) return cfgCache;
  try { cfgCache = JSON.parse(fs.readFileSync(CFG_PATH,'utf8')); } catch(_) { cfgCache = { providers:{}, active:'openai', theme:'dark', hotkeys:{ summarize:'CommandOrControl+Shift+Space', explain:'' }, memoryMode:'normal' }; }
  if(!cfgCache.hotkeys) cfgCache.hotkeys = { summarize:'CommandOrControl+Shift+Space', explain:'' };
  if(!cfgCache.providers) cfgCache.providers = {};
  if(!cfgCache.active) cfgCache.active = 'openai';
  if(!cfgCache.theme) cfgCache.theme = 'dark';
  if(!cfgCache.memoryMode) cfgCache.memoryMode = 'normal';
  return cfgCache;
}
function saveCfg(){ try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfgCache,null,2)); } catch(e){ console.error('Save config failed', e); } }
function saveProviderKey(provider, key, model){ const cfg = loadCfg(); if(!cfg.providers[provider]) cfg.providers[provider]={}; cfg.providers[provider].key = key; if(model) cfg.providers[provider].model = model; saveCfg(); }
function setActiveProvider(p){ const cfg = loadCfg(); cfg.active = p; saveCfg(); }
function currentProvider(){ const cfg = loadCfg(); return { name: cfg.active, ...cfg.providers[cfg.active] }; }
function setTheme(theme){ const cfg = loadCfg(); cfg.theme = theme==='light'?'light':'dark'; saveCfg(); }
function setMemoryMode(mode){ const cfg = loadCfg(); cfg.memoryMode = (mode==='aggressive')?'aggressive':'normal'; saveCfg(); }

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
function create() {
  const iconPath = resolveAsset(['icons/icon.png','icon.png']);
  win = new BrowserWindow({
    width:500,height:150,show:false,alwaysOnTop:true,frame:false,transparent:true,useContentSize:true,
    icon: iconPath || undefined,
    webPreferences:{preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false}
  });
  win.loadFile('index.html');
  win.on('hide', ()=> scheduleDestroyIfNeeded());
}

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

async function summarize(text){
  const prov = currentProvider();
  if(!prov.key) return {error:`No API key set for ${prov.name}`};
  text = (text||'').trim();
  if(!text) return {error:'Empty selection'};
  const maxChars = 4000; if(text.length>maxChars) text = text.slice(0,maxChars)+'...';
  try {
    if(prov.name === 'openai'){
      const model = prov.model || 'gpt-4o-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions',{
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${prov.key}`},
  body: JSON.stringify({model, messages:[{role:'system',content:'Return ONE short sentence (<=25 words) capturing the core idea. No preamble.'},{role:'user',content:text}], temperature:0.2, max_tokens:60})
      });
      if(!res.ok) return {error:`OpenAI ${res.status}`};
      const data = await res.json();
      const summary = data.choices?.[0]?.message?.content?.trim() || 'No content';
      return {summary, provider:prov.name, model};
    } else if(prov.name === 'gemini') {
      const model = prov.model || 'gemini-2.5-flash-lite';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${prov.key}`,{
        method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({contents:[{parts:[{text:`Return ONE short sentence (<=25 words) capturing the core idea:\n\n${text}` }]}]})
      });
      if(!res.ok) return {error:`Gemini ${res.status}`};
      const data = await res.json();
      const summary = data.candidates?.[0]?.content?.parts?.map(p=>p.text).join('').trim() || 'No content';
      return {summary, provider:prov.name, model};
    } else {
      return {error:`Unknown provider ${prov.name}`};
    }
  } catch(e){ return {error:e.message}; }
}

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
async function processText(text, mode){
  const prov = currentProvider();
  if(!prov.key) return {error:`No API key set for ${prov.name}`};
  text = (text||'').trim();
  if(!text) return {error:'Empty text'};
  const base = text.length>5000? text.slice(0,5000)+'...': text;
  const purpose = mode==='explain'
    ? 'Explain in ONE or TWO crisp sentences (<=40 words total). Keep essential symbols / LaTeX. No intro words.'
    : 'Give ONE short sentence (<=25 words) summarizing the core idea. Preserve key symbols / LaTeX. No preface.';
  try {
    if(prov.name==='openai'){
      const model = prov.model || 'gpt-4o-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${prov.key}`},body:JSON.stringify({model,messages:[{role:'system',content:purpose},{role:'user',content:base}],temperature:0.2,max_tokens:70})});
      if(!res.ok) return {error:`OpenAI ${res.status}`};
      const data = await res.json();
      return {output:data.choices?.[0]?.message?.content?.trim()||''};
    } else if(prov.name==='gemini'){
      const model = prov.model || 'gemini-2.5-flash-lite';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${prov.key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:`${purpose}\n\n${base}` }]}]})});
      if(!res.ok) return {error:`Gemini ${res.status}`};
      const data = await res.json();
      return {output:data.candidates?.[0]?.content?.parts?.map(p=>p.text).join('').trim()||''};
    }
    return {error:'Unknown provider'};
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

process.on('unhandledRejection', err=> console.warn('[UNHANDLED REJECTION]', err));
 