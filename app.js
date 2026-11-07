import { createMobileSyncUI, mobileSyncSettingsCard } from './mobile-sync-ui.js';
import { createUpdateUI } from './update-ui.js';
import { createIconSelects } from './icon-select.js';
import { renderAccountLibrary } from './account-cards.js';
import { getBalances, getCnyBalances, getNetWorth, transactionCnyAmount, moneyToCents, localDate, nextSubscriptionDue, setSubscriptionActive, replaceRecord, addMonthsDue, validateState, subscriptionAccountTypes, subscriptionExpiryStatus } from './engine.mjs';
import { subscriptionCatalog } from './subscription-catalog.mjs';
import { accountPresets, accountPreset, accountLabel, appleBalanceRegions, appleBalanceRegion, isAppleBalance } from './account-presets.mjs';
import { bankCatalog, bankById } from './bank-catalog.mjs';
import { currencyCatalog, currencyInfo, accountCurrency, currencyRate, parseMoney, amountInput, formatMoney, toCnyCents, normalizeRate } from './currencies.mjs';
const desktop = window.ledgerDesktop;
let desktopInfo = null;
let updateStatus = null;
let updateUI;
let mobileSync;
let iconSelects;


const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icons = {
  mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  palette:'<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.8 1.8 0 0 1 1-3.3h3a3 3 0 0 0 3-3c0-5-4-8-9-8Z"/><path d="M7 10h.01M10 7h.01M15 7h.01M6 14h.01"/>',
  gift:'<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-3 14h2"/>',
  bankCard:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 9h20M6 15h4m4 0h3"/>',
  cash:'<rect x="2" y="5" width="20" height="14" rx="3"/><circle cx="12" cy="12" r="3"/><path d="M5 9h1m12 6h1"/>',
  virtualCard:'<rect x="2" y="5" width="16" height="15" rx="3" stroke-dasharray="3 3"/><path d="M3 10h9m3-7 2 2-2 2m5-4-2 2 2 2M6 15h4"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  ledger:'<path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
  wallet:'<path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h14V8H6a2 2 0 0 1 0-4"/><path d="M20 12h-5v5h5M16 14.5h.1"/>',
  repeat:'<path d="m16 3 4 4-4 4M20 7H8a4 4 0 0 0-4 4M8 21l-4-4 4-4M4 17h12a4 4 0 0 0 4-4"/>',
  chart:'<path d="M4 3v17h17M8 15v-4m5 4V6m5 9V9"/>',
  goal:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  settings:'<path d="m10 3-.7 2.2-2 .9-2.2-.4-2 3.5 1.5 1.8v2l-1.5 1.8 2 3.5 2.2-.4 2 .9L10 21h4l.7-2.2 2-.9 2.2.4 2-3.5-1.5-1.8v-2l1.5-1.8-2-3.5-2.2.4-2-.9L14 3Z"/><circle cx="12" cy="12" r="3"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 19 19 5M5 5h14v14"/>',right:'<path d="m9 5 7 7-7 7"/>',left:'<path d="m15 5-7 7 7 7"/>',down:'<path d="M12 4v16m-6-6 6 6 6-6"/>',up:'<path d="M12 20V4m-6 6 6-6 6 6"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',bell:'<path d="M5 16h14l-2-3V9a5 5 0 0 0-10 0v4l-2 3Zm5 4h4"/>',eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-12 4h.1m4 0h.1m4 0h.1"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  shield:'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 12 3 3 5-6"/>',leaf:'<path d="M20 3C5 1 1 9 5 16s17 5 15-13ZM4 21 16 8"/>',coffee:'<path d="M3 8h13v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8Zm13 1h2a3 3 0 0 1 0 6h-2M6 3v2m4-2v2m4-2v2"/>',
  food:'<path d="M4 3v6a3 3 0 0 0 6 0V3M7 3v19M19 3c-4 2-5 8 0 9v10M19 3v9"/>',home:'<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',bag:'<path d="M4 7h16l1 14H3L4 7Zm4 0V5a4 4 0 0 1 8 0v2"/>',car:'<path d="m5 6 2-3h10l2 3 2 5v7H3v-7l2-5Zm-2 5h18M6 14h2m8 0h2M5 18v3m14-3v3"/>',book:'<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3V4Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h5V4Z"/>',
  music:'<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',play:'<rect x="3" y="5" width="18" height="15" rx="4"/><path d="m8 2 4 3 4-3m-6 8 5 3-5 3v-6Z"/>',cloud:'<path d="M7 19a5 5 0 1 1 0-10 6 6 0 0 1 12-1 5.5 5.5 0 0 1 0 11H7Z"/>',
  work:'<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V3h8v4M3 12a21 21 0 0 0 18 0m-9 0v4"/>',heart:'<path d="M12 21S2 15 2 8a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 7-10 13-10 13Z"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',upload:'<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',edit:'<path d="m15 4 5 5M3 21l5-1L21 7a2 2 0 0 0-4-4L4 16l-1 5Z"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',check:'<path d="m5 12 4 4L19 6"/>',spark:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>'
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.wallet}</svg>`;
const expenseCategories = ['餐饮美食','购物消费','交通出行','居住生活','会员订阅','娱乐休闲','学习成长','医疗健康','人情往来','其他支出'];
const incomeCategories = ['工资薪资','副业收入','投资收益','红包礼金','退款报销','其他收入'];
const categoryIcons = {'餐饮美食':'food','购物消费':'bag','交通出行':'car','居住生活':'home','会员订阅':'repeat','娱乐休闲':'play','学习成长':'book','医疗健康':'heart','人情往来':'heart','工资薪资':'work','副业收入':'spark','投资收益':'chart','红包礼金':'heart','账户转账':'repeat'};
const navItems = [['overview','grid','财务总览'],['transactions','ledger','收支账单'],['accounts','wallet','我的资产'],['subscriptions','repeat','订阅管理'],['insights','chart','收支洞察'],['goals','goal','心愿储蓄']];
let state, page = 'overview', month = localDate().slice(0,7), filter = 'all', query = '', accountFilter = '', hidden = false, menuOpen = false, busy = false, toastTimer, modalFocus;
let rateStatus = null, ratesError = '', ratesStatusPromise = null, ratesRefreshPromise = null, ratesRefreshing = false, ratesPollTimer, ratesDeferredRender = false;
let automaticBookingError = '', ledgerHealthUnavailable = false, ledgerHealthRequest = 0;
const manualRateDrafts = new WeakMap();
let accountView = 'banks';
const expandedBanks = new Set();
let dealBank = '';
let subscriptionFilter = 'all', subscriptionQuery = '', renderedDay = localDate();
const uid = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;
const amount = (cents, digits = 2) => ((cents === 0 ? 0 : cents) / 100).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:2});
const yuan = cents => `¥ ${amount(cents)}`;
const today = () => localDate();
const accountName = id => accountLabel(state.accounts.find(a=>a.id===id));
const accountById = id => state.accounts.find(a=>a.id===id);
const accountMoney = (units,id) => formatMoney(units,accountCurrency(accountById(id)));
const subscriptionMoney = s => formatMoney(s.amount,s.currency||accountCurrency(accountById(s.accountId)));
const hasForeign = () => state.accounts.some(a=>accountCurrency(a)!=='CNY');
const totals = rows => rows.reduce((a,t)=>{if(t.type==='income') a.income+=transactionCnyAmount(t,state); if(t.type==='expense')a.expense+=transactionCnyAmount(t,state);return a},{income:0,expense:0});
const monthRows = () => state.transactions.filter(t=>t.date.startsWith(month));
const monthly = () => totals(monthRows());
const balances = () => getBalances(state,today());
const netWorth = () => getNetWorth(state,today());
const recurringTotal = () => state.subscriptions.filter(s=>s.active&&s.recurring).reduce((a,s)=>a+toCnyCents(s.amount,accountCurrency(accountById(s.accountId)),currencyRate(accountById(s.accountId))),0);
const periodLabel = () => month===today().slice(0,7)?'本月':`${Number(month.slice(5))} 月`;
const monthLabel = () => `${month.slice(0,4)} 年 ${Number(month.slice(5))} 月`;
const dateLabel = d => d ? `${Number(d.slice(5,7))} 月 ${Number(d.slice(8))} 日` : '已完成';
const sortedRows = rows => [...rows].sort((a,b)=>b.date.localeCompare(a.date)||state.transactions.indexOf(b)-state.transactions.indexOf(a));
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('toast-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('toast-visible'),3500)}
async function api(path,options={}){const res=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});const value=await res.json();if(!res.ok){const e=new Error(value.error||'操作失败');e.status=res.status;throw e}return value}
function ledgerHealthNotice(){
 if(!automaticBookingError&&!ledgerHealthUnavailable)return '';
 const title=automaticBookingError?'自动记账暂未完成':'暂时无法检查自动记账状态';
 const detail=automaticBookingError?`现有账本已保留，可检查或暂停订阅后继续。${ledgerHealthUnavailable?'以下为上次检查结果：':''}${automaticBookingError}`:'已显示的账本和当前填写内容会保留，连接恢复后会自动重试。';
 return `<div class="ledger-warning" role="status" aria-live="polite" aria-atomic="true"><div><strong>${title}</strong><p>${esc(detail)}</p></div><button type="button" data-page="subscriptions">查看订阅 ${icon('right',14)}</button></div>`;
}
function updateLedgerHealthNotice(){
 const notice=$('#ledger-health-notice'),status=JSON.stringify([automaticBookingError,ledgerHealthUnavailable]);
 // Update this small region independently: health can change without a new
 // ledger revision, and an open editor must retain its draft and focus.
 if(notice&&notice.dataset.healthStatus!==status){notice.innerHTML=ledgerHealthNotice();notice.dataset.healthStatus=status}
}
async function loadLedgerHealth(){
 const request=++ledgerHealthRequest;
 try{
  const health=await api('/api/health',{signal:AbortSignal.timeout(8000)});
  if(request!==ledgerHealthRequest)return;
  automaticBookingError=typeof health.automaticBookingError==='string'?health.automaticBookingError:'';
  ledgerHealthUnavailable=false;
 }catch{
  if(request!==ledgerHealthRequest)return;
  ledgerHealthUnavailable=true;
 }finally{if(request===ledgerHealthRequest)updateLedgerHealthNotice()}
}
function desktopUpdateContent(){return updateUI?.settingsContent(updateStatus)||'<div class="panel-head"><h2>应用更新</h2></div><p class="small muted">正在读取版本信息…</p>'}
function desktopUpdateSettings(){return `<section class="panel" id="desktop-update-panel" style="grid-column:1/-1">${desktopUpdateContent()}</section>`}
function cachedRate(code){
 const quote=rateStatus?.rates?.[code];if(!quote)return null;
 try{return {...quote,cnyRate:normalizeRate(quote.cnyRate)}}catch{return null}
}
function rateTime(value){if(!value)return '尚未更新';const date=new Date(value);return Number.isNaN(date.getTime())?'尚未更新':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}
function rateErrors(){return [['法币汇率',rateStatus?.errors?.fiat],['USDT 汇率',rateStatus?.errors?.usdt],['账户估值',rateStatus?.applyError],['汇率缓存',rateStatus?.cacheError],['汇率服务',ratesError]].filter(([,value])=>value).map(([name,value])=>[name,typeof value==='string'?value:value.message||'暂时无法更新'])}
function rateIsRefreshing(){return ratesRefreshing||Boolean(rateStatus?.refreshing)}
function exchangeRateSettingsContent(){
 const updating=rateIsRefreshing(),errors=rateErrors(),codes=[...new Set([...(state?.accounts||[]).map(accountCurrency).filter(code=>code!=='CNY'),'USD','JPY','USDT'])].slice(0,6);
 const status=updating?'正在获取最新汇率':!rateStatus?(ratesError?'暂时未能连接':'正在读取汇率状态'):rateStatus.enabled===false?'自动更新暂不可用':errors.length?'部分更新未完成':rateStatus.lastSuccessAt?'每日自动更新已开启':'等待首次更新';
 return `<div class="panel-head"><div><h2>${icon('repeat',17)} 每日汇率</h2><p class="fx-panel-subtitle">账户保留原币，资产统一折合人民币</p></div><button type="button" class="btn btn-soft btn-sm" data-action="refresh-rates" ${updating||busy?'disabled':''}>${icon('repeat',14)} ${updating?'更新中…':'更新汇率'}</button></div><div class="fx-settings-summary" role="status"><span class="fx-status-pill ${errors.length?'has-error':''}"><i></i>${esc(status)}</span><span>上次成功 ${esc(rateTime(rateStatus?.lastSuccessAt))}</span>${rateStatus?.nextAttemptAt?`<span>下次检查 ${esc(rateTime(rateStatus.nextAttemptAt))}</span>`:''}</div><div class="fx-rates-list">${codes.map(code=>{const quote=cachedRate(code);return `<div class="fx-rate-item"><div><b>${code}</b><span>${esc(currencyInfo(code).name)}</span></div><strong>${quote?`1 ${code} = ${esc(quote.cnyRate)} CNY`:'等待可用汇率'}</strong><small>${quote?`${esc(quote.source||'公开汇率')} · ${esc(quote.asOf||'日期待确认')}`:'尚无缓存，可为账户手动填写'}</small></div>`}).join('')}</div>${errors.length?`<div class="fx-source-errors" role="status">${errors.map(([name,value])=>`<p><b>${esc(name)}</b> · ${esc(value)}</p>`).join('')}<p>已保存的汇率继续可用；手动模式账户不会被自动覆盖。</p></div>`:''}<p class="fx-privacy-note">法币来源 ECB，USDT 参考 Kraken × ECB。应用运行时每日更新，关闭后下次打开补查；参考汇率不代表实际兑换成交价。仅请求公开汇率，不上传账本。历史收支保留记账时的汇率。</p>`;
}
function exchangeRateSettings(){return `<section class="panel fx-settings-panel" id="exchange-rate-panel">${exchangeRateSettingsContent()}</section>`}
function updateRatesUI(){
 const panel=$('#exchange-rate-panel');
 if(panel){const focused=panel.contains(document.activeElement)&&document.activeElement?.dataset.action==='refresh-rates';panel.innerHTML=exchangeRateSettingsContent();if(focused)$('[data-action="refresh-rates"]',panel)?.focus({preventScroll:true})}
 updateAppleBalanceFields();
 updateSubscriptionPayment();
}
async function syncRatesLedger(){
 try{
  const next=await api('/api/state');
  if(busy||state&&next.revision<=state.revision)return;
  state=next;
  if($('.modal'))ratesDeferredRender=true;else render();
 }finally{void loadLedgerHealth()}
}
function scheduleRatesPoll(){
 clearTimeout(ratesPollTimer);
 if(rateStatus?.refreshing)ratesPollTimer=setTimeout(()=>{void loadRateStatus({sync:true})},1500);
}
async function loadRateStatus({sync=false}={}){
 if(ratesRefreshPromise)return ratesRefreshPromise;
 if(ratesStatusPromise)return ratesStatusPromise;
 ratesStatusPromise=(async()=>{
  try{const previous=rateStatus?.lastSuccessAt;rateStatus=await api('/api/rates');ratesError='';if(sync||previous!==rateStatus.lastSuccessAt)await syncRatesLedger()}
  catch(error){ratesError=error.message}
  finally{ratesStatusPromise=null;updateRatesUI();scheduleRatesPoll()}
  return rateStatus;
 })();
 updateRatesUI();
 return ratesStatusPromise;
}
async function refreshRates({announce=false}={}){
 if(ratesRefreshPromise)return ratesRefreshPromise;
 if(busy)return rateStatus;
 ratesRefreshing=true;ratesError='';updateRatesUI();
 ratesRefreshPromise=(async()=>{
  try{if(ratesStatusPromise)await ratesStatusPromise;rateStatus=await api('/api/rates/refresh',{method:'POST',body:'{}'});ratesError='';await syncRatesLedger();if(announce)toast(rateStatus.enabled===false?'自动更新暂不可用，可为账户选择手动汇率':rateErrors().length?'部分汇率未更新，已保留可用汇率':rateStatus.refreshing?'正在更新汇率':'汇率已更新，历史账单保持不变')}
  catch(error){ratesError=error.message;if(announce)toast('暂时无法更新汇率，已保存的汇率继续可用')}
  finally{ratesRefreshing=false;ratesRefreshPromise=null;updateRatesUI();scheduleRatesPoll()}
  return rateStatus;
 })();
 return ratesRefreshPromise;
}
async function ensureAccountRate(form){
 if(!form||form.elements.currency.value==='CNY'||form.elements.rateMode.value==='manual')return;
 const code=form.elements.currency.value,key=code+':auto';if(form.dataset.rateChecked===key)return;form.dataset.rateChecked=key;
 await loadRateStatus({sync:true});
 if(!form.isConnected||form.elements.currency.value!==code||form.elements.rateMode.value!=='auto')return;
 if(!cachedRate(code)&&rateStatus?.enabled!==false&&!rateIsRefreshing())await refreshRates();
}
async function commit(next,message='已保存到本机',importing=false){if(next.accounts.some(a=>accountCurrency(a)!=='CNY'))next.schemaVersion=2;if(busy)return false;busy=true;const buttons=[...document.querySelectorAll('.modal button[type="submit"]')];buttons.forEach(b=>b.disabled=true);try{state=await api(importing?'/api/import':'/api/state',{method:importing?'POST':'PUT',body:JSON.stringify({state:next,expectedRevision:state.revision})});if(importing){query='';filter='all';accountFilter=''}busy=false;closeModal();render();toast(message);return true}catch(e){if(e.status===409){state=await api('/api/state');busy=false;if($('.modal')){ratesDeferredRender=true;formError('汇率或账本已更新，填写已保留，请检查后再次保存');void loadRateStatus()}else{render();toast('账本已更新，请检查后再次保存')}}else formError(e.message);return false}finally{busy=false;buttons.forEach(b=>b.disabled=false);updateAccountCurrency();void loadLedgerHealth()}}
function formError(message){const el=$('.form-error');if(el)el.textContent=message;else toast(message)}
function monthControl(){return `<div class="month-picker"><button data-action="month-prev" aria-label="上个月">${icon('left',13)}</button><span>${monthLabel()}</span><button data-action="month-next" aria-label="下个月">${icon('right',13)}</button></div>`}
function shell(content){
 const current=navItems.find(n=>n[0]===page)?.[2]||'账本设置';
 return `${desktop?'<div class="native-titlebar"><span>超级账本</span><small>MONEY LAB</small></div>':''}
 <aside class="studio-sidebar">
  <a class="studio-brand" href="#overview" aria-label="超级账本首页"><span class="studio-brand-mark"><img src="/assets/app-icon.png" alt="" width="44" height="44"></span><span><b>超级账本<span>✦</span></b><small>MONEY LAB</small></span></a>
  <div class="studio-nav-label">我的空间</div>
  <nav class="studio-navigation" aria-label="主导航">${[...navItems,['settings','settings','账本设置']].map(([id,i,label])=>`<button data-page="${id}" class="${page===id?'active':''}" ${page===id?'aria-current="page"':''}>${icon(i,19)}<span>${label}</span>${page===id?'<i></i>':''}</button>`).join('')}</nav>
  <div class="studio-sidebar-bottom"><span>${icon('shield',20)}</span><strong>账本由你保管</strong><p>本地保存，扫码同步</p><small>LOCAL & YOURS</small></div>
 </aside>
 <header class="studio-topbar"><div class="studio-location"><small>我的账本</small><span>/</span><b>${current}</b></div><div class="studio-topbar-actions"><span class="local-status"><i class="live-dot"></i>已保存到本机</span><button type="button" class="btn btn-soft btn-sm mobile-sync-topbar" data-action="mobile-sync">${icon('phone',17)} 手机同步</button><button class="icon-btn" data-action="calendar" aria-label="订阅日历" title="订阅日历">${icon('calendar',19)}</button><button class="avatar" data-page="settings" aria-label="个人设置">ME</button></div></header>
 <main class="main studio-main ${hidden?'privacy':''}"><div id="ledger-health-notice" data-health-status="${esc(JSON.stringify([automaticBookingError,ledgerHealthUnavailable]))}">${ledgerHealthNotice()}</div>${content}<footer class="bottom-note"><span>一点记录，一点自由。</span><b>MONEY LAB</b></footer></main>`;
}

function heading(title,subtitle,kicker='',actions=''){
 return `<div class="page-heading"><div><p class="page-eyebrow">${icon(navItems.find(n=>n[0]===page)?.[1]||'settings',14)} ${page==='settings'?'按你的习惯':'我的财务空间'}</p><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function demoBanner(){return state.demo?`<div class="demo-banner"><span>${icon('info',12)} 你正在探索示例账本，所有金额均为演示数据。</span><button data-action="start-empty">开始我的账本 ${icon('right',11)}</button></div>`:(!state.accounts.length?`<div class="demo-banner"><span>${icon('wallet',12)} 账本已准备好，从添加你的第一个账户开始。</span><button data-action="add-account">添加账户 ${icon('plus',11)}</button></div>`:'')}
