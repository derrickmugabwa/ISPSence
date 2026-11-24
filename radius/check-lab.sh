#!/bin/sh
set -eu
umask 077
secret_file=$(mktemp)
packet_file=$(mktemp)
reply_file=$(mktemp)
trap 'rm -f "$secret_file" "$packet_file" "$reply_file"' EXIT HUP INT TERM
printf '%s\n' "$RADIUS_LAB_SECRET" > "$secret_file"
session="lab-$(date +%s)-$$"
event_time=$(date +%s)
send_accounting() {
    kind=$1
    elapsed=$2
    input=$3
    output=$4
    cat > "$packet_file" <<EOF
User-Name = "radius-lab"
NAS-Identifier = "private-lab"
Acct-Session-Id = "$session"
Acct-Status-Type = $kind
Event-Timestamp = $event_time
Acct-Session-Time = $elapsed
Acct-Input-Octets = $input
Acct-Output-Octets = $output
Message-Authenticator = 0x00
EOF
    if ! radclient -r 1 -t 5 -S "$secret_file" -f "$packet_file" 127.0.0.1:1813 acct > "$reply_file" 2>&1; then
        printf '%s\n' 'FAIL: accounting did not receive a successful response'
        exit 1
    fi
}
send_accounting Start 0 0 0
send_accounting Interim-Update 60 12345 67890
send_accounting Interim-Update 60 12345 67890
send_accounting Stop 120 20000 90000
# A late update must neither reopen the record nor lower its counters.
send_accounting Interim-Update 30 100 200
# The application rejects incomplete accounting. FreeRADIUS must not ACK it.
cat > "$packet_file" <<EOF
Acct-Status-Type = Start
Acct-Session-Id = "incomplete-$session"
Message-Authenticator = 0x00
EOF
if radclient -r 1 -t 1 -S "$secret_file" -f "$packet_file" 127.0.0.1:1813 acct > "$reply_file" 2>&1; then
    printf '%s\n' 'FAIL: rejected accounting was acknowledged'
    exit 1
fi
cat > "$packet_file" <<EOF
User-Name = "radius-lab"
User-Password = "not-a-customer-credential"
Message-Authenticator = 0x00
EOF
radclient -r 1 -t 5 -S "$secret_file" -f "$packet_file" 127.0.0.1:1812 auth > "$reply_file" 2>&1 || true
if ! grep -q 'Access-Reject' "$reply_file"; then
    printf '%s\n' 'FAIL: lab authorization did not reject access'
    exit 1
fi
printf '%s\n' "PASS: RADIUS Start/Interim/Stop, retransmission, late update, rejected accounting without ACK and denied authentication; session=$session"
