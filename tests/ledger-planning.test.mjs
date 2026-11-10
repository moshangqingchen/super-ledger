import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryOptions, budgetCategories, goalDeadlinePlan, removeCustomCategory } from '../assets/ledger-planning.mjs';
import { categorySummary } from '../assets/ledger-insights.mjs';

test('category lists include built-in, custom, historical and budget-only names without duplicates', () => {
  const state = { settings: { customCategories: { expense: ['猫咪', '咖啡'], income: ['稿费'] }, categoryBudgets: { 猫咪: 100, 旅行: 200 } },
    transactions: [{ type: 'expense', category: '咖啡' }, { type: 'expense', category: '旧分类' }] };
  assert.ok(categoryOptions(state, 'expense').includes('餐饮美食'));
  assert.ok(categoryOptions(state, 'expense').includes('旧分类'));
  assert.equal(categoryOptions(state, 'expense').filter(x => x === '咖啡').length, 1);
  assert.ok(categoryOptions(state, 'income').includes('稿费'));
  assert.ok(budgetCategories(state).includes('旅行'));
  assert.deepEqual(categorySummary([], state), [
    { category: '猫咪', amount: 0, count: 0, budget: 100 }, { category: '旅行', amount: 0, count: 0, budget: 200 },
  ]);
});

test('custom deletion drops its budget and empty optional containers while preserving historical text', () => {
  const state = { settings: { customCategories: { expense: ['猫咪'], income: [] }, categoryBudgets: { 猫咪: 100 } },
    transactions: [{ type: 'expense', category: '猫咪' }] };
  removeCustomCategory(state.settings, 'expense', '猫咪');
  assert.deepEqual(state.settings, {});
  assert.equal(state.transactions[0].category, '猫咪');
  assert.ok(categoryOptions(state, 'expense').includes('猫咪'));
});

test('goal deadline uses calendar-month ceiling and integer-cent ceiling across month ends and leap years', () => {
  const goal = { saved: 0, target: 10001 };
  for (const [today, deadline, months, monthly] of [
    ['2026-01-31', '2026-02-28', 1, 10001],
    ['2026-01-31', '2026-03-01', 2, 5001],
    ['2024-01-31', '2024-02-29', 1, 10001],
    ['2026-11-09', '2027-11-09', 12, 834],
    ['2026-11-09', '2026-11-10', 1, 10001],
  ]) {
    const result = goalDeadlinePlan({ ...goal, deadline }, today);
    assert.equal(result.months, months); assert.equal(result.monthly, monthly);
  }
  assert.equal(goalDeadlinePlan(goal, '2026-11-09'), null);
  assert.equal(goalDeadlinePlan({ ...goal, deadline: '2026-11-08' }, '2026-11-09').overdue, true);
  assert.equal(goalDeadlinePlan({ ...goal, deadline: '2026-11-09' }, '2026-11-09').monthly, null);
  assert.equal(goalDeadlinePlan({ ...goal, saved: 10001, deadline: '2026-12-09' }, '2026-11-09').monthly, null);
});
