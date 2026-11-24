# PayHero integration assessment

Rechecked 15 October 2026 using Context7 and the official Kenya/Africa documentation. Documentation review only: no credentials used, authenticated payment API calls made, STK requests sent or money moved.

## Decision

Following the owner's instruction to build the integration, a configurable Kenya M-Pesa STK v2 adapter is now implemented with collection disabled until configured. See [implementation and setup](design/payhero-integration.md). The owner's provider-hosted sandbox access is still needed to validate its endpoint, credentials, channel and actual payloads. Public documentation also describes the separate Africa/global interface; its identifiers and callback formats must not be mixed into this adapter.

## Documentation findings

The [Kenya STK documentation](https://docs.payhero.co.ke/docs/post-initiate-mpesa-stk-push-request) describes `POST https://backend.payhero.co.ke/api/v2/payments`, HTTP Basic authentication, an integer amount, phone number, `channel_id`, `provider: m-pesa`, external reference and callback URL. Initiation returns queued status and provider identifiers, not proof of payment. The [Kenya callback](https://docs.payhero.co.ke/docs/payment-callback) has a nested response containing the external reference, checkout ID, amount, result and receipt.

The [Africa environments page](https://docs.payhero.africa/get-started/environments/) recommends the global API for new integrations and lists the Kenya endpoints as compatibility interfaces on the Africa host. This alone does not establish that the owner's existing Kenya account can use them unchanged.

The [Kenya collections guide on Africa](https://docs.payhero.africa/kenya/collections/) distinguishes channel-based settlement to an external destination from collection into a provider wallet. Our plan prefers the ISP's own external channel. Confirm an active channel and its actual destination; do not silently substitute a wallet route. The guide includes account selection as well as channel routing, which must be checked against the account's contract.

The [Africa callback guide](https://docs.payhero.africa/guides/callbacks/) uses a different, flat result with merchant/external/provider references and currency. It asks consumers to acknowledge stored notifications promptly. The [status endpoint](https://docs.payhero.africa/api-reference/operations/gettransactionstatus/) documents an authenticated POST with a request ID. Verify its applicable identifier and response evidence using the chosen account/API family.

## Recheck findings for implementation

- The [global integration guide](https://docs.payhero.africa/get-started/integration-guide/) requires enabled providers on the account before discovery will return usable rails/networks. Global requests include `vendor_config.vendor_id` and discovered routing fields. Do not copy example provider/network IDs or assume Kenya V2 channel IDs are interchangeable with global IDs.
- [Authentication](https://docs.payhero.africa/get-started/authentication/) uses a generated API username/password pair with HTTP Basic auth. These credentials belong only on the backend.
- The [Kenya status lookup](https://docs.payhero.co.ke/docs/get-transaction-status) is `GET /api/v2/transaction-status?reference=...`, using the provider reference returned during initiation (the docs also allow a receipt code). Its example includes status and references, but does not establish amount/currency/channel evidence sufficient for automatic fulfillment by itself.
- The global status lookup is `POST /api/global/transaction-status` with `request_id`, documented as the merchant/request reference returned during creation. This is a different contract from Kenya's GET lookup.
- [Global collection amounts](https://docs.payhero.africa/global/collections/) are expressed in the country's currency, with at most two decimal places and network-specific limits. Our integer minor-unit amounts must be deliberately converted: 5,000 internal minor units means KES 50, not KES 5,000. Kenya STK documents an integer amount; fractional-KES support must be confirmed rather than silently rounded.
- Kenya payment initiation returns `201` and a queued result; global create responses also do not establish settlement. Keep payment verification separate from access provisioning. The callback guide recommends storing the notification and acknowledging promptly before fulfillment work.
- The reviewed environments, collection and integration pages do not establish a separate nonfinancial sandbox. Do not equate example requests, service credits or KYC dry-runs with simulated payment rails. Our existing local payment demo remains explicitly simulated.

The implementation now targets the documented Kenya v2 family explicitly. It uses a per-attempt secret callback URL plus independent authenticated status verification; this does not assume an undocumented provider-native signing scheme. It remains unconfigured and has not been certified against the owner's sandbox. The next operational step is to enter the provider-issued sandbox settings and validate that account's callback/status contract.

## Unresolved verification requirements

- Reviewed callback pages do not establish a usable signing-secret/signature-validation contract. A generic Basic-auth label in API-reference pages is not proof of how inbound callbacks authenticate. Confirm the supported mechanism and replay protection with provider evidence.
- Establish whether authenticated status/history evidence exposes the amount, currency, merchant/channel ownership, original request and final outcome required by the plan. Public examples alone do not close that gate.
- Confirm initiation idempotency and reference uniqueness guarantees. A timeout after sending an STK request must not automatically trigger another charge attempt.
- Confirm callback retry timing, duplicate/out-of-order delivery, rate limits, reversal notification and supported refund procedure. Fees and settlement behavior remain account-specific verification items.
- Confirm whether test service credits correspond to real payment rails. Do not assume a sandbox exists or that test credits make a customer transaction nonfinancial.

## Proposed processing contract

This is our design proposal, not a claim that the provider implements these guarantees:

1. Freeze order terms and selected merchant/channel; persist a distinct payment attempt and correlation reference before initiation.
2. Save returned provider identifiers. Treat queued responses, network timeouts and unknown results as pending/uncertain; reconcile before resubmitting.
3. Persist callbacks in a durable inbox with bounded request sizes and redacted operational logs; acknowledge after durable storage, then verify asynchronously.
4. Until callback authenticity is demonstrated, treat callback fields as untrusted hints. Query the authenticated provider API using identifiers stored from our initiation, and verify the required transaction details. If those details cannot be established, hold for review rather than grant access.
5. Apply the database uniqueness, payment transaction and provisioning-outbox rules in the implementation plan. Only a verified payment can schedule a grant; payment success never establishes router success.
6. Reconcile missing callbacks and excess payments. Keep separate immutable evidence for refunds/reversals and resulting access decisions.

Use one provider interface, with an explicit API-family setting and separately tested adapters where necessary. Do not silently fail over between different payment APIs after initiation uncertainty.

## Next input

Confirm whether the owner already has a PayHero account and an active Till/Paybill/bank collection channel, and which dashboard/domain it uses. No passwords or API keys should be posted in chat. Account confirmation can proceed independently of real-router availability; live payment verification still requires a reachable HTTPS callback endpoint and an explicitly agreed test transaction.
