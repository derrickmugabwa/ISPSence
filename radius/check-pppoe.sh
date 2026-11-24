#!/bin/sh
set -eu
umask 077
# The fixture generates its own disposable secrets and has no database access.
export RADIUS_LAB_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export PPPOE_FIXTURE_PASSWORD="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
work=$(mktemp -d)
pid=''
cleanup() { if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM
printf '%s\n' "$RADIUS_LAB_SECRET" > "$work/secret"
freeradius -C > "$work/config.log" 2>&1 || { printf '%s\n' 'FAIL: PPPoE fixture configuration'; cat "$work/config.log"; exit 1; }
freeradius -f -l "$work/server.log" > "$work/start.log" 2>&1 &
pid=$!
packet() {
    user=$1; method=$2; password=$3; nas=$4; service=$5; mac=$6
    cat > "$work/packet" <<EOF
User-Name = "$user"
$method = "$password"
NAS-Identifier = "$nas"
Service-Type = Framed-User
Framed-Protocol = PPP
Called-Station-Id = "$service"
Calling-Station-Id = "$mac"
Message-Authenticator = 0x00
EOF
}
send() { radclient -x -r 1 -t 5 -S "$work/secret" -f "$work/packet" 127.0.0.1:18120 auth > "$work/reply" 2>&1 || true; }
packet fixture-paid User-Password "$PPPOE_FIXTURE_PASSWORD" pppoe-fixture fixture-internet 02:00:00:00:00:01
ready=0
for i in 1 2 3 4 5; do send; if grep -q 'Access-Accept' "$work/reply"; then ready=1; break; fi; sleep 1; done
[ "$ready" = 1 ] || { printf '%s\n' 'FAIL: PPPoE fixture startup/authentication'; exit 1; }
for method in User-Password CHAP-Password; do
    for user in fixture-paid fixture-complimentary; do
        packet "$user" "$method" "$PPPOE_FIXTURE_PASSWORD" pppoe-fixture fixture-internet 02:00:00:00:00:01
        send
        grep -q 'Access-Accept' "$work/reply" || { printf '%s\n' "FAIL: $method authentication"; exit 1; }
        for expected in 'Framed-Protocol = PPP' 'Framed-Pool = "fixture-pool"' 'Mikrotik-Rate-Limit = "2M/5M"' 'Session-Timeout = 60' 'Acct-Interim-Interval = 60' 'Class ='; do
            grep -q "$expected" "$work/reply" || { printf '%s\n' "FAIL: missing $expected"; exit 1; }
        done
    done
    packet fixture-paid "$method" wrong-password pppoe-fixture fixture-internet 02:00:00:00:00:01
    send; grep -q 'Access-Reject' "$work/reply" || { printf '%s\n' 'FAIL: bad password did not receive Access-Reject'; exit 1; }
done
for user in fixture-unpaid fixture-expired fixture-suspended unknown; do
    packet "$user" User-Password "$PPPOE_FIXTURE_PASSWORD" pppoe-fixture fixture-internet 02:00:00:00:00:01
    send; grep -q 'Access-Reject' "$work/reply" || { printf '%s\n' 'FAIL: non-allowlisted identity did not receive Access-Reject'; exit 1; }
done
for invalid in nas service mac; do
    nas=pppoe-fixture; service=fixture-internet; mac=02:00:00:00:00:01
    case "$invalid" in nas) nas=wrong;; service) service=wrong;; mac) mac=02:00:00:00:00:02;; esac
    packet fixture-paid User-Password "$PPPOE_FIXTURE_PASSWORD" "$nas" "$service" "$mac"
    send; grep -q 'Access-Reject' "$work/reply" || { printf '%s\n' "FAIL: wrong $invalid did not receive Access-Reject"; exit 1; }
done
packet fixture-paid User-Password "$PPPOE_FIXTURE_PASSWORD" pppoe-fixture fixture-internet 02:00:00:00:00:01
printf '%s\n' 'wrong-shared-secret' > "$work/secret"
send
if grep -q 'Access-Accept' "$work/reply"; then printf '%s\n' 'FAIL: wrong RADIUS secret accepted'; exit 1; fi
printf '%s\n' 'PASS: isolated FreeRADIUS 3.2 PAP/CHAP, incorrect passwords, allowlisted identities, NAS/service/CPE checks, PPP pool/speed/time/Class replies and wrong shared secret'
printf '%s\n' 'Fixture only: database policy, admission reservations, accounting activation and router enforcement remain separate gates.'
