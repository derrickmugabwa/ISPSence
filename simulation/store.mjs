// Single-process transaction model. Production will use PostgreSQL transactions.
export class MemoryStore {
  #state;
  #tail = Promise.resolve();
  constructor(snapshot) {
    this.#state = structuredClone(snapshot ?? {
      orders: {}, attempts: {}, payments: {}, periods: {}, operations: {}, outbox: {}, events: [],
    });
  }
  snapshot() { return structuredClone(this.#state); }
  transaction(fn) {
    const work = this.#tail.then(() => {
      const draft = structuredClone(this.#state);
      const result = fn(draft);
      if (result instanceof Promise) throw new Error('Transactions must not perform asynchronous work');
      this.#state = draft;
      return structuredClone(result);
    });
    this.#tail = work.catch(() => {});
    return work;
  }
}
