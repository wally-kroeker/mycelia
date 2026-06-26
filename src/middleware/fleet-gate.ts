// src/middleware/fleet-gate.ts
// Centralizes all mode-dependent behavior for the three-mode trust spectrum.
//
// Routes import helpers from here — no raw `if(env.MODE)` scattered in route files.
// The MODE env var is the single source of truth; this file is the single door.
//
// Trust spectrum (§3.2):
//   fleet     — one principal's own agents; trust implicit, revocation is the control.
//   company   — one org, many employees' own agents; community trust enforcement +
//               fleet tenancy/registration/feed scoping.
//   community — open/public; full trust system load-bearing (default, backward-compat).

import type { Context, Next } from 'hono';
import type { Env, AuthContext } from '../types';
import { checkRevoked, type RevocationEntry } from '../lib/revocation';

export type NodeMode = 'fleet' | 'company' | 'community';

// ═══ Startup validation ═══════════════════════════════════════════════════════

/**
 * Validate MODE at startup — fail-closed on unset or invalid value.
 * Call once in index.ts fetch handler before any route logic runs.
 * Throws on invalid MODE so the Worker returns a 500 rather than serving in
 * an unknown trust state.
 */
export function validateMode(env: Env): NodeMode {
  const mode = env.MODE;
  if (!mode || !['fleet', 'company', 'community'].includes(mode)) {
    throw new Error(
      `Mycelia: invalid or missing MODE env var (got: "${mode ?? 'undefined'}"). ` +
      `Set MODE to 'fleet', 'company', or 'community' in wrangler.toml [vars] or [env.X.vars]. ` +
      `Node refuses to start without a valid MODE — fail-closed.`
    );
  }
  return mode as NodeMode;
}

// ═══ Feature-matrix helpers ═══════════════════════════════════════════════════
//
// Each helper maps to one row in the feature matrix (§3.2 table).
// All accept a NodeMode to keep them pure and unit-testable.

/**
 * Registration gate — true if public self-serve and key-gated registration
 * are restricted to ADMIN_OWNER_ID.
 * fleet + company = private nodes, owner-only registration.
 */
export function isRegistrationRestricted(mode: NodeMode): boolean {
  return mode === 'fleet' || mode === 'company';
}

/**
 * Trust gate — true if the ≥0.6 high-priority trust requirement is relaxed.
 * fleet only: all agents are the owner's own; trust is implicit.
 * company + community: trust remains load-bearing (earned/managed).
 */
export function isTrustGateRelaxed(mode: NodeMode): boolean {
  return mode === 'fleet';
}

/**
 * Scope-claim enforcement — true if the v1.1 grace period bypass is closed
 * and scope_claim is strictly required.
 * fleet + company = private nodes where identity envelopes are always expected.
 */
export function isScopeClaimEnforced(mode: NodeMode): boolean {
  return mode === 'fleet' || mode === 'company';
}

/**
 * Feed scoping — true if GET /v1/feed returns only events from agents
 * belonging to the requesting agent's owner_id, rather than the global feed.
 * fleet + company = private nodes where cross-org event visibility is unwanted.
 */
export function isFeedScoped(mode: NodeMode): boolean {
  return mode === 'fleet' || mode === 'company';
}

/**
 * KV fail-closed — true if a KV error during revocation check causes a
 * 503 (refuse to serve) rather than fail-open (silently skip).
 * fleet + company = private nodes where a KV outage must never silently
 * bypass revocation. Security over availability.
 */
export function isKvFailClosed(mode: NodeMode): boolean {
  return mode === 'fleet' || mode === 'company';
}

/**
 * Read revocation enforcement — true if read-only routes (GET) must also
 * honor revocation checks, closing the "read-bypass" gap where revoked
 * agents can still read data.
 * fleet + company = private nodes where revocation is a real security control.
 */
export function isReadRevocationEnforced(mode: NodeMode): boolean {
  return mode === 'fleet' || mode === 'company';
}

// ═══ Middleware ════════════════════════════════════════════════════════════════

/**
 * Hono middleware: block public self-serve registration on fleet/company nodes.
 * Mount at the top of the register.ts POST handler.
 * In community mode, passes through immediately (no-op).
 */
export const registrationGate = async (
  c: Context<{ Bindings: Env; Variables: { auth?: AuthContext } }>,
  next: Next
): Promise<Response | void> => {
  const mode = (c.env.MODE ?? 'community') as NodeMode;
  if (isRegistrationRestricted(mode)) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message:
            `Public registration is disabled on this node (MODE=${mode}). ` +
            `Contact the node operator to have your agent registered.`,
        },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() },
      },
      403
    );
  }
  await next();
};

// ═══ Revocation with mode-aware fail behavior ══════════════════════════════════

export type RevocationResult =
  | { revoked: true; entry: RevocationEntry }
  | { revoked: false }
  | { kvError: true }; // only returned in fail-open mode; fleet/company throws

/**
 * Check revocation with mode-aware failure behavior.
 *
 * - On KV error in fleet/company mode: throws (callers should return 503).
 * - On KV error in community mode: returns { revoked: false } (fail-open, current behavior).
 * - On clean result: returns { revoked: true, entry } or { revoked: false }.
 */
export async function checkRevocationWithMode(
  kv: KVNamespace,
  agentId: string,
  mode: NodeMode
): Promise<RevocationResult> {
  try {
    const entry = await checkRevoked(kv, agentId);
    if (entry) return { revoked: true, entry };
    return { revoked: false };
  } catch (err) {
    if (isKvFailClosed(mode)) {
      // Re-throw — caller must surface a 503 so revocation bypass is impossible.
      throw err;
    }
    // Community: fail-open (KV outage does not take down the network).
    return { kvError: true, revoked: false } as RevocationResult;
  }
}
