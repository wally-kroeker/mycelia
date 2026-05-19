# Worker Entrypoint Shape — Service Bindings for Fleet Workers

**Status:** Draft, awaiting Margin's sharpening pass. Written by Leroy 2026-05-18.

This spec describes the TypeScript shape every Worker-backed fleet agent (mirror-worker, gemini-worker, mistral-worker, brook) MUST implement to participate in directed-synchronous fleet calls via CF Service Bindings, per CF AI's 2026-05-18 recommendation.

---

## Why Service Bindings (not /ask HTTPS)

CF AI confirmed: Service Bindings with `WorkerEntrypoint` give Worker-to-Worker calls zero network hop, zero cost, typed methods, internal-only (no internet surface). The /ask-on-Worker pattern I'd originally proposed is replaced by this one. Internet-facing /ask endpoints are NOT shipped for Worker-tier agents — they would re-introduce a bearer-token-binary auth surface we don't need.

Claude Code instances (Leroy, Margin, CeeCee) still go through mycelia (targeted-mycelia for directed-eventual). Service Bindings are only for Worker → Worker.

---

## Required exports per fleet Worker

Every Worker-backed fleet agent exports an `*Api` class extending `WorkerEntrypoint`. The class is the public RPC surface for sibling fleet members.

```typescript
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ScopeClaim } from './scope-claim';  // shared types, copied from mycelia repo
import { validateScopeClaim, permits, refusalRequiredForMycelia } from './scope-claim';

export class MirrorApi extends WorkerEntrypoint<Env> {
  /**
   * Synchronous Q&A from a sibling fleet member.
   * @param scope  The caller's scope claim. Must be valid; ask_max_tier enforced.
   * @param question  The question text. Bounded length 1-4000 chars.
   * @returns AskResponse with body filtered to scope.ask_max_tier
   */
  async ask(scope: ScopeClaim, question: string): Promise<AskResponse> {
    // 1. Validate scope (identity match is delegated to caller-side proof; we trust
    //    the binding endpoint exists only between known fleet workers)
    const v = validateScopeClaim(scope, null /* bearer agent check happens upstream */);
    if (!v.ok) {
      return { ok: false, error: { code: v.code, message: v.message } };
    }

    // 2. Length bound on question
    if (typeof question !== 'string' || question.length === 0 || question.length > 4000) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'question must be 1-4000 chars' } };
    }

    // 3. Generate response (worker-specific logic)
    const raw = await this.generateAnswer(question);

    // 4. Apply scope filter — drop any content tier above ask_max_tier
    const filtered = filterByTier(raw, v.claim.ask_max_tier);

    // 5. Sacred-tier content never goes over fleet wire
    if (refusalRequiredForMycelia(filtered.body_tier)) {
      return {
        ok: false,
        error: {
          code: 'SACRED_REFUSAL',
          message: 'Some matched content was sacred-tier; direct Rob session required.',
        },
      };
    }

    // 6. Audit (every call logged)
    await this.logCall({
      caller_agent_id: v.claim.agent_id,
      caller_tier: v.claim.tier,
      ask_max_tier: v.claim.ask_max_tier,
      body_tier: filtered.body_tier,
      question_length: question.length,
      ts: new Date().toISOString(),
    });

    return { ok: true, body: filtered.body, body_tier: filtered.body_tier, model: this.modelName() };
  }

  /**
   * Status / health probe. Returns { name, version, model, last_seen }.
   * Always-public, never carries content. No scope check needed.
   */
  async status(): Promise<StatusResponse> {
    return {
      ok: true,
      name: 'mirror',
      version: '1.0.0',
      model: this.modelName(),
      last_seen: new Date().toISOString(),
    };
  }

  // Worker-specific implementations go below in the actual file.
  private async generateAnswer(_q: string): Promise<{ body: string; body_tier: Tier }> { throw new Error('impl in worker'); }
  private modelName(): string { throw new Error('impl in worker'); }
  private async logCall(_e: AuditCallEntry): Promise<void> { throw new Error('impl in worker'); }
}
```

---

## Required types (in scope-claim.ts companion)

```typescript
export interface AskResponse {
  ok: true;
  body: string;
  body_tier: Tier;
  model: string;
}

export type ApiError = {
  ok: false;
  error: { code: string; message: string };
};

export interface StatusResponse {
  ok: true;
  name: string;
  version: string;
  model: string;
  last_seen: string;
}

export interface AuditCallEntry {
  caller_agent_id: string;
  caller_tier: Tier;
  ask_max_tier: Tier;
  body_tier: Tier;
  question_length: number;
  ts: string;
}
```

---

## wrangler.jsonc additions

In the **caller's** wrangler config (e.g., `mycelia-api`):

