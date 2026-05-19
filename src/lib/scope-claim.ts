// src/lib/scope-claim.ts
// Scope-claim envelope types and validation for mycelia v1.1 + Service Bindings.
// Companion spec: docs/specs/MYCELIA_ENVELOPE.md
// F1 cheap-fix lineage: from the combined redteam (project-fleet-access-redteam-combined-20260518).

/**
 * Tier hierarchy (top is most restrictive).
 *
 * sacred   — Rob + per-item consent only. NEVER over mycelia.
 * intimate — Rob + named fleet. AEBS work-internal. Private in-flight decisions.
 * cohort   — fleet-internal doctrine, technical specs, project memories.
 * public   — NWS essays, doctrine docs, pack source, anything published.
 */
export type Tier = 'public' | 'cohort' | 'intimate' | 'sacred';

const TIER_RANK: Record<Tier, number> = {
  public: 0,
  cohort: 1,
  intimate: 2,
  sacred: 3,
};

const TIER_VALUES: readonly Tier[] = ['public', 'cohort', 'intimate', 'sacred'] as const;

/**
 * The structured envelope every v1.1 mycelia request must carry.
 * Spec: docs/specs/MYCELIA_ENVELOPE.md
 */
export interface ScopeClaim {
  /** Human-readable agent name (e.g., "leroy", "margin"). Logs only, not auth. */
  requester: string;

  /** Requesting agent's UUID. MUST match bearer token's resolved agent. */
  agent_id: string;

  /** Requester's own clearance tier. */
  tier: Tier;

  /**
   * Maximum tier of content the requester wants surfaced in responses.
   * MUST be <= tier. Allows deliberately asking for lower-tier responses
   * when the result will be shared more widely than the requester's clearance.
   */
  ask_max_tier: Tier;

  /** ISO-8601 timestamp when the claim was constructed. >1h old = stale. */
  ts: string;

  /**
   * Reserved for future signed-claim support. When present, will be
   * Ed25519 signature over (requester|agent_id|tier|ask_max_tier|ts)
   * by the agent's instance key. Spec'd, not yet enforced.
   */
  signature?: string;
}

export type ValidationResult =
  | { ok: true; claim: ScopeClaim }
  | { ok: false; code: ScopeClaimErrorCode; message: string };

export type ScopeClaimErrorCode =
  | 'SCOPE_CLAIM_REQUIRED'
  | 'SCOPE_CLAIM_MALFORMED'
  | 'INVALID_TIER'
  | 'ASK_EXCEEDS_TIER'
  | 'IDENTITY_MISMATCH'
  | 'STALE_CLAIM'
  | 'INVALID_SIGNATURE';

/** Maximum age of a scope_claim.ts before it's considered stale. */
const STALE_CLAIM_MS = 60 * 60 * 1000; // 1 hour

/**
 * Validate a raw scope_claim object against the v1.1 contract.
 *
 * @param raw   The parsed JSON object (from request body).
 * @param bearerAgentId  The agent_id resolved from the bearer token (auth layer).
 *                       Pass null if you want to skip identity-mismatch check
 *                       (e.g. testing).
 * @param now   Unix ms timestamp for "now"; defaults to Date.now(). Injectable for tests.
 */
