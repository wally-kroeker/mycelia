// tests/phase2-type-foundation.test.ts
//
// Phase 2 exit-criteria tests: type foundation.
// Covers all rows from the spec's exit-criteria table plus migration verification.
//
// Exit criteria:
//   | GET /v1/schemas returns list                              | 200 with schema slugs       |
//   | GET /v1/schemas/request_create returns body shape        | 200 with field definitions  |
//   | POST /v1/requests, type=delegate, community mode         | 403 FORBIDDEN               |
//   | POST /v1/requests, type=delegate, fleet mode             | 201 accepted                |
//   | POST /v1/requests, type=ack-close, community mode        | 201 accepted (no gate)      |
//   | POST /v1/requests, type=abandon, community mode          | 201 accepted (no gate)      |
//   | POST /v1/requests, type=council, community mode          | 201 accepted (peer, unchanged) |
//   | Migration 0006: request_type CHECK updated               | verified via test insert    |
//   | Migration 0007: coordination fields present on requests  | verified via test row       |
//
// Note: "All existing integration tests from integrate/pr3-scopeclaim" is covered
// by tests/integration/response-bugs.test.ts which is the ported regression suite.

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import {
  applyMigrationsSync,
  createTestEnv,
  seedAgents,
  type TestEnv,
  type SeededAgents,
} from './integration/_fixtures';

// ── helpers ──────────────────────────────────────────────────────────────────

function postReq(path: string, key: string, body: object): Request {
  return new Request(`http://test.local${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function getReq(path: string, key: string): Request {
  return new Request(`http://test.local${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
}

function fleetEnv(env: TestEnv): typeof env {
  return { ...env, ENVIRONMENT: 'test', MODE: 'fleet' as const };
}

function communityEnv(env: TestEnv): typeof env {
  return { ...env, ENVIRONMENT: 'test', MODE: 'community' as const };
}

/**
 * Minimal valid POST /v1/requests body for a given request_type.
 *
 * agentId: when set, includes a scope_claim (required for fleet mode).
 * When omitted, no scope_claim — community mode's grace period synthesizes one.
 */
function requestBody(type: string, agentId?: string, extra?: object): object {
  const base: Record<string, unknown> = {
    title: 'Integration test request title here',
    body: 'Integration test request body that meets the 20-char minimum.',
    request_type: type,
    tags: [typeToTag(type)],
  };
  if (agentId !== undefined) {
    base.scope_claim = {
      requester: 'test-agent',
      agent_id: agentId,
      tier: 'public',
      ask_max_tier: 'public',
      ts: new Date().toISOString(),
    };
  }
  return { ...base, ...extra };
}

/**
 * Map a request_type to a seeded capability tag that exists after all migrations.
 *
 * Migration 0001 seeds engineering/security/writing/analysis/design tags.
 * Migration 0006 seeds ops-bus and lifecycle tags (named after the type).
 *
 * For eval-surface types: use 'code-review' (seeded in 0001).
 * For ops-bus/lifecycle types: use the type name directly (seeded in 0006).
 */
function typeToTag(type: string): string {
  const opsBusTags = new Set(['handoff', 'collision-warn', 'status-sync', 'delegate', 'blocker']);
  const lifecycleTags = new Set(['ack-close', 'abandon']);
  if (opsBusTags.has(type)) return type;
  if (lifecycleTags.has(type)) return type;
  // eval-surface types: use a tag from migration 0001's seed
  return 'code-review';
}

// ── setup ─────────────────────────────────────────────────────────────────────

let env: TestEnv;
let agents: SeededAgents;

beforeEach(async () => {
  env = createTestEnv();
  applyMigrationsSync(env); // seeds eval-surface caps (0001) + ops-bus/lifecycle caps (0006)
  // Phase 3: seed with trusted tier so fleet-mode ops-bus tests pass the two-gate check.
  // Community mode tests are unaffected (mode gate fires before tier check).
  agents = await seedAgents(env, { tier: 'trusted' });
});

// ── exit criteria ─────────────────────────────────────────────────────────────

describe('Phase 2 — schemas endpoint', () => {
  it('GET /v1/schemas returns list with schema slugs', async () => {
    const res = await app.fetch(getReq('/v1/schemas', agents.requesterKey), communityEnv(env));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { schemas: Array<{ slug: string }> } };
    expect(body.ok).toBe(true);
    const slugs = body.data.schemas.map((s) => s.slug);
    expect(slugs).toContain('request_create');
  });

  it('GET /v1/schemas/request_create returns field definitions', async () => {
    const res = await app.fetch(getReq('/v1/schemas/request_create', agents.requesterKey), communityEnv(env));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { schema: { body: Record<string, unknown> } } };
    expect(body.ok).toBe(true);
    expect(body.data.schema.body).toHaveProperty('title');
    expect(body.data.schema.body).toHaveProperty('request_type');
  });
});

describe('Phase 2 — ops-bus type mode gate', () => {
  // community mode: mode gate fires before scope_claim check, so agentId not needed
  it('POST /v1/requests — type=delegate, community mode → 403 FORBIDDEN', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('delegate')),
      communityEnv(env)
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toContain('ops-bus type');
  });

  // fleet mode: scope_claim required — pass actual agentId
  it('POST /v1/requests — type=delegate, fleet mode → 201 accepted', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('delegate', agents.requesterId)),
      fleetEnv(env)
    );
    expect(res.status).toBe(201);
  });

  it('POST /v1/requests — type=handoff, community mode → 403 FORBIDDEN', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('handoff')),
      communityEnv(env)
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('POST /v1/requests — type=blocker, fleet mode → 201 accepted', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('blocker', agents.requesterId)),
      fleetEnv(env)
    );
    expect(res.status).toBe(201);
  });
});

