import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { subscriptionCatalog } from '../subscription-catalog.mjs';
import { makeEmptyState, validateState, applyRecurring } from '../engine.mjs';

test('requested membership presets have source-backed tiers and local logo assets',()=>{
  const ids=new Set();
  for(const p of subscriptionCatalog){
    assert.ok(!ids.has(p.id));ids.add(p.id);
    assert.ok(p.tiers.length>0&&p.tiers.every(t=>typeof t==='string'&&t.length<=80));
    assert.ok(p.sources.every(s=>new URL(s.url).protocol==='https:'));
    assert.ok(p.logo.startsWith('/assets/brands/'));
    const file=new URL('..'+p.logo,import.meta.url);assert.ok(fs.statSync(file).size>50);
  }
  for(const id of ['chatgpt','claude','gemini','ttvoice','kugou','baidu'])assert.ok(ids.has(id));
});
test('custom membership tiers survive validation and are recorded in automatic expenses',()=>{
  const s=makeEmptyState();s.accounts.push({id:'cash',name:'现金',type:'现金',openingBalance:10000,color:'#ffffff'});
  s.subscriptions.push({id:'sub_gpt',name:'ChatGPT',serviceId:'chatgpt',tier:'自定义优惠档位',amount:1234,accountId:'cash',category:'会员订阅',startDate:'2026-11-05',billingDay:5,recurring:true,active:true,color:'#111111',icon:'spark',processedOccurrences:[]});
  assert.equal(validateState(s),true);
  const result=applyRecurring(s,'2026-11-05');
  assert.equal(result.added.length,1);assert.equal(result.added[0].amount,1234);assert.match(result.added[0].title,/自定义优惠档位/);
  assert.equal(applyRecurring(result.state,'2026-11-05').added.length,0);
  s.subscriptions[0].tier='x'.repeat(81);assert.throws(()=>validateState(s),/会员档位/);
});
