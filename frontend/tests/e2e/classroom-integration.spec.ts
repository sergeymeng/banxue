import { test, expect } from '@playwright/test';
import { apiBase } from './environment';

test('teaching proposals execute with persisted receipts and student ink exports its saved revision', async ({page, request}) => {
  const teacher = await (await request.post(`${apiBase}/api/teachers`, {data: {name: '课堂接线测试'}})).json();
  try {
    const lesson = await (await request.post(`${apiBase}/api/teachers/${teacher.id}/lessons`, {data: {}})).json();
    await request.post(`${apiBase}/api/lessons/${lesson.id}/turn`, {data: {text: '我现在数学 B，还有一个月考试，我想冲 A*。'}});
    await request.post(`${apiBase}/api/lessons/${lesson.id}/turn`, {data: {text: 'Edexcel'}});
    await page.addInitScript(id => localStorage.setItem('banxue.lastTeacher', id), teacher.id);
    await page.goto('/');
    await expect(page.locator('[data-element-id^="teaching-"]').first()).toBeVisible();
    await expect.poll(async () => {
      const saved = await (await request.get(`${apiBase}/api/lessons/${lesson.id}`)).json();
      return saved.board_actions.some((a: {status: string}) => a.status === 'executed');
    }).toBe(true);
    const canvas = page.locator('.teaching-board'), box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * .65, box.y + 140); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .75, box.y + 190, {steps: 12}); await page.mouse.up();
    await expect(page.locator('[data-author="student"]')).toHaveCount(1);
    let submitted = false;
    await page.route('**/api/lessons/*/observations', async route => {
      const body = route.request().postDataJSON();
      const saved = await (await request.get(`${apiBase}/api/lessons/${lesson.id}`)).json();
      expect(body.source).toMatchObject({kind: 'whiteboard_region', page_id: 'main', author: 'student', revision: saved.board.revision});
      expect(body.source.snapshot_id).toBe(`banxue-board:v1:${saved.board.revision}`);
      expect(body.source.element_ids).toEqual(saved.board.elements.filter((e: {author: string}) => e.author === 'student').map((e: {id: string}) => e.id));
      expect(body.image).toMatch(/^data:image\/png;base64,/);
      submitted = true;
      await route.fulfill({json: {skipped: '测试：已接收学生选区。'}});
    });
    await page.getByRole('button', {name: '请看这一步', exact: true}).click();
    await expect.poll(() => submitted).toBe(true);
    await page.reload();
    await expect(page.locator('[data-author="student"]')).toHaveCount(1);
    await expect(page.locator('[data-element-id^="teaching-"]')).toHaveCount(1);
  } finally { await request.delete(`${apiBase}/api/teachers/${teacher.id}`); }
});
