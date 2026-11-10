import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeEmptyState, validateState, upgradeSchemaVersion, replaceRecord } from '../engine.mjs';
import { accountCurrency, currencyRate, currencyInfo, parseMoney, amountInput, formatMoney, normalizeRate } from '../currencies.mjs';
import { sortedLedgerRows } from '../assets/ledger-insights.mjs';

// Execute the actual renderer functions and delegated handlers with in-memory
// controls. No server, filesystem ledger, browser profile or dependency is used.
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `renderer boundaries: ${start}`);
  return source.slice(first, last);
}
const decode = value => value.replace(/&quot;|&#39;|&lt;|&gt;|&amp;/g, entity => ({
  '&quot;':'"', '&#39;':"'", '&lt;':'<', '&gt;':'>', '&amp;':'&',
}[entity]));
const attributes = html => Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));

function formFromHtml(html) {
  const attrs = attributes(/<form\b[^>]*>/.exec(html)[0]);
  const form = { id: attrs.id, dataset: {}, elements: {}, submitter: { value: 'again' } };
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('data-')) form.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  const control = (name, value) => ({ name, value, closest: () => form, focus() { form.focused = name; }, dispatchEvent() {} });
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const value = attributes(tag);
    form.elements[value.name] = control(value.name, value.value || '');
  }
  for (const [, head, content] of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const { name } = attributes(head), options = [...content.matchAll(/<option\b([^>]*)>/g)];
    const selected = options.find(([, option]) => /\bselected\b/.test(option)) || options[0];
    form.elements[name] = control(name, selected ? attributes(selected[1]).value : '');
  }
  for (const [, head, content] of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const { name } = attributes(head);
    form.elements[name] = control(name, decode(content));
  }
  form.querySelector = () => form.submitter;
  form.requestSubmit = button => { form.requestedSubmitter = button; };
  return form;
}

function fixture(transactions = []) {
  const state = makeEmptyState();
  state.accounts = [
    { id:'cash', name:'现金', type:'现金', color:'#123456', openingBalance:100000 },
    { id:'bank', name:'银行', type:'银行卡', color:'#654321', openingBalance:100000 },
    { id:'usd', name:'美元', type:'现金', color:'#123456', openingBalance:100000, currency:'USD', cnyRate:'7.2' },
  ];
  state.transactions = transactions;
  upgradeSchemaVersion(state);
  validateState(state);
  return state;
}
const expense = (id, extra = {}) => ({
  id, type:'expense', accountId:'cash', category:'购物消费', title:id,
  amount:100, date:'2026-11-08', note:'', ...extra,
});

