#!/bin/sh
set -eu
umask 077
attempt=0
while [ ! -s /lab/fixture.env ] && [ "$attempt" -lt 45 ]; do sleep 1; attempt=$((attempt+1)); done
[ -s /lab/fixture.env ] || { printf '%s\n' 'FAIL: database fixture did not become ready'; exit 1; }
. /lab/fixture.env
work=$(mktemp -d)
pid=''
cleanup() { if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM
printf '%s\n' "$RADIUS_LAB_SECRET" > "$work/secret"
freeradius -C -l stdout > "$work/config.log" 2>&1 || { printf '%s\n' 'FAIL: database fixture configuration'; cat "$work/config.log"; exit 1; }
freeradius -f -l "$work/server.log" > "$work/start.log" 2>&1 &
pid=$!
packet() {
    user=$1; method=$2; password=$3; nas=${4:-db-lab}; service=${5:-fixture-internet}; mac=${6:-02:00:00:00:00:01}
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
packet wire-paid-pap User-Password "$WIRE_PAID_PAP_PASSWORD"
ready=0
for i in 1 2 3 4 5; do send; if grep -q '^Received Access-Accept' "$work/reply"; then ready=1; break; fi; sleep 1; done
[ "$ready" = 1 ] || { printf '%s\n' 'FAIL: saved PAP credential or REST policy'; grep -E 'Error|Warning' "$work/server.log" | tail -n 10 || true; exit 1; }
class_expression=$(sed -n 's/^.*Class = //p' "$work/reply" | tail -n 1)
[ -n "$class_expression" ] || { printf '%s\n' 'FAIL: missing authorization correlation'; sed -n '/Received Access-/,$p' "$work/reply"; exit 1; }
for expected in 'Mikrotik-Rate-Limit = "2000000/5000000"' 'Session-Timeout = 30' 'Framed-Pool = "fixture-pool"'; do grep -q "$expected" "$work/reply" || { printf '%s\n' "FAIL: $expected"; exit 1; }; done
account() {
    kind=$1; elapsed=$2; upload=$3; download=$4
    cat > "$work/packet" <<EOF
User-Name = "wire-paid-pap"
NAS-Identifier = "db-lab"
Calling-Station-Id = "02:00:00:00:00:01"
Class = $class_expression
Acct-Session-Id = "wire-session"
Acct-Status-Type = $kind
Acct-Session-Time = $elapsed
Event-Timestamp = $(date +%s)
Framed-IP-Address = 10.20.0.2
Acct-Input-Octets = $upload
Acct-Output-Octets = $download
Message-Authenticator = 0x00
EOF
    radclient -x -r 1 -t 5 -S "$work/secret" -f "$work/packet" 127.0.0.1:18130 acct > "$work/reply" 2>&1 || { printf '%s\n' 'FAIL: durable correlated accounting'; exit 1; }
}
account Start 0 0 0
account Interim-Update 10 12345 67890
account Interim-Update 10 12345 67890
account Stop 20 20000 90000
account Interim-Update 5 1 1
for spec in paid-chap free-pap free-chap; do
    case "$spec" in paid-chap) password=$WIRE_PAID_CHAP_PASSWORD; method=CHAP-Password;; free-pap) password=$WIRE_FREE_PAP_PASSWORD; method=User-Password;; free-chap) password=$WIRE_FREE_CHAP_PASSWORD; method=CHAP-Password;; esac
    packet "wire-$spec" "$method" "$password"
    # One CHAP fixture exercises an explicit challenge; the other uses the
    # signed Access-Request authenticator supplied internally by FreeRADIUS.
    if [ "$spec" = free-chap ]; then printf '%s\n' 'CHAP-Challenge = 0x00112233445566778899aabbccddeeff' >> "$work/packet"; fi
    send; grep -q '^Received Access-Accept' "$work/reply" || { printf '%s\n' "FAIL: saved $spec credential"; exit 1; }
done
for method in User-Password CHAP-Password; do packet wire-paid-pap "$method" wrong-password; send; grep -q '^Received Access-Reject' "$work/reply" || { printf '%s\n' 'FAIL: password rejection'; exit 1; }; done
for user in unpaid suspended expired; do
    case "$user" in unpaid) password=$WIRE_UNPAID_PASSWORD;; suspended) password=$WIRE_SUSPENDED_PASSWORD;; expired) password=$WIRE_EXPIRED_PASSWORD;; esac
    packet "wire-$user" User-Password "$password"; send; grep -q '^Received Access-Reject' "$work/reply" || { printf '%s\n' "FAIL: billing policy rejection for $user"; exit 1; }
done
for invalid in nas service mac; do
    nas=db-lab; service=fixture-internet; mac=02:00:00:00:00:01
    case "$invalid" in nas) nas=wrong;; service) service=wrong;; mac) mac=02:00:00:00:00:02;; esac
    packet wire-paid-pap User-Password "$WIRE_PAID_PAP_PASSWORD" "$nas" "$service" "$mac"; send; grep -q '^Received Access-Reject' "$work/reply" || { printf '%s\n' "FAIL: wrong $invalid"; exit 1; }
done
packet wire-paid-pap User-Password "$WIRE_PAID_PAP_PASSWORD"
printf '%s\n' 'wrong-shared-secret' > "$work/secret"; send
if grep -q '^Received Access-Accept' "$work/reply"; then printf '%s\n' 'FAIL: wrong RADIUS secret'; exit 1; fi
printf '%s\n' 'PASS: database-backed PAP/CHAP for paid and complimentary logins, explicit/fallback CHAP challenge, billing denials, correlated durable accounting, duplicate/late packets and wrong shared secret'
