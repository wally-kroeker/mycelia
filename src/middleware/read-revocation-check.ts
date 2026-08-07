// src/middleware/read-revocation-check.ts
//
// Hono middleware: enforce read revocation on GET routes.
// Closes the "read-bypass" gap (fleet-coordination-v1, Phase 1) where revoked
// agents could still read requests, capabilities, and the feed.
//
// Wired to: GET /v1/requests, GET /v1/requests/:id, GET /v1/capabilities, GET /v1/feed
//
// Design:
//   All modes: revoked agent → 403 AGENT_REVOKED (KV is healthy, we know, we act).
//   fleet/company: KV error → 503 INTERNAL_ERROR (fail-closed; security over availability).
//   community: KV error → pass through (fail-open; a KV outage must not take down
//     a public community node for all non-revoked agents). This is the only
//     mode-conditional behavior. The fail-open on KV error is already implemented
//     inside checkRevocationWithMode — no separate community branch is needed here.
//
// Phase 3 cleanups applied here:
//   - Observer key branch removed (Phase 3 observer deprecation). Observer keys now
//     return 401 from authMiddleware before this middleware runs (no agents row for
//     the mycelia_obs_ prefix). The branch was already unreachable.
//   - isReadRevocationEnforced() from fleet-gate.ts removed (dead code). That function
//     returned false for community mode and conflated "should we check?" with "what do
//     we do on KV error?". The check itself runs in all modes; only the error behavior
//     is mode-conditional, handled inside checkRevocationWithMode.

import type { Context, Next } from 'hono';
import type { Env, AuthContext } from '../types';
import {
  checkRevocationWithMode,
  type NodeMode,
  type RevocationResult,
} from './fleet-gate';

export async function readRevocationCheck(
  c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  next: Next
): Promise<Response | void> {
  const mode = (c.env.MODE ?? 'community') as NodeMode;
  const auth = c.get('auth');

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
    // result.revoked === false in two cases:
    //   1. Active agent (KV healthy) → pass through.
    //   2. Community + KV error → checkRevocationWithMode returns {kvError: true, revoked: false}
    //      rather than throwing (fail-open for public nodes). Pass through.
    // fleet/company + KV error throws instead — caught below.
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
