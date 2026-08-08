// tests/integration/phase5-shipper-contract.test.ts
//
// Phase 5 (fleet-coordination-v1): shipper contract — POST /v1/events/batch
//
// Core invariant: replay safety.
// Ship a batch, ship the exact same batch again — second call must return
// accepted=0, skipped=N with no duplicates in the DB. The UNIQUE constraint
// on journal_event_id is the mechanism; this test suite proves it holds.
//
// Covers:
//   - Migration 0010: shipper_events table + indexes exist
//   - POST /v1/events/batch:
//       • accepts a valid batch, returns accepted/skipped counts
//       • idempotency: replay returns accepted=0, skipped=N (no duplicates)
//       • partial replay: new events accepted, existing events skipped
//       • ≤500 limit enforced (501 events → 400)
//       • run_id required (absent → 400)
//       • empty events array → 400
//       • per-event validation: seq, t, bob, ev
//       • within-batch duplicate seq → 400
//       • out-of-order seq accepted (batch need not be ordered)
//       • tool.call events accepted (shipper filtering is client-side; Mycelia doesn't enforce)
//       • any-order acceptance: seq 5,3,1 stored in seq order
//       • requires authentication
//   - GET /v1/events:
//       • returns events for a run, filtered by agent_id
//       • agents cannot read each other's events
//   - Wally's requirement: node with no shippers has empty table, normal behaviour

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

const MODE_ENV = { ENVIRONMENT: 'test', MODE: 'community' as const };

function batchReq(key: string, body: object): Request {
  return new Request('http://test.local/v1/events/batch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeEvent(seq: number, overrides: Partial<{
  t: string; bob: string; planet: string; ev: string; v: unknown
}> = {}) {
  return {
    seq,
    t: overrides.t ?? '2026-08-07T21:00:00Z',
    bob: overrides.bob ?? 'mario',
    planet: overrides.planet ?? 'mycelia',
    ev: overrides.ev ?? 'task.progress',
    v: overrides.v ?? { step: `step-${seq}` },
  };
}

function validBatch(runId: string, count: number = 3): object {
  return {
    run_id: runId,
    events: Array.from({ length: count }, (_, i) => makeEvent(i + 1)),
  };
}

// ─── Migration 0010 schema ────────────────────────────────────────────────────

