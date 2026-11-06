'use strict';

// Windows packaging uses installed tools only. It never installs dependencies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TOOL_ROOT = path.join(PROJECT_ROOT, 'node_modules');
const PROXY = 'http://127.0.0.1:10090';
const args = new Set(process.argv.slice(2));

function fail(message) { throw new Error(message); }
function file(filename, label = filename) {
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail(`缺少本地文件：${label}\n${filename}\n离线构建已停止，不会下载。`);
  return filename;
}
function directory(dirname, label = dirname) {
  if (!fs.existsSync(dirname) || !fs.statSync(dirname).isDirectory()) fail(`缺少本地目录：${label}\n${dirname}\n离线构建已停止，不会下载。`);
  return dirname;
}
function json(filename) { return JSON.parse(fs.readFileSync(file(filename), 'utf8').replace(/^\uFEFF/, '')); }
function children(dirname) {
  return fs.existsSync(dirname) ? fs.readdirSync(dirname, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(dirname, entry.name)).sort() : [];
}
function findBundle(envName, candidates, requiredFiles) {
  const explicit = process.env[envName];
  const choices = explicit ? [path.resolve(explicit)] : candidates;
  const result = choices.find(candidate => requiredFiles.every(name => {
    try { return fs.statSync(path.join(candidate, name)).isFile(); }
    catch { return false; }
  }));
  if (!result) fail(`未找到完整离线工具 ${envName}。需要：${requiredFiles.join(', ')}。\n请将该环境变量指向已有工具目录；不会自动下载。`);
  process.env[envName] = result;
  return result;
}

