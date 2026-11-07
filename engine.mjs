import { accountCurrency, currencyRate, currencyInfo, parseMoney, toCnyCents } from './currencies.mjs';
import { appleBalanceRegion, isAppleBalance } from './account-presets.mjs';

/** Balances and transactions use integer units of their account currency; reports use CNY cents. */
export const MAX_MONEY = 1_000_000_000_000;
export const subscriptionAccountTypes = Object.freeze([
  { id: 'email', label: '邮箱' },
  { id: 'apple', label: 'Apple 账户' },
  { id: 'google', label: 'Google 账户' },
  { id: 'phone', label: '手机号' },
  { id: 'wechat', label: '微信' },
  { id: 'qq', label: 'QQ' },
  { id: 'other', label: '其他' },
].map(item => Object.freeze(item)));
const SUBSCRIPTION_ACCOUNT_TYPES = new Set(subscriptionAccountTypes.map(item => item.id));
const DATE_PATTERN = /^(19\d{2}|20\d{2}|21\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clone = value => structuredClone(value);
const pad = n => String(n).padStart(2, '0');

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Subscription schedules follow Beijing standard time (UTC+8) on every device. */
export function beijingDateTime(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('当前时间格式不正确');
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    hour: shifted.getUTCHours(),
  };
}

function subscriptionClock(now, dateHour = 0) {
  if (now instanceof Date) {
    const clock = beijingDateTime(now);
    date(clock.date, '当前日期');
    return clock;
  }
  date(now, '当前日期');
  return { date: now, hour: dateHour };
}

export function subscriptionDueHour(sub, dueDate) {
  return dueDate.slice(0, 7) === sub.startDate.slice(0, 7) ? sub.startHour ?? 0 : sub.billingHour ?? 0;
}

