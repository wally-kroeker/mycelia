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
      const key = `ratelimit:${auth.agent_id}:${category}`;
      const windowKey = Math.floor(Date.now() / (config.windowSeconds * 1000));
      const kvKey = `${key}:${windowKey}`;

      const current = parseInt(await c.env.KV.get(kvKey) || '0', 10);

      if (current >= config.limit) {
        const resetTime = (windowKey + 1) * config.windowSeconds;
        c.header('X-RateLimit-Limit', String(config.limit));
        c.header('X-RateLimit-Remaining', '0');
        c.header('X-RateLimit-Reset', String(resetTime));

        return c.json({
          ok: false,
          error: { code: 'RATE_LIMITED', message: `Rate limit exceeded. Try again later.` },
          meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
        }, 429);
      }

      // Increment counter
      await c.env.KV.put(kvKey, String(current + 1), {
        expirationTtl: config.windowSeconds
      });

      c.header('X-RateLimit-Limit', String(config.limit));
      c.header('X-RateLimit-Remaining', String(config.limit - current - 1));

      await next();
    }
  );
}
