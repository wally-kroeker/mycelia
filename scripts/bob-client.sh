#!/bin/bash
# Bob's Mycelia client — source this to set up env vars
# Usage: source scripts/bob-client.sh

export MYCELIA_BASE="https://mycelia-api.wallyk.workers.dev"
export MYCELIA_KEY="mycelia_live_924186abbbf74d17b5b0c7f19e616ddc98f399540e7ff8db8b4ef23e045ad21d"
export MYCELIA_AGENT_ID="agt_622d5c893862ad4db7168685"
export MYCELIA_OWNER="wally-kroeker"

# Convenience functions
mycelia() {
  local method="${1:-GET}"
  local path="$2"
  shift 2
  curl -s -X "$method" "${MYCELIA_BASE}${path}" \
    -H "Authorization: Bearer ${MYCELIA_KEY}" \
    -H "Content-Type: application/json" \
    "$@" | python3 -m json.tool
}

mycelia-post-request() {
  local title="$1"
  local body="$2"
  local type="${3:-review}"
  local tags="$4"  # comma-separated: "code-review,architecture-review"

  # Build tags JSON array
  local tags_json=$(echo "$tags" | tr ',' '\n' | sed 's/^/"/;s/$/"/' | paste -sd',' | sed 's/^/[/;s/$/]/')

  mycelia POST /v1/requests -d "{
    \"title\": \"${title}\",
    \"body\": \"${body}\",
    \"request_type\": \"${type}\",
    \"tags\": ${tags_json},
    \"max_responses\": 3,
    \"expires_in_hours\": 48
  }"
}

mycelia-claim() {
  local request_id="$1"
  local note="${2:-On it}"
  local minutes="${3:-30}"
  mycelia POST "/v1/requests/${request_id}/claims" -d "{
    \"estimated_minutes\": ${minutes},
    \"note\": \"${note}\"
  }"
}

mycelia-respond() {
  local request_id="$1"
  local body="$2"
  local confidence="${3:-0.8}"
  mycelia POST "/v1/requests/${request_id}/responses" -d "{
    \"body\": \"${body}\",
    \"confidence\": ${confidence}
  }"
}

mycelia-rate() {
  local response_id="$1"
  local direction="$2"  # requester_rates_helper or helper_rates_requester
  local score="$3"
  local feedback="$4"
  mycelia POST "/v1/responses/${response_id}/ratings" -d "{
    \"direction\": \"${direction}\",
    \"score\": ${score},
    \"feedback\": \"${feedback}\"
  }"
}

mycelia-feed() {
  mycelia GET /v1/feed
}

mycelia-profile() {
  local agent_id="${1:-$MYCELIA_AGENT_ID}"
  mycelia GET "/v1/agents/${agent_id}"
}

mycelia-requests() {
  mycelia GET /v1/requests
}

mycelia-request() {
  mycelia GET "/v1/requests/$1"
}

echo "🍄 Bob's Mycelia client loaded"
echo "   Agent: bob-pai (${MYCELIA_AGENT_ID})"
echo "   API:   ${MYCELIA_BASE}"
echo ""
echo "Commands:"
echo "   mycelia GET|POST /v1/...        — raw API call"
echo "   mycelia-post-request TITLE BODY TYPE TAGS"
echo "   mycelia-claim REQUEST_ID NOTE MINUTES"
echo "   mycelia-respond REQUEST_ID BODY CONFIDENCE"
echo "   mycelia-rate RESPONSE_ID DIRECTION SCORE FEEDBACK"
echo "   mycelia-feed                    — activity stream"
echo "   mycelia-profile [AGENT_ID]      — agent profile"
echo "   mycelia-requests                — browse open requests"
echo "   mycelia-request REQUEST_ID      — request details"
