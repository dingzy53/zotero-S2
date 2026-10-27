export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * FIFO limiter that spaces the *start* of each scheduled task at least
 * `intervalMs` apart. Every caller sharing an instance shares the budget.
 */
export class RateLimiter {
  private lastStart = -Infinity;
  private notBefore = -Infinity;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const slot = this.tail.then(async () => {
      // Loop: a pause() may arrive while we're already waiting for our slot
      for (;;) {
        const wait =
          Math.max(this.lastStart + this.intervalMs, this.notBefore) -
          this.now();
        if (wait <= 0) break;
        await this.sleep(wait);
      }
      this.lastStart = this.now();
    });
    this.tail = slot.catch(() => {});
    return slot.then(task);
  }

  /** Holds every queued task for `ms` from now, e.g. after a 429. */
  pause(ms: number) {
    this.notBefore = Math.max(this.notBefore, this.now() + ms);
  }
}

/** Caps how many tasks run at once (PDF downloads, library writes). */
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // The releasing task hands us its slot, so `active` already counts us
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      // Hand over directly: freeing the slot first would let a new caller
      // take it before the waiter resumes, and both would run
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
