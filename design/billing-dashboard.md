# Billing dashboard

Fleet administrators land on **Dashboard → Billing**, ahead of Summary and
Operations. Accounts with other roles retain the network dashboard. Financial
reports are business-wide, including when a particular network site is selected;
the heading makes this scope explicit. Network polling on this page is disabled
while the Billing tab is active.

## Reading the overview

The period, package and payment-method filters apply to collection totals and
transaction activity. Dates use Africa/Nairobi and inclusive calendar days (up
to 93 days); the previous-period comparison uses the same number of days.
Customer access and connection counts show the current state, independent of
the financial date range. Search and status filters narrow the paginated register,
not the overview totals. Current attention filters include old unresolved items
outside the selected period.

The Customers register chooses a current valid/frozen entitlement ahead of an
old expired period or a queued renewal. Payment state, access state and connection
state are separate. Paused time, suspension, complimentary access and scheduled
hours are shown independently of payment results. Transactions retain every
purchase, with provider attempts inside its detail modal; retries do not multiply
transaction counts or collection amounts. Customer detail modals show access
periods, provisioning jobs and recent audit history.

Live connection status is currently **Unknown**, because the only RADIUS records
are isolated lab data. The live overview never infers offline status from missing
packets. The separate test view shows sandbox outcomes and simulation access;
all financial collection amounts remain zero. Connecting production accounting
will require associating sessions with customer accounts and a freshness policy.

## Confirmed receipts

`billing_payment_receipts` is an immutable receipt ledger, one receipt per
purchase. Verified live PayHero success writes its receipt in the same database
transaction as payment confirmation and access preparation. Existing verified
records are imported using the provider verification timestamp, explicitly noted
on the receipt. Sandbox success writes no financial receipt.

**Record offline payment** prepares a pending purchase with frozen server-side
package terms, then records verified cash, bank transfer or manually verified
M-Pesa. Existing pending purchases can also be settled from their detail modal.
The staff member must confirm receipt of the full amount and supply the actual
received time and an audit note; non-cash methods require a receipt/reference.
The receipt preserves both received and recorded times. Request keys make
confirmation idempotent. Bank reference uniqueness and case-insensitive M-Pesa
reference uniqueness prevent accidental reuse; unresolved live collection
attempts block manual confirmation. Test purchases cannot be promoted into live
receipts.

Recording payment prepares a live subscription and provisioning job. It does
not connect a router, issue credentials, or start purchased time. Router readiness
must still confirm activation. Receipts cannot be edited or deleted. Partial
payments, receipt corrections and a refund workflow are not implemented; refunded
purchases are excluded from the collected total, which is not a full accounting
cash-flow or profit report.

## Verification

- Dashboard/receipt validation and fleet-admin authorization tests.
- `scripts/check-billing-dashboard.cjs`: disposable schema, actual SQL totals,
  Nairobi boundaries, prior period, pagination, literal search, simulation
  isolation, schedule/entitlement precedence and concurrent receipt confirmation.
- `scripts/check-payhero.cjs`: provider reconciliation regression with injected
  fictional transport, including a single financial receipt for verified live
  success. No actual provider or router request is sent.
- Isolated UI fixtures verify filters, record modals, offline payment entry,
  dark mode and mobile layout.
