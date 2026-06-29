/**
 * A minimal single-consumer async queue: push values, then iterate them with
 * `for await`. Used to turn pushed pi events / text deltas into an
 * `AsyncIterable`. Backpressure-free (POC); values buffer until consumed.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private error: unknown;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.values.push(value);
  }

  /** Close the queue; pending/iterating consumers complete normally. */
  close(): void {
    this.closed = true;
    let resolve;
    while ((resolve = this.resolvers.shift())) {
      resolve({ value: undefined as never, done: true });
    }
  }

  /** Close the queue with an error that is thrown to the consumer. */
  fail(error: unknown): void {
    this.error = error;
    this.closed = true;
    // The next `next()` call observes the error.
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.error) return Promise.reject(this.error);
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