function renderer(state = fixture()) {
  const storage = new Map(), listeners = new Map(), surfaces = new Map();
  const ctx = vm.createContext({
    state, busy:false, ratesRefreshPromise:null, ratesDeferredRender:false,
    accountCurrency, currencyRate, currencyInfo, parseMoney, amountInput, formatMoney, normalizeRate,
    validateState, upgradeSchemaVersion, replaceRecord, structuredClone, Event,
    expenseCategories:['餐饮美食','购物消费'], incomeCategories:['工资薪资'],
    localStorage:{ getItem:key => storage.get(key), setItem:(key,value) => storage.set(key,value) },
    document:{
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
      querySelectorAll:() => ctx.submitButtons,
    },
    FormData:class {
      constructor(form) { this.values = Object.fromEntries(Object.entries(form.elements).filter(([, field]) => !field.disabled).map(([key, field]) => [key, field.value])); }
      get(name) { return this.values[name]; }
      has(name) { return Object.hasOwn(this.values, name); }
    },
    submitButtons:[{ disabled:false }, { disabled:false }],
    sortedRows:rows => sortedLedgerRows(rows, ctx.state.transactions),
    icon:() => '', ensureAccount:() => true,
    accountById:id => ctx.state.accounts.find(account => account.id === id), accountLabel:account => account.name,
    balances:() => Object.fromEntries(ctx.state.accounts.map(account => [account.id, account.openingBalance])),
    accountOptions:() => ctx.state.accounts.map(account => [account.id, account.name]),
    today:() => '2026-11-09', uid:() => 'new_transaction',
    modal(_title, _subtitle, html) { ctx.html = html; ctx.activeForm = formFromHtml(html); ctx.openCount++; },
    openCount:0, closeCount:0, renderCount:0, visualRefreshCount:0,
    closeModal() { ctx.activeForm = null; ctx.closeCount++; },
    render() { ctx.renderCount++; }, toast:message => { ctx.toastMessage = message; },
    formError:message => { ctx.error = message; },
    refreshFormVisuals:() => { ctx.visualRefreshCount++; },
    updateTransferPreview:() => ctx.updateTransactionCurrency(),
    updateAccountCurrency:() => {}, loadLedgerHealth:async () => {}, loadRateStatus:async () => {},
    queueMicrotask:callback => callback(),
    $(selector) {
      if (selector === '#transaction-form' || selector === '.modal') return ctx.activeForm;
      if (selector.includes('[name="amount"]')) return ctx.activeForm?.elements.amount;
      if (!surfaces.has(selector)) surfaces.set(selector, {});
      return surfaces.get(selector);
    },
    api:async (_path, options) => ({ ...JSON.parse(options.body).state, revision:ctx.state.revision + 1 }),
  });
  for (const name of ['esc', 'expenseCategories', 'incomeCategories']) {
    vm.runInContext(source.match(new RegExp(`const ${name} = [^\\n]+`))[0], ctx);
  }
  for (const name of ['field', 'selectField', 'footer']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^\\n]+`))[0], ctx);
  }
  vm.runInContext(section('function updateTransactionCurrency()', 'function updateSubscriptionCurrency()'), ctx);
  vm.runInContext(section('function transactionDefaults(', 'function providerFor('), ctx);
  vm.runInContext(section('async function commit(', 'function formError('), ctx);
  vm.runInContext(section("document.addEventListener('submit',", "document.addEventListener('compositionend',"), ctx);
  const submit = async (again = false) => listeners.get('submit')[0]({
    target:ctx.activeForm, preventDefault() {}, submitter:again ? ctx.activeForm.submitter : { value:'' },
  });
  const fire = (name, event) => listeners.get(name)?.forEach(callback => callback(event));
  return { ctx, storage, submit, fire };
}

test('new entry defaults are isolated by type, survive historical categories and safely fall back after account deletion', () => {
  const { ctx } = renderer(fixture([expense('old')]));
  ctx.rememberTransactionDefaults({ type:'expense', accountId:'bank', category:'历史分类' });
  ctx.rememberTransactionDefaults({ type:'income', accountId:'usd', category:'工资薪资' });
  ctx.transactionModal();
  assert.equal(ctx.activeForm.elements.accountId.value, 'bank');
  assert.equal(ctx.activeForm.elements.category.value, '历史分类');
  const firstSubmit = /<button\b(?=[^>]*\btype="submit")[^>]*>/.exec(ctx.html)[0];
  assert.doesNotMatch(firstSubmit, /name="saveMode"/, 'plain Enter must use the ordinary save button');
  ctx.transactionModal(undefined, 'income');
  assert.equal(ctx.activeForm.elements.accountId.value, 'usd');
  assert.equal(ctx.activeForm.elements.category.value, '工资薪资');
  ctx.rememberTransactionDefaults({ type:'expense', accountId:'deleted', category:'购物消费' });
  ctx.transactionModal();
  assert.equal(ctx.activeForm.elements.accountId.value, 'cash');
  ctx.transactionModal('old');
  assert.equal(ctx.activeForm.elements.accountId.value, 'cash');
  assert.equal(ctx.activeForm.elements.category.value, '购物消费');
  assert.doesNotMatch(ctx.html, /保存并再记一笔/);
});

test('blocked or malformed localStorage never prevents opening or saving an entry', async () => {
  const { ctx, storage, submit } = renderer();
  storage.set('moneylab-transaction-defaults-expense', '{broken');
  assert.doesNotThrow(() => ctx.transactionModal());
  ctx.localStorage.getItem = ctx.localStorage.setItem = () => { throw new Error('storage blocked'); };
  assert.doesNotThrow(() => ctx.transactionModal());
  ctx.activeForm.elements.amount.value = '1.01';
  await submit();
  assert.equal(ctx.state.transactions[0].amount, 101);
  assert.equal(ctx.error, undefined);
});

test('title suggestions are recent, unique, capped at thirty and escaped; older exact titles can still select a category', () => {
  const rows = Array.from({ length:205 }, (_, index) => expense('tx' + index, { title:'历史' + index }));
  rows.push(expense('latest', { title:'<img src=x>&"', category:'自定义<分类>' }));
  const { ctx, fire } = renderer(fixture(rows));
  ctx.transactionModal();
  const suggestions = ctx.recentTransactionTitles('expense');
  assert.equal(suggestions.length, 30);
  assert.equal(suggestions[0].id, 'latest');
  assert.equal(new Set(suggestions.map(row => row.title)).size, 30);
  assert.match(ctx.html, /value="&lt;img src=x&gt;&amp;&quot;"/);
  assert.doesNotMatch(ctx.html, /<img src=x>/);
  assert.doesNotMatch(ctx.html, /name="title"[^>]*required/);
  const field = ctx.activeForm.elements.title;
  field.value = '历史0';
  fire('input', { target:field });
  assert.equal(ctx.activeForm.elements.category.value, '购物消费');
  ctx.activeForm.elements.category.value = '医疗健康';
  field.value = '<img src=x>&"';
  fire('change', { target:field });
  assert.equal(ctx.activeForm.elements.category.value, '医疗健康', 'explicit category is preserved');
});

test('save-and-continue uses exact units and title fallback, retains defaults and clears the next draft', async () => {
  const { ctx, storage, submit } = renderer();
  ctx.transactionModal();
  Object.assign(ctx.activeForm.elements.amount, { value:'12.34' });
  ctx.activeForm.elements.accountId.value = 'bank';
  ctx.activeForm.elements.category.value = '购物消费';
  ctx.activeForm.elements.date.value = '2026-11-08';
  ctx.activeForm.elements.note.value = '第一笔备注';
  await submit(true);
  assert.equal(ctx.state.transactions[0].amount, 1234);
  assert.equal(ctx.state.transactions[0].title, '购物消费');
  assert.equal(ctx.activeForm.elements.accountId.value, 'bank');
  assert.equal(ctx.activeForm.elements.category.value, '购物消费');
  assert.equal(ctx.activeForm.elements.date.value, '2026-11-08');
  for (const name of ['amount', 'title', 'note']) assert.equal(ctx.activeForm.elements[name].value, '');
  assert.equal(ctx.activeForm.focused, 'amount');
  assert.equal(ctx.closeCount, 1);
  assert.equal(JSON.parse(storage.get('moneylab-transaction-defaults-expense')).accountId, 'bank');
});

test('a real 409 commit refreshes revision while preserving the draft and never reopening or remembering it', async () => {
  const { ctx, storage, submit } = renderer();
  ctx.transactionModal();
  const form = ctx.activeForm;
  form.elements.amount.value = '9.99';
  form.elements.title.value = '保留草稿';
  form.elements.note.value = '不要丢失';
  const latest = structuredClone(ctx.state);
  latest.revision = 7;
  let writes = 0;
  ctx.api = async (_path, options) => {
    if (options) { writes++; throw Object.assign(new Error('conflict'), { status:409 }); }
    return latest;
  };
  await submit(true);
  assert.equal(writes, 1);
  assert.equal(ctx.state.revision, 7);
  assert.equal(ctx.activeForm, form);
  assert.equal(form.elements.title.value, '保留草稿');
  assert.equal(form.elements.amount.value, '9.99');
  assert.equal(form.elements.note.value, '不要丢失');
  assert.equal(ctx.openCount, 1);
  assert.equal(ctx.closeCount, 0);
  assert.equal(storage.size, 0);
  assert.match(ctx.error, /填写已保留/);
  assert.equal(ctx.busy, false);
  assert.ok(ctx.submitButtons.every(button => !button.disabled));
});

test('Ctrl+Enter requests the continue submitter only for a new amount/title field, and date buttons use Beijing calendar dates', () => {
  const { ctx, fire } = renderer();
  ctx.transactionModal();
  const form = ctx.activeForm;
  fire('keydown', { target:form.elements.amount, ctrlKey:true, key:'Enter', preventDefault() {} });
  assert.equal(form.requestedSubmitter, form.submitter);
  form.requestedSubmitter = null;
  form.dataset.id = 'edited';
  fire('keydown', { target:form.elements.title, ctrlKey:true, key:'Enter', preventDefault() {} });
  assert.equal(form.requestedSubmitter, null);
  const button = { dataset:{ transactionDate:'yesterday' }, closest:() => form };
  fire('click', { target:{ closest:() => button } });
  assert.equal(form.elements.date.value, '2026-11-08');
  button.dataset.transactionDate = 'today';
  fire('click', { target:{ closest:() => button } });
  assert.equal(form.elements.date.value, '2026-11-09');
});

test('switching entry type clears an amount whose remembered account changes currency', () => {
  const { ctx } = renderer();
  ctx.rememberTransactionDefaults({ type:'income', accountId:'usd', category:'工资薪资' });
  ctx.transactionModal();
  ctx.activeForm.elements.amount.value = '123.45';
  ctx.activeForm.elements.title.value = '保留标题';
  ctx.id = '';
  ctx.target = { dataset:{ type:'income' } };
  const branch = section("case'transaction-type':{", "case'add-account':");
  vm.runInContext(`switch ('transaction-type') { ${branch} }`, ctx);
  assert.equal(ctx.activeForm.elements.accountId.value, 'usd');
  assert.equal(ctx.activeForm.elements.amount.value, '');
  assert.equal(ctx.activeForm.elements.title.value, '保留标题');
});
