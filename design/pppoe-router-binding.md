# PPPoE router assignment and protocol fixture

Date: 2026-10-16. This slice prepares router assignments; it does not enable customer authentication or start purchased time.

## Dashboard

Customer > Access > PPPoE connections > Assign router opens a modal. Pick a managed router, discover its configuration, and choose an enabled existing PPPoE server. The profile and IPv4 pool come from that server's existing defaults. An optional unicast CPE MAC records the intended customer-router interface. Save creates a pending assignment with a reason and audit event.

No managed router is required to create the customer login, password or funded periods. Without a connected API router, assignment remains incomplete. SSH-only devices are shown as requiring the API. No model restriction is imposed; menus and capabilities determine eligibility.

Discovery reads RouterOS version, PPPoE servers, PPP profiles, IPv4 pools, PPP AAA enablement, a count of enabled PPP RADIUS clients, and a boolean for a local PPP username collision. Router password, subscriber passwords, RADIUS secrets, profile scripts and unrelated configuration are excluded from the inventory. Local PPP/any usernames are compared case-insensitively, including disabled secrets, because cutover needs an explicit decision.

The initial selection requires PAP or CHAP, an existing default profile with a local address, and a named IPv4 remote-address pool. This is a configuration eligibility check, not a forwarding, pool-capacity or Internet reachability check. RADIUS enablement/client counts are observational and do not establish ownership or safe cutover from another billing system.

## API and storage

Fleet-admin session only; responses are no-store. Site-scoped users and API-token operators cannot reach these endpoints.

- `GET /api/billing/customer-services/routers`: safe managed-router selector fields.
- `POST /api/billing/customer-services/:id/discover`: `{device_id,version}`. Reads through the existing managed RouterOS client and identity checks. Failure to read any required menu is an error, never a successful empty inventory.
- `POST /api/billing/customer-services/:id/binding`: `{version,discovery_id,server_id,profile_name,pool_name,cpe_mac,reason,request_key}`. Server names, device identity and interface are derived from discovery, not client-supplied addresses.

`billing_pppoe_discoveries` stores immutable service-specific snapshots valid for ten minutes. `billing_service_bindings` stores immutable pending revisions, uniquely keyed by request key and service/version. Service summaries return the latest pending assignment. Password changes increment the same service version and invalidate older discovery.

Lock order is customer, then service. Router I/O happens outside the transaction. A version check after the read rejects concurrent service changes. Saving serializes per customer/service, checks ownership, freshness, local-secret collision and exact default profile/pool matching, then inserts the revision, advances service version and writes the audit event atomically. Database constraints retain history and reject an unmatched target/version/discovery. Concurrent different operations with the same version yield one success; identical retries return the current service summary without restoring an old assignment.

Discovery can become outdated after saving. A future provisioner must rediscover/revalidate configuration, enroll a trusted private NAS identity and use operation fencing before applying changes. A pending record is never evidence of provisioning success. Assignment does not alter credentials, receipts, subscriptions, activation dates, expiry or router configuration.

## Separate RADIUS packet fixture

`radius/Dockerfile.pppoe-test` builds a separate FreeRADIUS 3.2.10 fixture. It is absent from the application's Dockerfiles and Compose services. Run with no network attachment and no published ports:

```powershell
docker build -f radius/Dockerfile.pppoe-test -t isp-pppoe-protocol-check radius
docker run --rm --network none --cap-drop ALL --user 101:101 --read-only --tmpfs /tmp --tmpfs /var/log/freeradius:uid=101,gid=101,mode=0770 --tmpfs /var/run/freeradius:uid=101,gid=101,mode=0770 isp-pppoe-protocol-check
```

The process generates disposable random secrets and sends real loopback RADIUS packets. Checks cover PAP and CHAP for two allowlisted fictional identities, wrong passwords, unknown/non-allowlisted identities, NAS/service/CPE mismatches, wrong shared secret, and expected PPP reply attributes. Customer upload is the first side of `Mikrotik-Rate-Limit` (`2M/5M` means 2 Mbps upload, 5 Mbps download). Replies carry a sixty-second timeout and Class correlation marker.

This fixture intentionally does not access the saved service credentials or funded periods. Names such as fixture-expired exercise the allowlist rejection only; they do not test database expiry policy. It does not prove admission reservations, session accounting correlation, usable access, reconnect expiry precision, router enforcement, PAP privacy over a private path, MS-CHAPv2, or model/version compatibility. These remain live release gates. The normal `/internal/radius/authorize` route and accounting lab continue to reject authentication.

## Verification

Added `pppoeBindings.test.ts` for strict input parsing, capability-based selection, incomplete-read failure, secret-field exclusion and local-secret conflict detection. `scripts/check-pppoe-bindings.cjs` runs inside the foundation check's disposable database schema, covering concurrent/replayed saves, stale/expired discovery, immutable history and unchanged credentials/subscription timestamps. It must be mounted alongside the existing foundation and funding scripts.

Validation completed after restarting Docker Desktop: backend and frontend production builds passed; all 258 selected Jest tests passed; the disposable-schema foundation/funding/binding integration checks passed; the separate FreeRADIUS 3.2 PAP/CHAP packet fixture passed. The fixture timeout accommodates FreeRADIUS rejection delays. Targeted backend lint had no errors (two warnings for a bounded MAC regex and a fixture lookup); targeted frontend lint passed without errors.

Deployed to the local Docker application after saving `.local/backups/pppoe-binding-before.dump`. Post-deployment checks passed for `/api/health`, anonymous router-list rejection/no-store headers, both additive tables and the service-summary query. A before/after hash confirmed production subscription states, activation dates and expiry dates were unchanged. The private production authorization endpoint still returns 403. The disposable database schema was removed; the temporary browser preview was closed and its container stopped. Real router discovery, PPP forwarding and enforcement still require hardware qualification.

Completed without Docker: ten changed TypeScript/TSX files parsed/transformed successfully; direct source assertions passed for strict input parsing, CPE normalization, capability/default selection, local-secret conflicts, read-only commands, secret projection and failed reads. Source encoding passed for 663 files. Browser QA with fictional data subsequently passed assignment/discovery/save, pending status, profile/pool display, optional CPE MAC, another RouterOS version, local-secret conflict blocking, no-router state, modal dismissal, dark mode and a 384-pixel mobile layout without horizontal overflow. These checks qualify the dashboard workflow and protocol fixture only; hardware forwarding/enforcement and database-backed live authorization remain untested and disabled.

References: [RouterOS PPPoE](https://help.mikrotik.com/docs/display/ROS/PPPoE), [PPP AAA](https://help.mikrotik.com/docs/display/ROS/PPP+AAA), [FreeRADIUS 3.2.10 virtual-server configuration](https://github.com/FreeRADIUS/freeradius-server/blob/release_3_2_10/raddb/sites-available/default). Context7's current FreeRADIUS examples use newer syntax; the fixture follows the pinned 3.2 source and must pass that binary's configuration check.
