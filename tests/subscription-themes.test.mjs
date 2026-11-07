import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscriptionCatalog } from '../subscription-catalog.mjs';

const css = readFileSync(new URL('../subscription-polish.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
// Leaf rules also include declarations nested inside responsive @media blocks.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.trim(), body,
  declarations: new Map([...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)]
    .map(([, name, value]) => [name, value.trim()])),
}));
const base = rules.find(rule => rule.selector === '.subscription-grid > .subscription-card'
  && rule.declarations.has('--sub-motif'));
const motifDirectory = new URL('../assets/brands/motifs/', import.meta.url);

function motifPath(value) {
  const match = /^url\(\s*(["']?)(\/assets\/brands\/motifs\/[a-z0-9-]+\.svg)\1\s*\)$/.exec(value || '');
  assert.ok(match, `motif must be a local SVG directly inside assets/brands/motifs/: ${value}`);
  return match[2];
}

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function compactCard({ hidden = false, sub = {}, balance = 500 } = {}) {
  const [source] = /function subscriptionCompact\(s,status,currentBalances\)\{[\s\S]*?\r?\n\}\r?\n/.exec(appSource);
  const account = { id: 'a', name: '钱包' };
  const render = new Function(
    'hidden', 'esc', 'icon', 'subIcon', 'accountById', 'accountCurrency', 'accountLogo', 'accountLabel', 'subscriptionMoney', 'subscriptionDifferenceMoney',
    `${source}; return subscriptionCompact;`,
  )(hidden, value => String(value).replace(/</g, '&lt;'), () => '<svg></svg>', () => '<span class="service-logo"></span>',
    id => (id === 'a' ? account : undefined), () => 'USD', () => '<span class="account-logo"></span>', () => '钱包账户', s => `USD ${s.amount / 100}`, (units, code) => `${code} ${units / 100}`);
  return render(
    { id: 's1', name: 'Claude', tier: 'Pro', amount: 300, accountId: 'a', recurring: true, active: true, note: '私密备注', linkedAccounts: [{ type: 'email', value: 'login@example.com' }], ...sub },
    { tone: 'soon', label: '26 天后到期', date: '2026-12-02' },
    { a: balance },
  );
}

test('compact subscription cards keep the key facts and leave the details to the full view', () => {
  const html = compactCard();
  for (const expected of ['is-compact', 'data-expiry="soon"', 'Claude', 'Pro', 'USD 3', '/ 月', '26 天后到期', '2026-12-02', '余额充足', 'data-action="edit-subscription"']) {
    assert.ok(html.includes(expected), `missing ${expected}`);
  }
  for (const detail of ['私密备注', 'login@example.com', '关联登录账号', 'toggle-subscription', '按当前余额比较']) {
    assert.ok(!html.includes(detail), `should not show ${detail}`);
  }
  assert.match(compactCard({ sub: { active: false } }), /paused[\s\S]*记账已暂停/);
  assert.ok(compactCard({ sub: { name: '<img src=x>' } }).includes('&lt;img src=x>'));
});

test('compact funding states the shortfall and masks it in privacy mode', () => {
  const short = compactCard({ balance: 100 });
  assert.match(short, /data-funding="shortfall"/);
  assert.match(short, /余额不足，还差 <b class="money">USD 2<\/b>/);
  const masked = compactCard({ balance: 100, hidden: true });
  assert.ok(masked.includes('aria-label="金额已隐藏">••••'));
  assert.ok(!masked.includes('USD 2'));
  assert.match(compactCard({ balance: 300 }), /data-funding="enough"[\s\S]*余额充足/);
  assert.doesNotMatch(compactCard({ sub: { accountId: 'gone' } }), /compact-funding/);
});

test('the view switch only accepts known views and the desktop preference is validated', () => {
  assert.ok(appSource.includes(`case'subscription-view':{if(!['detailed','compact'].includes(target.dataset.view))break;`));
  assert.ok(appSource.includes(`if(subscriptionView==='compact')return subscriptionCompact(s,status,currentBalances);`));
  assert.ok(appSource.includes(`aria-label="订阅展示方式"`));
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /ledger:subscription-view',\(event,view\)=>\{\s*trusted\(event\);if\(!SUBSCRIPTION_VIEWS\.includes\(view\)\)throw/);
  assert.ok(main.includes('if(SUBSCRIPTION_VIEWS.includes(p.subscriptionView))preferences.subscriptionView=p.subscriptionView;'));
  const preload = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.ok(preload.includes(`setSubscriptionView:view=>ipcRenderer.invoke('ledger:subscription-view',view)`));
  assert.ok(preload.includes(`{keepInTray:Boolean(value.keepInTray)}`), 'the tray preference path stays separate');
});

test('compact cards leave the detailed subgrid and motifs stay whole in both views', () => {
  const declarations = selector => rules.find(rule => rule.selector === selector)?.declarations;
  assert.equal(declarations('.subscription-grid.is-compact > :is(.subscription-card, .add-card)')?.get('grid-row'), 'auto');
  assert.equal(declarations('.subscription-grid > .subscription-card.is-compact')?.get('display'), 'flex');
  assert.equal(declarations('.subscription-grid > .subscription-card::before')?.has('mask-image'), false);
  assert.ok(readFileSync(new URL('claude.svg', motifDirectory), 'utf8').includes('shape-rendering="crispEdges"'), 'the Claude mascot keeps blocky edges');
});

test('every subscription catalog service and the generic fallback define a complete theme', () => {
  assert.ok(base, 'custom subscriptions have a generic card theme');
  const themes = [['generic', base]];
  for (const { id } of subscriptionCatalog) {
    const selector = `.subscription-card:has(.service-logo[data-service="${id}"])`;
    const rule = rules.find(candidate => candidate.selector.endsWith(selector)
      && candidate.declarations.has('--sub-motif'));
    assert.ok(rule, `${id} has its own service-logo theme selector`);
    themes.push([id, rule]);
  }
  for (const [id, { declarations }] of themes) {
    for (const token of ['--subscription-accent', '--sub-glow', '--sub-tint']) {
      assert.match(declarations.get(token) || '', /^#[\da-f]{6}$/i, `${id} defines ${token}`);
    }
    assert.equal(motifPath(declarations.get('--sub-motif')), `/assets/brands/motifs/${id}.svg`);
  }
});

test('every motif reference resolves to an existing SVG inside the motif directory', () => {
  const root = realpathSync(motifDirectory);
  const references = [...css.matchAll(/--sub-motif\s*:\s*([^;}]+)/g)];
  assert.ok(references.length >= subscriptionCatalog.length + 1);
  for (const [, value] of references) {
    const file = new URL(`..${motifPath(value.trim())}`, import.meta.url);
    assert.ok(statSync(file).isFile(), `${value} exists`);
    const relative = path.relative(root, realpathSync(file));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${value} stays inside motifs`);
  }
});

test('handwritten motif SVGs keep the shared viewBox, size limit and passive vector-only markup', () => {
  const filenames = readdirSync(motifDirectory).filter(name => name.endsWith('.svg'));
  assert.ok(filenames.length >= subscriptionCatalog.length + 1);
  for (const filename of filenames) {
    const bytes = readFileSync(path.join(fileURLToPath(motifDirectory), filename));
    const svg = bytes.toString('utf8');
    assert.ok(bytes.length <= 8 * 1024, `${filename} is at most 8 KB (${bytes.length} bytes)`);
    assert.match(svg, /<svg\b[^>]*\bviewBox\s*=\s*(["'])0 0 240 240\1/, `${filename} has the shared viewBox`);
    assert.doesNotMatch(svg, /<\s*(?:[\w-]+:)?(?:script|image|foreignObject|text)\b/i, `${filename} is vector-only`);
    assert.doesNotMatch(svg, /\bhref\s*=|\son[\w:.-]*\s*=/i, `${filename} has no references or event handlers`);
  }
});

test('the two default outer halos never exceed the accepted opacity limits', () => {
  assert.ok(base, 'base card theme exists');
  const shadow = base.declarations.get('box-shadow') || '';
  for (const [blur, token, maximum] of [[8, '--halo-a', 16], [22, '--halo-b', 9]]) {
    assert.match(shadow, new RegExp(`(?:^|,)\\s*0\\s+0\\s+${blur}px(?:\\s+1px)?\\s+color-mix\\(\\s*in\\s+srgb\\s*,\\s*var\\(--sub-glow\\)\\s+var\\(${token}\\)\\s*,\\s*transparent\\s*\\)`));
    const percentage = /^(\d+(?:\.\d+)?)%$/.exec(base.declarations.get(token) || '');
    assert.ok(percentage, `${token} has an explicit default percentage`);
    assert.ok(Number(percentage[1]) <= maximum, `${blur}px halo stays at or below ${maximum}%`);
    for (const rule of rules.filter(rule => !rule.selector.includes(':hover') && rule.declarations.has(token))) {
      const value = /^(\d+(?:\.\d+)?)%$/.exec(rule.declarations.get(token));
      assert.ok(value && Number(value[1]) <= maximum, `${rule.selector} does not raise the resting ${blur}px halo`);
    }
  }
});

test('the transparent expiry border overrides the legacy line on resting and hovered cards', () => {
  assert.ok(base, 'base card theme exists');
  assert.match(base.declarations.get('border') || '', /^1px\s+solid\s+transparent$/);
  const override = rules.find(rule => rule.selector === '.subscription-grid > .subscription-card[data-expiry]');
  assert.equal(override?.declarations.get('border-top-color'), 'transparent');

  // The override has the same specificity (0,3,0) as the legacy hover selector;
  // loading it after fresh-ui.css makes it win without changing semantic colors.
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const stylesheets = [...index.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)]
    .map(match => match[1]);
  assert.ok(stylesheets.indexOf('/fresh-ui.css') >= 0);
  assert.ok(stylesheets.indexOf('/subscription-polish.css') > stylesheets.indexOf('/fresh-ui.css'));
  assert.doesNotMatch(css, /border-top(?:-color)?\s*:[^;}]*var\(--expiry-dot/);
});
