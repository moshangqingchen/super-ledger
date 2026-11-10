import { buildSubscriptionOverview, subscriptionPeriodLabel } from './subscription-overview.mjs';
import { formatAccountTotal } from './account-cards.js';
import { accountLabel } from './account-presets.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const hour = value => String(value).padStart(2, '0') + ':00';
const dayOrdinal = value => {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

function deadline(row, today) {
  const date = row.expiry.date;
  return { date, days: date ? dayOrdinal(date) - dayOrdinal(today) : null, kind: row.expiry.source === 'expiry' ? '到期' : '扣账' };
}

function expiryText(row) {
  if (row.expiry.source === 'none') return !row.sub.recurring && !row.due && row.sub.active ? '单次已完成' : '未设置到期日期';
  if (row.pending && row.expiry.source === 'renewal') return '等待扣账';
  return row.expiry.label;
}

function badges(row) {
  return (row.sub.active ? '' : '<span class="chart-badge is-muted">已暂停记账</span>')
    + `<span class="chart-badge expiry-${row.expiry.tone}">${esc(expiryText(row))}</span>`
    + (row.pending ? '<span class="chart-badge is-pending">待扣账</span>' : '')
    + (row.shortfall > 0 ? '<span class="chart-badge is-shortfall">单笔余额不足</span>' : '');
}

function placeStars(rows, today) {
  const candidates = rows.map(row => ({ row, ...deadline(row, today) }))
    .filter(item => item.days !== null && item.days >= 0 && item.days <= 30)
    .sort((left, right) => left.days - right.days || left.row.sub.name.localeCompare(right.row.sub.name));
  const occupied = [{ left: 252, right: 348, top: 191, bottom: 279 }];
  const stars = [];
  const angles = [-90, 90, 180, 0, ...Array.from({ length: 48 }, (_, index) => -180 + index * 7.5)];
  for (const item of candidates) {
    if (stars.length === 8) break;
    const radius = item.days <= 7 ? 112 + item.days / 7 * 24
      : item.days <= 15 ? 136 + (item.days - 7) / 8 * 30 : 166 + (item.days - 15) / 15 * 36;
    for (const angle of angles) {
      const radians = angle * Math.PI / 180;
      const x = 300 + Math.cos(radians) * radius, y = 235 + Math.sin(radians) * radius;
      const box = { left: x - 80, right: x + 80, top: y - 50, bottom: y + 50 };
      const overlaps = occupied.some(other => box.left < other.right + 8 && box.right > other.left - 8 && box.top < other.bottom + 8 && box.bottom > other.top - 8);
      if (box.left < 0 || box.right > 600 || box.top < 0 || box.bottom > 460 || overlaps) continue;
      occupied.push(box);
      stars.push({ ...item, x, y });
      break;
    }
  }
  return { stars, candidates };
}

function orbit(rows, today, { icon, subIcon }) {
  const { stars, candidates } = placeStars(rows, today);
  const outside = { paused: 0, expired: 0, later: 0, unset: 0 };
  for (const row of rows) {
    const item = deadline(row, today);
    if (!row.sub.active) outside.paused++;
    if (item.days === null) outside.unset++;
    else if (item.days < 0) outside.expired++;
    else if (item.days > 30) outside.later++;
  }
  const other = [['paused', '已暂停'], ['expired', '已过期'], ['later', '30 天外'], ['unset', '无日期']]
    .filter(([key]) => outside[key]).map(([key, label]) => `<span>${label} <b>${outside[key]}</b></span>`).join('');
  const nodes = stars.map(({ row, date, days, kind, x, y }) => {
    const label = `${row.sub.name} · ${date} ${kind} · ${days === 0 ? '今天' : days + ' 天后'}${row.sub.active ? '' : ' · 已暂停记账'}`;
    return `<button class="orbit-node${row.sub.active ? '' : ' is-paused'}" data-action="edit-subscription" data-id="${esc(row.sub.id)}" data-date="${date}" data-days="${days}" style="left:${(x / 6).toFixed(3)}%;top:${(y / 4.6).toFixed(3)}%" title="${esc(label)}" aria-label="编辑${esc(label)}">${subIcon(row.sub)}<span><b>${esc(row.sub.name)}</b><small>${Number(date.slice(5, 7))}/${Number(date.slice(8))} · ${days === 0 ? '今天' : days + ' 天'}</small></span></button>`;
  }).join('');
  return `<section class="subscription-chart-panel chart-orbit-panel"><div class="chart-panel-heading"><span>${icon('spark', 21)}</span><div><h2>订阅星图</h2><p>越靠近中心，提醒日期越近 · 北京时间</p></div></div><div class="subscription-orbit" aria-label="未来三十天的订阅到期与扣账提醒"><svg class="orbit-rings" viewBox="0 0 600 460" aria-hidden="true"><circle class="orbit-ring ring-30" cx="300" cy="235" r="202"/><circle class="orbit-ring ring-15" cx="300" cy="235" r="166"/><circle class="orbit-ring ring-7" cx="300" cy="235" r="136"/><path d="M98 235h404M300 33v404" class="orbit-guide"/></svg><div class="orbit-core" aria-hidden="true">${icon('calendar', 20)}<b>${candidates.length}</b><span>30 天内提醒</span></div>${nodes}</div><div class="orbit-legend"><span><i class="ring-7"></i>内圈 7 天</span><span><i class="ring-15"></i>中圈 15 天</span><span><i class="ring-30"></i>外圈 30 天</span></div><p class="orbit-caption">${candidates.length ? `星图显示 ${stars.length} / ${candidates.length} 项提醒，完整服务见下方。` : '当前筛选暂无 30 天内的提醒，完整服务见下方。'} 日期优先使用会员到期日。未填写会员到期日的连续订阅按下一次扣账日提醒。</p>${other ? `<div class="orbit-outside">${other}</div>` : ''}</section>`;
}

function attention(rows, { icon, subIcon, money }) {
  const priority = row => (row.shortfall > 0 ? 8 : 0) + (row.pending ? 4 : 0) + (row.expiry.days < 0 ? 2 : 0) + (row.expiry.days !== null && row.expiry.days >= 0 && row.expiry.days <= 7 ? 1 : 0);
  const flagged = rows.filter(row => priority(row) > 0).sort((left, right) => priority(right) - priority(left));
  const cards = flagged.slice(0, 4).map(row => `<article class="subscription-attention-item${row.shortfall > 0 ? ' has-shortfall' : ''}" data-id="${esc(row.sub.id)}"><button class="chart-service-link" data-action="edit-subscription" data-id="${esc(row.sub.id)}">${subIcon(row.sub)}<span><b>${esc(row.sub.name)}</b><small>${esc(row.sub.tier || (row.sub.recurring ? '连续订阅' : '单次订阅'))}</small></span>${icon('right', 14)}</button><div class="chart-badges">${badges(row)}</div>${row.shortfall > 0 ? `<p class="attention-money">单笔还差 ${money(row.shortfall, row.currency)}</p>` : ''}<p class="attention-dates">${row.expiry.date ? `${esc(row.expiry.date)} · ${esc(expiryText(row))}` : '会员到期日未填写'}${row.due ? `<br>${row.pending ? '待扣账' : '下次扣账'} ${row.due} ${hour(row.dueHour)} · 北京时间` : ''}</p></article>`).join('');
  return `<section class="subscription-chart-panel chart-attention-panel"><div class="chart-panel-heading"><span>${icon('bell', 21)}</span><div><h2>需要留意</h2><p>期限、待扣账和单笔余额分别核对</p></div></div><div class="chart-attention-list">${cards || `<div class="chart-attention-empty">${icon('check', 26)}<b>当前显示的订阅暂无紧急提醒</b><p>到期、待扣账和余额状态会随账本更新。</p></div>`}</div>${flagged.length > 4 ? `<p class="chart-section-note">另有 ${flagged.length - 4} 项提醒，见下方完整服务明细。</p>` : ''}</section>`;
}

function readiness(accounts, { icon, accountLogo, money, hidden }) {
  const cards = accounts.map(group => {
    const percentage = hidden ? null : Math.round(group.coverage * 100);
    const coverage = hidden ? '<p class="chart-coverage-private">金额已隐藏</p>'
      : `<div class="chart-coverage-line"><div class="coverage-track" role="meter" aria-label="下一笔费用覆盖比例" aria-valuenow="${percentage}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percentage}%"></span></div><span>${percentage}%</span></div>`;
    return `<article class="subscription-readiness-card${group.shortfall > 0 ? ' has-shortfall' : ''}" data-account-id="${esc(group.accountId)}"><div class="readiness-account"><div>${accountLogo(group.account)}<span><b>${esc(accountLabel(group.account))}</b><small>${group.currency} · ${group.subscriptions.length} 项订阅</small></span></div><span class="readiness-balance"><small>当前余额</small>${money(group.balance, group.currency)}</span></div><div class="readiness-amounts"><span>下一笔费用合计 ${money(group.amount, group.currency)}</span><span>${group.shortfall > 0 ? '合计还差 ' + money(group.shortfall, group.currency) : '合计余额充足'}</span></div>${coverage}<p class="readiness-due">最早扣账 ${group.due} ${hour(group.dueHour)} · 北京时间</p></article>`;
  }).join('');
  return `<section class="subscription-chart-panel chart-readiness-panel"><div class="chart-panel-heading"><span>${icon('wallet', 21)}</span><div><h2>续费准备</h2><p>同账户全部启用订阅的各下一笔费用，包含当前筛选外的订阅；余额只计一次。</p></div></div><div class="chart-readiness-grid">${cards || '<p class="chart-section-note">当前显示的订阅没有待安排的扣账账户。</p>'}</div></section>`;
}

function serviceList(rows, { icon, subIcon, money }) {
  const list = rows.map(row => `<li class="subscription-chart-service" data-id="${esc(row.sub.id)}"><button class="chart-service-link" data-action="edit-subscription" data-id="${esc(row.sub.id)}">${subIcon(row.sub)}<span><b>${esc(row.sub.name)}</b><small>${esc(row.sub.tier || (row.sub.recurring ? '连续订阅' : '单次订阅'))}</small></span></button><div class="chart-service-fee">${money(row.sub.amount, row.currency)}<small>/ ${subscriptionPeriodLabel(row.sub)}</small></div><div class="chart-service-dates"><span>会员到期 <b>${esc(row.sub.expiresOn || '未设置')}</b></span><span>${row.pending ? '待扣账' : '下次扣账'} <b>${row.due ? row.due + ' ' + hour(row.dueHour) : row.sub.active ? '已完成' : '已暂停'}</b></span><small>北京时间</small></div><div class="chart-service-funding"><div class="chart-badges">${badges(row)}</div><p>账户余额 ${money(row.balance, row.currency)}${row.shortfall > 0 ? '<br>单笔还差 ' + money(row.shortfall, row.currency) : ''}</p></div><button class="icon-btn" data-action="edit-subscription" data-id="${esc(row.sub.id)}" aria-label="编辑${esc(row.sub.name)}">${icon('edit', 16)}</button></li>`).join('');
  return `<section class="subscription-chart-panel chart-services-panel"><div class="chart-panel-heading"><span>${icon('ledger', 21)}</span><div><h2>订阅服务明细 <small>${rows.length} 项</small></h2><p>到期日期、北京时间扣账安排与单笔余额状态</p></div></div><div class="chart-service-columns" aria-hidden="true"><span>服务 / 会员</span><span>费用</span><span>到期与扣账时间</span><span>状态与账户余额</span><span></span></div><ul class="chart-service-list">${list}</ul></section>`;
}

export function renderSubscriptionChart({ state, visibleIds, hidden = false, icon, subIcon, accountLogo, now = new Date() }) {
  const overview = buildSubscriptionOverview(state, now);
  const rowById = new Map(overview.rows.map(row => [row.sub.id, row]));
  const rows = visibleIds.map(id => rowById.get(id)).filter(Boolean);
  const visible = new Set(visibleIds);
  const accounts = overview.accounts.filter(group => group.subscriptions.some(row => visible.has(row.sub.id)));
  const stats = {
    upcoming: rows.filter(row => row.expiry.days !== null && row.expiry.days >= 0 && row.expiry.days <= 30).length,
    urgent: rows.filter(row => row.expiry.days !== null && row.expiry.days >= 0 && row.expiry.days <= 7).length,
    pending: rows.filter(row => row.pending).length,
    shortfall: rows.filter(row => row.shortfall > 0).length,
  };
  const money = (value, currency) => hidden ? '<b class="money" aria-label="金额已隐藏">••••</b>' : `<b class="money">${esc(formatAccountTotal(value, currency))}</b>`;
  const context = { hidden, icon, subIcon, accountLogo, money };
  const statistics = [['upcoming', '30 天内到期 / 续费', 'calendar'], ['urgent', '7 天内到期 / 续费', 'spark'], ['pending', '待扣账', 'repeat'], ['shortfall', '单笔余额不足', 'info']]
    .map(([key, label, glyph]) => `<div class="chart-stat stat-${key}" data-chart-stat="${key}"><span>${icon(glyph, 22)}</span><div><small>${label}</small><b>${stats[key]} <em>项</em></b></div>${icon(glyph, 44)}</div>`).join('');
  if (!rows.length) return `<div class="subscription-chart"><div class="subscription-chart-stats">${statistics}</div><section class="subscription-chart-panel subscription-chart-empty">${icon('spark', 32)}<h2>${state.subscriptions.length ? '没有匹配的订阅' : '从第一项订阅开始'}</h2><p>${state.subscriptions.length ? '调整筛选或搜索，查看订阅的日期与资金安排。' : '添加服务后，星图和续费准备会跟随账本生成。'}</p><button class="btn btn-primary" data-action="add-subscription">${icon('plus', 16)} 添加订阅</button></section></div>`;
  return `<div class="subscription-chart"><div class="subscription-chart-stats">${statistics}</div><div class="subscription-chart-main">${orbit(rows, overview.today, context)}${attention(rows, context)}</div>${readiness(accounts, context)}${serviceList(rows, context)}</div>`;
}
