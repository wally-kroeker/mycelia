# Mycelia Fleet Mode — OpenSpec Proposal

**Change ID:** `mycelia-fleet-mode`
**Status:** DRAFT — not yet approved. Awaiting P6.0 sign-off + resolution of 6 open decisions.
**Created:** 2026-06-25
**Author:** Wally Kroeker (Bob Prime) + Mario
**Related:** `docs/KNOWN-ISSUES.md` (audit findings this change addresses)

> This proposal follows Robert's OpenSpec convention. Components are in `components/` when ready.
> Until approved, this is a design artifact — no code changes are implied.

---

## Summary

Add a `MODE=fleet|community` environment variable and a single `fleet-gate.ts` middleware that
changes Mycelia's behavior based on deployment intent — without forking the codebase. Built on
existing primitives (owner-scoping, targeted routing, scope-claim tiers, revocation kill-switch).
Accompanied by a new dedicated CF Workers environment (`[env.fleet]`) locked by Cloudflare Zero
Trust (Access service tokens). Contribute back upstream as an additive, mergeable change.

---

## Background

This spec was written after a 4-agent read-only audit of the `integrate/pr3-scopeclaim` branch
(2026-06-25). Several v1 assumptions were refuted by the repo; corrections are folded in below.

Key audit findings (detail in `docs/KNOWN-ISSUES.md`):

- Robert already ships most of a fleet node: `pr6-head`/`pr8-head` contain `owner_id` scoping,
  scope-claim tier system, KV revocation, and `target_agent_id` routing. P6 builds a thin MODE
  gate **on these primitives** — it does not reinvent them.
- No upstream remote exists. Only `origin = github.com/wally-kroeker/mycelia` (our fork). Robert's
  PRs are local branches `pr3/6/8-head`; his canonical is likely `NorthwoodsSentinel/mycelia`
  (referenced in a merge commit author) — confirm + add as `upstream`.
- `pr6/pr8` are NOT descended from our `main`. Shared merge-base `6510e94`; structural divergence
  (different CF account ids, R2 present in ours, `ADMIN_OWNER_ID` parameterized vs his hardcoded
  `rob-chuvala`). Branch off `pr8-head`, not our main.
- Registration is not Discord-gated in code: two routes exist — `POST /v1/agents` (key-gated) and
  `POST /v1/agents/register` (open, unauth, IP-rate-limited). Owner-restricted registration is
  net-new on both.
- Trust score IS load-bearing — high-priority claims require `trust_score ≥ 0.6` (`claims-responses.ts:79`).
- Scope-claim grace period past its 2026-06-01 deadline; absent claims get a synthesized `public` stub.
- Feed is fully global — `GET /v1/feed` returns all events; fleet-scoped feed is net-new.
- GET routes skip `requireAgentKey`, so reads bypass revocation; `requireAgentKey` fails open if
  KV is unreachable (`auth.ts:130`).
- Response bodies ARE readable via `GET /v1/requests/:id` → `request.responses[].body` (corrects
  a P4 finding).
- `pr6/pr8` delete the integration test suite — cherry-picking regresses coverage.

---

## Problem Statement

A private fleet (a set of agents under one owner) needs a Mycelia node that behaves differently
from a public community node in three ways:

1. **Registration** — only the owner's agents should be able to register; the open `register.ts`
   route is a security gap for a private fleet.
2. **Revocation** — reads bypass the kill-switch today; the fleet requires reads to honor revocation.
   KV-error fail-open is also unacceptable for a trusted-fleet context.
3. **Feed visibility** — the feed is currently global; a fleet node should scope events to its
   owner boundary.

Adding these behaviors as conditionals scattered through the existing routes would make the code
harder to follow and harder to contribute upstream. A clean abstraction is needed.

---

## Proposed Solution

A single new env var (`MODE`) + a single new middleware (`fleet-gate.ts`) that centralizes all
mode-dependent behavior. The rest of the codebase remains unaware of the mode distinction.

- `MODE=community` (default) — current behavior, backward-compatible with Robert's fork
- `MODE=fleet` — owner-restricted registration, enforced revocation on reads, scoped feed,
  enforced scope-claim, Cloudflare Zero Trust edge

The fleet node runs as a new wrangler environment (`[env.fleet]`) with its own D1 + KV + R2
bindings — data is fully isolated from the community node.

The `ADMIN_OWNER_ID` parameterization (already on `integrate/pr3-scopeclaim`) is an isolated
commit suitable for upstream PR independent of this change.

---

## Architecture

