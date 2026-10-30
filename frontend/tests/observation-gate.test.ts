import { describe, it, expect } from 'vitest';
import { ObservationGate } from '../lib/observation-gate';

describe('event-driven visual observation', () => {
  it('never observes an unchanged board', () => {
    expect(new ObservationGate().ready(1000000, true, false)).toBe(false);
  });
  it('requires enabled, idle and not busy; edits reset idle', () => {
    const gate = new ObservationGate(); gate.edit(1000);
    expect(gate.ready(3999, true, false)).toBe(false);
    expect(gate.ready(4000, false, false)).toBe(false);
    expect(gate.ready(4000, true, true)).toBe(false);
    gate.edit(3900);
    expect(gate.ready(4000, true, false)).toBe(false);
    expect(gate.ready(6900, true, false)).toBe(true);
  });
  it('requires another edit and enforces twenty second cooldown', () => {
    const gate = new ObservationGate(); gate.edit(0); gate.sent(3000);
    expect(gate.ready(30000, true, false)).toBe(false);
    gate.edit(4000);
    expect(gate.ready(22999, true, false)).toBe(false);
    expect(gate.ready(23000, true, false)).toBe(true);
  });
});
