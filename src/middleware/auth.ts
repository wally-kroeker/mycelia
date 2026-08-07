import { createMiddleware } from 'hono/factory';
import type { Env, AuthContext, AgentTier } from '../types';

/**
 * Generate a new API key for an agent.
 * Returns { key, hash, prefix } — key shown once, hash stored, prefix for lookup.
 *
 * Observer key type removed in Phase 3 (fleet-coordination-v1): no route ever
 * called generateApiKey('observer'), and observer-prefixed keys 401 on lookup
 * (no agents row). Cleaning up the dead branch here.
 */
export async function generateApiKey(): Promise<{
  key: string;
  hash: string;
  prefix: string;
}> {
  const prefix = 'mycelia_live_';
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const randomPart = Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const key = `${prefix}${randomPart}`;

  const hash = await hashApiKey(key);
  const keyPrefix = key.substring(0, prefix.length + 8); // prefix + 8 chars

  return { key, hash, prefix: keyPrefix };
}

/**
 * Hash an API key using SHA-256.
 * (bcrypt not available in Workers runtime — SHA-256 is sufficient for API keys)
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Auth middleware — validates Authorization: Bearer header.
 * Sets AuthContext on Hono context for downstream handlers.
 */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: { auth: AuthContext } }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
      }, 401);
    }

    const key = authHeader.slice(7);
    const keyType = getKeyType(key);

    if (!keyType) {
      return c.json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid API key format' },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
      }, 401);
    }

    const hash = await hashApiKey(key);
    const prefix = key.substring(0, key.indexOf('_', key.indexOf('_') + 1) + 1 + 8);

    // Look up agent by key prefix, then verify hash.
    // agent_tier is loaded here so enforcement points (ops-bus gate, etc.) need no second query.
    const agent = await c.env.DB.prepare(
      'SELECT id, owner_id, api_key_hash, status, agent_tier FROM agents WHERE key_prefix = ?'
    ).bind(prefix).first<{ id: string; owner_id: string; api_key_hash: string; status: string; agent_tier: AgentTier }>();

    if (!agent || agent.api_key_hash !== hash) {
      return c.json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
      }, 401);
    }

    if (agent.status !== 'active') {
      return c.json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Agent is suspended or deactivated' },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
      }, 403);
    }

    // Update last_seen_at
    await c.env.DB.prepare(
      'UPDATE agents SET last_seen_at = ? WHERE id = ?'
    ).bind(new Date().toISOString(), agent.id).run();

    c.set('auth', {
      agent_id: agent.id,
      key_type: keyType,
      owner_id: agent.owner_id,
      // agent_tier: loaded at auth time — no second query at enforcement points.
      // Defaults to 'peer' for agents registered before migration 0008.
      agent_tier: agent.agent_tier ?? 'peer',
    });

    await next();
  }
);

/**
 * Middleware that requires a valid agent key.
 * Enforces B8 kill-switch: revoked agents fail every action.
 *
 * KV fail behavior is mode-aware (see fleet-gate.ts):
 *  - fleet/company: KV error → 503 (fail-closed; revocation bypass is unacceptable).
 *  - community: KV error → pass (fail-open; KV outage does not take down the network).
 *
 * Note: the observer key_type check was removed in Phase 3 cleanup. Observer-prefixed
 * keys return 401 from authMiddleware (no agents row for that prefix). The
 * auth.key_type === 'observer' branch was unreachable. See getKeyType() below.
 */
export const requireAgentKey = createMiddleware<{ Bindings: Env; Variables: { auth: AuthContext } }>(
  async (c, next) => {
    const auth = c.get('auth');

    // B8 kill-switch (2026-05-18): revoked agents cannot act, period.
    // Self-revoke + admin-revoke handled in /routes/agents.ts.
    // Failure mode is now mode-aware via fleet-gate: fleet/company fail-closed, community fail-open.
    try {
      const { checkRevocationWithMode } = await import('./fleet-gate');
      const mode = (c.env.MODE ?? 'community') as import('./fleet-gate').NodeMode;
      const result = await checkRevocationWithMode(c.env.KV, auth.agent_id, mode);
      if ('revoked' in result && result.revoked === true) {
        const entry = (result as { revoked: true; entry: import('../lib/revocation').RevocationEntry }).entry;
        return c.json({
          ok: false,
          error: {
            code: 'AGENT_REVOKED',
            message: `Agent ${auth.agent_id} is revoked (${entry.reason}).${entry.revoke_until ? ` Auto-lift at ${entry.revoke_until}.` : ' Until admin lifts.'}`,
          },
          meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
        }, 403);
      }
      // kvError with revoked: false = community fail-open — fall through silently.
    } catch {
      // fleet/company: checkRevocationWithMode re-throws on KV error (fail-closed).
      // Return 503 so the request is rejected rather than silently bypassing revocation.
      return c.json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Revocation service unavailable. Request rejected to prevent revocation bypass.',
        },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
      }, 503);
    }

    await next();
  }
);

// Observer key prefix ('mycelia_obs_') removed in Phase 3. Any key with that prefix
// now returns null here and gets 401 'Invalid API key format'. No observer keys were
// ever registered in the agents table; this cleanup removes dead detection logic.
function getKeyType(key: string): 'agent' | null {
  if (key.startsWith('mycelia_live_') || key.startsWith('mycelia_test_')) return 'agent';
  return null;
}
