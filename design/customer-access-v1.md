# Customer access v1 implementation

Agreed scope: customer devices/MACs and session limits; complimentary access/revocation; speed overrides/reset; suspend/resume; renewals/expiry; sessions/disconnection; provisioning status/audit; alerts; schedules; vacation/pause.

Implementation rules:
- Router/RADIUS adapter is not connected. Live changes remain pending and never fabricate applied state, credentials or payment success.
- Simulator can confirm disconnection/readiness transactionally. Pause preserves remaining milliseconds only on that confirmation. Resume preserves the original subscription timestamps and stores an adjusted expiry separately, only after schedule/readiness permits access.
- Suspend and scheduled restrictions do not freeze subscription time. Scheduled windows use an explicit IANA timezone, support overnight windows and have exclusive end times.
- Customer operations serialize on customer first, then subscription; session admission follows the same order. Version/request-key checks protect concurrent edits/retries.
- Default policy: five registered devices, one simultaneous session, open enrollment. Explicitly disabled devices cannot connect; registered-only mode is optional. MAC registration alone never authorizes access.
- Renewal queues a separate existing successor entitlement, preserving both periods. It cannot shorten or replace an unexpired predecessor. Simulations may start the successor only after predecessor expiry and readiness; live successors require a future adapter and verified funding.
- Alerts are in-dashboard only, deduplicated and acknowledgeable. No email/SMS delivery is claimed or sent.
- Use existing Devices-style UI and shared modals on the customer profile.

Implemented: lifecycle/policy schema and API, simulator gates and reconciliation, dashboard controls, tests and isolated deployment checks. Evaluate further features after reviewing this v1 scope.

## Dashboard locations

- Customers > customer > Manage access: Controls, Devices, Schedule, Provisioning, Alerts.
- Controls: enable/resume, suspension, pause/vacation with optional return date, disconnect one/all sessions, permanently revoke a complimentary period, queue an existing unstarted replacement.
- Devices: optional initial MAC during customer creation; more devices later; labels and enable/disable, customer-wide connection limits, optional registered-only admission.
- Billing > Access alerts: latest 200 unresolved alerts across customers. Marking read acknowledges a notice without resolving its condition. Deadline changes resolve the old notice; confirmed simulation renewal resolves predecessor expiry notices.
- Original access dates remain immutable; runtime holds pause-adjusted expiry and preserved milliseconds. Schedules restrict admission at the start boundary, and reconciliation closes existing test sessions within its 15-second sweep interval.

## Verification

`accessManagement.test.ts` covers roles/site scope, forged enforcement fields, MAC/version validation and timezone/overnight/DST schedule boundaries. Existing billing route tests remain regression coverage.

Run `scripts/check-access-management.cjs` inside the backend container via stdin for isolated API/PostgreSQL fixtures. It checks concurrent admission, device disabling, counter preservation, vacation confirmation and retries, paused expiry, readiness gating, suspension, revocation, renewal ordering, alerts and live-pending behavior. The script removes only its own fixtures. Real RouterOS/RADIUS enforcement and hardware validation remain separate integration work.

Validation on 2026-10-15: 161 targeted backend tests passed. Deployed API/PostgreSQL checks passed for access management, existing subscriptions, session accounting and customer profiles/speed overrides. The explicit expiry-versus-pause race test confirms expiry waits on the customer lock and reads the newly confirmed pause. Browser visual verification could not be completed because the in-app browser rejects the local self-signed certificate; no browser certificate warning was bypassed.
