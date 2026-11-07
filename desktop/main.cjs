'use strict';
const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell, session, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { migrateLegacyData } = require('./migrate.cjs');
const { assertSafeExport } = require('./fs-safety.cjs');
const { createUpdater, CHECK_INTERVAL_MS } = require('./updater.cjs');
const { createUpdateController, createUpdateLifecycle } = require('./update-controller.cjs');

const ROOT = path.resolve(__dirname, '..');
const APP_ID = 'com.moneylab.superledger';
const TEST_MODE = process.argv.includes('--ledger-smoke-test');
const UI_TEST_MODE = process.argv.includes('--ledger-ui-test');
const ISOLATED_MODE = TEST_MODE || UI_TEST_MODE;
const testProfile = process.env.LEDGER_TEST_PROFILE;
if (ISOLATED_MODE && !testProfile) throw new Error('Desktop tests require an isolated LEDGER_TEST_PROFILE.');
app.setName('超级账本');
app.setPath('userData', ISOLATED_MODE ? path.resolve(testProfile) : path.join(app.getPath('appData'), 'SuperLedger'));
app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
const dataDirectory = path.join(app.getPath('userData'), 'data');
const protectedDirectories = [app.getPath('userData')];
let mainWindow, tray, server, origin = '', quitting = false, alreadyClosing = false;
let updater, updateController, updateLifecycle;
const sessionToken = randomBytes(32).toString('hex');
const preferencesFile = path.join(app.getPath('userData'), 'desktop-settings.json');
const SUBSCRIPTION_VIEWS = ['detailed', 'compact'];
let preferences = { keepInTray: true, subscriptionView: 'detailed' };
try { const p=JSON.parse(fs.readFileSync(preferencesFile,'utf8'));if(typeof p.keepInTray==='boolean')preferences.keepInTray=p.keepInTray;if(SUBSCRIPTION_VIEWS.includes(p.subscriptionView))preferences.subscriptionView=p.subscriptionView; } catch {}

