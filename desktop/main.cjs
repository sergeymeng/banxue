const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, session, shell, systemPreferences } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { microphoneAllowed } = require('./permissions.cjs');
const { defaults, validateSettings, publicSettings, toEnvironment } = require('./settings.cjs');
app.setName('伴学');
app.setPath('userData', process.env.BANXUE_DATA_DIR || path.join(app.getPath('appData'), 'Banxue'));
let win, engine, origin, port, shuttingDown = false, restarting = false;
const localToken = randomBytes(32).toString('hex');
const userData = app.getPath('userData');
const configPath = path.join(userData, 'settings.json');
let config = defaults();
const resourceRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../build/desktop-resources');
const enginePath = path.join(resourceRoot, 'tutor-engine', 'tutor-engine');

async function readSettings() {
  let file;
  try { file = JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return defaults(); throw new Error('设置文件无法读取。请保留数据文件夹后联系维护者。'); }
  if (file.encrypted) {
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(file.payload, 'base64'));
    const value = validateSettings(JSON.parse(decrypted.result));
    if (decrypted.shouldReEncrypt) await writeSettings(value);
    return value;
  }
  if ((file.value?.voice?.api_key || Object.values(file.value?.roles || {}).some(role => role.api_key))) throw new Error('拒绝读取明文密钥。');
  return validateSettings(file.value);
}
async function writeSettings(value) {
  const hasSecrets = value.voice?.api_key || Object.values(value.roles).some(role => role.api_key);
  let envelope;
  if (hasSecrets) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('系统密钥存储暂不可用，密钥没有保存。');
    envelope = { encrypted: true, payload: (await safeStorage.encryptStringAsync(JSON.stringify(value))).toString('base64') };
  } else envelope = { encrypted: false, value };
  await fs.writeFile(configPath + '.tmp', JSON.stringify(envelope), { mode: 0o600 });
  await fs.rename(configPath + '.tmp', configPath);
}
async function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
}
async function stopEngine() {
  const child = engine; engine = null;
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
}
async function startEngine() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(VOICE_|FAST_|REASONING_|VISION_|MODEL_MODE$|CONTEXT_TOKENS$|MAX_OUTPUT_TOKENS$|COMPLETION_TOKEN_FIELD$|REQUEST_BUDGET_|SESSION_BUDGET_|DAILY_BUDGET_)/.test(key)) delete env[key];
  Object.assign(env, toEnvironment(config), { DATA_DIR: path.join(userData, 'learning'), FRONTEND_DIR: path.join(resourceRoot, 'web'), DESKTOP_TOKEN: localToken, DESKTOP_PORT: String(port), ALLOWED_ORIGINS: origin, PYTHONUNBUFFERED: '1' });
  const child = spawn(enginePath, [], { cwd: userData, env, stdio: ['ignore', 'pipe', 'pipe'] });
  engine = child;
  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  // Never surface raw child output: external errors can contain sensitive configuration.
  child.stdout.resume(); child.stderr.resume();
  child.on('exit', () => { if (!shuttingDown && !restarting && engine === child && win) dialog.showMessageBox(win, { type: 'error', message: '课堂服务已停止', detail: '学习记录仍保存在本机。请退出并重新打开伴学。' }); });
  for (let n = 0; n < 150; n++) {
    if (spawnFailed || child.exitCode !== null) throw new Error('内置课堂服务未能启动。请检查应用包是否完整。');
    try { const response = await fetch(origin + '/health', { headers: { 'X-Desktop-Token': localToken }, signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('内置课堂服务启动超时。');
}
function checkSender(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith(origin + '/')) throw new Error('不允许该页面访问桌面设置。');
}
function registerIPC() {
  ipcMain.handle('settings:read', async event => { checkSender(event); return publicSettings(config); });
  ipcMain.handle('settings:save', async (event, input) => {
    checkSender(event);
    if (restarting) throw new Error('设置正在保存，请稍候。');
    const next = validateSettings(input, config);
    const previous = config;
    restarting = true;
    try {
      await writeSettings(next); config = next;
      await stopEngine(); await startEngine();
      return { saved: true };
    } catch (error) {
      config = previous;
      await writeSettings(previous).catch(() => {});
      await stopEngine(); await startEngine().catch(() => {});
      throw new Error(error.message.includes('密钥') ? error.message : '设置未能应用，已尝试恢复上一次配置。');
    } finally { restarting = false; }
  });
  ipcMain.handle('data:open', async event => { checkSender(event); await shell.openPath(path.join(userData, 'learning')); });
  ipcMain.handle('teacher:export', async (event, teacherId) => {
    checkSender(event);
    if (typeof teacherId !== 'string' || !/^[a-f0-9]{32}$/.test(teacherId)) throw new Error('教师 ID 无效。');
    const response = await fetch(`${origin}/api/teachers/${teacherId}/export`, { headers: { 'X-Desktop-Token': localToken } });
    if (!response.ok) throw new Error('导出失败。');
    const result = await dialog.showSaveDialog(win, { defaultPath: '学习记录.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled) return { saved: false };
    await fs.writeFile(result.filePath, JSON.stringify(await response.json(), null, 2), { mode: 0o600 });
    return { saved: true };
  });
}
function makeWindow() {
  win = new BrowserWindow({ width: 1360, height: 880, minWidth: 960, minHeight: 640, title: '伴学', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 }, backgroundColor: '#ffffff', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => win.show());
  win.loadURL(origin);
}
function menus() {
  const command = name => () => win?.webContents.send('menu:command', name);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '伴学', submenu: [{ role: 'about', label: '关于伴学' }, { label: '设置…', accelerator: 'CmdOrCtrl+,', click: command('settings') }, { type: 'separator' }, { role: 'hide', label: '隐藏伴学' }, { role: 'quit', label: '退出伴学' }] },
    { label: '文件', submenu: [{ label: '添加老师…', accelerator: 'CmdOrCtrl+N', click: command('teacher') }, { label: '导入教材…', accelerator: 'CmdOrCtrl+O', click: command('upload') }, { type: 'separator' }, { role: 'close', label: '关闭窗口' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'togglefullscreen', label: '全屏' }] },
  ]));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    await fs.mkdir(userData, { recursive: true, mode: 0o700 });
    config = await readSettings();
    port = await freePort(); origin = `http://127.0.0.1:${port}`;
    session.defaultSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      const allowed = microphoneAllowed({ wc, expected: win?.webContents, origin, permission, details });
      if (!allowed) return callback(false);
      try { callback(process.platform !== 'darwin' || await systemPreferences.askForMediaAccess('microphone')); }
      catch { callback(false); }
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
      microphoneAllowed({ wc, expected: win?.webContents, origin, permission,
        details: { ...details, requestingUrl: requestingOrigin } }));
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, 'X-Desktop-Token': localToken } }));
    session.defaultSession.webRequest.onHeadersReceived({ urls: [origin + '/*'] }, (details, callback) => callback({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'" ] } }));
    await startEngine(); registerIPC(); menus(); makeWindow();
    app.on('activate', () => { if (!win) makeWindow(); });
  }).catch(async () => { dialog.showErrorBox('伴学未能启动', '内置服务或设置无法加载。请确认应用包完整；你的学习记录不会被删除。'); await stopEngine(); app.exit(1); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (shuttingDown) return; event.preventDefault(); shuttingDown = true; stopEngine().finally(() => app.exit()); });