```jsonc
{
  "services": [
    { "binding": "MIRROR", "service": "mirror-worker", "entrypoint": "MirrorApi" },
    { "binding": "GEMINI", "service": "gemini-worker", "entrypoint": "GeminiApi" },
    { "binding": "MISTRAL", "service": "mistral-worker", "entrypoint": "MistralApi" },
    { "binding": "BROOK", "service": "brook", "entrypoint": "BrookApi" }
  ]
}
```

Call site:

```typescript
const result = await env.MIRROR.ask(myScope, "review this PR");
// result.body, result.body_tier, result.model
```

In each **target Worker** (mirror-worker, gemini-worker, etc.), no special wrangler config required beyond exporting the *Api class. CF detects WorkerEntrypoint exports automatically.

---

## Error codes (added for Worker tier)

| Code | Meaning |
|---|---|
| `SCOPE_CLAIM_REQUIRED` | scope arg was null/undefined |
| `SCOPE_CLAIM_MALFORMED` | scope shape invalid |
| `INVALID_TIER` | tier or ask_max_tier value not in enum |
| `ASK_EXCEEDS_TIER` | ask_max_tier > tier |
| `STALE_CLAIM` | scope.ts is more than 1 hour old |
| `VALIDATION_ERROR` | question length/shape invalid |
| `SACRED_REFUSAL` | matched content was sacred-tier; refused at fleet boundary |
| `MODEL_ERROR` | inference failure (caller can retry) |
| `INTERNAL_ERROR` | unexpected; caller should not retry |

The `ok: true | false` discriminant lets the caller pattern-match cleanly:

```typescript
const r = await env.MIRROR.ask(scope, q);
if (!r.ok) {
  if (r.error.code === 'SACRED_REFUSAL') { /* surface to Rob */ }
  else { /* log + retry-or-fail */ }
} else {
  // use r.body
}
```

---

## What this gives us that /ask HTTPS didn't

1. **No internet attack surface.** Service Bindings cannot be reached from outside the CF account. Bearer-token-binary auth gap (F1) closes structurally for Worker-tier.
2. **No HTTP overhead.** Same isolate, same thread, same memory. Microseconds, not milliseconds.
3. **Typed contracts.** TypeScript signatures replace JSON-schema convention. Wrong shape fails at compile time, not runtime.
4. **Zero billing for cross-Worker calls.** Per CF AI: free.
5. **Scope-claim as TYPED PARAMETER.** Replaces the body-prefix `SCOPE-CLAIM:` convention with a method parameter. Much harder to "forget" to include.

---

## What this DOESN'T give us

- Claude Code instances (Leroy, Margin, CeeCee) are not Workers, so they can't be Service-Binding targets. They must remain on targeted-mycelia for directed-eventual calls.
- Cross-account calls (cohort members) are NOT possible via Service Bindings — they're same-account-only. Cohort federation stays mycelia-over-HTTPS.
- Broadcast (one-to-many) — Service Bindings are 1:1. Broadcast remains on mycelia.

---

## Migration plan

1. Author scope-claim.ts in mycelia repo, ship to npm (or copy into each Worker repo as a vendored file — npm adds complexity for an 8-agent fleet).
2. Pick pilot Worker: **mirror-worker** (smallest, most-touched, lowest blast radius if I break it).
3. Add MirrorApi class in mirror-worker, deploy.
4. Add the service binding to mycelia-api wrangler.jsonc, deploy mycelia-api.
5. Smoke test: from a curl call into mycelia-api, trigger a path that calls env.MIRROR.ask(testScope, "ping").
6. If clean, fanout to gemini-worker, mistral-worker, brook.

---

## Open questions for Margin's review

1. Should `ask()` be the only method, or should there be multiple typed entrypoints per Worker (e.g., `mirror.brainstorm()`, `mirror.copy_review()`, `mirror.second_opinion()`)? More methods = more typed contracts = stricter API but more maintenance.
2. Should the scope_claim's `signature` field be enforced at Service-Binding boundaries even though Service Bindings are internal-only? Argument for: defense in depth. Argument against: pure ceremony when the boundary is structurally untouchable from outside.
3. Should there be a Worker-side `cancel()` method so a long-running call can be aborted by the caller? Probably v2.
4. Audit logging — where do these logs go? D1? Worker observability + structured logs? R2 for long-term? Probably Worker observability for now; promote to D1 audit_log if/when needed.

---

## Related

- Spec sibling: `MYCELIA_ENVELOPE.md` (the directed-eventual side of the same axis split)
- CF AI's recommendation: `project_margin_wired_into_mycelia_20260518.md` (the CF AI analysis that landed on Service Bindings)
- The 2x2 quadrant model that produced this: combined redteam, Margin + Leroy 2026-05-18
- CF docs: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
