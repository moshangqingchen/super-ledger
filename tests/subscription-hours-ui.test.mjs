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

function scheduleEditor(subscription) {
  const html = subscriptionForm(subscription);
  const form = {
    dataset: {
      followBillingDay: /data-follow-billing-day="([^"]+)"/.exec(html)[1],
      followBillingHour: /data-follow-billing-hour="([^"]+)"/.exec(html)[1],
    },
    elements: {},
  };
  const initial = {
    startDate: subscription?.startDate || '2026-11-07',
    startHour: String(selectedHour(html, 'startHour')),
    billingDay: String(subscription?.billingDay || 7),
    billingHour: String(selectedHour(html, 'billingHour')),
  };
  for (const [name, value] of Object.entries(initial)) form.elements[name] = { name, value, closest: () => form };
  const listeners = {};
  const handler = /function syncSubscriptionSchedule\(target\)\{[\s\S]*?\n\}/.exec(source)[0];
  const wiring = /for\(const event of \['input','change'\]\)document\.addEventListener\(event,e=>syncSubscriptionSchedule\(e.target\)\);/.exec(source)[0];
  new Function('document', `${handler}\n${wiring}`)({ addEventListener: (event, listener) => { listeners[event] = listener; } });
  return {
    form,
    update(name, value, event = 'change') {
      const target = form.elements[name];
      target.value = value;
      listeners[event]({ target });
    },
  };
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

test('new monthly schedules follow first-booking date and hour through input and change events', () => {
  const editor = scheduleEditor();
  editor.update('startDate', '2026-12-31', 'input');
  assert.equal(editor.form.elements.billingDay.value, '31');
  editor.update('startHour', '0');
  assert.equal(editor.form.elements.billingHour.value, '0');
  editor.update('startDate', '', 'input');
  assert.equal(editor.form.elements.billingDay.value, '31', 'Clearing a date must not overwrite a valid monthly day');
  editor.update('startDate', '2027-02-28');
  assert.equal(editor.form.elements.billingDay.value, '28');
  editor.update('startHour', '23', 'input');
  assert.equal(editor.form.elements.billingHour.value, '23');
});

test('manual monthly day and hour changes independently stop following the first booking', () => {
  const editor = scheduleEditor();
  editor.update('billingDay', '15', 'input');
  editor.update('billingDay', '7');
  editor.update('startDate', '2026-11-20');
  assert.equal(editor.form.elements.billingDay.value, '7', 'Returning to the same day still preserves an explicit monthly choice');
  editor.update('startHour', '23');
  assert.equal(editor.form.elements.billingHour.value, '23', 'The hour still follows when only the day was overridden');
  editor.update('billingHour', '5');
  editor.update('startHour', '0', 'input');
  assert.equal(editor.form.elements.billingHour.value, '5');
});

test('editing preserves existing independent schedule fields while matching fields keep following', () => {
  const distinct = scheduleEditor({ id: 'member', startDate: '2026-10-31', startHour: 23, billingDay: 15, billingHour: 0, recurring: true });
  distinct.update('startDate', '2026-11-20', 'input');
  distinct.update('startHour', '12');
  assert.equal(distinct.form.elements.billingDay.value, '15');
  assert.equal(distinct.form.elements.billingHour.value, '0');
  const matching = scheduleEditor({ id: 'member', startDate: '2026-10-31', billingDay: 31, recurring: true });
  matching.update('startDate', '2026-11-30');
  matching.update('startHour', '12', 'input');
  assert.equal(matching.form.elements.billingDay.value, '30');
  assert.equal(matching.form.elements.billingHour.value, '12');
  matching.update('billingHour', '18');
  matching.update('startDate', '2026-12-05');
  matching.update('startHour', '0');
  assert.equal(matching.form.elements.billingDay.value, '5');
  assert.equal(matching.form.elements.billingHour.value, '18');
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