describe('Phase 2 — lifecycle types (universally available)', () => {
  // community mode: grace period synthesizes scope_claim, no agentId needed
  it('POST /v1/requests — type=ack-close, community mode → 201 accepted', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('ack-close')),
      communityEnv(env)
    );
    expect(res.status).toBe(201);
  });

  it('POST /v1/requests — type=abandon, community mode → 201 accepted', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('abandon')),
      communityEnv(env)
    );
    expect(res.status).toBe(201);
  });

  // fleet mode: scope_claim required
  it('POST /v1/requests — type=ack-close, fleet mode → 201 accepted', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('ack-close', agents.requesterId)),
      fleetEnv(env)
    );
    expect(res.status).toBe(201);
  });
});

describe('Phase 2 — eval-surface types unchanged', () => {
  it('POST /v1/requests — type=council, community mode → 201 accepted', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('council')),
      communityEnv(env)
    );
    // community mode: scope_claim grace period synthesizes a claim.
    // 201 expected — eval-surface types have no mode gate.
    expect(res.status).toBe(201);
  });
});

describe('Phase 2 — coordination fields (migration 0007)', () => {
  it('POST /v1/requests — coordination fields stored and returned', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('review', agents.requesterId, {
        references: ['req-abc', 'req-def'],
        supersedes: 'req-old',
        action_required: 'act',
        blocking: 'req-upstream',
      })),
      fleetEnv(env)
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { request: { id: string } } };
    const id = body.data.request.id;

    // Verify fields were persisted to DB
    const row = await env.DB.prepare(
      `SELECT references_json, supersedes, action_required, blocking FROM requests WHERE id = ?`
    ).bind(id).first<{
      references_json: string;
      supersedes: string;
      action_required: string;
      blocking: string;
    }>();
    expect(JSON.parse(row!.references_json)).toEqual(['req-abc', 'req-def']);
    expect(row!.supersedes).toBe('req-old');
    expect(row!.action_required).toBe('act');
    expect(row!.blocking).toBe('req-upstream');
  });

  it('POST /v1/requests — action_required smart default: directed → act', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('review', agents.requesterId, {
        target_agent_id: agents.responderId,
        // action_required omitted — should default to 'act' for directed requests
      })),
      fleetEnv(env)
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { request: { id: string } } };
    const id = body.data.request.id;
    const row = await env.DB.prepare(
      `SELECT action_required FROM requests WHERE id = ?`
    ).bind(id).first<{ action_required: string }>();
    expect(row!.action_required).toBe('act');
  });

  it('POST /v1/requests — action_required smart default: broadcast → fyi', async () => {
    const res = await app.fetch(
      postReq('/v1/requests', agents.requesterKey, requestBody('review')),
      // community mode + no target_agent_id, no action_required → 'fyi'
      communityEnv(env)
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { request: { id: string } } };
    const id = body.data.request.id;
    const row = await env.DB.prepare(
      `SELECT action_required FROM requests WHERE id = ?`
    ).bind(id).first<{ action_required: string }>();
    expect(row!.action_required).toBe('fyi');
  });
});

describe('Phase 2 — migration 0006 CHECK constraint', () => {
  it('ops-bus type can be inserted via app (CHECK accepts it)', async () => {
    // Indirect: if the CHECK rejected 'handoff', the 201 above would have failed.
    // Direct test: insert via DB to confirm the CHECK constraint specifically.
    const ts = new Date().toISOString();
    let threw = false;
    try {
      await env.DB.prepare(
        `INSERT INTO requests (id, requester_id, title, body, request_type, priority,
                               status, max_responses, response_count, expires_at,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        'req-check-test', agents.requesterId, 'title', 'body body body body body',
        'INVALID_TYPE_XYZ', 'normal', 'open', 3, 0,
        new Date(Date.now() + 3600 * 1000).toISOString(), ts, ts
      ).run();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // CHECK violation: unknown type

    // Valid ops-bus type should succeed
    await env.DB.prepare(
      `INSERT INTO requests (id, requester_id, title, body, request_type, priority,
                             status, max_responses, response_count, expires_at,
                             created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      'req-handoff-test', agents.requesterId, 'title', 'body body body body body',
      'handoff', 'normal', 'open', 3, 0,
      new Date(Date.now() + 3600 * 1000).toISOString(), ts, ts
    ).run();

    // abandon type (new in this spec, not in PR #12) should also succeed
    await env.DB.prepare(
      `INSERT INTO requests (id, requester_id, title, body, request_type, priority,
                             status, max_responses, response_count, expires_at,
                             created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      'req-abandon-test', agents.requesterId, 'title', 'body body body body body',
      'abandon', 'normal', 'open', 3, 0,
      new Date(Date.now() + 3600 * 1000).toISOString(), ts, ts
    ).run();

    const inserted = await env.DB.prepare(
      `SELECT request_type FROM requests WHERE id IN ('req-handoff-test', 'req-abandon-test') ORDER BY request_type`
    ).all<{ request_type: string }>();
    expect(inserted.results.map((r) => r.request_type)).toEqual(['abandon', 'handoff']);
  });
});
