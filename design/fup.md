# Fair usage policies

Package policy: optional, versioned JSON with 1–8 cumulative usage stages; download/upload/combined counters; lower speeds or final block. Warning percentage is evaluated before the next stage. Stages cannot raise speeds. A customer's existing speed override is the normal ceiling; a reached FUP tier caps it using the lower value in each direction.

Daily resets occur at local midnight, weekly on Monday, monthly on day 1; timezone is explicit. Subscription resets use effective activation and expiry. Calendar windows are clipped to access boundaries and honor DST. Pausing access does not extend calendar reset periods. Renewal creates a new entitlement; no carryover.

Purchased and complimentary terms include a frozen package policy. Editing a package affects future purchases, never historical snapshots. Old purchases without a policy have no package FUP. Customer settings can inherit those purchased terms, replace them, or exempt FUP. A dated replacement/exemption automatically falls back to purchased terms on expiry. Changes use optimistic versions and customer locks and are audited.

Policies apply across sessions within each subscription/access period, for both Hotspot and PPPoE. Customer overrides apply to all the customer's access periods; each period has its own counters. Hard data allowance remains a separate subscription-lifetime cap and overrides FUP exemptions/resets. Suspension, schedule closure, revocation and expiry take precedence.

The evaluation engine requires complete deduplicated accounting for the exact reset window. A hard cap additionally requires lifetime usage. Missing/incomplete accounting returns unavailable, not zero. Historical whole-session counters cannot determine calendar-window usage.

Configuration and deterministic policy evaluation are implemented. Production accounting ingestion, warning-alert delivery, periodic reevaluation, recoverable router application and confirmed stage status are not yet connected. The dashboard explicitly reports this. Do not treat saving policy as enforcement. Those adapters must use the shared reset/evaluation functions, exclude legacy test observations, deduplicate counters across retries, handle resets/late events and preserve requested/applied state.