function addButton(){return `<button class="btn btn-primary" data-action="add-transaction">${icon('plus',16)} 记一笔</button>`}
function statCards(){const m=monthly();return `<div class="summary-grid"><div class="summary-card"><span class="stat-icon">${icon('down',19)}</span><div><small>${periodLabel()}收入</small><b class="money">${yuan(m.income)}</b></div><span class="stat-note">MONEY IN</span></div><div class="summary-card"><span class="stat-icon orange">${icon('up',19)}</span><div><small>${periodLabel()}支出</small><b class="money">${yuan(m.expense)}</b></div><span class="stat-note">MONEY OUT</span></div><div class="summary-card"><span class="stat-icon purple">${icon('wallet',19)}</span><div><small>${periodLabel()}结余</small><b class="money">${yuan(m.income-m.expense)}</b></div><span class="stat-note">LEFT TO LIVE</span></div></div>`}
function goalCard(g){
 const pct=g?Math.min(100,Math.round(g.saved/g.target*100)):0;
 return `<div class="goal-card"><div class="wish-art" aria-hidden="true"><span>${icon('spark',48)}</span><i>${icon('goal',30)}</i><em>MAKE IT HAPPEN</em></div><div class="goal-body"><div class="goal-title-row"><h3>${g?esc(g.name):'下一件想实现的小事'}</h3><button data-action="${g?'edit-goal':'add-goal'}" ${g?'data-id="'+esc(g.id)+'"':''} aria-label="${g?'编辑储蓄心愿':'创建储蓄目标'}">${icon(g?'arrow':'plus',17)}</button></div>${g?`<div class="goal-numbers"><span><b class="money">${yuan(g.saved)}</b> / <span class="money">${yuan(g.target)}</span></span><span class="money">${pct}%</span></div><div class="progress" role="progressbar" aria-label="储蓄进度" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`:'<p class="small muted">旅行、新设备，或任何让你开心的事。</p>'}</div></div>`;
}

