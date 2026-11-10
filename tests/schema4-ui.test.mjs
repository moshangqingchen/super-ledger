import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as engine from '../engine.mjs';
import * as planning from '../assets/ledger-planning.mjs';
import * as currencies from '../currencies.mjs';
import { subscriptionPeriodLabel } from '../subscription-overview.mjs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
function fixture() {
  const state = engine.makeEmptyState();
  state.accounts = [{ id: 'cash', name: '现金', type: '现金', color: '#123456', openingBalance: 1000000 }];
  return state;
}
function renderer(state = fixture()) {
  const listeners = {};
  const env = {
    ...engine, ...planning, ...currencies, subscriptionPeriodLabel, state, structuredClone,
    ratesRefreshPromise: null, hidden: false, month: '2026-11',
    uid: () => 'test-id', today: () => '2026-11-09',
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-09T04:00:00Z'])); } },
    syncSubscriptionSchedule: () => {}, readLinkedAccounts: () => [],
    accountById: id => env.state.accounts.find(account => account.id === id),
    document: { addEventListener: (name, handler) => { listeners[name] = handler; } },
    FormData: class { constructor(form) { this.values = form.values; } get(name) { return this.values[name]; } has(name) { return Object.hasOwn(this.values, name); } },
    icon: () => '', modal: (_title, _description, html) => { env.html = html; },
    formError: message => { env.error = message; }, customCategoriesModal: () => { env.reopened = true; },
    commit: async next => { env.state = next; env.saved = structuredClone(next); return true; },
    monthControl: () => '', monthLabel: () => env.month,
    subscriptionMoney: sub => currencies.formatMoney(sub.amount, 'CNY'),
    subscriptionTime: (sub, due) => String(engine.subscriptionDueHour(sub, due)).padStart(2, '0') + ':00',
  };
  const declarations = [source.match(/^const esc = .+$/m)[0],
    ...['field', 'footer'].map(name => source.match(new RegExp(`function ${name}\\([^\\n]+`))[0]),
    section('function budgetModal()', 'function confirmModal('),
    section('function calendarModal()', 'async function download('),
    section("document.addEventListener('submit',", "document.addEventListener('compositionend',"),
  ].join('\n');
  const api = new Function('environment', `with(environment){ ${declarations}; return {budgetModal, customCategoriesModal, calendarModal}; }`)(env);
  return { env, api, submit: form => listeners.submit({ target: form, preventDefault() {} }) };
}

test('budget modal escapes custom and orphan names; submit preserves unknown settings and rejects negative money', async () => {
  const state = fixture();
  state.settings.customCategories = { expense: ['猫咪<用品>'], income: [] };
  state.settings.categoryBudgets = { '旧预算"': 100 };
  state.settings.extension = { retained: true };
  const { env, api, submit } = renderer(state);
  api.budgetModal();
  assert.match(env.html, /猫咪&lt;用品&gt;（元）/);
  assert.match(env.html, /data-budget-category="旧预算&quot;"/);
  const rows = [{ value: '12.34', dataset: { budgetCategory: '猫咪<用品>' } }, { value: '0', dataset: { budgetCategory: '旧预算"' } }];
  const form = { id: 'budget-form', dataset: {}, values: { budget: '50.01' }, querySelectorAll: () => rows };
  await submit(form);
  assert.equal(env.saved.schemaVersion, 4);
  assert.equal(env.saved.settings.monthlyBudget, 5001);
  assert.deepEqual(Object.entries(env.saved.settings.categoryBudgets), [['猫咪<用品>', 1234]]);
  assert.deepEqual(env.saved.settings.extension, { retained: true });
  const before = structuredClone(env.saved);
  rows[0].value = '-1'; await submit(form);
  assert.match(env.error, /不能为负数/);
  assert.deepEqual(env.saved, before);
  rows[0].value = ''; await submit(form);
  assert.equal(Object.hasOwn(env.saved.settings, 'categoryBudgets'), false);
});

