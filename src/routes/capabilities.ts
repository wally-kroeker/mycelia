import { Hono } from 'hono';
import type { Env, AuthContext, ProposeTagInput } from '../types';
import { authMiddleware, requireAgentKey } from '../middleware/auth';
import { readRevocationCheck } from '../middleware/read-revocation-check';
import { writeAuditLog } from '../lib/audit';
import { kvCacheGet } from '../lib/kv';
import { success, error, now } from '../lib/utils';

const capabilities = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

capabilities.use('*', authMiddleware);

// GET /v1/capabilities — List all capability tags
capabilities.get('/', readRevocationCheck, async (c) => {
  const category = c.req.query('category');

  let query = 'SELECT id, tag, category, description FROM capabilities';
  const params: string[] = [];

  if (category) {
    query += ' WHERE category = ?';
    params.push(category);
  }

  query += ' ORDER BY category, tag';

  const result = params.length > 0
    ? await c.env.DB.prepare(query).bind(...params).all()
    : await c.env.DB.prepare(query).all();

  return c.json(success({ capabilities: result.results }));
});

// POST /v1/capabilities/propose — Propose a new capability tag
// Must be declared BEFORE /:tag/agents to avoid route conflict
capabilities.post('/propose', requireAgentKey, async (c) => {
  const auth = c.get('auth');

  let input: ProposeTagInput;
  try {
    input = await c.req.json<ProposeTagInput>();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'Invalid JSON body', 400).body, 400);
  }

  // Validate tag
  if (!input.tag || typeof input.tag !== 'string') {
    return c.json(error('VALIDATION_ERROR', 'tag is required', 400).body, 400);
  }
  if (input.tag.length < 3 || input.tag.length > 50) {
    return c.json(error('VALIDATION_ERROR', 'tag must be 3-50 characters', 400).body, 400);
  }
  if (!/^[a-z-]+$/.test(input.tag)) {
    return c.json(error('VALIDATION_ERROR', 'tag must be lowercase letters and hyphens only', 400).body, 400);
  }

  // Validate category
  if (!input.category || typeof input.category !== 'string') {
    return c.json(error('VALIDATION_ERROR', 'category is required', 400).body, 400);
  }

  // Validate description
  if (!input.description || typeof input.description !== 'string') {
    return c.json(error('VALIDATION_ERROR', 'description is required', 400).body, 400);
  }

  // Check tag doesn't already exist in capabilities
  const existingCap = await c.env.DB.prepare(
    'SELECT id FROM capabilities WHERE tag = ?'
  ).bind(input.tag).first();

  if (existingCap) {
    return c.json(error('CONFLICT', 'Tag already exists in the capability taxonomy', 409).body, 409);
  }

  // Check tag doesn't already exist in pending proposals
  const existingProposal = await c.env.DB.prepare(
    "SELECT id FROM tag_proposals WHERE tag = ? AND status = 'pending'"
  ).bind(input.tag).first();

  if (existingProposal) {
    return c.json(error('CONFLICT', 'A pending proposal for this tag already exists', 409).body, 409);
  }

  const timestamp = now();

  await c.env.DB.prepare(
    `INSERT INTO tag_proposals (proposed_by, tag, category, description, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(auth.agent_id, input.tag, input.category, input.description, timestamp).run();

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'tag.proposed',
    actor_id: auth.agent_id,
    target_type: 'capability',
    target_id: input.tag,
    detail: { category: input.category, description: input.description }
  });

  return c.json(success({
    proposal: {
      tag: input.tag,
      category: input.category,
      description: input.description,
      status: 'pending',
      proposed_by: auth.agent_id,
      created_at: timestamp
    }
  }), 201);
});

// GET /v1/capabilities/:tag/agents — Find agents with a capability
capabilities.get('/:tag/agents', async (c) => {
  const tag = c.req.param('tag');
  const minTrustParam = c.req.query('min_trust');
  const minTrust = minTrustParam !== undefined ? parseFloat(minTrustParam) : 0;

  if (isNaN(minTrust) || minTrust < 0 || minTrust > 1) {
    return c.json(error('VALIDATION_ERROR', 'min_trust must be a number between 0 and 1', 400).body, 400);
  }

  // KV cache key includes minTrust to avoid serving wrong cached results
  const cacheKey = minTrust > 0 ? `match:${tag}:${minTrust}` : `match:${tag}`;

  const matchedAgents = await kvCacheGet(c.env.KV, cacheKey, 300, async () => {
    const result = await c.env.DB.prepare(`
      SELECT a.id, a.name, ac.confidence, ac.verified_score, a.trust_score,
             COALESCE(ac.verified_score, ac.confidence) * a.trust_score AS match_score
      FROM agent_capabilities ac
      JOIN capabilities cap ON ac.capability_id = cap.id
      JOIN agents a ON ac.agent_id = a.id
      WHERE cap.tag = ? AND a.status = 'active' AND a.trust_score >= ?
      ORDER BY match_score DESC
    `).bind(tag, minTrust).all<{
      id: string;
      name: string;
      confidence: number;
      verified_score: number | null;
      trust_score: number;
      match_score: number;
    }>();

    return result.results;
  });

  return c.json(success({ agents: matchedAgents }));
});

export default capabilities;
