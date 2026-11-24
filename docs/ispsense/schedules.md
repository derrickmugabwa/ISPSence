## Configure allowed hours

Open the customer's Manage access → Schedule. Select the days and hours when access should be allowed, with an explicit timezone. Review overnight windows carefully: their allowed interval crosses midnight.

## How boundaries work

The end of a scheduled window is exclusive. Daylight-saving changes follow the chosen timezone. Use the timezone of the intended business policy rather than relying on the administrator's browser timezone.

## Schedules and paid time

A schedule restricts access; it does not freeze purchased time. Use pause/vacation when the agreed policy is to preserve remaining time, and wait for confirmed disconnection.

Suspension, revocation, expiry, and other access restrictions still apply even during an allowed window.

## Confirm application

Saving the schedule records the requested policy. It does not establish that a router is enforcing it. Review [provisioning](/docs/provisioning) and [feature readiness](/docs/feature-readiness) before offering scheduled service to a live customer.
