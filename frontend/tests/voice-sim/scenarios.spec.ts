import { test, expect } from '@playwright/test';
import { backend, boot, count, events, finish, inject, playing, scenario, stopped, typed, type SimWindow } from './harness';

test('real local WS + Qwen adapters: streamed ASR, text, TTS and playback receipts', async ({ page, request }, info) => {
  const ids = await boot(page, request);
  await inject(page);
  await expect.poll(() => count(page, 'transcript')).toBeGreaterThanOrEqual(2);
  await playing(page);
  await expect.poll(() => count(page, 'send_played'), { timeout: 15000 }).toBeGreaterThan(0);
  const usage = await (await request.get(`${backend}/api/lessons/${ids.lesson}/usage`)).json();
  expect(new Set(usage.requests.map((r: { role: string }) => r.role))).toEqual(new Set(['asr', 'reasoning', 'tts']));
  await page.screenshot({ path: '../docs/voice-evaluation/simulation-classroom.png' });
  await finish(page, request, info, ids);
});

test('three natural interruptions cancel old replies; late audio and text stay silent', async ({ page, request }, info) => {
  const ids = await boot(page, request);
  await scenario(request, { answer: '第一句。第二句。第三句。', audio_seconds: 6, tts_delay_ms: 80 });
  await typed(page); await playing(page);
  for (let i = 0; i < 3; i++) {
    const n = await count(page, 'turn');
    await scenario(request, { transcript: ['等一下', '为什么', '我没懂'][i], answer: `这是第${i + 1}次插话的仿真回应。继续看当前题。`, audio_seconds: 6, tts_delay_ms: 80 });
    await inject(page);
    await expect.poll(() => count(page, 'send_begin')).toBe(i + 1);
    expect(await page.evaluate(() => (window as SimWindow).voiceSim.contexts[1].state)).toBe('suspended');
    await expect.poll(() => count(page, 'turn'), { timeout: 10000 }).toBe(n + 1);
    await playing(page);
  }
  expect(await count(page, 'cancelled')).toBe(3);
  await page.getByRole('button', { name: '打断' }).click();
  const starts = await page.evaluate(() => (window as SimWindow).voiceSim.starts);
  await request.post(`${backend}/__simulation/late/${ids.lesson}`);
  await expect.poll(() => events(page).then(e => e.some(x => x.turn_id === 'cancelled-simulation-turn'))).toBe(true);
  expect(await page.evaluate(() => (window as SimWindow).voiceSim.starts)).toBe(starts);
  await expect(page.getByText('SIM_STALE_SHOULD_NOT_APPEAR')).toHaveCount(0);
  await finish(page, request, info, ids);
});

for (const transcript of ['嗯。', '']) test(`provisional pause resumes same reply for ${transcript || 'empty/noise'} transcript`, async ({ page, request }, info) => {
  const ids = await boot(page, request);
  await scenario(request, { transcript, answer: '这段老师音频仍然有效。', audio_seconds: 8, tts_delay_ms: 80 });
  await typed(page); await playing(page);
  await inject(page);
  await expect.poll(() => count(page, 'resume'), { timeout: 10000 }).toBe(1);
  await playing(page);
  expect(await count(page, 'turn')).toBe(1); expect(await count(page, 'cancelled')).toBe(0);
  await finish(page, request, info, ids);
});

test('thinking pause stays one utterance; ambiguous math waits for explicit confirmation', async ({ page, request }, info) => {
  const ids = await boot(page, request);
  await scenario(request, { transcript: '负 x 的二次方' });
  await inject(page, 'pause');
  await expect(page.getByRole('button', { name: '确认原话并继续' })).toBeVisible({ timeout: 10000 });
  expect(await count(page, 'send_begin')).toBe(1); expect(await count(page, 'turn')).toBe(0);
  await page.getByRole('button', { name: '确认原话并继续' }).click();
  await playing(page); expect(await count(page, 'turn')).toBe(1);
  await finish(page, request, info, ids);
});

for (const fault of ['asr_fail', 'asr_disconnect', 'llm_disconnect', 'llm_timeout', 'tts_fail', 'tts_disconnect']) {
  test(`fault ${fault}: clear error, uncertain reservation, no retry, subsequent typed recovery`, async ({ page, request }, info) => {
    const ids = await boot(page, request);
    await scenario(request, { fault });
    if (fault.startsWith('asr')) await inject(page); else await typed(page);
    await expect(page.locator('.error[role=alert]')).toBeVisible({ timeout: 12000 });
    const usage = await (await request.get(`${backend}/api/lessons/${ids.lesson}/usage`)).json();
    expect(usage.requests.some((r: { status: string; estimated_cost_gbp: number }) => r.status === 'uncertain' && r.estimated_cost_gbp > 0)).toBe(true);
    const state = await (await request.get(backend + '/__simulation/state')).json();
    const service = fault.split('_')[0];
    // New explicit requests are allowed; the failing request itself must not automatically retry.
    expect(state.active[service]).toBe(0);
    expect(state.events.filter((e: { service: string; event: string }) => e.service === service && e.event === (service === 'llm' ? 'request' : 'open'))).toHaveLength(1);
    await scenario(request, { answer: '这是恢复后的仿真回答。' });
    await typed(page, '重新解释一下'); await playing(page);
    await finish(page, request, info, ids);
  });
}

for (const stop of ['disconnect', 'device', 'leave']) test(`${stop} releases capture, playback, connection and backend tasks`, async ({ page, request }, info) => {
  const ids = await boot(page, request);
  await scenario(request, { llm_delay_ms: 800, answer: '这是一段故意缓慢的回答。还在生成中。' });
  await typed(page);
  await expect.poll(() => count(page, 'turn')).toBe(1);
  await expect.poll(async () => (await (await request.get(backend + '/__simulation/state')).json()).active.llm).toBe(1);
  if (stop === 'disconnect') await request.post(backend + '/__simulation/disconnect');
  if (stop === 'device') await page.evaluate(() => (window as SimWindow).voiceSim.unplug());
  if (stop === 'leave') await page.getByRole('button', { name: '课堂菜单', exact: true }).click();
  if (stop === 'leave') {
    await page.getByRole('button', { name: '设置', exact: false }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  }
  await stopped(page);
  const usage = await finish(page, request, info, ids);
  expect(usage.requests.some((r: { status: string; usage_source: string; estimated_cost_gbp: number }) =>
    r.status === 'interrupted' && r.usage_source === 'reservation' && r.estimated_cost_gbp > 0)).toBe(true);
});

test('synthetic keyboard and residual echo: observe VAD, recover possible false pauses without new replies', async ({ page, request }, info) => {
  const ids = await boot(page, request);
  await scenario(request, { transcript: '', answer: '这是用于回声残留注入测试的老师音频。', audio_seconds: 10 });
  await typed(page); await playing(page);
  await inject(page, 'noise');
  await page.waitForTimeout(2500); // Allow the complete finite acoustic fixture + endpoint silence.
  await inject(page, 'echo');
  await page.waitForTimeout(3500);
  expect(await count(page, 'turn')).toBe(1);
  expect(await count(page, 'cancelled')).toBe(0);
  const pauses = await count(page, 'send_begin');
  await expect.poll(() => count(page, 'resume')).toBe(pauses);
  await playing(page);
  await info.attach('echo-scope', { body: 'Synthetic residual speech enters after microphone capture. This measures VAD/recovery only; browser AEC and physical speaker echo are not simulated or certified.', contentType: 'text/plain' });
  await finish(page, request, info, ids);
});
