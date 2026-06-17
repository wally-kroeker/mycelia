import { Hono } from 'hono';
import type { Env, AuthContext, CreateAgentInput, UpdateAgentInput } from '../types';
import { authMiddleware, requireAgentKey, generateApiKey } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { writeAuditLog } from '../lib/audit';
import { kvInvalidateCapabilityCache } from '../lib/kv';
import { success, error, generateId, now } from '../lib/utils';
import { revoke, unrevoke, checkRevoked } from '../lib/revocation';

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

  // Atomic batch: INSERT agent + INSERT agent_capabilities (variable count).
  // Prior implementation ran them as separate awaits, so a mid-sequence
  // failure could leave an agent registered without their declared
  // capabilities — undiscoverable via capability matching despite being
  // an active agent. Audit log post-batch as best-effort.
  const batchStatements = [
    c.env.DB.prepare(
      `INSERT INTO agents (id, name, description, owner_id, api_key_hash, key_prefix, trust_score,
        trust_score_as_helper, trust_score_as_requester, status, request_count, response_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0.5, 0.5, 0.5, 'active', 0, 0, ?)`
    ).bind(id, input.name, input.description ?? null, input.owner_id, hash, prefix, timestamp),
  ];
  for (const cap of capabilityRows) {
    batchStatements.push(
      c.env.DB.prepare(
        'INSERT INTO agent_capabilities (agent_id, capability_id, confidence) VALUES (?, ?, ?)'
      ).bind(id, cap.id, cap.confidence)
    );
  }
  await c.env.DB.batch(batchStatements);

  try {
    await writeAuditLog(c.env.DB, c.env.KV, {
      event_type: 'agent.registered',
      actor_id: id,
      target_type: 'agent',
      target_id: id,
      detail: { name: input.name, owner_id: input.owner_id, capabilities: input.capabilities.map((cap) => cap.tag) }
    });
  } catch (auditErr) {
    console.error('[agents] writeAuditLog failed after committed agent', id, auditErr);
  }

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
  }

  // Build agent row UPDATE if any scalar fields change
  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.description !== undefined) {
    updates.push('description = ?');
    values.push(input.description);
  }

  // Atomic batch: DELETE existing agent_capabilities + INSERT new rows +
  // (optional) UPDATE agents scalar fields. Prior implementation ran the
  // DELETE before the INSERT loop with no transaction — a failure between
  // them would wipe the agent's capabilities entirely, leaving them visible
  // but undiscoverable. This is a real availability hit on the fleet's
  // capability-matching layer. Batch ensures the swap is atomic.
  const batchStatements: ReturnType<typeof c.env.DB.prepare>[] = [];
  if (input.capabilities !== undefined) {
    batchStatements.push(
      c.env.DB.prepare('DELETE FROM agent_capabilities WHERE agent_id = ?').bind(agentId)
    );
    for (const cap of capabilityRows) {
      batchStatements.push(
        c.env.DB.prepare(
          'INSERT INTO agent_capabilities (agent_id, capability_id, confidence) VALUES (?, ?, ?)'
        ).bind(agentId, cap.id, cap.confidence)
      );
    }
  }
  if (updates.length > 0) {
    values.push(agentId);
    batchStatements.push(
      c.env.DB.prepare(
        `UPDATE agents SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values)
    );
  }
  if (batchStatements.length > 0) {
    await c.env.DB.batch(batchStatements);
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

// ─── POST /:id/revoke — Kill-switch (B8 from combined redteam) ───────────────
// Either Rob (admin) or the agent itself (self-revoke) may revoke.
// Body: { reason: string, revoke_until?: ISO-8601 string }
agents.post('/:id/revoke', requireAgentKey, async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  // Authorization: self-revoke or rob (owner_id == rob-chuvala on the admin agent)
  // We treat the caller's resolved agent as authoritative on self-revoke.
  // For Rob admin we check the auth's owner_id.
  const isSelf = auth.agent_id === id;
  const isAdmin = auth.owner_id === 'rob-chuvala';
  if (!isSelf && !isAdmin) {
    return c.json(error('FORBIDDEN', 'Only the agent itself or rob-chuvala may revoke', 403).body, 403);
  }

  let body: { reason?: string; revoke_until?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const reason = (typeof body.reason === 'string' && body.reason.length > 0)
    ? body.reason.slice(0, 500)
    : (isSelf ? 'self-revoke (no reason given)' : 'admin-revoke (no reason given)');

  // Validate revoke_until if provided
  let revokeUntil: string | null = null;
  if (body.revoke_until) {
    const t = Date.parse(body.revoke_until);
    if (isNaN(t)) {
      return c.json(error('VALIDATION_ERROR', 'revoke_until must be ISO-8601', 400).body, 400);
    }
    if (t <= Date.now()) {
      return c.json(error('VALIDATION_ERROR', 'revoke_until must be in the future', 400).body, 400);
    }
    revokeUntil = new Date(t).toISOString();
  }

  // Confirm target agent exists
  const target = await c.env.DB.prepare(
    'SELECT id, name FROM agents WHERE id = ?'
  ).bind(id).first<{ id: string; name: string }>();
  if (!target) {
    return c.json(error('NOT_FOUND', 'Agent not found', 404).body, 404);
  }

  const entry = await revoke(c.env.KV, id, reason, auth.agent_id, revokeUntil);

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'agent.deactivated',
    actor_id: auth.agent_id,
    target_type: 'agent',
    target_id: id,
    detail: {
      via: 'kill_switch',
      revoke_self: isSelf,
      reason: entry.reason,
      revoke_until: entry.revoke_until,
    },
  });

  return c.json(success({ revocation: entry }), 201);
});

// ─── DELETE /:id/revoke — Lift a revocation (admin only) ────────────────────
agents.delete('/:id/revoke', requireAgentKey, async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  if (auth.owner_id !== 'rob-chuvala') {
    return c.json(error('FORBIDDEN', 'Only rob-chuvala may lift a revocation', 403).body, 403);
  }

  await unrevoke(c.env.KV, id);

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'agent.updated',
    actor_id: auth.agent_id,
    target_type: 'agent',
    target_id: id,
    detail: { via: 'unrevoke' },
  });

  return c.json(success({ lifted: true, agent_id: id }));
});

// ─── GET /:id/revocation — Inspect current revocation state ─────────────────
agents.get('/:id/revocation', async (c) => {
  const id = c.req.param('id');
  const entry = await checkRevoked(c.env.KV, id);
  return c.json(success({ revoked: !!entry, entry }));
});

export default agents;