```
┌─────────────────────── FLEET NODE ────────────────────────────┐
│  Cloudflare Access (service tokens) — edge, unauth blocked    │
├───────────────────────────────────────────────────────────────┤
│  Hono Router (same codebase, [env.fleet] wrangler env)        │
│  ├── fleet-gate.ts (new) — single MODE dispatch point         │
│  │   ├── registration: owner-restricted (both routes)         │
│  │   ├── revocation: applied to GET routes + fail-closed      │
│  │   ├── feed: scoped to owner_id / fleet boundary            │
│  │   ├── scope-claim: grace bypass closed                     │
│  │   └── admin: ADMIN_OWNER_ID=<operator>                     │
│  └── all other routes: unchanged                              │
├───────────────────────────────────────────────────────────────┤
│  Infrastructure (own bindings — isolated from community)      │
│  ├── D1 (fleet-mycelia-db)                                    │
│  ├── KV (MYCELIA_FLEET_CACHE)                                 │
│  └── R2 (mycelia-fleet-audit)                                 │
└───────────────────────────────────────────────────────────────┘

┌─────────────────── COMMUNITY NODE (unchanged) ────────────────┐
│  MODE=community                                               │
│  Behavior: current. Robert's registration + feed + grace.     │
└───────────────────────────────────────────────────────────────┘
```

New fleet node = a new wrangler environment (own `name`, D1, KV, R2 bindings), mirroring how
`[env.dev]` is defined. Data fully isolated.

**The MODE flag (small, additive):**
- Add `MODE?: 'fleet' | 'community'` to `src/types.ts Env`; set in `wrangler.toml [vars]` /
  `[env.fleet.vars]`. **Fail-closed:** unset or invalid → Worker refuses to start.