test('custom category management uses unique accessible field IDs and rejects duplicate or built-in entries', async () => {
  const { env, api, submit } = renderer();
  api.customCategoriesModal();
  assert.match(env.html, /for="field-category-expense"/);
  assert.match(env.html, /for="field-category-income"/);
  const form = { id: 'custom-category-expense', dataset: { type: 'expense' }, values: { 'category-expense': '咖啡<豆>' } };
  await submit(form);
  assert.deepEqual(env.saved.settings.customCategories, { expense: ['咖啡<豆>'], income: [] });
  assert.equal(env.saved.schemaVersion, 4);
  await submit(form); assert.match(env.error, /重复/);
  form.values['category-expense'] = '工资薪资';
  await submit(form); assert.match(env.error, /内置/);
  api.customCategoriesModal();
  assert.match(env.html, /data-category="咖啡&lt;豆&gt;"/);
  assert.doesNotMatch(env.html, /咖啡<豆>/);
});

test('wish editor submit writes or clears deadline without changing money units', async () => {
  const { env, submit } = renderer();
  const form = { id: 'goal-form', dataset: {}, values: { name: '心愿', target: '100.01', saved: '0.01', deadline: '2027-02-28' } };
  await submit(form);
  assert.equal(env.saved.goals[0].deadline, '2027-02-28');
  assert.equal(env.saved.goals[0].target, 10001);
  form.dataset.id = 'test-id'; form.values.deadline = '';
  await submit(form);
  assert.equal(Object.hasOwn(env.saved.goals[0], 'deadline'), false);
  assert.equal(env.saved.goals[0].saved, 1);
  assert.equal(env.saved.schemaVersion, 4, 'version does not downgrade after removing the last field');
});

test('calendar skips non-grid months and shows escaped yearly price labels', () => {
  const state = fixture();
  state.subscriptions = [{ id: 'annual', name: '<年度>', amount: 10001, startDate: '2026-01-31', billingDay: 31, recurring: true, active: true, intervalMonths: 12 }];
  const { env, api } = renderer(state);
  api.calendarModal(); assert.doesNotMatch(env.html, /calendar-amount/);
  env.month = '2027-01'; api.calendarModal();
  assert.match(env.html, /&lt;年度&gt;/);
  assert.match(env.html, /<small class="money">¥ 100.01 \/ 年/);
  env.hidden = true; api.calendarModal(); assert.doesNotMatch(env.html, /100.01/);
});

test('actual subscription submit wires cycle changes to skip past months and omits monthly/default fields', async () => {
  const state = fixture();
  state.schemaVersion = 4;
  state.subscriptions = [{ id: 'yearly', name: '年费', amount: 10001, accountId: 'cash', category: '会员订阅',
    startDate: '2026-01-31', billingDay: 31, recurring: true, active: true, intervalMonths: 12,
    processedOccurrences: ['yearly:2026-01'], icon: 'repeat', color: '#123456', expiresOn: '' }];
  const { env, submit } = renderer(state);
  const form = { id: 'subscription-form', dataset: { id: 'yearly' },
    values: { name: '年费', amount: '100.01', accountId: 'cash', startDate: '2026-01-31', recurring: 'on',
      intervalMonths: '1', color: '#123456', icon: 'repeat', expiresOn: '' },
    elements: { startDate: {}, startHour: { value: '0' }, billingDay: { value: '31' }, billingHour: { value: '0' }, expiresOn: { defaultValue: '' } } };
  await submit(form);
  assert.equal(env.error, undefined);
  const sub = env.saved.subscriptions[0];
  assert.equal(Object.hasOwn(sub, 'intervalMonths'), false);
  assert.equal(sub.processedOccurrences.length, 10);
  assert.ok(sub.processedOccurrences.includes('yearly:2026-01'));
  assert.equal(engine.nextSubscriptionDue(sub, '2026-11-09'), '2026-11-30');
  form.values.intervalMonths = '6';
  await submit(form);
  assert.equal(env.saved.subscriptions[0].intervalMonths, 6);
  delete form.values.recurring;
  await submit(form);
  assert.equal(Object.hasOwn(env.saved.subscriptions[0], 'intervalMonths'), false);
});
