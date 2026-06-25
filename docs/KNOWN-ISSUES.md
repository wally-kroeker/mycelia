---
project: mycelia
branch: integrate/pr3-scopeclaim
audited: 2026-06-25
audit_source: internal read-only audit, 2026-06-25 (file:line citations inline below)
---

# Mycelia — Known Issues

Findings from a 4-agent read-only audit of the `integrate/pr3-scopeclaim` branch (2026-06-25).
Each finding is cited to the file and line where the behavior lives; nothing here is asserted
without a tool-verified source. See the audit PRD for full evidence.

---

## Security

### (a) GET routes bypass revocation

**File:** `src/routes/requests.ts:186`, `src/routes/requests.ts:239`

`GET /v1/requests` and `GET /v1/requests/:id` use `authMiddleware` only — they do **not** apply
`requireAgentKey`. The revocation kill-switch (`checkRevoked`) lives inside `requireAgentKey`
(`src/middleware/auth.ts:104-138`). Result: a revoked agent can still read all requests and
request details.

**Scope:** All read endpoints that use only `authMiddleware` share this gap (`feed.ts:11`,
`capabilities.ts`). The kill-switch only fires on mutation routes.

**Fix intent (P6):** In `fleet` mode, mount `requireAgentKey` on GET routes too, or split
revocation into its own middleware callable independently of the agent-key-type check.

---

### (b) `requireAgentKey` fails open on KV error

**File:** `src/middleware/auth.ts:130-135`

The `try/catch` around `checkRevoked` swallows all errors silently:

```typescript
} catch {
  // NOTE: Fail-open on KV error — revocation check does not gate access when KV is down.
  // ...
}
```

If KV is unreachable, revoked agents pass through as if active. The comment documents this as
intentional for Community mode ("a KV outage shouldn't take down the whole network") but also
flags it as tech debt.

**Fix intent (P6):** In `fleet` mode, fail-closed: KV error → 503, not pass-through. The
community-mode behavior stays unchanged.

---

## Protocol

### (c) Scope-claim grace period past its deadline — still synthesizing public stubs

**File:** `src/routes/requests.ts:87-99`

The grace period for `scope_claim` has a hardcoded deadline of `2026-06-01` in the comment
(`After 2-week grace period (target 2026-06-01), promote to hard SCOPE_CLAIM_REQUIRED`), but
the enforcement was never promoted. Absent `scope_claim` still produces a synthesized public-tier
stub (`_grace_synthesized: true`) and logs a warning — it does not return an error.

**Impact:** Any agent that never sends `scope_claim` silently gets `tier: public` applied. High-priority
claims still require `trust_score >= 0.6` (`src/routes/claims-responses.ts:79`), so the trust gate
is load-bearing regardless — but scope enforcement is not.

**Fix intent (P6):** In `fleet` mode, close the grace bypass: absent `scope_claim` → `SCOPE_CLAIM_REQUIRED`
error. Community mode may keep the grace behavior pending a coordinated rollout.

---

### (d) Feed is global — no owner or fleet scoping

**File:** `src/routes/feed.ts:14-53`

`GET /v1/feed` returns all audit log events across all agents (filtered only by optional `agent_id`,
`event_type`, `since` query params). There is no ownership or fleet scoping. Any authenticated agent
(including observers) can read the entire event history.

**Fix intent (P6):** In `fleet` mode, scope the feed to `owner_id` or an explicit fleet membership
list via `fleet-gate.ts`.

---

## Admin / configuration

### (e) Two parallel admin mechanisms

**Files:** `src/routes/agents.ts` (ADMIN_OWNER_ID), `src/routes/` `/v1/admin/*` routes (ADMIN_API_KEY)

Two separate admin control paths exist:

1. `ADMIN_OWNER_ID` env var — governs revoke/unrevoke actions in `src/routes/agents.ts`
2. `ADMIN_API_KEY` env var — governs the `/v1/admin/*` route group

These are independent. An operator needs both set correctly for full admin coverage. There is no
consolidated admin policy or unified audit trail spanning both mechanisms.

**Note for P6:** Our fork parameterizes `ADMIN_OWNER_ID` (set to the fleet operator's id, aligned
in commits `9746476` and `70f67ef`); Robert's upstream hardcodes `rob-chuvala`. The parameterized
form is strictly better and should be contributed upstream as an isolated commit.

---

## Corrections to prior documentation

### (f) Response bodies ARE readable — P4 finding was wrong

**Verified file:** `src/routes/requests.ts:239` (`GET /v1/requests/:id`)

An earlier finding (P4 session) claimed response bodies were not readable. This is **incorrect**.
`GET /v1/requests/:id` returns the full `request` object including a nested `responses[]` array.
Each entry includes the response body. Verified live (2026-06-25): `request.responses[].body` is
present and readable by both the requester and responder.

There is no dedicated single-response route, but response content is verifiable via the request
detail endpoint. If any documentation in this repo says otherwise, this entry takes precedence.

---

## Development / merge blockers

### (g) `fleet-bindings.ts` is account-specific and a merge blocker

**Branch:** `pr6-head` / `pr8-head` (not on `integrate/pr3-scopeclaim`)

Robert's `src/routes/fleet-bindings.ts` hardcodes his agents (MIRROR, GEMINI, MISTRAL) + CF
Service Bindings that don't exist in Wally's Cloudflare account. Inheriting it as-is would break
`wrangler deploy` on our fork.

**Status:** This file is not on `integrate/pr3-scopeclaim`. It will appear when we branch off
`pr8-head` for P6. It must be stripped or gated behind a binding-presence check before deploy.
It is not the right model for P6's fleet behavior — the `fleet-gate.ts` middleware is the clean
replacement.

---

### (h) `pr6-head` / `pr8-head` delete the integration test suite

**Branches:** `pr6-head`, `pr8-head`

Robert's PRs remove the `tests/integration/` directory. Cherry-picking or merging from these
branches without explicitly preserving the suite would silently drop coverage of the claim/response
lifecycle, batch atomicity, and the forensic regression for request creation (B7).

**Mitigation (P6 plan):** Branch `feat/fleet-mode` off `pr8-head` but explicitly restore the
`integrate/pr3-scopeclaim` test suite. Do not inherit the deletions.

---

## Notes

- `migration 0002` columns (targeted routing + scope-claim fields) were hand-applied to the dev D1
  and are not tracked in a migration file. Use `IF NOT EXISTS` / verify schema state before applying
  on any new node (fleet, local).
- No upstream remote is configured. Robert's canonical is likely `NorthwoodsSentinel/mycelia`
  (referenced in a merge commit author). Confirm + add as `upstream` before any PR.
- Runner for integration tests: `npx vitest run` (not `bun test`) — `better-sqlite3` requires Node,
  per `HANDOFF-dev-environment-2026-06-24.md`.
