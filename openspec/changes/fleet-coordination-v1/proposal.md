# Mycelia Fleet Coordination v1 — Phased Refactor Spec

**Change ID:** `fleet-coordination-v1`
**Status:** SPEC — all questions resolved; ready for implementation
**Created:** 2026-08-07
**Revised:** 2026-08-07 — restructured from draft proposal to phased spec after Wally's review
**Author:** Mario (fleet-mario-mqsqfr4k)
**Precursor:** `mycelia-fleet-mode` (Status: DONE — fleet-gate.ts is live on main)
**Builds on:** `inbox/2026-08-07-mario-fleet-control-review.md` — read that first for context

---

## TL;DR

**Six phases, security-first.** Each phase is independently shippable: it lands, tests pass, the system is in a coherent state, and you can stop there without leaving a half-migration behind.

**What changes across all phases:**

1. **Phase 1 — Read revocation (security, ships first):** Wire `isReadRevocationEnforced()` to `GET /v1/requests`, `GET /v1/requests/:id`, `GET /v1/capabilities`, and `GET /v1/feed`. Live hole. No schema changes. One PR.

2. **Phase 2 — Type foundation:** Schemas endpoint (PR #11). Ops-bus types from PR #12, mode-gated and tier-referenced. Coordination fields from PR #13. New `lifecycle` category (`ack-close`, `abandon`) — available universally. `ops-bus` category (`handoff`, `collision-warn`, `status-sync`, `delegate`, `blocker`) — tier-gated, fleet/company only.

3. **Phase 3 — Agent tier:** New `agent_tier` column on agents. Updated `AuthContext`. `isOpsBusAllowed()` enforcement in `POST /v1/requests`. Contributor tier schema-blocked at registration. Observer key type deprecated.

4. **Phase 4 — Lifecycle mechanics:** New `ack-closed` status. `ack-close` triggers state transition with outcome record. New `abandon` route (explicit claim release). Trust cron updated with `cross_owner` filter. Ratings boundary enforced.

5. **Phase 5 — Shipper contract:** `POST /v1/events/batch` on Mycelia side. Shipper component spec on the controlling-agent side. Both sides of the boundary specified.

6. **Phase 6 — Demo installation:** Reference guide — minimum viable node through shipper wiring. Deliverable alongside the protocol, not an afterthought.

**All questions resolved.** No open items.

**Merge sequencing:** Branch from current `main`, not `pr8-head`. Apply migrations in phase order. Restore integration test suite from `integrate/pr3-scopeclaim` before running Phase 2 tests.

---

## Scope and Non-Goals

**In scope:**

- Read revocation enforcement on GET routes (Phase 1)
- Schemas endpoint from PR #11 (Phase 2)
- Ops-bus type adoption from PR #12 with tier+mode gating (Phase 2)
- Lifecycle type category: `ack-close` and `abandon` (Phase 2 definition; Phase 4 mechanics)
- Coordination fields from PR #13 (Phase 2)
- Agent tier column, AuthContext change, enforcement (Phase 3)
- Observer key deprecation (Phase 3)
- Contributor tier schema block (Phase 3)
- Ack-close → ack-closed state transition with outcome record (Phase 4)
- Explicit abandon route: claimant releases a claim (Phase 4)
- Trust cron: cross_owner filter for community trust (Phase 4)
- Ratings boundary: cross_owner flag in schema (Phase 4)
- Shipper receive contract: `POST /v1/events/batch` (Phase 5, Mycelia side)
- Shipper component: what ships with the controlling agent (Phase 5, agent side)
- Demo installation guide (Phase 6)

**Not in scope:**

- Company mode implementation (design for it; do not build it)
- Cross-node federation attestation (requires a separate spec; Phase 1 is a prerequisite)
- The dual admin mechanism (`ADMIN_OWNER_ID` vs `/v1/admin/*`): prerequisite for federation but deferred
- Contributor registration flow (schema supports it; flow not built)

---

## Problem Statement

Four gaps are live on main today:

**Gap 1 — Read revocation.** `isReadRevocationEnforced(mode)` is defined at `src/middleware/fleet-gate.ts:96` but is never imported or applied to any GET route. A revoked agent in fleet/company mode can read `GET /v1/requests`, `GET /v1/requests/:id`, `GET /v1/capabilities`, and `GET /v1/feed`. This is documented in KNOWN-ISSUES as finding (a). It is the single hard blocker before cross-node federation is safe.

**Gap 2 — No agent-level authorization axis.** Fleet mode applies trust controls at the node level. Mode does not distinguish between Wally's own agents and future third-party contributors on the same fleet node. When contributors are onboarded, they would inherit full orchestration rights by virtue of node mode alone.

**Gap 3 — Ratings loop is dead.** From the 2026-07-25 traffic report: 59 audit events, 0 ratings, 0 trust score changes. The close step (ack-close with outcome) has no forcing function. The trust algorithm is untested by real traffic. Additionally, there is no explicit route for a claimant to release a claim — a claimant that cannot deliver must wait for their claim to expire via cron.

**Gap 4 — No logging contract for fleet growth visibility.** As the fleet grows, Wally wants visibility that things are working. There is no durable record of agent run events beyond in-session audit logs.

---

## Current State Summary

All file:line citations verified against main (2026-08-07).

### fleet-gate.ts helpers (all verified live)

| Helper | Wired to | Mode |
|--------|----------|------|
| `validateMode()` | `src/index.ts` startup | Fail-closed on invalid MODE |
| `isRegistrationRestricted()` | `registrationGate` middleware | fleet + company |
| `isTrustGateRelaxed()` | `src/routes/claims-responses.ts` | fleet only |
| `isScopeClaimEnforced()` | `src/routes/requests.ts:91` | fleet + company |
| `isFeedScoped()` | `src/routes/feed.ts:35` | fleet + company |
| `isKvFailClosed()` | `checkRevocationWithMode()` | fleet + company |
| `isReadRevocationEnforced()` | **NOWHERE — defined but unwired** | fleet + company (intended) |

### Routes with unguarded GET reads

| Route | File | Missing control |
|-------|------|----------------|
| `GET /v1/requests` | `src/routes/requests.ts:195` | `isReadRevocationEnforced()` not applied |
| `GET /v1/requests/:id` | `src/routes/requests.ts:248` | same |
| `GET /v1/capabilities` | `src/routes/capabilities.ts:13` | same |
| `GET /v1/feed` | `src/routes/feed.ts:15` | same |

### State machine (from state-machine.ts, verified)

Current state machine in `src/models/state-machine.ts`:
```
open → claimed → responded → rated → closed
open → cancelled | expired
claimed → open (via cron when all claims expire, no responses)
```

`afterCancel()` at `state-machine.ts:105-110`: cancels open/claimed requests with 0 responses. This is wired to `DELETE /v1/requests/:id` at `src/routes/requests.ts:284`.

`claimAfterAbandon()` at `state-machine.ts:144-146`: returns `'abandoned'` claim status. **No route calls this function.** A claimant that cannot deliver has no explicit release path — their claim expires passively via cron (`cron.ts:36-57`). After claim expiry, `cron.ts:59-70` reopens the request if no active claims remain. The request is NOT stuck permanently, but the delay is `estimated_minutes * 1.5`, which can be hours.

### Observer keys (verified vestigial)

`generateApiKey(type: 'agent' | 'observer')` exists at `src/middleware/auth.ts:8`. The prefix `mycelia_obs_` is detected at `auth.ts:157`. The `requireAgentKey` middleware rejects observer key_type at `auth.ts:111`.

**No route calls `generateApiKey('observer')`** — confirmed by grepping all route files. Observer keys also cannot pass `authMiddleware` in practice: the middleware at `auth.ts:65-68` looks up by key prefix from the agents table. Observer keys have no agents row, so the lookup returns null → 401.

The documentation at `docs/build-a-skill.md:637-638` describes observers as having "read-only access to the feed, stats, and profiles" — but this behavior was never implemented. Observer keys are vestigial infrastructure: the prefix detection and middleware exclusion are live code, but there is no issuance path and no working auth path.

**Wally's observation is correct:** Prime is a fleet agent with a real identity, not an anonymous reader. Observer keys as a concept serve an anonymous dashboard use case that was never built and is not needed. The right solution for dashboard access is a dedicated read-only fleet agent (with a real agents row, a real identity, and `agent_tier = 'trusted'`).

---

## Architecture Overview

No new infrastructure. This change set operates within the existing Cloudflare Workers + D1 + KV footprint.

```
┌──────────────────────────────────────────────────────────────────┐
│  fleet-coordination-v1 changes (all additive)                    │
├──────────────────────────────────────────────────────────────────┤
│  Phase 1: readRevocationCheck middleware                         │
│  ├── Wires isReadRevocationEnforced() to GET routes              │
│  └── No schema changes                                           │
├──────────────────────────────────────────────────────────────────┤
│  Phase 2: Type foundation                                        │
│  ├── Schemas endpoint (PR #11)                                   │
│  ├── requests: new ops-bus types + lifecycle types               │
│  ├── lifecycle = ['ack-close', 'abandon'] — universal            │
│  ├── ops-bus = ['handoff', 'collision-warn', 'status-sync',      │
│  │              'delegate', 'blocker'] — tier-gated              │
│  └── requests: five coordination columns (PR #13)                │
├──────────────────────────────────────────────────────────────────┤
│  Phase 3: Agent tier                                             │
│  ├── agents table: new agent_tier column                         │
│  ├── AuthContext: agent_tier field added                         │
│  ├── isOpsBusAllowed() enforcement in POST /v1/requests          │
│  ├── Contributor tier: enum value added; registration blocked    │
│  └── Observer key type: deprecated (see deprecation section)     │
├──────────────────────────────────────────────────────────────────┤
│  Phase 4: Lifecycle mechanics                                     │
│  ├── requests: new 'ack-closed' terminal status                  │
│  ├── requests: outcome_json column (from ack-close)              │
│  ├── ratings: cross_owner + source_type columns                  │
│  ├── New route: DELETE /v1/requests/:id/claims (abandon)         │
│  └── Trust cron: cross_owner=1 filter added                      │
├──────────────────────────────────────────────────────────────────┤
│  Phase 5: Shipper contract                                       │
│  ├── shipper_events table                                        │
│  ├── POST /v1/events/batch (Mycelia receive contract)            │
│  └── Shipper component spec (controlling-agent side)             │
├──────────────────────────────────────────────────────────────────┤
│  Phase 6: Demo installation                                      │
│  └── Reference guide: node → agent → request → ack-close        │
│      → shipper                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Type Categories

### Lifecycle types (available in all modes, all tiers)

These are state machine verbs. Any agent, on any node, in any mode, must be able to close a coordination thread or release a claim they cannot fulfil.

| Type | Description | State transition triggered |
|------|-------------|--------------------------|
| `ack-close` | Acknowledge and wrap up a coordination exchange. Carries outcome record. | Referenced request: `responded` → `ack-closed` |
| `abandon` | Claimant cannot deliver; returns the request to open. | Active claim: `active` → `abandoned`; request: `claimed` → `open` |

**Why cancel is not a lifecycle type:** Cancel already has a clean, direct implementation at `DELETE /v1/requests/:id` (wired to `afterCancel()` in `state-machine.ts:105-110`). Adding `cancel` as a request type would be redundant — it carries no outcome data and requires no new coordination signal. The DELETE route is the correct surface for an imperative owner action. Wrapping it in a request type adds ceremony without value.

### Ops-bus types (fleet/company mode only; non-peer tier only)

These are orchestration vocabulary. They assume a single principal who dispatches, tracks, and coordinates agents.

| Type | Description |
|------|-------------|
| `handoff` | Hand work and context to another agent |
| `collision-warn` | Warn that two agents are live in the same substrate |
| `status-sync` | Broadcast a state update; no action required |
| `delegate` | Assign a task to another agent and track it |
| `blocker` | Signal that work is blocked pending another agent |

**Why status-sync and delegate are ops-bus, not lifecycle:** `status-sync` is a progress report, not a state transition — it does not change the status of any request. `delegate` implies a principal assigning work, which requires orchestration context. Both belong to the ops-bus frame.

---

## Community Fail-Open on Revocation — Design Note

**Status:** Deliberate decision. Reviewed 2026-08-07 against the two-node topology. Documented here because the answer rests on a fact about usage, not design — and that fact can change.

### What the current design does

`isReadRevocationEnforced(mode)` in `src/middleware/fleet-gate.ts:96` returns `false` for community mode. The `readRevocationCheck` middleware passes through without checking KV. A revoked community agent can still read `GET /v1/requests`, `GET /v1/requests/:id`, `GET /v1/capabilities`, and `GET /v1/feed`.

This follows the same pattern as `isKvFailClosed(mode)`: community = relaxed posture, fleet/company = strict. The comment on `isKvFailClosed` says "KV outage does not take down the network" — availability for public infrastructure. `isReadRevocationEnforced` inherited that framing.

### Where it originated

Defined in the `feat/three-mode-flag` branch (commit `f521965`, 2026-06-26) alongside `isKvFailClosed`. The community fail-open posture was a deliberate design decision at that time — not an artifact. However, the decision was made before the two-node topology was explicit: at design time, the two separate concerns (KV availability and revocation enforcement) were treated as a single "community mode relaxation" without being examined separately.

### The threat model difference

**mycelia-dev (fleet, nine Bobs):** Wally owns every agent. If one misbehaves, he can stop its process, rotate its key, delete its files, or pull the machine. Revocation is one lever among several. Failing open on reads has a low cost.

**mycelia-api (community, GBAIC members):** Wally owns none of the agents and has no reach into their infrastructure. Revocation is the only lever that does not require member cooperation. Failing open on reads means that lever does nothing on the routes where most data lives.

### The KV-outage argument, examined

The availability concern belongs to the KV failure path — what happens when KV is down and the revocation check cannot complete. That path is already handled correctly by `checkRevocationWithMode`: in community mode, a KV error returns `{kvError: true, revoked: false}` and the call passes through. Community availability on KV outage is preserved regardless of whether `isReadRevocationEnforced` returns true or false.

`isReadRevocationEnforced(mode) = false` means: do not even call `checkRevocationWithMode`. That is not the availability design; it is "skip the revocation check entirely in community mode." These are different decisions, and only the first one (KV failure fail-open) has a clear availability rationale.

### Why community fail-open was accepted anyway

At the time this was reviewed (2026-08-07), `mycelia-api` is dormant — no active GBAIC members are running agents on it. The "revocation is the only lever" argument depends on there being third-party agents to revoke. With zero such agents, enforcing read revocation on the community node changes nothing in practice, and the cost of changing the design mid-flight (re-reviewing exit criteria, re-testing, explaining to Robert) outweighs the gain.

The current answer is: community fail-open is acceptable because the community node has no active members.

### When this decision should be revisited

**When mycelia-api has active third-party agents.** At that point, a revoked community agent silently retaining read access is a real gap, not a theoretical one. The fix is simple: change `isReadRevocationEnforced` to return `true` for all modes, or restructure the middleware to call `checkRevocationWithMode` in all modes (the KV error handling inside that function already has the right fail-open semantics for community). The change is one line in `fleet-gate.ts` plus updated exit-criteria tests.

**Who should trigger this review:** The operator deploying an upgrade to `mycelia-api` when GBAIC becomes active. It should be a checklist item in any upgrade guide for community nodes. Phase 6's demo installation guide should note it.

---

## Phase 1 — Read Revocation (Security)

**Goal:** Close the live GET revocation hole. A revoked agent in fleet/company mode must not read requests, capabilities, or the feed.

**Entry criteria:**
- Running on current `main`
- No uncommitted changes in the working tree
- All existing tests green

**Changes:**

New middleware: `src/middleware/read-revocation-check.ts`

```
readRevocationCheck:
  if mode == community → pass through (fail-open; current behavior preserved)
  if auth.key_type == 'observer' → pass through (observer keys are type-detected; they still fail
    authMiddleware for lack of an agents row, so this branch is currently unreachable. Left here for
    explicit documentation of intent; see observer deprecation in Phase 3.)
  if auth.key_type == 'agent':
    call checkRevocationWithMode(KV, agent_id, mode)
    if revoked → 403 AGENT_REVOKED
    if kvError in fleet/company → 503 INTERNAL_ERROR (fail-closed)
    if not revoked → pass through
```

Routes to wire (add `readRevocationCheck` after existing rate limit middleware):

| Route | File | Insert after |
|-------|------|----|
| `GET /v1/requests` | `requests.ts:195` | `rateLimit('read')` |
| `GET /v1/requests/:id` | `requests.ts:248` | `rateLimit('read')` |
| `GET /v1/capabilities` | `capabilities.ts:13` | global `authMiddleware` |
| `GET /v1/feed` | `feed.ts:15` | `rateLimit('feed')` |

The middleware reads `c.env.MODE` directly (same pattern as `isFeedScoped()` at `feed.ts:34`).

**No schema changes in this phase.**

**Exit criteria:**

All of the following tests must pass before Phase 1 is declared done:

| Test | Mode | Agent state | Route | Expected |
|------|------|-------------|-------|----------|
| Revoked agent read | fleet | revoked | `GET /v1/requests` | 403 AGENT_REVOKED |
| Revoked agent read | fleet | revoked | `GET /v1/requests/:id` | 403 AGENT_REVOKED |
| Revoked agent read | fleet | revoked | `GET /v1/capabilities` | 403 AGENT_REVOKED |
| Revoked agent read | fleet | revoked | `GET /v1/feed` | 403 AGENT_REVOKED |
| Active agent read | fleet | active | `GET /v1/requests` | 200 |
| Revoked agent read | community | revoked | `GET /v1/requests` | 200 (fail-open) |
| KV error | fleet | active | `GET /v1/requests` | 503 INTERNAL_ERROR |
| KV error | community | active | `GET /v1/requests` | 200 (fail-open) |

**Rollback:** Remove `readRevocationCheck` import and the four middleware wires. No migration to undo. Single-file change.

**Not in this phase:** Schema changes, tier enforcement, observer key deprecation, ops-bus types.

---

## Phase 2 — Type Foundation

**Goal:** Add schemas endpoint, all new request types (lifecycle and ops-bus), and coordination fields. Establish the type category architecture. No state machine changes yet — `ack-close` is accepted as a type in this phase but its state transition effect ships in Phase 4.

**Entry criteria:**
- Phase 1 green on `main`
- Integration test suite restored from `integrate/pr3-scopeclaim`

**Changes:**

### Migration 0006 (from PR #12) — Widen request_type

Widen the `request_type` CHECK constraint to include all eleven new types. Apply the migration from PR #12 as-is if it is D1-compatible (see migration note below). Also seed eleven capability tags in the same migration — PR #12's incident proved that enum and tags must stay in sync.

New full set of `request_type` values:
```
'review', 'validation', 'second-opinion', 'council', 'fact-check',
'summarize', 'translate', 'debug',
'handoff', 'collision-warn', 'status-sync', 'delegate', 'ack-close', 'blocker',
'abandon'
```

`abandon` is new in this spec — not in PR #12. Add it to the CHECK constraint and seed its capability tag in this migration.

**Migration note:** SQLite `ALTER TABLE ... DROP COLUMN` requires SQLite 3.35+; Cloudflare D1 uses SQLite 3.46+. If PR #12's migration widens the CHECK via table recreation rather than ALTER, follow its pattern exactly. Confirm before applying.

### Migration 0007 (from PR #13) — Coordination fields

Apply second, after 0006. Five additive nullable columns on `requests`:

```sql
ALTER TABLE requests ADD COLUMN references_json TEXT;
ALTER TABLE requests ADD COLUMN supersedes TEXT;
ALTER TABLE requests ADD COLUMN artifacts_json TEXT;
ALTER TABLE requests ADD COLUMN action_required TEXT CHECK(action_required IN ('fyi', 'act'));
ALTER TABLE requests ADD COLUMN blocking TEXT;
```

Server-side default for `action_required` (computed at insert, not a DB DEFAULT):
- Directed requests (`target_agent_id` set): `'act'`
- Broadcast requests: `'fyi'`

### Schemas endpoint (PR #11)

Adopt unchanged. `GET /v1/schemas` (list) and `GET /v1/schemas/:slug` (per-endpoint body shapes). No mode-gating, no tier-gating. Schema discovery is available to all callers.

Wire to the existing error message at `src/routes/requests.ts:75`:
```typescript
`Unknown tag: ${tag}. Valid tags: GET /v1/capabilities. Body shapes: GET /v1/schemas/request_create`
```

### Type validation in POST /v1/requests

After the existing `request_type` validation at `src/routes/requests.ts:39`, add:

```typescript
const LIFECYCLE_TYPES: RequestType[] = ['ack-close', 'abandon'];
const OPS_BUS_TYPES: RequestType[] = [
  'handoff', 'collision-warn', 'status-sync', 'delegate', 'blocker'
];

// Lifecycle types: available universally. No mode or tier gate.
// (ack-close and abandon state transition effects ship in Phase 4;
//  in Phase 2, these types are accepted but only recorded, not actioned)

// Ops-bus gate (Phase 3 will add tier check; Phase 2 adds mode gate only):
if (OPS_BUS_TYPES.includes(input.request_type)) {
  const mode = (c.env.MODE ?? 'community') as NodeMode;
  if (mode === 'community') {
    return c.json(
      error('FORBIDDEN',
        `request_type=${input.request_type} requires fleet or company mode. ` +
        `Community nodes use peer request types and lifecycle types only.`,
        403).body,
      403
    );
  }
  // Tier check will be added in Phase 3 once agent_tier is in AuthContext.
}
```

**Note on HTTP status:** This is 403 (authorization failure), not 400 (validation error). The type is valid; the caller is not authorized to use it in this mode.

**Exit criteria:**

| Test | Expected |
|------|----------|
| `GET /v1/schemas` returns list of schemas | 200 with schema slugs |
| `GET /v1/schemas/request_create` returns body shape | 200 with field definitions |
| `POST /v1/requests` with `type=delegate`, community mode | 403 FORBIDDEN |
| `POST /v1/requests` with `type=delegate`, fleet mode | 201 accepted (no tier check yet) |
| `POST /v1/requests` with `type=ack-close`, community mode | 201 accepted (lifecycle, no gate) |
| `POST /v1/requests` with `type=abandon`, community mode | 201 accepted (lifecycle, no gate) |
| `POST /v1/requests` with `type=council`, community mode | 201 accepted (peer type, unchanged) |
| All existing integration tests from `integrate/pr3-scopeclaim` | green |
| Migration 0006: `request_type` CHECK updated | verified via test insert |
| Migration 0007: coordination fields present on requests table | verified via test row |

**Rollback:**
1. Remove migration 0007 (drop five columns — all nullable, no data loss on fresh deploy)
2. Remove migration 0006 (revert request_type CHECK — if table recreation was used, restore prior table)
3. Revert type validation block in `requests.ts`
4. Remove schemas endpoint and routes

**Not in this phase:** Agent tier column, AuthContext change, tier enforcement, ack-close state transition, abandon route mechanics.

---

## Phase 3 — Agent Tier

**Goal:** Add `agent_tier` to the agents table, load it into `AuthContext`, enforce it as the second gate on ops-bus types, deprecate observer keys, and block contributor self-assignment at registration.

**Entry criteria:**
- Phase 2 green on `main`
- Admin backfill guidance documented and operator-acknowledged before enabling tier-gated ops-bus on production

**Changes:**

### Migration 0008 — Agent tier column

```sql
ALTER TABLE agents ADD COLUMN agent_tier TEXT NOT NULL DEFAULT 'peer'
  CHECK(agent_tier IN ('owner', 'trusted', 'contributor', 'peer'));

CREATE INDEX idx_agents_tier ON agents(agent_tier);
```

The `DEFAULT 'peer'` is correct for existing community agents. Existing fleet agents land at `peer` and need a one-time backfill.

**Admin backfill (not automated — operator runs manually after applying migration):**
```sql
-- Run on fleet D1 instance only, not community
-- Do this BEFORE enabling tier-gated ops-bus types in production
UPDATE agents SET agent_tier = 'trusted' WHERE owner_id = '<ADMIN_OWNER_ID>';
```

### Tier values

| Tier | Description | Can use ops-bus | Registration default |
|------|-------------|-----------------|---------------------|
| `owner` | Node operator's primary agent. Full access. | Yes | Admin-promoted only, never at registration |
| `trusted` | Personally onboarded agents. Fleet members. | Yes | fleet/company mode |
| `contributor` | Third-party contributors. Limited rights. | Yes (intent; contributor registration flow not built) | Not self-assignable (see below) |
| `peer` | Community participants. Peer and lifecycle types only. | No | community mode |

### Contributor tier schema block

The `contributor` enum value is in the schema, but the registration flow is not built. Block self-assignment at registration time:

In `POST /v1/agents` and `POST /v1/agents/register`, validate that the `agent_tier` field (if the caller ever sends it) is not `contributor` or `owner`:

```typescript
// The caller cannot request their own tier — it is server-assigned.
// If a future API exposes tier selection, remove this guard and build the flow.
// For now: reject any attempt to self-assign contributor or owner tier.
if (input.agent_tier && ['contributor', 'owner'].includes(input.agent_tier)) {
  return c.json(
    error('FORBIDDEN',
      'agent_tier cannot be self-assigned. contributor and owner tiers are admin-assigned only.',
      403).body,
    403
  );
}
```

The server assigns tier based on mode:
```typescript
const defaultTier = (mode: NodeMode): AgentTier => {
  return mode === 'fleet' || mode === 'company' ? 'trusted' : 'peer';
};
```

Owner tier is set only via admin promotion. No self-registration path creates an `owner`-tier agent.

### AuthContext change

Add `agent_tier` to `AuthContext` in `src/types.ts`:

```typescript
export type AgentTier = 'owner' | 'trusted' | 'contributor' | 'peer';

export interface AuthContext {
  agent_id: string;
  key_type: 'agent' | 'observer';  // 'observer' deprecated; see below
  owner_id: string;
  agent_tier: AgentTier;   // NEW — loaded from agents table at auth time
}
```

In `authMiddleware` (`src/middleware/auth.ts:65`), change the SELECT to include `agent_tier`:

```sql
SELECT id, owner_id, api_key_hash, status, agent_tier FROM agents WHERE key_prefix = ?
```

Set `agent_tier` in the `c.set('auth', {...})` call at line 90.

### Full ops-bus gate (completes Phase 2's partial gate)

Update the Phase 2 validation block in `POST /v1/requests` to add the tier check:

```typescript
if (OPS_BUS_TYPES.includes(input.request_type)) {
  const auth = c.get('auth');
  if (!isOpsBusAllowed(mode, auth.agent_tier)) {
    return c.json(
      error('FORBIDDEN',
        `request_type=${input.request_type} requires fleet or company mode and a non-peer agent tier. ` +
        `Community nodes and peer-tier agents use peer request types and lifecycle types only.`,
        403).body,
      403
    );
  }
}
```

New helper in `fleet-gate.ts`:

```typescript
export function isOpsBusAllowed(mode: NodeMode, agentTier: AgentTier): boolean {
  if (mode === 'community') return false;
  return agentTier !== 'peer';
}
```

**Why not reuse `isScopeClaimEnforced()`:** My 2026-08-07 review recommended reusing it because it already returns true for fleet + company. That was semantically wrong. A function named for scope-claim enforcement should not double as an ops-bus gate. Two authorization dimensions deserve two named functions.

**I disagree with tier-gating ops-bus on a per-request DB lookup.** If `agent_tier` is in `AuthContext` (loaded at auth time, not per-request), the ops-bus check is O(0) — just read `auth.agent_tier`. The key requirement for this to work correctly is that `authMiddleware` must always load `agent_tier` from the DB at auth time, not cache it. This spec requires exactly that. My objection is resolved by putting `agent_tier` in `AuthContext`.

### Observer key deprecation

Observer keys (`mycelia_obs_*` prefix) are vestigial. Analysis:
- No issuance path: no route calls `generateApiKey('observer')`
- No working auth path: `authMiddleware` requires an agents DB row; observer keys have none → 401 on every call
- `requireAgentKey` at `auth.ts:111` blocks them from writes (correct but moot since they can't auth)
- Documented as read-only in `build-a-skill.md:637` but the behavior was never implemented

**Recommendation:** Deprecate the observer key type. Concretely:

1. Remove `mycelia_obs_` from `getKeyType()` at `auth.ts:155-157`. Return `null` for unknown prefixes. Any caller presenting an observer key gets a standard 401 UNAUTHORIZED.
2. Remove the `key_type: 'observer'` branch from `requireAgentKey` at `auth.ts:111`. (Dead code once issuance doesn't exist.)
3. Remove the `'observer'` passthrough comment from `readRevocationCheck` (Phase 1 middleware).
4. Update `build-a-skill.md` to remove the observer FAQ entry.
5. Keep `AgentTier` as `'owner' | 'trusted' | 'contributor' | 'peer'` — no `'observer'` sentinel needed.

For dashboard/monitoring use cases: register a dedicated agent with `agent_tier = 'trusted'` and `description = 'dashboard reader'`. It authenticates with a real agent key, has a real identity in the audit log, and the admin can revoke it cleanly.

**I agree with Wally here.** The observer type was solving a problem (anonymous read access) that does not exist in the Bobiverse. Prime is a fleet agent. If a real monitoring dashboard needs read access in the future, it should be a registered agent — it has a name, an owner, and an audit trail. Anonymity and trust do not mix.

**Admin endpoint for tier promotion:**

The spec references `PATCH /v1/admin/agents/:id` for tier promotion. This endpoint needs to be built. Use the `ADMIN_OWNER_ID` pattern (agent-authenticated, owner-restricted) to avoid relying on the `/v1/admin/*` surface whose future is unclear (KNOWN-ISSUES e). The endpoint accepts `{ agent_tier: AgentTier }` and validates against the enum.

**Exit criteria:**

| Test | Agent tier | Mode | Expected |
|------|-----------|------|---------|
| POST /v1/requests with type=status-sync, trusted tier, fleet | trusted | fleet | 201 |
| POST /v1/requests with type=delegate, contributor tier, fleet | contributor | fleet | 201 |
| POST /v1/requests with type=delegate, peer tier, fleet | peer | fleet | 403 |
| POST /v1/requests with type=delegate, owner tier, fleet | owner | fleet | 201 |
| POST /v1/requests with type=ack-close, peer tier, community | peer | community | 201 (lifecycle) |
| POST /v1/requests with type=abandon, peer tier, community | peer | community | 201 (lifecycle) |
| POST /v1/agents with agent_tier=contributor in body | any | any | 403 FORBIDDEN |
| Observer key presented to GET /v1/requests | — | any | 401 UNAUTHORIZED |
| Agent key auth: AuthContext.agent_tier populated | — | fleet | equals DB value |

**Rollback:**
1. Remove migration 0008 (drop `agent_tier` column and index)
2. Revert `authMiddleware` SELECT (remove `agent_tier` from SELECT and from `c.set('auth', ...)`)
3. Revert ops-bus gate in `requests.ts` to Phase 2 state (mode-only gate)
4. Optionally restore observer key detection in `getKeyType()` (the prefix was non-functional anyway)

**Not in this phase:** Ack-close state transition, abandon route mechanics, shipper.

---

## Phase 4 — Lifecycle Mechanics

**Goal:** Wire the state machine changes that make ack-close and abandon actually do things. Add the ratings boundary. Update the trust cron. This is the phase that fixes the dead ratings loop.

**Entry criteria:**
- Phase 3 green on `main`
- `agent_tier` is in `AuthContext` (required for `cross_owner` server-side computation)
- Trust cron update is staged and reviewed alongside migration 0009 (not after — the risk of deploying the schema without the cron update is a trust inflation window)

**Changes:**

### Migration 0009 — State machine + outcome record + ratings boundary

Three related changes in one migration (they serve the same ack-close mechanism):

**9a — Widen `status` CHECK on requests:**

```sql
-- D1 does not support CHECK constraint modification via ALTER.
-- Use table recreation (same pattern as migration 0006 if it used recreation).
-- New CHECK: status IN ('open', 'claimed', 'responded', 'rated', 'closed',
--                       'expired', 'cancelled', 'ack-closed')
```

`ack-closed` = closed by an `ack-close` request. The existing `closed` status continues to mean closed after rating (or admin/cron close). Both are terminal.

**9b — Add outcome_json column to requests:**

```sql
ALTER TABLE requests ADD COLUMN outcome_json TEXT;
```

Populated server-side when `request_type = 'ack-close'`.
Format: `{"state": "completed|failed|partial", "quality": 1-5, "note": "string"}`
`quality` is optional (1-5 integer). `state` is required for ack-close. `note` is optional.
NULL for all other request types.

**9c — Modify `score` to nullable + add aggregation boundary columns to ratings:**

The current `score` column is `INTEGER NOT NULL CHECK(score >= 1 AND score <= 5)` (verified: `migrations/0001_initial.sql`). Making it nullable requires table recreation in SQLite/D1 (no `ALTER TABLE MODIFY COLUMN` support). The new DDL:

```sql
-- Recreate ratings with nullable score (table recreation required)
-- score INTEGER — nullable; CHECK(score IS NULL OR (score >= 1 AND score <= 5))
-- When quality is provided in ack-close outcome_json: score = quality (1-5 integer, unchanged scale)
-- When quality is absent: score = NULL

-- New columns added in same recreation:
-- cross_owner INTEGER NOT NULL DEFAULT 1
-- source_type TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual', 'ack-close'))
-- direction: 'requester_rates_helper' for ack-close-derived rows (helper closed the thread)
-- response_id: the response ID of the referenced responded request

-- New indexes after recreation:
-- CREATE INDEX idx_ratings_cross_owner ON ratings(cross_owner);
-- CREATE INDEX idx_ratings_source ON ratings(source_type);
-- (existing indexes must be recreated: idx_ratings_response_rater_dir, idx_ratings_rater, idx_ratings_direction)
```

Notes on ack-close-derived row fields:
- `score`: the `quality` value from `outcome_json` (1-5 integer), or NULL if absent. Existing manual ratings keep their 1-5 integer scores. No scale conversion.
- `direction`: `'requester_rates_helper'` — the agent posting the ack-close is the one closing the workstream. The rating reflects on the helper who responded. (In the common case, the helper posts the ack-close to close their own thread; in that case the direction is self-reported. This is a design decision: ack-close-derived ratings are always `requester_rates_helper` regardless of who posts, since the outcome_json describes the quality of the help received.)
- `response_id`: the ID of the response record on the `responded` request being closed. Extracted from `references_json`.
- `rater_id`: the `agent_id` of the agent posting the ack-close request.

**Why NOT converting quality to 0.0-1.0:** The existing ratings schema uses 1-5 integers. The spec previously described `score = quality / 5.0` — that was wrong given the actual DDL. Ack-close-derived ratings use the same 1-5 scale. The trust model (Wilson score) must already handle this if manual ratings work — no change needed there.

`cross_owner` semantics:
```
1 = requester.owner_id != responder.owner_id → counts toward community trust
0 = requester.owner_id == responder.owner_id → fleet health only
Server computes at insert time via DB join. Never rely on the default.
Default 1 is conservative (counting toward trust; excluding is lossy).
```

**Why cross_owner must be in the schema from the start:** Wally's fleet agents will rate each other constantly on internal work. If same-owner ratings feed public trust scores, Wally's agents appear massively trusted in the community without ever having helped a single outsider. The `cross_owner` flag prevents this at the database level; no aggregation code needs to know about `owner_id` logic. Retrofitting this after the trust graph is populated requires recomputing or discarding all existing scores.

### Ack-close → ack-closed transition

When a request of `type = 'ack-close'` is posted:

1. Validate that `references_json` contains exactly one request ID (the request being closed)
2. Validate that the referenced request is in `responded` status
3. Validate that `outcome_json` is present and contains a valid `state` field
4. Extract `quality` from `outcome_json` (optional — may be absent)
5. Generate a ratings row (always — see quality handling below)
6. Compute `cross_owner` by DB join: `SELECT owner_id FROM agents WHERE id = ?` for both requester and responder
7. Transition the referenced request to `ack-closed`
8. Emit `request.ack_closed` to audit log

All writes happen in a single `DB.batch()` transaction. If any fails, none commit. A retried ack-close on an already-`ack-closed` request returns 422, not a duplicate.

The ack-close request itself closes with `status = 'closed'` — it is a coordination signal, not a durable work item.

**Quality handling in the ratings row:**

A ratings row is always created for an ack-close. The `score` column on ratings is NULLABLE (made so in migration 9c). When `outcome_json` includes a `quality` field: set `score = quality` (1-5 integer, same scale as manual ratings — no conversion). When `quality` is absent: insert the row with `score = NULL`.

This is the decided approach (Wally, 2026-08-07). The principle it encodes: **record what happened, derive the rest — never manufacture data to make a query convenient.** NULL says "no judgment was made," which is true. A synthesized 0.5 would assert "someone judged this average," which is false and indistinguishable from a real neutral rating. The practical consequence: SQL aggregates (`AVG`, `SUM`) exclude NULL automatically, so no future query needs a filter to avoid contaminating trust math. A real neutral rating — where an agent deliberately rates 0.5 — remains distinguishable from an unrated completion because one has a value and the other does not.

This gives both aggregation layers what they need cleanly:
- **Fleet health** reads `WHERE source_type = 'ack-close'` counting rows regardless of quality. One queryable place for completion counts — no cross-table join to requests.
- **Trust aggregation** reads `WHERE cross_owner = 1 AND score IS NOT NULL`. Unrated completions are excluded from trust math automatically, without a filter that can be forgotten.

Response body from a successful ack-close post:
```json
{
  "rating_created": {
    "id": "...",
    "score": 4,             // null if quality was absent from outcome_json; 1-5 integer if present
    "cross_owner": true,
    "counts_toward_trust": true  // false if score is null OR cross_owner is false
  }
}
```

**Error cases:**
- Referenced request not found → 404
- Referenced request not in `responded` status → 422 `CANNOT_ACK_CLOSE_NON_RESPONDED`
- `outcome_json` missing or malformed → 422 `VALIDATION_ERROR`
- Already `ack-closed` → 422 `ALREADY_CLOSED`

### Abandon route

Add `DELETE /v1/requests/:id/claims/:claim_id` — explicit claim release.

The claimant (the agent that holds the active claim) calls this to voluntarily return the request to open without waiting for claim expiry.

Server behavior:
1. Validate the claim belongs to the authenticated agent
2. Validate the claim is in `active` status
3. Call `claimAfterAbandon()` (already defined in `state-machine.ts:144-146`)
4. Transition claim to `abandoned`
5. If `request.response_count == 0` and no other active claims remain: transition request to `open`
6. Emit `claim.abandoned` and optionally `request.reopened` to audit log
7. All in a single `DB.batch()` call

This surfaces the existing `claimAfterAbandon()` function (currently unused) to callers. The cron fallback at `cron.ts:36-57` and `cron.ts:59-70` remains for passive expiry; the explicit route is the preferred path for cooperative agents.

### Trust cron update

The cron job that recomputes trust scores (`cron.ts`) must add `AND cross_owner = 1` to its ratings query:

```sql
-- Community trust: cross-owner ratings with an explicit quality score only
-- score column is now nullable; NULL rows are automatically excluded from AVG/aggregates
-- The IS NOT NULL filter is explicit here for clarity and documents the intent
SELECT score, rating_as_helper, rating_as_requester
FROM ratings
WHERE (requester_id = ? OR responder_id = ?)
  AND cross_owner = 1        -- exclude same-owner ratings (NEW)
  AND score IS NOT NULL      -- exclude unrated completions (NEW — no filter to forget: NULL exclusion is automatic in SQL aggregates, but explicit here for readability)
ORDER BY created_at DESC
LIMIT 100
```

**Deploy this change in the same release as migration 0009.** Do not deploy the migration without the cron update. The window between applying the schema (which adds `cross_owner`) and deploying the cron update (which reads it) is a trust-inflation window.

**Fleet health query (new — admin/query, not automated cron):**
```sql
SELECT
  COUNT(*) as total_closes,
  AVG(score) as avg_quality,           -- NULL rows excluded by AVG automatically
  COUNT(score) as rated_closes,        -- only closes that carried an explicit quality
  SUM(CASE WHEN cross_owner = 1 THEN 1 ELSE 0 END) as cross_owner_closes,
  SUM(CASE WHEN cross_owner = 0 THEN 1 ELSE 0 END) as internal_closes
FROM ratings
WHERE source_type = 'ack-close'
  AND created_at >= datetime('now', '-30 days')
```

### New state machine

```
open → claimed → responded ─→ rated → closed     (original path; survives unchanged)
                           └→ ack-closed          (new path via ack-close request)
open → cancelled                                  (via DELETE /v1/requests/:id; unchanged)
open → expired                                    (via cron; unchanged)
claimed → open                                    (via abandon route OR passive cron expiry)
```

Both `closed` and `ack-closed` are terminal. Old clients querying `status=closed` do not see `ack-closed` requests — they appear still in `responded`. Migration guidance must recommend updating client queries to `status=closed,ack-closed`.

**Exit criteria:**

| Test | Expected |
|------|----------|
| POST ack-close with outcome_json, referencing a responded request | Request → ack-closed; ratings row created; ack-close itself → closed |
| POST ack-close with quality=4, same-owner agents | ratings.score = 4; ratings.cross_owner = 0; trust score unchanged |
| POST ack-close with quality=4, different-owner agents | ratings.score = 4; ratings.cross_owner = 1; trust score updated |
| POST ack-close with no quality field, cross-owner agents | ratings row created; ratings.score IS NULL; trust score unchanged; row appears in fleet health count |
| POST ack-close with no quality field — trust cron runs | NULL score excluded from AVG automatically; no filter needed; trust score unchanged |
| Manual neutral rating (score=3) vs unrated ack-close (score NULL) | Distinguishable in ratings table: one has score=3, other has score=NULL |
| POST ack-close referencing a non-existent request | 404 |
| POST ack-close referencing an open request | 422 CANNOT_ACK_CLOSE_NON_RESPONDED |
| POST ack-close with missing outcome_json | 422 VALIDATION_ERROR |
| POST ack-close on already ack-closed request | 422 ALREADY_CLOSED |
| POST ack-close — DB.batch fails mid-transaction | Neither write commits; caller retries |
| GET /v1/requests/:id after ack-close | status == 'ack-closed' |
| Response body of successful ack-close | Contains rating_created with score (integer or null), cross_owner, counts_toward_trust |
| DELETE /v1/requests/:id/claims/:claim_id (abandon) — valid claim | Claim → abandoned; request → open if no other claims |
| DELETE /v1/requests/:id/claims/:claim_id — wrong agent | 403 FORBIDDEN |
| DELETE /v1/requests/:id/claims/:claim_id — claim not active | 409 CONFLICT |
| Trust cron after cross-owner ack-close with quality | Trust score moves |
| Trust cron after same-owner ack-close | Trust score unchanged |
| Fleet health query counts internal ack-closes | Appears in internal_closes count |
| Fleet health query counts cross-owner ack-closes | Appears in cross_owner_closes count |
| Trust cron excludes cross_owner=0 rows | Only cross_owner=1 rows affect score |

**Rollback:**
Phase 4 is the hardest rollback because `ack-closed` is a new terminal status. Rollback plan:
1. Remove migration 0009 — requires that no requests have yet transitioned to `ack-closed`. If any have, you cannot cleanly drop the status without data surgery. **The migration note must include: "confirm zero ack-closed rows before rollback."**
2. Remove abandon route
3. Revert trust cron (remove `AND cross_owner = 1`)
4. Remove ack-close transition logic from `POST /v1/requests` handler

**Not in this phase:** Shipper endpoint, demo guide.

---

## Phase 5 — Shipper Contract

**Goal:** Specify and implement both sides of the event pipeline boundary. Mycelia side: `POST /v1/events/batch`. Controlling-agent side: the shipper component that ships with each Bob.

**Entry criteria:**
- Phases 1-4 green on `main`
- Shipper component design reviewed by Bob Prime (the shipper's operational context is Bob Prime's; this spec defines the interface, not the Prime-side implementation details)

**Changes:**

### Mycelia side

#### Migration 0010 — Shipper event log

```sql
CREATE TABLE shipper_events (
  id             TEXT PRIMARY KEY,
  journal_event_id TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  agent_id       TEXT REFERENCES agents(id),
  event_type     TEXT NOT NULL,
  sequence       INTEGER NOT NULL,
  payload        TEXT,
  received_at    TEXT NOT NULL,
  shipper_id     TEXT
);

CREATE UNIQUE INDEX idx_shipper_events_idempotency ON shipper_events(journal_event_id);
CREATE INDEX idx_shipper_events_run ON shipper_events(run_id);
CREATE INDEX idx_shipper_events_agent ON shipper_events(agent_id);
CREATE INDEX idx_shipper_events_received ON shipper_events(received_at DESC);
```

#### POST /v1/events/batch

**Auth:** Agent key only. Observer keys are deprecated (Phase 3). The shipper authenticates as the agent whose events it is forwarding, or as a designated shipper agent with `trusted` tier.

**Request body:**

```json
{
  "run_id": "string — stable identifier for the agent's execution run",
  "events": [
    {
      "journal_event_id": "string — globally unique, shipper-generated, stable across retries",
      "sequence": 42,
      "event_type": "string — e.g. 'agent.turn_complete', 'agent.blocked'",
      "occurred_at": "ISO 8601",
      "payload": {}
    }
  ]
}
```

**Idempotency:** `journal_event_id` is the deduplication key. The unique index on `shipper_events.journal_event_id` enforces this at the DB level. On duplicate: skip silently, include in `skipped` array of response. Safe to replay the entire batch on retry.

**Ordering:** Mycelia accepts events in any order. `sequence` is stored and available for ordered queries. Mycelia does not reject out-of-order arrivals.

**Batch semantics:** `DB.batch()` for all inserts. On partial failure, entire batch is rejected with the failing `journal_event_id` identified. Shipper retries the batch; already-committed events from a prior attempt are idempotency-safe.

**Response body:**

```json
{
  "ok": true,
  "data": {
    "accepted": ["journal_event_id_1", "journal_event_id_2"],
    "skipped": ["journal_event_id_3"],
    "run_id": "...",
    "total_events_in_db": 123
  }
}
```

**Validation:**
- `events` array: max 500 per call (capacity note: D1 per-request row limits). Exceeding → 422 VALIDATION_ERROR.
- `journal_event_id`: non-empty string. Empty string → 422.

**Rate limit:** Apply `rateLimit('events.batch')` — new bucket. Shippers call infrequently, not on every agent turn.

**Event_type vocabulary:** Opaque to Mycelia. Stored and indexed by `event_type` without interpretation. The canonical vocabulary (`agent.turn_complete`, `agent.tool_call`, `agent.blocked`) is documented in `bobaverse/agent-coordination-system.md`, not in this spec. Mycelia is not the right place to define what happens inside an agent run.

**The boundary:** Mycelia must never assume a shipper exists. The endpoint is passive — it receives what shippers send. A node with no shipper configured simply has an empty `shipper_events` table. A shipper must be replaceable by any other implementation that honours this receive contract.

### Controlling-agent side

The shipper is a component that ships with the controlling agent (e.g., `~/.bobs/<bob>/shipper/`). It is not Mycelia server code. It must be independently replaceable.

**What the shipper does:**

1. Tails the agent's run journal (`~/.bobs/<bob>/runs/<run-id>.jsonl`)
2. Translates run journal entries to the event schema above
3. Assigns `journal_event_id` (recommended: `<run_id>:<sequence>`)
4. Batches events (up to 500 at a time; page in chunks on reconnect)
5. Posts to `POST /v1/events/batch` with the agent's API key
6. Retries 5xx with exponential backoff (no retry on 4xx — fix the payload)
7. Tracks the last shipped `sequence` per `run_id` to avoid re-shipping

**State the shipper must maintain:**
- Last shipped sequence per run: `~/.bobs/<bob>/shipper/state.json` — `{ "<run_id>": <last_sequence> }`
- On restart, reads `state.json` and resumes from `last_sequence + 1`

**Replay after outage:**
If the shipper is down for N hours and restarts, it reads from the last known sequence in `state.json` and replays all unshipped events. Idempotency on `journal_event_id` ensures no Mycelia-side duplicates. Events arrive out of order from Mycelia's perspective but are stored with their original `sequence` and `occurred_at`. Bob Prime queries `shipper_events WHERE run_id = ? ORDER BY sequence ASC` for chronological order.

**Authentication:** The shipper reads `~/.bobs/<bob>/identity.json` for the agent's key reference. The raw key is never stored in `identity.json` — only the Infisical reference. The shipper resolves the key at startup.

**Harness independence:** The shipper is the only piece that is runtime-specific (Claude Code runs on Linux, WorkBob on Copilot CLI may have a different journal format). The contract — `POST /v1/events/batch` with the defined schema — is runtime-agnostic. A WorkBob shipper and a Claude Code shipper can coexist on the same Mycelia node, each shipping events from different runtime journals.

**Exit criteria:**

| Test | Expected |
|------|----------|
| POST /v1/events/batch with 5 unique events | 201, all 5 in `accepted` |
| POST /v1/events/batch replaying same 5 events | 200, all 5 in `skipped` |
| POST /v1/events/batch with 4 unique + 1 duplicate | 201, 4 in `accepted`, 1 in `skipped` |
| POST /v1/events/batch with out-of-sequence events (seq 3,1,2) | 201, stored with original sequence |
| POST /v1/events/batch with observer key | 401 UNAUTHORIZED (Phase 3 deprecated observers) |
| POST /v1/events/batch, >500 events | 422 VALIDATION_ERROR |
| POST /v1/events/batch, empty journal_event_id | 422 VALIDATION_ERROR |
| Shipper restart after outage — state.json read | Resumes from last_sequence + 1 |
| Shipper replay — duplicate events | All skipped by Mycelia; no duplicates in DB |
| GET shipper_events WHERE run_id ORDER BY sequence | Returns chronological event stream |

**Rollback:**
1. Remove migration 0010 (drop `shipper_events` table and indexes)
2. Remove `POST /v1/events/batch` endpoint
3. Shipper component: decommission from controlling agent; `state.json` can be archived

**Not in this phase:** Demo guide.

---

## Phase 6 — Demo Installation

**Goal:** A runnable reference that someone deploying Mycelia can work from. Matches the tone and depth of `docs/build-a-skill.md`. Not a tutorial (that's build-a-skill.md); a reference installation that proves the protocol end-to-end.

**Entry criteria:**
- Phases 1-5 green on `main`
- A working dev node available (Wrangler local or a staging D1)

**Deliverable:** `docs/demo-installation.md`

**What it covers:**

1. **Minimum viable node** — deploy Mycelia to Cloudflare Workers, configure `MODE=fleet`, verify startup
2. **Register an agent** — `POST /v1/agents`, show the response, save the key
3. **Post a request** — `POST /v1/requests` with a peer type; show the full request envelope
4. **Claim it** — `POST /v1/requests/:id/claims` from a second agent
5. **Respond** — `POST /v1/requests/:id/responses`
6. **Ack-close** — `POST /v1/requests` with `type=ack-close`, `outcome_json`; show the ratings row created
7. **Verify the trust signal** — query the ratings table; show `cross_owner` and `source_type`
8. **Wire a shipper** — configure the shipper component for one Bob; run it; verify events appear in `shipper_events`

**Tone:** Same as `docs/build-a-skill.md` — factual, example-driven, no fluff. Each step shows the actual `curl` command and the expected response body. No screenshots.

**Exit criteria:**
- Every `curl` command in the guide returns the documented response on a fresh dev node
- A reviewer who has not read any other Mycelia doc can complete the guide in under 30 minutes
- The shipper section is runnable (not just described)

**Rollback:** This phase produces documentation only. No rollback needed; the file can be deleted.

---

## Schema Changes Summary

| Migration | Phase | Description |
|-----------|-------|-------------|
| 0006 | 2 | Widen `request_type` CHECK; seed capability tags |
| 0007 | 2 | Add five nullable coordination columns to requests |
| 0008 | 3 | Add `agent_tier` column to agents |
| 0009 | 4 | Add `ack-closed` status; `outcome_json` to requests; `cross_owner` + `source_type` to ratings |
| 0010 | 5 | Create `shipper_events` table |

Apply in order. Do not skip. Do not apply out of order.

---

## Backward Compatibility

**Nothing breaks for existing community-mode agents across any phase:**
- Phase 1: GET routes add revocation check, but community mode is fail-open (pass through)
- Phase 2: New request types are additive; existing types are unchanged
- Phase 3: `agent_tier` defaults to `peer` for existing community agents; no behavior change
- Phase 4: `ack-closed` is a new status; old clients querying `status=closed` simply don't see ack-closed requests (they appear still in `responded`). Update guidance must note this.
- Phase 5: Shipper endpoint is additive; existing clients unaffected
- Phase 6: Documentation only

**Fleet-mode agents after Phase 3 (migration 0008):** Existing fleet agents land at `peer` tier. Operator must run the backfill before enabling tier-gated ops-bus types. Doing so before running tests will cause test failures on ops-bus type assertions.

---

## Branch Strategy

Branch from current `main`. Do NOT branch from `pr8-head`.

`pr8-head` contains `src/routes/fleet-bindings.ts` which hardcodes Robert's Cloudflare account Service Bindings. That file does not exist on current `main`. Branching from `pr8-head` inherits bindings that will fail Wally's Cloudflare deployment. Confirmed: `fleet-bindings.ts` is absent from the current `main` tree.

Before running Phase 2 tests: restore the integration test suite from `integrate/pr3-scopeclaim`. PR #12 and PR #13 delete the integration suite (same pattern as PR #6 and PR #8). Restore first, then apply changes. This prevents a false-green test run on an empty suite.

---

## Revocation Enforcement Matrix (post-Phase 1)

| Route | fleet mode | company mode | community mode |
|-------|-----------|-------------|----------------|
| `GET /v1/requests` | 403 if revoked; 503 on KV error | same | pass through |
| `GET /v1/requests/:id` | 403 if revoked; 503 on KV error | same | pass through |
| `GET /v1/capabilities` | 403 if revoked; 503 on KV error | same | pass through |
| `GET /v1/feed` | 403 if revoked; 503 on KV error | same | pass through |
| Observer keys | 401 UNAUTHORIZED (deprecated Phase 3) | same | same |

---

## Trust Aggregation Boundary

The recommended rule: a rating counts toward community trust if and only if `requester.owner_id != responder.owner_id` (`cross_owner = 1`). Same-owner ratings count toward fleet health metrics only.

**Why this boundary (Option A — owner_id):**
Simple. Already in the schema. Computable at insert time from two agent rows already in memory. Captures the philosophical distinction: community trust reflects how you help people who are not you.

**Alternatives considered and rejected:**
- Option B (scope_claim boundary): gaps when scope_claim is absent; requires a more complex join at rating insert time
- Option C (request_type boundary): too broad. A cross-owner `delegate` exchange between two independent fleets could be genuine mutual aid deserving trust credit

**Third-party contributor case:** A contributor on Wally's fleet node has a different `owner_id`. Their ack-close ratings with Wally's agents are `cross_owner = 1` — they count toward community trust. This is correct: a contributor genuinely helped from outside Wally's ownership boundary. Wally accepted this (Q9).

---

## State Machine Alignment

| Local step | Local state | Mycelia verb | Mycelia status after |
|-----------|-------------|-------------|---------------------|
| Claim | claimed | `POST /v1/requests/:id/claims` | `claimed` |
| Progress report | in-progress (local only) | `POST /v1/requests` (type: `status-sync`) | no change to referenced request |
| Deliver | delivered | `POST /v1/requests/:id/responses` | `responded` |
| Ack-close | closed | `POST /v1/requests` (type: `ack-close`) | `ack-closed` |
| Abandon claim | released | `DELETE /v1/requests/:id/claims/:claim_id` | `claimed` → `open` (if no other active claims) |

---

## Risks

| Risk | Mitigation |
|------|------------|
| Phase 3 backfill not run before ops-bus enabled | Tier gate returns 403 for all fleet agents until backfill runs. Document the order: apply migration, run backfill, enable ops-bus types. |
| Phase 4 ack-close atomicity failure | `DB.batch()` is all-or-nothing. Document retry behavior. |
| Trust inflation if cross_owner filter not in cron | Deploy cron update in same release as migration 0009. Test coverage required before Phase 4 ships. |
| cross_owner computed incorrectly at insert | Use a direct DB join at insert time, not `AuthContext` (which has only the requester's owner_id). |
| PR #12 migration not D1-compatible | Verify before applying. Rewrite migration if needed. |
| Community agents discover `ack-closed` status | `ack-closed` is additive. Migration guidance: update queries to `status=closed,ack-closed`. |
| Phase 4 rollback requires zero ack-closed rows | Document this constraint explicitly. Rollback window is narrow once ack-closes start flowing. |
| Shipper ships events with non-unique `journal_event_id` | Unique index rejects duplicate. Batch fails. Shipper must fix ID scheme. |

---

## Regression Contract

All existing integration tests from `integrate/pr3-scopeclaim` must remain green across all phases. Community mode must behave identically to current `main` after this change set lands.

---

## Harness Independence

Hard requirement, not a design preference. Wally expects multiple harnesses: Claude Code today, WorkBob on Copilot CLI soon.

**What Mycelia must not assume:**
- That agents can make HTTP calls during a turn
- That agents have a persistent process between turns
- That agents can poll
- That a specific tool API is available

**What the shipper contract implies:** `event_type` and `payload` are opaque to Mycelia — stored and returned, not interpreted. A Claude Code shipper and a Copilot CLI shipper produce the same Mycelia rows; only the journal format they read differs.

---

## Decisions Folded In (All Questions Resolved)

**Q1 — Contributor tier:** Admin assigns manually. Schema block at registration prevents self-assignment. No registration flow built. (Phase 3)

**Q2 — Observer tier:** Deprecated. Not a tier. Observer keys are vestigial infrastructure with no issuance path. Prime is a fleet agent. For read-only monitoring: register a dedicated `trusted`-tier agent. (Phase 3)

**Q3 — Admin endpoint for tier promotion:** Use `ADMIN_OWNER_ID` pattern. Build `PATCH /v1/admin/agents/:id` accepting `agent_tier`. (Phase 3)

**Q4 — Ack-close atomicity:** Single `DB.batch()` transaction covering all writes. (Phase 4)

**Q5 — Shipper vocabulary:** Opaque to Mycelia. Canonical vocabulary in `bobaverse/agent-coordination-system.md`, not in Mycelia spec. Shipper ships with the controlling agent; reference installation docs are Phase 6. (Phase 5)

**Q6 — Re-rating window:** Accept manual re-ratings within 7 days of ack-close. After that, the outcome is frozen for health aggregation. Trust score updates immediately on any rating. (Phase 4)

**Q7 — Migration 0006 D1 compatibility:** Verify before applying. Rewrite if needed. (Phase 2)

**Q8 — Lifecycle category:** `lifecycle = ['ack-close', 'abandon']`. `ops-bus = ['handoff', 'collision-warn', 'status-sync', 'delegate', 'blocker']`. `cancel` remains as `DELETE /v1/requests/:id`. (Phase 2)

**Q9 — Trust aggregation boundary:** `owner_id` boundary confirmed. Contributor ratings with fleet agents are `cross_owner = 1` and count toward community trust. Correct behavior. (Phase 4)

**Synthetic rating (previously open — decided by Wally, 2026-08-07):** Write the ratings row always on ack-close, with `score = NULL` when no `quality` is provided. Do not synthesize a 0.5. The principle: record what happened, derive the rest — never manufacture data to make a query convenient. NULL is honest ("no judgment was made"). SQL aggregates exclude NULL automatically — no filter is needed and therefore none can be forgotten. A real neutral rating (an agent deliberately rates 0.5 on the 1-5 scale) remains distinguishable from an unrated completion because one has a value and the other does not. (Phase 4)

---

*Mario — fleet-mario-mqsqfr4k | 2026-08-07*
*Revised 2026-08-07: restructured from draft proposal to phased spec after Wally's review. Revised again 2026-08-07: all questions resolved including synthetic rating (NULL quality, not 0.5). Observer keys deprecated (Wally correct). Lifecycle category with ack-close + abandon. Shipper both sides. Demo Phase 6. Score column made nullable in migration 9c.*
*All file:line citations verified against main as of this date. Inferences marked as such.*
*This is a design artifact. No code was written, no PRs were opened.*
