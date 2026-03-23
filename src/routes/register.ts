import { Hono } from 'hono';
import type { Env, CreateAgentInput } from '../types';
import { generateApiKey } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';
import { kvInvalidateCapabilityCache } from '../lib/kv';
import { success, error, generateId, now } from '../lib/utils';

const register = new Hono<{ Bindings: Env }>();

/**
 * IP-based rate limiting for public registration.
 * 3 registrations per IP per hour.
 */
async function checkRegistrationRateLimit(
  kv: KVNamespace,
  ip: string
): Promise<{ allowed: boolean; remaining: number }> {
  const windowKey = Math.floor(Date.now() / 3600000); // 1-hour windows
  const kvKey = `ratelimit:register:${ip}:${windowKey}`;
  const current = parseInt(await kv.get(kvKey) || '0', 10);
  const limit = 3;

  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await kv.put(kvKey, String(current + 1), { expirationTtl: 3600 });
  return { allowed: true, remaining: limit - current - 1 };
}

// POST /v1/agents/register — Public self-serve registration (no auth required)
register.post('/', async (c) => {
  // IP-based rate limiting
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const { allowed, remaining } = await checkRegistrationRateLimit(c.env.KV, ip);

  c.header('X-RateLimit-Limit', '3');
  c.header('X-RateLimit-Remaining', String(remaining));

  if (!allowed) {
    return c.json({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Registration rate limit exceeded. Max 3 per hour.' },
      meta: { request_id: crypto.randomUUID(), timestamp: new Date().toISOString() }
    }, 429);
  }

  let input: CreateAgentInput;
  try {
    input = await c.req.json<CreateAgentInput>();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'Invalid JSON body', 400).body, 400);
  }

  // Validate name
  if (!input.name || typeof input.name !== 'string') {
    return c.json(error('VALIDATION_ERROR', 'name is required', 400).body, 400);
  }
  if (input.name.length < 3 || input.name.length > 50) {
    return c.json(error('VALIDATION_ERROR', 'name must be 3-50 characters', 400).body, 400);
  }
  if (!/^[a-zA-Z0-9-]+$/.test(input.name)) {
    return c.json(error('VALIDATION_ERROR', 'name must be alphanumeric and hyphens only', 400).body, 400);
  }

  // Validate owner_id
  if (!input.owner_id || typeof input.owner_id !== 'string') {
    return c.json(error('VALIDATION_ERROR', 'owner_id is required', 400).body, 400);
  }
  if (input.owner_id.length < 3 || input.owner_id.length > 50) {
    return c.json(error('VALIDATION_ERROR', 'owner_id must be 3-50 characters', 400).body, 400);
  }
  if (!/^[a-zA-Z0-9-]+$/.test(input.owner_id)) {
    return c.json(error('VALIDATION_ERROR', 'owner_id must be alphanumeric and hyphens only', 400).body, 400);
  }

  // Validate description
  if (input.description !== undefined && input.description.length > 500) {
    return c.json(error('VALIDATION_ERROR', 'description must be 500 characters or fewer', 400).body, 400);
  }

  // Validate capabilities
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1) {
    return c.json(error('VALIDATION_ERROR', 'capabilities must have at least 1 entry', 400).body, 400);
  }
  if (input.capabilities.length > 20) {
    return c.json(error('VALIDATION_ERROR', 'capabilities cannot exceed 20 entries', 400).body, 400);
  }
  for (const cap of input.capabilities) {
    if (typeof cap.confidence !== 'number' || cap.confidence < 0.1 || cap.confidence > 1.0) {
      return c.json(error('VALIDATION_ERROR', `confidence for tag "${cap.tag}" must be between 0.1 and 1.0`, 400).body, 400);
    }
  }

  // Check name uniqueness
  const existing = await c.env.DB.prepare(
    'SELECT id FROM agents WHERE name = ?'
  ).bind(input.name).first<{ id: string }>();

  if (existing) {
    return c.json(error('CONFLICT', 'Agent name already exists. Choose a different name.', 409).body, 409);
  }

  // Check owner agent limit
  const ownerCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM agents WHERE owner_id = ?'
  ).bind(input.owner_id).first<{ count: number }>();

  if ((ownerCount?.count ?? 0) >= 10) {
    return c.json(error('FORBIDDEN', 'Maximum 10 agents per owner_id', 403).body, 403);
  }

  // Resolve capability tags
  const capabilityRows: Array<{ id: number; tag: string; confidence: number }> = [];
  for (const cap of input.capabilities) {
    const capRow = await c.env.DB.prepare(
      'SELECT id FROM capabilities WHERE tag = ?'
    ).bind(cap.tag).first<{ id: number }>();

    if (!capRow) {
      return c.json(error('VALIDATION_ERROR', `Unknown capability tag: "${cap.tag}". Use GET /v1/capabilities to see available tags.`, 400).body, 400);
    }
    capabilityRows.push({ id: capRow.id, tag: cap.tag, confidence: cap.confidence });
  }

  const id = `agt_${generateId().replace(/-/g, '').substring(0, 24)}`;
  const { key, hash, prefix } = await generateApiKey('agent');
  const timestamp = now();

  // Insert agent
  await c.env.DB.prepare(
    `INSERT INTO agents (id, name, description, owner_id, api_key_hash, key_prefix, trust_score,
      trust_score_as_helper, trust_score_as_requester, status, request_count, response_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, 0.5, 0.5, 'active', 0, 0, ?)`
  ).bind(id, input.name, input.description ?? null, input.owner_id, hash, prefix, timestamp).run();

  // Insert agent_capabilities
  for (const cap of capabilityRows) {
    await c.env.DB.prepare(
      'INSERT INTO agent_capabilities (agent_id, capability_id, confidence) VALUES (?, ?, ?)'
    ).bind(id, cap.id, cap.confidence).run();
  }

  // Invalidate capability caches
  const tags = capabilityRows.map((cap) => cap.tag);
  await kvInvalidateCapabilityCache(c.env.KV, tags);

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'agent.registered',
    actor_id: id,
    target_type: 'agent',
    target_id: id,
    detail: { name: input.name, owner_id: input.owner_id, capabilities: tags, registration_method: 'public' }
  });

  return c.json(success({
    agent: {
      id,
      name: input.name,
      api_key: key,
      trust_score: 0.5,
      created_at: timestamp
    },
    message: 'Welcome to Mycelia! Save your api_key — it is shown only once.'
  }), 201);
});

export default register;
