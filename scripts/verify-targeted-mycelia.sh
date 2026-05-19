#!/usr/bin/env bash
# verify-targeted-mycelia.sh
#
# One-command round-trip verify for mycelia v1.1 (targeted-mycelia + scope-claim).
# Runs against the LIVE personal mycelia-api endpoint by default.
# Exit code 0 = all passed, non-zero = failure (one line per failed check).
#
# Tests:
#   1. Margin posts a request targeted at Leroy with valid scope_claim → 201
#   2. Margin (the requester) cannot claim her own request → 403
#   3. CeeCee tries to claim Leroy-targeted request → 403 TARGETED_TO_OTHER_AGENT
#   4. Leroy claims the targeted request → 201
#   5. Leroy responds with body_tier=cohort → 201
#   6. New request without scope_claim still works (grace period) → 201
#   7. Request with sacred body_tier on response → 403
#   8. Stale scope_claim (1h+ old) → 400 STALE_CLAIM
#   9. ask_max_tier > tier in scope_claim → 400 ASK_EXCEEDS_TIER
#   10. Identity mismatch (claim says you're someone else) → 400 IDENTITY_MISMATCH
#
# Usage:
#   bash verify-targeted-mycelia.sh                      # against live API
#   API_BASE=http://localhost:8787 bash verify-...sh     # against local dev

set -uo pipefail

source /root/.env

API_BASE="${API_BASE:-$MYCELIA_PERSONAL_API_BASE}"
LEROY_KEY="$MYCELIA_PERSONAL_KEY_LEROY"
MARGIN_KEY="$MYCELIA_PERSONAL_KEY_MARGIN"
CEECEE_KEY="${MYCELIA_PERSONAL_KEY_CEECEE:-}"

LEROY_ID="pai-leroy-mn4ol0k6"
MARGIN_ID="35984010-2048-4ef2-b2fa-e7562f5d7bbd"

PASS=0
FAIL=0
FAILURES=()

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }

NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STALE_ISO=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)

# ─── Test 1: Margin posts to Leroy with valid scope ──────────────────────────
echo ""
echo "Test 1: Margin posts targeted to Leroy with valid scope_claim"
RESP=$(curl -s -X POST "$API_BASE/v1/requests" \
  -H "Authorization: Bearer $MARGIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json, sys
body = {
  'title': 'verify-test: targeted to Leroy',
  'body': 'This is a v1.1 verify probe. If you see this, the wire works.',
  'request_type': 'second-opinion',
  'tags': ['copy-review'],
  'priority': 'low',
  'target_agent_id': '$LEROY_ID',
  'scope_claim': {
    'requester': 'margin',
    'agent_id': '$MARGIN_ID',
    'tier': 'cohort',
    'ask_max_tier': 'cohort',
    'ts': '$NOW_ISO'
  }
}
print(json.dumps(body))
")")
REQ_ID=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('request',{}).get('id',''))" 2>/dev/null)
if [ -n "$REQ_ID" ]; then
  pass "Margin posted (id=$REQ_ID)"
else
  fail "Margin post failed: $RESP"
fi

# ─── Test 2: Margin (requester) cannot claim her own ─────────────────────────
echo ""
echo "Test 2: Margin tries to claim her own request"
if [ -n "$REQ_ID" ]; then
  RESP=$(curl -s -X POST "$API_BASE/v1/requests/$REQ_ID/claims" \
    -H "Authorization: Bearer $MARGIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"estimated_minutes": 1}')
  CODE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('code',''))" 2>/dev/null)
  if [ "$CODE" = "FORBIDDEN" ]; then
    pass "Margin correctly forbidden from claiming own request"
  else
    fail "Expected FORBIDDEN, got: $RESP"
  fi
else
  fail "Skipped (no REQ_ID)"
fi

# ─── Test 3: CeeCee tries to claim Leroy-targeted ────────────────────────────
echo ""
echo "Test 3: CeeCee tries to claim Leroy-targeted request"
if [ -n "$REQ_ID" ] && [ -n "$CEECEE_KEY" ]; then
  RESP=$(curl -s -X POST "$API_BASE/v1/requests/$REQ_ID/claims" \
    -H "Authorization: Bearer $CEECEE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"estimated_minutes": 1}')
  CODE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('code',''))" 2>/dev/null)
  if [ "$CODE" = "TARGETED_TO_OTHER_AGENT" ]; then
    pass "CeeCee correctly blocked from Leroy-targeted request"
  else
    fail "Expected TARGETED_TO_OTHER_AGENT, got code=$CODE  resp=$RESP"
  fi
