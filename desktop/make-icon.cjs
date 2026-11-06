'use strict';

// Convert the generated PNG into Windows icon sizes. Never redraw or replace it.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'assets', 'app-icon.png');
const outputPath = path.join(root, 'assets', 'app-icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const offlineSwitches = ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings'];

function compileIcon(nativeImage) {
  const source = nativeImage.createFromBuffer(fs.readFileSync(sourcePath));
  if (source.isEmpty()) throw new Error(`无法读取源 PNG：${sourcePath}`);
  const originalSize = source.getSize();
  if (originalSize.width !== originalSize.height || originalSize.width < 256) {
    throw new Error('源 PNG 必须为至少 256 × 256 的正方形；不会自动裁切或补边。');
  }

  const images = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16;
    const dimension = sizes[index] === 256 ? 0 : sizes[index];
    directory[entry] = dimension;
    directory[entry + 1] = dimension;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  fs.writeFileSync(outputPath, Buffer.concat([directory, ...images]));
  console.log(`Created ICO (${sizes.join(', ')} px) from ${originalSize.width} × ${originalSize.height} PNG; source PNG unchanged.`);
}

if (process.versions.electron && process.type === 'browser') {
  const { app, nativeImage } = require('electron');
  // Work synchronously before app readiness: no windows, sessions or services.
  for (const name of offlineSwitches) app.commandLine.appendSwitch(name);
  app.disableHardwareAcceleration();
  try {
    compileIcon(nativeImage);
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
} else {
  try {
    const toolRoot = path.resolve(process.env.LEDGER_DESKTOP_TOOLROOT || path.join(root, 'node_modules'));
    const electron = path.join(toolRoot, 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(electron)) throw new Error(`缺少本地 Electron：${electron}\n请设置 LEDGER_DESKTOP_TOOLROOT；不会下载。`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    Object.assign(environment, {
      HTTP_PROXY: 'http://127.0.0.1:10090', HTTPS_PROXY: 'http://127.0.0.1:10090',
      http_proxy: 'http://127.0.0.1:10090', https_proxy: 'http://127.0.0.1:10090',
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    });
    const result = spawnSync(electron, [
      ...offlineSwitches.map(name => `--${name}`),
      '--proxy-server=http://127.0.0.1:10090', __filename,
    ], { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
