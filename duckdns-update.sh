#!/bin/sh
# Keep b4us.duckdns.org pointed at this host's current public IP.
# Token from $DUCKDNS_TOKEN or /root/.duckdns-token (operator-created, gitignored).
# Never fetches or logs the public IP: ip= is left empty so DuckDNS resolves it
# server-side from the request source.
TOKEN="${DUCKDNS_TOKEN:-$(cat /root/.duckdns-token 2>/dev/null)}"
[ -z "$TOKEN" ] && { echo "duckdns: missing DUCKDNS_TOKEN / /root/.duckdns-token" >&2; exit 1; }
RESP=$(curl -s "https://www.duckdns.org/update?domains=b4us&token=${TOKEN}&ip=")
[ "$RESP" = "OK" ] && exit 0
echo "duckdns update failed (response: $RESP)" >&2
exit 1
