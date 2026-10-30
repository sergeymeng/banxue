// Idle indicates an opportunity to observe, never evidence of confusion.
export class ObservationGate {
  private changed = false;
  private lastChange = 0;
  private lastRequest = -Infinity;
  edit(at: number) { this.changed = true; this.lastChange = at; }
  ready(at: number, enabled: boolean, busy: boolean) {
    return enabled && !busy && this.changed && at - this.lastChange >= 3000 && at - this.lastRequest >= 20000;
  }
  sent(at: number) { this.changed = false; this.lastRequest = at; }
}
