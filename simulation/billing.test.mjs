import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './store.mjs';
import { FakePayments, FakeRouter } from './adapters.mjs';
import { BillingSimulation } from './billing.mjs';

function fixture() {
  let time = Date.parse('2026-10-14T09:00:00Z');
  const store = new MemoryStore();
  const payments = new FakePayments();
  const router = new FakeRouter();
  const clock = () => time;
  const engine = new BillingSimulation({ store, payments, router, clock });
  const terms = { name: 'One hour', amountMinor: 1000, currency: 'KES', durationMs: 3600000, deviceLimit: 1 };
  return { store, payments, router, clock, engine, terms,
    advance: (ms) => { time += ms; },
    checkout: (options = {}) => engine.checkout({ customerId: 'customer-1', target: 'router-1/hotspot-1', packageTerms: terms, ...options }),
  };
}
async function funded(f) {
  const order = await f.checkout();
  const attempt = await f.engine.requestPayment(order.id);
  f.payments.settle(attempt.id);
  const { operationKey } = await f.engine.paymentNotification(attempt.id);
  return { order, attempt, operationKey };
}

test('checkout freezes terms and does not confuse payer with customer', async () => {
  const f = fixture(); const order = await f.checkout();
  f.terms.amountMinor = 5000;
  order.terms.amountMinor = 6000;
  assert.equal(f.store.snapshot().orders[order.id].terms.amountMinor, 1000);
  assert.equal(f.store.snapshot().orders[order.id].customerId, 'customer-1');
});

test('transaction failures roll back and callers cannot mutate committed state', async () => {
  const store = new MemoryStore();
  await assert.rejects(store.transaction((s) => { s.orders.bad = {}; throw new Error('rollback'); }));
  assert.deepEqual(store.snapshot().orders, {});
  await assert.rejects(store.transaction(async (s) => { s.orders.bad = {}; }));
  assert.deepEqual(store.snapshot().orders, {});
});

test('queued STK response and forged callback fields cannot grant access', async () => {
  const f = fixture(); const order = await f.checkout();
  const attempt = await f.engine.requestPayment(order.id);
  const result = await f.engine.paymentNotification(attempt.id, { status: 'succeeded', amountMinor: 1000 });
  assert.equal(result.outcome, 'pending');
  assert.deepEqual(f.store.snapshot().periods, {});
  await assert.rejects(f.engine.paymentNotification('unknown'), /Unknown/);
});

test('confirmed failed payment never activates or creates provisioning work', async () => {
  const f = fixture(); const order = await f.checkout();
  const attempt = await f.engine.requestPayment(order.id);
  f.payments.settle(attempt.id, { status: 'failed' });
  assert.equal((await f.engine.paymentNotification(attempt.id)).outcome, 'failed');
  assert.deepEqual(f.store.snapshot().operations, {});
  assert.deepEqual(f.store.snapshot().payments, {});
});

test('verified payment creates pending access with no effective clock', async () => {
  const f = fixture(); const { order } = await funded(f);
  assert.equal(f.store.snapshot().orders[order.id].status, 'paid_awaiting_activation');
  assert.equal(f.store.snapshot().periods[order.id].activationAt, null);
  assert.equal(f.router.applyCount, 0);
});

test('twenty concurrent notifications converge on one payment, period and event', async () => {
  const f = fixture(); const { attempt } = await funded(f);
  const results = await Promise.all(Array.from({ length: 20 }, () => f.engine.paymentNotification(attempt.id)));
  assert.ok(results.every((r) => r.outcome === 'duplicate'));
  const s = f.store.snapshot();
  assert.equal(Object.keys(s.payments).length, 1);
  assert.equal(Object.keys(s.periods).length, 1);
  assert.equal(Object.keys(s.outbox).length, 1);
  assert.equal(s.events.filter((e) => e.action === 'payment_allocated').length, 1);
});

for (const [field, value] of [['amountMinor', 900], ['currency', 'USD'], ['account', 'other'], ['channel', 'other'], ['attemptId', 'other']]) {
  test(`verified ${field} mismatch is retained for review without activation`, async () => {
    const f = fixture(); const order = await f.checkout(); const a = await f.engine.requestPayment(order.id);
    f.payments.settle(a.id, { [field]: value });
    assert.equal((await f.engine.paymentNotification(a.id)).outcome, 'needs_review');
    assert.equal(Object.keys(f.store.snapshot().payments).length, 1);
    assert.equal(Object.keys(f.store.snapshot().periods).length, 0);
  });
}

test('late success remains paid evidence for review', async () => {
  const f = fixture(); const o = await f.checkout(); const a = await f.engine.requestPayment(o.id);
  f.advance(16 * 60_000); f.payments.settle(a.id);
  assert.equal((await f.engine.paymentNotification(a.id)).outcome, 'needs_review');
  assert.equal(Object.keys(f.store.snapshot().payments).length, 1);
  assert.equal(f.store.snapshot().orders[o.id].status, 'needs_review');
});

