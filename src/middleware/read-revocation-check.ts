// src/middleware/read-revocation-check.ts
//
// Hono middleware: enforce read revocation on GET routes.
// Closes the "read-bypass" gap (fleet-coordination-v1, Phase 1) where revoked
// agents in fleet/company mode could still read requests, capabilities, and the feed.
//
// Wired to: GET /v1/requests, GET /v1/requests/:id, GET /v1/capabilities, GET /v1/feed
//
// Design:
//   community mode — fail-open: pass through without checking. See the community
//     fail-open design note in openspec/changes/fleet-coordination-v1/proposal.md
//     for the rationale and the conditions under which this decision should be revisited.
//   fleet/company mode — enforced: revoked agents get 403 AGENT_REVOKED; KV error
//     gets 503 INTERNAL_ERROR (fail-closed, consistent with existing write-path
//     behavior in authMiddleware).
//   observer keys — pass through: observer keys are rejected by authMiddleware before
//     this middleware runs (no agents row → 401). Branch is unreachable; kept for
//     explicit documentation of intent. See observer deprecation in Phase 3.

import type { Context, Next } from 'hono';
import type { Env, AuthContext } from '../types';
import {
  isReadRevocationEnforced,
  checkRevocationWithMode,
  type NodeMode,
  type RevocationResult,
} from './fleet-gate';

export async function readRevocationCheck(
  c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  next: Next
): Promise<Response | void> {
  const mode = (c.env.MODE ?? 'community') as NodeMode;

  // community mode: fail-open (no revocation check on reads)
  if (!isReadRevocationEnforced(mode)) {
    return next();
  }

  const auth = c.get('auth');

  // observer keys cannot pass authMiddleware (no agents row → 401 before we run).
  // Pass through here for explicit documentation; this branch is unreachable until
  // Phase 3 formally removes observer key support.
  if (auth.key_type === 'observer') {
    return next();
  }

  try {
    const result: RevocationResult = await checkRevocationWithMode(c.env.KV, auth.agent_id, mode);
    if ('revoked' in result && result.revoked === true) {
      const { entry } = result as Extract<RevocationResult, { revoked: true }>;
      return c.json(
        {
          ok: false,
          error: {
            code: 'AGENT_REVOKED',
            message: `Agent ${auth.agent_id} is revoked (${entry.reason}).${
              entry.revoke_until ? ` Auto-lift at ${entry.revoke_until}.` : ' Until admin lifts.'
            }`,
          },
          meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() },
        },
        403
      );
    }
    // result.revoked === false: active agent, pass through.
    // kvError with revoked: false: community fail-open, already handled by
    // isReadRevocationEnforced returning false for community. This branch is
    // unreachable because fleet/company throws on KV error (caught below).
  } catch {
    // fleet/company: checkRevocationWithMode re-throws on KV error (fail-closed).
    // Return 503 so the read is rejected rather than silently bypassing revocation.
    return c.json(
      {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Revocation service unavailable. Request rejected to prevent revocation bypass.',
        },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() },
      },
      503
    );
  }

  return next();
}
