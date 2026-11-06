'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..');
const jar = path.join(__dirname, 'lib', 'core-3.5.3.jar');
const build = path.join(root, 'android', 'build', 'qr-interop');
fs.mkdirSync(build, { recursive: true });
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'assets', 'vendor', 'qrcodegen.js'), 'utf8'), context);
const { QrCode } = context.qrcodegen;
execFileSync('javac.exe', ['-encoding', 'UTF-8', '-cp', jar, '-d', build, path.join(__dirname, 'QrInteropTest.java')], { stdio: 'inherit' });
for (const addresses of [['http://192.168.1.100:49392'], ['http://192.168.1.100:49392', 'http://10.1.2.3:49392', 'http://172.16.1.30:49392']]) {
  const payload = JSON.stringify({ app: 'superledger', v: 1, protocolVersion: 2, addresses,
    sessionId: '0123456789abcdef0123456789abcdef', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', expiresAt: 1793999999000 });
  const qr = QrCode.encodeText(payload, QrCode.Ecc.MEDIUM);
  const scale = 6, border = 4, size = (qr.size + border * 2) * scale;
  const pixels = Buffer.alloc(size * size, 255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (qr.getModule(Math.floor(x / scale) - border, Math.floor(y / scale) - border)) pixels[y * size + x] = 0;
  }
  const raster = path.join(build, 'pairing.gray');
  const expected = path.join(build, 'pairing.json');
  fs.writeFileSync(raster, pixels);
  fs.writeFileSync(expected, payload);
  execFileSync('java.exe', ['-cp', [build, jar].join(path.delimiter), 'QrInteropTest', String(size), raster, expected], { stdio: 'inherit' });
}
