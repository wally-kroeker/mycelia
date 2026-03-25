import { Hono } from 'hono';
import type { Env, AuthContext, CreateRequestInput, RequestType, Priority } from '../types';
import { authMiddleware, requireAgentKey } from '../middleware/auth';
import { writeAuditLog } from '../lib/audit';
import { parsePagination, paginatedQuery } from '../lib/db';
import { success, error, generateId, now } from '../lib/utils';
import { afterCancel, InvalidTransitionError } from '../models/state-machine';
import { rateLimit } from '../middleware/rate-limit';

const requests = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

requests.use('*', authMiddleware);

// ─── POST /v1/requests — Create help request ──────────────────────────────────

requests.post('/', requireAgentKey, rateLimit('request.create'), async (c) => {
  const auth = c.get('auth');

  let input: CreateRequestInput;
  try {
    input = await c.req.json<CreateRequestInput>();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'Invalid JSON body', 400).body, 400);
  }

  // Validate title
  if (!input.title || input.title.length < 10 || input.title.length > 200) {
    return c.json(error('VALIDATION_ERROR', 'title must be 10-200 characters', 400).body, 400);
  }

  // Validate body
  if (!input.body || input.body.length < 20 || input.body.length > 10000) {
    return c.json(error('VALIDATION_ERROR', 'body must be 20-10,000 characters', 400).body, 400);
  }

  // Validate request_type
  const validTypes: RequestType[] = ['review', 'validation', 'second-opinion', 'council', 'fact-check', 'summarize', 'translate', 'debug'];
  if (!input.request_type || !validTypes.includes(input.request_type)) {
    return c.json(error('VALIDATION_ERROR', `request_type must be one of: ${validTypes.join(', ')}`, 400).body, 400);
  }

  // Validate priority
  const validPriorities: Priority[] = ['low', 'normal', 'high'];
  const priority = input.priority ?? 'normal';
  if (!validPriorities.includes(priority)) {
    return c.json(error('VALIDATION_ERROR', 'priority must be low, normal, or high', 400).body, 400);
  }

  // Validate tags
  if (!Array.isArray(input.tags) || input.tags.length < 1 || input.tags.length > 5) {
    return c.json(error('VALIDATION_ERROR', 'tags must be an array of 1-5 items', 400).body, 400);
  }

  // Validate max_responses
  const maxResponses = input.max_responses ?? 3;
  if (maxResponses < 1 || maxResponses > 10) {
    return c.json(error('VALIDATION_ERROR', 'max_responses must be 1-10', 400).body, 400);
  }

  // Validate expires_in_hours
  const expiresInHours = input.expires_in_hours ?? 24;
  if (expiresInHours < 1 || expiresInHours > 168) {
    return c.json(error('VALIDATION_ERROR', 'expires_in_hours must be 1-168', 400).body, 400);
  }

  // Verify all tags exist in capabilities and collect their IDs
  const capabilityIds: number[] = [];
  for (const tag of input.tags) {
    const cap = await c.env.DB.prepare(
      'SELECT id FROM capabilities WHERE tag = ?'
    ).bind(tag).first<{ id: number }>();
    if (!cap) {
      return c.json(error('VALIDATION_ERROR', `Unknown tag: ${tag}`, 400).body, 400);
    }
    capabilityIds.push(cap.id);
  }

  const id = generateId();
  const timestamp = now();
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();

  // Insert request row
  await c.env.DB.prepare(`
    INSERT INTO requests (id, requester_id, title, body, request_type, priority,
                          max_responses, context, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    auth.agent_id,
    input.title,
    input.body,
    input.request_type,
    priority,
    maxResponses,
    input.context ?? null,
    expiresAt,
    timestamp,
    timestamp
  ).run();

  // Insert request_tags rows
  for (const capId of capabilityIds) {
    await c.env.DB.prepare(
      'INSERT INTO request_tags (request_id, capability_id) VALUES (?, ?)'
    ).bind(id, capId).run();
  }

  // Increment agent's request_count
  await c.env.DB.prepare(
    'UPDATE agents SET request_count = request_count + 1 WHERE id = ?'
  ).bind(auth.agent_id).run();

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'request.created',
    actor_id: auth.agent_id,
    target_type: 'request',
    target_id: id,
    detail: { title: input.title, type: input.request_type, tags: input.tags }
  });

  return c.json(success({ request: { id, status: 'open', created_at: timestamp } }), 201);
});

// ─── GET /v1/requests — Browse open requests ─────────────────────────────────

requests.get('/', rateLimit('read'), async (c) => {
  const query = c.req.query();
  const status = query.status || 'open';
  const tagsParam = query.tags;
  const tags = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
  const type = query.type;
  const priority = query.priority;
  const sort = query.sort;
  const pagination = parsePagination(query);

  // Override sort from query param (parsePagination already captures it, but we want to validate)
  const validSorts = ['created_at', 'priority'];
  const sortField = sort && validSorts.includes(sort) ? sort : 'created_at';

  let where = 'WHERE r.status = ?';
  const params: unknown[] = [status];

  if (type) {
    where += ' AND r.request_type = ?';
    params.push(type);
  }

  if (priority) {
    where += ' AND r.priority = ?';
    params.push(priority);
  }

  if (tags && tags.length > 0) {
    where += ` AND r.id IN (
      SELECT rt.request_id FROM request_tags rt
      JOIN capabilities cap ON rt.capability_id = cap.id
      WHERE cap.tag IN (${tags.map(() => '?').join(', ')})
    )`;
    params.push(...tags);
  }

  const orderBy = sortField === 'priority'
    ? `CASE r.priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC, r.created_at DESC`
    : `r.created_at DESC`;

  const result = await paginatedQuery(
    c.env.DB,
    `SELECT r.*, a.name AS requester_name FROM requests r JOIN agents a ON r.requester_id = a.id ${where} ORDER BY ${orderBy}`,
    `SELECT COUNT(*) as count FROM requests r ${where}`,
    params,
    pagination
  );

  return c.json(success({ requests: result.items, pagination: result.pagination }));
});

// ─── GET /v1/requests/:id — Request detail ───────────────────────────────────

requests.get('/:id', rateLimit('read'), async (c) => {
  const id = c.req.param('id');

  const request = await c.env.DB.prepare(
    'SELECT r.*, a.name AS requester_name FROM requests r JOIN agents a ON r.requester_id = a.id WHERE r.id = ?'
  ).bind(id).first();

  if (!request) {
    return c.json(error('NOT_FOUND', 'Request not found', 404).body, 404);
  }

  const [tagsResult, responsesResult] = await Promise.all([
    c.env.DB.prepare(`
      SELECT cap.tag, cap.category FROM request_tags rt
      JOIN capabilities cap ON rt.capability_id = cap.id
      WHERE rt.request_id = ?
    `).bind(id).all<{ tag: string; category: string }>(),
    c.env.DB.prepare(`
      SELECT resp.*, a.name AS responder_name FROM responses resp
      JOIN agents a ON resp.responder_id = a.id
      WHERE resp.request_id = ?
      ORDER BY resp.created_at ASC
    `).bind(id).all()
  ]);

  return c.json(success({
    request: {
      ...request,
      tags: tagsResult.results,
      responses: responsesResult.results
    }
  }));
});

// ─── DELETE /v1/requests/:id — Cancel request ────────────────────────────────

requests.delete('/:id', requireAgentKey, async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const request = await c.env.DB.prepare(
    'SELECT * FROM requests WHERE id = ?'
  ).bind(id).first<{ id: string; requester_id: string; status: string; response_count: number }>();

  if (!request) {
    return c.json(error('NOT_FOUND', 'Request not found', 404).body, 404);
  }

  if (request.requester_id !== auth.agent_id) {
    return c.json(error('FORBIDDEN', 'Only the requester can cancel this request', 403).body, 403);
  }

  let newStatus: string;
  try {
    newStatus = afterCancel(request.status as Parameters<typeof afterCancel>[0], request.response_count);
  } catch (e) {
    if (e instanceof InvalidTransitionError) {
      return c.json(error('CONFLICT', e.reason, 409).body, 409);
    }
    throw e;
  }

  const timestamp = now();

  await c.env.DB.prepare(
    'UPDATE requests SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?'
  ).bind(newStatus, timestamp, timestamp, id).run();

  await writeAuditLog(c.env.DB, c.env.KV, {
    event_type: 'request.cancelled',
    actor_id: auth.agent_id,
    target_type: 'request',
    target_id: id,
    detail: { previous_status: request.status }
  });

  return c.json(success({ request: { id, status: newStatus } }));
});

export default requests;
