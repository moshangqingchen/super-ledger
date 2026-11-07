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
