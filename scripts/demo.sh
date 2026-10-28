#!/usr/bin/env bash
# CarrierBridge two-minute demo. Requires: a running stack (docker compose up), curl, jq.
#   ./scripts/demo.sh            # interactive (pauses between steps)
#   DEMO_FAST=1 ./scripts/demo.sh  # no pauses
set -euo pipefail

API=${API:-http://localhost:3000}
MOCK_A=${MOCK_A:-http://localhost:4001}
MOCK_B=${MOCK_B:-http://localhost:4002}

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; [[ -n "${DEMO_FAST:-}" ]] || read -r -p "(enter to continue) " _; }
wait_for_pull() {
  local id=$1 status
  for _ in $(seq 1 60); do
    status=$(curl -s "$API/pulls/$id" | jq -r .status)
    [[ "$status" != "pending" && "$status" != "running" ]] && break
    sleep 0.5
  done
}
connections() {
  # $1 = carrier B password (lets the demo break exactly one carrier)
  cat <<JSON
{"connections":[
  {"carrierId":"carrier-a","credentials":{"username":"alex.rivera@example.com","password":"apex-demo-1"}},
  {"carrierId":"carrier-b","credentials":{"username":"ARIVERA","password":"$1"}},
  {"carrierId":"carrier-c","credentials":{"username":"arivera","password":"portal-demo-1"}}]}
JSON
}

curl -s -X POST "$MOCK_A/__control/reset" >/dev/null

step "1. Three carriers, three integration styles"
curl -s "$API/carriers" | jq -c '.data[] | {id, integrationType, description}'

step "2. Start an async pull across all three (202 + Location)"
KEY="demo-$(date +%s)"
curl -s -i -X POST "$API/pulls" -H 'content-type: application/json' -H "Idempotency-Key: $KEY" \
  -d "$(connections 'Legacy#2024')" | grep -iE '^(HTTP|location|idempotent-replayed|x-request-id)'
PULL=$(curl -s -X POST "$API/pulls" -H 'content-type: application/json' -H "Idempotency-Key: $KEY" -d "$(connections 'Legacy#2024')" | jq -r .id)
wait_for_pull "$PULL"
curl -s "$API/pulls/$PULL" | jq '{status, summary, carriers: [.carriers[] | {carrierId, status, attempts, policyCount}]}'

step "3. Same key, same body: idempotent replay (200, same id)"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$API/pulls" -H 'content-type: application/json' -H "Idempotency-Key: $KEY" -d "$(connections 'Legacy#2024')"
echo "Same key, different body:"
curl -s -X POST "$API/pulls" -H 'content-type: application/json' -H "Idempotency-Key: $KEY" -d "$(connections 'other')" | jq -c '{status, code, detail}'

step "4. Carrier B speaks legacy: HTTP 200 errors, MM/DD vs YYYYMMDD, '\$1,284.6', limits in thousands"
SK=$(curl -s -X POST "$MOCK_B/PolicyService/Authenticate" -d 'UserName=JLEE&PassWord=Legacy%232025&ClientCode=CBRIDGE01' | jq -r .AuthenticateResult.SessionKey)
curl -s "$MOCK_B/PolicyService/GetPolicyList?SessionKey=$SK" | jq -c '.GetPolicyListResult.PolicyList.Policy[0] | {POL_NBR, EFF_DT, EXP_DT, TOT_PREM, COV: .COV_LIST.COV[0]}' || echo "(hit the deterministic 503; run again)"

step "5. ...and comes out normalized (cents, ISO dates, split limits, warnings)"
JORDAN=$(curl -s -X POST "$API/pulls" -H 'content-type: application/json' \
  -d '{"connections":[{"carrierId":"carrier-b","credentials":{"username":"JLEE","password":"Legacy#2025"}}]}' | jq -r .id)
wait_for_pull "$JORDAN"
curl -s "$API/pulls/$JORDAN" | jq -c '.carriers[0] | {carrierId, status, policyCount, recordWarnings: [.warnings[].code]}'
curl -s "$API/pulls/$JORDAN/policies?limit=10" | jq '.data[] | select(.policy.externalPolicyId == "BL-90311-02") | .policy
  | {externalPolicyId, effectiveDate, expirationDate, premium, firstCoverage: .coverages[0], vehicles, warnings: .source.warnings}'

step "6. Break things: Carrier A outage + bad Carrier B password"
curl -s -X POST "$MOCK_A/__control/faults" -H 'content-type: application/json' \
  -d '{"method":"GET","path":"/v1/policies","times":100,"action":{"type":"status","status":503}}' >/dev/null
BROKEN=$(curl -s -X POST "$API/pulls" -H 'content-type: application/json' -d "$(connections 'wrong-password')" | jq -r .id)
wait_for_pull "$BROKEN"
curl -s "$API/pulls/$BROKEN" | jq '{status, carriers: [.carriers[] | {carrierId, status, attempts, error: (.error | if . then {category, code, retryable} else null end)}]}'
curl -s -X POST "$MOCK_A/__control/reset" >/dev/null

step "7. Errors are RFC 9457 problems with request IDs"
curl -s "$API/pulls/00000000-0000-4000-8000-000000000000" -H 'X-Request-Id: demo-trace-1' | jq -c .

printf '\nSwagger UI: %s/docs\n' "$API"
