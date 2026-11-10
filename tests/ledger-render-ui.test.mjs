import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as insights from '../assets/ledger-insights.mjs';
import { transactionCnyAmount } from '../engine.mjs';
import { accountCurrency, formatMoney } from '../currencies.mjs';
import { accountLabel } from '../account-presets.mjs';

// Exercise the real renderer without starting a server, touching ledger storage,
// or importing the application's browser startup side effects.
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `renderer section ${start}`);
  return source.slice(from, to);
}
function constant(name) {
  const match = source.match(new RegExp(`^const ${name}\\s*=[^\\r\\n]+`, 'm'));
  assert.ok(match, `renderer constant ${name}`);
  return match[0];
}
const rendererSource = [
  ...['esc', 'expenseCategories', 'incomeCategories', 'categoryIcons', 'accountById',
    'accountName', 'hasForeign', 'totals', 'monthRows', 'monthly', 'periodLabel',
    'monthLabel', 'dateLabel', 'sortedRows'].map(constant),
  section('function statComparison(', 'function subscriptionTime('),
  section('function transactionTable(', 'function overview('),
  section('function isCrossMonthSearch(', 'function accounts('),
  section('function insights(){', 'function goals(){'),
].join('\n');

function fixture() {
  return {
    settings: { monthlyBudget: 300000 },
    accounts: [
      { id: 'cash', name: '现金', type: '现金', openingBalance: 0, color: '#123456' },
      { id: 'usd', name: '美元钱包', type: '现金', openingBalance: 0, color: '#123456', currency: 'USD', cnyRate: '7.2' },
    ],
    transactions: [
      { id: 'old', type: 'expense', title: '咖啡', category: '餐饮美食', accountId: 'cash', amount: 1000, date: '2025-12-12', note: '' },
      { id: 'coffee', type: 'expense', title: '咖啡 <img src=x>', category: '<b>咖啡</b>', accountId: 'cash', amount: 3210, date: '2026-01-08', note: '' },
      { id: 'foreign', type: 'expense', title: '咖啡', category: '<b>咖啡</b>', accountId: 'usd', amount: 125, currency: 'USD', cnyRate: '7.2', date: '2026-01-08', note: '' },
      { id: 'salary', type: 'income', title: '工资', category: '工资薪资', accountId: 'cash', amount: 1850000, date: '2026-01-01', note: '' },
      { id: 'future', type: 'expense', title: '未来', category: '其他支出', accountId: 'cash', amount: 100, date: '2026-01-30', note: '' },
    ],
  };
}

function renderer(overrides = {}) {
  const environment = {
    ...insights, transactionCnyAmount, accountCurrency, formatMoney, accountLabel,
    state: fixture(), month: '2026-01', query: '', filter: 'all',
    accountFilter: '', categoryFilter: '', dateFilter: '', searchScope: 'all', hidden: false,
    today: () => '2026-01-09', yuan: value => formatMoney(value, 'CNY'), icon: () => '',
    heading: () => '', monthControl: () => '', addButton: () => '', demoBanner: () => '',
    empty: () => '<div class="empty"></div>',
    ...overrides,
  };
  const api = new Function('environment', `with(environment){
    ${rendererSource}
    return { filteredTransactions, transactionTable, transactions, transactionFilterTags,
      transactionCategories, clearTransactionFilters, statCards, chart, insights,
      monthlyTrendPanel, goalCard };
  }`)(environment);
  return { api, environment };
}

test('ledger searches all months by default, retains same-day order and renders complete dates', () => {
  const { api, environment } = renderer({ query: '咖啡' });
  assert.deepEqual(api.filteredTransactions().map(row => row.id), ['foreign', 'coffee', 'old']);
  const html = api.transactions();
  assert.match(html, /2025 \/ 12 \/ 12/);
  assert.match(html, /2026 \/ 01 \/ 08/);
  assert.match(html, /共 3 笔 · 全部月份 · 搜索结果/);
  assert.match(html, /data-scope="all" class="selected" aria-pressed="true"/);
  assert.equal((html.match(/class="transaction-day-row"/g) || []).length, 2);
  environment.searchScope = 'month';
  assert.deepEqual(api.filteredTransactions().map(row => row.id), ['foreign', 'coffee']);
  assert.doesNotMatch(api.transactions(), /2025 \/ 12 \/ 12/);
  environment.query = '';
  environment.searchScope = 'all';
  assert.equal(api.filteredTransactions().length, 4);
  assert.doesNotMatch(api.transactions(), /aria-label="搜索范围"/);
});