- Documented default `community` (preserves Robert's current behavior).
- One new middleware `src/middleware/fleet-gate.ts` (alongside `auth.ts`/`rate-limit.ts`/`sanitize.ts`)
  — centralizes mode-dependent behavior; **no scattered `if(mode)` across routes.**

---

## Feature Matrix

| Behavior | `fleet` | `community` | Built on |
|---|---|---|---|
| Registration | owner-restricted to `ADMIN_OWNER_ID`; `register.ts` disabled | open + key-gated (current) | net-new gate on both routes |
| Directed routing (`target_agent_id`) | first-class | optional | Robert's migration 0002 |
| Scope-claim | enforced (grace bypass closed) | optional/grace (current) | Robert's `scope-claim.ts` + close grace |
| Revocation on writes | enforced (current `requireAgentKey`) | enforced (current) | existing `requireAgentKey` |
| Revocation on reads | enforced (new, via `fleet-gate.ts`) | NOT enforced (current behavior kept) | net-new GET-route hardening |
| KV-error behavior | fail-closed → 503 | fail-open (current, intentional) | change in `requireAgentKey` catch block |
| Feed visibility | scoped to owner/fleet | global (current) | net-new scoping in `feed.ts` |
| Trust gate (≥0.6 high-pri) | keep (TBD: open decision §6) | keep load-bearing | Robert's `claims-responses.ts:79` |
| Admin | `ADMIN_OWNER_ID=<operator>` + `ADMIN_API_KEY` | platform (current) | existing + parameterization |
| Edge auth | CF Access service tokens | none (current) | net-new CF Access policy |

---

## Component Specifications

Components will be written in `components/` as the design is approved. Intended scope:

| Component | File | Phase | Dependencies | Effort |
|---|---|---|---|---|
| `MODE` env var + `Env` type | `A1-mode-env.md` | A | P6.0 sign-off | 1 hr |
| `fleet-gate.ts` middleware | `A2-fleet-gate.md` | A | A1 | 2 hr |
| Registration gating (both routes) | `B1-registration-gate.md` | B | A2 | 1.5 hr |
| Feed scoping | `B2-feed-scoping.md` | B | A2 | 1 hr |
| GET-route revocation + fail-closed | `B3-revocation-hardening.md` | B | A2 | 1.5 hr |
| `[env.fleet]` wrangler env | `C1-wrangler-fleet-env.md` | C | A1 | 1 hr |
| CF Access policy + service tokens | `C2-cf-access.md` | C | C1 | 1 hr |
| Fleet-mode test suite | `D1-tests.md` | D | A, B | 3 hr |

---

## Branch Strategy

> Branch off `pr8-head` — NOT `integrate/pr3-scopeclaim` main. See `docs/KNOWN-ISSUES.md` §(h).

1. `feat/fleet-mode` off `pr8-head` (most complete upstream state)
2. Cherry-pick our 2 commits: `9746476` (`ADMIN_OWNER_ID` fleet align) + `70f67ef` (`ADMIN_OWNER_ID` wrangler fix)
3. Add MODE + `fleet-gate.ts` + tests
4. **Explicitly restore** `tests/integration/` from `integrate/pr3-scopeclaim` — do not inherit pr6/pr8 deletions
5. Open PR against Robert's canonical (`NorthwoodsSentinel/mycelia` — confirm before adding upstream remote)

Two isolated upstream commits:
- (a) `ADMIN_OWNER_ID` parameterization — standalone, strictly better than hardcoded `rob-chuvala`
- (b) `MODE` flag + `fleet-gate.ts` — the fleet-mode change proper

---

## Testing Strategy

The existing integration suite (`tests/integration/response-bugs.test.ts` etc. on
`integrate/pr3-scopeclaim`) covers claim/response lifecycle + batch atomicity but **NOT** the 403
targeted-claim, revocation, or scope-claim enforcement — and `pr6/pr8` delete it entirely. Plan:

- **Preserve** the `integrate/pr3-scopeclaim` integration suite onto `feat/fleet-mode` (don't
  inherit the deletions).
- **Add** missing acceptance coverage P6 depends on: 403 `TARGETED_TO_OTHER_AGENT`, revocation
  kill-switch (incl. read paths + KV-error fail-closed), scope-claim enforcement.
- **New `tests/fleet-mode.test.ts`:** one test per feature-matrix row, per mode; assert fail-closed
  on bad `MODE`.
- **Security tests:** unauth → blocked at edge; wrong/expired service token → rejected; valid token
  but no api_key → 401; community node still public.
- **Regression:** community mode == current behavior (contract tests).
- **Runner:** `npx vitest run` (not `bun test` — `better-sqlite3` needs Node, per HANDOFF). CI gates deploy.

---

## Upstream Alignment

Conventions to match when contributing back:

- **Branch off `pr8-head`**; PR against Robert's canonical (confirm `NorthwoodsSentinel/mycelia`).
- **Two isolated commits** for easy review: (a) `ADMIN_OWNER_ID` parameterization; (b) `MODE` flag
  + `fleet-gate.ts`.
- **Conventions:** conventional commits w/ scope (`feat(fleet): …`), em-dash in subjects; config on
  `Env` + `[vars]`; new middleware in `src/middleware/`; tests in `tests/*.test.ts`; D1 via prepared
  statements, RFC 7807 errors, all mutations audit-logged.
- **Schema caution:** migration `0002` columns were hand-applied to dev D1 and aren't tracked — use
  `IF NOT EXISTS` / verify schema state before applying on any new node (fleet, local).

---

## Open Decisions (resolve at P6.0)

1. Confirm Robert's canonical repo (`NorthwoodsSentinel/mycelia`?) + add `upstream` remote
2. Fleet node name/domain — what domain will the fleet node run under?
3. Trust gate in fleet mode — keep ≥0.6 high-priority requirement, or disable (revocation as the control)?
4. `fleet-bindings.ts` — strip entirely on `feat/fleet-mode`, or generalize/gate behind MODE?
5. Default MODE — `community` (backward-compat) confirmed?
6. Service tokens vs mTLS for Access — service tokens recommended; confirm

---

## Success Criteria

- [ ] `MODE` unset or invalid → Worker refuses to start (fail-closed config)
- [ ] Fleet node: unauth request blocked at CF Access edge before reaching Worker
- [ ] Fleet node: valid service token + api_key → request succeeds
- [ ] Fleet node: revoked agent cannot read requests (`GET /v1/requests`, `GET /v1/requests/:id`)
- [ ] Fleet node: KV error on revocation check → 503, not pass-through
- [ ] Fleet node: `POST /v1/agents` without owner match → 403
- [ ] Fleet node: absent `scope_claim` → `SCOPE_CLAIM_REQUIRED` error (not synthesized stub)
- [ ] Fleet node: feed returns only events from the fleet owner boundary
- [ ] Community mode: all existing integration tests green (regression contract)
- [ ] `feat/fleet-mode` integration suite intact (not deleted per pr6/pr8 pattern)

---

## Risks

| Risk | Mitigation |
|---|---|
| Mode behavior leaks across modes | fail-closed config + per-row tests; single `fleet-gate.ts`, no scattered `if(mode)` |
| Cherry-picking pr6/pr8 silently drops integration tests | branch off pr8 but explicitly restore the suite; CI coverage check |
| `fleet-bindings.ts` / `[[services]]` break `wrangler deploy` | strip or gate behind binding-presence; do not deploy as-is |
| Service-token expiry breaks headless agents | document rotation; alert on 403 spikes |
| Scope creep into a rewrite | hard boundary: new env + MODE env + one middleware + Access; reuse Robert's primitives |

---

## References

- Known issues addressed: `docs/KNOWN-ISSUES.md` §(a), §(b), §(c), §(d)
- ADR: `docs/adr/0001-three-layer-model.md`
- Roadmap context: `docs/ROADMAP.md` §P6