function chart(rows=monthRows()){const [y,m]=month.split('-').map(Number);const days=new Date(y,m,0).getDate();const daily=Array.from({length:days},(_,i)=>totals(rows.filter(t=>Number(t.date.slice(8))===i+1)));const max=Math.max(10000,...daily.flatMap(d=>[d.income,d.expense]));const w=520,h=150,left=43,right=8,top=8,bottom=25;const x=i=>left+i*(w-left-right)/(days-1),py=v=>h-bottom-v/max*(h-top-bottom);const path=type=>daily.map((d,i)=>`${i?'L':'M'} ${x(i).toFixed(1)} ${py(d[type]).toFixed(1)}`).join(' ');const curve=path('income');return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${monthLabel()}每天收入和支出折线图，金额单位元"><defs><linearGradient id="income-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#b0a4f4" stop-opacity=".35"/><stop offset="100%" stop-color="#b0a4f4" stop-opacity=".01"/></linearGradient></defs>${[0,.5,1].map(v=>`<line x1="${left}" y1="${py(max*v)}" x2="${w-right}" y2="${py(max*v)}" stroke="#edf0e7" stroke-dasharray="3 4"/><text x="0" y="${py(max*v)+4}">${v===0?'0':amount(max*v,0)}</text>`).join('')}<path d="${curve} L ${x(days-1)} ${h-bottom} L ${left} ${h-bottom} Z" fill="url(#income-fill)"/><path d="${curve}" fill="none" stroke="#9584df" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="${path('expense')}" fill="none" stroke="#e8aa91" stroke-width="2" vector-effect="non-scaling-stroke"/>${[1,Math.round(days*.25),Math.round(days*.5),Math.round(days*.75),days].map(d=>`<text x="${x(d-1)}" y="${h-3}" text-anchor="middle">${String(d).padStart(2,'0')}日</text>`).join('')}</svg>`}
function trendPanel(){const m=monthly();return `<section class="panel"><div class="panel-head"><div><h2>${icon('chart',17)} 收支趋势</h2><p>每天的收支变化，一目了然</p></div><div class="chart-legend"><span><i class="legend-dot"></i>收入</span><span><i class="legend-dot expense"></i>支出</span></div></div><div class="chart-summary"><div><small>${periodLabel()}累计收入</small><b class="money">${yuan(m.income)}</b></div><span class="divider"></span><div><small>${periodLabel()}累计支出</small><b class="money">${yuan(m.expense)}</b></div></div>${chart()}</section>`}
function upcoming(){return state.subscriptions.filter(s=>s.active&&nextSubscriptionDue(s,today())).sort((a,b)=>nextSubscriptionDue(a,today()).localeCompare(nextSubscriptionDue(b,today())))}
function subPreview(){const subs=upcoming().slice(0,3);return `<section class="panel"><div class="panel-head"><div><h2>${icon('repeat',17)} 会员订阅</h2><p>下一次续费，提前心中有数</p></div><button class="text-btn" data-page="subscriptions">管理 ${icon('arrow',12)}</button></div><div class="sub-preview">${subs.length?subs.map(s=>`<button class="subscription-item" data-action="edit-subscription" data-id="${s.id}" style="text-align:left;padding:0">${subIcon(s)}<span class="service-info"><b>${esc(s.name)}${s.tier?`<span class="inline-tier">${esc(s.tier)}</span>`:''}</b><small>${dateLabel(nextSubscriptionDue(s,today()))}扣账 · ${esc(accountName(s.accountId))}</small></span><span class="service-price money">${esc(subscriptionMoney(s))}<small>${s.recurring?'每月':'单次'}</small></span></button>`).join(''):empty('还没有订阅','加上你的第一项会员，让账本替你记住。','add-subscription','添加订阅')}</div><div class="subscription-footer"><span>连续订阅 / 月${hasForeign()?' · 折合 CNY':''}</span><b class="money">${yuan(recurringTotal())}</b></div></section>`}
function empty(title,copy,action,label){return `<div class="empty">${icon('leaf',25)}<strong>${title}</strong><p>${copy}</p>${action?`<button class="btn btn-primary btn-sm" data-action="${action}">${icon('plus',13)} ${label}</button>`:''}</div>`}
function transactionTable(rows){return rows.length?`<div class="table-wrap"><table><thead><tr><th>收支事项</th><th>分类</th><th>账户</th><th>日期</th><th style="text-align:right">金额</th><th></th></tr></thead><tbody>${rows.map(t=>`<tr><td><div class="transaction-title"><span class="category-icon" ${t.type==='income'?'style="background:#eef4e6;color:#7d985e"':''}>${icon(categoryIcons[t.category]||'wallet',15)}</span><div><b>${esc(t.title)}</b><small>${t.subscriptionId?'订阅自动记账':t.mobileCapture?'手机通知记账':t.type==='transfer'?'账户间流转':t.note?esc(t.note.slice(0,25)):t.type==='income'?'生活的奖励':'生活的小日常'}</small></div></div></td><td><span class="category-tag">${esc(t.category)}</span></td><td class="muted">${esc(accountName(t.accountId))}${t.type==='transfer'?` → ${esc(accountName(t.toAccountId))}`:''}</td><td class="muted">${t.date.slice(5).replace('-',' / ')}</td><td class="amount-cell ${t.type==='income'?'positive':t.type==='expense'?'':'muted'}">${t.type==='income'?'+':t.type==='expense'?'−':''}${esc(formatMoney(t.amount,t.currency||accountCurrency(accountById(t.accountId))))}${t.type==='transfer'&&accountCurrency(accountById(t.accountId))!==accountCurrency(accountById(t.toAccountId))?`<small class="transaction-fx-note money">→ ${esc(formatMoney(t.toAmount,t.toCurrency||accountCurrency(accountById(t.toAccountId))))}</small>`:t.type!=='transfer'&&(t.currency||accountCurrency(accountById(t.accountId)))!=='CNY'?`<small class="transaction-fx-note money">≈ ${yuan(transactionCnyAmount(t,state))}</small>`:''}</td><td class="table-actions"><button class="icon-btn" data-action="edit-transaction" data-id="${t.id}" aria-label="编辑${esc(t.title)}">${icon('more',15)}</button></td></tr>`).join('')}</tbody></table></div>`:empty('这里还没有账单','从一杯咖啡开始，记录属于你的生活。','add-transaction','记下第一笔')}
function overview(){
 const m=monthly(),d=totals(state.transactions.filter(t=>t.date===today())),budget=state.settings.monthlyBudget;
 const pct=budget?Math.round(m.expense/budget*100):0,hasAccounts=Boolean(state.accounts.length),rows=sortedRows(monthRows()).slice(0,4),subs=upcoming().slice(0,3);
 const currentMonth=month===today().slice(0,7),monthPrefix=currentMonth?'本月':Number(month.slice(5))+' 月';
 const g=state.goals[0],goalPct=g?Math.min(100,Math.round(g.saved/g.target*100)):0;
 return `<div class="overview-heading"><div class="overview-intro"><p class="overview-kicker"><span></span>${Number(today().slice(5,7))} 月 ${Number(today().slice(8))} 日 · ${['周日','周一','周二','周三','周四','周五','周六'][new Date(today()+'T12:00:00').getDay()]}</p><h1>每一笔<span>，</span>都心中有数。</h1><p class="overview-subtitle">好好生活，慢慢积累。</p></div><div class="overview-date">${monthControl()}</div><img class="overview-art" src="/assets/illustrations/ledger-bloom.png" alt="" aria-hidden="true" width="180" height="144"></div>
 ${state.demo?demoBanner():''}
 <div class="overview-lead">
  <section class="balance-board" aria-label="资产总览">
   <div class="balance-topline"><span>${icon('wallet',18)} 当前净资产${hasForeign()?' <em class="currency-badge">折合 CNY</em>':''}</span><button class="icon-btn" data-action="privacy" aria-label="${hidden?'显示':'隐藏'}金额">${icon('eye',19)}</button></div>
   <button class="balance-value money ${amount(netWorth()).length>11?'long-balance':''}" data-page="accounts" aria-label="查看我的资产"><span>¥</span>${amount(netWorth())}${icon('arrow',27)}</button>
   <div class="balance-caption"><span>${state.accounts.length} 个账户${hasForeign()?' · 按账户汇率折算':'的当前余额'}</span><button data-page="accounts">管理账户 ${icon('right',14)}</button></div>
   <div class="balance-month"><span>${monthPrefix}收支</span><i></i><button data-page="insights">查看分析 ${icon('right',13)}</button></div>
   <div class="balance-stats"><button data-action="view-income"><span><i class="income-dot"></i>收入</span><strong class="money" style="--digits:${Math.max(10,amount(m.income).length+2)}">${yuan(m.income)}</strong><small class="${currentMonth?'money':''}">${currentMonth?'今日 '+yuan(d.income):'所选月份收入'}</small></button><button data-action="view-expense"><span><i class="expense-dot"></i>支出</span><strong class="money" style="--digits:${Math.max(10,amount(m.expense).length+2)}">${yuan(m.expense)}</strong><small class="${currentMonth?'money':''}">${currentMonth?'今日 '+yuan(d.expense):'所选月份支出'}</small></button><div><span><i class="balance-dot"></i>结余</span><strong class="money" style="--digits:${Math.max(10,amount(m.income-m.expense).length+2)}">${yuan(m.income-m.expense)}</strong><small>收入减去支出</small></div></div>
  </section>
  <section class="record-board"><div class="record-label">${icon('spark',17)} ${hasAccounts?'今日记录':'开始你的账本'}<span>${state.transactions.filter(t=>t.date===today()).length} 笔</span></div><h2>${hasAccounts?'随手记，轻松一点。':'从第一个账户开始。'}</h2>${hasAccounts?`<div class="record-today"><span>今日支出${hasForeign()?' · 折合 CNY':''}</span><strong class="money">${yuan(d.expense)}</strong></div>`:'<p>添加钱包或银行卡，填入真实余额。<br>你的财务空间就准备好了。</p>'}<button class="record-primary" data-action="${hasAccounts?'add-expense':'add-account'}"><span>${icon('plus',21)} ${hasAccounts?'记一笔支出':'添加第一个账户'}</span><i>${icon('right',18)}</i></button><div class="record-secondary"><button data-action="add-income">${icon('down',16)} 记收入</button><button data-action="add-transfer">${icon('repeat',16)} 转账</button></div><div class="record-foot">${icon('shield',12)} ${hasAccounts?'本地保存，随时与手机同步':'余额由你填写，安心开始'}</div></section>
 </div>
 <div class="overview-content">
  <section class="activity-panel"><div class="dashboard-section-head"><div><span class="section-mark coral">${icon('ledger',19)}</span><h2>最近账单</h2><span class="section-note">${monthPrefix}</span></div><button class="text-btn" data-action="view-all-transactions">全部账单 ${icon('right',14)}</button></div>${rows.length?transactionTable(rows):`<div class="activity-empty"><div class="receipt-illustration" aria-hidden="true"><span>${icon('check',20)}</span><i></i><i></i><i></i><b>HELLO, LIFE.</b></div><div><h3>${state.transactions.length?'这个月，还没有账单。':'故事，等你写下第一笔。'}</h3><p>${state.transactions.length?'可以切换月份，看看之前的记录。':'从今天开始，让钱的来去清清楚楚。'}</p><button class="text-btn" data-action="${hasAccounts?'add-transaction':'add-account'}">${hasAccounts?'记下第一笔':'先添加一个账户'} ${icon('arrow',15)}</button></div></div>`}</section>
  <section class="subscriptions-panel"><div class="dashboard-section-head"><div><span class="section-mark purple">${icon('repeat',19)}</span><h2>会员订阅</h2></div><button class="icon-btn" data-action="add-subscription" aria-label="添加订阅">${icon('plus',18)}</button></div><div class="subscriptions-total"><span>连续订阅 / 月</span><b class="money">${yuan(recurringTotal())}</b></div>${subs.length?`<div class="sub-preview">${subs.map(s=>`<button class="subscription-item" data-action="edit-subscription" data-id="${esc(s.id)}">${subIcon(s)}<span class="service-info"><b>${esc(s.name)}</b><small class="expiry-text expiry-${subscriptionExpiryStatus(s,today()).tone}" title="${esc(subscriptionExpiryStatus(s,today()).detail)}">${esc(subscriptionExpiryStatus(s,today()).label)}${s.tier?' · '+esc(s.tier):''}</small></span><span class="service-price money">${esc(subscriptionMoney(s))}</span></button>`).join('')}</div>`:`<div class="subscriptions-empty"><div class="service-orbit" aria-hidden="true">${subscriptionCatalog.slice(0,3).map(s=>`<span><img src="${esc(s.logo)}" alt="" width="23" height="23"></span>`).join('')}</div><h3>喜欢的服务，安排明白。</h3><p>添加你的会员，续费日期不再忘记。</p></div>`}<button class="subscription-manage" data-page="subscriptions">${subs.length?'管理我的订阅':'查看会员选项'} ${icon('right',14)}</button></section>
 </div>
 <div class="overview-extras"><section class="budget-strip"><div class="extra-symbol">${icon('chart',23)}</div><div class="extra-copy"><h2>${monthPrefix}预算<span class="${budget?'money':''}">${budget?(pct>100?'已超预算':'已用 '+pct+'%'):'还未设置'}</span></h2>${budget?`<p>${pct>100?'超出':'剩余'} <b class="money">${yuan(Math.abs(budget-m.expense))}</b><span class="muted"> / 预算 <span class="money">${yuan(budget)}</span></span></p><div class="progress"><span style="width:${Math.min(pct,100)}%"></span></div>`:'<p>为日常花销，留一点计划。</p>'}</div><button class="icon-btn" data-action="budget" aria-label="设置预算">${icon('arrow',17)}</button></section><section class="wish-strip"><div class="extra-symbol">${icon('goal',24)}</div><div class="extra-copy"><h2>${g?esc(g.name):'给喜欢的事，存一点。'}${g?`<span class="money">${goalPct}%</span>`:''}</h2><p>${g?`已存 <b class="money">${yuan(g.saved)}</b>`:'把下一个小心愿，慢慢变成现实。'}</p></div><button class="icon-btn" ${g?'data-page="goals"':'data-action="add-goal"'} aria-label="${g?'查看储蓄心愿':'创建储蓄目标'}">${icon(g?'arrow':'plus',17)}</button></section></div>`;
}

function filteredTransactions(){return sortedRows(monthRows()).filter(t=>(filter==='all'||t.type===filter)&&(!accountFilter||t.accountId===accountFilter||t.toAccountId===accountFilter)&&(!query||[t.title,t.note,t.category,accountName(t.accountId),t.toAccountId?accountName(t.toAccountId):''].join(' ').toLowerCase().includes(query.toLowerCase())))}
function transactions(){const rows=filteredTransactions();return heading('收支账单','收入从哪里来，支出去向哪里，全部清清楚楚。','THE STORY BEHIND EVERY NUMBER.',monthControl()+addButton())+demoBanner()+statCards()+`<div class="page-tools"><div class="segmented">${[['all','全部账单'],['expense','支出'],['income','收入'],['transfer','转账']].map(([v,l])=>`<button data-filter="${v}" class="${filter===v?'selected':''}">${l}</button>`).join('')}</div><div class="filter-row"><input class="table-search" id="transaction-search" aria-label="筛选账单" placeholder="搜索事项、银行、尾号" value="${esc(query)}"><select class="filter-select" id="account-filter" aria-label="按账户筛选"><option value="">全部账户</option>${state.accounts.map(a=>`<option value="${a.id}" ${accountFilter===a.id?'selected':''}>${esc(accountLabel(a))}</option>`).join('')}</select><button class="icon-btn" data-action="export-csv" title="导出当前账单CSV" aria-label="导出当前账单CSV">${icon('download',16)}</button></div></div><section class="panel transaction-panel" style="margin-top:0">${transactionTable(rows)}<div class="footer-count">共 ${rows.length} 笔 · ${monthLabel()}${query?' · 搜索结果':''}</div></section>`}
function accounts(){const b=balances(),cny=getCnyBalances(state,today());return heading('我的资产','统一管理银行卡、钱包、现金和负债，资产变化一眼看懂。','A HOME FOR EVERY YUAN.',`<button class="btn btn-outline" data-action="add-transfer">${icon('repeat',16)} 转移资产</button><button class="btn btn-primary" data-action="add-account">${icon('plus',16)} 添加账户</button>`)+demoBanner()+`<div class="summary-grid"><div class="summary-card"><span class="stat-icon">${icon('wallet')}</span><div><small>净资产</small><b class="money">${yuan(netWorth())}</b></div></div><div class="summary-card"><span class="stat-icon">${icon('up')}</span><div><small>正向资产</small><b class="money">${yuan(Object.values(cny).filter(v=>v>0).reduce((a,v)=>a+v,0))}</b></div></div><div class="summary-card"><span class="stat-icon orange">${icon('down')}</span><div><small>待偿还负债</small><b class="money">${yuan(-Object.values(cny).filter(v=>v<0).reduce((a,v)=>a+v,0))}</b></div></div></div>`+renderAccountLibrary({state,balances:b,cnyBalances:cny,view:accountView,expandedBanks,dealBankId:dealBank,icon,accountLogo})}
function subscriptionAccountLabel(account){return subscriptionAccountTypes.find(type=>type.id===account.type)?.label||'其他'}
function expiryBanner(status){return '<div class="expiry-banner expiry-'+status.tone+'">'+icon(status.tone==='expired'?'info':'calendar',17)+'<span><b>'+esc(status.label)+'</b><small>'+esc(status.detail)+'</small></span></div>'}
// A comparison can exceed one record's money limit (negative balance plus a full fee).
// Format that read-only difference exactly without relaxing any persisted money limits.
function subscriptionDifferenceMoney(units,code){
 const {decimals}=currencyInfo(code),exact=BigInt(units),scale=10n**BigInt(decimals);
 const whole=String(exact/scale).replace(/\B(?=(\d{3})+(?!\d))/g,','),fraction=decimals?String(exact%scale).padStart(decimals,'0'):'';
 return (code==='CNY'?'¥':code)+' '+whole+(fraction?'.'+(code==='USDT'?fraction.replace(/0+$/,''):fraction):'').replace(/\.$/,'');
}
function subscriptionPayment(accountId,fee,{editing=false,currentBalances=balances()}={}){
 const account=accountById(accountId);if(!account)return '<div class="subscription-payment"><p>请选择扣款账户后查看余额。</p></div>';
 const code=accountCurrency(account),current=currentBalances[accountId],valid=Number.isSafeInteger(fee)&&fee>0,shortfall=valid?Math.max(0,fee-current):0;
 const masked=hidden&&!editing,money=value=>'<b class="money"'+(masked?' aria-label="金额已隐藏"':'')+'>'+(masked?'••••':esc(value))+'</b>';
 const status=valid?(shortfall>0?'shortfall':'enough'):'pending';
 return '<section class="subscription-payment" data-funding="'+status+'" aria-label="扣款账户与余额"><div class="subscription-payment-heading"><span>'+icon('wallet',15)+' 扣款账户</span><small>'+code+'</small></div><div class="subscription-payment-account">'+accountLogo(account)+'<span>'+esc(accountLabel(account))+'</span></div><div class="subscription-payment-amounts"><div><span>当前账本余额</span>'+money(formatMoney(current,code))+'</div><div><span>本次费用</span>'+(valid?money(formatMoney(fee,code)):'<b class="subscription-payment-empty">待填写</b>')+'</div></div><div class="subscription-payment-result"><span>'+icon(status==='enough'?'check':'info',14)+(valid?(shortfall>0?'余额不足':'余额充足'):'填写费用后核对余额')+'</span>'+(shortfall>0?'<span>还差 '+money(subscriptionDifferenceMoney(shortfall,code))+'</span>':'')+'</div><p class="subscription-payment-note">按当前余额比较一笔费用，未预扣未来费用。</p></section>';
}
function updateSubscriptionPayment(){
 const form=$('#subscription-form'),preview=$('#subscription-payment-preview');if(!form||!preview)return;
 let fee=null;try{fee=parseMoney(form.elements.amount.value,accountCurrency(accountById(form.elements.accountId.value)))}catch{}
 preview.innerHTML=subscriptionPayment(form.elements.accountId.value,fee,{editing:true});
}
function subscriptions(){
 const active=state.subscriptions.filter(s=>s.active).length;
 const currentBalances=balances();
 const entries=state.subscriptions.map(sub=>({sub,status:subscriptionExpiryStatus(sub,today())}));
 const matches=({sub,status})=>(subscriptionFilter==='all'||subscriptionFilter==='upcoming'&&status.days!==null&&status.days>=0&&status.days<=30||subscriptionFilter==='expired'&&status.tone==='expired'||subscriptionFilter==='unset'&&status.source==='none'||subscriptionFilter==='paused'&&!sub.active)&&(!subscriptionQuery||[sub.name,sub.tier,sub.note,...(sub.linkedAccounts||[]).flatMap(a=>[a.value,a.label,subscriptionAccountLabel(a)])].join(' ').toLowerCase().includes(subscriptionQuery.toLowerCase()));
 const entriesShown=entries.filter(matches).sort((a,b)=>(a.status.date||'9999').localeCompare(b.status.date||'9999'));
 const upcoming=entries.filter(({status})=>status.days!==null&&status.days>=0&&status.days<=30).length, expired=entries.filter(({status})=>status.tone==='expired').length;
 return heading('会员订阅','账号、会员期限与每次扣账，都记在这里。','SUBSCRIBE TO A GOOD LIFE.', '<button class="btn btn-outline" data-action="calendar">'+icon('calendar',16)+' 扣账日历</button><button class="btn btn-primary" data-action="add-subscription">'+icon('plus',16)+' 添加订阅</button>')+demoBanner()+
 '<div class="summary-grid"><div class="summary-card"><span class="stat-icon">'+icon('repeat')+'</span><div><small>连续订阅 / 月'+(hasForeign()?' · 折合 CNY':'')+'</small><b class="money">'+yuan(recurringTotal())+'</b></div></div><div class="summary-card"><span class="stat-icon purple">'+icon('calendar')+'</span><div><small>连续订阅 / 年估算'+(hasForeign()?' · 折合 CNY':'')+'</small><b class="money">'+yuan(recurringTotal()*12)+'</b></div></div><div class="summary-card"><span class="stat-icon orange">'+icon('spark')+'</span><div><small>启用的订阅</small><b class="subscription-active-count">'+active+' <small>/ '+state.subscriptions.length+' 项</small></b></div></div></div>'+
 '<div class="subscription-legend" aria-label="到期状态颜色说明"><strong>到期 / 续费提醒</strong><span><i class="expiry-normal"></i>超过 30 天</span><span><i class="expiry-soon"></i>8–30 天</span><span><i class="expiry-urgent"></i>7 天内（含今天）</span><span><i class="expiry-expired"></i>已到期</span><span><i class="expiry-unset"></i>未设置日期</span></div>'+
 '<div class="subscription-tools"><div class="subscription-filters" role="group" aria-label="筛选订阅">'+[['all','全部'],['upcoming','30 天内 · '+upcoming],['expired','已到期 · '+expired],['unset','未设日期'],['paused','已暂停']].map(([value,label])=>'<button data-action="filter-subscriptions" data-value="'+value+'" class="'+(subscriptionFilter===value?'selected':'')+'" aria-pressed="'+(subscriptionFilter===value)+'">'+label+'</button>').join('')+'</div><input class="subscription-search" id="subscription-search" aria-label="搜索订阅或关联账号" placeholder="搜索订阅、邮箱或账号" value="'+esc(subscriptionQuery)+'"></div>'+
 '<p class="subscription-count">'+(state.subscriptions.length?'显示 '+entriesShown.length+' / '+state.subscriptions.length+' 项 · 按到期 / 续费日期排序':'添加第一份订阅，把关联账号和会员期限一起记好。')+'</p><div class="page-grid subscription-grid">'+entriesShown.map(({sub:s,status})=>{
  const due=nextSubscriptionDue(s,today());
  return '<section class="subscription-card '+(s.active?'':'paused')+'" data-expiry="'+status.tone+'"><div class="subscription-top">'+subIcon(s)+'<div class="subscription-top-actions">'+(!s.active?'<span class="status-pill paused">记账已暂停</span>':'')+'<button class="icon-btn" data-action="edit-subscription" data-id="'+esc(s.id)+'" aria-label="编辑'+esc(s.name)+'">'+icon('edit',16)+'</button></div></div><h3>'+esc(s.name)+'</h3>'+(s.tier?'<span class="membership-tier-badge">'+esc(s.tier)+'</span>':'')+'<div class="money">'+esc(subscriptionMoney(s))+' <small>/ '+(s.recurring?'月':'次')+'</small></div>'+expiryBanner(status)+
  subscriptionPayment(s.accountId,s.amount,{currentBalances})+
  '<div class="subscription-login-heading">关联登录账号</div><div class="linked-account-list">'+((s.linkedAccounts||[]).length?s.linkedAccounts.map(a=>'<div class="linked-account-item"><span>'+esc(subscriptionAccountLabel(a))+'</span><b>'+esc(a.value)+'</b>'+(a.label?'<small>'+esc(a.label)+'</small>':'')+'</div>').join(''):'<div class="linked-account-empty">尚未关联登录账号</div>')+'</div>'+
  '<div class="sub-details"><span>会员到期日</span><b>'+(s.expiresOn?esc(s.expiresOn):'未设置')+'</b></div><div class="sub-details"><span>下一次扣账</span><b>'+(s.active?(due?esc(due):'已完成'):'已暂停')+'</b></div>'+(s.note?'<div class="subscription-note"><span>备注</span><p>'+esc(s.note)+'</p></div>':'')+'<div class="toggle-row"><span>'+(s.recurring?'连续订阅 · 每月自动记账':'单次订阅')+'</span><button class="switch '+(s.active?'on':'')+'" role="switch" aria-checked="'+s.active+'" aria-label="'+(s.active?'暂停':'恢复')+esc(s.name)+'" data-action="toggle-subscription" data-id="'+esc(s.id)+'"></button></div></section>';
 }).join('')+'<button class="add-card" data-action="add-subscription">'+icon('plus',26)+'<span>'+(state.subscriptions.length&&!entriesShown.length?'没有匹配的订阅，添加一份':'把下一项喜欢，放进来')+'</span></button></div><div class="callout">'+icon('info',16)+'<span>会员到期日用于提醒；未填写时，连续订阅按下次扣账日提示续费。到期提醒不会自动暂停记账，续费后请更新会员到期日。自动记账只扣减账本余额，不向平台付款；暂停期间的账期恢复后不补记。</span></div>';
}

function insights(){
 const m=monthly(), rows=monthRows(), budget=state.settings.monthlyBudget;
 const pct=budget?Math.round(m.expense/budget*100):0;
 const categories=new Map();
 for(const tx of rows){
  if(tx.type!=='expense')continue;
  categories.set(tx.category,(categories.get(tx.category)||0)+transactionCnyAmount(tx,state));
 }
 const breakdown=[...categories].sort((a,b)=>b[1]-a[1]);
 const colors=['#8d7bcf','#df9c7d','#70a99e','#809ec9','#c19b55'];
 const categoryRows=breakdown.map(([name,value],index)=>{
  const share=m.expense?value/m.expense*100:0;
  const categoryIcon=Object.hasOwn(categoryIcons,name)?categoryIcons[name]:'wallet';
  return `<div><div class="category-row-head"><span>${icon(categoryIcon,14)} ${esc(name)}</span><span><b class="money">${yuan(value)}</b> <span class="muted">· ${Math.round(share)}%</span></span></div><div class="category-bar"><span style="width:${share}%;background:${colors[index%colors.length]}"></span></div></div>`;
 }).join('');
 const current=month===today().slice(0,7);
 const days=current?Number(today().slice(8)):new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate();
 return heading('收支洞察','收入怎么来，花销怎么走，都有迹可循。','',monthControl())+statCards()+`<div class="insights-grid">
  ${trendPanel()}
  <section class="panel budget-panel ${budget&&m.expense>budget?'over-budget':''}">
   <div class="panel-head"><div><h2>${icon('goal',17)} 月度预算</h2><p>${monthLabel()}</p></div></div>
   <div class="budget-ring" style="--progress:${Math.min(100,pct)}%"><div class="budget-ring-inner"><b>${budget?pct+'%':'—'}</b><small>${budget?'预算已使用':'未设置预算'}</small></div></div>
   <div class="budget-info"><div>月度预算<b class="money">${yuan(budget)}</b></div><div>${!budget?periodLabel()+'支出':m.expense>budget?'已超预算':'剩余预算'}<b class="money">${yuan(Math.abs(budget-m.expense))}</b></div></div>
   <button class="btn btn-soft budget-edit" data-action="budget">调整预算 ${icon('arrow',14)}</button>
  </section>
  <section class="panel"><div class="panel-head"><div><h2>${icon('chart',17)} 支出分类</h2><p>${periodLabel()}支出占比</p></div></div><div class="category-breakdown">${categoryRows||empty(periodLabel()+'还没有支出','记下支出后，就能看到各分类的占比。')}</div></section>
  <section class="panel"><div class="panel-head"><div><h2>${icon('ledger',17)} ${periodLabel()}小结</h2><p>按所选月份的账单计算</p></div></div>
   <div class="setting-row"><div><b>账单数量</b><p>包含收入、支出与账户转账</p></div><b>${rows.length} 笔</b></div>
   <div class="setting-row"><div><b>平均每日支出</b><p>按${current?'本月已过天数':'整月天数'}计算</p></div><b class="money">${yuan(Math.round(m.expense/days))}</b></div>
   <div class="setting-row"><div><b>结余占收入</b><p>收入扣除支出后的比例</p></div><b>${m.income?Math.round((m.income-m.expense)/m.income*100)+'%':'暂无收入'}</b></div>
  </section>
 </div>`;
}
function goals(){return heading('想要的生活，一点点靠近。','为一趟旅行、一份礼物、一个新开始，存一点期待。','SMALL STEPS. BIG DREAMS.',`<button class="btn btn-primary" data-action="add-goal">${icon('plus',16)} 新建心愿</button>`)+`<div class="goals-grid">${state.goals.map(goalCard).join('')}<button class="add-card" data-action="add-goal">${icon('goal',30)}<span>下一个心愿，是什么？</span></button></div><div class="callout">${icon('info',16)}<span>心愿金额用于记录储蓄进度，不会重复增加总资产或生成收支。实际资金流动请在「收支账单」中记账或转账。</span></div>`}
function settings(){
 return heading('账本设置','照顾好你的数据，也照顾好你的使用习惯。')+`<div class="settings-grid">
 ${desktop?desktopUpdateSettings():''}
 <section class="panel"><div class="panel-head"><h2>${icon('settings',17)} 账本偏好</h2></div>
  <div class="setting-row"><div><b>月度生活预算</b><p>给每个月的花销一点计划</p></div><button class="btn btn-soft btn-sm money" data-action="budget">${yuan(state.settings.monthlyBudget)}</button></div>
  <div class="setting-row"><div><b>金额隐私</b><p>隐藏浏览金额；编辑时正常显示</p></div><button class="switch ${hidden?'on':''}" role="switch" aria-checked="${hidden}" aria-label="隐藏金额" data-action="privacy"></button></div>
  <div class="setting-row"><div><b>汇总币种</b><p>外币按账户汇率折算，账户保留原币</p></div><span class="category-tag">CNY ¥</span></div>
  <div class="setting-row"><div><b>快捷记账</b><p>按 N 记一笔，Esc 关闭弹窗</p></div><span class="keycap">N</span></div>
 </section>
 <section class="panel"><div class="panel-head"><h2>${icon('shield',17)} 备份与恢复</h2></div>
  <div class="setting-row"><div><b>导出完整备份</b><p>含账户、收支、订阅和储蓄目标</p></div><button class="btn btn-outline btn-sm" data-action="export">${icon('download',14)} 导出</button></div>
  <div class="setting-row"><div><b>从备份恢复</b><p>导入 Money Lab JSON 格式账本</p></div><button class="btn btn-outline btn-sm" data-action="import">${icon('upload',14)} 导入</button></div>
  <div class="setting-row"><div><b>${state.demo?'开始我的账本':'新建空账本'}</b><p>${state.demo?'清除示例，开始记录自己的生活':'当前账本会先保存一份本地备份'}</p></div><button class="btn btn-soft btn-sm" data-action="start-empty">开始</button></div>
  <div class="data-care-note">${icon('check',14)} 安装更新会保留本地账本</div>
 </section>
 ${mobileSyncSettingsCard()}
 ${desktop?desktopSettings():''}
 ${exchangeRateSettings()}
 <section class="panel runtime-panel" style="grid-column:1/-1"><div class="panel-head"><h2>${icon('shield',17)} 本地数据</h2><span class="category-tag"><span class="live-dot"></span>本机运行中</span></div><p class="runtime-summary">${state.accounts.length} 个账户 <span>·</span> ${state.transactions.length} 笔账单 <span>·</span> ${state.subscriptions.length} 项订阅</p><details class="runtime-details"><summary>查看数据位置与运行说明</summary><div class="data-status">数据保存于 <b>${desktopInfo?esc(desktopInfo.dataDirectory+'\\ledger.json'):'项目目录 / data / ledger.json'}</b><br>账本修订 <b>${state.revision}</b><br>${desktop?'关闭窗口默认收起到系统托盘，后台继续记录到期订阅。完全退出或关闭电脑后，下次打开自动补记。':'关闭网页后，本地后台仍可记录到期订阅。关闭电脑或后台进程后，下次启动会自动补记。'}<br>账本保存在本机，可主动扫码与安卓手机进行局域网加密同步。公开参考汇率与应用更新需要联网；账本不会上传到云端。</div></details></section>
 </div>`;
}
function render(){if(!state)return;renderedDay=today();if(accountFilter&&!state.accounts.some(a=>a.id===accountFilter))accountFilter='';document.body.classList.toggle('amounts-hidden',hidden);$('#app').innerHTML=shell(({overview,transactions,accounts,subscriptions,insights,goals,settings}[page]||overview)());document.title=`${navItems.find(x=>x[0]===page)?.[2]||'账本设置'} · MONEY LAB`}
function navigate(next){page=next;menuOpen=false;location.hash=next;render();window.scrollTo(0,0)}
function modal(title,subtitle,body,wide=false){iconSelects?.close();mobileSync?.onModalClosed();modalFocus=document.activeElement;$('#modal-root').innerHTML=`<div class="modal-overlay"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-head"><div><h2 id="modal-title">${title}</h2><p>${subtitle}</p></div><button class="icon-btn" data-action="close-modal" aria-label="关闭">${icon('close',16)}</button></header><div class="modal-body">${body}</div></section></div>`;document.body.style.overflow='hidden';refreshFormVisuals();setTimeout(()=>($('.modal [autofocus]')||$('.modal input')||$('.modal button'))?.focus(),40)}
function closeModal(){
 iconSelects?.close();
 if(busy)return;
 const opener=modalFocus,hadModal=Boolean($('.modal'));
 // Run after a successful save's render, before the modal observer offers an update.
 queueMicrotask(()=>{
  if($('.modal')||$('.update-dialog'))return;
  if(hadModal){
   let target=opener?.isConnected?opener:opener?.id?document.getElementById(opener.id):null;
   if(!target&&opener?.dataset){const {action,page:openerPage,id}=opener.dataset;target=[...document.querySelectorAll('[data-action],[data-page]')].find(el=>action?el.dataset.action===action&&el.dataset.id===id:openerPage&&el.dataset.page===openerPage)}
   target?.focus?.({preventScroll:true});
  }
  updateUI?.flushPrompt();
 });
 mobileSync?.onModalClosed();$('#modal-root').innerHTML='';document.body.style.overflow='';if(ratesDeferredRender){ratesDeferredRender=false;render()}modalFocus?.focus?.();
}
function footer(save='保存',remove){return `<div class="form-error" role="alert"></div><div class="modal-footer">${remove?`<button type="button" class="btn btn-danger btn-sm delete-btn" data-action="${remove.action}" data-id="${remove.id}">${icon('trash',14)} 删除</button>`:''}<button type="button" class="btn btn-outline" data-action="close-modal">取消</button><button class="btn btn-primary" type="submit">${icon('check',15)} ${save}</button></div>`}
function field(label,name,value='',type='text',extra='',full=false){return `<div class="field ${full?'full':''}"><label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`}
function selectField(label,name,options,value,full=false){return `<div class="field ${full?'full':''}"><label for="field-${name}">${label}</label><select name="${name}" id="field-${name}">${options.map(o=>{const [v,l]=Array.isArray(o)?o:[o,o];return `<option value="${esc(v)}" ${v===value?'selected':''}>${esc(l)}</option>`}).join('')}</select></div>`}
function accountOptions(){return state.accounts.map(a=>[a.id,accountLabel(a)])}
function ensureAccount(){if(state.accounts.length)return true;toast('先添加一个账户，就可以开始记账了');accountModal();return false}

function accountLogo(account){
 const p=bankById(account?.bankId)||accountPreset(account),color=p?.color||account?.color||'#a498cf';
 return '<span class="account-logo" style="--account-accent:'+esc(color)+'">'+(p?.logo?'<img src="'+esc(p.logo)+'" alt="'+esc(p.name)+' Logo" width="30" height="30">':icon(p?.icon||'wallet',25))+'</span>';
}
function pickerSymbol(name='wallet',tone='lilac'){
 return '<span class="picker-symbol tone-'+esc(tone)+'" aria-hidden="true">'+icon(name,19)+'</span>';
}
function linkedAccountIcon(type){
 const logo={apple:'/assets/brands/apple.svg',google:'/assets/brands/google.svg',wechat:'/assets/brands/wechat.png',qq:'/assets/brands/qq.png'}[type];
 return logo?'<span class="picker-symbol tone-neutral" aria-hidden="true"><img src="'+logo+'" alt="" width="22" height="22"></span>':pickerSymbol({email:'mail',phone:'phone',qq:'user',other:'user'}[type]||'user','mint');
}
function describePickerOption(select,option){
 const value=option.value,name=select.name,title=option.textContent;
 if(['accountId','toAccountId'].includes(name)||select.id==='account-filter'){
  const account=accountById(value);
  if(!account)return {iconHtml:pickerSymbol('wallet'),title};
  const bank=bankById(account.bankId),preset=accountPreset(account),region=isAppleBalance(account)?appleBalanceRegion(account.appleRegion):null;
  const details=[bank?.name||preset?.name||account.type,region?.name,account.lastFour?'尾号 '+account.lastFour:'',account.appleAccount];
  if(select.form?.dataset.type==='transfer')details.push('余额 '+formatMoney(balances()[account.id],accountCurrency(account)));
  return {iconHtml:accountLogo(account),title:account.name,subtitle:[...new Set(details.filter(Boolean))].join(' · '),badge:accountCurrency(account),searchText:accountLabel(account)};
 }
 if(name==='providerId'||name==='bankId'){
  const entity=name==='bankId'?bankById(value):accountPresets.find(p=>p.id===value);
  return {iconHtml:entity?accountLogo(name==='bankId'?{bankId:value}:{providerId:value}):pickerSymbol(name==='bankId'?'bankCard':'wallet'),title,subtitle:entity?.type||'',searchText:entity?.shortName||''};
 }
 if(name==='serviceId'){
  const provider=subscriptionCatalog.find(p=>p.id===value);
  return {iconHtml:provider?subIcon({serviceId:value}):pickerSymbol('spark'),title,searchText:provider?.aliases?.join(' ')||''};
 }
 if(name==='tierPreset'){
  const serviceId=select.form?.elements.serviceId?.value,provider=subscriptionCatalog.find(p=>p.id===serviceId);
  return {iconHtml:provider?subIcon({serviceId}):pickerSymbol('spark'),title};
 }
 if(name==='currency'){
  const currency=currencyInfo(value);
  return {iconHtml:'<span class="picker-symbol tone-mint currency-symbol" aria-hidden="true">'+esc(currency.symbol)+'</span>',title:currency.name,badge:value};
 }
 if(name==='appleRegion'){
  const region=appleBalanceRegion(value);
  return {iconHtml:pickerSymbol('globe','mint'),title:region?.name||title,badge:region?.currency||''};
 }
 if(name==='category')return {iconHtml:pickerSymbol(categoryIcons[value]||'ledger',incomeCategories.includes(value)?'mint':'peach'),title};
 if(name==='icon')return {iconHtml:pickerSymbol(value),title};
 if(name==='billingDay')return {iconHtml:pickerSymbol('calendar','peach'),title:'每月 '+title};
 if(name==='rateMode')return {iconHtml:pickerSymbol(value==='auto'?'repeat':'edit','mint'),title};
 if(name==='type')return {iconHtml:pickerSymbol(({'银行卡':'bankCard','数字钱包':'wallet','现金':'cash','虚拟卡':'virtualCard','Apple 账户余额':'gift','储蓄投资':'chart','信用卡 / 负债':'bankCard'})[value]||'wallet'),title};
 if(select.dataset.linkedField==='type')return {iconHtml:linkedAccountIcon(value),title};
 if(select.id==='saved-linked-account'){
  const account=value===''?null:savedSubscriptionAccounts()[Number(value)];
  return account?{iconHtml:linkedAccountIcon(account.type),title:account.value,subtitle:[subscriptionAccountLabel(account),account.label].filter(Boolean).join(' · ')}:{iconHtml:pickerSymbol('user','mint'),title};
 }
 return {iconHtml:pickerSymbol('grid'),title};
}
const formFieldIcons={name:'edit',amount:'cash',accountId:'wallet',toAccountId:'wallet',providerId:'wallet',bankId:'bankCard',lastFour:'bankCard',currency:'globe',rateMode:'repeat',cnyRate:'chart',openingBalance:'cash',type:'grid',color:'palette',appleRegion:'globe',appleAccount:'user',category:'grid',title:'edit',date:'calendar',note:'book',toAmount:'cash',serviceId:'spark',tier:'spark',expiresOn:'bell',startDate:'calendar',billingDay:'repeat',icon:'palette',target:'goal',saved:'cash',budget:'chart',backup:'upload'};
function refreshFormVisuals(){
 iconSelects?.refresh();
 const dialog=$('.modal');if(!dialog)return;
 for(const label of dialog.querySelectorAll('label[for]')){
  if(label.querySelector('.form-field-icon'))continue;
  const control=document.getElementById(label.htmlFor);if(!control)continue;
  const name=control.dataset.linkedField?({type:'user',value:'user',label:'edit'})[control.dataset.linkedField]:formFieldIcons[control.name];
  if(name)label.insertAdjacentHTML('afterbegin','<span class="form-field-icon" aria-hidden="true">'+icon(name,14)+'</span>');
 }
 for(const title of dialog.querySelectorAll('.subscription-section-title h3')){
  if(!title.querySelector('.form-section-icon'))title.insertAdjacentHTML('afterbegin','<span class="form-section-icon" aria-hidden="true">'+icon(title.textContent.includes('到期')?'bell':'user',18)+'</span>');
 }
 const heading=$('.modal-head > div',dialog);
 if(heading&&!heading.querySelector('.form-heading-icon')){
  const form=$('form',dialog),name=({'subscription-form':'spark','account-form':'wallet','transaction-form':'ledger','goal-form':'goal','budget-form':'chart','import-form':'upload'})[form?.id];
  if(name){heading.classList.add('illustrated-form-heading');heading.insertAdjacentHTML('afterbegin','<span class="form-heading-icon" aria-hidden="true">'+icon(name,25)+'</span>');}
 }
}
function updateAccountCurrency({request=false}={}){
 const form=$('#account-form');if(!form)return;
 const code=form.elements.currency.value,info=currencyInfo(code),foreign=code!=='CNY',rate=form.elements.cnyRate,mode=form.elements.rateMode.value,previousCode=form.dataset.currency,previousMode=form.dataset.rateMode;
 let drafts=manualRateDrafts.get(form);if(!drafts){drafts={};manualRateDrafts.set(form,drafts)}
 if(previousMode==='manual')drafts[previousCode]=rate.value;
 if(previousCode!==code){rate.value='';form.dataset.rateChecked='';}
 if(mode==='manual'&&(previousMode!=='manual'||previousCode!==code)&&Object.hasOwn(drafts,code))rate.value=drafts[code];
 form.dataset.currency=code;form.dataset.rateMode=mode;
 const existing=accountById(form.dataset.id),saved=existing&&accountCurrency(existing)===code?existing:null,quote=cachedRate(code),useQuote=quote&&(!saved?.rateAsOf||!quote.asOf||quote.asOf>=saved.rateAsOf);
 if(foreign&&mode==='auto')rate.value=useQuote?quote.cnyRate:saved?.cnyRate||'';
 $('#account-rate-mode-field').hidden=!foreign;form.elements.rateMode.disabled=!foreign;
 $('#account-rate-field').hidden=!foreign;rate.disabled=!foreign;rate.required=foreign;rate.readOnly=foreign&&mode==='auto';
 $('.currency-fields',form).classList.toggle('is-cny',!foreign);
 $('#account-rate-field label').textContent=`${mode==='auto'?'自动参考汇率':'手动汇率'} · 1 ${code} = 多少 CNY`;
 rate.placeholder=mode==='auto'?'等待获取可用汇率':'填写折合人民币的金额';
 const status=$('#account-rate-status');status.hidden=!foreign;
 const updating=rateIsRefreshing()||Boolean(ratesStatusPromise);
 const source=useQuote?quote:saved;
 let message='';
 if(mode==='manual')message='自动更新不会覆盖此账户；按你的实际兑换或估值汇率填写。';
 else if(rate.value)message=`${source?.source||source?.rateSource||'已保存的参考汇率'}${source?.asOf||source?.rateAsOf?' · '+(source.asOf||source.rateAsOf):''}${updating?' · 正在检查更新':useQuote?' · 每日自动更新':' · 暂沿用已保存汇率'}`;
 else message=updating?'正在获取公开汇率，稍等一下…':'尚无可用汇率。可以重新更新，或切换「手动填写」后继续。';
 const relevantError=rateStatus?.errors?.[code==='USDT'?'usdt':'fiat']||ratesError;
 if(mode==='auto'&&relevantError&&!updating)message+=' 本次更新未完成，已保存的汇率继续可用。';
 $('.fx-account-status-text',status).textContent=message;
 const refreshButton=$('[data-action="refresh-rates"]',status);refreshButton.hidden=mode==='manual';refreshButton.disabled=updating||busy;refreshButton.innerHTML=icon('repeat',13)+(updating?' 更新中…':' 更新汇率');
 status.classList.toggle('has-error',mode==='auto'&&!updating&&(!rate.value||Boolean(relevantError)));
 const blocked=foreign&&mode==='auto'&&!rate.value;form.dataset.rateBlocked=String(blocked);
 const submit=$('button[type="submit"]',form);if(submit)submit.disabled=busy||blocked||rateIsRefreshing();
 $('#account-currency-hint').textContent=(foreign?'汇率只影响人民币估值，不会改写历史收支。':'默认人民币，汇率为 1。')+(info.decimals===0?'此币种按整数记录。':`最多支持 ${info.decimals} 位小数。`)+(rateIsRefreshing()?'正在更新汇率，完成后即可保存。':'');
 $('#account-form label[for="field-openingBalance"]').textContent=`${form.dataset.id?'期初余额':'当前余额'}（${code} · ${info.name}）`;
 if(request&&foreign&&mode==='auto')void ensureAccountRate(form);
}
function updateTransactionCurrency(){
 const form=$('#transaction-form');if(!form)return;
 const account=accountById(form.elements.accountId.value),code=accountCurrency(account),changed=form.dataset.currency!==code;
 if(changed){form.elements.amount.value='';if(form.elements.toAmount)form.elements.toAmount.value='';form.dataset.transferAmount='';}
 if(form.dataset.accountId!==account?.id)form.elements.cnyRate.value=code==='CNY'?'1':currencyRate(account);
 form.dataset.accountId=account?.id||'';
 form.dataset.currency=code;
 const foreign=code!=='CNY';$('#transaction-rate-field').hidden=!foreign;form.elements.cnyRate.disabled=!foreign;form.elements.cnyRate.required=foreign;
 $('#transaction-rate-field label').textContent=`本笔折算汇率 · 1 ${code} = 多少 CNY`;
 $('#transaction-form label[for="field-amount"]').textContent=`${form.dataset.type==='transfer'?'转出':'本次'}金额（${code}）`;
 const decimals=currencyInfo(code).decimals;form.elements.amount.placeholder=decimals===0?'填写整数金额':`最多 ${decimals} 位小数`;
}
function updateSubscriptionCurrency(){
 const form=$('#subscription-form');if(!form)return;
 const code=accountCurrency(accountById(form.elements.accountId.value));
 if(form.dataset.currency&&form.dataset.currency!==code)form.elements.amount.value='';
 form.dataset.currency=code;
 $('#subscription-form label[for="field-amount"]').textContent=`每次费用（${code} · ${currencyInfo(code).name}）`;
 form.elements.amount.placeholder=currencyInfo(code).decimals===0?'填写实际扣款整数金额':'填写实际扣款金额';
 updateSubscriptionPayment();
}
function accountModal(id,preferredBankId){
 const a=state.accounts.find(x=>x.id===id),p=accountPreset(a),providerId=a?.providerId||p?.id||'',code=accountCurrency(a);
 const bank=bankById(a?.bankId),bankOptions=[['','其他银行 / 暂不选择'],...bankCatalog.map(b=>[b.id,b.name])];
 const locked=Boolean(a&&(state.transactions.some(t=>t.accountId===id||t.toAccountId===id)||state.subscriptions.some(s=>s.accountId===id)));
 if(a?.bankId&&!bank)bankOptions.push([a.bankId,'已保存的自定义银行']);
 const types=[...new Set(['数字钱包','银行卡','现金','虚拟卡','Apple 账户余额','储蓄投资','信用卡 / 负债','其他账户',a?.type].filter(Boolean))];
 const options=[['','其他 / 自定义账户'],...accountPresets.map(p=>[p.id,p.name])];
 if(providerId&&!accountPresets.some(p=>p.id===providerId))options.push([providerId,a.name+'（自定义）']);
 modal(a?'管理这个账户':bankById(preferredBankId)?'添加'+bankById(preferredBankId).name+'银行卡':'添加一个账户','选好账户和币种，填入自己的实际余额。',
 `<form id="account-form" data-id="${id||''}" data-preset="${esc(providerId)}" data-currency="${code}" data-currency-locked="${locked}" data-suggested-name="${esc(bank?.name||p?.name||'')}">
 <div class="account-shortcuts">${accountPresets.map(p=>`<button type="button" class="account-choice ${providerId===p.id?'selected':''}" data-action="choose-account" data-id="${p.id}" aria-pressed="${providerId===p.id}">${accountLogo({providerId:p.id,color:p.color})}<span>${p.name}</span></button>`).join('')}</div>
 <div class="form-grid">${selectField('账户选项','providerId',options,providerId,true)}
 <section class="bank-fields field full" id="bank-fields" hidden><div class="bank-section-head"><b>给这张卡一个专属标记</b><span>银行 + 尾号，一眼认出</span></div><div class="bank-shortcuts">${bankCatalog.slice(0,4).map(b=>`<button type="button" class="bank-choice" data-action="choose-bank" data-id="${esc(b.id)}" aria-pressed="false">${accountLogo({bankId:b.id})}<span>${esc(b.shortName)}</span></button>`).join('')}</div><div class="bank-details-grid">${selectField('所属银行','bankId',bankOptions,a?.bankId||'')}${field('卡片尾号 · 可不填','lastFour',a?.lastFour||'','text','inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" placeholder="最后 4 位，如 0088"')}</div><p class="hint">只记录尾号，方便区分同一银行的多张卡。</p></section>
 ${appleBalanceFields(a)}
 ${field('账户名称','name',a?.name||'','text','required maxlength="60" placeholder="选择后自动填写，也可改成自己的名称"',true)}
 <section class="currency-fields field full">${selectField('账户币种','currency',currencyCatalog.map(c=>[c.code,c.code+' · '+c.name]),code)}<div class="field" id="account-rate-mode-field"><label for="field-rateMode">汇率方式</label><select id="field-rateMode" name="rateMode"><option value="auto" ${a?.rateMode!=='manual'?'selected':''}>每日自动更新</option><option value="manual" ${a?.rateMode==='manual'?'selected':''}>手动填写</option></select></div><div class="field full" id="account-rate-field"><label for="field-cnyRate">折算汇率</label><input id="field-cnyRate" name="cnyRate" value="${esc(a?.cnyRate||'')}" inputmode="decimal" maxlength="30" placeholder="填写折合人民币的金额"></div><div class="fx-account-status" id="account-rate-status" role="status"><span class="fx-account-status-text"></span><button type="button" class="btn btn-outline btn-sm fx-refresh-btn" data-action="refresh-rates">${icon('repeat',13)} 更新汇率</button></div><p class="currency-hint" id="account-currency-hint"></p>${locked?'<p class="currency-hint">此账户已有账单或订阅，币种已固定；需要其他币种可新建账户。</p>':''}</section>
 <div class="field full account-balance-field"><label for="field-openingBalance">${a?'期初余额':'当前余额'}（${code}）</label><input class="amount-input" id="field-openingBalance" name="openingBalance" value="${a?amountInput(a.openingBalance,code):''}" placeholder="填写你的实际余额" inputmode="decimal" required><p class="hint">${a?'调整期初余额会更新当前余额，已有账单保持不变。':'按所选币种填写余额，之后的收支会自动更新。'} 负债可以填写负数。</p></div>
 <div class="field" id="account-type-field" ${p?'hidden':''}><label for="field-type">账户类别</label><select name="type" id="field-type">${types.map(t=>`<option value="${esc(t)}" ${t===(a?.type||'其他账户')?'selected':''}>${esc(t)}</option>`).join('')}</select></div>
 ${field('账户标记色','color',a?.color||p?.color||'#a498cf','color','',Boolean(p))}</div>${footer(a?'保存账户':'添加账户',a?{action:'delete-account',id:a.id}:null)}</form>`);
 updateBankFields();updateAppleBalanceFields({request:true});
 if(!a&&bankById(preferredBankId)){chooseAccountPreset('bank-card');chooseBank(preferredBankId);$('#account-form').dataset.bankContext=preferredBankId;}
}

function appleBalanceFields(account){
 const code=accountCurrency(account),locked=Boolean(account&&(state.transactions.some(t=>t.accountId===account.id||t.toAccountId===account.id)||state.subscriptions.some(s=>s.accountId===account.id)));
 return '<section class="apple-balance-fields field full" id="apple-balance-fields" hidden><div class="apple-balance-heading"><span>'+icon('gift',21)+'</span><div><h3>Apple 账户 / 礼品卡余额</h3><p>按国家地区和 Apple 账号分开记录</p></div></div><div class="apple-region-shortcuts">'+['US','JP','TR','CN'].map(id=>{const r=appleBalanceRegion(id);return '<button type="button" class="apple-region-choice" data-action="choose-apple-region" data-region="'+id+'" '+(locked&&code!==r.currency?'disabled':'')+'>'+esc(r.name)+'<small>'+r.currency+'</small></button>'}).join('')+'</div><div class="apple-balance-grid"><div class="field"><label for="field-appleRegion">国家或地区</label><select id="field-appleRegion" name="appleRegion">'+appleBalanceRegions.map(r=>'<option value="'+r.id+'" '+((account?.appleRegion||'US')===r.id?'selected':'')+' '+(locked&&r.currency&&r.currency!==code?'disabled':'')+'>'+esc(r.name)+(r.currency?' · '+r.currency:'')+'</option>').join('')+'</select></div>'+field('关联 Apple 账号 · 可选','appleAccount',account?.appleAccount||'','text','maxlength="160" autocomplete="off" placeholder="Apple 账号邮箱或账号标注"')+'</div><p id="apple-region-hint" class="hint"></p><p class="hint">填写已充值到该 Apple 账号的实际余额。不同地区分别建账；充值可记录为转入，会员扣费可选择此账户。</p></section>';
}
function updateAppleBalanceFields({request=false}={}){
 const form=$('#account-form');if(!form)return;
 const enabled=form.elements.providerId.value==='apple-balance',locked=form.dataset.currencyLocked==='true',regionSelect=form.elements.appleRegion;
 $('#apple-balance-fields').hidden=!enabled;regionSelect.disabled=!enabled;regionSelect.required=enabled;form.elements.appleAccount.disabled=!enabled;
 let region=appleBalanceRegion(regionSelect.value);
 if(enabled&&locked&&region?.currency&&region.currency!==form.elements.currency.value){regionSelect.value=appleBalanceRegions.find(r=>r.currency===form.elements.currency.value)?.id||'OTHER';region=appleBalanceRegion(regionSelect.value);}
 if(enabled&&region?.currency&&form.elements.currency.value!==region.currency){
  form.elements.currency.value=region.currency;
  if(form.elements.openingBalance.value){form.elements.openingBalance.value='';toast('币种已切换为 '+region.currency+'，请重新填写余额');}
 }
 form.elements.currency.disabled=locked||Boolean(enabled&&region?.currency);
 form.querySelectorAll('.apple-region-choice').forEach(button=>{const selected=button.dataset.region===regionSelect.value;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
 $('#apple-region-hint').textContent=enabled?(region?.currency?'此地区使用 '+region.currency+' · '+currencyInfo(region.currency).name+'。'+(locked?'此账户已有账单或订阅，其他币种的地区请新建账户。':'切换到不同币种的地区时，需要重新填写余额。'):'请按实际地区选择账户币种，并在账户名称中标明国家或地区。'):'';
 const hint=$('.account-balance-field .hint',form);
 hint.textContent=enabled?(form.dataset.id?'这里是期初余额，调整后会与已有收支一起计算当前余额。后续充值请使用转账或收入记录。':'按所选国家或地区的币种填写当前 Apple 账户余额，不会自动向 Apple 查询或充值。'):(form.dataset.id?'调整期初余额会更新当前余额，已有账单保持不变。负债可以填写负数。':'按所选币种填写余额，之后的收支会自动更新。负债可以填写负数。');
 updateAccountCurrency({request});
 if(enabled)$('#account-form label[for="field-openingBalance"]').textContent=(form.dataset.id?'期初 Apple 余额':'Apple 账户当前余额')+'（'+form.elements.currency.value+' · '+currencyInfo(form.elements.currency.value).name+'）';
}
function chooseAppleRegion(regionId){const form=$('#account-form');if(!form)return;const option=[...form.elements.appleRegion.options].find(o=>o.value===regionId);if(!option||option.disabled)return;form.elements.appleRegion.value=regionId;updateAppleBalanceFields({request:true});}
function isCardType(providerId,type){return ['bank-card','virtual-card'].includes(providerId)||/银行卡|储蓄卡|信用卡|虚拟卡/.test(type||'');}
function updateBankFields(){
 const form=$('#account-form');if(!form)return;
 const enabled=isCardType(form.elements.providerId.value,form.elements.type.value);
 $('#bank-fields').hidden=!enabled;form.elements.bankId.disabled=!enabled;form.elements.lastFour.disabled=!enabled;
 form.querySelectorAll('.bank-choice').forEach(b=>{const selected=b.dataset.id===form.elements.bankId.value;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});
}
function chooseBank(bankId){
 const form=$('#account-form');if(!form)return;
 const bank=bankById(bankId),p=accountPresets.find(p=>p.id===form.elements.providerId.value),suggested=bank?.name||p?.name||'银行卡';
 if(!form.elements.name.value.trim()||form.elements.name.value===form.dataset.suggestedName)form.elements.name.value=suggested;
 form.dataset.suggestedName=suggested;form.elements.bankId.value=bankId;
 if(bank||p)form.elements.color.value=bank?.color||p.color;
 updateBankFields();
}
function chooseAccountPreset(providerId){
 const form=$('#account-form');if(!form)return;
 const p=accountPresets.find(p=>p.id===providerId),previous=accountPresets.find(p=>p.id===form.dataset.preset);
 form.elements.providerId.value=providerId;form.dataset.preset=providerId;
 const bank=isCardType(providerId,p?.type)?bankById(form.elements.bankId.value):undefined,suggested=bank?.name||p?.name||'';
 if(p){if(!form.elements.name.value.trim()||form.elements.name.value===form.dataset.suggestedName)form.elements.name.value=suggested;form.elements.type.value=p.type;form.elements.color.value=bank?.color||p.color;}
 else if(previous&&form.elements.type.value===previous.type)form.elements.type.value='其他账户';
 form.dataset.suggestedName=suggested;
 $('#account-type-field').hidden=Boolean(p);form.elements.color.closest('.field').classList.toggle('full',Boolean(p));
 form.querySelectorAll('.account-choice').forEach(b=>{const selected=b.dataset.id===providerId;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});
 updateBankFields();updateAppleBalanceFields({request:true});
}
function updateTransferPreview(preferredTarget){
 const form=$('#transaction-form');if(!form)return;
 updateTransactionCurrency();if(form.dataset.type!=='transfer')return;
 const from=accountById(form.elements.accountId.value),previous=typeof preferredTarget==='string'?preferredTarget:form.elements.toAccountId.value;
 const targets=state.accounts.filter(a=>a.id!==from?.id),b=balances();
 form.elements.toAccountId.innerHTML=targets.map(a=>`<option value="${esc(a.id)}">${esc(accountLabel(a))} · ${esc(formatMoney(b[a.id],accountCurrency(a)))}</option>`).join('');
 if(targets.some(a=>a.id===previous))form.elements.toAccountId.value=previous;
 form.dataset.transferTarget=form.elements.toAccountId.value;
 const to=targets.find(a=>a.id===form.elements.toAccountId.value),preview=$('#transfer-preview');if(!from||!to||!preview)return;
 const toCode=accountCurrency(to),cross=accountCurrency(from)!==toCode;
 if(form.dataset.toCurrency!==toCode)form.elements.toAmount.value='';
 form.dataset.toCurrency=toCode;
 $('#transfer-receive-field').hidden=!cross;form.elements.toAmount.disabled=!cross;form.elements.toAmount.required=cross;
 $('#transfer-receive-field label').textContent=`实际到账金额（${toCode}）`;
 form.elements.toAmount.placeholder=currencyInfo(toCode).decimals===0?'填写实际到账整数金额':'填写实际收到的金额';
 const block=(a,label)=>`<div class="transfer-account">${accountLogo(a)}<div><small>${label}</small><b>${esc(accountLabel(a))}</b><span>当前余额 ${esc(formatMoney(b[a.id],accountCurrency(a)))}</span></div></div>`;
 preview.innerHTML=block(from,'转出账户')+`<span class="transfer-arrow">${icon('right',20)}</span>`+block(to,'转入账户');
}

function transactionModal(id,type){
 if(!ensureAccount())return;
 const tx=state.transactions.find(t=>t.id===id);type=type||tx?.type||'expense';
 if(type==='transfer'&&state.accounts.length<2){modal('先添加一个转入账户','转移资产需要至少两个账户。',`<div class="transfer-empty">${icon('repeat',32)}<p>再添加一张银行卡、微信、支付宝或虚拟卡，就能在自己的账户之间转移资金。</p></div><div class="modal-footer"><button class="btn btn-outline" data-action="close-modal">稍后再说</button><button class="btn btn-primary" data-action="add-account">${icon('plus',15)} 添加另一个账户</button></div>`);return;}
 const cats=type==='income'?[...incomeCategories]:type==='transfer'?['账户转账']:[...expenseCategories];
 if(tx?.category&&!cats.includes(tx.category)&&type===tx.type)cats.push(tx.category);
 const from=tx?.accountId||state.accounts[0].id,to=tx?.toAccountId||state.accounts.find(a=>a.id!==from)?.id,b=balances(),fromAccount=accountById(from),code=accountCurrency(fromAccount),toCode=accountCurrency(accountById(to));
 const transferOptions=state.accounts.map(a=>[a.id,accountLabel(a)+' · '+formatMoney(b[a.id],accountCurrency(a))]);
 modal(tx?'编辑这笔记录':type==='transfer'?'转移资产':'记下这一刻',type==='transfer'?'跨币种时，分别记录转出和实际到账金额。':'金额使用所选账户的币种。',
 `<form id="transaction-form" data-id="${id||''}" data-type="${type}" data-account-id="${esc(from)}" data-currency="${code}" data-to-currency="${toCode}"><div class="segmented">${[['expense','支出'],['income','收入'],['transfer','转移资产']].map(([v,l])=>`<button type="button" data-action="transaction-type" data-type="${v}" data-id="${id||''}" class="${type===v?'selected':''}">${l}</button>`).join('')}</div>
 <div class="form-grid">${type==='transfer'?selectField('转出账户','accountId',transferOptions,from)+selectField('转入账户','toAccountId',transferOptions.filter(o=>o[0]!==from),to)+'<div class="transfer-route field full" id="transfer-preview"></div>':selectField('记账账户','accountId',accountOptions(),from,true)}
 <div class="field full"><label for="field-amount">${type==='transfer'?'转出':'本次'}金额（${code}）</label><input class="amount-input" id="field-amount" name="amount" inputmode="decimal" value="${tx?amountInput(tx.amount,tx.currency||code):''}" required autofocus></div>
 ${type==='transfer'?`<div class="field full transfer-receive-field" id="transfer-receive-field"><label for="field-toAmount">实际到账金额（${toCode}）</label><input id="field-toAmount" name="toAmount" inputmode="decimal" value="${tx?.toAmount?amountInput(tx.toAmount,tx.toCurrency||toCode):''}"><p class="hint">按转入账户币种填写，包含兑换或手续费后实际到账的金额。</p></div>`:''}
 <div class="field full" id="transaction-rate-field"><label for="field-cnyRate">本笔折算汇率</label><input id="field-cnyRate" name="cnyRate" inputmode="decimal" maxlength="30" value="${esc(tx?.cnyRate||currencyRate(fromAccount))}"><p class="hint">随这笔记录保存，今后调整账户汇率不会改写历史收支。</p></div>
 ${field(type==='transfer'?'转移说明':'这笔钱的故事','title',tx?.title||(type==='transfer'?'账户间转移':''),'text','required maxlength="120" placeholder="给这笔记录起个名字"',true)}
 ${type==='transfer'?'':selectField('收支分类','category',cats,tx?.type===type?tx.category:cats[0],true)}
 ${field('发生日期','date',tx?.date||today(),'date','required max="'+today()+'" min="1900-01-01"',true)}
 <div class="field full"><label for="field-note">备注 · 可不填</label><textarea id="field-note" name="note" maxlength="2000" placeholder="记住这一笔背后的事">${esc(tx?.note||'')}</textarea></div></div>${footer(tx?'保存修改':type==='transfer'?'确认转移':'记好了',tx?{action:'delete-transaction',id:tx.id}:null)}<p class="kbd-note">${icon('shield',11)} ${type==='transfer'?'仅调整账本余额，不计入收入支出，也不发起真实转账。':'原币记账，收支汇总按本笔汇率折合人民币。'}</p></form>`);
 updateTransferPreview();
}

function providerFor(sub){return subscriptionCatalog.find(p=>p.id===sub?.serviceId)||subscriptionCatalog.find(p=>[p.name,...(p.aliases||[])].some(n=>n.toLowerCase()===(sub?.name||'').toLowerCase()));}
function subIcon(s){const p=providerFor(s);return p?`<span class="service-logo" data-service="${esc(p.id)}"><img src="${esc(p.logo)}" alt="${esc(p.name)} Logo" width="28" height="28"></span>`:`<span class="service-icon" style="background:${esc(s.color)}">${icons[s.icon]?icon(s.icon,19):esc(s.icon.slice(0,2))}</span>`;}
function savedSubscriptionAccounts(){
 const saved=new Map();for(const sub of state.subscriptions)for(const account of sub.linkedAccounts||[])saved.set(JSON.stringify([account.type,account.value,account.label||'']),account);return [...saved.values()];
}
function linkedAccountRow(account={type:'email',value:'',label:''}){
 const key=uid('link');
 return '<div class="linked-account-row" data-key="'+key+'"><div class="linked-account-fields"><div class="field"><label for="'+key+'-type">账号类型</label><select data-linked-field="type" id="'+key+'-type">'+subscriptionAccountTypes.map(type=>'<option value="'+type.id+'" '+(type.id===account.type?'selected':'')+'>'+type.label+'</option>').join('')+'</select></div><div class="field"><label for="'+key+'-value">关联账号</label><input data-linked-field="value" id="'+key+'-value" type="'+(account.type==='email'?'email':'text')+'" required maxlength="160" value="'+esc(account.value)+'" placeholder="邮箱地址 / 账号 / 手机号" autocomplete="off"></div><div class="field"><label for="'+key+'-label">标注 · 可选</label><input data-linked-field="label" id="'+key+'-label" maxlength="40" value="'+esc(account.label||'')+'" placeholder="如主账号、美区"></div></div><button type="button" class="icon-btn" data-action="remove-linked-account" aria-label="移除这个关联账号">'+icon('trash',15)+'</button></div>';
}
function updateLinkedAccountEditor(){
 const editor=$('#linked-accounts-editor');if(!editor)return;const count=editor.querySelectorAll('.linked-account-row').length;
 $('#linked-account-empty').hidden=count>0;$('#add-linked-account').disabled=count>=10;$('#saved-linked-account').disabled=count>=10;
}
function addLinkedAccount(account){
 const editor=$('#linked-accounts-editor');if(!editor||editor.querySelectorAll('.linked-account-row').length>=10)return;
 editor.insertAdjacentHTML('beforeend',linkedAccountRow(account));updateLinkedAccountEditor();editor.lastElementChild.querySelector('[data-linked-field="value"]').focus();
}
function readLinkedAccounts(){
 const seen=new Set();return [...document.querySelectorAll('#linked-accounts-editor .linked-account-row')].map(row=>{
  const read=field=>row.querySelector('[data-linked-field="'+field+'"]').value.trim(),account={type:read('type'),value:read('value')};if(read('label'))account.label=read('label');
  if(!account.value)throw new Error('请填写关联账号，或移除不需要的空白行');
  const key=JSON.stringify([account.type,account.value]);if(seen.has(key))throw new Error('同一种类型的关联账号重复了，请保留一项');seen.add(key);return account;
 });
}
function updateSubscriptionExpiryPreview(){
 const form=$('#subscription-form');if(!form)return;const old=state.subscriptions.find(s=>s.id===form.dataset.id);
 const sub={...old,id:old?.id||'preview',expiresOn:form.elements.expiresOn.value,startDate:form.elements.startDate.value,billingDay:Number(form.elements.billingDay.value),recurring:form.elements.recurring.checked,active:old?.active??true,processedOccurrences:old?.processedOccurrences||[]};
 form.elements.expiresOn.min=sub.startDate||'1900-01-01';form.elements.billingDay.disabled=!sub.recurring;
 const preview=$('#subscription-expiry-preview');
 if(sub.expiresOn&&sub.startDate&&sub.expiresOn<sub.startDate){preview.textContent='会员到期日不能早于首次扣账日期';return;}
 try{preview.innerHTML=expiryBanner(subscriptionExpiryStatus(sub,today()))}catch{preview.textContent='选择日期后显示到期提醒';}
}
function subscriptionModal(id){
 if(!ensureAccount())return;
 const s=state.subscriptions.find(x=>x.id===id),provider=providerFor(s),serviceId=s?.serviceId||provider?.id||'',saved=savedSubscriptionAccounts();
 modal(s?'管理这份会员':'添加你的会员订阅','把服务、关联账号和到期时间一起记好。',
 '<form id="subscription-form" data-id="'+(id||'')+'"><div class="membership-shortcuts">'+subscriptionCatalog.map(p=>'<button type="button" class="membership-choice '+(serviceId===p.id?'selected':'')+'" data-action="choose-service" data-id="'+esc(p.id)+'"><img src="'+esc(p.logo)+'" alt="" width="25" height="25"><span>'+esc(p.name)+'</span></button>').join('')+'</div><div class="form-grid">'+
 selectField('选择会员服务','serviceId',[['','其他服务 / 自定义'],...subscriptionCatalog.map(p=>[p.id,p.name])],serviceId,true)+field('订阅名称','name',s?.name||'','text','required maxlength="80" placeholder="选择服务后自动填写，也可以自定义"',true)+
 '<div class="field full"><label for="field-tier">会员档位 · 可选择，也可自行填写</label><div class="tier-picker-row"><select id="membership-tier-select" name="tierPreset" aria-label="已有会员档位"><option value="">自定义档位 / 选择已有档位</option>'+(provider?.tiers||[]).map(t=>'<option value="'+esc(t)+'" '+(s?.tier===t?'selected':'')+'>'+esc(t)+'</option>').join('')+'</select><input id="field-tier" name="tier" list="membership-tiers" value="'+esc(s?.tier||'')+'" maxlength="80" placeholder="也可以直接填写档位" autocomplete="off"></div><datalist id="membership-tiers">'+(provider?.tiers||[]).map(t=>'<option value="'+esc(t)+'"></option>').join('')+'</datalist><p class="hint" id="membership-tier-hint">先选一个服务查看档位，或直接输入你的会员档位。</p></div>'+
 '<section class="subscription-section field full"><div class="subscription-section-title"><h3>关联登录账号</h3><p>填写使用会员的邮箱、Apple 账号等；费用从下方所选的扣款账户记账。</p></div><div id="linked-accounts-editor">'+(s?.linkedAccounts||[]).map(linkedAccountRow).join('')+'</div><p class="linked-account-empty" id="linked-account-empty">可选填写，最多关联 10 个账号。</p><div class="linked-account-actions"><select id="saved-linked-account" aria-label="选择已保存的关联账号"><option value="">'+(saved.length?'选择已保存的账号…':'暂无已保存账号')+'</option>'+saved.map((a,i)=>'<option value="'+i+'">'+esc(subscriptionAccountLabel(a)+' · '+a.value+(a.label?' · '+a.label:''))+'</option>').join('')+'</select><button type="button" id="add-linked-account" class="btn btn-outline btn-sm" data-action="add-linked-account">'+icon('plus',14)+' 添加关联账号</button></div></section>'+
 '<section class="subscription-section field full"><div class="subscription-section-title"><h3>会员到期提醒</h3><p>填写平台显示的会员到期日，自动标注剩余天数和颜色。</p></div>'+field('会员到期日 · 可不填','expiresOn',s?.expiresOn||'','date','min="1900-01-01" max="2199-12-31"')+'<div class="subscription-expiry-preview" id="subscription-expiry-preview" aria-live="polite"></div><p class="hint">未填写时，连续订阅按下次扣账日提示续费。此日期只用于提醒；续费后请更新，停止记账请关闭订阅开关。</p></section>'+
 field('每次费用','amount',s?amountInput(s.amount,s.currency||accountCurrency(accountById(s.accountId))):'','text','required inputmode="decimal" placeholder="填写实际扣款金额"')+selectField('扣款账户','accountId',accountOptions(),s?.accountId||state.accounts[0].id)+
 '<div class="field full" id="subscription-payment-preview" aria-live="polite"></div><p class="field full currency-hint">费用按扣款账户币种填写；更换不同币种账户后请重填金额。自动记账保留每笔汇率。</p>'+field('首次扣账日期','startDate',s?.startDate||today(),'date','required min="1900-01-01" max="2198-12-31"')+selectField('每月扣账日','billingDay',Array.from({length:31},(_,i)=>[String(i+1),(i+1)+' 日']),String(s?.billingDay||Number(today().slice(8))))+
 '<label class="checkbox-field field full"><input type="checkbox" name="recurring" '+(!s||s.recurring?'checked':'')+'><span>连续订阅，每月自动记账<small>取消勾选则只在首次日期记录一次</small></span></label>'+selectField('自定义服务图标','icon',[['music','音乐'],['play','视频'],['cloud','云存储'],['spark','AI / 创作'],['book','学习'],['repeat','其他']],s?.icon||'spark')+field('自定义标记色','color',s?.color||'#a498cf','color')+
 '<div class="field full subscription-note-field"><label for="field-note">订阅备注 · 可不填</label><textarea id="field-note" name="note" maxlength="500" placeholder="如购买渠道、共享成员、续费注意事项">'+esc(s?.note||'')+'</textarea></div><div class="field full"><p class="hint">选择过去日期会补记未处理账期；29–31 日在短月按月末记账。这里记录费用，不会向平台购买或续费。</p></div></div>'+footer(s?'保存订阅':'添加订阅',s?{action:'delete-subscription',id:s.id}:null)+'</form>',true);
 updateSubscriptionCurrency();updateLinkedAccountEditor();updateSubscriptionExpiryPreview();
}

function chooseSubscriptionService(id){
 const p=subscriptionCatalog.find(x=>x.id===id), form=$('#subscription-form');if(!form)return;
 form.elements.serviceId.value=p?.id||'';
 if(p){form.elements.name.value=p.name;form.elements.color.value=p.color||'#a498cf';form.elements.icon.value=['chatgpt','claude','gemini','grok'].includes(p.id)?'spark':['baidu','icloud'].includes(p.id)?'cloud':['kugou','netease','suno'].includes(p.id)?'music':'play';}
 form.elements.tier.value='';
 form.elements.tierPreset.innerHTML='<option value="">自定义档位 / 选择已有档位</option>'+(p?.tiers||[]).map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
 $('#membership-tiers').innerHTML=(p?.tiers||[]).map(t=>`<option value="${esc(t)}"></option>`).join('');
 $('#membership-tier-hint').textContent=p?'已有档位可直接下拉选取；也可以填写地区专属或自定义套餐名称。':'可以输入任意会员档位。';
 form.querySelectorAll('.membership-choice').forEach(b=>b.classList.toggle('selected',b.dataset.id===p?.id));
}

function goalModal(id){const g=state.goals.find(x=>x.id===id);modal(g?'离心愿，又近了一点':'给未来一个小期待','把想做的事，变成看得见的进度。',`<form id="goal-form" data-id="${id||''}"><div class="form-grid">${field('心愿名称','name',g?.name||'','text','required maxlength="80" placeholder="例如：下一站，去看世界"',true)}${field('目标金额（元）','target',g?String(g.target/100):'','text','required inputmode="decimal" placeholder="15000"')}${field('已经存下（元）','saved',g?String(g.saved/100):'0','text','required inputmode="decimal"')}<div class="field full"><p class="hint">这是储蓄进度的记录，不会重复增加总资产。新增资金的实际流动请另行记账。</p></div></div>${footer(g?'更新心愿':'创建心愿',g?{action:'delete-goal',id:g.id}:null)}</form>`)}
function budgetModal(){modal('给这个月，一点规划','预算是参考线，好的生活由你定义。',`<form id="budget-form"><div class="form-grid">${field('月度预算（元）','budget',String(state.settings.monthlyBudget/100),'text','required inputmode="decimal"',true)}</div>${footer('保存预算')}</form>`)}
function confirmModal(title,copy,action){modal(title,'每一步，都由你决定。',`<p class="confirm-copy">${copy}</p><div class="form-error" role="alert"></div><div class="modal-footer"><button class="btn btn-outline" data-action="close-modal">再想想</button><button class="btn btn-dark" id="confirm-action">确认继续 ${icon('right',14)}</button></div>`);$('#confirm-action').onclick=async()=>{const b=$('#confirm-action');b.disabled=true;try{await action();if(b.isConnected)b.disabled=false}catch(e){formError(e.message);b.disabled=false}}}
function calendarModal(){
 const [y,m]=month.split('-').map(Number);
 const days=new Date(y,m,0).getDate(), offset=(new Date(y,m-1,1).getDay()+6)%7;
 const bills={};
 for(const sub of state.subscriptions){
  if(!sub.active)continue;
  const [sy,sm]=sub.startDate.split('-').map(Number);
  const delta=(y-sy)*12+m-sm;
  if(delta<0||(!sub.recurring&&delta>0))continue;
  const due=addMonthsDue(sub.startDate,delta,sub.billingDay);
  (bills[Number(due.slice(8))]??=[]).push(sub);
 }
 const cells=Array.from({length:days},(_,i)=>{
  const date=`${month}-${String(i+1).padStart(2,'0')}`;
  const entries=(bills[i+1]||[]).map(sub=>{
   const price=hidden?'':subscriptionMoney(sub);
   return `<button class="calendar-amount" data-action="edit-subscription" data-id="${esc(sub.id)}" title="${esc(sub.name+(price?' · '+price:''))}"><span>${esc(sub.name)}</span>${price?`<small>${esc(price)}</small>`:''}</button>`;
  }).join('');
  return `<div class="calendar-day ${date===today()?'today':''}"><span>${i+1}</span>${entries}</div>`;
 }).join('');
 const weekdays=['一','二','三','四','五','六','日'].map(day=>`<div class="calendar-weekday">${day}</div>`).join('');
 modal('订阅日历',`${monthLabel()} · 已启用订阅的记账安排`,`<div class="page-tools">${monthControl()}<span class="small muted">${Object.values(bills).flat().length} 项扣账计划</span></div><div class="calendar">${weekdays}${'<div class="calendar-day blank"></div>'.repeat(offset)}${cells}</div>`,true);
}
async function download(name,content,type){if(desktop)return(await desktop.saveExport(name,content)).saved;const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;}
async function exportCsv(){
 const safe=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
 const rows=[['日期','类型','事项','分类','账户','转入账户','原币种','原币金额','到账币种','到账金额','本笔人民币汇率','折合人民币（元）','备注'],...filteredTransactions().map(t=>{
 const code=t.currency||accountCurrency(accountById(t.accountId)),target=t.type==='transfer'?(t.toCurrency||accountCurrency(accountById(t.toAccountId))):'';
 return [t.date,{income:'收入',expense:'支出',transfer:'转账'}[t.type],t.title,t.category,accountName(t.accountId),t.toAccountId?accountName(t.toAccountId):'',code,amountInput(t.amount,code),target,target?amountInput(t.toAmount??t.amount,target):'',t.cnyRate||'1',amountInput(transactionCnyAmount(t,state),'CNY'),t.note];})];
 if(await download('MoneyLab-'+month+'.csv','\ufeff'+rows.map(r=>r.map(safe).join(',')).join('\r\n'),'text/csv;charset=utf-8'))toast('当前筛选账单已导出');
}
function importModal(){modal('把你的账本，带回来','导入前会自动保存一份带时间戳的本地备份。',`<form id="import-form"><div class="field"><label for="import-file">选择 Money Lab JSON 备份（最大 2 MB）</label><input type="file" id="import-file" name="backup" accept=".json,application/json" required></div><div class="callout">${icon('info',15)}<span>导入会替换当前账本的账户、收支、订阅和储蓄目标。启用的订阅会补记至今天；建议先导出当前账本。</span></div>${footer('验证并导入')}</form>`)}
async function resetEmpty(){confirmModal(state.demo?'准备好，记录你的生活了吗？':'开启一个空白账本？',state.demo?'示例收支、账户、订阅和心愿将被清空。系统会先保留一份本地备份，账户、收支、订阅、心愿和预算都从零开始。':'当前账本将替换为空账本，原数据会保存到 data 目录的带时间戳备份文件。建议同时导出一份备份。',async()=>{state=await api('/api/reset',{method:'POST',body:JSON.stringify({mode:'empty',expectedRevision:state.revision})});void loadLedgerHealth();query='';filter='all';accountFilter='';closeModal();navigate('overview');toast('你的账本准备好了，从第一笔开始吧')})}
async function deleteItem(kind,id){const labels={transaction:'这笔账单',account:'这个账户',subscription:'这项订阅',goal:'这个心愿'};if(kind==='account'&&(state.transactions.some(t=>t.accountId===id||t.toAccountId===id)||state.subscriptions.some(s=>s.accountId===id))){formError('该账户有关联账单或订阅，请先调整关联记录，再删除账户。');return}confirmModal(`删除${labels[kind]}？`,kind==='subscription'?'历史订阅支出会保留，之后不再自动记录这项订阅。':kind==='transaction'?'这笔记录将移除，相关账户余额会随之更新。删除自动订阅账单后，该账期不会再次补记。':'删除后将从当前账本移除。',async()=>{const next=structuredClone(state);const key={transaction:'transactions',account:'accounts',subscription:'subscriptions',goal:'goals'}[kind];next[key]=next[key].filter(x=>x.id!==id);if(kind==='subscription')next.transactions.forEach(t=>{if(t.subscriptionId===id){delete t.subscriptionId;delete t.occurrenceKey}});await commit(next,'已删除')})}

document.addEventListener('click',async e=>{const target=e.target.closest('button,[data-page]');if(!target)return;if(target.dataset.page){navigate(target.dataset.page);return}if(target.dataset.filter){filter=target.dataset.filter;render();return}const a=target.dataset.action,id=target.dataset.id;if(!a)return;try{switch(a){case'check-updates':await updateUI?.check();break;case'download-update':await updateUI?.download();break;case'cancel-update':await updateUI?.cancel();break;case'install-update':await updateUI?.install();break;case'mobile-sync':await mobileSync.open();break;case'retry':location.reload();break;case'refresh-rates':await refreshRates({announce:true});break;case'menu':menuOpen=!menuOpen;render();break;case'close-modal':closeModal();break;case'add-transaction':transactionModal();break;case'add-expense':transactionModal(undefined,'expense');break;case'add-income':transactionModal(undefined,'income');break;case'add-transfer':transactionModal(undefined,'transfer');break;case'view-all-transactions':filter='all';query='';accountFilter='';navigate('transactions');break;case'view-income':filter='income';query='';accountFilter='';navigate('transactions');break;case'view-expense':filter='expense';query='';accountFilter='';navigate('transactions');break;case'edit-transaction':transactionModal(id);break;case'transaction-type':{
 const previousForm=$('#transaction-form'),draft=new FormData(previousForm),transferTarget=String(draft.get('toAccountId')||previousForm.dataset.transferTarget||''),toAmount=String(draft.get('toAmount')||previousForm.dataset.transferAmount||''),toCode=previousForm.dataset.toCurrency||'',code=previousForm.dataset.currency,rate=previousForm.elements.cnyRate.value;
 transactionModal(id,target.dataset.type);const nextForm=$('#transaction-form');if(!nextForm)break;
 nextForm.elements.accountId.value=draft.get('accountId');nextForm.dataset.accountId=draft.get('accountId');nextForm.dataset.currency=code;nextForm.dataset.toCurrency=toCode;
 for(const key of ['amount','title','date','note']){if(nextForm.elements[key]&&draft.has(key))nextForm.elements[key].value=draft.get(key);}
 nextForm.elements.cnyRate.value=rate;nextForm.dataset.transferTarget=transferTarget;nextForm.dataset.transferAmount=toAmount;
 updateTransferPreview(transferTarget);if(nextForm.elements.toAmount&&nextForm.dataset.toCurrency===toCode)nextForm.elements.toAmount.value=toAmount;
 break;}case'add-account':accountModal();break;
 case'add-bank-account':if(bankById(target.dataset.bankId))accountModal(undefined,target.dataset.bankId);break;
 case'toggle-bank':{const bankId=target.dataset.bankId;if(!bankById(bankId))break;if(expandedBanks.has(bankId))expandedBanks.delete(bankId);else{expandedBanks.add(bankId);dealBank=bankId;}render();dealBank='';document.querySelector('[data-action="toggle-bank"][data-bank-id="'+bankId+'"]').focus({preventScroll:true});break;}
 case'toggle-all-banks':{const bankIds=[...document.querySelectorAll('.bank-group[data-bank-id]')].map(group=>group.dataset.bankId);if(bankIds.every(bankId=>expandedBanks.has(bankId)))expandedBanks.clear();else bankIds.forEach(bankId=>expandedBanks.add(bankId));render();document.querySelector('[data-action="toggle-all-banks"]').focus({preventScroll:true});break;}
 case'accounts-view':{if(!['banks','cards'].includes(target.dataset.view))break;accountView=target.dataset.view;render();document.querySelector('[data-action="accounts-view"][data-view="'+accountView+'"]').focus({preventScroll:true});break;}
 case'choose-account':chooseAccountPreset(id);break;case'choose-bank':chooseBank(id);break;case'edit-account':accountModal(id);break;case'add-subscription':subscriptionModal();break;case'choose-service':chooseSubscriptionService(id);break;case'edit-subscription':subscriptionModal(id);break;case'toggle-subscription':{const s=state.subscriptions.find(x=>x.id===id);await commit(setSubscriptionActive(state,id,!s.active,today()),s.active?'已暂停订阅自动记账':'已恢复订阅自动记账');break}case'add-goal':goalModal();break;case'edit-goal':goalModal(id);break;case'budget':budgetModal();break;case'privacy':hidden=!hidden;sessionStorage.setItem('moneylab-hidden',String(hidden));render();break;case'month-prev':case'month-next':{const d=new Date(`${month}-15T12:00:00`);d.setMonth(d.getMonth()+(a==='month-prev'?-1:1));month=localDate(d).slice(0,7);render();if($('.calendar'))calendarModal();break}case'filter-subscriptions':subscriptionFilter=target.dataset.value;render();break;case'choose-apple-region':chooseAppleRegion(target.dataset.region);break;case'add-linked-account':addLinkedAccount();break;case'remove-linked-account':target.closest('.linked-account-row')?.remove();updateLinkedAccountEditor();break;case'calendar':calendarModal();break;case'account-transactions':accountFilter=id;filter='all';query='';navigate('transactions');break;case'export':{const data=await api('/api/state');if(await download(`MoneyLab-backup-${today()}.json`,JSON.stringify(data,null,2),'application/json'))toast('完整账本已导出');break}case'export-csv':await exportCsv();break;case'open-data':await desktop?.openDataDirectory();break;case'toggle-tray':desktopInfo=await desktop.setPreferences({keepInTray:!desktopInfo.keepInTray});render();break;case'exit-app':desktop?.quit();break;case'import':importModal();break;case'start-empty':resetEmpty();break;case'delete-transaction':case'delete-account':case'delete-subscription':case'delete-goal':deleteItem(a.replace('delete-',''),id);break}}catch(error){formError(error.message)}});
document.addEventListener('submit',async e=>{const form=e.target;e.preventDefault();const data=new FormData(form),get=name=>String(data.get(name)||'').trim();if(form.id==='global-search'){query=get('query');navigate('transactions');return}if(ratesRefreshPromise){formError('正在更新汇率，请稍后保存');return}const next=structuredClone(state),id=form.dataset.id;try{switch(form.id){case'transaction-form':{const type=form.dataset.type,old=state.transactions.find(x=>x.id===id);const tx={id:id||uid('tx'),type,currency:accountCurrency(accountById(get('accountId'))),amount:parseMoney(get('amount'),accountCurrency(accountById(get('accountId')))),accountId:get('accountId'),category:type==='transfer'?'账户转账':get('category'),title:get('title'),date:get('date'),note:get('note')};if(tx.amount<=0)throw new Error('金额需要大于 0');if(tx.date>today())throw new Error('普通账单请使用今天或过去的日期，未来费用可添加为订阅');if(tx.currency!=='CNY')tx.cnyRate=normalizeRate(get('cnyRate'));if(type==='transfer'){tx.toAccountId=get('toAccountId');tx.toCurrency=accountCurrency(accountById(tx.toAccountId));if(tx.currency!==tx.toCurrency)tx.toAmount=parseMoney(get('toAmount'),tx.toCurrency);}if(old?.mobileCapture)tx.mobileCapture=structuredClone(old.mobileCapture);if(old?.subscriptionId&&type==='expense'&&tx.date.slice(0,7)===old.date.slice(0,7)){tx.subscriptionId=old.subscriptionId;tx.occurrenceKey=old.occurrenceKey}if(id)replaceRecord(next.transactions,id,tx);else next.transactions.push(tx);break}case'account-form':{const item={id:id||uid('acc'),name:get('name'),type:get('type'),color:get('color'),currency:form.elements.currency.value,openingBalance:parseMoney(get('openingBalance'),form.elements.currency.value)};if(item.currency!=='CNY'){item.rateMode=get('rateMode')==='manual'?'manual':'auto';item.cnyRate=normalizeRate(item.rateMode==='auto'?form.elements.cnyRate.value:get('cnyRate'));const quote=cachedRate(item.currency);if(item.rateMode==='auto'&&quote&&quote.cnyRate===item.cnyRate){if(quote.asOf)item.rateAsOf=quote.asOf;if(quote.source)item.rateSource=quote.source;}}if(get('providerId'))item.providerId=get('providerId');if(item.providerId==='apple-balance'){item.appleRegion=get('appleRegion');if(get('appleAccount'))item.appleAccount=get('appleAccount');}if(isCardType(item.providerId,item.type)){if(get('bankId'))item.bankId=get('bankId');if(get('lastFour')){if(!/^[0-9]{4}$/.test(get('lastFour')))throw new Error('卡片尾号需要填写 4 位数字');item.lastFour=get('lastFour');}}if(id)replaceRecord(next.accounts,id,item);else next.accounts.push(item);break}case'subscription-form':{const old=state.subscriptions.find(x=>x.id===id);const sub={id:id||uid('sub'),name:get('name'),currency:accountCurrency(accountById(get('accountId'))),amount:parseMoney(get('amount'),accountCurrency(accountById(get('accountId')))),accountId:get('accountId'),category:'会员订阅',startDate:get('startDate'),billingDay:Number(form.elements.billingDay.value),recurring:data.has('recurring'),active:old?.active??true,color:get('color'),icon:get('icon'),processedOccurrences:old?.processedOccurrences||[],tier:get('tier'),linkedAccounts:readLinkedAccounts(),expiresOn:get('expiresOn'),note:get('note')};if(get('serviceId'))sub.serviceId=get('serviceId');if(id)replaceRecord(next.subscriptions,id,sub);else next.subscriptions.push(sub);break}case'goal-form':{const goal={id:id||uid('goal'),name:get('name'),target:moneyToCents(get('target')),saved:moneyToCents(get('saved')),color:'#c7dfa2',cover:'assets/alpine-goal.png'};if(id)replaceRecord(next.goals,id,goal);else next.goals.push(goal);break}case'budget-form':next.settings.monthlyBudget=moneyToCents(get('budget'));break;case'import-form':{const file=data.get('backup');if(!file?.size)throw new Error('请选择有效的 JSON 文件');if(file.size>2*1024*1024)throw new Error('备份不能超过 2 MB');let imported;try{imported=JSON.parse((await file.text()).replace(/^\uFEFF/,''))}catch{throw new Error('文件不是有效的 JSON 备份')}validateState(imported);await commit(imported,'完整账本已恢复',true);return}default:return}if(next.accounts.some(a=>accountCurrency(a)!=='CNY'))next.schemaVersion=2;validateState(next);const saved=await commit(next);if(saved&&form.id==='account-form'&&!id&&bankById(get('bankId'))){expandedBanks.add(get('bankId'));render()}}catch(error){formError(error.message)}});
document.addEventListener('compositionend',e=>{
 if(['subscription-search','transaction-search'].includes(e.target.id))e.target.dispatchEvent(new Event('input',{bubbles:true}));
});
for(const event of ['input','change'])document.addEventListener(event,e=>{if(e.target.name==='amount'&&e.target.closest('#subscription-form'))updateSubscriptionPayment()});
document.addEventListener('input',e=>{
 const {id,value,selectionStart,name}=e.target;
 if(['subscription-search','transaction-search'].includes(id)){
  if(e.isComposing)return;
  if(id==='subscription-search')subscriptionQuery=value;
  else query=value;
  render();
  const search=document.getElementById(id);
  search?.focus({preventScroll:true});
  search?.setSelectionRange(selectionStart,selectionStart);
 }
 if(['expiresOn','startDate'].includes(name)&&e.target.closest('#subscription-form'))updateSubscriptionExpiryPreview();
});
document.addEventListener('change',e=>{if(e.target.name==='appleRegion'&&e.target.closest('#account-form'))updateAppleBalanceFields({request:true});if(e.target.id==='saved-linked-account'&&e.target.value!==''){const account=savedSubscriptionAccounts()[Number(e.target.value)];if(account)addLinkedAccount(account);e.target.value=''}if(e.target.dataset.linkedField==='type'){const input=e.target.closest('.linked-account-row').querySelector('[data-linked-field="value"]');input.type=e.target.value==='email'?'email':'text';}if(['expiresOn','startDate','billingDay','recurring'].includes(e.target.name)&&e.target.closest('#subscription-form'))updateSubscriptionExpiryPreview();if(['currency','rateMode'].includes(e.target.name)&&e.target.closest('#account-form'))updateAppleBalanceFields({request:true});if(e.target.name==='accountId'&&e.target.closest('#subscription-form'))updateSubscriptionCurrency();if(e.target.name==='bankId'&&e.target.closest('#account-form'))chooseBank(e.target.value);if(e.target.name==='type'&&e.target.closest('#account-form'))updateBankFields();if(e.target.name==='providerId'&&e.target.closest('#account-form'))chooseAccountPreset(e.target.value);if(['accountId','toAccountId'].includes(e.target.name)&&e.target.closest('#transaction-form'))updateTransferPreview();if(e.target.name==='serviceId'){chooseSubscriptionService(e.target.value)}if(e.target.name==='tierPreset'){const tier=$('#field-tier');tier.value=e.target.value;if(!e.target.value)tier.focus();}if(e.target.id==='account-filter'){accountFilter=e.target.value;render()}if(e.target.name==='startDate'&&e.target.closest('#subscription-form')&&!$('#subscription-form').dataset.id){$('#field-billingDay').value=String(Number(e.target.value.slice(8)));updateSubscriptionExpiryPreview()}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();if(menuOpen){menuOpen=false;render()}}if($('.modal')){if(e.key==='Tab'){const nodes=[...$('.modal').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node=>node.tabIndex>=0&&node.getClientRects().length&&!node.closest('[hidden]'));const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}return}if(e.key.toLowerCase()==='n'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){e.preventDefault();transactionModal()}});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if([...navItems.map(x=>x[0]),'settings'].includes(next)&&page!==next){page=next;render()}});
async function refresh(){try{const next=await api('/api/state');if(!busy&&(!state||next.revision>state.revision||renderedDay!==today())){state=next;if($('.modal'))ratesDeferredRender=true;else render()}}catch(e){if(!state)$('#app').innerHTML=`<div class="boot"><span class="brand-mark"><img src="/assets/app-icon.png" alt="超级账本" width="54" height="54"></span><h2>暂时无法打开本地账本</h2><p class="muted">${esc(e.message)}</p><p class="small muted">请先尝试重新连接；仍无法打开时，退出应用，再从桌面或开始菜单打开「超级账本」。</p><button class="btn btn-primary" data-action="retry">重新连接</button></div>`}finally{await loadLedgerHealth()}}
iconSelects=createIconSelects({describeOption:describePickerOption});
// Refresh after business handlers finish changing native values or dependent fields.
for(const event of ['click','change','input'])document.addEventListener(event,()=>queueMicrotask(refreshFormVisuals));
mobileSync=createMobileSyncUI({api,modal,toast,desktop,refresh:async()=>{await refresh();if(mobileSync.isOpen()){ratesDeferredRender=false;render()}}});
page=[...navItems.map(x=>x[0]),'settings'].includes(location.hash.slice(1))?location.hash.slice(1):'overview';
hidden=sessionStorage.getItem('moneylab-hidden')==='true';
if(desktop){
 document.body.classList.add('desktop-app');
 try{desktopInfo=await desktop.getInfo()}catch{}
 desktop.onPreferencesChanged(value=>{desktopInfo=value;if(page==='settings')render()});
 updateUI=createUpdateUI({desktop,icon,onStatus:value=>{updateStatus=value}});
 if(desktop.getUpdateStatus){try{updateUI.update(await desktop.getUpdateStatus())}catch{}}
}
await refresh();
void loadRateStatus({sync:true});
setInterval(()=>{if(!busy&&document.visibilityState==='visible'){if(!$('.modal'))void refresh();else void loadLedgerHealth();void loadRateStatus()}},30000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!busy){if(!$('.modal'))void refresh();else void loadLedgerHealth();void loadRateStatus({sync:true})}});

function desktopSettings(){return `<section class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>${icon('settings',17)} 桌面应用</h2><span class="category-tag">v${esc(desktopInfo?.version||'1.1.0')}</span></div><div class="setting-row"><div><b>关闭窗口后留在托盘</b><p>继续自动记订阅支出；关闭此项后，点 × 会完全退出</p></div><button class="switch ${desktopInfo?.keepInTray?'on':''}" role="switch" aria-checked="${Boolean(desktopInfo?.keepInTray)}" aria-label="关闭窗口后留在托盘" data-action="toggle-tray"></button></div><div class="setting-row"><div><b>本机数据文件夹</b><p>程序与账本分开保存，安装更新不会覆盖数据</p></div><button class="btn btn-outline btn-sm" data-action="open-data">打开文件夹</button></div><div class="setting-row"><div><b>完全退出超级账本</b><p>下次打开时补记遗漏的订阅账期</p></div><button class="btn btn-soft btn-sm" data-action="exit-app">退出应用</button></div></section>`;}
