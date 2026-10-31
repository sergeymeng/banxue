import { apiBase } from './environment';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
const api = apiBase;
async function classroom(page: Page, request: APIRequestContext) {
  await page.goto('/');
  await expect(page.getByText('正在打开课堂…', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '课堂菜单', exact: true }).click();
  await page.getByRole('button', { name: '添加老师', exact: true }).first().click();
  const name = `Board ${Date.now()}`;
  await page.getByLabel('老师姓名').fill(name);
  await page.getByRole('button', { name: '创建并上课' }).click();
  await expect(page.getByTestId('teaching-board')).toBeVisible();
  const teachers = await (await request.get(`${api}/api/teachers`)).json();
  return teachers.find((t: { name: string }) => t.name === name);
}
async function draw(page: Page) {
  const box = (await page.getByTestId('teaching-board').boundingBox())!;
  await page.mouse.move(box.x + box.width * .3, box.y + box.width * .35); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .4, box.y + box.width * .45, { steps: 8 }); await page.mouse.up();
}

test('shared board: ink, teacher sequence, pause/cancel, undo, region PNG and restore', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const teacher = await classroom(page, request);
  try {
    await draw(page); await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await page.getByRole('button', { name: '白板更多功能' }).click();
    await page.getByText('开发演示与动作记录', { exact: true }).click();
    await page.getByRole('button', { name: '开发演示：逐步板书' }).click();
    await expect(page.locator('[data-author=teacher]')).toHaveCount(1);
    await page.getByRole('button', { name: '暂停板书', exact: true }).click();
    const paused = await page.getByTestId('queue-status').textContent(); await page.waitForTimeout(900);
    expect(await page.getByTestId('queue-status').textContent()).toBe(paused);
    await page.getByRole('button', { name: '继续板书', exact: true }).click();
    await expect(page.getByTestId('queue-status')).toContainText('已执行 8 · 待执行 0', { timeout: 10000 });
    await expect(page.locator('[data-author=teacher]')).toHaveCount(6);
    await expect(page.locator('[data-kind=rectangle]')).toHaveCount(0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('[data-author=teacher]')).toHaveCount(5);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.locator('[data-author=teacher]')).toHaveCount(6);
    await page.getByRole('button', { name: '白板更多功能' }).click();
    await page.getByRole('button', { name: '框选区域', exact: true }).click();
    const box = (await page.getByTestId('teaching-board').boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.width * .5); await page.mouse.up();
    const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '导出选区', exact: true }).click();
    const file = await downloading; expect(file.suggestedFilename()).toMatch(/board-.*\.png$/);
    const stream = await file.createReadStream(); const parts: Buffer[] = [];
    for await (const chunk of stream!) parts.push(Buffer.from(chunk));
    const png = Buffer.concat(parts); expect(png.subarray(1, 4).toString()).toBe('PNG'); expect(png.readUInt32BE(16)).toBeLessThanOrEqual(1200);
    let observed = false;
    await page.route('**/observe', async route => {
      const image: string = route.request().postDataJSON().image;
      expect(image).toMatch(/^data:image\/png;base64,/);
      const pixels = await page.evaluate(async image => {
        const img = new Image(); img.src = image; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
        let blue = 0, black = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          if (rgba[i + 2] > rgba[i] + 40) blue++;
          if (rgba[i] < 100 && rgba[i + 1] < 100 && rgba[i + 2] < 100) black++;
        }
        return { blue, black };
      }, image);
      expect(pixels.blue).toBe(0); expect(pixels.black).toBeGreaterThan(0); observed = true;
      await route.fulfill({ json: { skipped: '测试桩：不具备视觉识别' } });
    });
    await page.getByRole('button', { name: '请看这一步' }).click();
    await expect(page.getByRole('status')).toContainText('测试桩'); expect(observed).toBe(true);
    await page.getByRole('button', { name: '重试保存' }).click(); await page.reload();
    await expect(page.locator('[data-author=student]')).toHaveCount(1); await expect(page.locator('[data-author=teacher]')).toHaveCount(6);
    await page.getByRole('button', { name: '白板更多功能' }).click();
    await page.getByText('开发演示与动作记录', { exact: true }).click();
    await page.getByRole('button', { name: '开发演示：逐步板书' }).click();
    await page.getByRole('button', { name: '暂停板书', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); await page.reload();
    await page.getByRole('button', { name: '白板更多功能' }).click();
    await page.getByText('开发演示与动作记录', { exact: true }).click();
    await expect(page.getByTestId('queue-status')).toContainText('已暂停');
    await page.getByRole('button', { name: '取消待执行' }).click();
    await expect(page.getByTestId('queue-status')).toContainText('待执行 0');
    await page.getByText('动作记录', { exact: true }).click();
    await expect(page.locator('.board-queue li').filter({ hasText: 'cancelled' })).toHaveCount(8);
    await page.getByText('动作记录', { exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.screenshot({ path: 'test-results/teaching-board.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await request.delete(`${api}/api/teachers/${teacher.id}`); }
});

test('legacy snapshots stay untouched until explicit replacement; save failures are retryable', async ({ page, request }) => {
  const teacher = await classroom(page, request);
  try {
    const response = page.waitForRequest(r => r.url().endsWith('/board') && r.method() === 'PUT');
    await draw(page); const put = await response; await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const url = put.url(), legacy = { document: { store: { 'shape:old': { type: 'draw', text: 'old data' } } } };
    await request.put(url, { data: { snapshot: legacy } }); await page.reload();
    await expect(page.getByText('这是旧版或无法读取的白板快照。原始数据保持不变；新版暂不支持完整呈现。')).toBeVisible();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载原始快照' }).click();
    const stream = await (await download).createReadStream(); const parts: Buffer[] = [];
    for await (const part of stream!) parts.push(Buffer.from(part));
    expect(JSON.parse(Buffer.concat(parts).toString())).toEqual(legacy);
    let fail = true;
    await page.route('**/board', route => fail ? route.fulfill({ status: 503, json: { detail: 'test save failure' } }) : route.continue());
    await page.getByRole('button', { name: '保留原始快照并新建白板' }).click();
    await expect(page.getByRole('status')).toContainText('保存失败'); await draw(page); fail = false;
    const saved = page.waitForRequest(r => r.url().endsWith('/board') && r.postDataJSON().snapshot.elements.length === 1);
    await page.getByRole('button', { name: '重试保存' }).click();
    expect((await saved).postDataJSON().snapshot.legacySnapshot).toEqual(legacy);
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); await page.reload();
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
  } finally { await request.delete(`${api}/api/teachers/${teacher.id}`); }
});


test('touch input, cancelled pen gesture, eraser, and mobile board stay usable', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const teacher = await classroom(page, request);
  try {
    const board = page.getByTestId('teaching-board');
    await board.scrollIntoViewIfNeeded();
    const box = (await board.boundingBox())!;
    // Chromium touch emulation, not physical stylus/pressure validation.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 20, y: box.y + 20 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 50, y: box.y + 50 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 60, y: box.y + 60 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await page.getByRole('button', { name: '整笔擦除', exact: true }).click();
    await page.locator('[data-author=student] path').click({ position: { x: 10, y: 10 }, force: true });
    await expect(page.locator('[data-author=student]')).toHaveCount(0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally { await request.delete(`${api}/api/teachers/${teacher.id}`); }
});
