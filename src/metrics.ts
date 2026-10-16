import type { Rev } from './protocol';

const WINDOW = 100;

export interface LatencyStats {
  last: number;
  p50: number;
  p95: number;
  count: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * Keystroke-to-preview latency. Each input is stamped with the rev it produced. A paint of rev N
 * completes every outstanding input up to N, because a coalesced edit is shown by the newer frame.
 */
export class LatencyMeter {
  #outstanding: { rev: Rev; at: number }[] = [];
  #recent: number[] = [];
  #count = 0;

  input(rev: Rev, at: number): void {
    this.#outstanding.push({ rev, at });
  }

  painted(rev: Rev, at: number): void {
    while (this.#outstanding.length > 0 && this.#outstanding[0]!.rev <= rev) {
      this.#recent.push(at - this.#outstanding.shift()!.at);
      this.#count++;
    }
    if (this.#recent.length > WINDOW) this.#recent.splice(0, this.#recent.length - WINDOW);
  }

  stats(): LatencyStats {
    const sorted = [...this.#recent].sort((a, b) => a - b);
    return {
      last: this.#recent[this.#recent.length - 1] ?? NaN,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      count: this.#count,
    };
  }
}

/** Calls back after the next paint: rAF runs before paint, a message posted from it runs after. */
export function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = callback;
    channel.port2.postMessage(null);
  });
}
