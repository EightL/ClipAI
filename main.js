const {app, globalShortcut, BrowserWindow} = require('electron');
let win;
function create() {
  win = new BrowserWindow({width:400,height:260,show:false,alwaysOnTop:true,frame:false,transparent:true});
  win.loadFile('index.html');
}
app.whenReady().then(()=>{
  create();
  const toggle = ()=>{ if(!win) return; const showing = !win.isVisible(); showing? win.show(): win.hide(); console.log('[DBG] Toggled popup ->', showing? 'shown':'hidden'); };
  // Register a few modifier combos (these are more reliable cross-platform than raw single key):
  const combos = [
    'CommandOrControl+Shift+Space',
    'CommandOrControl+Shift+P',
    'CommandOrControl+Alt+P'
  ];
  combos.forEach(c=>{
    const ok = globalShortcut.register(c, toggle);
    console.log(ok? `[DBG] Registered combo ${c}` : `[DBG] FAILED combo ${c}`);
  });
  // Triple 'P' sequence within 800ms total (resets after pause) -> toggle popup (may fail on some OS policies).
  let pressCount = 0, lastPress = 0;
  const singleOk = globalShortcut.register('P', ()=>{
    const now = Date.now();
    const gap = now - lastPress;
    if(gap > 800 && pressCount) { console.log('[DBG] Timeout gap', gap, 'ms -> reset'); pressCount = 0; }
    lastPress = now;
    pressCount++;
    console.log('[DBG] P press', pressCount, 'gap', gap || 0, 'ms');
    if(pressCount === 3) { pressCount = 0; toggle(); }
  });
  console.log(singleOk ? "[DBG] Registered single-key 'P' for PPP sequence" : "[DBG] FAILED single-key 'P' (likely blocked by OS)");
  app.on('activate', ()=> BrowserWindow.getAllWindows().length===0 && create());
});
app.on('will-quit', ()=> globalShortcut.unregisterAll());
 