const { _electron: electron, expect } = require('@playwright/test');
const { mkdtemp, readFile, access, mkdir } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '../..');
(async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'banxue-desktop-test-'));
  const executablePath = process.env.BANXUE_EXECUTABLE || path.join(root, 'dist/伴学-darwin-arm64/伴学.app/Contents/MacOS/Banxue');
  let app;
  let savedLesson;
  const launch = async () => {
    app = await electron.launch({ executablePath, env: { ...process.env, BANXUE_DATA_DIR: userData }, timeout: 60000 });
    const page = await app.firstWindow({ timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: '我的老师', exact: true })).toBeVisible();
    return page;
  };
  try {
    let page = await launch();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = new URL(page.url()).origin;
    const denied = await fetch(origin + '/api/teachers');
    if (denied.status !== 401) throw new Error('Desktop API accessible without desktop token');
    await page.getByRole('button', { name: '添加老师', exact: true }).last().click();
    await page.getByLabel('老师姓名').fill('Alex');
    await page.getByRole('button', { name: '创建并上课' }).click();
    await expect(page.locator('.chat-header strong')).toHaveText('Alex');
    const message = page.getByRole('textbox', { name: '给老师的消息' });
    await message.fill('我现在数学 B，还有一个月考试，我想冲 A*。');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(message).toHaveValue('');
    await message.fill('Edexcel'); await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.state-pill')).toHaveText('诊断测试');
    await page.locator('input[type=file]').setInputFiles(path.join(root, 'samples/derivatives.pdf'));
    await expect(page.getByText('derivatives.pdf', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '课堂', exact: true }).click();
    const canvas = page.locator('.tl-canvas'); await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + 170, box.y + 140); await page.keyboard.press('t');
    await page.mouse.click(box.x + 170, box.y + 140);
    await page.keyboard.insertText('y = (3x + 1)²\ndy/dx = 6(3x + 1)');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible();
    savedLesson = await page.evaluate(async () => {
      const teachers = await (await fetch('/api/teachers')).json();
      return (await (await fetch(`/api/teachers/${teachers[0].id}/lessons`)).json())[0].id;
    });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs/desktop-app.png') });
    await page.getByRole('button', { name: /设置/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('API 地址')).toBeVisible();
    await page.screenshot({ path: path.join(root, 'docs/desktop-settings.png') });
    const settings = await page.evaluate(() => window.desktop.getSettings());
    if (settings.roles.fast.api_key !== '') throw new Error('Secret returned to renderer');
    await page.getByRole('button', { name: '保存并应用' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('.state-pill')).toHaveText('诊断测试');
    await app.close(); app = null;
    // A new OS process must reopen the exact same lesson and board.
    app = await electron.launch({ executablePath, env: { ...process.env, BANXUE_DATA_DIR: userData }, timeout: 60000 });
    page = await app.firstWindow();
    await expect(page.locator('.state-pill')).toHaveText('诊断测试');
    await expect(page.locator('.tl-shape')).toHaveCount(1);
    const resumed = await page.evaluate(async () => {
      const teachers = await (await fetch('/api/teachers')).json();
      return (await (await fetch(`/api/teachers/${teachers[0].id}/lessons`)).json())[0].id;
    });
    if (savedLesson !== resumed) throw new Error('Wrong resumed lesson');
    const childPort = new URL(page.url()).origin;
    await app.close(); app = null;
    let exited = false;
    for (let i = 0; i < 30; i++) { try { await fetch(childPort + '/health'); } catch { exited = true; break; } await new Promise(r => setTimeout(r, 100)); }
    if (!exited) throw new Error('Backend was not stopped on quit');
    if (errors.length) throw new Error(errors.join('\n'));
    await access(path.join(userData, 'learning/tutor.db'));
    console.log('PASS packaged .app: launch, token isolation, teacher, PDF, conversation, real canvas, settings save/restart, process restart persistence, backend shutdown.');
    console.log('Screenshots: docs/desktop-app.png and docs/desktop-settings.png');
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
