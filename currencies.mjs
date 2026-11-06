/** Offline currency definitions. Rates are supplied by the owner, never inferred. */
export const MAX_NATIVE_UNITS = 1_000_000_000_000;
const RATE_SCALE = 100_000_000n;
const MAX_RATE = 1_000_000n * RATE_SCALE;

export const currencyCatalog = Object.freeze([
  { code: 'CNY', name: '人民币', symbol: '¥', decimals: 2 },
  { code: 'USD', name: '美元', symbol: '$', decimals: 2 },
  { code: 'USDT', name: '泰达币', symbol: 'USDT', decimals: 6 },
  { code: 'JPY', name: '日元', symbol: 'JP¥', decimals: 0 },
  { code: 'EUR', name: '欧元', symbol: '€', decimals: 2 },
  { code: 'HKD', name: '港币', symbol: 'HK$', decimals: 2 },
  { code: 'GBP', name: '英镑', symbol: '£', decimals: 2 },
  { code: 'KRW', name: '韩元', symbol: '₩', decimals: 0 },
  { code: 'SGD', name: '新加坡元', symbol: 'S$', decimals: 2 },
  { code: 'AUD', name: '澳大利亚元', symbol: 'A$', decimals: 2 },
  { code: 'CAD', name: '加拿大元', symbol: 'C$', decimals: 2 },
  { code: 'CHF', name: '瑞士法郎', symbol: 'CHF', decimals: 2 },
  { code: 'TRY', name: '土耳其里拉', symbol: '₺', decimals: 2 },
].map(Object.freeze));

export function currencyInfo(code = 'CNY') {
  const item = currencyCatalog.find(currency => currency.code === code);
  if (!item) throw new Error('请选择支持的账户币种');
  return item;
}

export function accountCurrency(account) {
  return currencyInfo(account?.currency === undefined ? 'CNY' : account.currency).code;
}

/** Parse a denomination into its exact integer units, without floating rounding. */
export function parseMoney(value, code = 'CNY') {
  const { decimals, name } = currencyInfo(code);
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('金额格式不正确');
  const raw = String(value).trim();
  const pattern = decimals ? new RegExp(`^-?\\d+(?:\\.\\d{1,${decimals}})?$`) : /^-?\d+$/;
  if (!pattern.test(raw)) throw new Error(decimals ? `${name}金额最多保留 ${decimals} 位小数` : `${name}金额请填写整数`);
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  const exact = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (exact > BigInt(MAX_NATIVE_UNITS)) throw new Error('金额超过支持的范围');
  const result = Number(exact) * (negative ? -1 : 1);
  return result === 0 ? 0 : result;
}

function checkedUnits(units) {
  if (!Number.isSafeInteger(units) || Math.abs(units) > MAX_NATIVE_UNITS) throw new Error('金额超过支持的范围');
  return BigInt(units);
}

/** An editable decimal: no separators; significant fractional digits are retained. */
export function amountInput(units, code = 'CNY') {
  return formatAmount(units, code, { grouping: false, trim: true });
}

export function formatAmount(units, code = 'CNY', { grouping = true, trim = false } = {}) {
  const { decimals } = currencyInfo(code);
  const exact = checkedUnits(units);
  const absolute = exact < 0n ? -exact : exact;
  const scale = 10n ** BigInt(decimals);
  let whole = String(absolute / scale);
  if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let fraction = decimals ? String(absolute % scale).padStart(decimals, '0') : '';
  if (trim) fraction = fraction.replace(/0+$/, '');
  return `${exact < 0n ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}

/** Currency codes disambiguate USD, HKD, CAD and JPY instead of overloading $/¥. */
export function formatMoney(units, code = 'CNY') {
  currencyInfo(code);
  return `${code === 'CNY' ? '¥' : code} ${formatAmount(units, code, { trim: code === 'USDT' })}`;
}

function rateUnits(value) {
  if (typeof value !== 'string' || value.length > 32 || !/^\d+(?:\.\d{1,8})?$/.test(value.trim())) throw new Error('汇率请填写大于 0 的数字，最多 8 位小数');
  const [whole, fraction = ''] = value.trim().split('.');
  const exact = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(8, '0'));
  if (exact <= 0n || exact > MAX_RATE) throw new Error('汇率必须大于 0 且不超过 1000000');
  return exact;
}

export function normalizeRate(value) {
  const exact = rateUnits(value);
  const fraction = String(exact % RATE_SCALE).padStart(8, '0').replace(/0+$/, '');
  return String(exact / RATE_SCALE) + (fraction ? '.' + fraction : '');
}

export function currencyRate(account) {
  const code = accountCurrency(account);
  if (code === 'CNY') {
    if (account?.cnyRate !== undefined && normalizeRate(account.cnyRate) !== '1') throw new Error('人民币折算汇率必须为 1');
    return '1';
  }
  if (account?.cnyRate === undefined) throw new Error(`${code} 账户需要填写人民币折算汇率`);
  return normalizeRate(account.cnyRate);
}

/** Round to CNY cents once, half away from zero; never multiply binary floats. */
export function toCnyCents(units, code = 'CNY', rate = undefined) {
  const { decimals } = currencyInfo(code);
  const source = checkedUnits(units);
  const normalized = currencyRate({ currency: code, ...(rate === undefined ? {} : { cnyRate: rate }) });
  const numerator = source * rateUnits(normalized) * 100n;
  const denominator = (10n ** BigInt(decimals)) * RATE_SCALE;
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  if (rounded > BigInt(MAX_NATIVE_UNITS)) throw new Error('人民币折算金额超过支持的范围');
  const result = Number(numerator < 0n ? -rounded : rounded);
  return result === 0 ? 0 : result;
}