export function validateScopeClaim(
  raw: unknown,
  bearerAgentId: string | null,
  now: number = Date.now(),
): ValidationResult {
  if (raw == null) {
    return {
      ok: false,
      code: 'SCOPE_CLAIM_REQUIRED',
      message: 'scope_claim is required in v1.1; see docs/specs/MYCELIA_ENVELOPE.md',
    };
  }

  if (typeof raw !== 'object') {
    return {
      ok: false,
      code: 'SCOPE_CLAIM_MALFORMED',
      message: 'scope_claim must be a JSON object',
    };
  }

  const c = raw as Partial<ScopeClaim>;

  if (typeof c.requester !== 'string' || c.requester.length === 0) {
    return { ok: false, code: 'SCOPE_CLAIM_MALFORMED', message: 'scope_claim.requester must be a non-empty string' };
  }
  if (typeof c.agent_id !== 'string' || c.agent_id.length === 0) {
    return { ok: false, code: 'SCOPE_CLAIM_MALFORMED', message: 'scope_claim.agent_id must be a non-empty string' };
  }
  if (typeof c.tier !== 'string' || !TIER_VALUES.includes(c.tier as Tier)) {
    return { ok: false, code: 'INVALID_TIER', message: `scope_claim.tier must be one of ${TIER_VALUES.join(', ')}` };
  }
  if (typeof c.ask_max_tier !== 'string' || !TIER_VALUES.includes(c.ask_max_tier as Tier)) {
    return { ok: false, code: 'INVALID_TIER', message: `scope_claim.ask_max_tier must be one of ${TIER_VALUES.join(', ')}` };
  }
  if (typeof c.ts !== 'string' || c.ts.length === 0) {
    return { ok: false, code: 'SCOPE_CLAIM_MALFORMED', message: 'scope_claim.ts must be an ISO-8601 timestamp string' };
  }

  // Identity match
  if (bearerAgentId != null && c.agent_id !== bearerAgentId) {
    return {
      ok: false,
      code: 'IDENTITY_MISMATCH',
      message: `scope_claim.agent_id (${c.agent_id}) does not match bearer token's agent (${bearerAgentId})`,
    };
  }

  // ask_max_tier must be <= tier
  if (TIER_RANK[c.ask_max_tier as Tier] > TIER_RANK[c.tier as Tier]) {
    return {
      ok: false,
      code: 'ASK_EXCEEDS_TIER',
      message: `scope_claim.ask_max_tier (${c.ask_max_tier}) cannot exceed scope_claim.tier (${c.tier})`,
    };
  }

  // Stale check
  const claimTime = Date.parse(c.ts);
  if (isNaN(claimTime)) {
    return { ok: false, code: 'SCOPE_CLAIM_MALFORMED', message: 'scope_claim.ts could not be parsed as a date' };
  }
  if (now - claimTime > STALE_CLAIM_MS) {
    return {
      ok: false,
      code: 'STALE_CLAIM',
      message: `scope_claim.ts is more than 1 hour old (${Math.round((now - claimTime) / 60000)} min); replay protection rejected this claim`,
    };
  }

  return {
    ok: true,
    claim: {
      requester: c.requester,
      agent_id: c.agent_id,
      tier: c.tier as Tier,
      ask_max_tier: c.ask_max_tier as Tier,
      ts: c.ts,
      signature: typeof c.signature === 'string' ? c.signature : undefined,
    },
  };
}

/**
 * Check whether a holder of `holderTier` may access content classified as `contentTier`.
 * Read rule: tier X may read content at tier X and below.
 */
export function permits(holderTier: Tier, contentTier: Tier): boolean {
  return TIER_RANK[holderTier] >= TIER_RANK[contentTier];
}

/**
 * Compare two tiers. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareTiers(a: Tier, b: Tier): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

/**
 * Sacred-tier content NEVER traverses mycelia (handler discipline rule).
 * Helper to make the check explicit at call sites.
 */
export function refusalRequiredForMycelia(contentTier: Tier): boolean {
  return contentTier === 'sacred';
}

/**
 * Construct a fresh ScopeClaim. Convenience for clients.
 */
export function buildScopeClaim(args: {
  requesterName: string;
  agentId: string;
  tier: Tier;
  askMaxTier?: Tier; // defaults to tier (ask for the max you hold)
}): ScopeClaim {
  return {
    requester: args.requesterName,
    agent_id: args.agentId,
    tier: args.tier,
    ask_max_tier: args.askMaxTier ?? args.tier,
    ts: new Date().toISOString(),
  };
}
