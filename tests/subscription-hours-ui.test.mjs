import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const modalSource = /function subscriptionModal\(id\)\{[\s\S]*?\n\}/.exec(source)[0];
const fieldSource = /function field\([^\n]+/.exec(source)[0];
const selectSource = /function selectField\([^\n]+/.exec(source)[0];

function subscriptionForm(subscription) {
  let html;
  const environment = {
    state: { accounts: [{ id: 'cash' }], subscriptions: subscription ? [subscription] : [] },
    ensureAccount: () => true,
    providerFor: () => null,
    savedSubscriptionAccounts: () => [],
    subscriptionCatalog: [],
    beijingDateTime: () => ({ date: '2026-11-07', hour: 10 }),
    esc: value => String(value),
    modal: (title, subtitle, content) => { html = content; },
    amountInput: () => '10',
    accountCurrency: () => 'CNY',
    accountById: () => ({ id: 'cash' }),
    accountOptions: () => [['cash', '现金']],
    linkedAccountRow: () => '',
    icon: () => '',
    footer: () => '',
    updateSubscriptionCurrency: () => {},
    updateLinkedAccountEditor: () => {},
    updateSubscriptionExpiryPreview: () => {},
  };
  const open = new Function('environment', `with(environment){${fieldSource}\n${selectSource}\n${modalSource}\nreturn subscriptionModal;}`)(environment);
  open(subscription?.id);
  return html;
}

function selectedHour(html, name) {
  const select = new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)[1];
  assert.equal((select.match(/<option /g) || []).length, 24);
  return Number(/<option value="(\d+)" selected>/.exec(select)[1]);
}

test('new subscriptions default to the Beijing date and hour in both schedule controls', () => {
  const html = subscriptionForm();
  assert.match(html, /name="startDate"[^>]*value="2026-11-07"/);
  assert.equal(selectedHour(html, 'startHour'), 10);
  assert.equal(selectedHour(html, 'billingHour'), 10);
  assert.match(html, /北京时间（UTC\+8）/);
});

test('editing legacy and hourly subscriptions preserves midnight and distinct first and monthly hours', () => {
  const legacy = { id: 'member', startDate: '2026-10-31', billingDay: 31, recurring: true };
  const oldHtml = subscriptionForm(legacy);
  assert.equal(selectedHour(oldHtml, 'startHour'), 0);
  assert.equal(selectedHour(oldHtml, 'billingHour'), 0);
  const hourlyHtml = subscriptionForm({ ...legacy, startHour: 23, billingHour: 0 });
  assert.equal(selectedHour(hourlyHtml, 'startHour'), 23);
  assert.equal(selectedHour(hourlyHtml, 'billingHour'), 0);
});

test('single subscriptions disable the monthly hour and keep both hour values in the preview', () => {
  const previewSource = /function updateSubscriptionExpiryPreview\(\)\{[\s\S]*?\n\}/.exec(source)[0];
  const elements = {
    expiresOn: { value: '' }, startDate: { value: '2026-11-07' },
    startHour: { value: '11' }, billingDay: { value: '7' }, billingHour: { value: '20' },
    recurring: { checked: false },
  };
  const form = { dataset: {}, elements }, preview = {};
  let scheduled;
  const update = new Function('$', 'state', 'subscriptionStatus', 'expiryBanner', `${previewSource}; return updateSubscriptionExpiryPreview;`)(
    selector => selector === '#subscription-form' ? form : preview,
    { subscriptions: [] },
    sub => { scheduled = sub; return {}; },
    () => '到期提醒',
  );
  update();
  assert.equal(elements.billingDay.disabled, true);
  assert.equal(elements.billingHour.disabled, true);
  assert.equal(scheduled.startHour, 11);
  assert.equal(scheduled.billingHour, 20);
  elements.recurring.checked = true;
  update();
  assert.equal(elements.billingHour.disabled, false);
});
