// src/routes/events.ts
// Mounted at /v1/events in index.ts.
//
// Receives agent run-journal events forwarded by the shipper process.
// See AGENT-CONTRACT-v1.md §6 for the shipper contract.

import { Hono } from 'hono';
import type { Env, AuthContext, ShipBatchInput, ShipperEvent } from '../types';
import { authMiddleware, requireAgentKey } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { success, error, generateId, now } from '../lib/utils';

const events = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

events.use('*', authMiddleware);

// ─── POST /v1/events/batch — ingest a batch of run-journal events ─────────────
//
// Idempotency: journal_event_id = "<run_id>:<seq>". The UNIQUE constraint on
// that column means a duplicate is a no-op (INSERT OR IGNORE). A replay of
// the exact same batch will return accepted=0, skipped=N — no duplicates.
//
// Atomicity: DB.batch() wraps all inserts in an implicit transaction. Either
// all new events land or none do. Existing events (idempotency hits) are
// silently skipped by INSERT OR IGNORE, which does not count as an error for
// D1's batch semantics.
//
// Constraints:
//   - ≤500 events per call (hard limit; callers batch larger sets)
//   - run_id must be non-empty
//   - Each event: seq (positive integer), t (non-empty), bob (non-empty), ev (non-empty)
//   - seq must be unique within the submitted batch (not enforced DB-side for
//     cross-batch, but detected within a single call to surface shipper bugs)
//
// event_type stays opaque: Mycelia stores whatever string ev contains.
// The agent contract (§4.3) defines the vocabulary; Mycelia does not validate it.

events.post('/batch', requireAgentKey, rateLimit('events.batch'), async (c) => {
  const auth = c.get('auth');

  let input: ShipBatchInput;
  try {
    input = await c.req.json<ShipBatchInput>();
  } catch {
    return c.json(error('VALIDATION_ERROR', 'Invalid JSON body', 400).body, 400);
  }

  // Validate run_id
  if (!input.run_id || typeof input.run_id !== 'string' || input.run_id.trim() === '') {
    return c.json(error('VALIDATION_ERROR', 'run_id must be a non-empty string', 400).body, 400);
  }
  const runId = input.run_id.trim();

  // Validate events array
  if (!Array.isArray(input.events)) {
    return c.json(error('VALIDATION_ERROR', 'events must be an array', 400).body, 400);
  }
  if (input.events.length === 0) {
    return c.json(error('VALIDATION_ERROR', 'events array must not be empty', 400).body, 400);
  }
  if (input.events.length > 500) {
    return c.json(
      error('VALIDATION_ERROR', `events array exceeds maximum of 500 (got ${input.events.length})`, 400).body,
      400
    );
  }

  // Validate individual events and detect within-batch seq duplicates
  const seenSeqs = new Set<number>();
  for (let i = 0; i < input.events.length; i++) {
    const ev = input.events[i];

    if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq < 1) {
      return c.json(
        error('VALIDATION_ERROR', `events[${i}].seq must be a positive integer (got ${JSON.stringify(ev.seq)})`, 400).body,
        400
      );
    }
    if (seenSeqs.has(ev.seq)) {
      return c.json(
        error('VALIDATION_ERROR', `Duplicate seq ${ev.seq} within batch — each event must have a unique seq`, 400).body,
        400
      );
    }
    seenSeqs.add(ev.seq);

    if (typeof ev.t !== 'string' || ev.t.trim() === '') {
      return c.json(
        error('VALIDATION_ERROR', `events[${i}].t must be a non-empty ISO 8601 timestamp`, 400).body,
        400
      );
    }
    if (typeof ev.bob !== 'string' || ev.bob.trim() === '') {
      return c.json(
        error('VALIDATION_ERROR', `events[${i}].bob must be a non-empty agent name`, 400).body,
        400
      );
    }
    if (typeof ev.ev !== 'string' || ev.ev.trim() === '') {
      return c.json(
        error('VALIDATION_ERROR', `events[${i}].ev must be a non-empty event type`, 400).body,
        400
      );
    }
  }

  const receivedAt = now();

  // Build DB.batch() statements using INSERT OR IGNORE for idempotency.
  // INSERT OR IGNORE silently skips a row when journal_event_id already exists.
  // D1 batch() wraps all in an implicit transaction — all new, or none.
  //
  // We cannot get a per-row "was this inserted or skipped?" from D1's batch API
  // directly. Instead we count affected rows from the meta.changes field of
  // each result.
  const statements = input.events.map((ev: ShipperEvent) => {
    const journalEventId = `${runId}:${ev.seq}`;
    return c.env.DB.prepare(`
      INSERT OR IGNORE INTO shipper_events
        (id, journal_event_id, run_id, seq, bob, planet, event_type, payload, t, received_at, agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId(),
      journalEventId,
      runId,
      ev.seq,
      ev.bob,
      ev.planet ?? null,
      ev.ev,
      ev.v !== undefined ? JSON.stringify(ev.v) : null,
      ev.t,
      receivedAt,
      auth.agent_id
    );
  });

  const results = await c.env.DB.batch(statements);

  // Count accepted (changes=1) vs skipped (changes=0, INSERT OR IGNORE hit the unique index).
  let accepted = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.meta.changes > 0) {
      accepted++;
    } else {
      skipped++;
    }
  }

  return c.json(success({ accepted, skipped }), 200);
});

// ─── GET /v1/events?run_id=<id>&bob=<name> — query stored events ─────────────
//
// Simple read endpoint for inspection and debugging. Not paginated for now;
// a run typically has <100 semantic events (tool.call is excluded at shipper).

events.get('/', requireAgentKey, rateLimit('read'), async (c) => {
  const auth = c.get('auth');
  const runId = c.req.query('run_id');
  const bob = c.req.query('bob');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);

  if (!runId && !bob) {
    return c.json(error('VALIDATION_ERROR', 'Provide at least one of run_id or bob to filter events', 400).body, 400);
  }

  let query: string;
  let bindings: unknown[];

  if (runId && bob) {
    query = `SELECT * FROM shipper_events WHERE agent_id = ? AND run_id = ? AND bob = ? ORDER BY seq ASC LIMIT ?`;
    bindings = [auth.agent_id, runId, bob, limit];
  } else if (runId) {
    query = `SELECT * FROM shipper_events WHERE agent_id = ? AND run_id = ? ORDER BY seq ASC LIMIT ?`;
    bindings = [auth.agent_id, runId, limit];
  } else {
    query = `SELECT * FROM shipper_events WHERE agent_id = ? AND bob = ? ORDER BY received_at DESC LIMIT ?`;
    bindings = [auth.agent_id, bob!, limit];
  }

  const rows = await c.env.DB.prepare(query).bind(...bindings).all();

  return c.json(success({ events: rows.results, total: rows.results.length }), 200);
});

export default events;
