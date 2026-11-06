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
let updater, updateTimer, updateStartupTimer, updatePromptBusy = false, downloadPromptBusy = false, installPromptBusy = false;
const sessionToken = randomBytes(32).toString('hex');
const preferencesFile = path.join(app.getPath('userData'), 'desktop-settings.json');
let preferences = { keepInTray: true };
try { const p=JSON.parse(fs.readFileSync(preferencesFile,'utf8'));if(typeof p.keepInTray==='boolean')preferences.keepInTray=p.keepInTray; } catch {}

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
function showWindow() { if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();void offerUpdate(false);} }
function info() { return { version:app.getVersion(),dataDirectory,keepInTray:preferences.keepInTray,platform:process.platform }; }
function configureIpc() {
  ipcMain.handle('ledger:info',event=>{trusted(event);return info();});
  ipcMain.handle('ledger:update-status',event=>{trusted(event);return updater.status();});
  ipcMain.handle('ledger:update-check',async event=>{trusted(event);await checkUpdates(true);return updater.status();});
  ipcMain.handle('ledger:update-download',async event=>{trusted(event);await downloadUpdate();return updater.status();});
  ipcMain.handle('ledger:update-cancel',event=>{trusted(event);return updater.cancelDownload();});
  ipcMain.handle('ledger:update-install',async event=>{trusted(event);await offerInstall();return updater.status();});
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
}
async function hasOpenEditor() {
  if(!mainWindow||mainWindow.isDestroyed())return true;
  try{return await mainWindow.webContents.executeJavaScript('Boolean(document.querySelector(".modal form"))');}
  catch{return true;}
}
async function updateMessage(options) {
  if(!mainWindow||mainWindow.isDestroyed()||quitting)return {response:options.cancelId??1};
  return dialog.showMessageBox(mainWindow,{title:'超级账本 · 应用更新',noLink:true,...options});
}
async function offerInstall() {
  if(installPromptBusy||!updater?.status().ready||quitting)return;
  installPromptBusy=true;
  try{
    if(await hasOpenEditor()){
      await updateMessage({type:'info',message:'新版本已下载，请先保存正在编辑的内容',detail:'当前有打开的编辑表单。请返回完成保存，再到「账本设置 → 应用更新」点击安装。',buttons:['返回保存'],defaultId:0,cancelId:0});
      return;
    }
    const value=updater.status();
    const choice=await updateMessage({type:'question',message:`安装超级账本 ${value.availableVersion}？`,detail:'将正常退出当前应用，覆盖升级已安装的超级账本，完成后重新打开。账本仍保存在应用数据目录。请确认需要的内容已经保存。',buttons:['退出并安装','稍后安装'],defaultId:1,cancelId:1});
    if(choice.response!==0){updater.defer();return;}
    // A form can be opened while a download is running. Recheck immediately
    // before spawning, and never abandon an open editor to install an update.
    if(await hasOpenEditor())return;
    await updater.install();
    quitting=true;app.quit();
  }catch(error){await updateMessage({type:'error',message:'暂时无法安装更新',detail:error.message,buttons:['知道了'],defaultId:0,cancelId:0});}
  finally{installPromptBusy=false;}
}
async function downloadUpdate() {
  if(downloadPromptBusy||quitting)return;
  downloadPromptBusy=true;
  const progressDialog=new AbortController();let finished=false;
  try{
    const value=updater.status();
    if(!value.availableVersion)throw new Error('请先检查可用更新。');
    const progress=updateMessage({type:'info',message:`正在下载超级账本 ${value.availableVersion}`,detail:'下载完成后会再次询问是否退出安装。你可以继续使用账本，也可在设置中查看进度或取消下载。',buttons:['取消下载','后台下载'],defaultId:1,cancelId:1,signal:progressDialog.signal});
    void progress.then(choice=>{if(!finished&&choice.response===0)updater.cancelDownload();}).catch(()=>{});
    const result=await updater.download();
    finished=true;progressDialog.abort();
    if(result.ready)await offerInstall();
    else if(result.phase==='error')await updateMessage({type:'error',message:'更新未能下载完成',detail:result.error,buttons:['知道了'],defaultId:0,cancelId:0});
  }catch(error){await updateMessage({type:'error',message:'暂时无法下载更新',detail:error.message,buttons:['知道了'],defaultId:0,cancelId:0});}
  finally{finished=true;progressDialog.abort();downloadPromptBusy=false;}
}
async function offerUpdate(manual=false) {
  if(!updater||updatePromptBusy||downloadPromptBusy||installPromptBusy||quitting)return;
  const value=updater.status();
  if(!value.enabled||!['available','ready'].includes(value.phase)||!value.availableVersion)return;
  if(!manual&&(!updater.shouldPrompt()||!mainWindow?.isVisible()||await hasOpenEditor()))return;
  updatePromptBusy=true;
  try{
    if(value.ready){await offerInstall();return;}
    const choice=await updateMessage({type:'info',message:`发现新版本 ${value.availableVersion}`,detail:`当前版本 ${value.currentVersion}\n\n${value.notes||'包含功能改进与问题修复。'}\n\n下载前会验证发布签名，下载后会校验安装包。`,buttons:['下载更新','稍后提醒'],defaultId:1,cancelId:1});
    if(choice.response===0)await downloadUpdate();else updater.defer();
  }catch(error){if(manual)await updateMessage({type:'error',message:'更新暂不可用',detail:error.message,buttons:['知道了'],defaultId:0,cancelId:0});}
  finally{updatePromptBusy=false;}
}
async function checkUpdates(manual=false) {
  if(!updater||quitting)return;
  try{
    const result=await updater.check();
    if(result.phase==='error'){
      if(manual)await updateMessage({type:'warning',message:'未能检查更新',detail:result.error,buttons:['知道了'],defaultId:0,cancelId:0});
    }else if(['available','ready'].includes(result.phase))await offerUpdate(manual);
    else if(manual&&result.phase==='idle')await updateMessage({type:'info',message:'当前已经是最新版本',detail:`超级账本 ${result.currentVersion}`,buttons:['知道了'],defaultId:0,cancelId:0});
  }catch(error){if(manual)await updateMessage({type:'warning',message:'当前无法检查更新',detail:error.message,buttons:['知道了'],defaultId:0,cancelId:0});}
}
function scheduleUpdates() {
  if(!updater.status().enabled)return;
  updateStartupTimer=setTimeout(()=>{void checkUpdates(false);},12000);updateStartupTimer.unref();
  updateTimer=setInterval(()=>{void checkUpdates(false);},CHECK_INTERVAL_MS);updateTimer.unref();
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
    title:UI_TEST_MODE?'超级账本 · 测试窗口':'超级账本',show:false,backgroundColor:'#f8f8f5',autoHideMenuBar:true,
    icon:path.join(ROOT,'assets','app-icon.ico'),titleBarStyle:'hidden',
    titleBarOverlay:{color:'#f8f8f5',symbolColor:'#777586',height:36},
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
  publishUpdateStatus(updater.status());scheduleUpdates();
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
    clearTimeout(updateStartupTimer);clearInterval(updateTimer);updater?.close();
    if(server&&!alreadyClosing){event.preventDefault();alreadyClosing=true;const active=server;server=null;active.close(()=>app.quit());active.closeAllConnections();}
  });
  app.on('will-quit',()=>{tray?.destroy();});
  app.whenReady().then(boot).catch(error=>{log(error.stack||error.message);dialog.showErrorBox('超级账本未能启动',`${error.message}\n\n原账本不会被覆盖。请查看 ${app.getPath('userData')} 中的 desktop.log。`);quitting=true;app.quit();});
}
