import { randomUUID } from 'node:crypto';

const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
};
const positive = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
};

export class BillingSimulation {
  constructor({ store, payments, router, clock }) {
    Object.assign(this, { store, payments, router, clock });
  }
  async checkout({ customerId, target, packageTerms, account = 'fake-merchant', channel = 'fake-channel' }) {
    required(customerId, 'customerId'); required(target, 'target');
    required(account, 'account'); required(channel, 'channel');
    positive(packageTerms.amountMinor, 'amountMinor'); positive(packageTerms.durationMs, 'durationMs');
    if (packageTerms.currency !== 'KES') throw new Error('Only KES is supported');
    if (packageTerms.deviceLimit !== 1) throw new Error('Prototype supports one device');
    required(packageTerms.name, 'name');
    const order = {
      id: randomUUID(), customerId, target, terms: structuredClone(packageTerms), account, channel,
      status: 'pending_payment', deadline: this.clock() + 15 * 60_000, createdAt: this.clock(),
    };
    return this.store.transaction((s) => {
      // Initial purchase slice only. Renewal/replacement need their own transitions.
      if (Object.values(s.orders).some((o) => o.customerId === customerId && o.target === target
        && ['pending_payment', 'paid_awaiting_activation', 'active', 'needs_review'].includes(o.status))) {
        throw new Error('An existing purchase requires resolution; renewal is not implemented in this slice');
      }
      s.orders[order.id] = order;
      return order;
    });
  }
  async requestPayment(orderId) {
    const attempt = await this.store.transaction((s) => {
      const order = s.orders[orderId];
      if (!order || order.status !== 'pending_payment' || this.clock() >= order.deadline) {
        throw new Error('Order is not payable');
      }
      if (Object.values(s.attempts).some((a) => a.orderId === orderId
        && ['initiated','pending','uncertain'].includes(a.status))) throw new Error('Reconcile existing attempt first');
      const a = { id: randomUUID(), orderId, status: 'initiated',
        amountMinor: order.terms.amountMinor, currency: order.terms.currency,
        account: order.account, channel: order.channel };
      s.attempts[a.id] = a;
      return a;
    });
    try {
      const response = await this.payments.request(attempt);
      return await this.store.transaction((s) => {
        const a = s.attempts[attempt.id];
        a.reference = response.reference;
        if (a.status === 'initiated') a.status = 'pending';
        return a;
      });
    } catch (error) {
      await this.store.transaction((s) => {
        if (s.attempts[attempt.id].status === 'initiated') s.attempts[attempt.id].status = 'uncertain';
      });
      throw error;
    }
  }
  async paymentNotification(attemptId) {
    // Caller supplies only a correlation hint; callback success/amount are never trusted.
    if (!this.store.snapshot().attempts[attemptId]) throw new Error('Unknown payment attempt');
    const evidence = await this.payments.verify(attemptId);
    return this.store.transaction((s) => {
      const attempt = s.attempts[attemptId];
      const order = s.orders[attempt.orderId];
      if (evidence.status === 'pending') return { outcome: 'pending' };
      if (evidence.status === 'failed') {
        if (attempt.status !== 'succeeded') attempt.status = 'failed';
        return { outcome: 'failed' };
      }
      if (evidence.status !== 'succeeded') throw new Error('Unrecognized verification outcome');
      required(evidence.receipt, 'verified receipt');
      const key = JSON.stringify(['fake', evidence.account, evidence.receipt]);
      const fact = { attemptId, orderId: order.id, evidence };
      const prior = s.payments[key];
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(fact)) {
          s.events.push({ action: 'conflicting_receipt', orderId: order.id, at: this.clock() });
          if (!order.paymentKey) order.status = 'needs_review';
          return { outcome: 'needs_review' };
        }
        return { outcome: 'duplicate' };
      }
      s.payments[key] = structuredClone(fact);
      attempt.status = 'succeeded';
      const matches = evidence.attemptId === attemptId && evidence.account === attempt.account
        && evidence.channel === attempt.channel && evidence.amountMinor === attempt.amountMinor
        && evidence.currency === attempt.currency;
      // Simulator has no trusted settlement timestamp: delayed success goes to review.
      if (!matches || this.clock() >= order.deadline || order.paymentKey) {
        if (!order.paymentKey) order.status = 'needs_review';
        s.events.push({ action: 'payment_review', orderId: order.id, at: this.clock() });
        return { outcome: 'needs_review' };
      }
      order.paymentKey = key;
      order.status = 'paid_awaiting_activation';
      const operationKey = `activate:${order.id}`;
      s.periods[order.id] = { orderId: order.id, status: 'pending', activationAt: null, expiresAt: null };
      s.operations[operationKey] = { operationKey, orderId: order.id, status: 'queued', revision: 1 };
      s.outbox[operationKey] = { operationKey, orderId: order.id };
      s.events.push({ action: 'payment_allocated', orderId: order.id, at: this.clock() });
      return { outcome: 'allocated', operationKey };
    });
  }
  async provision(operationKey, { crashAfterApply = false } = {}) {
    const intent = await this.store.transaction((s) => {
      const op = s.operations[operationKey];
      if (!op) throw new Error('Unknown operation');
      if (op.status === 'confirmed') return null;
      op.status = 'in_progress';
      const order = s.orders[op.orderId];
      return { target: order.target, operationKey, durationMs: order.terms.durationMs, now: this.clock() };
    });
    if (!intent) return { outcome: 'already_confirmed' };
    let observed;
    try {
      observed = await this.router.inspect(intent.target, operationKey);
      if (observed.state === 'never_applied') observed = await this.router.apply(intent);
    } catch (error) {
      await this.store.transaction((s) => { s.operations[operationKey].status = 'uncertain'; });
      return { outcome: 'uncertain', message: error.message };
    }
    if (crashAfterApply) throw new Error('Simulated worker crash before database finalization');
    return this.store.transaction((s) => {
      const op = s.operations[operationKey];
      if (op.status === 'confirmed') return { outcome: 'already_confirmed' };
      if (!['ready','expired'].includes(observed.state)) {
        op.status = 'uncertain';
        return { outcome: 'uncertain' };
      }
      const period = s.periods[op.orderId];
      if (!Number.isSafeInteger(observed.activationAt) || !Number.isSafeInteger(observed.expiresAt)
        || observed.expiresAt - observed.activationAt !== intent.durationMs) throw new Error('Invalid router evidence');
      if (period.activationAt !== null && (period.activationAt !== observed.activationAt
        || period.expiresAt !== observed.expiresAt)) throw new Error('Effective time conflict');
      Object.assign(period, { activationAt: observed.activationAt, expiresAt: observed.expiresAt,
        status: this.clock() >= observed.expiresAt ? 'expired' : 'active' });
      s.orders[op.orderId].status = period.status === 'active' ? 'active' : 'fulfilled';
      op.status = 'confirmed';
      delete s.outbox[operationKey];
      s.events.push({ action: 'access_confirmed', orderId: op.orderId, at: this.clock() });
      return { outcome: period.status, ...period };
    });
  }
  async expire(operationKey, expectedRevision) {
    const s = this.store.snapshot();
    const op = s.operations[operationKey];
    if (!op || op.revision !== expectedRevision || op.status !== 'confirmed') return { outcome: 'stale' };
    const period = s.periods[op.orderId];
    if (period.status === 'expired') return { outcome: 'expired' };
    if (this.clock() < period.expiresAt) return { outcome: 'not_due' };
    await this.router.expire(s.orders[op.orderId].target, operationKey, this.clock());
    return this.store.transaction((current) => {
      if (current.operations[operationKey].revision !== expectedRevision) return { outcome: 'stale' };
      current.periods[op.orderId].status = 'expired';
      current.orders[op.orderId].status = 'fulfilled';
      return { outcome: 'expired' };
    });
  }
}
