# RADIUS integration: private accounting lab

This step adds FreeRADIUS protocol testing and an accounting ingestion path. It does not enable live customer authentication, issue credentials, bind customers to a router, change payments, or confirm live access provisioning.

## Isolation

- FreeRADIUS 3.2.10 is pinned by image digest. The separate Compose overlay is opt-in; ordinary app startup does not publish RADIUS ports or enroll a router.
- The lab listens only on its own loopback addresses, accepts one loopback client with a generated shared secret, and requires Message-Authenticator on Access-Requests.
- A private Docker network connects FreeRADIUS to the backend. The HTTP bridge uses a separate 256-bit token; nginx blocks `/internal/` rather than forwarding it. It is mounted before dashboard audit and rate-limit middleware so packet throughput does not consume administrator request limits or log authorization headers.
- Secrets are generated in the ignored local environment file and are not displayed. The container runs as the FreeRADIUS account with capabilities dropped and a read-only root filesystem.
- Authentication always rejects. This is deliberate until the authorization/provisioning protocol, router binding and enforced expiry have been implemented and tested.

## Accounting semantics

FreeRADIUS overwrites `Tmp-IP-Address-0` from the received UDP source address. The bridge uses that value rather than trusting a packet's claimed `NAS-IP-Address`. Only loopback lab traffic is currently enrolled.

Records are keyed by source, NAS identifier, username and session ID. Each normalized packet has a unique SHA-256 fingerprint. Repeated packets do not add usage. Input octets/gigawords are customer upload; output is customer download. Values combine with exact integer arithmetic and are checked against the supported safe range. Record totals and elapsed time use maxima so late packets cannot decrease them. A stop is terminal; a later start cannot reopen the record. Changed starts after a stop, counter resets after a changed start, and boot boundary notices mark ambiguity for review.

All records remain separate unlinked lab diagnostics. Missing starts, missing stops and possible session-ID reuse are visible. An open accounting record is not proof of a customer being online. This path does not infer customer ownership, initial activation time, entitlements or remaining data allowances.

The backend returns success only after the database transaction commits. FreeRADIUS withholds an accounting response if the bridge fails, allowing a NAS to retry. Durable packet replay and late-arrival behavior are checked independently of the router.

## Run locally

Generate missing secrets once (the script preserves existing configured values):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-radius-lab.ps1
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml -f docker-compose.radius-lab.yml up --build -d --wait backend nginx radius-lab
```

Run a real packet exchange and inspect its persisted result:

```powershell
docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml -f docker-compose.radius-lab.yml exec -T radius-lab check-billing-lab
Get-Content -Raw scripts/check-radius-lab.cjs | docker compose -p isp-billing-dev --env-file .local/manager.env -f docker-compose.yml exec -T backend node
```

The labelled `radius-lab` record is retained as visible diagnostic evidence under Billing > RADIUS diagnostics. No personal/customer test account is created. The server configuration never enables FreeRADIUS debug mode, which could disclose shared secrets or credentials.

## Remaining live integration

Enroll the router over a private path with a separate per-router secret and read-only discovery of existing Hotspot/RADIUS ownership. Bind each account to the chosen router/Hotspot. Implement credential handling for the selected login methods, authorization against current customer policy, conservative session admission, accounting-to-account binding, and router disconnect/CoA with confirmed outcomes. Effective activation must follow verifiable readiness; uncertain outcomes must preserve evidence and prevent duplicate grants. Test expiry and disconnect during app/worker outages, router restart, lost responses, and migration from an existing provider before marking live service ready.

Sources: [FreeRADIUS security release](https://www.freeradius.org/release_notes/), [FreeRADIUS 3 REST configuration](https://github.com/FreeRADIUS/freeradius-server/blob/v3.2.x/raddb/mods-available/rest), [MikroTik RADIUS reference](https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS).

## Verification completed

On 2026-10-15: 25 targeted backend tests, backend/frontend production builds, and frontend lint passed. Real timestamped Start/Interim/Stop packets traversed FreeRADIUS and the authenticated HTTP bridge into PostgreSQL. The repeated interim packet produced one stored event; the late update preserved stopped state and the final counters. The protocol check also verified that rejected accounting receives no ACK and authentication receives Access-Reject. The authenticated dashboard API returned the persisted lab record without exposing the bridge token. HTTPS health, compiled assets, ordinary API authentication and nginx blocking of the private bridge passed. Browser visual verification remains unavailable because of the local self-signed certificate.
