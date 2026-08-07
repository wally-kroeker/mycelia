// tests/integration/phase4-lifecycle-mechanics.test.ts
//
// Phase 4 (fleet-coordination-v1): lifecycle mechanics.
//
// Covers:
//   - Migration 0009: ack-closed status, outcome_json, ratings nullable score,
//     cross_owner, source_type
//   - POST /v1/requests/:id/ack-close:
//       • responded → ack-closed status transition
//       • rating auto-created with NULL score when quality absent
//       • rating auto-created with score when quality present
//       • cross_owner=0 when same owner, cross_owner=1 when different owner
//       • source_type='ack-close' on auto-created rating
//       • 409 if request not in 'responded' state
//       • 403 if non-requester attempts ack-close
//   - DELETE /v1/requests/:id/claims/:claim_id (abandon):
//       • claim transitions to 'abandoned'
//       • request reopens to 'open' when no other active claims + no responses
//       • request stays in current status when other active claims remain
//       • 403 if agent doesn't own the claim
//       • 409 if claim not active

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/index';
import {
  applyMigrationsSync,
  createTestEnv,
  seedAgents,
  SeededAgents,
  TestEnv,
} from './_fixtures';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Seed two agents with DIFFERENT owner_ids (for cross_owner=1 tests).
 */
async function seedCrossOwnerAgents(env: TestEnv): Promise<SeededAgents & { requesterOwnerId: string; responderOwnerId: string }> {
  const requesterId = 'agent-requester-' + crypto.randomUUID();
  const responderId = 'agent-responder-' + crypto.randomUUID();
  const requesterKey = 'mycelia_live_' + 'c'.repeat(64);
  const responderKey = 'mycelia_live_' + 'd'.repeat(64);
  const requesterHash = await sha256(requesterKey);
  const responderHash = await sha256(responderKey);
  const requesterPrefix = requesterKey.substring(0, 21);
  const responderPrefix = responderKey.substring(0, 21);
  const ts = new Date().toISOString();
  const requesterOwnerId = 'owner-alpha-' + crypto.randomUUID().slice(0, 8);
  const responderOwnerId = 'owner-beta-' + crypto.randomUUID().slice(0, 8);

  await env.DB.prepare(
    `INSERT INTO agents (id, name, owner_id, api_key_hash, key_prefix, trust_score, status, agent_tier, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(requesterId, 'requester', requesterOwnerId, requesterHash, requesterPrefix, 0.7, 'active', 'peer', ts, ts).run();

  await env.DB.prepare(
    `INSERT INTO agents (id, name, owner_id, api_key_hash, key_prefix, trust_score, status, agent_tier, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(responderId, 'responder', responderOwnerId, responderHash, responderPrefix, 0.7, 'active', 'peer', ts, ts).run();

  return { requesterId, requesterKey, responderId, responderKey, requesterOwnerId, responderOwnerId };
}

/**
 * Seed a request in 'responded' status with one response row.
 * Returns requestId and responseId.
 */
async function seedRespondedRequest(
  env: TestEnv,
  agents: SeededAgents
): Promise<{ requestId: string; responseId: string }> {
  const requestId = 'req-' + crypto.randomUUID();
  const responseId = 'resp-' + crypto.randomUUID();
  const ts = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO requests (id, requester_id, title, body, request_type, priority, status,
     max_responses, response_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    requestId,
    agents.requesterId,
    'Ack-close integration test title',
    'A request body that is at least twenty characters long.',
    'review',
    'normal',
    'responded',
    3,
    1,
    ts,
    ts
  ).run();

  await env.DB.prepare(
    `INSERT INTO responses (id, request_id, responder_id, claim_id, parent_response_id, body, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(responseId, requestId, agents.responderId, null, null, 'Here is my response text for the integration test.', 0.9, ts).run();

  return { requestId, responseId };
}

// ─── Migration 0009 schema ────────────────────────────────────────────────────

describe('migration 0009 — lifecycle mechanics schema', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
    applyMigrationsSync(env);
  });

  it('requests table accepts ack-closed status', async () => {
    const agents = await seedAgents(env);
    const { requestId } = await seedRespondedRequest(env, agents);

    await env.DB.prepare(
      `UPDATE requests SET status = 'ack-closed' WHERE id = ?`
    ).bind(requestId).run();

    const row = await env.DB.prepare(
      'SELECT status FROM requests WHERE id = ?'
    ).bind(requestId).first<{ status: string }>();
    expect(row?.status).toBe('ack-closed');
  });

  it('requests table has outcome_json column (nullable)', async () => {
    const agents = await seedAgents(env);
    const { requestId } = await seedRespondedRequest(env, agents);

    const row = await env.DB.prepare(
      'SELECT outcome_json FROM requests WHERE id = ?'
    ).bind(requestId).first<{ outcome_json: string | null }>();
    expect(row?.outcome_json).toBeNull();
  });

  it('ratings table accepts nullable score', async () => {
    const agents = await seedAgents(env);
    const { responseId } = await seedRespondedRequest(env, agents);

    const ratingId = 'rat-' + crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO ratings (id, response_id, rater_id, direction, score, feedback, created_at, cross_owner, source_type)
       VALUES (?, ?, ?, 'requester_rates_helper', NULL, NULL, ?, 1, 'ack-close')`
    ).bind(ratingId, responseId, agents.requesterId, new Date().toISOString()).run();

    const row = await env.DB.prepare(
      'SELECT score, cross_owner, source_type FROM ratings WHERE id = ?'
    ).bind(ratingId).first<{ score: number | null; cross_owner: number; source_type: string }>();
    expect(row?.score).toBeNull();
    expect(row?.cross_owner).toBe(1);
    expect(row?.source_type).toBe('ack-close');
  });

  it('ratings table has cross_owner and source_type columns', async () => {
    const agents = await seedAgents(env);
    const { responseId } = await seedRespondedRequest(env, agents);

    const ratingId = 'rat-' + crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO ratings (id, response_id, rater_id, direction, score, feedback, created_at, cross_owner, source_type)
       VALUES (?, ?, ?, 'requester_rates_helper', 4, NULL, ?, 0, 'standard')`
    ).bind(ratingId, responseId, agents.requesterId, new Date().toISOString()).run();

    const row = await env.DB.prepare(
      'SELECT cross_owner, source_type FROM ratings WHERE id = ?'
    ).bind(ratingId).first<{ cross_owner: number; source_type: string }>();
    expect(row?.cross_owner).toBe(0);
    expect(row?.source_type).toBe('standard');
  });
});

// ─── POST /v1/requests/:id/ack-close ─────────────────────────────────────────

describe('POST /v1/requests/:id/ack-close', () => {
  let env: TestEnv;
  let agents: SeededAgents;
  let requestId: string;
  let responseId: string;

  beforeEach(async () => {
    env = createTestEnv();
    applyMigrationsSync(env);
    agents = await seedAgents(env);
    ({ requestId, responseId } = await seedRespondedRequest(env, agents));
  });

  function ackCloseReq(key: string, id: string, body?: object): Request {
    return new Request(`http://test.local/v1/requests/${id}/ack-close`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('transitions responded → ack-closed', async () => {
    const res = await app.fetch(ackCloseReq(agents.requesterKey, requestId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT status FROM requests WHERE id = ?'
    ).bind(requestId).first<{ status: string }>();
    expect(row?.status).toBe('ack-closed');
  });

  it('creates a rating row with NULL score when no quality supplied', async () => {
    const res = await app.fetch(ackCloseReq(agents.requesterKey, requestId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    const ratingId = body.data.rating.id;
    expect(body.data.rating.score).toBeNull();

    const row = await env.DB.prepare(
      'SELECT score, source_type FROM ratings WHERE id = ?'
    ).bind(ratingId).first<{ score: number | null; source_type: string }>();
    expect(row?.score).toBeNull();
    expect(row?.source_type).toBe('ack-close');
  });

  it('creates a rating row with score when quality supplied', async () => {
    const res = await app.fetch(ackCloseReq(agents.requesterKey, requestId, { quality: 4 }), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    const ratingId = body.data.rating.id;
    expect(body.data.rating.score).toBe(4);

    const row = await env.DB.prepare(
      'SELECT score FROM ratings WHERE id = ?'
    ).bind(ratingId).first<{ score: number | null }>();
    expect(row?.score).toBe(4);
  });

  it('cross_owner=0 when requester and responder share owner_id', async () => {
    // seedAgents gives both agents owner_id='owner-test'
    const res = await app.fetch(ackCloseReq(agents.requesterKey, requestId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.data.rating.cross_owner).toBe(0);

    const row = await env.DB.prepare(
      'SELECT cross_owner FROM ratings WHERE id = ?'
    ).bind(body.data.rating.id).first<{ cross_owner: number }>();
    expect(row?.cross_owner).toBe(0);
  });

  it('cross_owner=1 when requester and responder have different owner_ids', async () => {
    // Use cross-owner agents
    const xAgents = await seedCrossOwnerAgents(env);
    const { requestId: xReqId } = await seedRespondedRequest(env, xAgents);

    const res = await app.fetch(ackCloseReq(xAgents.requesterKey, xReqId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.data.rating.cross_owner).toBe(1);

    const row = await env.DB.prepare(
      'SELECT cross_owner FROM ratings WHERE id = ?'
    ).bind(body.data.rating.id).first<{ cross_owner: number }>();
    expect(row?.cross_owner).toBe(1);
  });

  it('writes outcome_json to the request', async () => {
    const res = await app.fetch(
      ackCloseReq(agents.requesterKey, requestId, { quality: 5, summary: 'Great help!' }),
      { ...env, ENVIRONMENT: 'test', MODE: 'community' as const }
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT outcome_json FROM requests WHERE id = ?'
    ).bind(requestId).first<{ outcome_json: string | null }>();
    expect(row?.outcome_json).not.toBeNull();

    const outcome = JSON.parse(row!.outcome_json!);
    expect(outcome.quality).toBe(5);
    expect(outcome.summary).toBe('Great help!');
  });

  it('403 if non-requester attempts ack-close', async () => {
    const res = await app.fetch(ackCloseReq(agents.responderKey, requestId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(403);

    const body = await res.json<any>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('409 if request not in responded state', async () => {
    // First ack-close succeeds
    await app.fetch(ackCloseReq(agents.requesterKey, requestId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });

    // Second ack-close: request is already ack-closed → 409
    const res = await app.fetch(ackCloseReq(agents.requesterKey, requestId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(409);

    const body = await res.json<any>();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('ack-closed');
  });

  it('400 if quality is out of range', async () => {
    const res = await app.fetch(ackCloseReq(agents.requesterKey, requestId, { quality: 6 }), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(400);

    const body = await res.json<any>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404 if request not found', async () => {
    const res = await app.fetch(ackCloseReq(agents.requesterKey, 'req-does-not-exist'), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /v1/requests/:id/claims/:claim_id — abandon ──────────────────────

describe('DELETE /v1/requests/:id/claims/:claim_id — abandon', () => {
  let env: TestEnv;
  let agents: SeededAgents;
  let requestId: string;

  async function seedOpenRequestAndClaim(
    env: TestEnv,
    agents: SeededAgents
  ): Promise<{ requestId: string; claimId: string }> {
    const reqId = 'req-' + crypto.randomUUID();
    const claimId = 'clm-' + crypto.randomUUID();
    const ts = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    await env.DB.prepare(
      `INSERT INTO requests (id, requester_id, title, body, request_type, priority, status,
       max_responses, response_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?)`
    ).bind(
      reqId,
      agents.requesterId,
      'Abandon integration test title',
      'A request body that is at least twenty characters long.',
      'review',
      'normal',
      3,
      0,
      ts,
      ts
    ).run();

    await env.DB.prepare(
      `INSERT INTO claims (id, request_id, agent_id, status, estimated_minutes, claimed_at, expires_at)
       VALUES (?, ?, ?, 'active', 60, ?, ?)`
    ).bind(claimId, reqId, agents.responderId, ts, expiresAt).run();

    return { requestId: reqId, claimId };
  }

  beforeEach(async () => {
    env = createTestEnv();
    applyMigrationsSync(env);
    agents = await seedAgents(env);
  });

  function abandonReq(key: string, reqId: string, claimId: string): Request {
    return new Request(`http://test.local/v1/requests/${reqId}/claims/${claimId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });
  }

  it('claim transitions to abandoned status', async () => {
    const { requestId, claimId } = await seedOpenRequestAndClaim(env, agents);

    const res = await app.fetch(abandonReq(agents.responderKey, requestId, claimId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT status FROM claims WHERE id = ?'
    ).bind(claimId).first<{ status: string }>();
    expect(row?.status).toBe('abandoned');
  });

  it('request reopens to open when no other active claims and no responses', async () => {
    const { requestId, claimId } = await seedOpenRequestAndClaim(env, agents);

    const res = await app.fetch(abandonReq(agents.responderKey, requestId, claimId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.data.request.status).toBe('open');

    const row = await env.DB.prepare(
      'SELECT status FROM requests WHERE id = ?'
    ).bind(requestId).first<{ status: string }>();
    expect(row?.status).toBe('open');
  });

  it('request stays in claimed when other active claims remain', async () => {
    const { requestId, claimId } = await seedOpenRequestAndClaim(env, agents);

    // Add a second active claim from a different agent
    const agent2Id = 'agent-other-' + crypto.randomUUID();
    const agent2Key = 'mycelia_live_' + 'e'.repeat(64);
    const agent2Hash = await sha256(agent2Key);
    const agent2Prefix = agent2Key.substring(0, 21);
    const ts = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO agents (id, name, owner_id, api_key_hash, key_prefix, trust_score, status, agent_tier, created_at, last_seen_at)
       VALUES (?, 'agent2', 'owner-other', ?, ?, 0.7, 'active', 'peer', ?, ?)`
    ).bind(agent2Id, agent2Hash, agent2Prefix, ts, ts).run();

    const claim2Id = 'clm-' + crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO claims (id, request_id, agent_id, status, estimated_minutes, claimed_at, expires_at)
       VALUES (?, ?, ?, 'active', 60, ?, ?)`
    ).bind(claim2Id, requestId, agent2Id, ts, expiresAt).run();

    const res = await app.fetch(abandonReq(agents.responderKey, requestId, claimId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.data.request.status).toBe('claimed');

    const row = await env.DB.prepare(
      'SELECT status FROM requests WHERE id = ?'
    ).bind(requestId).first<{ status: string }>();
    expect(row?.status).toBe('claimed');
  });

  it('403 if agent does not own the claim', async () => {
    const { requestId, claimId } = await seedOpenRequestAndClaim(env, agents);

    // requester tries to abandon responder's claim
    const res = await app.fetch(abandonReq(agents.requesterKey, requestId, claimId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(403);

    const body = await res.json<any>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('409 if claim is not active', async () => {
    const { requestId, claimId } = await seedOpenRequestAndClaim(env, agents);

    // Mark the claim as abandoned first
    await env.DB.prepare(
      `UPDATE claims SET status = 'abandoned' WHERE id = ?`
    ).bind(claimId).run();

    const res = await app.fetch(abandonReq(agents.responderKey, requestId, claimId), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(409);

    const body = await res.json<any>();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('404 if claim not found', async () => {
    const { requestId } = await seedOpenRequestAndClaim(env, agents);

    const res = await app.fetch(abandonReq(agents.responderKey, requestId, 'clm-does-not-exist'), { ...env, ENVIRONMENT: 'test', MODE: 'community' as const });
    expect(res.status).toBe(404);
  });
});
