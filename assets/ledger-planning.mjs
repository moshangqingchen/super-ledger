import { expenseCategories, incomeCategories } from './ledger-categories.mjs';
import { addMonthsDue } from '../engine.mjs';

export function categoryOptions(state, type) {
  if (type === 'transfer') return ['账户转账'];
  const builtin = type === 'income' ? incomeCategories : expenseCategories;
  return [...new Set([...builtin, ...(state.settings.customCategories?.[type] || []),
    ...state.transactions.filter(tx => tx.type === type).map(tx => tx.category)])];
}

export function budgetCategories(state) {
  return [...new Set([...categoryOptions(state, 'expense'), ...Object.keys(state.settings.categoryBudgets || {})])];
}

/** Calendar months, rounded up; a partial month always counts as one saving period. */
export function goalDeadlinePlan(goal, today) {
  if (!goal?.deadline) return null;
  const days = Math.round((Date.parse(goal.deadline + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  const achieved = goal.saved >= goal.target;
  if (achieved || days <= 0) return { days, achieved, overdue: !achieved && days < 0, monthly: null };
  const [y, m, d] = today.split('-').map(Number);
  const [dy, dm] = goal.deadline.split('-').map(Number);
  let months = (dy - y) * 12 + dm - m;
  if (addMonthsDue(today, months, d) < goal.deadline) months++;
  months = Math.max(1, months);
  const remaining = BigInt(goal.target - goal.saved), count = BigInt(months);
  return { days, achieved, overdue: false, months, monthly: Number((remaining + count - 1n) / count) };
}

/** Delete only the preference and its budget; historical transaction text is untouched. */
export function removeCustomCategory(settings, type, category) {
  const custom = settings.customCategories;
  if (!custom || !custom[type]?.includes(category)) return;
  custom[type] = custom[type].filter(value => value !== category);
  if (!custom.expense.length && !custom.income.length) delete settings.customCategories;
  if (settings.categoryBudgets && Object.hasOwn(settings.categoryBudgets, category)) {
    delete settings.categoryBudgets[category];
    if (!Object.keys(settings.categoryBudgets).length) delete settings.categoryBudgets;
  }
}