describe('migration 0010 — shipper_events schema', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
    applyMigrationsSync(env);
  });

  it('shipper_events table exists', async () => {
    const row = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='shipper_events'`
    ).first<{ name: string }>();
    expect(row?.name).toBe('shipper_events');
  });

  it('journal_event_id column has UNIQUE constraint', async () => {
    const agents = await seedAgents(env);
    const ts = new Date().toISOString();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO shipper_events (id, journal_event_id, run_id, seq, bob, planet, event_type, payload, t, received_at, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id1, 'run1:1', 'run1', 1, 'mario', 'mycelia', 'task.claim', null, ts, ts, agents.requesterId).run();

    // Second INSERT with same journal_event_id — must fail
    await expect(
      env.DB.prepare(
        `INSERT INTO shipper_events (id, journal_event_id, run_id, seq, bob, planet, event_type, payload, t, received_at, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id2, 'run1:1', 'run1', 1, 'mario', 'mycelia', 'task.claim', null, ts, ts, agents.requesterId).run()
    ).rejects.toThrow();
  });

  it('INSERT OR IGNORE skips duplicate without error', async () => {
    const agents = await seedAgents(env);
    const ts = new Date().toISOString();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO shipper_events (id, journal_event_id, run_id, seq, bob, planet, event_type, payload, t, received_at, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id1, 'run2:1', 'run2', 1, 'mario', 'mycelia', 'run.start', null, ts, ts, agents.requesterId).run();

    // Second insert — INSERT OR IGNORE, must not throw
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO shipper_events (id, journal_event_id, run_id, seq, bob, planet, event_type, payload, t, received_at, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id2, 'run2:1', 'run2', 1, 'mario', 'mycelia', 'run.start', null, ts, ts, agents.requesterId).run();
    expect(res.meta.changes).toBe(0); // 0 = skipped

    // Only one row with this journal_event_id
    const count = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM shipper_events WHERE journal_event_id = 'run2:1'`
    ).first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it('node with no shipper events has empty table — normal behaviour unaffected', async () => {
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM shipper_events'
    ).first<{ c: number }>();
    expect(count?.c).toBe(0);

    // Requests still work (smoke check that shipper_events doesn't interfere)
    const agentCount = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM agents'
    ).first<{ c: number }>();
    expect(agentCount?.c).toBe(0);
  });
});

// ─── POST /v1/events/batch ────────────────────────────────────────────────────

describe('POST /v1/events/batch', () => {
  let env: TestEnv;
  let agents: SeededAgents;

  beforeEach(async () => {
    env = createTestEnv();
    applyMigrationsSync(env);
    agents = await seedAgents(env);
  });

  it('accepts a valid batch and returns accepted/skipped counts', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, validBatch('run-abc', 3)),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.ok).toBe(true);
    expect(body.data.accepted).toBe(3);
    expect(body.data.skipped).toBe(0);
  });

  it('stores events in the DB', async () => {
    await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: 'run-store-test',
        events: [
          makeEvent(1, { ev: 'run.start', bob: 'mario', planet: 'mycelia' }),
          makeEvent(2, { ev: 'task.claim', v: { task: 't-0001' } }),
        ],
      }),
      { ...env, ...MODE_ENV }
    );

    const rows = await env.DB.prepare(
      `SELECT event_type, seq, bob, planet FROM shipper_events WHERE run_id = ? ORDER BY seq`
    ).bind('run-store-test').all<{ event_type: string; seq: number; bob: string; planet: string }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].event_type).toBe('run.start');
    expect(rows.results[0].seq).toBe(1);
    expect(rows.results[0].bob).toBe('mario');
    expect(rows.results[0].planet).toBe('mycelia');
    expect(rows.results[1].event_type).toBe('task.claim');
  });

  // ─── CORE INVARIANT: replay safety ─────────────────────────────────────────

  it('REPLAY SAFETY: second identical batch returns accepted=0, skipped=N, no duplicates', async () => {
    const runId = 'run-replay-' + crypto.randomUUID().slice(0, 8);
    const batch = validBatch(runId, 5);

    // First ship
    const res1 = await app.fetch(batchReq(agents.requesterKey, batch), { ...env, ...MODE_ENV });
    expect(res1.status).toBe(200);
    const body1 = await res1.json<any>();
    expect(body1.data.accepted).toBe(5);
    expect(body1.data.skipped).toBe(0);

    // Replay — exact same batch
    const res2 = await app.fetch(batchReq(agents.requesterKey, batch), { ...env, ...MODE_ENV });
    expect(res2.status).toBe(200);
    const body2 = await res2.json<any>();
    expect(body2.data.accepted).toBe(0); // all skipped
    expect(body2.data.skipped).toBe(5);

    // DB still has exactly 5 rows — no duplicates
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM shipper_events WHERE run_id = ?'
    ).bind(runId).first<{ c: number }>();
    expect(count?.c).toBe(5);
  });

  it('partial replay: new events accepted, existing events skipped', async () => {
    const runId = 'run-partial-' + crypto.randomUUID().slice(0, 8);

    // Ship events 1-3
    const res1 = await app.fetch(
      batchReq(agents.requesterKey, { run_id: runId, events: [makeEvent(1), makeEvent(2), makeEvent(3)] }),
      { ...env, ...MODE_ENV }
    );
    expect((await res1.json<any>()).data.accepted).toBe(3);

    // Ship events 2-5 (2+3 already present, 4+5 new)
    const res2 = await app.fetch(
      batchReq(agents.requesterKey, { run_id: runId, events: [makeEvent(2), makeEvent(3), makeEvent(4), makeEvent(5)] }),
      { ...env, ...MODE_ENV }
    );
    const body2 = await res2.json<any>();
    expect(body2.data.accepted).toBe(2); // 4 and 5 are new
    expect(body2.data.skipped).toBe(2);  // 2 and 3 already present

    // DB has exactly 5 rows
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM shipper_events WHERE run_id = ?'
    ).bind(runId).first<{ c: number }>();
    expect(count?.c).toBe(5);
  });

  it('accepts events in any order — stored by seq', async () => {
    const runId = 'run-order-' + crypto.randomUUID().slice(0, 8);

    // Submit seq 5, 3, 1 (reverse order)
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: runId,
        events: [makeEvent(5), makeEvent(3), makeEvent(1)],
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.data.accepted).toBe(3);

    // Stored rows should have the correct seqs
    const rows = await env.DB.prepare(
      'SELECT seq FROM shipper_events WHERE run_id = ? ORDER BY seq'
    ).bind(runId).all<{ seq: number }>();
    expect(rows.results.map((r) => r.seq)).toEqual([1, 3, 5]);
  });

  it('tool.call events are accepted — filtering is client-side (§4.3)', async () => {
    // Mycelia must not enforce the shipper's filtering policy.
    // The shipper skips tool.call before sending; the server accepts any ev.
    const runId = 'run-toolcall-' + crypto.randomUUID().slice(0, 8);
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: runId,
        events: [makeEvent(1, { ev: 'tool.call', v: { tool: 'Read', target: 'src/index.ts' } })],
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.data.accepted).toBe(1);
  });

  it('payload v field stored as JSON string', async () => {
    const runId = 'run-payload-' + crypto.randomUUID().slice(0, 8);
    const payload = { task: 't-0042', quality: 4, note: 'clean fix' };
    await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: runId,
        events: [makeEvent(1, { ev: 'task.ack_close', v: payload })],
      }),
      { ...env, ...MODE_ENV }
    );

    const row = await env.DB.prepare(
      'SELECT payload FROM shipper_events WHERE run_id = ? AND seq = 1'
    ).bind(runId).first<{ payload: string }>();
    expect(JSON.parse(row!.payload)).toEqual(payload);
  });

  it('events without v field store NULL payload', async () => {
    const runId = 'run-noV-' + crypto.randomUUID().slice(0, 8);
    await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: runId,
        events: [{ seq: 1, t: '2026-08-07T21:00:00Z', bob: 'mario', ev: 'run.end' }],
      }),
      { ...env, ...MODE_ENV }
    );

    const row = await env.DB.prepare(
      'SELECT payload FROM shipper_events WHERE run_id = ? AND seq = 1'
    ).bind(runId).first<{ payload: string | null }>();
    expect(row?.payload).toBeNull();
  });

  // ─── Validation ────────────────────────────────────────────────────────────

  it('400 if events array exceeds 500', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: 'run-too-big',
        events: Array.from({ length: 501 }, (_, i) => makeEvent(i + 1)),
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('500');
  });

  it('400 if run_id is absent', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, { events: [makeEvent(1)] }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe('VALIDATION_ERROR');
  });

  it('400 if run_id is empty string', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, { run_id: '', events: [makeEvent(1)] }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('400 if events array is empty', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, { run_id: 'run-empty', events: [] }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe('VALIDATION_ERROR');
  });

  it('400 if event seq is not a positive integer', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: 'run-bad-seq',
        events: [{ seq: 0, t: '2026-08-07T21:00:00Z', bob: 'mario', ev: 'run.start' }],
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.message).toContain('seq');
  });

  it('400 if event seq is a float', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: 'run-float-seq',
        events: [{ seq: 1.5, t: '2026-08-07T21:00:00Z', bob: 'mario', ev: 'run.start' }],
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('400 if within-batch duplicate seq detected', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: 'run-dup-seq',
        events: [makeEvent(1), makeEvent(2), makeEvent(1)], // seq 1 appears twice
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.message).toContain('seq');
  });

  it('400 if event bob is empty', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: 'run-no-bob',
        events: [{ seq: 1, t: '2026-08-07T21:00:00Z', bob: '', ev: 'run.start' }],
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('400 if event ev is empty', async () => {
    const res = await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: 'run-no-ev',
        events: [{ seq: 1, t: '2026-08-07T21:00:00Z', bob: 'mario', ev: '' }],
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('401 if no API key provided', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/events/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBatch('run-unauth')),
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(401);
  });
});

// ─── GET /v1/events ───────────────────────────────────────────────────────────

describe('GET /v1/events', () => {
  let env: TestEnv;
  let agents: SeededAgents;
  const runId = 'run-get-' + 'a'.repeat(8);

  beforeEach(async () => {
    env = createTestEnv();
    applyMigrationsSync(env);
    agents = await seedAgents(env);

    // Pre-populate some events
    await app.fetch(
      batchReq(agents.requesterKey, {
        run_id: runId,
        events: [
          makeEvent(1, { ev: 'run.start', bob: 'mario' }),
          makeEvent(2, { ev: 'task.claim', bob: 'mario' }),
          makeEvent(3, { ev: 'task.deliver', bob: 'mario' }),
        ],
      }),
      { ...env, ...MODE_ENV }
    );
  });

  function getReq(key: string, params: Record<string, string>): Request {
    const qs = new URLSearchParams(params).toString();
    return new Request(`http://test.local/v1/events?${qs}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  }

  it('returns events for a run_id', async () => {
    const res = await app.fetch(getReq(agents.requesterKey, { run_id: runId }), { ...env, ...MODE_ENV });
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.data.total).toBe(3);
    expect(body.data.events[0].event_type).toBe('run.start');
    expect(body.data.events[2].event_type).toBe('task.deliver');
  });

  it('returns events by bob name', async () => {
    const res = await app.fetch(getReq(agents.requesterKey, { bob: 'mario' }), { ...env, ...MODE_ENV });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.data.total).toBe(3);
  });

  it('400 if neither run_id nor bob is provided', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/events', {
        headers: { Authorization: `Bearer ${agents.requesterKey}` },
      }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('responder cannot read requester events (agent_id isolation)', async () => {
    // Both agents share same owner_id in seedAgents, but events are stored
    // with the posting agent_id. Requester posted; responder reads back nothing.
    const res = await app.fetch(
      getReq(agents.responderKey, { run_id: runId }),
      { ...env, ...MODE_ENV }
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    // Responder's agent_id filter means they see 0 rows
    expect(body.data.total).toBe(0);
  });
});
