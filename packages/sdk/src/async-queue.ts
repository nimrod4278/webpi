/**
 * A minimal single-consumer async queue: push values, then iterate them with
 * `for await`. Used to turn pushed pi events / text deltas into an
 * `AsyncIterable`. Backpressure-free (POC); values buffer until consumed.
 */
interface Waiter<T> {
  resolve: (r: IteratorResult<T>) => void;
  reject: (err: unknown) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Waiter<T>[] = [];
  private closed = false;
  private error: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  /** Close the queue; pending/iterating consumers complete normally. */
  close(): void {
    this.closed = true;
    let waiter;
    while ((waiter = this.waiters.shift())) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  /** Close the queue with an error that is thrown to the consumer. */
  fail(error: unknown): void {
    this.error = error;
    this.closed = true;
    // Consumers already blocked on next() must see the error too, not a
    // clean end-of-stream.
    let waiter;
    while ((waiter = this.waiters.shift())) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
