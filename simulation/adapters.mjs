import { randomUUID } from 'node:crypto';

// These adapters make no network calls and accept no real credentials.
export class FakePayments {
  #records = new Map();
  request(attempt) {
    this.#records.set(attempt.id, {
      status: 'pending', attemptId: attempt.id, amountMinor: attempt.amountMinor,
      currency: attempt.currency, account: attempt.account, channel: attempt.channel,
    });
    return { reference: `fake:${attempt.id}` };
  }
  settle(attemptId, overrides = {}) {
    const record = this.#records.get(attemptId);
    if (!record) throw new Error('Unknown simulated payment attempt');
    Object.assign(record, { status: 'succeeded', receipt: randomUUID(), ...overrides });
  }
  verify(attemptId) {
    const record = this.#records.get(attemptId);
    if (!record) throw new Error('Unknown simulated payment attempt');
    return structuredClone(record);
  }
}

export class FakeRouter {
  #records = new Map();
  #current = new Map();
  mode = 'ready';
  applyCount = 0;
  inspect(target, operationKey) {
    if (this.mode === 'unreachable') return { state: 'uncertain' };
    const record = this.#records.get(operationKey);
    if (!record) return { state: 'never_applied' };
    if (record.target !== target) throw new Error('Operation target mismatch');
    return structuredClone(record);
  }
  apply({ target, operationKey, durationMs, now }) {
    if (this.mode === 'unreachable') throw new Error('Simulated connection unavailable');
    if (this.#records.has(operationKey)) return this.inspect(target, operationKey);
    if (this.mode === 'before_apply') throw new Error('Simulated failure before router change');
    const record = { state: 'ready', target, activationAt: now, expiresAt: now + durationMs };
    this.#records.set(operationKey, record);
    this.#current.set(target, operationKey);
    this.applyCount++;
    if (this.mode === 'after_apply') throw new Error('Simulated lost reply after router change');
    return structuredClone(record);
  }
  expire(target, operationKey, now) {
    if (this.mode === 'unreachable') throw new Error('Simulated router unavailable');
    const record = this.#records.get(operationKey);
    if (!record || this.#current.get(target) !== operationKey || now < record.expiresAt) return false;
    record.state = 'expired';
    this.#current.delete(target);
    return true;
  }
  hasAccess(target, now) {
    const record = this.#records.get(this.#current.get(target));
    return !!record && record.state === 'ready' && now >= record.activationAt && now < record.expiresAt;
  }
}
