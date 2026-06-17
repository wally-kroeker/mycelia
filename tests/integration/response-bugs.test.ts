// tests/integration/response-bugs.test.ts
//
// Regression suite for the four bugs surfaced 2026-06-16/17 by CeeCee's
// memoir-worthy-moment request (7f5cd691). Each test:
//   1. Sets up a fresh in-memory D1 with migrations 0001/0002/0003
//   2. Exercises the production handler via app.fetch()
//   3. Asserts the post-state matches the FIX'd behaviour
//
// Without the fixes, these tests would catch the regression class before it
// reaches a live request from another fleet member.

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/index';
import {
  applyMigrationsSync,
  createTestEnv,
  seedAgents,
  seedDirectedRequest,
  SeededAgents,
  TestEnv,
} from './_fixtures';

interface SetupResult {
  env: TestEnv;
  agents: SeededAgents;
  requestId: string;
}

async function setup(): Promise<SetupResult> {
  const env = createTestEnv();
  applyMigrationsSync(env);
  const agents = await seedAgents(env);
  const { requestId } = await seedDirectedRequest(env, agents);
  return { env, agents, requestId };
}

function authReq(path: string, key: string, body?: object, method = 'POST'): Request {
  return new Request(`http://test.local${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ENV_EXTRAS = { ENVIRONMENT: 'test' };

describe('B1 — tier-refused response leaves no zombie claim', () => {
  it('claim → tier-escalated response → 403 ASK_EXCEEDS_TIER → claim STILL active', async () => {
    const { env, agents, requestId } = await setup();
    const fullEnv = { ...env, ...ENV_EXTRAS };

    // Step 1: responder claims
    const claimRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );
    expect(claimRes.status).toBe(201);

    const claimRow = await env.DB.prepare(
      `SELECT id, status FROM claims WHERE request_id = ? AND agent_id = ?`
    ).bind(requestId, agents.responderId).first<{ id: string; status: string }>();
    expect(claimRow?.status).toBe('active');
    const claimId = claimRow!.id;

    // Step 2: responder posts response with cohort tier against public ask
    const respRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/responses`, agents.responderKey, {
        body: 'A response body of at least twenty characters that exceeds the public ask tier with cohort content.',
        body_tier: 'cohort',
      }),
      fullEnv
    );
    expect(respRes.status).toBe(403);
    const respJson = await respRes.json() as any;
    expect(respJson.error?.code).toBe('ASK_EXCEEDS_TIER');

    // Step 3: B1 invariant — claim must STILL be active. Pre-fix, the handler
    // marked the claim 'completed' before validating tier, so a tier failure
    // left a zombie. Post-fix, tier validation runs first and the claim row
    // is untouched.
    const claimAfter = await env.DB.prepare(
      `SELECT status FROM claims WHERE id = ?`
    ).bind(claimId).first<{ status: string }>();
    expect(claimAfter?.status).toBe('active');

    // Step 4: no response row inserted
    const responses = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM responses WHERE request_id = ?`
    ).bind(requestId).first<{ c: number }>();
    expect(responses?.c).toBe(0);
  });
});

describe('B2 — re-claim after completed claim succeeds', () => {
  it('claim → respond (claim completes) → claim again → 201', async () => {
    const { env, agents, requestId } = await setup();
    const fullEnv = { ...env, ...ENV_EXTRAS };

    // First cycle: claim + respond (max_responses=3 so request stays open)
    const claim1 = await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );
    expect(claim1.status).toBe(201);

    const resp1 = await app.fetch(
      authReq(`/v1/requests/${requestId}/responses`, agents.responderKey, {
        body: 'First substantive response of at least twenty characters length.',
        body_tier: 'public',
      }),
      fullEnv
    );
    expect(resp1.status).toBe(201);

    const claimAfter = await env.DB.prepare(
      `SELECT status FROM claims WHERE request_id = ? AND agent_id = ?`
    ).bind(requestId, agents.responderId).first<{ status: string }>();
    expect(claimAfter?.status).toBe('completed');

    // Second cycle: re-claim. Pre-B2-migration: UNIQUE INDEX on (request, agent)
    // ignoring status would throw a unique-violation → 500. Post-migration:
    // the partial unique index only covers status='active' rows, so a new
    // INSERT with status='active' succeeds alongside the existing 'completed' row.
    const claim2 = await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );
    expect(claim2.status).toBe(201);

    const claimRows = await env.DB.prepare(
      `SELECT id, status FROM claims WHERE request_id = ? AND agent_id = ? ORDER BY claimed_at`
    ).bind(requestId, agents.responderId).all<{ id: string; status: string }>();
    expect(claimRows.results.length).toBe(2);
    expect(claimRows.results.map((r) => r.status).sort()).toEqual(['active', 'completed']);
  });
});

describe('B3 — response to open-status request with valid claim succeeds', () => {
  it('claim → simulate cron-flip (request → open) → respond → 201 + responded', async () => {
    const { env, agents, requestId } = await setup();
    const fullEnv = { ...env, ...ENV_EXTRAS };

    const claimRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );
    expect(claimRes.status).toBe(201);

    // Simulate the cron's reclaim-check that yesterday's incident demonstrated:
    // if request gets reset to 'open' while my claim is still active, my response
    // should still go through. Pre-B3: state machine throws InvalidTransitionError
    // (open → responded refused) → handler returns 500.
    await env.DB.prepare(`UPDATE requests SET status = 'open' WHERE id = ?`).bind(requestId).run();

    const respRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/responses`, agents.responderKey, {
        body: 'Response that arrives while the request status has been flipped back to open by cron.',
        body_tier: 'public',
      }),
      fullEnv
    );
    expect(respRes.status).toBe(201);

    const reqAfter = await env.DB.prepare(
      `SELECT status, response_count FROM requests WHERE id = ?`
    ).bind(requestId).first<{ status: string; response_count: number }>();
    expect(reqAfter?.status).toBe('responded');
    expect(reqAfter?.response_count).toBe(1);
  });
});

