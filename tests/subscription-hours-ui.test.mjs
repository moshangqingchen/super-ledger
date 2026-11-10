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
  const customInput = /<input[^>]*name="customBilling"[^>]*>/.exec(html)[0];
  const panel = { hidden: /\shidden(?:\s|>)/.test(/<div id="subscription-monthly-fields"[^>]*>/.exec(html)[0]) };
  const toggle = { hidden: /\shidden(?:\s|>)/.test(/<label id="subscription-monthly-toggle"[^>]*>/.exec(html)[0]) };
  const extraControls = Object.fromEntries(['#subscription-interval-field', 'label[for="field-billingDay"]', 'label[for="field-billingHour"]', '#subscription-schedule-label'].map(key => [key, {}]));
  const form = {
    dataset: { id: subscription?.id || '' },
    elements: {},
    querySelector: selector => selector === '#subscription-monthly-fields' ? panel : selector === '#subscription-monthly-toggle' ? toggle : extraControls[selector],
  };
  const initial = {
    intervalMonths: String(subscription?.intervalMonths || 1),
    expiresOn: subscription?.expiresOn || '',
    startDate: subscription?.startDate || '2026-11-07',
    startHour: String(selectedHour(html, 'startHour')),
    billingDay: String(subscription?.billingDay || 7),
    billingHour: String(selectedHour(html, 'billingHour')),
  };
  for (const [name, value] of Object.entries(initial)) form.elements[name] = { name, value, closest: () => form };
  form.elements.recurring = { name: 'recurring', checked: subscription?.recurring ?? true, closest: () => form };
  form.elements.customBilling = {
    name: 'customBilling', checked: /\schecked(?:\s|>)/.test(customInput), closest: () => form,
    setAttribute(name, value) { this[name] = value; },
  };
  const listeners = {};
  const handler = /function syncSubscriptionSchedule\(target\)\{[\s\S]*?\n\}/.exec(source)[0];
  const wiring = /for\(const event of \['input','change'\]\)document\.addEventListener\(event,e=>syncSubscriptionSchedule\(e.target\)\);/.exec(source)[0];
  const sync = new Function('document', `${handler}\n${wiring}\nreturn syncSubscriptionSchedule;`)({ addEventListener: (event, listener) => { listeners[event] = listener; } });
  sync(form.elements.startDate);
  return {
    form, panel, toggle, sync, extraControls,
    update(name, value, event = 'change') {
      const target = form.elements[name];
      if (typeof value === 'boolean') target.checked = value;
      else target.value = value;
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

test('new monthly settings stay collapsed and follow first-booking date and hour through input and change events', () => {
  const editor = scheduleEditor();
  assert.equal(editor.panel.hidden, true);
  assert.equal(editor.form.elements.customBilling.checked, false);
  assert.equal(editor.form.elements.billingDay.disabled, true);
  assert.equal(editor.form.elements.billingHour.disabled, true);
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

test('expanding monthly settings preserves independent values and collapsing restores first-booking values', () => {
  const editor = scheduleEditor();
  editor.update('customBilling', true);
  assert.equal(editor.panel.hidden, false);
  assert.equal(editor.form.elements.billingDay.disabled, false);
  assert.equal(editor.form.elements.billingHour.disabled, false);
  editor.update('billingDay', '15', 'input');
  editor.update('startDate', '2026-11-20');
  assert.equal(editor.form.elements.billingDay.value, '15');
  editor.update('startHour', '23');
  assert.equal(editor.form.elements.billingHour.value, '10', 'Both fields are independent while the section is expanded');
  editor.update('billingHour', '5');
  editor.update('startHour', '0', 'input');
  assert.equal(editor.form.elements.billingHour.value, '5');
  editor.update('customBilling', false, 'input');
  assert.equal(editor.panel.hidden, true);
  assert.equal(editor.form.elements.billingDay.value, '20');
  assert.equal(editor.form.elements.billingHour.value, '0');
  editor.update('startDate', '2026-12-31');
  editor.update('startHour', '17');
  assert.equal(editor.form.elements.billingDay.value, '31');
  assert.equal(editor.form.elements.billingHour.value, '17');
});

test('editing different monthly values opens the section and matching schedules stay collapsed', () => {
  const distinct = scheduleEditor({ id: 'member', startDate: '2026-10-31', startHour: 23, billingDay: 15, billingHour: 0, recurring: true });
  assert.equal(distinct.panel.hidden, false);
  distinct.update('startDate', '2026-11-20', 'input');
  distinct.update('startHour', '12');
  assert.equal(distinct.form.elements.billingDay.value, '15');
  assert.equal(distinct.form.elements.billingHour.value, '0');
  const dayOnly = scheduleEditor({ id: 'member', startDate: '2026-10-31', billingDay: 15, recurring: true });
  assert.equal(dayOnly.panel.hidden, false);
  dayOnly.update('startHour', '12');
  assert.equal(dayOnly.form.elements.billingHour.value, '0');
  const matching = scheduleEditor({ id: 'member', startDate: '2026-10-31', billingDay: 31, recurring: true });
  assert.equal(matching.panel.hidden, true);
  matching.update('startDate', '2026-11-30');
  matching.update('startHour', '12', 'input');
  assert.equal(matching.form.elements.billingDay.value, '30');
  assert.equal(matching.form.elements.billingHour.value, '12');
  matching.update('customBilling', true);
  matching.update('billingHour', '18');
  matching.update('startDate', '2026-12-05');
  matching.update('startHour', '0');
  assert.equal(matching.form.elements.billingDay.value, '30');
  assert.equal(matching.form.elements.billingHour.value, '18');
});

test('single subscriptions hide monthly settings and restore their independent values when recurring resumes', () => {
  const previewSource = /function updateSubscriptionExpiryPreview\(\)\{[\s\S]*?\n\}/.exec(source)[0];
  const editor = scheduleEditor({ id: 'member', startDate: '2026-11-07', startHour: 11, billingDay: 7, billingHour: 20, recurring: false });
  const form = editor.form;
  const elements = form.elements;
  const preview = {};
  let scheduled;
  const update = new Function('$', 'state', 'subscriptionStatus', 'expiryBanner', 'syncSubscriptionSchedule', `${previewSource}; return updateSubscriptionExpiryPreview;`)(
    selector => selector === '#subscription-form' ? form : preview,
    { subscriptions: [] },
    sub => { scheduled = sub; return {}; },
    () => '到期提醒',
    editor.sync,
  );
  update();
  assert.equal(elements.billingDay.disabled, true);
  assert.equal(elements.billingHour.disabled, true);
  assert.equal(scheduled.startHour, 11);
  assert.equal(scheduled.billingHour, 20);
  assert.equal(editor.panel.hidden, true);
  assert.equal(editor.toggle.hidden, true);
  assert.equal(elements.customBilling.disabled, true);
  editor.update('recurring', true);
  update();
  assert.equal(editor.panel.hidden, false);
  assert.equal(editor.toggle.hidden, false);
  assert.equal(elements.billingHour.disabled, false);
  assert.equal(elements.billingHour.value, '20');
});


test('cycle selector changes monthly labels and stays hidden for one-time subscriptions', () => {
  const editor = scheduleEditor();
  assert.match(subscriptionForm(), /name="intervalMonths"/);
  editor.update('intervalMonths', '12');
  assert.equal(editor.extraControls['label[for="field-billingDay"]'].textContent, '扣账日');
  assert.equal(editor.extraControls['label[for="field-billingHour"]'].textContent, '扣账时间');
  assert.equal(editor.panel.hidden, true, 'cycle selection does not expand custom schedule');
  editor.update('recurring', false);
  assert.equal(editor.form.elements.intervalMonths.disabled, true);
  assert.equal(editor.extraControls['#subscription-interval-field'].hidden, true);
  editor.update('recurring', true);
  editor.update('intervalMonths', '1');
  assert.equal(editor.extraControls['label[for="field-billingDay"]'].textContent, '每月扣账日');
});
