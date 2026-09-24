/**
 * Estimates the offset between this browser's clock and the server's, NTP-style.
 *
 * Each ping records the client send/receive times (Date.now) and the server's
 * timestamp. Assuming symmetric latency, the server's clock at receive time
 * is serverTime + rtt/2, so offset = serverTime + rtt/2 - receivedAt.
 * Samples with the smallest round trip are the most trustworthy, so we use
 * the best of the recent ones.
 */
export type ClockSample = { offsetMs: number; rttMs: number };

const MAX_SAMPLES = 10;

export class ClockSync {
  private samples: ClockSample[] = [];

  addSample(sentAt: number, serverTime: number, receivedAt: number): ClockSample | null {
    const rttMs = receivedAt - sentAt;
    // A negative or huge round trip means clock jumps or a stalled tab; ignore it.
    if (rttMs < 0 || rttMs > 10_000) return null;
    const sample = { offsetMs: serverTime + rttMs / 2 - receivedAt, rttMs };
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return sample;
  }

  /** Best (lowest-RTT) recent sample, or null before the first pong. */
  best(): ClockSample | null {
    let best: ClockSample | null = null;
    for (const s of this.samples) if (!best || s.rttMs < best.rttMs) best = s;
    return best;
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  /** Current server time as estimated from this browser. */
  serverNow(now = Date.now()): number {
    return now + (this.best()?.offsetMs ?? 0);
  }
}
