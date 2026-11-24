## Configure a policy

Use Configure FUP in the package editor to define fair usage terms. Supported policy choices include reset-window rules, usage direction, warning thresholds, and staged speed changes. Review the saved policy before applying the offer to customers.

Customer overrides can inherit the package policy, use a custom policy, or exempt the customer from FUP. An override may have an expiry. An exemption does not remove a separate hard data allowance.

## Policy priority

Expiry, suspension, revocation, and closed schedules still restrict access. Fair usage reduction is not permission to bypass those controls. A hard data cap takes precedence over FUP reset/exemption choices.

## Accounting requirements

Evaluation needs complete deduplicated usage for the exact reset window. A lifetime hard cap also requires lifetime usage. Whole-session totals spanning a reset boundary cannot safely be split into that window by guesswork.

Missing or incomplete accounting means unavailable, not zero consumption. Do not infer a customer has unused quota from an empty report.

## Current readiness

Configuration and the deterministic evaluation engine are implemented. The durable accounting pipeline stores observations and deltas, but verified period/reset-window correlation, automatic reevaluation, warning delivery, and qualified router application still need integration.

Saving FUP settings does not mean reduced speeds are being enforced. Review [Feature readiness](/docs/feature-readiness) before offering automatic FUP to customers.
