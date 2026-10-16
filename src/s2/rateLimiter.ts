export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * FIFO limiter that spaces the *start* of each scheduled task at least
 * `intervalMs` apart. Every caller sharing an instance shares the budget.
 */
export class RateLimiter {
  private lastStart = -Infinity;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const slot = this.tail.then(async () => {
      const wait = this.lastStart + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
    });
    this.tail = slot.catch(() => {});
    return slot.then(task);
  }
}

/** Caps how many tasks run at once (used for PDF downloads). */
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