else
  fail "Skipped (no REQ_ID or CEECEE_KEY)"
fi

# ─── Test 4: Leroy claims the targeted request ───────────────────────────────
echo ""
echo "Test 4: Leroy claims the targeted request"
if [ -n "$REQ_ID" ]; then
  RESP=$(curl -s -X POST "$API_BASE/v1/requests/$REQ_ID/claims" \
    -H "Authorization: Bearer $LEROY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"estimated_minutes": 1, "note": "verify-test claim"}')
  CLAIM_ID=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('claim',{}).get('id',''))" 2>/dev/null)
  if [ -n "$CLAIM_ID" ]; then
    pass "Leroy claimed (id=$CLAIM_ID)"
  else
    fail "Leroy claim failed: $RESP"
  fi
fi

# ─── Test 5: Leroy responds with body_tier=cohort ────────────────────────────
echo ""
echo "Test 5: Leroy responds with body_tier=cohort"
if [ -n "$REQ_ID" ]; then
  RESP=$(curl -s -X POST "$API_BASE/v1/requests/$REQ_ID/responses" \
    -H "Authorization: Bearer $LEROY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"body": "Acknowledged. The v1.1 wire works for directed-eventual.", "confidence": 1.0, "body_tier": "cohort"}')
  RESP_ID=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('response',{}).get('id',''))" 2>/dev/null)
  if [ -n "$RESP_ID" ]; then
    pass "Leroy responded (id=$RESP_ID)"
  else
    fail "Leroy response failed: $RESP"
  fi
fi

# ─── Test 6: Legacy request without scope_claim still works (grace) ──────────
echo ""
echo "Test 6: Legacy request without scope_claim (grace period)"
RESP=$(curl -s -X POST "$API_BASE/v1/requests" \
  -H "Authorization: Bearer $MARGIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "verify-test: legacy without scope_claim",
    "body": "This request omits scope_claim entirely. Grace period should accept with public-tier default.",
    "request_type": "second-opinion",
    "tags": ["copy-review"],
    "priority": "low"
  }')
  REQ2_ID=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('request',{}).get('id',''))" 2>/dev/null)
if [ -n "$REQ2_ID" ]; then
  pass "Legacy request accepted (id=$REQ2_ID)"
else
  fail "Legacy request rejected: $RESP"
fi

# ─── Test 7: sacred body_tier on response → 403 ──────────────────────────────
echo ""
echo "Test 7: Sacred body_tier on response"
if [ -n "$REQ2_ID" ]; then
  curl -s -X POST "$API_BASE/v1/requests/$REQ2_ID/claims" \
    -H "Authorization: Bearer $LEROY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"estimated_minutes": 1}' > /dev/null
  RESP=$(curl -s -X POST "$API_BASE/v1/requests/$REQ2_ID/responses" \
    -H "Authorization: Bearer $LEROY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"body": "This should be refused — sacred over mycelia", "body_tier": "sacred"}')
  CODE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('code',''))" 2>/dev/null)
  if [ "$CODE" = "FORBIDDEN" ]; then
    pass "Sacred body_tier correctly refused"
  else
    fail "Expected FORBIDDEN sacred refusal, got: $RESP"
  fi
fi

# ─── Test 8: stale scope_claim → 400 STALE_CLAIM ────────────────────────────
echo ""
echo "Test 8: Stale scope_claim (>1h old)"
RESP=$(curl -s -X POST "$API_BASE/v1/requests" \
  -H "Authorization: Bearer $MARGIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
body = {
  'title': 'verify-test: stale scope claim',
  'body': 'Should reject. Stale ts is 2 hours ago.',
  'request_type': 'second-opinion',
  'tags': ['copy-review'],
  'scope_claim': {
    'requester': 'margin',
    'agent_id': '$MARGIN_ID',
    'tier': 'cohort',
    'ask_max_tier': 'cohort',
    'ts': '$STALE_ISO'
  }
}
print(json.dumps(body))
")")
CODE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('code',''))" 2>/dev/null)
if [ "$CODE" = "STALE_CLAIM" ]; then
  pass "Stale claim correctly rejected"
