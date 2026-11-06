'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ledgerDesktop', Object.freeze({
  isDesktop:true,
  getInfo:()=>ipcRenderer.invoke('ledger:info'),
  getUpdateStatus:()=>ipcRenderer.invoke('ledger:update-status'),
  checkForUpdates:()=>ipcRenderer.invoke('ledger:update-check'),
  downloadUpdate:()=>ipcRenderer.invoke('ledger:update-download'),
  cancelUpdateDownload:()=>ipcRenderer.invoke('ledger:update-cancel'),
  installUpdate:()=>ipcRenderer.invoke('ledger:update-install'),
  deferUpdate:()=>ipcRenderer.invoke('ledger:update-defer'),
  setPreferences:value=>ipcRenderer.invoke('ledger:preferences',{keepInTray:Boolean(value.keepInTray)}),
  openDataDirectory:()=>ipcRenderer.invoke('ledger:open-data'),
  openMobileFiles:()=>ipcRenderer.invoke('ledger:mobile-files'),
  enableMobileSyncNetwork:()=>ipcRenderer.invoke('ledger:mobile-firewall'),
  saveExport:(name,content)=>ipcRenderer.invoke('ledger:save-export',{name,content}),
  pickBackup:()=>ipcRenderer.invoke('ledger:pick-backup'),
  quit:()=>ipcRenderer.send('ledger:quit'),
  onPreferencesChanged:callback=>{const handler=(_event,value)=>callback(value);ipcRenderer.on('ledger:preferences-changed',handler);return ()=>ipcRenderer.removeListener('ledger:preferences-changed',handler);},
  onUpdateStatusChanged:callback=>{const handler=(_event,value)=>callback(value);ipcRenderer.on('ledger:update-status-changed',handler);return ()=>ipcRenderer.removeListener('ledger:update-status-changed',handler);},
  onUpdatePrompt:callback=>{const handler=(_event,value)=>callback(value);ipcRenderer.on('ledger:update-prompt',handler);return ()=>ipcRenderer.removeListener('ledger:update-prompt',handler);}
}));