test('uncertain initiation cannot trigger an automatic second STK request', async () => {
  const f = fixture(); const o = await f.checkout();
  const original = f.payments.request.bind(f.payments);
  f.payments.request = (attempt) => { original(attempt); throw new Error('lost initiation reply'); };
  await assert.rejects(f.engine.requestPayment(o.id), /lost initiation/);
  await assert.rejects(f.engine.requestPayment(o.id), /Reconcile/);
  assert.equal(Object.values(f.store.snapshot().attempts)[0].status, 'uncertain');
});

test('two distinct successful attempts preserve excess payment without a second grant', async () => {
  const f = fixture(); const o = await f.checkout();
  const a = await f.engine.requestPayment(o.id);
  f.payments.settle(a.id, { status: 'failed' }); await f.engine.paymentNotification(a.id);
  const b = await f.engine.requestPayment(o.id);
  f.payments.settle(b.id); await f.engine.paymentNotification(b.id);
  f.payments.settle(a.id);
  assert.equal((await f.engine.paymentNotification(a.id)).outcome, 'needs_review');
  assert.equal(Object.keys(f.store.snapshot().payments).length, 2);
  assert.equal(Object.keys(f.store.snapshot().periods).length, 1);
});

test('a reused receipt cannot fund another order', async () => {
  const f = fixture(); const first = await funded(f);
  const receipt = f.payments.verify(first.attempt.id).receipt;
  const o = await f.checkout({ customerId: 'customer-2' }); const a = await f.engine.requestPayment(o.id);
  f.payments.settle(a.id, { receipt });
  assert.equal((await f.engine.paymentNotification(a.id)).outcome, 'needs_review');
  assert.equal(Object.keys(f.store.snapshot().periods).length, 1);
});

test('before-apply outage does not consume time, and later retry starts at readiness', async () => {
  const f = fixture(); const { order, operationKey } = await funded(f);
  f.router.mode = 'before_apply';
  assert.equal((await f.engine.provision(operationKey)).outcome, 'uncertain');
  assert.equal(f.store.snapshot().periods[order.id].activationAt, null);
  f.advance(2 * 3600000); f.router.mode = 'ready';
  const result = await f.engine.provision(operationKey);
  assert.equal(result.activationAt, f.clock());
  assert.equal(result.expiresAt - result.activationAt, 3600000);
});

test('lost reply is reconciled without restarting time or creating duplicate access', async () => {
  const f = fixture(); const { operationKey } = await funded(f);
  const firstReady = f.clock(); f.router.mode = 'after_apply';
  assert.equal((await f.engine.provision(operationKey)).outcome, 'uncertain');
  f.advance(600000); f.router.mode = 'ready';
  const result = await f.engine.provision(operationKey);
  assert.equal(result.activationAt, firstReady);
  assert.equal(f.router.applyCount, 1);
});

test('engine reconstruction after crash recovers recorded router time', async () => {
  const f = fixture(); const { operationKey } = await funded(f);
  const readyAt = f.clock();
  await assert.rejects(f.engine.provision(operationKey, { crashAfterApply: true }), /worker crash/);
  const store = new MemoryStore(f.store.snapshot());
  f.advance(120000);
  const restarted = new BillingSimulation({ store, payments: f.payments, router: f.router, clock: f.clock });
  assert.equal((await restarted.provision(operationKey)).activationAt, readyAt);
  assert.equal(f.router.applyCount, 1);
});

test('concurrent provisioning retries apply once and finalize once', async () => {
  const f = fixture(); const { operationKey } = await funded(f);
  await Promise.all(Array.from({ length: 10 }, () => f.engine.provision(operationKey)));
  assert.equal(f.router.applyCount, 1);
  assert.equal(f.store.snapshot().events.filter((e) => e.action === 'access_confirmed').length, 1);
});

test('simulated router locally expires while engine is idle; stale expiry job does nothing', async () => {
  const f = fixture(); const { operationKey } = await funded(f);
  await f.engine.provision(operationKey);
  assert.equal(f.router.hasAccess('router-1/hotspot-1', f.clock()), true);
  assert.equal((await f.engine.expire(operationKey, 0)).outcome, 'stale');
  assert.equal((await f.engine.expire(operationKey, 1)).outcome, 'not_due');
  f.advance(3600000);
  assert.equal(f.router.hasAccess('router-1/hotspot-1', f.clock()), false);
  assert.equal((await f.engine.expire(operationKey, 1)).outcome, 'expired');
});

test('unreachable router retains pending work without guessing activation', async () => {
  const f = fixture(); const { order, operationKey } = await funded(f);
  f.router.mode = 'unreachable';
  assert.equal((await f.engine.provision(operationKey)).outcome, 'uncertain');
  assert.equal(f.store.snapshot().periods[order.id].activationAt, null);
  assert.equal(Object.keys(f.store.snapshot().outbox).length, 1);
});

test('unsupported overlapping purchases and invalid prices are rejected explicitly', async () => {
  const f = fixture(); await f.checkout();
  await assert.rejects(f.checkout(), /renewal is not implemented/);
  await assert.rejects(f.checkout({ customerId: 'other', packageTerms: { ...f.terms, amountMinor: 1.5 } }), /safe integer/);
});
