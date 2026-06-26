import { Hono } from 'hono';
import type { Env, AuthContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { isFeedScoped, type NodeMode } from '../middleware/fleet-gate';
import { rateLimit } from '../middleware/rate-limit';
import { kvCacheGet } from '../lib/kv';
import { parsePagination, paginatedQuery } from '../lib/db';
import { success, error } from '../lib/utils';

const feed = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

feed.use('*', authMiddleware);

// GET /v1/feed — Paginated activity feed from audit_log, enriched with actor names
feed.get('/', rateLimit('feed'), async (c) => {
  const agentId = c.req.query('agent_id');
  const eventType = c.req.query('event_type');
  const since = c.req.query('since');
  const query = c.req.queries();

  const flatQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    flatQuery[k] = Array.isArray(v) ? v[0] : v;
  }

  const pagination = parsePagination(flatQuery);
  pagination.limit = Math.min(pagination.limit, 100);

  let where = 'WHERE 1=1';
  const params: unknown[] = [];

  // fleet/company: scope feed to agents belonging to the requester's owner_id.
  // Prevents cross-org event visibility on private nodes.
  const mode = (c.env.MODE ?? 'community') as NodeMode;
  if (isFeedScoped(mode)) {
    const auth = c.get('auth');
    where += ' AND a.owner_id = ?';
    params.push(auth.owner_id);
  }

  if (agentId) {
    where += ' AND al.actor_id = ?';
    params.push(agentId);
  }
  if (eventType) {
    where += ' AND al.event_type = ?';
    params.push(eventType);
  }
  if (since) {
    where += ' AND al.created_at >= ?';
    params.push(since);
  }

  const result = await paginatedQuery<Record<string, unknown>>(
    c.env.DB,
    `SELECT al.id, al.event_type, al.actor_id, al.target_type, al.target_id, al.detail, al.created_at,
            a.name AS actor_name
     FROM audit_log al
     LEFT JOIN agents a ON al.actor_id = a.id
     ${where}
     ORDER BY al.created_at DESC`,
    `SELECT COUNT(*) as count FROM audit_log al LEFT JOIN agents a ON al.actor_id = a.id ${where}`,
    params,
    pagination
  );

  const events = result.items.map((event) => ({
    ...event,
    detail: event.detail && typeof event.detail === 'string'
      ? (() => { try { return JSON.parse(event.detail); } catch { return event.detail; } })()
      : event.detail ?? null
  }));

  return c.json(success({ events, pagination: result.pagination }));
});

// GET /v1/feed/stats — Network statistics, KV cached with 15-minute TTL
feed.get('/stats', rateLimit('feed'), async (c) => {
  const stats = await kvCacheGet(c.env.KV, 'feed:stats', 900, async () => {
    const [
      agentsResult,
      activeResult,
      requestsResult,
      openReqsResult,
      responsesResult,
      avgRatingResult,
      avgResponseTimeResult,
      topCapsResult
    ] = await Promise.all([
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM agents WHERE status = 'active'"
      ).first<{ count: number }>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM agents WHERE last_seen_at >= datetime('now', '-1 day')"
      ).first<{ count: number }>(),
      c.env.DB.prepare(
        'SELECT COUNT(*) AS count FROM requests'
      ).first<{ count: number }>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM requests WHERE status = 'open'"
      ).first<{ count: number }>(),
      c.env.DB.prepare(
        'SELECT COUNT(*) AS count FROM responses'
      ).first<{ count: number }>(),
      c.env.DB.prepare(
        'SELECT AVG(score) AS avg FROM ratings'
      ).first<{ avg: number | null }>(),
      c.env.DB.prepare(`
        SELECT AVG(
          CAST((julianday(r.created_at) - julianday(req.created_at)) * 1440 AS REAL)
        ) AS avg_minutes
        FROM responses r
        JOIN requests req ON r.request_id = req.id
      `).first<{ avg_minutes: number | null }>(),
      c.env.DB.prepare(`
        SELECT c.tag, COUNT(*) AS request_count
        FROM request_tags rt
        JOIN capabilities c ON rt.capability_id = c.id
        GROUP BY c.tag
        ORDER BY request_count DESC
        LIMIT 10
      `).all<{ tag: string; request_count: number }>()
    ]);

    return {
      total_agents: agentsResult?.count ?? 0,
      active_agents_24h: activeResult?.count ?? 0,
      total_requests: requestsResult?.count ?? 0,
      open_requests: openReqsResult?.count ?? 0,
      total_responses: responsesResult?.count ?? 0,
      average_rating: Math.round(((avgRatingResult?.avg ?? 0)) * 10) / 10,
      average_response_time_minutes: Math.round((avgResponseTimeResult?.avg_minutes ?? 0) * 10) / 10,
      top_capabilities: topCapsResult.results
    };
  });

  return c.json(success({ stats }));
});

// GET /v1/feed/timeline/:id — Full audit trail for a specific request
feed.get('/timeline/:id', rateLimit('feed'), async (c) => {
  const requestId = c.req.param('id');

  // Verify request exists
  const req = await c.env.DB.prepare(
    'SELECT id FROM requests WHERE id = ?'
  ).bind(requestId).first<{ id: string }>();

  if (!req) {
    return c.json(error('NOT_FOUND', 'Request not found', 404).body, 404);
  }

  const eventsResult = await c.env.DB.prepare(`
    SELECT al.id, al.event_type, al.actor_id, al.target_type, al.target_id, al.detail, al.created_at,
           a.name AS actor_name
    FROM audit_log al
    LEFT JOIN agents a ON al.actor_id = a.id
    WHERE (al.target_id = ? AND al.target_type = 'request')
       OR al.target_id IN (SELECT id FROM claims WHERE request_id = ?)
       OR al.target_id IN (SELECT id FROM responses WHERE request_id = ?)
       OR al.target_id IN (
         SELECT rat.id FROM ratings rat
         JOIN responses resp ON rat.response_id = resp.id
         WHERE resp.request_id = ?
       )
    ORDER BY al.created_at ASC
  `).bind(requestId, requestId, requestId, requestId).all<Record<string, unknown>>();

  const timeline = eventsResult.results.map((e) => ({
    id: e.id,
    event: e.event_type,
    actor_id: e.actor_id,
    actor_name: e.actor_name ?? null,
    target_type: e.target_type,
    target_id: e.target_id,
    detail: e.detail && typeof e.detail === 'string'
      ? (() => { try { return JSON.parse(e.detail as string); } catch { return e.detail; } })()
      : e.detail ?? null,
    at: e.created_at
  }));

  return c.json(success({ request_id: requestId, timeline }));
});

export default feed;
