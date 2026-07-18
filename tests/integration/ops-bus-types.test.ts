// tests/integration/ops-bus-types.test.ts
//
// v1.2 ops-bus request types: the six operational-coordination types added to
// RequestType must be accepted end-to-end (validation → CHECK constraint →
// tags), and migration 0006 must seed the six matching capability tags in the
// same migration that widens the enum. The two halves are tested together on
// purpose: shipping the enum without the tags left agents with a request_type
// they could select but no honest tag to attach — in a production fleet
// deployment that locked an agent out of the bus for hours.

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/index';
import {
  applyMigrationsSync,
  createTestEnv,
  seedAgents,
  SeededAgents,
  TestEnv,
} from './_fixtures';

const OPS_BUS_TYPES = [
  'handoff',
  'collision-warn',
  'status-sync',
  'delegate',
  'ack-close',
  'blocker',
] as const;

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

const ENV_EXTRAS = { ENVIRONMENT: 'test', MODE: 'community' as const };

describe('v1.2 ops-bus request types', () => {
  let env: TestEnv;
  let agents: SeededAgents;

  beforeEach(async () => {
    env = createTestEnv();
    applyMigrationsSync(env);
    agents = await seedAgents(env);
  });

  it('migration 0006 seeds all six ops-bus capability tags', async () => {
    const rows = await env.DB.prepare(
      `SELECT tag, category, description FROM capabilities WHERE category = 'ops-bus' ORDER BY tag`
    ).all<{ tag: string; category: string; description: string }>();
    const tags = rows.results.map((r) => r.tag);
    expect(tags).toEqual([...OPS_BUS_TYPES].sort());
    for (const row of rows.results) {
      expect(row.category).toBe('ops-bus');
      expect(row.description).toBeTruthy();
    }
  });

  for (const type of OPS_BUS_TYPES) {
    it(`accepts request_type '${type}' tagged with its matching capability`, async () => {
      const fullEnv = { ...env, ...ENV_EXTRAS };
      const res = await app.fetch(
        authReq('/v1/requests', agents.requesterKey, {
          title: `Ops-bus integration: ${type}`,
          body: 'A request body that is at least twenty characters long for the validator.',
          request_type: type,
          tags: [type], // the seeded ops-bus tag — proves enum and taxonomy move together
        }),
        fullEnv
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as any;
      expect(json.data?.request?.id).toBeTruthy();

      // The row must land with the ops-bus type intact (DB CHECK widened too).
      const row = await env.DB.prepare(
        `SELECT request_type FROM requests WHERE id = ?`
      ).bind(json.data.request.id).first<{ request_type: string }>();
      expect(row?.request_type).toBe(type);
    });
  }

  it('still rejects an unknown request_type', async () => {
    const fullEnv = { ...env, ...ENV_EXTRAS };
    const res = await app.fetch(
      authReq('/v1/requests', agents.requesterKey, {
        title: 'Ops-bus integration: bad type',
        body: 'A request body that is at least twenty characters long for the validator.',
        request_type: 'not-a-type',
        tags: ['handoff'],
      }),
      fullEnv
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error?.code).toBe('VALIDATION_ERROR');
  });

  it('requests table survives the 0006 rebuild with indexes and FK integrity intact', async () => {
    // The rebuild must not touch the claims partial unique index from 0003...
    const idx = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_claims_request_agent_active'`
    ).first<{ name: string; sql: string }>();
    expect(idx?.name).toBe('idx_claims_request_agent_active');

    // ...and no referring table may be left pointing at a dropped intermediate name.
    const dangling = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%requests_new%'`
    ).all<{ name: string }>();
    expect(dangling.results).toEqual([]);

    // The requests indexes rebuilt by 0006 are present.
    const reqIdx = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='requests' AND name LIKE 'idx_requests_%' ORDER BY name`
    ).all<{ name: string }>();
    const names = reqIdx.results.map((r) => r.name);
    for (const expected of [
      'idx_requests_created',
      'idx_requests_expires',
      'idx_requests_requester',
      'idx_requests_status',
      'idx_requests_target',
    ]) {
      expect(names).toContain(expected);
    }
  });
});
