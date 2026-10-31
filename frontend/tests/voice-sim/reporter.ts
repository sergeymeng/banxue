import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Compact, explicit simulation evidence; full per-test traces remain Playwright attachments. */
export default class SimulationReporter implements Reporter {
  private cases: { name: string; status: string; duration_ms: number; injection_to_suspend_ms: number[]; max_scheduled_overlap?: number; uncertain_reservations?: number; false_pause_count?: number }[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    const attachment = result.attachments.find(a => a.name === 'simulation-trace');
    const body = attachment?.body || (attachment?.path ? readFileSync(attachment.path) : undefined);
    const trace = body ? JSON.parse(body.toString()) : undefined;
    const events = trace?.client as { type: string; at: number }[] | undefined;
    const delays: number[] = [];
    if (test.title.startsWith('three natural interruptions') && events) {
      for (let i = 0; i < events.length; i++) {
        if (events[i].type !== 'injected_speech') continue;
        const pause = events.slice(i + 1).find(e => e.type === 'local_suspend');
        if (pause) delays.push(Math.round((pause.at - events[i].at) * 10) / 10);
      }
    }
    this.cases.push({ name: test.title, status: result.status, duration_ms: result.duration,
      injection_to_suspend_ms: delays, max_scheduled_overlap: trace?.playback?.maxScheduledOverlap,
      uncertain_reservations: trace?.usage?.requests.filter((r: { status: string }) => ['uncertain', 'interrupted', 'reserved'].includes(r.status)).length,
      false_pause_count: test.title.startsWith('synthetic keyboard') ? events?.filter(e => e.type === 'send_begin').length : undefined });
  }
  onEnd(result: FullResult) {
    const dir = path.resolve('../docs/voice-evaluation'); mkdirSync(dir, { recursive: true });
    const report = { date: new Date().toISOString(), status: result.status, simulation: true,
      provider_verified: false, physical_echo_verified: false, human_barge_in_latency_verified: false,
      measurement: 'Synthetic fixture scheduling to teacher AudioContext.suspend call, performance.now on the same browser clock. Not acoustic speech onset or audible speaker stop.',
      cases: this.cases };
    writeFileSync(path.join(dir, 'simulation-summary.json'), JSON.stringify(report, null, 2) + '\n');
    const delays = this.cases.flatMap(c => c.injection_to_suspend_ms);
    writeFileSync(path.join(dir, 'simulation-summary.md'), `# 语音仿真自动报告\n\n运行时间：${report.date}。总体结果：${result.status}。\n\n仅模拟云端传输；没有调用真实供应商，没有验证真人麦克风或扬声器回声。\n\n| 场景 | 结果 | 耗时 |\n|---|---|---|\n${this.cases.map(c => `| ${c.name} | ${c.status} | ${(c.duration_ms / 1000).toFixed(1)} s |`).join('\n')}\n\n连续插话场景中，合成音频调度 → 本地 suspend 调用：${delays.length ? delays.join('、') + ' ms' : '未获得样本'}。同一浏览器 performance.now 时钟；不是人声起点 → 扬声器实际停声，不据此认定达到 300 ms 目标。\n\nJSON 包含播放调度重叠、保留费用预留和合成噪声引起的暂停次数；详细事件与费用流水保留在 Playwright 的 simulation-trace 附件。\n`);
  }
}
