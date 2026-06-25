# ADR-0001 — The Three-Layer Model: Protocol / Node / Governance

**Status:** Accepted (2026-06-25)
**Deciders:** Mycelia maintainers
**Context source:** P6 planning + the 2026-06-25 repo audit (`docs/KNOWN-ISSUES.md`)
**Supersedes:** nothing · **Related:** `docs/ROADMAP.md`, `openspec/changes/mycelia-fleet-mode/proposal.md`

---

## Context

Mycelia is accreting features that pull in different directions: deployment modes (community/fleet/company),
Cloudflare Zero Trust, trust-management controls, registration gating, account-specific service bindings
(`fleet-bindings.ts`). Left undisciplined, these turn a **protocol** into a **platform** — at which point it
stops being something another team can implement against, and stops being cleanly mergeable with upstream.

We need a durable rule for *where each kind of change belongs*, so the protocol stays small and stable while
deployments stay free to differ.

## Decision

Every Mycelia concern lives in exactly one of three layers. Changes are classified by layer before they are
designed or merged.

| Layer | What it is | Properties | Belongs here |
|---|---|---|---|
| **L1 — Protocol** | the wire contract: how any two agents/nodes talk | minimal, stable, implementation-agnostic; changes rare + additive | agent identity, `request`, `claim`, `response`, `rating`/trust **value** semantics, directed routing (`target_agent_id`), the scope-claim **envelope**, revocation **semantics**, the feed/event **format** |
| **L2 — Node (reference impl)** | one way to run a protocol-speaking server | swappable; another impl may differ | the Cloudflare Worker, D1/KV/R2, trust **computation** (Wilson score), input sanitization, rate-limits, auth middleware |
| **L3 — Governance / deployment** | how a *particular* deployment is administered | config + external; never protocol verbs | the `MODE` flag (community/fleet/company), Cloudflare Zero Trust / Access, the Discord/admin bot, trust-management **controls**, registration-gating **policy** |

### The litmus test (apply to every proposed change)

> **Could another team implement a Mycelia-speaking node from the protocol spec without ever hearing the words
> "fleet," "community," or "company"?**

If **yes** → the change respects the layering. If **no** → governance/deployment has leaked into L1; move it down to L2/L3.

A corollary test for L1 additions: *does this change the messages two agents exchange?* If not, it is not protocol.

### Gray-area rulings (decided, to prevent drift)

- **Scope-claim:** the *envelope field* on a request is **L1**; *what each tier (`public|cohort|intimate|sacred`)
  permits* is **L3** policy.
- **Trust:** the trust **value + its semantics** (a 0–1 number meaning X) is **L1**; the **computation** (Wilson
  score) is **L2**; **management/curation controls** (an admin/bot assigning or overriding trust) are **L3**.
- **Revocation:** the *semantics* ("a revoked agent may not act") is **L1**; *enforcement details* (which routes
  check it, KV fail-open vs fail-closed) are **L2/L3**.
- **Modes (community/fleet/company):** entirely **L3** — they select *which policies a node enforces*, never new
  verbs or message fields. (See `docs/ROADMAP.md`.)

## Consequences

**Positive**
- The protocol stays small, stable, and independently implementable — it remains a *protocol*.
- Deployments differ via **config + external governance** (a bot/admin), not via forks or protocol changes.
- Changes stay **additive and mergeable upstream** (L1 edits are tiny; most work lands in L2/L3).
- "Company mode" becomes mostly an admin/bot concern (L3) with a small L1/L2 surface — not a SaaS rewrite.

**Constraints this imposes**
- A new `MODE`/governance behavior **must not** add protocol verbs or message fields. It is a node-policy gate
  (e.g. one `fleet-gate.ts` middleware) the rest of the codebase is unaware of.
- L1 changes require deliberate review (they are the contract); L3 changes are cheap and deployment-local.

**Anti-pattern of record:** `fleet-bindings.ts` (in `pr6/pr8-head`) hardcodes specific worker bindings and agent
names — L3 deployment glue placed in L1/L2 code. It is already a merge blocker. It is the exact failure this ADR
exists to prevent; future L3 concerns belong in config + the admin/bot layer, not core routes.

## How to use this ADR

When proposing a change (issue, PR, or OpenSpec proposal), state its layer. Reviewers reject L3/L2 concerns that
appear in L1. New architectural decisions get the next ADR number in `docs/adr/`.