describe('B7 — request creation handler writes are atomic via batch', () => {
  it('forensic — POST /v1/requests invokes DB.batch() rather than independent .run() calls', async () => {
    // Pre-B7 the request handler ran INSERT requests + INSERT request_tags
    // (N iterations) + UPDATE agents as independent awaits. A mid-sequence
    // failure could leave a request without its capability tags, making it
    // undiscoverable via capability matching.
    const env = createTestEnv();
    applyMigrationsSync(env);
    const agents = await seedAgents(env);
    const fullEnv = { ...env, ...ENV_EXTRAS };

    // Seed a capability tag so the request can pass tag validation
    await env.DB.prepare(
      'INSERT INTO capabilities (id, tag, category, description, created_at) VALUES (1, ?, ?, ?, ?)'
    ).bind('test-tag', 'general', 'Integration test capability', new Date().toISOString()).run();

    env.DB.resetCounters();

    const reqRes = await app.fetch(
      new Request('http://test.local/v1/requests', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${agents.requesterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Integration test request title',
          body: 'A request body that is at least twenty characters long for the validator.',
          request_type: 'second-opinion',
          tags: ['test-tag'],
        }),
      }),
      fullEnv
    );
    expect(reqRes.status).toBe(201);

    // Post-B7: at least one batch call wrapping the INSERT-request +
    // request_tags + UPDATE-agents triple.
    expect(env.DB.batchCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('B5 — claim handler writes are atomic via batch', () => {
  it('forensic — claim handler invokes DB.batch() rather than independent .run() calls', async () => {
    // Pre-B5 the claim handler ran INSERT claims + UPDATE requests as two
    // independent awaits. A D1 transient on the UPDATE would leave the claim
    // committed but the request still 'open' — agent locked out of re-claim
    // (constraint 6 detects active claim) while request appears unclaimed.
    const { env, agents, requestId } = await setup();
    const fullEnv = { ...env, ...ENV_EXTRAS };

    env.DB.resetCounters();

    const claimRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );
    expect(claimRes.status).toBe(201);

    // Post-B5: at least one batch call for the INSERT-claim + UPDATE-request pair.
    expect(env.DB.batchCalls).toBeGreaterThanOrEqual(1);
  });

  it('post-condition lockstep — claim creation transitions request status atomically', async () => {
    const { env, agents, requestId } = await setup();
    const fullEnv = { ...env, ...ENV_EXTRAS };

    const claimRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );
    expect(claimRes.status).toBe(201);

    const claimRow = await env.DB.prepare(
      `SELECT status FROM claims WHERE request_id = ? AND agent_id = ?`
    ).bind(requestId, agents.responderId).first<{ status: string }>();
    const reqRow = await env.DB.prepare(
      `SELECT status FROM requests WHERE id = ?`
    ).bind(requestId).first<{ status: string }>();

    // Either both succeeded (active + claimed) or batch rolled back (no claim row).
    // The "claim active but request still open" partial-commit state is what
    // pre-B5 could produce. Post-B5 this never happens.
    expect(claimRow?.status).toBe('active');
    expect(reqRow?.status).toBe('claimed');
  });
});

describe('B4 — response handler writes are atomic via batch', () => {
  it('forensic — response handler invokes DB.batch() rather than independent .run() calls', async () => {
    // Forensic test that fails against pre-fix code: pre-B4 the handler ran
    // INSERT response, UPDATE requests, UPDATE agents as three independent
    // awaits (writeRuns = 3, batchCalls = 0). Post-B4 those three writes are
    // collapsed into a single DB.batch() call (writeRuns counts only
    // non-batched mutations; batchCalls = 1 for the response-creation path).
    const { env, agents, requestId } = await setup();
    const fullEnv = { ...env, ...ENV_EXTRAS };

    // Claim first (this itself runs an INSERT + UPDATE outside the batch path;
    // we only care about the response handler's behaviour).
    await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );

    // Reset counters so we measure the response handler in isolation.
    env.DB.resetCounters();

    const respRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/responses`, agents.responderKey, {
        body: 'Substantive response of at least twenty characters in length for the validator.',
        body_tier: 'public',
      }),
      fullEnv
    );
    expect(respRes.status).toBe(201);

    // Post-B4 invariant: the response-creation writes (claim mark-completed,
    // INSERT response, UPDATE requests, UPDATE agents) are collapsed into one
    // DB.batch() call. Pre-fix: batchCalls = 0 because the handler ran each
    // write as an independent await. Post-fix: batchCalls >= 1.
    //
    // writeRuns isn't a useful signal here because middleware-level writes
    // (auth's last_seen UPDATE — runs twice due to overlapping route mounts)
    // and the best-effort audit-log INSERT legitimately stay outside the batch.
    expect(env.DB.batchCalls).toBeGreaterThanOrEqual(1);
  });

  it('post-condition lockstep — successful response leaves all four counters consistent', async () => {
    const { env, agents, requestId } = await setup();
    const fullEnv = { ...env, ...ENV_EXTRAS };

    const agentBefore = await env.DB.prepare(
      `SELECT response_count FROM agents WHERE id = ?`
    ).bind(agents.responderId).first<{ response_count: number }>();

    await app.fetch(
      authReq(`/v1/requests/${requestId}/claims`, agents.responderKey, { estimated_minutes: 10 }),
      fullEnv
    );
    const respRes = await app.fetch(
      authReq(`/v1/requests/${requestId}/responses`, agents.responderKey, {
        body: 'Substantive response of at least twenty characters in length for the validator.',
        body_tier: 'public',
      }),
      fullEnv
    );
    expect(respRes.status).toBe(201);

    const reqAfter = await env.DB.prepare(
      `SELECT status, response_count FROM requests WHERE id = ?`
    ).bind(requestId).first<{ status: string; response_count: number }>();
    const respCount = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM responses WHERE request_id = ?`
    ).bind(requestId).first<{ c: number }>();
    const agentAfter = await env.DB.prepare(
      `SELECT response_count FROM agents WHERE id = ?`
    ).bind(agents.responderId).first<{ response_count: number }>();

    expect(reqAfter?.status).toBe('responded');
    expect(reqAfter?.response_count).toBe(1);
    expect(respCount?.c).toBe(1);
    expect(agentAfter?.response_count).toBe((agentBefore?.response_count ?? 0) + 1);
  });

  it('all-or-nothing: a forced batch failure leaves zero side-effects', async () => {
    // Adapter-level proof of atomicity. The handler is wired to the same batch
    // primitive, so handler-level atomicity inherits from this.
    const env = createTestEnv();
    applyMigrationsSync(env);
    const agents = await seedAgents(env);
    const { requestId } = await seedDirectedRequest(env, agents);

    const before = await env.DB.prepare(`SELECT response_count FROM requests WHERE id = ?`)
      .bind(requestId).first<{ response_count: number }>();

    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE requests SET response_count = response_count + 1, updated_at = ? WHERE id = ?`
        ).bind(new Date().toISOString(), requestId),
        // Deliberately violate a CHECK constraint to force the batch to abort
        env.DB.prepare(
          `INSERT INTO requests (id, requester_id, title, body, request_type, priority, status, max_responses, response_count, created_at, updated_at)
           VALUES ('forced-fail', ?, 't', 'body twenty plus chars long for validator', 'second-opinion', 'normal', 'INVALID_STATUS', 3, 0, ?, ?)`
        ).bind(agents.requesterId, new Date().toISOString(), new Date().toISOString()),
      ]);
      expect.fail('expected batch to throw');
    } catch (_) {
      // expected
    }

    const after = await env.DB.prepare(`SELECT response_count FROM requests WHERE id = ?`)
      .bind(requestId).first<{ response_count: number }>();
    expect(after?.response_count).toBe(before?.response_count); // rollback
  });
});