function configureOfflineEnvironment() {
  Object.assign(process.env, {
    HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, http_proxy: PROXY, https_proxy: PROXY,
    npm_config_proxy: PROXY, npm_config_https_proxy: PROXY,
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1', ELECTRON_BUILDER_OFFLINE: 'true',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  });
  // Fail before a JS library can request any remote URL. The native programs
  // used below are preflighted local NSIS/7-Zip tools, with publishing/signing off.
  const denied = () => fail('离线构建拒绝网络访问。请补齐本地工具，不能回退为下载。');
  for (const name of ['node:http', 'node:https']) {
    const module = require(name);
    module.request = denied;
    module.get = denied;
  }
  require('node:tls').connect = denied;
  const net = require('node:net');
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...connectArgs) {
    const first = connectArgs[0];
    const pipe = typeof first === 'string' && first.startsWith('\\\\.\\pipe\\')
      || first && typeof first === 'object' && typeof first.path === 'string' && first.path.startsWith('\\\\.\\pipe\\');
    if (!pipe) return denied();
    return originalConnect.apply(this, connectArgs);
  };
  globalThis.fetch = denied;
  require('node:module').syncBuiltinESMExports();
}

async function main() {
  const supported = new Set(['--dir', '--check', '--help']);
  for (const argument of args) if (!supported.has(argument)) fail(`未知参数：${argument}。可用参数：--dir、--check、--help。`);
  if (args.has('--help')) {
    console.log('node desktop/build.cjs          离线生成 Windows x64 安装包及 win-unpacked\nnode desktop/build.cjs --dir    仅生成 win-unpacked\nnode desktop/build.cjs --check  仅检查本地打包工具和配置\nLEDGER_DESKTOP_TOOLROOT 可覆盖已有 node_modules 工具目录。');
    return;
  }
  if (process.platform !== 'win32') fail('此离线构建脚本仅支持本机 Windows。');
  process.chdir(PROJECT_ROOT);
  configureOfflineEnvironment();

  const toolRoot = directory(path.resolve(process.env.LEDGER_DESKTOP_TOOLROOT || DEFAULT_TOOL_ROOT), 'Electron 工具根目录');
  const builderDirectory = directory(path.join(toolRoot, 'electron-builder'));
  const builderPackage = json(path.join(builderDirectory, 'package.json'));
  if (builderPackage.version !== '26.15.3') fail(`当前离线流程已核验 electron-builder 26.15.3，实际为 ${builderPackage.version}；请核验新工具后再更新脚本。`);
  const electronDirectory = directory(path.join(toolRoot, 'electron'));
  const electronPackage = json(path.join(electronDirectory, 'package.json'));
  const electronDist = directory(path.join(electronDirectory, 'dist'), '本地 Electron runtime');
  for (const item of ['electron.exe', 'version', 'icudtl.dat', 'resources.pak', 'LICENSE']) file(path.join(electronDist, item));
  const electronVersion = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(electronVersion) || electronVersion !== electronPackage.version) fail('Electron package.json 与 dist/version 不一致，离线构建已停止。');

  const manifest = json(path.join(PROJECT_ROOT, 'package.json'));
  if (!manifest.build || typeof manifest.build !== 'object') fail('package.json 尚未提供桌面 build 配置。');
  if (manifest.build.electronVersion && manifest.build.electronVersion !== electronVersion) fail(`项目要求 Electron ${manifest.build.electronVersion}，本机 runtime 是 ${electronVersion}。`);
  file(path.resolve(PROJECT_ROOT, manifest.main || 'desktop/main.cjs'), '桌面主进程入口');
  const icon = file(path.resolve(PROJECT_ROOT, manifest.build.win?.icon || 'assets/app-icon.ico'), 'Windows 应用图标');
  const iconHeader = fs.readFileSync(icon);
  if (iconHeader.length < 6 || iconHeader.readUInt16LE(0) !== 0 || iconHeader.readUInt16LE(2) !== 1 || iconHeader.readUInt16LE(4) === 0) fail('Windows 应用图标必须是有效的 ICO 文件。');

  const cache = directory(path.resolve(process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache')), 'electron-builder 本地缓存');
  process.env.ELECTRON_BUILDER_CACHE = cache;
  const sevenZip = process.env.ELECTRON_BUILDER_7ZIP_PATH
    ? file(path.resolve(process.env.ELECTRON_BUILDER_7ZIP_PATH), '7-Zip')
    : children(path.join(cache, '7zip@1.0.0')).map(dir => path.join(dir, 'bin', '7za.exe')).find(filename => fs.existsSync(filename));
  if (!sevenZip) fail('缺少本地 7za.exe，请设置 ELECTRON_BUILDER_7ZIP_PATH。不会自动下载。');
  process.env.ELECTRON_BUILDER_7ZIP_PATH = sevenZip;
  const icons = findBundle('ELECTRON_BUILDER_ICONS_TOOLSET_DIR', children(path.join(cache, 'icons@1.1.0')), ['icon-tool.js']);
  let nsis = null;
  let nsisResources = null;
  if (!args.has('--dir')) {
    const nsisFiles = ['Bin/makensis.exe', 'elevate.exe', 'Include/MUI2.nsh', ...['nsDialogs', 'nsExec', 'System', 'LangDLL', 'UserInfo'].map(name => `Plugins/x86-unicode/${name}.dll`)];
    const resourceFiles = ['UAC', 'StdUtils', 'WinShell', 'nsis7z', 'nsProcess'].map(name => `plugins/x86-unicode/${name}.dll`);
    // Prefer the verified extracted bundles. Old cache directories can contain
    // empty plugin folders left by an incomplete download and must not qualify.
    nsis = findBundle('ELECTRON_BUILDER_NSIS_DIR', [...children(path.join(cache, 'nsis-3.0.4.1')), path.join(cache, 'nsis', 'nsis-3.0.4.1')], nsisFiles);
    nsisResources = findBundle('ELECTRON_BUILDER_NSIS_RESOURCES_DIR', [...children(path.join(cache, 'nsis-resources-3.4.1')), path.join(cache, 'nsis', 'nsis-resources-3.4.1')], resourceFiles);
    if (manifest.build.nsis?.customNsisBinary || manifest.build.nsis?.customNsisResources) fail('离线构建不接受会触发下载的 NSIS 自定义资源配置，请使用本地环境变量覆盖。');
  }
  // Version 26.15.3 edits executable icons/metadata in-process with resedit.
  // Code signing stays disabled, so no winCodeSign download or timestamp call occurs.
  file(path.join(toolRoot, 'resedit', 'package.json'), '本地 Windows 资源编辑库 resedit');

  const electronGet = require(path.join(toolRoot, 'app-builder-lib', 'out', 'util', 'electronGet.js'));
  const binDownload = require(path.join(toolRoot, 'app-builder-lib', 'out', 'binDownload.js'));
  const noDownload = async () => fail('构建需要未配置的本地工具，已阻止自动下载。请补齐对应 ELECTRON_BUILDER_* 路径。');
  for (const name of ['downloadBuilderToolset', 'downloadElectronArtifactZip', 'downloadElectronArtifact']) electronGet[name] = noDownload;
  for (const name of ['download', 'getBinFromCustomLoc', 'getBinFromUrl', 'getBin']) binDownload[name] = noDownload;

  console.log(JSON.stringify({ mode: args.has('--dir') ? 'unpacked' : 'nsis', electron: electronVersion, builder: builderPackage.version, toolRoot, electronDist, sevenZip, icons, nsis, nsisResources, downloads: 'disabled' }, null, 2));
  if (args.has('--check')) { console.log('离线构建预检通过；尚未执行打包。'); return; }
  const builder = require(builderDirectory);
  const config = {
    ...manifest.build,
    electronVersion, electronDist,
    npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
    forceCodeSigning: false, publish: null,
    win: { ...manifest.build.win, icon, signAndEditExecutable: true, signExecutable: false },
    nsis: { ...manifest.build.nsis, installerIcon: manifest.build.nsis?.installerIcon || icon, uninstallerIcon: manifest.build.nsis?.uninstallerIcon || icon },
  };
  const outputs = await builder.build({ projectDir: PROJECT_ROOT, config, targets: builder.Platform.WINDOWS.createTarget(args.has('--dir') ? 'dir' : 'nsis', builder.Arch.x64), publish: 'never' });
  console.log('离线打包完成。');
  for (const output of outputs) console.log(output);
}

main().catch(error => {
  console.error(`\n构建失败：${error.message}`);
  process.exitCode = 1;
  // temp-file's asynchronous cleanup may otherwise finish with exit(0).
  // Match electron-builder's CLI behavior while allowing cleanup to complete.
  process.on('exit', () => { process.exitCode = 1; });
});
