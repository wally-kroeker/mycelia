import { createMiddleware } from 'hono/factory';
import type { Env, AuthContext } from '../types';

interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'agent.register': { limit: 5, windowSeconds: 3600 },
  'request.create': { limit: 20, windowSeconds: 3600 },
  'claim.create': { limit: 30, windowSeconds: 3600 },
  'response.create': { limit: 20, windowSeconds: 3600 },
  'rating.create': { limit: 30, windowSeconds: 3600 },
  'read': { limit: 120, windowSeconds: 60 },
  'feed': { limit: 60, windowSeconds: 60 },
  'key.rotate': { limit: 3, windowSeconds: 3600 },
};

export function rateLimit(category: string) {
  const config = RATE_LIMITS[category];
  if (!config) throw new Error(`Unknown rate limit category: ${category}`);

  return createMiddleware<{ Bindings: Env; Variables: { auth: AuthContext } }>(
    async (c, next) => {
      const auth = c.get('auth');
      const key = `${auth.agent_id}:${category}`;
      const windowStart = Math.floor(Date.now() / (config.windowSeconds * 1000));

      // Atomic upsert: increment within the current window; reset on window
      // rollover. D1 serializes writes, so no lost-update race is possible.
      // The CASE expression resets count to 1 when the stored window_start
      // differs from the incoming window — same semantics as KV TTL expiry.
      //
      // Table size is bounded: one row per (agent_id, category) pair; the
      // window_start column is updated in-place rather than inserting a new
      // row per window. No cleanup job is needed.
      const row = await c.env.DB.prepare(
        `INSERT INTO rate_limits (key, count, window_start)
         VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = excluded.window_start
                        THEN rate_limits.count + 1
                        ELSE 1 END,
           window_start = excluded.window_start
         RETURNING count`
      ).bind(key, windowStart).first<{ count: number }>();

      const current = row?.count ?? 1;

      if (current > config.limit) {
        const resetTime = (windowStart + 1) * config.windowSeconds;
        c.header('X-RateLimit-Limit', String(config.limit));
        c.header('X-RateLimit-Remaining', '0');
        c.header('X-RateLimit-Reset', String(resetTime));

        return c.json({
          ok: false,
          error: { code: 'RATE_LIMITED', message: `Rate limit exceeded. Try again later.` },
          meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
        }, 429);
      }

      c.header('X-RateLimit-Limit', String(config.limit));
      c.header('X-RateLimit-Remaining', String(config.limit - current));

      await next();
    }
  );
}
