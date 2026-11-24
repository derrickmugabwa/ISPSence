## Read payment history

Billing → Payments shows the customer, reference, frozen package terms, amount, payment status, and access status. A purchase, a provider attempt, a confirmed receipt, and usable access are separate records and states.

The payer can differ from the customer. Check the customer and payment reference before recording a receipt or investigating a provider result.

## Offline payments

Use the offline-payment action to record money received through a supported manual method. Check the amount, reference, date, and notes before saving. This is a financial record; record actual receipts rather than expected payments.

Confirmed receipts contribute to collections. Pending requests and provider sandbox results must not be reported as collected real money.

## Online payments

PayHero handles the configured online collection flow. Configure it in Settings → PayHero, then verify with provider-issued sandbox credentials before enabling collections. A selected package or an initiated STK request is not payment confirmation.

See [PayHero](/docs/payhero) for channels, callbacks, and credential handling.

## After payment

Review the subscription and provisioning state. Payment confirmation does not prove that the router has enabled access. Paid time must begin only when the activation protocol confirms readiness; it must not be consumed by a stalled provisioning request.

Continue with [Subscriptions and renewals](/docs/subscriptions).
