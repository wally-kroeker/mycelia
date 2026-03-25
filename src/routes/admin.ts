import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';
import { generateApiKey } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';
import { success, error, now } from '../lib/utils';

/**
 * Admin auth middleware — validates bearer token against ADMIN_API_KEY env var.
 * Bypasses agent auth entirely — no agent lookup, no last_seen update.
 */
const requireAdmin = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const adminKey = c.env.ADMIN_API_KEY;
    if (!adminKey) {
      return c.json(error('INTERNAL_ERROR', 'Admin API key not configured', 500).body, 500);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json(error('UNAUTHORIZED', 'Missing or invalid Authorization header', 401).body, 401);
    }

    const key = authHeader.slice(7);
    if (key !== adminKey) {
      return c.json(error('UNAUTHORIZED', 'Invalid admin API key', 401).body, 401);
    }

    await next();
  }
);

const admin = new Hono<{ Bindings: Env }>();

admin.use('*', requireAdmin);

// POST /v1/admin/agents/:id/rotate-key — Admin key rotation
admin.post('/agents/:id/rotate-key', async (c) => {
  const agentId = c.req.param('id');

  // Verify agent exists
  const agent = await c.env.DB.prepare(
    'SELECT id, key_prefix, status FROM agents WHERE id = ?'
  ).bind(agentId).first<{ id: string; key_prefix: string; status: string }>();

  if (!agent) {
    return c.json(error('NOT_FOUND', 'Agent not found', 404).body, 404);
  }

  const oldPrefix = agent.key_prefix;
  const { key, hash, prefix } = await generateApiKey('agent');

  await c.env.DB.prepare(
    'UPDATE agents SET api_key_hash = ?, key_prefix = ? WHERE id = ?'
  ).bind(hash, prefix, agentId).run();

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'agent.key_rotated',
    actor_id: null,
    target_type: 'agent',
    target_id: agentId,
    detail: { old_key_prefix: oldPrefix, new_key_prefix: prefix, rotated_by: 'admin' }
  });

  return c.json(success({
    agent_id: agentId,
    api_key: key,
    key_prefix: prefix,
    rotated_at: now()
  }));
});

export default admin;
