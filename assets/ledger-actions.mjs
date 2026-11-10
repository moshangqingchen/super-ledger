import { MAX_MONEY, moneyToCents, validateState } from '../engine.mjs';

const collections = { transaction: 'transactions', subscription: 'subscriptions', goal: 'goals' };

export function adjustedGoalSaved(saved, value, mode = 'deposit') {
  const delta = moneyToCents(value);
  if (delta <= 0) throw new Error('金额需要大于 0');
  if (!['deposit', 'withdraw'].includes(mode)) throw new Error('请选择存入或取出');
  const result = saved + (mode === 'withdraw' ? -delta : delta);
  if (result < 0) throw new Error('取出金额不能超过当前已存金额');
  if (!Number.isSafeInteger(result) || result > MAX_MONEY) throw new Error('已存金额超过支持的上限');
  return result;
}

/** Keep only the deleted record and its links, never an entire stale ledger. */
export function captureDeletion(state, kind, id) {
  const key = collections[kind];
  if (!key) throw new Error('该记录不支持撤销');
  const index = state[key].findIndex(record => record.id === id);
  if (index < 0) throw new Error('记录已被移除，请刷新后重试');
  return {
    key, index,
    record: structuredClone(state[key][index]),
    beforeId: state[key][index - 1]?.id,
    afterId: state[key][index + 1]?.id,
    links: kind === 'subscription' ? state.transactions.filter(tx => tx.subscriptionId === id)
      .map(tx => ({ id: tx.id, subscriptionId: tx.subscriptionId, occurrenceKey: tx.occurrenceKey })) : [],
  };
}

/** Merge into current state; unrelated additions and edits must survive undo. */
export function restoreDeletion(state, deletion) {
  const { key, record, index, beforeId, afterId, links } = deletion;
  if (state[key].some(item => item.id === record.id)) throw new Error('相同 ID 的记录已存在，无法撤销');
  const next = structuredClone(state);
  const after = next[key].findIndex(item => item.id === afterId);
  const before = next[key].findIndex(item => item.id === beforeId);
  const position = after >= 0 ? after : before >= 0 ? before + 1 : Math.min(index, next[key].length);
  next[key].splice(position, 0, structuredClone(record));
  for (const link of links) {
    const tx = next.transactions.find(item => item.id === link.id);
    // A separately deleted bill stays deleted. Restore only the removed linkage.
    if (!tx) continue;
    if (tx.subscriptionId || tx.occurrenceKey) throw new Error('相关账单的订阅关联已改变，无法撤销');
    tx.subscriptionId = link.subscriptionId;
    if (link.occurrenceKey !== undefined) tx.occurrenceKey = link.occurrenceKey;
  }
  validateState(next);
  return next;
}
