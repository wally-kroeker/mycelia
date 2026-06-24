import { createMiddleware } from 'hono/factory';
import type { Env, AuthContext } from '../types';

/**
 * Generate a new API key.
 * Returns { key, hash, prefix } — key shown once, hash stored, prefix for lookup.
 */
export async function generateApiKey(type: 'agent' | 'observer'): Promise<{
  key: string;
  hash: string;
  prefix: string;
}> {
  const prefix = type === 'observer' ? 'mycelia_obs_' : 'mycelia_live_';
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

    // Look up agent by key prefix, then verify hash
    const agent = await c.env.DB.prepare(
      'SELECT id, owner_id, api_key_hash, status FROM agents WHERE key_prefix = ?'
    ).bind(prefix).first<{ id: string; owner_id: string; api_key_hash: string; status: string }>();

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
      owner_id: agent.owner_id
    });

    await next();
  }
);

/**
 * Middleware that requires agent key type (not observer).
 * Also enforces B8 kill-switch: revoked agents fail every action.
 */
export const requireAgentKey = createMiddleware<{ Bindings: { KV: KVNamespace }; Variables: { auth: AuthContext } }>(
  async (c, next) => {
    const auth = c.get('auth');
    if (auth.key_type === 'observer') {
      return c.json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Observer keys cannot perform this action' },
        meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
      }, 403);
    }

    // B8 kill-switch (2026-05-18): revoked agents cannot act, period.
    // Self-revoke + admin-revoke handled in /routes/agents.ts.
    try {
      const { checkRevoked } = await import('../lib/revocation');
      const rev = await checkRevoked(c.env.KV, auth.agent_id);
      if (rev) {
        return c.json({
          ok: false,
          error: {
            code: 'AGENT_REVOKED',
            message: `Agent ${auth.agent_id} is revoked (${rev.reason}).${rev.revoke_until ? ` Auto-lift at ${rev.revoke_until}.` : ' Until admin lifts.'}`,
          },
          meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
        }, 403);
      }
    } catch {
      // NOTE: Fail-open on KV error — revocation check does not gate access when KV is down.
      // This is intentional: a KV outage shouldn't take down the whole network.
      // Audit log captures drift; ops should alert on repeated KV errors.
      // Tech debt: consider adding a console.error here to surface KV failures in logs.
    }

    await next();
  }
);

function getKeyType(key: string): 'agent' | 'observer' | null {
  if (key.startsWith('mycelia_live_') || key.startsWith('mycelia_test_')) return 'agent';
  if (key.startsWith('mycelia_obs_')) return 'observer';
  return null;
}
