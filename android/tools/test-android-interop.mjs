import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { appleBalanceRegions } from '../../account-presets.mjs';
import { createLedgerServer } from '../../server.mjs';
import { networkChoices } from '../../mobile-sync.mjs';
const execute=promisify(execFile), tools=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(tools,'../..');
const build=path.join(root,'android','build','native-interop-'+Date.now());
const classes=path.join(build,'classes'), data=path.join(build,'desktop'), phone=path.join(build,'phone');
for(const p of [build,classes,data,phone])fs.mkdirSync(p,{recursive:true});
const jar=path.join(tools,'lib','json-20240303.jar');
const source=path.join(root,'android','app','src','main','java','com','moneylab','superledger','mobile');
const androidRegions=[...fs.readFileSync(path.join(source,'AppleBalance.java'),'utf8').matchAll(/new Region\("([^"]+)","([^"]+)",("[^"]+"|null)\)/g)].map(([,id,name,currency])=>({id,name,currency:currency==='null'?null:JSON.parse(currency)}));
assert.deepEqual(androidRegions,appleBalanceRegions,'Apple regions must match desktop');
const files=[path.join(tools,'AndroidInteropHarness.java'),...['SyncClient','LedgerStore','MobileLedger','AppleBalance','SubscriptionDetails','PaymentParser','PaymentRouting','PaymentPageParser','UpdatePolicy','UpdateSources'].map(n=>path.join(source,n+'.java'))];
const testSource=path.join(root,'android','app','src','test','java','com','moneylab','superledger','mobile');
const testNames=['PaymentParserTest','PaymentRoutingTest','PaymentPageParserTest','LedgerStoreTest','MobileLedgerTest','SubscriptionDetailsTest','SubscriptionRenewalTest','UpdatePolicyTest'];
files.push(...testNames.map(n=>path.join(testSource,n+'.java')));
for(const file of ['android/util/Base64.java','android/util/AtomicFile.java','android/content/Context.java','android/os/Build.java'])files.push(path.join(tools,'test-stubs',file));
await execute('javac.exe',['-J-Duser.language=en','-encoding','UTF-8','-cp',jar,'-d',classes,...files]);
for(const name of testNames){
  const {stdout}=await execute('java.exe',['-Dfile.encoding=UTF-8','-cp',[classes,jar].join(path.delimiter),'com.moneylab.superledger.mobile.'+name]);process.stdout.write(stdout);
}
const address=networkChoices().find(i=>!i.virtual)?.address;
assert.ok(address,'This integration test requires a local private IPv4 interface.');
let server,base;
async function start(){
  server=await createLedgerServer({port:0,dataDirectory:data,authToken:'java-source-test',mobileSyncOptions:{interfaces:()=>[{address,label:'Local interop test'}]}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
}
async function stop(){if(server?.listening){await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>setImmediate(resolve));}}
async function api(route,body,method='POST'){
  const response=await fetch(base+route,{method:body===undefined?'GET':method,headers:{'X-Ledger-Token':'java-source-test','Content-Type':'application/json',Connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
}
const qrFile=path.join(build,'pairing.json'), resultFile=path.join(build,'result.json');
async function pair(){const status=await api('/api/mobile-sync/start',{address});fs.writeFileSync(qrFile,status.qrPayload);}
async function java(action,extra='',profile=phone){
  const {stdout}=await execute('java.exe',['-Dfile.encoding=UTF-8','-cp',[classes,jar].join(path.delimiter),'AndroidInteropHarness',action,profile,qrFile,resultFile,extra],{maxBuffer:2*1024*1024});
  process.stdout.write(stdout);return JSON.parse(fs.readFileSync(resultFile,'utf8'));
}
const checks=[];
try{
  await start();let state=await api('/api/state');state.accounts=[{id:'wallet',name:'微信',type:'数字钱包',providerId:'wechat',openingBalance:10000000,color:'#28b877'}];await api('/api/state',{state,expectedRevision:state.revision},'PUT');
  await pair();let r=await java('sync');assert.equal(r.snapshot.state.accounts.length,1);assert.equal(r.snapshot.operations.length,0);checks.push('actual Java AES-GCM request/response and first pairing');
  await java('pairing-validation');checks.push('public IP, loopback, hostname, padded IP, port, path and scheme rejection');
  await java('add','510');r=await java('sync');assert.equal(r.request.operations.length,500);assert.equal(r.snapshot.operations.length,10);assert.equal(r.snapshot.state.transactions.length,510);checks.push('500-operation batch retains unsent local records');
  r=await java('sync-no-ack');assert.equal(r.snapshot.operations.length,10);assert.equal((await api('/api/state')).transactions.length,510);
  await stop();await start();await pair();r=await java('sync');assert.equal(r.response.summary.duplicates,10);assert.equal(r.snapshot.operations.length,0);assert.equal(r.snapshot.state.transactions.length,510);checks.push('lost ACK across native JVM and desktop restart retries without duplicates');
  r=await java('edit');const editedId=r.transaction.id;state=await api('/api/state');state.transactions.find(t=>t.id===editedId).title='电脑并发修改';await api('/api/state',{state,expectedRevision:state.revision},'PUT');
  r=await java('sync');assert.equal(r.snapshot.conflicts.length,1);assert.equal(r.snapshot.operations.length,1);assert.equal(r.snapshot.state.transactions.find(t=>t.id===editedId).title,'手机离线修改');checks.push('concurrent desktop edit preserves native mobile pending work');
  await java('add','2');r=await java('sync');assert.equal(r.snapshot.conflicts.length,1);assert.equal(r.snapshot.operations.length,1);assert.equal(r.request.operations.length,2);checks.push('later batch does not erase earlier unresolved conflict');
  r=await java('resolve-desktop');assert.equal(r.snapshot.conflicts.length,0);assert.equal(r.snapshot.operations.length,0);assert.equal(r.snapshot.state.transactions.find(t=>t.id===editedId).title,'电脑并发修改');checks.push('explicit conflict resolution applies current desktop version');
  await java('add','1');await java('sync-no-ack');assert.equal((await api('/api/state')).transactions.length,513);
  r=await java('delete-pending');assert.equal(r.snapshot.operations[0].kind,'delete');const deletedId=r.deletedId;
  r=await java('sync');assert.equal(r.response.summary.deleted,1);assert.equal(r.snapshot.operations.length,0);assert.equal(r.snapshot.state.transactions.length,512);assert.equal(r.snapshot.state.transactions.some(t=>t.id===deletedId),false);checks.push('delete after lost creation ACK sends tombstone and does not resurrect transaction');
  await java('add-large','220');r=await java('sync');while(r.snapshot.operations.length){assert.equal(r.response.conflicts.length,0);const before=r.snapshot.operations.length;r=await java('sync');assert.ok(r.snapshot.operations.length<before);}assert.equal(r.snapshot.operations.length,0);
  await java('edit-large');r=await java('sync');const firstLargeCount=r.request.operations.length;
  assert.ok(firstLargeCount>0&&firstLargeCount<220);assert.ok(Buffer.byteLength(JSON.stringify(r.request),'utf8')<=2*1024*1024);assert.equal(r.snapshot.operations.length,220-firstLargeCount);
  while(r.snapshot.operations.length){assert.equal(r.response.conflicts.length,0);const before=r.snapshot.operations.length;r=await java('sync');assert.ok(Buffer.byteLength(JSON.stringify(r.request),'utf8')<=2*1024*1024);assert.ok(r.snapshot.operations.length<before);}assert.equal(r.snapshot.state.transactions.filter(t=>t.title.startsWith('长备注测试')&&t.title.endsWith('修改')).length,220);checks.push('UTF-8 base+put payload under 500 operations splits at 2MB and retains/sends remaining changes');
  await java('full-ledger');r=await java('sync-no-ack');assert.equal(r.response.conflicts.length,0,JSON.stringify(r.response.conflicts));
  state=await api('/api/state');assert.equal(state.accounts.find(a=>a.id==='mobile_usd').currency,'USD');assert.equal(state.transactions.find(t=>t.id==='mobile_exchange').toAmount,1000);assert.equal(state.settings.monthlyBudget,123456);assert.equal(state.goals[0].saved,25000);assert.equal(state.transactions.filter(t=>t.subscriptionId==='mobile_sub').length,1);
  r=await java('sync');assert.equal(r.snapshot.operations.length,0);assert.equal(r.snapshot.state.transactions.filter(t=>t.subscriptionId==='mobile_sub').length,1);checks.push('native full-entity queue, historical FX, cross-currency transfer, budget, goal and subscription converge after lost ACK');
  state=await api('/api/state');state.accounts.push({id:'desktop_apple_tr',name:'土耳其 Apple 余额',type:'Apple 账户余额',providerId:'apple-balance',appleRegion:'TR',appleAccount:'interop@example.com',currency:'TRY',cnyRate:'0.15',rateMode:'manual',openingBalance:10025,color:'#555555'});await api('/api/state',{state,expectedRevision:state.revision},'PUT');
  r=await java('sync');assert.equal(r.snapshot.state.accounts.find(a=>a.id==='desktop_apple_tr').currency,'TRY');await java('apple-edit');r=await java('sync');assert.equal(r.response.conflicts.length,0);
  let apple=(await api('/api/state')).accounts.find(a=>a.id==='desktop_apple_tr');assert.equal(apple.openingBalance,20050);assert.equal(apple.providerId,'apple-balance');assert.equal(apple.appleRegion,'TR');assert.equal(apple.appleAccount,'interop@example.com');
  await java('apple-convert');r=await java('sync');assert.equal(r.response.conflicts.length,0);apple=(await api('/api/state')).accounts.find(a=>a.id==='desktop_apple_tr');assert.equal(apple.providerId,undefined);assert.equal(apple.appleRegion,undefined);assert.equal(apple.appleAccount,undefined);checks.push('desktop TRY Apple account survives native pull and balance edit, and account conversion clears Apple metadata');
  await java('goal-edit');state=await api('/api/state');state.goals[0].saved=45000;await api('/api/state',{state,expectedRevision:state.revision},'PUT');r=await java('sync');assert.equal(r.snapshot.conflicts.length,1);assert.equal(r.snapshot.conflicts[0].entity,'goal');assert.equal(r.snapshot.state.goals[0].saved,35000);r=await java('resolve-desktop');assert.equal(r.snapshot.state.goals[0].saved,45000);checks.push('entity conflict keeps local goal until explicit resolution');
  await java('delete-sub');r=await java('sync');assert.equal(r.snapshot.operations.length,0);state=await api('/api/state');assert.equal(state.subscriptions.length,0);assert.equal(state.transactions.filter(t=>t.id.startsWith('rec_mobile_sub_')).length,1);assert.equal(state.transactions.find(t=>t.id.startsWith('rec_mobile_sub_')).subscriptionId,undefined);checks.push('subscription deletion sync retains already booked expense');
  await java('mobile-apple-create');r=await java('sync-no-ack');assert.equal(r.response.conflicts.length,0);state=await api('/api/state');
  apple=state.accounts.find(a=>a.id==='mobile_apple_tr');let appleSub=state.subscriptions.find(s=>s.id==='mobile_apple_subscription');
  assert.equal(apple.currency,'TRY');assert.equal(apple.appleRegion,'TR');assert.equal(apple.appleAccount,'owner-mobile@example.com');assert.equal(apple.openingBalance,10025);
  assert.deepEqual(appleSub.linkedAccounts.map(a=>a.type),['email','apple','other']);assert.equal(appleSub.note,'手机创建的订阅备注');assert.ok(appleSub.expiresOn>appleSub.startDate);assert.equal(appleSub.amount,999);
  r=await java('sync');assert.equal(r.snapshot.operations.length,0);assert.equal((await api('/api/state')).accounts.filter(a=>a.id==='mobile_apple_tr').length,1);checks.push('mobile-created TRY Apple balance and membership details reach desktop exactly once after lost ACK');
  await java('mobile-apple-edit');r=await java('sync');assert.equal(r.response.conflicts.length,0);state=await api('/api/state');apple=state.accounts.find(a=>a.id==='mobile_apple_tr');appleSub=state.subscriptions.find(s=>s.id==='mobile_apple_subscription');
  assert.equal(apple.appleRegion,'OTHER');assert.equal(apple.currency,'TRY');assert.equal(apple.appleAccount,'edited-mobile@example.com');assert.equal(apple.openingBalance,25075);assert.equal(appleSub.linkedAccounts.length,1);assert.equal(appleSub.linkedAccounts[0].value,apple.appleAccount);assert.equal(appleSub.note,'手机修改后的订阅备注');
  appleSub.note='电脑补充的说明';appleSub.linkedAccounts.push({type:'google',value:'desktop@example.com',label:'电脑补充'});await api('/api/state',{state,expectedRevision:state.revision},'PUT');r=await java('sync');let pulledSub=r.snapshot.state.subscriptions.find(s=>s.id==='mobile_apple_subscription');assert.equal(pulledSub.note,'电脑补充的说明');assert.equal(pulledSub.linkedAccounts[1].type,'google');checks.push('Apple region and identity edits and subscription details converge in both directions');
  await java('mobile-apple-clear');r=await java('sync');assert.equal(r.response.conflicts.length,0);state=await api('/api/state');apple=state.accounts.find(a=>a.id==='mobile_apple_tr');appleSub=state.subscriptions.find(s=>s.id==='mobile_apple_subscription');
  assert.equal(apple.appleRegion,'TR');assert.equal(apple.appleAccount,undefined);assert.equal(apple.openingBalance,25075);assert.deepEqual(appleSub.linkedAccounts,[]);assert.equal(appleSub.expiresOn,'');assert.equal(appleSub.note,'');r=await java('sync');assert.equal(r.snapshot.operations.length,0);assert.deepEqual(r.snapshot.state.subscriptions.find(s=>s.id==='mobile_apple_subscription').linkedAccounts,[]);checks.push('explicit clearing of Apple identity and subscription details stays cleared after a second sync');
  await api('/api/mobile-sync/stop',{});await pair();const offlinePhone=path.join(build,'offline-first-phone');fs.mkdirSync(offlinePhone);await java('offline-first','',offlinePhone);r=await java('sync','',offlinePhone);assert.equal(r.request.bookId,null);assert.equal(r.response.conflicts.length,0);assert.equal(r.snapshot.operations.length,0);assert.ok(r.snapshot.state.accounts.some(a=>a.id==='wallet'));assert.ok(r.snapshot.state.accounts.some(a=>a.id==='offline_wallet'));assert.equal((await api('/api/state')).transactions.filter(t=>t.id==='offline_expense').length,1);checks.push('first pairing merges independently created mobile accounts and transactions without replacing desktop ledger');
  await api('/api/mobile-sync/stop',{});await pair();
  r=await java('membership-renew');const renewedExpiry=r.expectedExpiry;
  r=await java('sync');assert.equal(r.response.conflicts.length,0,JSON.stringify(r.response.conflicts));state=await api('/api/state');
  let membership=state.subscriptions.find(s=>s.id==='renewing_membership');assert.equal(membership.expiresOn,renewedExpiry);assert.equal(membership.expiryRenewal.renewedOccurrences.length,1);assert.equal(state.transactions.filter(t=>t.subscriptionId==='renewing_membership').length,1);
  r=await java('sync');assert.equal(r.snapshot.state.subscriptions.find(s=>s.id==='renewing_membership').expiresOn,renewedExpiry);assert.equal(r.snapshot.operations.length,0);checks.push('native membership expense and renewal credit converge without extending twice on repeated synchronization');
  r=await java('membership-edit-expiry');const manualExpiry=r.expectedExpiry;r=await java('sync');assert.equal(r.response.conflicts.length,0,JSON.stringify(r.response.conflicts));membership=(await api('/api/state')).subscriptions.find(s=>s.id==='renewing_membership');assert.equal(membership.expiresOn,manualExpiry);assert.equal(membership.expiryRenewal.renewedOccurrences.length,0);assert.equal(membership.expiryRenewal.baselineOccurrences.length,1);checks.push('native manual membership expiry establishes a new baseline without replaying an existing paid period');
  r=await java('membership-unfunded');const unfundedExpiry=r.expectedExpiry;r=await java('sync');assert.equal(r.response.conflicts.length,0,JSON.stringify(r.response.conflicts));state=await api('/api/state');membership=state.subscriptions.find(s=>s.id==='funding_member');assert.equal(membership.expiresOn,unfundedExpiry);assert.equal(membership.processedOccurrences.length,0);assert.equal(state.transactions.filter(t=>t.subscriptionId==='funding_member').length,0);checks.push('native unfunded subscriptions remain unpaid and retain expiry after desktop synchronization');
  r=await java('membership-topup');const fundedExpiry=r.expectedExpiry;assert.equal(r.snapshot.state.transactions.filter(t=>t.subscriptionId==='funding_member').length,1);r=await java('sync');assert.equal(r.response.conflicts.length,0,JSON.stringify(r.response.conflicts));state=await api('/api/state');membership=state.subscriptions.find(s=>s.id==='funding_member');assert.equal(membership.expiresOn,fundedExpiry);assert.equal(membership.processedOccurrences.length,1);assert.equal(state.transactions.filter(t=>t.subscriptionId==='funding_member').length,1);r=await java('sync');assert.equal(r.snapshot.state.subscriptions.find(s=>s.id==='funding_member').expiresOn,fundedExpiry);checks.push('native income top-ups pay one pending period and renew membership once across repeated desktop sync');
  r=await java('stale-funding-wallet');const staleDate=r.today;await java('sync');state=await api('/api/state');state.transactions.push({id:'desktop_stale_spend',type:'expense',amount:100,accountId:'stale_wallet',category:'其他支出',title:'电脑已使用缓存中的余额',date:staleDate,note:''});await api('/api/state',{state,expectedRevision:state.revision},'PUT');
  r=await java('stale-funding-plan');const recoveredExpiry=r.expectedExpiry;r=await java('sync');assert.equal(r.response.conflicts.some(c=>c.retryWhenFunded),true);assert.equal(r.snapshot.state.transactions.filter(t=>t.subscriptionId==='stale_member').length,0);assert.equal(r.snapshot.state.subscriptions.find(s=>s.id==='stale_member').processedOccurrences.length,0);
  state=await api('/api/state');state.transactions.push({id:'desktop_stale_topup',type:'income',amount:100,accountId:'stale_wallet',category:'其他收入',title:'电脑补足待扣账期',date:state.subscriptions.find(s=>s.id==='stale_member').startDate,note:''});await api('/api/state',{state,expectedRevision:state.revision},'PUT');
  r=await java('sync-until-settled');assert.ok(r.rounds<=2);assert.equal(r.snapshot.conflicts.length,0);assert.equal(r.snapshot.operations.length,0);assert.equal(r.snapshot.state.transactions.filter(t=>t.subscriptionId==='stale_member').length,1);assert.equal(r.snapshot.state.subscriptions.find(s=>s.id==='stale_member').expiresOn,recoveredExpiry);checks.push('stale mobile funding is held without a local debit, then a desktop top-up settles the pending period and retry acknowledgement automatically');
  const report={passed:true,checks,scope:'Production Android Java sources on JDK with test-only platform adapters; not an Android runtime/device test.',completedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(build,'report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(tools,'native-interop-latest.json'),JSON.stringify({...report,artifacts:build},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,report:path.join(build,'report.json')}));
} finally { await stop(); }
