import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedgerServer } from '../server.mjs';

test('renderer additions are packaged and served by the unchanged static allowlist', async t => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'moneylab-ux-assets-'));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    const relative = path.relative(tempRoot, fs.realpathSync(directory));
    assert.ok(relative.startsWith('moneylab-ux-assets-') && !relative.includes(path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  server = await createLedgerServer({ port: 0, dataDirectory: directory, onlineRates: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  for (const filename of ['assets/ledger-insights.mjs', 'assets/ledger-actions.mjs', 'ledger-ui.css']) {
    assert.ok(pkg.build.files.includes(filename), `${filename} must ship in the installer`);
    const response = await fetch(`${origin}/${filename}`);
    assert.equal(response.status, 200, filename);
    assert.match(response.headers.get('content-type'), filename.endsWith('.css') ? /text\/css/ : /text\/javascript/);
    assert.equal(await response.text(), fs.readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8'));
    if (filename.endsWith('.mjs')) assert.ok(app.includes(`'./${filename}'`));
  }
  const index = await (await fetch(origin)).text();
  assert.match(index, /href="\/ledger-ui\.css"/);
});