function log(message) {
  try { fs.mkdirSync(app.getPath('userData'),{recursive:true});fs.appendFileSync(path.join(app.getPath('userData'),'desktop.log'),`[${new Date().toISOString()}] ${message}\n`); } catch {}
}
function savePreferences() {
  fs.mkdirSync(app.getPath('userData'),{recursive:true});
  fs.writeFileSync(preferencesFile,JSON.stringify(preferences,null,2));
}
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('无效的应用请求');
  const url = new URL(event.senderFrame.url);
  if (url.origin !== origin) throw new Error('无效的应用来源');
}
function showWindow() { if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();void updateLifecycle?.opened();void offerUpdate(false);} }
function info() { return { version:app.getVersion(),dataDirectory,keepInTray:preferences.keepInTray,subscriptionView:preferences.subscriptionView,platform:process.platform }; }
function configureIpc() {
  ipcMain.handle('ledger:info',event=>{trusted(event);return info();});
  ipcMain.handle('ledger:update-status',event=>{trusted(event);return updater.status();});
  ipcMain.handle('ledger:update-check',async event=>{trusted(event);await checkUpdates(true);return updater.status();});
  ipcMain.handle('ledger:update-download',async event=>{trusted(event);return updateController.download();});
  ipcMain.handle('ledger:update-cancel',event=>{trusted(event);return updater.cancelDownload();});
  ipcMain.handle('ledger:update-install',async event=>{trusted(event);return updateController.install();});
  ipcMain.handle('ledger:update-defer',event=>{trusted(event);return updateController.defer();});
  ipcMain.handle('ledger:subscription-view',(event,view)=>{
    trusted(event);if(!SUBSCRIPTION_VIEWS.includes(view))throw new Error('设置格式无效');
    preferences.subscriptionView=view;savePreferences();return info();
  });
  ipcMain.handle('ledger:preferences',(event,value)=>{
    trusted(event);if(!value||typeof value.keepInTray!=='boolean')throw new Error('设置格式无效');
    preferences.keepInTray=value.keepInTray;savePreferences();updateTray();return info();
  });
  ipcMain.handle('ledger:open-data',async event=>{trusted(event);await shell.openPath(dataDirectory);return true;});
  ipcMain.handle('ledger:mobile-files',async event=>{
    trusted(event);
    const directory=app.isPackaged?path.join(process.resourcesPath,'mobile'):path.join(ROOT,'android','release');
    if(!fs.existsSync(directory))throw new Error('安卓安装包尚未构建，请使用完整的 1.5.0 桌面安装包。');
    const error=await shell.openPath(directory);if(error)throw new Error(error);return true;
  });
  ipcMain.handle('ledger:mobile-firewall',async event=>{
    trusted(event);
    if(!app.isPackaged||process.platform!=='win32')throw new Error('请在已安装的 Windows 桌面版中设置局域网连接。');
    const script=path.join(process.resourcesPath,'mobile','enable-mobile-sync.ps1');
    if(!fs.existsSync(script))throw new Error('缺少局域网设置工具，请重新安装完整桌面版。');
    // All arguments are fixed application paths. Encode PowerShell as UTF-16LE
    // and quote literal apostrophes; no user supplied command can be executed.
    const literal=value=>"'"+value.replace(/'/g,"''")+"'";
    const inner=`try { & ${literal(script)} -ProgramPath ${literal(process.execPath)}; exit 0 } catch { exit 1 }`;
    const encoded=Buffer.from(inner,'utf16le').toString('base64');
    const command=`$p=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
    await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:180000},error=>error?reject(new Error('Windows 授权未完成或规则添加失败。未修改代理或网络类别；需要时可再次点击并允许管理员授权。')):resolve()));
    return true;
  });
  ipcMain.handle('ledger:save-export',async(event,payload)=>{
    trusted(event);
    if(!payload||typeof payload.name!=='string'||typeof payload.content!=='string'||Buffer.byteLength(payload.content)>2*1024*1024+1024)throw new Error('导出内容格式或大小不正确');
    const name=path.basename(payload.name);
    const ext=path.extname(name).toLowerCase();
    if(!['.json','.csv'].includes(ext)||name!==payload.name)throw new Error('仅支持导出 JSON 或 CSV');
    const choice=await dialog.showSaveDialog(mainWindow,{title:ext==='.json'?'保存完整账本备份':'导出收支明细',defaultPath:path.join(app.getPath('documents'),name),filters:[{name:ext==='.json'?'账本备份':'CSV 表格',extensions:[ext.slice(1)]}]});
    if(choice.canceled||!choice.filePath)return {saved:false};
    const exportPath=assertSafeExport(choice.filePath,protectedDirectories);
    const temporary=path.join(path.dirname(exportPath),`.moneylab-export-${randomBytes(8).toString('hex')}.tmp`);
    try { fs.writeFileSync(temporary,payload.content,{encoding:'utf8',flag:'wx'});fs.renameSync(temporary,exportPath); }
    finally { if(fs.existsSync(temporary))fs.unlinkSync(temporary); }
    return {saved:true};
  });
  ipcMain.handle('ledger:pick-backup',async event=>{
    trusted(event);
    const choice=await dialog.showOpenDialog(mainWindow,{title:'选择超级账本备份',properties:['openFile'],filters:[{name:'账本备份',extensions:['json']}]});
    if(choice.canceled||!choice.filePaths[0])return null;
    const file=choice.filePaths[0];if(fs.statSync(file).size>2*1024*1024)throw new Error('备份不能超过 2 MB');
    return {name:path.basename(file),content:fs.readFileSync(file,'utf8')};
  });
  ipcMain.on('ledger:quit',event=>{trusted(event);quitting=true;app.quit();});
}
function updateTray() {
  if(!tray)return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'打开超级账本',click:showWindow},
    {type:'separator'},
    {label:'关闭窗口后留在托盘',type:'checkbox',checked:preferences.keepInTray,click:item=>{preferences.keepInTray=item.checked;savePreferences();mainWindow?.webContents.send('ledger:preferences-changed',info());updateTray();}},
    {label:'打开数据文件夹',click:()=>shell.openPath(dataDirectory)},
    {type:'separator'},
    {label:'退出超级账本',click:()=>{quitting=true;app.quit();}}
  ]));
}
function createTray() {
  const trayImage=nativeImage.createFromPath(path.join(ROOT,'assets','app-icon.png')).resize({width:24,height:24});
  tray=new Tray(trayImage);tray.setToolTip('超级账本 · 本地保存，自动记录订阅');tray.on('double-click',showWindow);tray.on('click',showWindow);updateTray();
}
function publishUpdateStatus(value) {
  if(!mainWindow||mainWindow.isDestroyed())return;
  mainWindow.webContents.send('ledger:update-status-changed',value);
  mainWindow.setProgressBar(value.phase==='downloading'&&value.totalBytes?Math.min(1,value.downloadedBytes/value.totalBytes):-1);
}
function initializeUpdater() {
  updater=createUpdater({currentVersion:app.getVersion(),userDataDirectory:app.getPath('userData'),
    publicKey:fs.readFileSync(path.join(ROOT,'assets','update-public-key.pem'),'utf8'),
    enabled:app.isPackaged&&process.platform==='win32'&&!ISOLATED_MODE,
    onStatus:publishUpdateStatus});
  updateController=createUpdateController({updater,
    isVisible:()=>!quitting&&Boolean(mainWindow&&!mainWindow.isDestroyed()&&mainWindow.isVisible()&&!mainWindow.isMinimized()),
    hasOpenEditor,
    notify:value=>{if(mainWindow&&!mainWindow.isDestroyed()&&!quitting)mainWindow.webContents.send('ledger:update-prompt',value);},
    quit:()=>{quitting=true;app.quit();},
  });
  updateLifecycle=createUpdateLifecycle({
    check:()=>checkUpdates(false),
    enabled:()=>!quitting&&updater.status().enabled,
    intervalMs:CHECK_INTERVAL_MS,
    onResult:(value,reason)=>log(`Update check (${reason}): ${value.phase}${value.error?`; ${value.error}`:''}`),
    onError:(error,reason)=>log(`Update check (${reason}): ${error.message}`),
  });
}
async function hasOpenEditor() {
  if(!mainWindow||mainWindow.isDestroyed())return true;
  try{return await mainWindow.webContents.executeJavaScript('Boolean(document.querySelector(".modal form"))');}
  catch{return true;}
}
async function offerUpdate(manual=false) {
  if(!updateController||quitting)return;
  return updateController.offer(manual);
}
async function checkUpdates(manual=false) {
  if(!updateController||quitting)return;
  return updateController.check(manual);
}
async function configureSession(appSession) {
  await appSession.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:10090',proxyBypassRules:'<local>'});
  appSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  appSession.setPermissionCheckHandler(()=>false);
  appSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    let allowed=false;
    try { const u=new URL(details.url);allowed=u.origin===origin||u.protocol==='data:'||(u.protocol==='blob:'&&u.origin===origin); } catch {}
    callback({cancel:!allowed});
  });
  appSession.webRequest.onBeforeSendHeaders({urls:['http://127.0.0.1/*']},(details,callback)=>{
    const headers={...details.requestHeaders};
    if(details.url.startsWith(origin+'/api/'))headers['X-Ledger-Token']=sessionToken;
    callback({requestHeaders:headers});
  });
}
function createWindow(appSession) {
  const area=screen.getPrimaryDisplay().workAreaSize;
  mainWindow=new BrowserWindow({
    width:Math.min(1420,area.width-60),height:Math.min(1040,area.height-50),minWidth:960,minHeight:680,
    title:UI_TEST_MODE?'超级账本 · 测试窗口':'超级账本',show:false,backgroundColor:'#f7f8fc',autoHideMenuBar:true,
    icon:path.join(ROOT,'assets','app-icon.ico'),titleBarStyle:'hidden',
    titleBarOverlay:{color:'#f7f8fc',symbolColor:'#777586',height:36},
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,spellcheck:false,session:appSession}
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
  mainWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
  mainWindow.webContents.on('page-title-updated',event=>{event.preventDefault();mainWindow.setTitle(UI_TEST_MODE?'超级账本 · 测试窗口':'超级账本');});
  mainWindow.webContents.on('render-process-gone',(_event,details)=>log(`Renderer stopped: ${details.reason}`));
  mainWindow.on('close',event=>{if(!quitting&&!TEST_MODE&&preferences.keepInTray&&tray){event.preventDefault();mainWindow.hide();}});
  mainWindow.on('closed',()=>{mainWindow=null;});
  mainWindow.on('focus',()=>{void offerUpdate(false);});
  mainWindow.webContents.on('did-finish-load',()=>updateController?.resetPrompt());
  mainWindow.once('ready-to-show',()=>{if(!TEST_MODE)mainWindow.show();});
  return mainWindow.loadURL(origin+'/');
}
async function boot() {
  const {validateState}=await import(pathToFileURL(path.join(ROOT,'engine.mjs')).href);
  let legacy=[];
  if(!ISOLATED_MODE){
    try{legacy=JSON.parse(fs.readFileSync(path.join(__dirname,'legacy-locations.json'),'utf8'));}catch{}
    legacy.push(path.join(ROOT,'data'));
    protectedDirectories.push(...legacy);
  }
  const migrated=migrateLegacyData({destinationDirectory:dataDirectory,legacyDirectories:legacy,validate:validateState});
  if(migrated.migrated)log(`Migrated existing ledger with backup from ${migrated.source}`);
  const {createLedgerServer}=await import(pathToFileURL(path.join(ROOT,'server.mjs')).href);
  server=await createLedgerServer({port:0,dataDirectory,authToken:sessionToken,onlineRates:!ISOLATED_MODE||(UI_TEST_MODE&&process.env.LEDGER_TEST_RATES==='1')});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  initializeUpdater();
  const appSession=session.fromPartition('persist:super-ledger');
  await configureSession(appSession);configureIpc();Menu.setApplicationMenu(null);
  if(!TEST_MODE)createTray();
  await createWindow(appSession);
  publishUpdateStatus(updater.status());void updateLifecycle.start();
  log(`Application ${app.getVersion()} ready; local ledger, daily public exchange rates via configured proxy; migration=${migrated.migrated}`);
  if(TEST_MODE){
    const check=await fetch(origin+'/api/state',{headers:{'X-Ledger-Token':sessionToken}});const state=await check.json();validateState(state);
    const denied=await fetch(origin+'/api/state');
    const report={ready:true,version:app.getVersion(),electron:process.versions.electron,authorizedStatus:check.status,unauthorizedStatus:denied.status,rendererLoaded:!mainWindow.webContents.isLoading(),isolatedDataDirectory:dataDirectory,ledger:{demo:state.demo,accounts:state.accounts.length,transactions:state.transactions.length,subscriptions:state.subscriptions.length,goals:state.goals.length,monthlyBudget:state.settings.monthlyBudget}};
    fs.writeFileSync(path.join(app.getPath('userData'),'smoke-report.json'),JSON.stringify(report,null,2));
    quitting=true;app.quit();
  }
}

const primary=app.requestSingleInstanceLock();
if(!primary){app.quit();}else{
  app.on('second-instance',showWindow);
  app.on('activate',showWindow);
  app.on('window-all-closed',()=>{if(!preferences.keepInTray||quitting||TEST_MODE)app.quit();});
  app.on('before-quit',event=>{
    quitting=true;
    updateLifecycle?.close();updater?.close();
    if(server&&!alreadyClosing){event.preventDefault();alreadyClosing=true;const active=server;server=null;active.close(()=>app.quit());active.closeAllConnections();}
  });
  app.on('will-quit',()=>{tray?.destroy();});
  app.whenReady().then(boot).catch(error=>{log(error.stack||error.message);dialog.showErrorBox('超级账本未能启动',`${error.message}\n\n原账本不会被覆盖。请查看 ${app.getPath('userData')} 中的 desktop.log。`);quitting=true;app.quit();});
}
