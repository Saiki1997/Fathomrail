export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Stopped"));
      },
      { once: true },
    );
  });
}

/** Token-bucket limiter shared across workers. 0 = unlimited. */
export class ByteLimiter {
  private last = performance.now();
  private allowance = 0;

  constructor(private capBps: number) {}

  async take(n: number, signal?: AbortSignal) {
    if (this.capBps <= 0 || n <= 0) return;
    const now = performance.now();
    this.allowance += ((now - this.last) / 1000) * this.capBps;
    this.last = now;
    this.allowance = Math.min(this.allowance, this.capBps);
    if (this.allowance >= n) {
      this.allowance -= n;
      return;
    }
    const wait = ((n - this.allowance) / this.capBps) * 1000;
    this.allowance = 0;
    await sleep(wait, signal);
  }
}

const hostLast = new Map<string, number>();
const hostActive = new Map<string, number>();

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export async function acquireHost(host: string, gapMs: number, maxConcurrent: number, signal?: AbortSignal) {
  const gap = Math.max(0, gapMs);
  const cap = Math.max(1, maxConcurrent);
  for (;;) {
    if (signal?.aborted) throw new Error("Stopped");
    const active = hostActive.get(host) ?? 0;
    const waitGap = (hostLast.get(host) ?? 0) + gap - Date.now();
    if (active < cap && waitGap <= 0) {
      hostActive.set(host, active + 1);
      hostLast.set(host, Date.now());
      return;
    }
    await sleep(Math.max(30, waitGap), signal);
  }
}

export function releaseHost(host: string) {
  hostActive.set(host, Math.max(0, (hostActive.get(host) ?? 1) - 1));
}