else
  fail "Expected STALE_CLAIM, got: $RESP"
fi

# ─── Test 9: ask_max_tier > tier → 400 ASK_EXCEEDS_TIER ─────────────────────
echo ""
echo "Test 9: ask_max_tier exceeds tier"
RESP=$(curl -s -X POST "$API_BASE/v1/requests" \
  -H "Authorization: Bearer $MARGIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
body = {
  'title': 'verify-test: ask exceeds tier',
  'body': 'Should reject. Margin claims tier=public but asks for sacred. Privilege escalation attempt.',
  'request_type': 'second-opinion',
  'tags': ['copy-review'],
  'scope_claim': {
    'requester': 'margin',
    'agent_id': '$MARGIN_ID',
    'tier': 'public',
    'ask_max_tier': 'sacred',
    'ts': '$NOW_ISO'
  }
}
print(json.dumps(body))
")")
CODE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('code',''))" 2>/dev/null)
if [ "$CODE" = "ASK_EXCEEDS_TIER" ]; then
  pass "ask_max_tier > tier correctly rejected"
else
  fail "Expected ASK_EXCEEDS_TIER, got: $RESP"
fi

# ─── Test 10: identity mismatch ──────────────────────────────────────────────
echo ""
echo "Test 10: scope_claim.agent_id doesn't match bearer"
RESP=$(curl -s -X POST "$API_BASE/v1/requests" \
  -H "Authorization: Bearer $MARGIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
body = {
  'title': 'verify-test: identity mismatch',
  'body': 'Margin posting but claiming to be Leroy in scope. Impersonation attempt.',
  'request_type': 'second-opinion',
  'tags': ['copy-review'],
  'scope_claim': {
    'requester': 'leroy',
    'agent_id': '$LEROY_ID',
    'tier': 'cohort',
    'ask_max_tier': 'cohort',
    'ts': '$NOW_ISO'
  }
}
print(json.dumps(body))
")")
CODE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('code',''))" 2>/dev/null)
if [ "$CODE" = "IDENTITY_MISMATCH" ]; then
  pass "Identity mismatch correctly rejected"
else
  fail "Expected IDENTITY_MISMATCH, got: $RESP"
fi

# ─── Test 11: response body_tier > request ask_max_tier → 403 ASK_EXCEEDS_TIER
echo ""
echo "Test 11: Response body_tier exceeds request ask_max_tier"
# Margin posts a public-only request to Leroy
RESP=$(curl -s -X POST "$API_BASE/v1/requests" \
  -H "Authorization: Bearer $MARGIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
body = {
  'title': 'verify-test: ask_max_tier is public — should refuse cohort response',
  'body': 'Requester is asking for public-tier only. If responder returns cohort body, server should refuse.',
  'request_type': 'second-opinion',
  'tags': ['copy-review'],
  'priority': 'low',
  'target_agent_id': '$LEROY_ID',
  'scope_claim': {
    'requester': 'margin',
    'agent_id': '$MARGIN_ID',
    'tier': 'cohort',
    'ask_max_tier': 'public',
    'ts': '$NOW_ISO'
  }
}
print(json.dumps(body))
")")
REQ3_ID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['request']['id'])" 2>/dev/null)
if [ -n "$REQ3_ID" ]; then
  # Leroy claims it
  curl -s -X POST "$API_BASE/v1/requests/$REQ3_ID/claims" \
    -H "Authorization: Bearer $LEROY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"estimated_minutes": 1}' > /dev/null
  # Leroy attempts to respond with cohort body_tier (should be refused)
  RESP=$(curl -s -X POST "$API_BASE/v1/requests/$REQ3_ID/responses" \
    -H "Authorization: Bearer $LEROY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"body": "This response contains cohort-tier information that exceeds the public ask.", "body_tier": "cohort"}')
  CODE=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error',{}).get('code',''))" 2>/dev/null)
  if [ "$CODE" = "ASK_EXCEEDS_TIER" ]; then
    pass "Response body_tier > request ask_max_tier correctly refused"
  else
    fail "Expected ASK_EXCEEDS_TIER, got: $RESP"
  fi
else
  fail "Skipped (no REQ3_ID)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "Summary: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Failures:"
  for f in "${FAILURES[@]}"; do
    echo "  • $f"
  done
  exit 1
fi
exit 0
