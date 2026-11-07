import { bankForCard, groupAccounts } from './account-groups.mjs';
import { accountPreset, accountLabel, isAppleBalance, appleBalanceRegion } from './account-presets.mjs';
import { accountCurrency, currencyInfo, formatMoney } from './currencies.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Read-only subtotals may exceed the limit of one persisted account. Keep all
// digits exact without relaxing the amount rules used by the ledger itself.
export function formatAccountTotal(units, code = 'CNY') {
  const { decimals } = currencyInfo(code);
  const raw = BigInt(units), negative = raw < 0n, absolute = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = (absolute / scale).toLocaleString('en-US');
  let fraction = decimals ? String(absolute % scale).padStart(decimals, '0') : '';
  if (code === 'USDT') fraction = fraction.replace(/0+$/, '');
  return `${code === 'CNY' ? '¥' : code} ${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}

function cardTheme(account) {
  const preset = accountPreset(account);
  // An explicit provider wins; a real bank card then wins over legacy name
  // guessing (a card nicknamed “微信” must still belong to its selected bank).
  if (['wechat', 'alipay'].includes(account.providerId)) return account.providerId;
  if (isAppleBalance(account)) return 'apple';
  if (account.providerId === 'cash') return 'cash';
  if (bankForCard(account)) return 'bank';
  if (['wechat', 'alipay'].includes(preset?.id)) return preset.id;
  if (preset?.id === 'cash') return 'cash';
  if (preset?.id === 'bank-card' || /银行卡|信用卡|储蓄卡/.test(account.type)) return 'bank';
  if (preset?.id === 'virtual-card') return 'virtual';
  return 'other';
}

// Theme keys come only from the built-in bank/provider catalogue, never names
// or arbitrary IDs imported from a ledger. Kept as a stable public helper.
export function accountCardArtKey(account) {
  const theme = cardTheme(account);
  if (theme === 'bank') return bankForCard(account)?.id || 'generic';
  return theme === 'other' ? 'generic' : theme;
}

function cardDecoration(theme) {
  // Native glass objects use CSS gradients and inline geometry, with no shared IDs.
  if (theme === 'bank') return '<span class="card-ornament ornament-bank" aria-hidden="true"><i class="bank-rings"></i><i class="bank-chip"><svg viewBox="0 0 44 34" fill="none"><path d="M14 0v10H0m30-10v10h14M14 34V24H0m30 10V24h14M14 10h16v14H14zM14 17H0m30 0h14"/></svg></i><svg class="bank-contactless" viewBox="0 0 30 54" fill="none"><path d="M4 21q7 6 0 12M11 15q14 12 0 24M18 9q21 18 0 36"/></svg></span>';
  if (theme === 'wechat') return '<span class="card-ornament ornament-chat" aria-hidden="true"><i></i><i></i></span>';
  if (theme === 'alipay') return '<span class="card-ornament ornament-scan" aria-hidden="true"><i class="scan-orb"></i><svg class="scan-frame" viewBox="0 0 100 100" fill="none"><path d="M14 32v-9a9 9 0 019-9h9M68 14h9a9 9 0 019 9v9M86 68v9a9 9 0 01-9 9h-9M32 86h-9a9 9 0 01-9-9v-9"/></svg><i class="scan-line"></i></span>';
  if (theme === 'apple') return '<span class="card-ornament ornament-gift" aria-hidden="true"><i class="gift-card"><i class="gift-ribbon"></i><svg class="gift-bow" viewBox="0 0 52 30" fill="none"><path d="M26 22C8 22 4 14 8 8S25 6 26 22ZM26 22C44 22 48 14 44 8S27 6 26 22Z"/><path d="M22 20q4-3 8 0v5q-4 3-8 0z"/></svg></i></span>';
  if (theme === 'virtual') return '<span class="card-ornament ornament-virtual" aria-hidden="true"><i></i><i><svg viewBox="0 0 100 62" fill="none"><path d="M13 17h24l10 10h21M13 44h20l12-12h24l12 12M53 12v9l9 9v18"/><circle cx="68" cy="27" r="2.5"/><circle cx="81" cy="44" r="2.5"/><circle cx="62" cy="48" r="2.5"/></svg></i></span>';
  if (theme === 'cash') return '<span class="card-ornament ornament-notes" aria-hidden="true"><i></i><i></i><b class="cash-coin"></b></span>';
  return '<span class="card-ornament ornament-crystal" aria-hidden="true"><svg viewBox="0 0 120 130"><polygon points="60,9 27,29 60,37" fill="currentColor" fill-opacity=".18"/><polygon points="60,9 60,37 96,28" fill="currentColor" fill-opacity=".34"/><polygon points="27,29 13,70 50,70 60,37" fill="currentColor" fill-opacity=".25"/><polygon points="60,37 50,70 84,70 96,28" fill="currentColor" fill-opacity=".46"/><polygon points="96,28 84,70 108,70" fill="currentColor" fill-opacity=".2"/><polygon points="13,70 60,119 50,70" fill="currentColor" fill-opacity=".32"/><polygon points="50,70 60,119 84,70" fill="currentColor" fill-opacity=".58"/><polygon points="84,70 60,119 108,70" fill="currentColor" fill-opacity=".4"/></svg></span>';
}

function renderCard(account, context) {
  const { balances, cnyBalances, icon, accountLogo, transactionCounts } = context;
  const currency = accountCurrency(account), bank = bankForCard(account), theme = cardTheme(account);
  const region = isAppleBalance(account) ? appleBalanceRegion(account.appleRegion) : null;
  const subtype = [bank?.name || region?.name || accountPreset(account)?.name, account.type].filter(Boolean);
  const tail = account.lastFour ? `<span class="card-digits"><span aria-hidden="true">••••</span> ${esc(account.lastFour)}</span>` : '';
  return `<article class="account-card account-face theme-${theme}" data-account-id="${esc(account.id)}" data-account-theme="${accountCardArtKey(account)}">
    ${cardDecoration(theme)}
    <div class="account-top"><div class="account-identity">${accountLogo(bank ? account : {...account,bankId:undefined})}<div><h3>${esc(account.name)}</h3><div class="account-type">${esc([...new Set(subtype)].join(' · '))}</div></div></div><button class="icon-btn account-edit" data-action="edit-account" data-id="${esc(account.id)}" aria-label="编辑${esc(accountLabel(account))}">${icon('edit',15)}</button></div>
    <div class="card-balance${balances[account.id] < 0 ? ' is-negative' : ''}" aria-label="当前余额（${currency}）"><div class="card-balance-label">当前余额 <span class="card-currency">${currency}</span></div><div class="money">${esc(formatMoney(balances[account.id], currency))}</div></div>
    <div class="card-detail-line">${tail}${isAppleBalance(account) ? `<span class="card-account-label">${esc(account.appleAccount || 'Apple 账户余额')}</span>` : ''}</div>
    ${currency !== 'CNY' ? `<div class="account-cny-value">约 <span class="money">${formatAccountTotal(cnyBalances[account.id])}</span> · ${account.rateMode === 'manual' ? '手动汇率' : '自动汇率'}${account.rateAsOf ? ' · ' + esc(account.rateAsOf) : ''}</div>` : ''}
    <div class="account-footer"><span>${transactionCounts.get(account.id) || 0} 笔关联账单</span><button class="text-btn" data-action="account-transactions" data-id="${esc(account.id)}">查看账单 ${icon('arrow',12)}</button></div>
  </article>`;
}

function renderBank(group, context) {
  const { expandedBanks, icon, accountLogo } = context;
  const { bank, accounts, currencyTotals, totalCny } = group;
  const expanded = expandedBanks.has(bank.id), foreign = currencyTotals.some(item => item.currency !== 'CNY');
  const debt = accounts.some(account => context.balances[account.id] < 0);
  return `<section class="bank-group ${expanded ? 'is-expanded' : ''}${context.dealBankId === bank.id && expanded ? ' is-dealing' : ''}" data-bank-id="${bank.id}" data-card-stack="${Math.min(accounts.length,3)}" data-account-theme="${bank.id}" aria-label="${esc(bank.name)}的银行卡">
    <div class="bank-group-overview">${cardDecoration('bank')}<div class="bank-cover">
      <div class="account-identity">${accountLogo({ bankId:bank.id })}<div><h3>${esc(bank.name)}<span class="bank-card-count">${accounts.length} 张卡</span></h3><div class="account-type">${debt ? '包含负余额' : '每张卡独立记账'}${foreign ? ' · 多币种账户' : ''}</div></div></div>
      <div class="bank-total${totalCny < 0 ? ' is-negative' : ''}"><div class="card-balance-label">${foreign ? '合计余额 · 折合 CNY' : '合计余额 · CNY'}</div><div class="money">${formatAccountTotal(totalCny)}</div></div>
    </div><div class="bank-group-bottom"><div class="bank-currency-totals" aria-label="各币种合计">${foreign ? currencyTotals.map(({currency,amount})=>`<span class="money">${esc(formatAccountTotal(amount,currency))}</span>`).join('') : '<span class="bank-summary-note">同一银行，统一管理</span>'}</div><div class="bank-group-actions"><button class="bank-add-card" data-action="add-bank-account" data-bank-id="${bank.id}" aria-label="在${esc(bank.name)}添加银行卡">${icon('plus',14)} 添加银行卡</button><button class="bank-group-toggle" data-action="toggle-bank" data-bank-id="${bank.id}" aria-expanded="${expanded}" aria-controls="bank-cards-${bank.id}">${expanded ? '收起卡片' : `展开 ${accounts.length} 张卡`}${icon('right',14)}</button></div></div></div>
    <div id="bank-cards-${bank.id}" class="bank-group-members" ${expanded ? '' : 'hidden'}><div class="bank-members-heading"><span>旗下账户</span><small>余额按原币展示</small></div><div class="bank-member-grid">${expanded ? accounts.map(account=>renderCard(account,context)).join('') : ''}</div></div>
  </section>`;
}

export function renderAccountLibrary({ state, balances, cnyBalances, view, expandedBanks, dealBankId = '', icon, accountLogo }) {
  const groups = groupAccounts(state.accounts, { balances, cnyBalances });
  const banks = groups.filter(group=>group.kind === 'bank');
  const singles = groups.filter(group=>group.kind === 'account');
  const transactionCounts = new Map();
  for (const tx of state.transactions) {
    for (const id of new Set([tx.accountId, tx.toAccountId].filter(Boolean))) transactionCounts.set(id, (transactionCounts.get(id) || 0) + 1);
  }
  const context = { balances, cnyBalances, expandedBanks, dealBankId, icon, accountLogo, transactionCounts };
  const add = `<button class="add-card account-add-tile" data-action="add-account">${icon('plus',24)}<span>添加新账户</span><small>钱包、银行卡、现金与更多</small></button>`;
  const toolbar = `<div class="accounts-toolbar"><div><h2>我的账户<span>${state.accounts.length}</span></h2><p>${view === 'banks' ? '同一家银行，收在一起。' : '每一个账户，都清清楚楚。'}</p></div><div class="segmented account-view-switch" role="group" aria-label="账户展示方式">${[['banks','按银行合并'],['cards','全部单卡']].map(([key,label])=>`<button data-action="accounts-view" data-view="${key}" class="${view === key ? 'selected' : ''}" aria-pressed="${view === key}">${icon(key === 'banks' ? 'wallet' : 'grid',14)}${label}</button>`).join('')}</div></div>`;
  if (!state.accounts.length) return toolbar + `<div class="account-empty"><span>${icon('wallet',32)}</span><h3>给每一笔钱，一个归属。</h3><p>添加第一个账户，开始整理你的资产。</p><button class="btn btn-primary" data-action="add-account">${icon('plus',16)} 添加账户</button></div>`;
  if (view === 'cards') return toolbar + `<div class="account-library-grid all-account-cards">${state.accounts.map(account=>renderCard(account,context)).join('')}${add}</div>`;
  return toolbar + (banks.length ? `<section class="accounts-section" aria-label="银行卡"><div class="accounts-section-heading"><h3>${icon('bankCard',17)} 银行卡</h3><span>${banks.length} 家银行 · ${banks.reduce((count,bank)=>count+bank.accounts.length,0)} 张卡</span>${banks.length >= 2 ? `<button class="text-btn bank-toggle-all" data-action="toggle-all-banks">${banks.every(group=>expandedBanks.has(group.bank.id)) ? '全部收起' : '全部展开'}</button>` : ''}</div><div class="account-library-grid bank-library">${banks.map(group=>renderBank(group,context)).join('')}</div></section>` : '') + `<section class="accounts-section" aria-label="钱包与其他账户"><div class="accounts-section-heading"><h3>${icon('wallet',17)} 钱包与其他</h3><span>${singles.length} 个独立账户</span></div><div class="account-library-grid">${singles.map(group=>renderCard(group.account,context)).join('')}${add}</div></section>`;
}
