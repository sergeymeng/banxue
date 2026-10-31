import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { apiBase } from './environment';

test('shared PDF: draw, undo, page isolation, save failure, classroom switch and reload', async ({page, request}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const teacher = await (await request.post(`${apiBase}/api/teachers`, {data: {name: '陈老师'}})).json();
  const lesson = await (await request.post(`${apiBase}/api/teachers/${teacher.id}/lessons`, {data: {}})).json();
  const material = await (await request.post(`${apiBase}/api/teachers/${teacher.id}/documents`, {multipart: {file: {name: '链式法则练习.pdf', mimeType: 'application/pdf', buffer: await readFile('tests/fixtures/classroom-pages.pdf')}}})).json();
  await page.addInitScript(id => localStorage.setItem('banxue.lastTeacher', id), teacher.id);
  try {
    await page.goto('/'); await expect(page.getByTestId('teaching-board')).toBeVisible();
    await expect(page.locator('.conversation')).toBeHidden();
    await page.getByRole('button', {name: '教材', exact: true}).first().click();
    await page.getByRole('button', {name: /链式法则练习.pdf/}).click();
    const canvas = page.getByTestId('material-ink');
    await expect(page.getByRole('button', {name: '下一页'})).toBeEnabled({timeout: 20000});
    // Check real PDF canvas painting, not an empty frame or a mocked image.
    expect(await page.locator('.paper-sheet canvas').evaluate(c => {
      const node = c as HTMLCanvasElement, pixels = node.getContext('2d')!.getImageData(0,0,node.width,node.height).data;
      let dark = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 120 && pixels[i+3] > 0) dark++;
      return dark;
    })).toBeGreaterThan(1000);
    const ink = () => page.locator('[data-ink-id]');
    const draw = async () => { const b = (await canvas.boundingBox())!; await page.mouse.move(b.x+b.width*.15, b.y+b.height*.37); await page.mouse.down(); await page.mouse.move(b.x+b.width*.48, b.y+b.height*.41, {steps: 10}); await page.mouse.up(); };
    await draw(); await expect(ink()).toHaveCount(1);
    await page.getByRole('button', {name: '撤销批注'}).click(); await expect(ink()).toHaveCount(0);
    await page.getByRole('button', {name: '重做批注'}).click(); await expect(ink()).toHaveCount(1);
    await page.getByRole('button', {name: '下一页'}).click(); await expect(page.getByText('第 2 / 2 页')).toBeVisible();
    await expect(page.getByRole('button', {name: '上一页'})).toBeEnabled(); await expect(ink()).toHaveCount(0);
    await draw(); await expect(ink()).toHaveCount(1);
    await page.getByRole('button', {name: '上一页'}).click(); await expect(page.getByText('第 1 / 2 页')).toBeVisible(); await expect(ink()).toHaveCount(1);
    await page.route('**/pages/1/ink', route => route.request().method() === 'PUT' ? route.fulfill({status: 503, json: {detail: '保存测试：连接中断'}}) : route.continue());
    await draw(); await expect(ink()).toHaveCount(2);
    await expect(page.getByRole('button', {name: '重试保存'})).toBeVisible();
    await page.getByRole('button', {name: '下一页'}).click(); await expect(page.getByText('第 1 / 2 页')).toBeVisible(); await expect(ink()).toHaveCount(2);
    await page.unroute('**/pages/1/ink'); await page.getByRole('button', {name: '重试保存'}).click();
    await expect(page.getByRole('button', {name: '重试保存'})).toBeHidden();
    await expect(page.locator('.paper-error')).toBeHidden();
    await page.getByRole('button', {name: '下一页'}).click(); await expect(page.getByText('第 2 / 2 页')).toBeVisible();
    await page.reload(); await expect(page.getByText('第 2 / 2 页')).toBeVisible(); await expect(ink()).toHaveCount(1);
    await page.getByRole('button', {name: '上一页'}).click(); await expect(ink()).toHaveCount(2);
    await mkdir('../docs/classroom-ui', {recursive: true});
    await page.screenshot({path: '../docs/classroom-ui/meeting-material.png'});
    await page.getByRole('button', {name: '返回课堂'}).click(); await expect(page.getByTestId('teaching-board')).toBeVisible();
    await page.getByRole('tab', {name: /链式法则练习.pdf/}).click(); await expect(ink()).toHaveCount(2);
    await page.getByRole('tab', {name: '课堂白板'}).click();
    await page.getByRole('button', {name: '白板更多功能'}).click(); await page.getByText('开发演示与动作记录', {exact: true}).click();
    await page.getByRole('button', {name: '开发演示：逐步板书'}).click(); await expect(page.getByTestId('queue-status')).toContainText('已执行 8', {timeout: 12000});
    await page.getByRole('button', {name: '白板更多功能'}).click();
    await page.screenshot({path: '../docs/classroom-ui/meeting-board.png'});
    await page.getByRole('button', {name: '聊天', exact: true}).click(); await expect(page.getByRole('textbox', {name: '给老师的消息'})).toBeVisible();
    await page.screenshot({path: '../docs/classroom-ui/meeting-chat.png'});
    const saved = await (await request.get(`${apiBase}/api/lessons/${lesson.id}/documents/${material.id}/pages/1/ink`)).json(); expect(saved.strokes).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally { await request.delete(`${apiBase}/api/teachers/${teacher.id}`); }
});

test('narrow classroom keeps controls reachable and restores ink after opening chat', async ({page, request}) => {
  await page.setViewportSize({width: 390, height: 844});
  const teacher = await (await request.post(`${apiBase}/api/teachers`, {data: {name: '移动课堂'}})).json();
  await page.addInitScript(id => localStorage.setItem('banxue.lastTeacher', id), teacher.id);
  try {
    await page.goto('/'); await expect(page.getByTestId('teaching-board')).toBeVisible();
    const box = (await page.getByTestId('teaching-board').boundingBox())!;
    await page.mouse.move(box.x+50,box.y+160); await page.mouse.down(); await page.mouse.move(box.x+140,box.y+200,{steps:10}); await page.mouse.up();
    await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await page.getByRole('button', {name:'聊天',exact:true}).click(); await expect(page.getByRole('textbox',{name:'给老师的消息'})).toBeInViewport();
    await page.getByRole('button',{name:'收起讲解面板'}).click(); await expect(page.locator('[data-author=student]')).toHaveCount(1);
    await expect(page.getByRole('button',{name:'下课',exact:true})).toBeInViewport(); await expect(page.getByRole('button',{name:'开始语音'})).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({path:'../docs/classroom-ui/meeting-narrow.png'});
  } finally { await request.delete(`${apiBase}/api/teachers/${teacher.id}`); }
});
