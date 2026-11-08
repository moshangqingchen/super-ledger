import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEmptyState, validateState } from '../engine.mjs';
import { renderSubscriptionChart } from '../subscription-chart.js';

const NOW = new Date('2026-11-07T02:00:00Z');
const sub = (id, extra = {}) => ({
  id, name: id, amount: 8000, accountId: 'cash', category: '会员订阅',
  startDate: '2026-11-07', startHour: 18, billingDay: 7, billingHour: 18,
  recurring: true, active: true, color: '#123456', icon: 'spark', processedOccurrences: [],
  expiresOn: '2026-11-10', ...extra,
});
function fixture(subscriptions) {
  const state = makeEmptyState();
  state.schemaVersion = 3;
  state.accounts = [{ id: 'cash', name: '共享账户', type: '现金', openingBalance: 10000, color: '#123456' }];
  state.subscriptions = subscriptions;
  validateState(state);
  return state;
}
function render(state, visibleIds = state.subscriptions.map(row => row.id), hidden = false) {
  return renderSubscriptionChart({
    state, visibleIds, hidden, now: NOW,
    icon: () => '<svg></svg>',
    subIcon: () => '<span class="service-logo"><img src="/assets/brands/chatgpt.svg" alt=""></span>',
    accountLogo: () => '<span class="account-logo"></span>',
  });
}
const count = (html, className) => [...html.matchAll(new RegExp(`class="${className}(?:[ "]|$)`, 'g'))].length;

test('TT voice keeps its dark brand background in every chart logo without changing logo sizing', () => {
  const css = readFileSync(new URL('../subscription-polish.css', import.meta.url), 'utf8');
  const rule = /\.subscription-chart\s+\.service-logo\[data-service="ttvoice"\]\s*\{([^}]+)\}/.exec(css);
  assert.ok(rule, 'The service-specific chart selector outranks the generic chart logo background');
  assert.match(rule[1], /background\s*:\s*#626ad4\s*;/);
  assert.match(rule[1], /border-color\s*:\s*#626ad4\s*;/);
  assert.doesNotMatch(rule[1], /(?:padding|width|height|flex-basis)\s*:/);
});

test('chart filtering applies to service statistics while a shared account reserves all active next fees', () => {
  const state = fixture([sub('visible'), sub('filtered-out')]);
  const before = JSON.stringify(state);
  const html = render(state, ['visible']);
  assert.equal(count(html, 'subscription-chart-service'), 1);
  assert.equal(count(html, 'subscription-readiness-card'), 1);
  assert.match(html, /data-chart-stat="upcoming"[\s\S]*?<b>1 <em>项/);
  assert.match(html, /下一笔费用合计 <b class="money">¥ 160\.00<\/b>/);
  assert.match(html, /合计还差 <b class="money">¥ 60\.00<\/b>/);
  assert.match(html, /同账户全部启用订阅的各下一笔费用，包含当前筛选外的订阅/);
  assert.match(html, /data-chart-stat="shortfall"[\s\S]*?<b>0 <em>项/);
  assert.equal(JSON.stringify(state), before);
});

test('star dates and summary stay consistent for paused, late, missing and single-booking deadlines', () => {
  const state = fixture([
    sub('paused', { active: false }),
    sub('later', { expiresOn: '2026-12-20' }),
    sub('expired', { startDate: '2026-10-01', expiresOn: '2026-11-06' }),
    sub('single-unset', { recurring: false, expiresOn: '' }),
  ]);
  const paused = render(state, ['paused']);
  assert.match(paused, /class="orbit-node is-paused"/);
  assert.match(paused, /data-chart-stat="upcoming"[\s\S]*?<b>1 <em>项/);
  assert.equal(count(paused, 'subscription-readiness-card'), 0);
  for (const id of ['later', 'expired', 'single-unset']) {
    const html = render(state, [id]);
    assert.equal(count(html, 'orbit-node'), 0, id);
    assert.equal(count(html, 'subscription-chart-service'), 1, id);
  }
  const single = render(state, ['single-unset']);
  assert.match(single, /2026-11-07 18:00/);
  assert.equal(count(single, 'subscription-readiness-card'), 1);
});

test('crowded stars keep real dates and every service remains in the complete list', () => {
  const state = fixture(Array.from({ length: 24 }, (_, index) => sub('same-' + index)));
  const html = render(state);
  const plotted = count(html, 'orbit-node');
  assert.ok(plotted > 0 && plotted <= 8);
  assert.equal(count(html, 'subscription-chart-service'), 24);
  assert.match(html, new RegExp(`星图显示 ${plotted} / 24 项提醒`));
  const dates = [...html.matchAll(/class="orbit-node[^>]*data-date="([^"]+)" data-days="(\d+)"/g)];
  assert.equal(dates.length, plotted);
  for (const [, date, days] of dates) {
    assert.equal(date, '2026-11-10');
    assert.equal(days, '3');
  }
});

test('privacy omits monetary values, coverage ratios and amount-bearing accessibility text from the DOM', () => {
  const state = fixture([sub('private', { amount: 8123 })]);
  state.accounts[0].openingBalance = 6234;
  const html = render(state, ['private'], true);
  assert.match(html, /aria-label="金额已隐藏">••••/);
  for (const amount of ['81.23', '62.34', '18.89']) assert.ok(!html.includes(amount), amount);
  assert.ok(!html.includes('coverage-track'));
  assert.ok(!html.includes('aria-valuenow'));
  assert.ok(!html.includes('覆盖比例'));
  assert.ok(!html.includes('width:'));
});

test('read-only chart escapes names, retains actual Beijing dates and has an actionable empty state', () => {
  const state = fixture([sub('escaped', { name: '<b>名称</b>', startDate: '2026-11-06', startHour: 23, expiresOn: '2026-11-08' })]);
  const html = render(state);
  assert.match(html, /&lt;b&gt;名称&lt;\/b&gt;/);
  assert.ok(!html.includes('<b>名称</b>'));
  assert.match(html, /2026-11-06 23:00/);
  assert.match(html, /北京时间/);
  const empty = render(state, []);
  assert.match(empty, /subscription-chart-empty/);
  assert.match(empty, /data-action="add-subscription"/);
  assert.equal(count(empty, 'subscription-chart-service'), 0);
  assert.equal(count(empty, 'subscription-readiness-card'), 0);
});
