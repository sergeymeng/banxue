import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { apiBase } from './environment';
// Full Chromium includes the native PDF viewer; headless-shell does not.
test.use({ channel: 'chromium' });

async function cleanup(request: APIRequestContext) {
  const teachers = await (await request.get(`${apiBase}/api/teachers`)).json();
  for (const teacher of teachers) if (teacher.name.includes('· 界面测试') || teacher.name.includes('· 触摸测试')) await request.delete(`${apiBase}/api/teachers/${teacher.id}`);
}
test.beforeAll(async ({ request }) => cleanup(request));
test.afterEach(async ({ request }) => cleanup(request));

async function openClassroom(page: Page, request: APIRequestContext, name: string) {
  const teacher = await (await request.post(`${apiBase}/api/teachers`, { data: { name } })).json();
  await page.goto('/');
  await expect(page.getByTestId('teaching-board')).toBeVisible();
  await page.getByRole('button', { name: '课堂菜单', exact: true }).click();
  await page.getByRole('button', { name: `${name} A-level 数学`, exact: true }).click();
  await expect(page.getByTestId('teaching-board')).toBeVisible();
  return teacher;
}
async function demonstrate(page: Page) {
  await page.getByRole('button', { name: '白板更多功能' }).click();
  await page.getByText('开发演示与动作记录', { exact: true }).click();
  await page.getByRole('button', { name: '开发演示：逐步板书' }).click();
  await expect(page.getByTestId('queue-status')).toContainText('已执行 8 · 待执行 0', { timeout: 12000 });
  await page.getByRole('button', { name: '白板更多功能' }).click();
}

test('classroom shell keeps the board mounted across resources, teacher switch and collapsed explanation', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const teacher = await openClassroom(page, request, '林老师 · 界面测试');
  let second: { id: string } | undefined;
  try {
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.getByRole('button', { name: '开发演示：逐步板书' })).toBeHidden();
    await demonstrate(page);
    const board = page.getByTestId('teaching-board');
    const box = (await board.boundingBox())!;
    await page.mouse.move(box.x + 160, box.y + 300); await page.mouse.down();
    await page.mouse.move(box.x + 205, box.y + 330, { steps: 8 }); await page.mouse.up();
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await board.focus(); await page.keyboard.press('Control+z');
    await expect(page.locator('[data-author=student]')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const before = (await board.boundingBox())!.width;
    await page.getByRole('button', { name: '收起讲解', exact: true }).click();
    expect((await board.boundingBox())!.width).toBeGreaterThan(before);
    await expect(page.getByRole('button', { name: '开始语音课堂' })).toBeVisible();
    await page.getByRole('button', { name: '展开讲解', exact: true }).click();
    await page.getByRole('button', { name: '教材', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles('../samples/derivatives.pdf');
    await page.getByRole('button', { name: 'derivatives.pdf', exact: true }).click();
    await expect(page.getByTitle('教材预览：derivatives.pdf')).toHaveAttribute('src', /^blob:/);
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await mkdir('../docs/classroom-ui', { recursive: true });
    await page.getByTitle('教材预览：derivatives.pdf').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500); // Let the browser's out-of-process PDF compositor paint for visual QA.
    await page.screenshot({ path: '../docs/classroom-ui/materials.png' });
    await page.getByRole('button', { name: '返回课堂' }).click();
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await page.screenshot({ path: '../docs/classroom-ui/desktop.png' });
    second = await (await request.post(`${apiBase}/api/teachers`, { data: { name: '另一位老师 · 界面测试' } })).json();
    await page.reload();
    await expect(page.getByTestId('teaching-board')).toBeVisible();
    await page.getByRole('button', { name: '课堂菜单', exact: true }).click();
    await page.getByRole('button', { name: '另一位老师 · 界面测试 A-level 数学', exact: true }).click();
    await expect(page.locator('[data-author=student]')).toHaveCount(0);
    await page.getByRole('button', { name: '课堂菜单', exact: true }).click();
    await page.getByRole('button', { name: '林老师 · 界面测试 A-level 数学', exact: true }).click();
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await expect(page.locator('[data-author=teacher]')).toHaveCount(6);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`${apiBase}/api/teachers/${teacher.id}`);
    if (second) await request.delete(`${apiBase}/api/teachers/${second.id}`);
  }
});

test('narrow classroom opens on ink, maps zoomed coordinates and pans without writing', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const teacher = await openClassroom(page, request, '林老师 · 触摸测试');
  try {
    await expect(page.locator('.conversation')).toBeHidden();
    await expect(page.getByRole('button', { name: '开始语音课堂' })).toBeInViewport();
    await expect(page.getByRole('button', { name: '结束本节' })).toBeInViewport();
    const board = page.getByTestId('teaching-board');
    await page.getByLabel('白板缩放').selectOption('2');
    const geometry = await board.evaluate(svg => {
      const node = svg as SVGSVGElement, box = node.getBoundingClientRect();
      const start = { x: box.x + 70, y: box.y + 80 };
      const end = { x: box.x + 140, y: box.y + 120 };
      const expected = new DOMPoint(start.x, start.y).matrixTransform(node.getScreenCTM()!.inverse());
      return { start, end, expected: { x: expected.x, y: expected.y } };
    });
    const saved = page.waitForRequest(r => r.url().endsWith('/board') && r.method() === 'PUT' && r.postDataJSON().snapshot.elements.some((e: { author: string }) => e.author === 'student'));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [geometry.start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [geometry.end] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const stroke = (await saved).postDataJSON().snapshot.elements.find((e: { author: string }) => e.author === 'student');
    expect(stroke.points[0].x).toBeCloseTo(geometry.expected.x, 1); expect(stroke.points[0].y).toBeCloseTo(geometry.expected.y, 1);
    await page.getByRole('button', { name: '移动画布', exact: true }).click();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [geometry.end] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [geometry.start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await page.locator('.board-scroll').evaluate(el => el.scrollLeft)).toBeGreaterThan(20);
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await page.locator('.board-scroll').evaluate(el => el.scrollTo(0, 0));
    await page.getByRole('button', { name: '书写', exact: true }).click();
    await demonstrate(page);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: '../docs/classroom-ui/narrow.png' });
    await page.getByRole('button', { name: '展开讲解', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '给老师的消息' })).toBeInViewport();
    await page.screenshot({ path: '../docs/classroom-ui/narrow-explanation.png' });
    await page.getByRole('button', { name: '收起讲解面板' }).click();
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
  } finally { await request.delete(`${apiBase}/api/teachers/${teacher.id}`); }
});