function fail(message) { throw new Error(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
}
function string(value, label, max = 120, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label}格式不正确`);
}
function boolean(value, label) { if (typeof value !== 'boolean') fail(`${label}必须为布尔值`); }
function integer(value, label, min = 0, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}必须是${min}至${max}之间的整数`);
}
function id(value, label, max = 128) {
  string(value, label, max);
  if (!ID_PATTERN.test(value)) fail(`${label}仅能包含字母、数字、下划线或短横线`);
}
function color(value, label) {
  if (typeof value !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) fail(`${label}必须是十六进制颜色`);
}
function array(value, label, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}必须是数组且不能超过${max}项`);
}
function uniqueIds(items, label, maxLength = 128) {
  const ids = new Set();
  for (const item of items) {
    object(item, label);
    id(item.id, `${label} ID`, maxLength);
    if (ids.has(item.id)) fail(`${label} ID 重复：${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function date(value, label) { if (!isValidDate(value)) fail(`${label}必须是1900至2199年的有效 YYYY-MM-DD 日期`); }

/** Parse a yuan decimal without floating-point multiplication or rounding. */
export function moneyToCents(value) {
  return parseMoney(value, 'CNY');
}

/** First occurrence is startDate. Later occurrences use billingDay, clamped to month end. */
export function addMonthsDue(startDate, monthIndex, billingDay) {
  date(startDate, '首次扣款日期');
  integer(monthIndex, '月份偏移', 0, 3599);
  integer(billingDay, '扣款日', 1, 31);
  if (monthIndex === 0) return startDate;
  const [year, month] = startDate.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1 + monthIndex, 1));
  const y = result.getUTCFullYear();
  const m = result.getUTCMonth() + 1;
  if (y > 2199) fail('扣款日期超过支持范围');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(billingDay, lastDay))}`;
}

export function occurrenceKey(subscription, dueDate) {
  return `${subscription.id}:${dueDate.slice(0, 7)}`;
}

/** Retain the schema gate so older applications reject schedules they cannot honor. */
export function upgradeSchemaVersion(state) {
  if (state.accounts.some(account => accountCurrency(account) !== 'CNY')) state.schemaVersion = Math.max(state.schemaVersion, 2);
  if (state.subscriptions.some(sub => own(sub, 'startHour') || own(sub, 'billingHour'))) state.schemaVersion = Math.max(state.schemaVersion, 3);
  return state;
}

export function validateState(state) {
  object(state, '账本');
  if (![1, 2, 3].includes(state.schemaVersion)) fail('不支持此账本版本');
  integer(state.revision, '账本版本号', 0, Number.MAX_SAFE_INTEGER);
  boolean(state.demo, '示例数据标志');
  object(state.settings, '设置');
  integer(state.settings.monthlyBudget, '月预算', 0);
  if (state.settings.currency !== 'CNY') fail('汇总显示币种必须为人民币 CNY');
  array(state.accounts, '账户', 100);
  array(state.transactions, '交易', 100_000);
  array(state.subscriptions, '订阅', 1000);
  array(state.goals, '储蓄目标', 1000);
  const accounts = uniqueIds(state.accounts, '账户', 80);
  const accountById = new Map(state.accounts.map(account => [account.id, account]));
  const subscriptions = uniqueIds(state.subscriptions, '订阅', 80);
  uniqueIds(state.transactions, '交易');
  uniqueIds(state.goals, '储蓄目标', 80);
  for (const account of state.accounts) {
    string(account.name, '账户名称', 60);
    string(account.type, '账户类型', 40);
    if (own(account, 'providerId')) id(account.providerId, '账户预设标识', 80);
    if (own(account, 'appleRegion')) string(account.appleRegion, 'Apple 账户国家或地区', 10, true);
    if (own(account, 'appleAccount')) string(account.appleAccount, 'Apple 账号标注', 160, true);
    if (isAppleBalance(account)) {
      const region = appleBalanceRegion(account.appleRegion);
      if (!region) fail('请选择 Apple 账户的国家或地区');
      if (region.currency && accountCurrency(account) !== region.currency) fail(`Apple 账户地区与币种不一致，${region.name}应使用 ${region.currency}`);
    } else if (account.appleRegion || account.appleAccount) {
      fail('只有 Apple 余额账户可以设置 Apple 地区或账号标注');
    }
    if (own(account, 'bankId')) id(account.bankId, '银行标识', 80);
    if (own(account, 'lastFour') && (typeof account.lastFour !== 'string' || !/^[0-9]{4}$/.test(account.lastFour))) fail('银行卡尾号必须为 4 位数字');
    if (own(account, 'rateMode') && !['auto', 'manual'].includes(account.rateMode)) fail('账户汇率模式必须为 auto 或 manual');
    if (own(account, 'rateAsOf')) date(account.rateAsOf, '账户汇率日期');
    if (own(account, 'rateSource')) string(account.rateSource, '账户汇率来源', 120);
    integer(account.openingBalance, '账户期初余额', -MAX_MONEY);
    color(account.color, '账户颜色');
    accountCurrency(account);
    currencyRate(account);
  }
  if (state.schemaVersion === 1 && state.accounts.some(account => accountCurrency(account) !== 'CNY')) fail('外币账本需要使用版本 2，请使用支持多币种的新版应用保存');
  const knownOccurrences = new Set();
  const historicalTotals = { income: 0n, expense: 0n };
  for (const tx of state.transactions) {
    if (!['income', 'expense', 'transfer'].includes(tx.type)) fail('交易类型不正确');
    integer(tx.amount, '交易金额', 1);
    if (!accounts.has(tx.accountId)) fail('交易的账户不存在');
    const sourceCurrency = accountCurrency(accountById.get(tx.accountId));
    const recordedCurrency = currencyInfo(tx.currency === undefined ? 'CNY' : tx.currency).code;
    if (recordedCurrency !== sourceCurrency) fail('交易币种与账户币种不一致，已有账单账户不能直接更改币种');
    // Snapshots prevent later edits to an account's valuation rate from rewriting paid history.
    currencyRate({ currency: recordedCurrency, ...(own(tx, 'cnyRate') ? { cnyRate: tx.cnyRate } : {}) });
    const convertedAmount = transactionCnyAmount(tx);
    // Version 1 historically permits arbitrarily large gross turnover with a safe net balance.
    // Version 2 and later bound converted totals before they reach number-based UI charts.
    if (state.schemaVersion >= 2 && tx.type !== 'transfer') {
      historicalTotals[tx.type] += BigInt(convertedAmount);
      if (historicalTotals[tx.type] > BigInt(MAX_MONEY)) fail('人民币折算累计收支超过支持的范围');
    }
    if (tx.type === 'transfer') {
      if (!accounts.has(tx.toAccountId)) fail('转入账户不存在');
      if (tx.accountId === tx.toAccountId) fail('转入和转出账户不能相同');
      const targetCurrency = accountCurrency(accountById.get(tx.toAccountId));
      const recordedTarget = currencyInfo(tx.toCurrency === undefined ? 'CNY' : tx.toCurrency).code;
      if (recordedTarget !== targetCurrency) fail('转入金额币种与转入账户币种不一致');
      if (sourceCurrency !== targetCurrency && !own(tx, 'toAmount')) fail('跨币种转移需要填写实际到账金额');
      if (own(tx, 'toAmount')) {
        integer(tx.toAmount, '实际到账金额', 1);
        if (sourceCurrency === targetCurrency && tx.toAmount !== tx.amount) fail('相同币种的转出和到账金额必须相同');
      }
    } else if (own(tx, 'toAccountId') && tx.toAccountId !== '' && tx.toAccountId != null) {
      fail('非转账交易不能包含转入账户');
    }
    if (tx.type !== 'transfer' && (own(tx, 'toAmount') || own(tx, 'toCurrency'))) fail('非转账交易不能包含到账金额或转入币种');
    string(tx.category, '交易分类', 50);
    string(tx.title, '交易名称', 120);
    date(tx.date, '交易日期');
    string(tx.note, '交易备注', 2000, true);
    if (own(tx, 'subscriptionId')) {
      if (!subscriptions.has(tx.subscriptionId)) fail('交易对应的订阅不存在');
      if (tx.type !== 'expense') fail('订阅交易必须是支出');
    }
    if (own(tx, 'occurrenceKey')) {
      string(tx.occurrenceKey, '订阅账期标识', 100);
      if (!tx.subscriptionId || tx.occurrenceKey !== `${tx.subscriptionId}:${tx.date.slice(0, 7)}`) fail('订阅账期与交易日期不符');
      if (knownOccurrences.has(tx.occurrenceKey)) fail('同一订阅账期不能重复记账');
      knownOccurrences.add(tx.occurrenceKey);
    }
  }
  let recurringCnyTotal = 0n;
  for (const sub of state.subscriptions) {
    string(sub.name, '订阅名称', 80);
    if (own(sub, 'serviceId')) id(sub.serviceId, '会员服务标识', 80);
    if (own(sub, 'tier')) string(sub.tier, '会员档位', 80, true);
    if (own(sub, 'linkedAccounts')) {
      array(sub.linkedAccounts, '关联账号', 10);
      for (const linked of sub.linkedAccounts) {
        object(linked, '关联账号');
        if (!SUBSCRIPTION_ACCOUNT_TYPES.has(linked.type)) fail('关联账号类型不正确');
        string(linked.value, '关联账号内容', 160);
        if (own(linked, 'label')) string(linked.label, '关联账号标注', 40, true);
      }
    }
    if (own(sub, 'note')) string(sub.note, '订阅备注', 500, true);
    integer(sub.amount, '订阅金额', 1);
    if (!accounts.has(sub.accountId)) fail('订阅扣款账户不存在');
    const account = accountById.get(sub.accountId);
    const subCurrency = currencyInfo(sub.currency === undefined ? 'CNY' : sub.currency).code;
    if (subCurrency !== accountCurrency(account)) fail('订阅币种与扣款账户币种不一致');
    const convertedAmount = toCnyCents(sub.amount, subCurrency, currencyRate(account));
    if (sub.category !== '会员订阅') fail('订阅分类必须为会员订阅');
    date(sub.startDate, '首次扣款日期');
    if (own(sub, 'startHour')) integer(sub.startHour, '首次扣账小时', 0, 23);
    if (own(sub, 'billingHour')) integer(sub.billingHour, '每月扣账小时', 0, 23);
    if (state.schemaVersion < 3 && (own(sub, 'startHour') || own(sub, 'billingHour'))) fail('按小时扣账需要使用版本 3，请使用支持北京时间按小时扣账的新版应用保存');
    if (own(sub, 'expiresOn')) {
      string(sub.expiresOn, '会员到期日期', 10, true);
      if (sub.expiresOn) {
        date(sub.expiresOn, '会员到期日期');
        if (sub.expiresOn < sub.startDate) fail('会员到期日期不能早于首次扣款日期');
      }
    }
    integer(sub.billingDay, '每月扣款日', 1, 31);
    boolean(sub.recurring, '连续订阅');
    boolean(sub.active, '订阅启用状态');
    if (sub.active && sub.recurring) {
      recurringCnyTotal += BigInt(convertedAmount);
      if (recurringCnyTotal * 12n > BigInt(MAX_MONEY)) fail('连续订阅的人民币折算年度预估超过支持的范围');
    }
    color(sub.color, '订阅颜色');
    string(sub.icon, '订阅图标', 80);
    array(sub.processedOccurrences, '已处理订阅账期', 3600);
    const processed = new Set();
    for (const key of sub.processedOccurrences) {
      string(key, '已处理订阅账期', 100);
      const prefix = `${sub.id}:`;
      if (!key.startsWith(prefix) || !isValidDate(`${key.slice(prefix.length)}-01`)) fail('订阅已处理账期格式不正确');
      if (processed.has(key)) fail('订阅已处理账期不能重复');
      processed.add(key);
    }
  }
  for (const goal of state.goals) {
    string(goal.name, '储蓄目标名称', 80);
    integer(goal.target, '目标金额', 1);
    integer(goal.saved, '已存金额', 0);
    color(goal.color, '目标颜色');
    if (own(goal, 'cover')) {
      string(goal.cover, '目标封面', 250, true);
      if (goal.cover && (!/^(?:\/)?assets\/[A-Za-z0-9_./-]+$/.test(goal.cover) || goal.cover.includes('..'))) fail('目标封面只能使用本地 assets 资源');
    }
  }
  // Prevent valid individual records from overflowing usable balance limits in aggregate.
  getBalances(state);
  return true;
}

/** Omit asOfDate for all recorded entries; supply today's date for current balances. */
export function getBalances(state, asOfDate) {
  if (asOfDate !== undefined) date(asOfDate, '余额截止日期');
  const exact = Object.create(null);
  for (const account of state.accounts) exact[account.id] = BigInt(account.openingBalance);
  for (const tx of state.transactions) {
    if (asOfDate !== undefined && tx.date > asOfDate) continue;
    if (!own(exact, tx.accountId)) fail('交易的账户不存在');
    exact[tx.accountId] += BigInt(tx.type === 'income' ? tx.amount : -tx.amount);
    if (tx.type === 'transfer') {
      if (!own(exact, tx.toAccountId)) fail('转入账户不存在');
      exact[tx.toAccountId] += BigInt(tx.toAmount ?? tx.amount);
    }
  }
  const balances = Object.create(null);
  for (const [accountId, balance] of Object.entries(exact)) {
    if (balance < -BigInt(MAX_MONEY) || balance > BigInt(MAX_MONEY)) fail('账户累计余额超过支持的范围');
    balances[accountId] = Number(balance);
  }
  sumCnyBalances(state, balances);
  return balances;
}

function sumCnyBalances(state, balances) {
  let total = 0n;
  for (const account of state.accounts) {
    total += BigInt(toCnyCents(balances[account.id], accountCurrency(account), currencyRate(account)));
  }
  if (total < -BigInt(MAX_MONEY) || total > BigInt(MAX_MONEY)) fail('人民币折算总资产超过支持的范围');
  return Number(total);
}

/** Current-rate valuation, separate from the native balances returned by getBalances. */
export function getCnyBalances(state, asOfDate) {
  const native = getBalances(state, asOfDate);
  const result = Object.create(null);
  for (const account of state.accounts) result[account.id] = toCnyCents(native[account.id], accountCurrency(account), currencyRate(account));
  return result;
}

export function getNetWorth(state, asOfDate) {
  return sumCnyBalances(state, getBalances(state, asOfDate));
}

/** This is a source-amount valuation. Income/expense reports must still exclude transfers. */
export function transactionCnyAmount(tx, state) {
  const code = currencyInfo(tx.currency === undefined ? 'CNY' : tx.currency).code;
  if (state) {
    const account = state.accounts.find(item => item.id === tx.accountId);
    if (!account) fail('交易的账户不存在');
    if (accountCurrency(account) !== code) fail('交易币种与账户币种不一致');
  }
  return toCnyCents(tx.amount, code, tx.cnyRate);
}

function dueDates(sub, today, hour = 23) {
  if (sub.startDate > today) return [];
  if (!sub.recurring) return sub.startDate < today || subscriptionDueHour(sub, sub.startDate) <= hour ? [sub.startDate] : [];
  const [sy, sm] = sub.startDate.split('-').map(Number);
  const [ty, tm] = today.split('-').map(Number);
  const months = (ty - sy) * 12 + tm - sm;
  const dates = [];
  for (let i = 0; i <= months; i++) {
    const due = addMonthsDue(sub.startDate, i, sub.billingDay);
    if (due < today || due === today && subscriptionDueHour(sub, due) <= hour) dates.push(due);
  }
  return dates;
}

/** Catch up monthly bookings, exactly once per subscription/month; never initiates bank payments. */
export function applyRecurring(state, now = new Date()) {
  validateState(state);
  // Explicit date-only callers retain their existing whole-day behavior.
  const { date: today, hour } = subscriptionClock(now, 23);
  const next = clone(state);
  const added = [];
  const existing = new Set(next.transactions.map(tx => tx.occurrenceKey).filter(Boolean));
  const transactionIds = new Set(next.transactions.map(tx => tx.id));
  const accountById = new Map(next.accounts.map(account => [account.id, account]));
  for (const sub of next.subscriptions) {
    if (!sub.active) continue;
    const processed = new Set(sub.processedOccurrences);
    for (const due of dueDates(sub, today, hour)) {
      const key = occurrenceKey(sub, due);
      if (processed.has(key)) continue;
      if (!existing.has(key)) {
        const txId = `rec_${sub.id}_${due.slice(0, 7).replace('-', '')}`;
        if (transactionIds.has(txId)) fail('自动记账交易 ID 冲突，请检查账本数据');
        const tx = {
          id: txId, type: 'expense', amount: sub.amount, accountId: sub.accountId,
          category: '会员订阅', title: (sub.name + (sub.tier ? ' · ' + sub.tier : '')).slice(0, 120), date: due, note: '订阅到期自动记账' + (sub.tier ? ' · 会员档位：' + sub.tier : ''),
          subscriptionId: sub.id, occurrenceKey: key,
        };
        const account = accountById.get(sub.accountId);
        if (accountCurrency(account) !== 'CNY') {
          tx.currency = accountCurrency(account);
          tx.cnyRate = currencyRate(account);
        }
        next.transactions.push(tx);
        added.push(tx);
        existing.add(key);
        transactionIds.add(txId);
      }
      processed.add(key);
    }
    sub.processedOccurrences = [...processed].sort();
  }
  validateState(next);
  return { state: next, added };
}

/** Preserve paid history while intentionally skipping billing periods spent paused. */
export function setSubscriptionActive(state, subscriptionId, active, now = new Date()) {
  validateState(state);
  const { date: today, hour } = subscriptionClock(now);
  boolean(active, '订阅启用状态');
  const next = clone(state);
  const sub = next.subscriptions.find(item => item.id === subscriptionId);
  if (!sub) fail('订阅不存在');
  if (sub.active === active) return next;
  if (active) {
    const processed = new Set(sub.processedOccurrences);
    for (const due of dueDates(sub, today, hour)) {
      if (due < today || subscriptionDueHour(sub, due) < hour) processed.add(occurrenceKey(sub, due));
    }
    sub.processedOccurrences = [...processed].sort();
  }
  sub.active = active;
  return next;
}

/** Overwrite a saved record in place. It may have been deleted while its form was open. */
export function replaceRecord(records, id, record) {
  const index = records.findIndex(item => item.id === id);
  if (index < 0) fail('这条记录已被删除，修改没有保存。表单内容还在，需要的话请复制后重新添加。');
  records[index] = record;
}

export function nextSubscriptionDue(sub, now = new Date()) {
  const { date: today, hour } = subscriptionClock(now);
  if (!sub.active) return null;
  const processed = new Set(sub.processedOccurrences);
  if (!sub.recurring) return processed.has(occurrenceKey(sub, sub.startDate)) ? null : sub.startDate;
  const [sy, sm] = sub.startDate.split('-').map(Number);
  const [ty, tm] = today.split('-').map(Number);
  const start = Math.max(0, (ty - sy) * 12 + tm - sm);
  const lastSupportedMonth = (2199 - sy) * 12 + 12 - sm;
  for (let i = start; i <= lastSupportedMonth; i++) {
    const due = addMonthsDue(sub.startDate, i, sub.billingDay);
    if ((due > today || due === today && subscriptionDueHour(sub, due) >= hour) && !processed.has(occurrenceKey(sub, due))) return due;
  }
  return null;
}

/** Membership expiry is a reminder only; it does not stop or reschedule ledger bookings. */
export function subscriptionExpiryStatus(sub, now = new Date()) {
  const { date: referenceDate } = subscriptionClock(now);
  let target = sub.expiresOn || null;
  let source = target ? 'expiry' : 'none';
  if (!target && sub.recurring && sub.active) {
    target = nextSubscriptionDue(sub, now);
    if (target) source = 'renewal';
  }
  if (!target) return {
    tone: 'unset', label: '未设置到期日期', detail: '可在编辑中填写会员到期日期',
    date: null, days: null, source: 'none',
  };
  date(target, '会员到期日期');
  // UTC date ordinals count calendar days equally across local DST transitions.
  const ordinal = value => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86_400_000;
  };
  const days = ordinal(target) - ordinal(referenceDate);
  const action = source === 'expiry' ? '到期' : '续费';
  return {
    tone: days < 0 ? 'expired' : days <= 7 ? 'urgent' : days <= 30 ? 'soon' : 'normal',
    label: days < 0 ? `已${action} ${-days} 天` : days === 0 ? `今天${action}` : `${days} 天后${action}`,
    detail: `${target} · ${source === 'expiry' ? '会员到期' : '下次续费'}`,
    date: target, days, source,
  };
}

export function makeEmptyState() {
  return {
    schemaVersion: 1, revision: 0, demo: false,
    settings: { monthlyBudget: 0, currency: 'CNY' },
    accounts: [], transactions: [], subscriptions: [], goals: [],
  };
}

/** Explicit demonstration data; new personal ledgers must use makeEmptyState. */
export function makeInitialState(today = localDate()) {
  date(today, '当前日期');
  const month = today.slice(0, 7);
  const todayDay = Number(today.slice(8));
  const [year, mon] = today.split('-').map(Number);
  const previous = new Date(Date.UTC(year, mon - 2, 1));
  const previousMonth = `${previous.getUTCFullYear()}-${pad(previous.getUTCMonth() + 1)}`;
  const current = day => `${month}-${pad(Math.min(day, todayDay))}`;
  const state = makeEmptyState();
  state.demo = true;
  state.settings.monthlyBudget = 600000;
  state.accounts = [
    { id: 'bank', name: '招商银行', type: '银行卡', openingBalance: 9300000, color: '#293F35' },
    { id: 'alipay', name: '支付宝', type: '数字钱包', openingBalance: 1680000, color: '#729FCE' },
    { id: 'wechat', name: '微信钱包', type: '数字钱包', openingBalance: 836600, color: '#7B9C80' },
    { id: 'cash', name: '现金', type: '现金', openingBalance: 145000, color: '#C5A26A' },
  ];
  const tx = (id, type, amount, accountId, category, title, date, note = '') => ({ id, type, amount, accountId, category, title, date, note });
  state.transactions = [
    tx('demo_prev_salary', 'income', 1850000, 'bank', '工资薪资', '上月工资', `${previousMonth}-05`, '示例数据'),
    tx('demo_prev_rent', 'expense', 320000, 'bank', '居住生活', '上月房租', `${previousMonth}-06`),
    tx('demo_prev_food', 'expense', 182500, 'alipay', '餐饮美食', '上月餐饮', `${previousMonth}-15`),
    tx('demo_prev_shopping', 'expense', 146800, 'alipay', '购物消费', '上月购物', `${previousMonth}-20`),
    tx('demo_salary', 'income', 1850000, 'bank', '工资薪资', '本月工资到账', current(1), '示例数据 · 仅供体验'),
    tx('demo_rent', 'expense', 320000, 'bank', '居住生活', '我的小窝 · 房租', current(1)),
    tx('demo_coffee', 'expense', 2800, 'wechat', '餐饮美食', '一杯拿铁的快乐', current(2)),
    tx('demo_ride', 'expense', 3560, 'alipay', '交通出行', '打车回家', current(2)),
    tx('demo_grocery', 'expense', 18650, 'alipay', '居住生活', '周末补给计划', current(3)),
    tx('demo_freelance', 'income', 260000, 'alipay', '副业收入', '设计项目尾款', current(3)),
    tx('demo_dinner', 'expense', 16800, 'wechat', '餐饮美食', '和朋友吃顿好的', current(4)),
    tx('demo_book', 'expense', 8900, 'alipay', '学习成长', '买一本新书', current(4)),
    tx('demo_brunch', 'expense', 4650, 'wechat', '餐饮美食', '今天也要好好吃饭', current(5)),
  ];
  state.subscriptions = [
    { id: 'music', name: '网易云音乐', amount: 1800, accountId: 'alipay', category: '会员订阅', startDate: `${month}-08`, billingDay: 8, recurring: true, active: true, color: '#EF7062', icon: 'music', processedOccurrences: [] },
    { id: 'video', name: '哔哩哔哩大会员', amount: 2500, accountId: 'wechat', category: '会员订阅', startDate: `${month}-12`, billingDay: 12, recurring: true, active: true, color: '#6CB8D4', icon: 'play', processedOccurrences: [] },
    { id: 'cloud', name: 'iCloud+', amount: 6800, accountId: 'bank', category: '会员订阅', startDate: `${month}-24`, billingDay: 24, recurring: true, active: true, color: '#8A85BC', icon: 'cloud', processedOccurrences: [] },
  ];
  state.goals = [{ id: 'travel', name: '下一站，去看世界', target: 1500000, saved: 860000, color: '#D6EF74', cover: 'assets/alpine-goal.png' }];
  validateState(state);
  return state;
}
