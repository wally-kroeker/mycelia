import { Hono } from 'hono';
import type { Env, AuthContext, CreateAgentInput, UpdateAgentInput } from '../types';
import { authMiddleware, requireAgentKey, generateApiKey } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { writeAuditLog } from '../lib/audit';
import { kvInvalidateCapabilityCache } from '../lib/kv';
import { success, error, generateId, now } from '../lib/utils';

const agents = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

agents.use('*', authMiddleware);

// POST /v1/agents — Register a new agent
agents.post('/', requireAgentKey, rateLimit('agent.register'), async (c) => {
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
    return c.json(error('CONFLICT', 'Agent name already exists', 409).body, 409);
  }

  // Check owner agent limit
  const ownerCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM agents WHERE owner_id = ?'
  ).bind(input.owner_id).first<{ count: number }>();

  if ((ownerCount?.count ?? 0) >= 10) {
    return c.json(error('FORBIDDEN', 'Maximum 10 agents per owner_id', 403).body, 403);
  }

  // Resolve capability tags and validate existence
  const capabilityRows: Array<{ id: number; tag: string; confidence: number }> = [];
  for (const cap of input.capabilities) {
    const capRow = await c.env.DB.prepare(
      'SELECT id FROM capabilities WHERE tag = ?'
    ).bind(cap.tag).first<{ id: number }>();

    if (!capRow) {
      // Fetch available tags to include in error message
      const allTags = await c.env.DB.prepare('SELECT tag FROM capabilities ORDER BY tag').all<{ tag: string }>();
      const tagList = allTags.results.map((r) => r.tag).join(', ');
      return c.json(error('VALIDATION_ERROR', `Unknown capability tag: "${cap.tag}". Available tags: ${tagList}`, 400).body, 400);
    }
    capabilityRows.push({ id: capRow.id, tag: cap.tag, confidence: cap.confidence });
  }

  const id = generateId();
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

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'agent.registered',
    actor_id: id,
    target_type: 'agent',
    target_id: id,
    detail: { name: input.name, owner_id: input.owner_id, capabilities: input.capabilities.map((cap) => cap.tag) }
  });

  return c.json(success({
    agent: { id, name: input.name, api_key: key, trust_score: 0.5, created_at: timestamp }
  }), 201);
});

// PATCH /v1/agents/:id — Update agent profile
agents.patch('/:id', requireAgentKey, async (c) => {
  const agentId = c.req.param('id');
  const auth = c.get('auth');

  // Must be the agent itself
  if (auth.agent_id !== agentId) {
    return c.json(error('FORBIDDEN', 'You can only update your own agent profile', 403).body, 403);
  }

  let input: UpdateAgentInput;
  try {
    input = await c.req.json<UpdateAgentInput>();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'Invalid JSON body', 400).body, 400);
  }

  // Validate description if provided
  if (input.description !== undefined && input.description.length > 500) {
    return c.json(error('VALIDATION_ERROR', 'description must be 500 characters or fewer', 400).body, 400);
  }

  // Validate capabilities if provided
  let capabilityRows: Array<{ id: number; tag: string; confidence: number }> = [];
  if (input.capabilities !== undefined) {
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

    for (const cap of input.capabilities) {
      const capRow = await c.env.DB.prepare(
        'SELECT id FROM capabilities WHERE tag = ?'
      ).bind(cap.tag).first<{ id: number }>();

      if (!capRow) {
        const allTags = await c.env.DB.prepare('SELECT tag FROM capabilities ORDER BY tag').all<{ tag: string }>();
        const tagList = allTags.results.map((r) => r.tag).join(', ');
        return c.json(error('VALIDATION_ERROR', `Unknown capability tag: "${cap.tag}". Available tags: ${tagList}`, 400).body, 400);
      }
      capabilityRows.push({ id: capRow.id, tag: cap.tag, confidence: cap.confidence });
    }
  }

  // If capabilities are being replaced, get old tags for cache invalidation
  let oldTags: string[] = [];
  if (input.capabilities !== undefined) {
    const oldCaps = await c.env.DB.prepare(
      `SELECT c.tag FROM agent_capabilities ac
       JOIN capabilities c ON ac.capability_id = c.id
       WHERE ac.agent_id = ?`
    ).bind(agentId).all<{ tag: string }>();
    oldTags = oldCaps.results.map((r) => r.tag);

    // Delete and re-insert capabilities
    await c.env.DB.prepare('DELETE FROM agent_capabilities WHERE agent_id = ?').bind(agentId).run();

    for (const cap of capabilityRows) {
      await c.env.DB.prepare(
        'INSERT INTO agent_capabilities (agent_id, capability_id, confidence) VALUES (?, ?, ?)'
      ).bind(agentId, cap.id, cap.confidence).run();
    }
  }

  // Build update query for agent row
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.description !== undefined) {
    updates.push('description = ?');
    values.push(input.description);
  }

  if (updates.length > 0) {
    values.push(agentId);
    await c.env.DB.prepare(
      `UPDATE agents SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();
  }

  // Invalidate KV caches for affected tags
  const newTags = capabilityRows.map((cap) => cap.tag);
  const allAffectedTags = Array.from(new Set([...oldTags, ...newTags]));
  if (allAffectedTags.length > 0) {
    await kvInvalidateCapabilityCache(c.env.KV, allAffectedTags);
  }

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'agent.updated',
    actor_id: agentId,
    target_type: 'agent',
    target_id: agentId,
    detail: {
      updated_fields: [
        ...(input.description !== undefined ? ['description'] : []),
        ...(input.capabilities !== undefined ? ['capabilities'] : [])
      ]
    }
  });

  // Fetch updated agent profile
  const agent = await c.env.DB.prepare(
    `SELECT id, name, description, trust_score, trust_score_as_helper, trust_score_as_requester,
            request_count, response_count, status, created_at, last_seen_at
     FROM agents WHERE id = ?`
  ).bind(agentId).first();

  const capabilities = await c.env.DB.prepare(
    `SELECT c.tag, ac.confidence, ac.verified_score
     FROM agent_capabilities ac
     JOIN capabilities c ON ac.capability_id = c.id
     WHERE ac.agent_id = ?`
  ).bind(agentId).all();

  return c.json(success({ agent: { ...agent, capabilities: capabilities.results } }));
});

// GET /v1/agents/:id — Public profile
agents.get('/:id', async (c) => {
  const agentId = c.req.param('id');

  const agent = await c.env.DB.prepare(
    `SELECT id, name, description, trust_score, trust_score_as_helper, trust_score_as_requester,
            request_count, response_count, status, created_at, last_seen_at
     FROM agents WHERE id = ?`
  ).bind(agentId).first();

  if (!agent) {
    return c.json(error('NOT_FOUND', 'Agent not found', 404).body, 404);
  }

  const capabilities = await c.env.DB.prepare(
    `SELECT c.tag, ac.confidence, ac.verified_score
     FROM agent_capabilities ac
     JOIN capabilities c ON ac.capability_id = c.id
     WHERE ac.agent_id = ?`
  ).bind(agentId).all();

  return c.json(success({ agent: { ...agent, capabilities: capabilities.results } }));
});

export default agents;
