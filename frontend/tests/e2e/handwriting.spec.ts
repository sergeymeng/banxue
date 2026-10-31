import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('region review, edit, reload and confirmation (mock only)', async ({ page, request }) => {
  const base = 'http://127.0.0.1:8100';
  const teacher = await (await request.post(`${base}/api/teachers`, { data: { name: 'Handwriting E2E' } })).json();
  const lesson = await (await request.post(`${base}/api/teachers/${teacher.id}/lessons`, { data: {} })).json();
  const binary = readFileSync('public/handwriting/fraction.png');
  const image = `data:image/png;base64,${binary.toString('base64')}`;
  const observation = {
    id: 'mock-region', schema_version: 1, status: 'pending', uncertainty: 'unreviewed', notes: '浏览器流程模拟；不证明真实识别能力。',
    source: { kind: 'fixture', label: 'fraction', sha256: createHash('sha256').update(binary).digest('hex'), width: 900, height: 420 },
    provenance: { adapter: 'e2e_mock', model: 'mock-only', mode: 'mock', coordinates: 'model_estimated' },
    steps: [
      { id: 's1', order: 1, text: 'y=(x+1)/2', expressions: ['y=\\frac{x+1}{2}'], region: { x: .05, y: .05, width: .5, height: .5 }, mark: 'active' },
      { id: 's2', order: 2, text: '误识别行', expressions: [], region: { x: .05, y: .6, width: .5, height: .2 }, mark: 'active' },
    ],
    ambiguities: [{ id: 'a1', step_id: 's1', region: { x: .2, y: .3, width: .2, height: .2 }, reason: '分母是 2 还是 2x？', alternatives: ['2', '2x'] }],
  };
  let pending = false;
  let confirmed = false;
  await page.addInitScript(id => localStorage.setItem('banxue.lastTeacher', id), teacher.id);
  await page.route('**/api/config', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), mode: 'live' } });
  });
  await page.route(`**/api/teachers/${teacher.id}/lessons`, route => route.fulfill({ json: { ...lesson, latest_observation_id: pending ? observation.id : undefined, pending_observation_id: pending ? observation.id : null } }));
  await page.route(`**/api/lessons/${lesson.id}/observations`, async route => {
    const payload = route.request().postDataJSON();
    expect(payload.image).toBe(image);
    expect(payload.source.kind).toBe('fixture');
    pending = true;
    await route.fulfill({ json: { lesson: { ...lesson, latest_observation_id: observation.id, pending_observation_id: observation.id }, sources: [], observation } });
  });
  await page.route(`**/api/lessons/${lesson.id}/observations/mock-region`, route => route.fulfill({ json: { image, observation, status: 'pending' } }));
  await page.route(`**/api/lessons/${lesson.id}/observations/mock-region/confirm`, async route => {
    const payload = route.request().postDataJSON();
    expect(payload.image_sha256).toBe(observation.source.sha256);
    expect(payload.steps[0].text).toBe('y=(x+1)/(2x)');
    expect(payload.steps[0].expressions).toEqual(['y=\\frac{x+1}{2x}']);
    expect(payload.steps).toHaveLength(1);
    expect(payload.resolutions.a1).toBe('原图为 2x，已修正');
    expect(payload.step_complete).toBe(true);
    confirmed = true;
    await route.fulfill({ json: { lesson: { ...lesson, latest_observation_id: observation.id, pending_observation_id: null }, sources: [], observation: { ...observation, steps: payload.steps, status: 'confirmed' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '区域识别与核对', exact: true }).click();
  await page.getByRole('button', { name: '载入测试图片' }).click();
  await expect(page.getByAltText('选中的解题区域原图')).toBeVisible();
  await page.getByRole('button', { name: '识别此区域' }).click();
  await expect(page.getByLabel('歧义 a1 的确认')).toBeVisible();
  await expect(page.getByRole('button', { name: '已核对原图，确认以上内容' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('dialog', { name: '解题区域 · 原图核对' })).toBeVisible();
  await expect(page.getByAltText('选中的解题区域原图')).toHaveAttribute('src', image);
  await page.getByRole('button', { name: '下移', exact: true }).first().click();
  await expect(page.getByLabel('逐字文本').first()).toHaveValue('误识别行');
  await page.getByRole('button', { name: '删除误识别行' }).first().click();
  await page.getByLabel('逐字文本').fill('y=(x+1)/(2x)');
  await page.getByLabel('数学表达式（LaTeX，每行一项）').fill('y=\\frac{x+1}{2x}');
  await page.getByLabel('歧义 a1 的确认').fill('原图为 2x，已修正');
  await page.getByLabel('这一步写完了，请老师看看').check();
  await page.screenshot({ path: '../docs/handwriting-evaluation/review.png', fullPage: true });
  await page.getByRole('button', { name: '已核对原图，确认以上内容' }).click();
  await expect(page.getByText('核对已保存并交给教学模块；未更新掌握程度。')).toBeVisible();
  expect(confirmed).toBe(true);
  await request.delete(`${base}/api/teachers/${teacher.id}`);
});

test('demo shows synthetic region without pretending to recognize it', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const base = 'http://127.0.0.1:8100';
  const teacher = await (await request.post(`${base}/api/teachers`, { data: { name: 'Handwriting Demo E2E' } })).json();
  await page.addInitScript(id => localStorage.setItem('banxue.lastTeacher', id), teacher.id);
  await page.goto('/');
  await page.getByRole('button', { name: '区域识别与核对', exact: true }).click();
  await page.getByRole('button', { name: '载入测试图片' }).click();
  await expect(page.getByText('演示模式不运行手写识别。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '识别此区域' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await request.delete(`${base}/api/teachers/${teacher.id}`);
});