test('ledger groups filtered rows by day with CNY subtotals and omits placeholder subtitles', () => {
  const { api } = renderer({ query: '咖啡' });
  const html = api.transactionTable(api.filteredTransactions(), true);
  assert.match(html, /2026 年 1 月 8 日 · 周四/);
  assert.match(html, /支出 <b class="money">¥ 41\.10<\/b>/);
  assert.match(html, /收入 <b class="money">¥ 0\.00<\/b>/);
  assert.match(html, /折合 CNY/);
  assert.match(html, /USD 1\.25/);
  assert.match(html, /≈ ¥ 9\.00/);
  assert.match(html, /<b>咖啡 &lt;img src=x&gt;<\/b><\/div>/);
  assert.doesNotMatch(html, /生活的小日常|生活的奖励|<img src=x>/);
  const rows = [
    { ...fixture().transactions[1], note: '<script>note</script>' },
    { ...fixture().transactions[1], id: 'subscription', subscriptionId: 's' },
    { ...fixture().transactions[1], id: 'mobile', mobileCapture: {} },
    { ...fixture().transactions[1], id: 'transfer', type: 'transfer', toAccountId: 'cash' },
  ];
  const details = api.transactionTable(rows);
  assert.match(details, /<small>&lt;script&gt;note&lt;\/script&gt;<\/small>/);
  assert.match(details, /<small>订阅自动记账<\/small>/);
  assert.match(details, /<small>手机通知记账<\/small>/);
  assert.match(details, /<small>账户间流转<\/small>/);
});

test('category, account, type, day and search filters compose with escaped removable chips', () => {
  const { api, environment } = renderer({
    query: '咖啡', filter: 'expense', accountFilter: 'usd',
    categoryFilter: '<b>咖啡</b>', dateFilter: '2026-01-08', searchScope: 'month',
  });
  assert.deepEqual(api.filteredTransactions().map(row => row.id), ['foreign']);
  const html = api.transactionFilterTags();
  for (const key of ['query', 'scope', 'type', 'account', 'category', 'date']) {
    assert.ok(html.includes(`data-filter-key="${key}"`), key);
  }
  assert.match(html, /data-action="clear-transaction-filters"/);
  assert.match(html, /分类：&lt;b&gt;咖啡&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>咖啡<\/b>/);
  assert.ok(api.transactionCategories().includes('<b>咖啡</b>'));
  assert.ok(api.transactionCategories().includes('工资薪资'));
  environment.query = '"><img src=x>';
  assert.match(api.transactionFilterTags(), /&quot;&gt;&lt;img src=x&gt;/);
  api.clearTransactionFilters();
  assert.equal(api.transactionFilterTags(), '');
  assert.equal(environment.searchScope, 'all');
  assert.equal(api.filteredTransactions().length, 4);
});

test('daily expense chart leaves future slots empty and salary does not rescale expense bars', () => {
  const { api, environment } = renderer();
  const html = api.chart();
  assert.equal((html.match(/data-action="insight-day"/g) || []).length, 9);
  assert.equal((html.match(/class="daily-expense-bar"/g) || []).length, 9);
  assert.match(html, /tabindex="0" data-action="insight-day" data-date="2026-01-08"/);
  assert.doesNotMatch(html, /data-date="2026-01-30"/);
  assert.match(html, /class="daily-budget-line"/);
  assert.match(html, /class="daily-income-dot"/);
  const expenseBars = value => [...value.matchAll(/<rect class="daily-expense-bar"[^>]+/g)].map(match => match[0]);
  environment.state.transactions.find(row => row.id === 'salary').amount = 99000000;
  environment.state.transactions.find(row => row.id === 'future').amount = 88000000;
  assert.deepEqual(expenseBars(api.chart()), expenseBars(html));
});

test('six-month chart includes cross-year empty months and private tooltips contain no amounts', () => {
  const { api, environment } = renderer();
  const html = api.monthlyTrendPanel();
  assert.deepEqual([...html.matchAll(/data-month="([^"]+)"/g)].map(match => match[1]), [
    '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01',
  ]);
  assert.match(html, /data-month="2026-01"[^>]+aria-pressed="true"/);
  assert.match(html, /class="monthly-income-bar"[^>]+height="0"/);
  environment.hidden = true;
  const masked = api.chart() + api.monthlyTrendPanel();
  for (const amount of ['18,500.00', '32.10', '41.10', '10.00', '42.10']) assert.ok(!masked.includes(amount), amount);
  assert.match(masked, /class="money">••••<\/strong>/);
  assert.doesNotMatch(masked, /\btitle=/);
});

test('insights escape category and largest-expense text and provide actionable detail buttons', () => {
  const { api } = renderer();
  const html = api.insights();
  assert.match(html, /data-action="insight-category" data-category="&lt;b&gt;咖啡&lt;\/b&gt;"/);
  assert.match(html, /<small class="muted">2 笔<\/small>/);
  assert.match(html, /data-action="edit-transaction" data-id="coffee"/);
  assert.match(html, /咖啡 &lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>|<b>咖啡<\/b>/);
  assert.match(html, /订阅自动记账占比/);
  assert.match(html, /上月无记录/);
  assert.doesNotMatch(html, /累计收入|累计支出/);
});

test('goal cards expose deposit action, remaining amount and achieved status without unsafe text', () => {
  const { api, environment } = renderer();
  const goal = { id: 'goal"bad', name: '<img src=x>', saved: 1250, target: 5000 };
  const html = api.goalCard(goal);
  assert.match(html, /data-action="goal-deposit" data-id="goal&quot;bad"/);
  assert.match(html, /还差 <b class="money">¥ 37\.50<\/b>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(api.goalCard({ ...goal, saved: 5000 }), /class="goal-achieved">已达成/);
  environment.hidden = true;
  assert.doesNotMatch(api.goalCard(goal), /aria-valuenow=/);
  assert.match(api.goalCard(), /data-action="add-goal"/);
});
